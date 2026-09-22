require("dotenv").config({ quiet: true });

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { Pool, types: pgTypes } = require("pg");
const nodemailer = require("nodemailer");
const multer = require("multer");
const mediaStorage = require("./storage");

/* Prefer IPv4 for outbound connections (nodemailer SMTP, webhooks, etc.).
   Render and most cloud hosts have no IPv6 route, so when smtp.gmail.com
   resolves to an AAAA (IPv6) address first the socket dies with
   "connect ENETUNREACH ... - Local (:::0)" and mail silently fails. Resolving
   IPv4-first makes delivery deterministic on those hosts. */
require("dns").setDefaultResultOrder("ipv4first");

/* PostgreSQL returns dates as JS Date objects by default. Reformat timestamps
   to the plain "YYYY-MM-DD HH:MM:SS" shared by the whole storefront (MySQL
   previously sent the same shape via dateStrings), so every frontend + email
   date consumer keeps working unchanged. Emitted in the server's local time,
   exactly like the old MySQL driver did. */
const pad2 = n => String(n).padStart(2, "0");
function pgDateParser(value) {
  if (value == null) return value;
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
pgTypes.setTypeParser(1184, pgDateParser); /* timestamptz */
pgTypes.setTypeParser(1114, pgDateParser); /* timestamp */

/* ------------------------------------------------------------------ */
/*  Configuration (all secrets come from environment variables)        */
/* ------------------------------------------------------------------ */
const SESSION_SECRET = process.env.SESSION_SECRET;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@marygoldcollections.com").trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DELIVERY_FEE = 2500;
const FREE_DELIVERY_THRESHOLD = 100000;
const ORDER_STATUSES = ["Pending", "Confirmed", "Processing", "Shipped", "Delivered", "Cancelled"];
const PAYMENT_STATUSES = ["Pending", "Paid", "Failed", "Refunded"];
const WHATSAPP_NUMBER = String(process.env.WHATSAPP_NUMBER || "").replace(/[^0-9]/g, "").replace(/^0+/, "");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_DATABASE = "novacart";

/* Outgoing mail. Both the production naming (EMAIL_*) and the legacy/dev
   naming (SMTP_* / MAIL_FROM) are recognised — EMAIL_* wins when both are
   present, so the same code keeps working with the local .env and with the
   Render environment. With no host configured the emails are written to the
   server log (handy during development); once a host is set they are really
   delivered. */
/* Customer-facing brand used in email subjects, headers and footers. STORE_NAME
   may override it, but the fallback is the real store identity — never the
   GitHub/project name. Internal technical identifiers (database, package, repo)
   stay unchanged. */
const BRAND_NAME = String(process.env.STORE_NAME || "Mary Gold Collection").trim() || "Mary Gold Collection";
const SMTP_HOST = process.env.EMAIL_HOST || process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.EMAIL_PORT || process.env.SMTP_PORT || 587);
const SMTP_SECURE = /^(true|1)$/i.test(String(process.env.EMAIL_SECURE || process.env.SMTP_SECURE || ""));
const SMTP_USER = process.env.EMAIL_USER || process.env.SMTP_USER || "";
/* Gmail App Passwords are typically copied with spaces (e.g. "abcd efgh ijkl
   mnop"), but Gmail only accepts the 16 alphanumeric characters. All
   whitespace is stripped before the secret reaches Nodemailer. */
const SMTP_PASS = normalizeSecret(process.env.EMAIL_PASSWORD || process.env.SMTP_PASS || "");
const MAIL_FROM_NAME = String(process.env.EMAIL_FROM_NAME || "").trim();
/* Sender identity: the address always comes from the configured EMAIL_FROM /
   MAIL_FROM (or the SMTP user as a last resort — never hard-coded), while the
   display name is forced to the customer-facing brand so customers always see
   "Mary Gold Collection <configured@example.com>", never the project name. */
const MAIL_FROM = normalizedFrom(process.env.EMAIL_FROM || process.env.MAIL_FROM || "");

function normalizedFrom(raw) {
  const s = String(raw || "").trim();
  const angled = s.match(/<([^>]+)>/);
  const bare = /^[^\s@<>]+@[^\s@<>]+$/.test(s) ? [null, s] : null;
  const addr = (angled || bare || [null, ""])[1].trim();
  const name = MAIL_FROM_NAME || BRAND_NAME;
  if (addr) return `${name} <${addr}>`;
  return defaultFrom(); /* nothing configured — build from the SMTP user */
}
const STORE_EMAIL = (process.env.STORE_EMAIL || process.env.OWNER_EMAIL || ADMIN_EMAIL || "").trim().toLowerCase();

/* Strips surrounding and internal whitespace from a secret value. Never logs
   the value. Safe for Gmail App Passwords (letters/digits only). */
function normalizeSecret(value) {
  return String(value == null ? "" : value).trim().replace(/\s+/g, "");
}

function smtpConfigured() {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

/* Reasonable "From" fallback when no explicit EMAIL_FROM / MAIL_FROM is set:
   use the configured sender name (or the store name) with no-reply@domain. */
function defaultFrom() {
  const name = MAIL_FROM_NAME || BRAND_NAME;
  if (SMTP_USER) {
    const at = String(SMTP_USER).indexOf("@");
    const domain = at >= 0 ? String(SMTP_USER).slice(at + 1) : "novacart.app";
    return `${name} <no-reply@${domain}>`;
  }
  return `${name} <no-reply@novacart.app>`;
}

if (!SESSION_SECRET || SESSION_SECRET === "nova-local-dev-secret-change-me") {
  throw new Error("FATAL: SESSION_SECRET must be set to a strong random value (e.g. openssl rand -hex 32).");
}
if (!ADMIN_PASSWORD || ADMIN_PASSWORD === "admin123") {
  throw new Error("FATAL: ADMIN_PASSWORD must be set to a strong password — the default 'admin123' is not allowed.");
}

/* Absolute base URL used for links in emails (order tracking, unsubscribe,
   etc). Resolution order: APP_BASE_URL → RENDER_EXTERNAL_URL →
   RENDER_EXTERNAL_HOSTNAME (both supplied by Render at runtime) → BASE_URL →
   localhost development fallback. Never generates localhost links in
   production unless nothing else is available. */
function siteBaseUrl() {
  const candidates = [
    process.env.APP_BASE_URL,
    process.env.RENDER_EXTERNAL_URL,
    process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : "",
    process.env.BASE_URL
  ];
  const found = candidates.find(v => String(v || "").trim().startsWith("http"));
  return String(found || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, "");
}

/* PostgreSQL connection settings. Prefer a single DATABASE_URL
   (e.g. postgresql://user:pass@host:5432/novacart) in production, or the
   standard PG* variables (PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE)
   which the `pg` driver also reads automatically. Cloud databases usually
   require TLS: enable it by adding ?ssl=true to DATABASE_URL, by setting
   PGSSL=true, or via PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE + PGSSL. */
const dbSsl = enabled => (enabled ? { ssl: { rejectUnauthorized: false } } : {});

function dbConfig() {
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    const sslQuery = (u.searchParams.get("ssl") || "").toLowerCase();
    const sslMode = (u.searchParams.get("sslmode") || "").toLowerCase();
    const sslEnabled =
      sslQuery === "true" || sslQuery === "1" || sslQuery === "preferred" || sslQuery === "required" ||
      sslMode === "preferred" || sslMode === "require" || sslMode === "verify-ca" || sslMode === "verify-full";
    return {
      host: u.hostname,
      port: Number(u.port || 5432),
      user: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
      database: decodeURIComponent(u.pathname.replace(/^\//, "")) || DEFAULT_DATABASE,
      connectionTimeoutMillis: 10000,
      ...dbSsl(sslEnabled)
    };
  }
  const sslEnabled = /^(1|true|required|preferred)$/i.test(String(process.env.PGSSL || ""));
  return {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "novacart",
    password: process.env.PGPASSWORD || "",
    database: process.env.PGDATABASE || DEFAULT_DATABASE,
    connectionTimeoutMillis: 10000,
    ...dbSsl(sslEnabled)
  };
}

let pool;

/* Best-effort database creation for local development. Hosted PostgreSQL
   (e.g. Render) usually can't create databases — the DATABASE_URL it provides
   already points at an existing database, so this being a no-op there is fine. */
async function ensureDatabase(cfg) {
  const admin = new Pool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, ssl: cfg.ssl, database: "postgres", connectionTimeoutMillis: 10000 });
  try {
    const res = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [cfg.database]);
    if (res.rowCount === 0) {
      const dbId = String(cfg.database).replace(/[^a-zA-Z0-9_]/g, "");
      if (dbId) await admin.query(`CREATE DATABASE "${dbId}"`);
    }
  } catch (err) {
    console.warn("[db] Could not auto-create database (expected on hosted Postgres): " + (err && err.message ? err.message : err));
  } finally {
    try { await admin.end(); } catch (_) { }
  }
}

/* Parameter placeholders: converts MySQL-style "?" into PostgreSQL "$1..$n". */
const pgPlaceholders = sql => {
  let n = 0;
  return String(sql).replace(/\?/g, () => `$${++n}`);
};

async function initDatabase() {
  const cfg = dbConfig();
  await ensureDatabase(cfg);

  pool = new Pool({
    ...cfg,
    max: 10,
    idleTimeoutMillis: 30000
  });

  /* Schema — created idempotently, existing data is preserved. */
  const schema = [
    `CREATE TABLE IF NOT EXISTS categories (
       id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
       name VARCHAR(80) NOT NULL UNIQUE,
       slug VARCHAR(80) NOT NULL UNIQUE,
       description TEXT,
       image TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS products (
       id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
       name VARCHAR(160) NOT NULL,
       category VARCHAR(80) NOT NULL,
       price INTEGER NOT NULL,
       image TEXT NOT NULL,
       video_url TEXT,
       stock INTEGER NOT NULL DEFAULT 20,
       description TEXT,
       featured BOOLEAN NOT NULL DEFAULT FALSE,
       rating NUMERIC(3,2) NOT NULL DEFAULT 4.50,
       is_active BOOLEAN NOT NULL DEFAULT TRUE,
       created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
       category_id INTEGER,
       CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories(id)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)`,
    `CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id)`,
    `CREATE TABLE IF NOT EXISTS orders (
       id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
       order_number VARCHAR(20),
       customer VARCHAR(160) NOT NULL,
       email VARCHAR(254) NOT NULL,
       phone VARCHAR(40) NOT NULL DEFAULT '',
       address VARCHAR(255) NOT NULL DEFAULT '',
       city VARCHAR(100) NOT NULL DEFAULT '',
       state VARCHAR(100) NOT NULL DEFAULT '',
       country VARCHAR(100) NOT NULL DEFAULT 'Nigeria',
       subtotal INTEGER NOT NULL DEFAULT 0,
       delivery_fee INTEGER NOT NULL DEFAULT 0,
       total INTEGER NOT NULL DEFAULT 0,
       payment_method VARCHAR(40) NOT NULL DEFAULT 'Cash on Delivery',
       payment_status VARCHAR(20) NOT NULL DEFAULT 'Pending',
       status VARCHAR(20) NOT NULL DEFAULT 'Pending',
       status_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
       tracking_token VARCHAR(64),
       shipping_carrier VARCHAR(80) NOT NULL DEFAULT '',
       tracking_number VARCHAR(120) NOT NULL DEFAULT '',
       created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_tracking_token ON orders(tracking_token)`,
    `CREATE TABLE IF NOT EXISTS order_status_history (
       id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
       order_id INTEGER NOT NULL,
       old_status VARCHAR(20) NOT NULL DEFAULT '',
       new_status VARCHAR(20) NOT NULL DEFAULT '',
       changed_by VARCHAR(254) NOT NULL DEFAULT 'system',
       note VARCHAR(255) NOT NULL DEFAULT '',
       changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT fk_osh_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
     )`,
    `CREATE INDEX IF NOT EXISTS idx_osh_order ON order_status_history(order_id)`,
    `CREATE TABLE IF NOT EXISTS order_items (
       id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
       order_id INTEGER NOT NULL,
       product_id INTEGER NOT NULL,
       quantity INTEGER NOT NULL,
       price INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id)`,
    `CREATE TABLE IF NOT EXISTS customers (
       id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
       name VARCHAR(160) NOT NULL DEFAULT '',
       email VARCHAR(254) NOT NULL UNIQUE,
       phone VARCHAR(40) NOT NULL DEFAULT '',
       address VARCHAR(255) NOT NULL DEFAULT '',
       city VARCHAR(100) NOT NULL DEFAULT '',
       state VARCHAR(100) NOT NULL DEFAULT '',
       country VARCHAR(100) NOT NULL DEFAULT 'Nigeria',
       created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS admin_users (
       id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
       email VARCHAR(254) NOT NULL UNIQUE,
       password_hash VARCHAR(255) NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS sessions (
       sid VARCHAR(128) NOT NULL PRIMARY KEY,
       data TEXT NOT NULL,
       expires_at BIGINT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS newsletter_subscribers (
       id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
       email VARCHAR(254) NOT NULL UNIQUE,
       status VARCHAR(20) NOT NULL DEFAULT 'subscribed',
       unsub_token VARCHAR(64) NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE INDEX IF NOT EXISTS idx_newsletter_status ON newsletter_subscribers(status)`,
    `CREATE TABLE IF NOT EXISTS contact_messages (
       id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
       name VARCHAR(160) NOT NULL DEFAULT '',
       email VARCHAR(254) NOT NULL DEFAULT '',
       subject VARCHAR(200) NOT NULL DEFAULT '',
       message TEXT NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`
  ];
  for (const ddl of schema) await pool.query(ddl);

  /* Migrations: add columns that older installs may be missing. */
  await ensureColumn("products", "featured", "featured BOOLEAN NOT NULL DEFAULT FALSE");
  await ensureColumn("products", "video_url", "video_url TEXT");
  await ensureColumn("products", "rating", "rating NUMERIC(3,2) NOT NULL DEFAULT 4.50");
  await ensureColumn("products", "is_active", "is_active BOOLEAN NOT NULL DEFAULT TRUE");
  await ensureColumn("products", "created_at", "created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP");
  await ensureColumn("products", "category_id", "category_id INTEGER");
  await ensureColumn("orders", "order_number", "order_number VARCHAR(20)");
  await ensureColumn("orders", "phone", "phone VARCHAR(40) NOT NULL DEFAULT ''");
  await ensureColumn("orders", "address", "address VARCHAR(255) NOT NULL DEFAULT ''");
  await ensureColumn("orders", "city", "city VARCHAR(100) NOT NULL DEFAULT ''");
  await ensureColumn("orders", "state", "state VARCHAR(100) NOT NULL DEFAULT ''");
  await ensureColumn("orders", "country", "country VARCHAR(100) NOT NULL DEFAULT 'Nigeria'");
  await ensureColumn("orders", "subtotal", "subtotal INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("orders", "delivery_fee", "delivery_fee INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("orders", "payment_method", "payment_method VARCHAR(40) NOT NULL DEFAULT 'Cash on Delivery'");
  await ensureColumn("orders", "payment_status", "payment_status VARCHAR(20) NOT NULL DEFAULT 'Pending'");
  await ensureColumn("orders", "status_updated_at", "status_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP");
  await ensureColumn("orders", "tracking_token", "tracking_token VARCHAR(64)");
  await ensureColumn("orders", "shipping_carrier", "shipping_carrier VARCHAR(80) NOT NULL DEFAULT ''");
  await ensureColumn("orders", "tracking_number", "tracking_number VARCHAR(120) NOT NULL DEFAULT ''");
  await ensureColumn("newsletter_subscribers", "status", "status VARCHAR(20) NOT NULL DEFAULT 'subscribed'");
  await ensureColumn("newsletter_subscribers", "unsub_token", "unsub_token VARCHAR(64)");
  await ensureColumn("newsletter_subscribers", "updated_at", "updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP");

  /* Backfill one-click unsubscribe tokens for subscribers added before the
     column existed, and normalise statuses. Runs before the UNIQUE constraint
     is added so old duplicate/empty values can never violate it. Fresh
     installs have nothing to backfill (CREATE TABLE already made the column
     NOT NULL UNIQUE). */
  const needTokens = await query("SELECT id FROM newsletter_subscribers WHERE unsub_token IS NULL OR unsub_token = ''");
  for (const r of needTokens) {
    await run("UPDATE newsletter_subscribers SET unsub_token = ? WHERE id = ?",
      [crypto.randomBytes(24).toString("hex"), r.id]);
  }
  await run(
    `UPDATE newsletter_subscribers SET status = 'unsubscribed'
     WHERE status NOT IN ('subscribed', 'unsubscribed')`
  );
  /* The column may have been added nullable on legacy tables; enforce
     uniqueness now. A single named index makes this idempotent across
     reboots. The old ADD CONSTRAINT form is dropped if a legacy install
     created it (its backing index shares the constraint name). */
  try {
    await run("ALTER TABLE newsletter_subscribers DROP CONSTRAINT IF EXISTS unsub_token");
  } catch (_) { /* index-only installs */ }
  await pool.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_unsub_token ON newsletter_subscribers(unsub_token)"
  );

  /* Normalise the legacy "Clothes" category and backfill order numbers. */
  await pool.query("UPDATE products SET category = 'Clothing' WHERE category IN ('Clothes', 'CLOTHES')");
  await pool.query(
    `UPDATE orders SET order_number = 'NC-' || LPAD(id::text, 6, '0')
     WHERE order_number IS NULL OR order_number = ''`
  );

  /* Backfill tracking tokens and status timestamps for orders created before
     those columns existed. Idempotent: only touches rows that still lack a
     token, and the same token is never regenerated once assigned. */
  const needOrderTokens = await query("SELECT id FROM orders WHERE tracking_token IS NULL OR tracking_token = ''");
  for (const r of needOrderTokens) {
    await run("UPDATE orders SET tracking_token = ? WHERE id = ?",
      [crypto.randomBytes(24).toString("hex"), r.id]);
  }
  await run(
    `UPDATE orders SET status_updated_at = created_at
     WHERE status_updated_at IS NULL`
  );

  /* Indexes used by tracking lookups and admin filtering. Safe on legacy
     installs: ignored when the index already exists (CREATE TABLE above
     already declares the ones fresh installs get). */
  for (const [table, keyName, cols] of [
    ["orders", "idx_orders_payment_status", "payment_status"],
    ["orders", "idx_orders_tracking_token", "tracking_token"],
    ["order_status_history", "idx_osh_order", "order_id"]
  ]) {
    await pool.query(`CREATE INDEX IF NOT EXISTS ${keyName} ON ${table} (${cols})`);
  }

  /* Seed default categories. Idempotent: only runs on a fresh install
     (empty table) so deleted categories are never resurrected on restart. */
  const addDefaultCategory = async name => {
    const has = await one("SELECT id FROM categories WHERE LOWER(name) = LOWER(?) OR LOWER(slug) = LOWER(?)", [name.slug, name.slug]);
    if (has) return;
    await run(
      "INSERT INTO categories(name, slug, description, image) VALUES (?, ?, ?, ?)",
      [name.name, name.slug, name.description, name.image]
    );
  };
  const DEFAULT_CATEGORIES = [
    { name: "Clothing", slug: "clothing", description: "Tailored and everyday essentials.", image: "" },
    { name: "Shoes", slug: "shoes", description: "From sneakers to statement styles.", image: "" },
    { name: "Jewelry", slug: "jewelry", description: "Pieces that finish every outfit.", image: "" },
    { name: "Accessories", slug: "accessories", description: "Watches, belts and finishing touches.", image: "" },
    { name: "Bags", slug: "bags", description: "Carry everyday in style.", image: "" }
  ];
  const categoryCount = Number((await one("SELECT COUNT(*) AS n FROM categories")).n);
  if (categoryCount === 0) {
    for (const c of DEFAULT_CATEGORIES) await addDefaultCategory(c);
  }

  /* Relational migration: point existing products at categories by id. Rows that
     reference a category not in the table are auto-created instead of lost. */
  const orphans = await query("SELECT id, category FROM products WHERE category_id IS NULL");
  for (const r of orphans) {
    const name = String(r.category || "").trim();
    if (!name) continue;
    let cat = await one("SELECT id FROM categories WHERE LOWER(name) = LOWER(?) OR LOWER(slug) = LOWER(?)", [name, name]);
    if (!cat) {
      await run("INSERT INTO categories(name, slug) VALUES (?, ?) ON CONFLICT DO NOTHING", [name, slugify(name)]);
      cat = await one("SELECT id FROM categories WHERE LOWER(name) = LOWER(?) OR LOWER(slug) = LOWER(?)", [name, name]);
    }
    if (cat) await run("UPDATE products SET category_id = ? WHERE id = ?", [cat.id, r.id]);
  }

  /* Seed the catalog only when the products table is empty. */
  const countRow = await one("SELECT COUNT(*) AS n FROM products");
  if (!Number(countRow.n)) {
    const seed = [
      ["Satin Evening Dress", "Clothing", 89000, "https://images.unsplash.com/photo-1566174053879-31528523f8ae?auto=format&fit=crop&w=900&q=85", 18, "Elegant satin dress for evening occasions.", 1, 4.8],
      ["Minimal Linen Shirt", "Clothing", 52000, "https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?auto=format&fit=crop&w=900&q=85", 30, "Relaxed premium linen shirt.", 1, 4.6],
      ["Classic Leather Sneakers", "Shoes", 68000, "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=900&q=85", 24, "Everyday leather sneakers.", 1, 4.7],
      ["Urban Running Shoes", "Shoes", 76000, "https://images.unsplash.com/photo-1552346154-21d32810aba3?auto=format&fit=crop&w=900&q=85", 16, "Lightweight performance trainers.", 0, 4.5],
      ["Gold Statement Necklace", "Jewelry", 125000, "https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?auto=format&fit=crop&w=900&q=85", 12, "Statement necklace with a polished finish.", 1, 4.9],
      ["Pearl Drop Earrings", "Jewelry", 54000, "https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?auto=format&fit=crop&w=900&q=85", 20, "Elegant pearl drop earrings.", 0, 4.4],
      ["Chrono Wristwatch", "Accessories", 145000, "https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=900&q=85", 5, "Modern stainless-steel wristwatch.", 1, 4.7],
      ["Structured Handbag", "Bags", 98000, "https://images.unsplash.com/photo-1584917865442-de89df76afd3?auto=format&fit=crop&w=900&q=85", 0, "Structured everyday handbag.", 1, 4.6]
    ];
    for (const r of seed) {
      const cat = await one("SELECT id FROM categories WHERE LOWER(name) = LOWER(?)", [r[1]]);
      await run(
        "INSERT INTO products(name, category, category_id, price, image, stock, description, featured, rating) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [r[0], r[1], cat ? cat.id : null, r[2], r[3], r[4], r[5], r[6], r[7]]
      );
    }
  }

  /* Seed admin user (hashed password) from environment variables. */
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
  await run(
    `INSERT INTO admin_users(email, password_hash) VALUES (?, ?)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [ADMIN_EMAIL, hash]
  );
}

/* Query helpers ------------------------------------------------------ */
async function query(sql, params) {
  const res = await pool.query(pgPlaceholders(sql), params || []);
  return res.rows;
}
async function one(sql, params) {
  const rows = await query(sql, params);
  return rows[0];
}
async function run(sql, params) {
  const res = await pool.query(pgPlaceholders(sql), params || []);
  return { rowCount: res.rowCount, rows: res.rows, command: res.command };
}
/* Run an INSERT (or any statement) that must return the created row/columns,
   e.g. `INSERT ... RETURNING id`. */
async function insertRow(sql, params) {
  const res = await pool.query(pgPlaceholders(sql), params || []);
  return res.rows[0];
}

async function columnExists(table, column) {
  const rows = await query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = current_schema() AND TABLE_NAME = LOWER($1) AND COLUMN_NAME = LOWER($2)`,
    [table, column]
  );
  return rows.length > 0;
}

async function ensureColumn(table, column, ddl) {
  if (!(await columnExists(table, column))) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/* Run `fn(conn)` inside a transaction, rolling back on error. */
async function withTx(fn) {
  const client = await pool.connect();
  const conn = {
    query: (sql, params) => client.query(pgPlaceholders(sql), params || [])
  };
  try {
    await client.query("BEGIN");
    const out = await fn(conn);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) { /* connection may have failed */ }
    throw err;
  } finally {
    client.release();
  }
}

/* Wrap async route handlers so rejected promises reach the error handler. */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function validateProduct(body) {
  const errors = [];
  const name = String(body.name || "").trim();
  const price = Number(body.price);
  const stock = Number(body.stock);
  const image = String(body.image || "").trim();
  const video = String(body.video_url || "").trim();
  const description = String(body.description || "").trim();

  if (name.length < 2 || name.length > 120) errors.push("Product name must be between 2 and 120 characters.");

  const categoryId = Number(body.category_id);
  let category = null;
  if (Number.isInteger(categoryId) && categoryId > 0) {
    category = await one("SELECT id, name, slug FROM categories WHERE id = ?", [categoryId]);
  } else if (String(body.category || "").trim()) {
    category = await one("SELECT id, name, slug FROM categories WHERE LOWER(name) = LOWER(?)", [String(body.category).trim()]);
  }
  if (!category) errors.push("Please select a valid category.");

  if (!Number.isFinite(price) || !Number.isInteger(price) || price < 0 || price > 100000000)
    errors.push("Price must be a whole number between 0 and ₦100,000,000.");
  if (!Number.isInteger(stock) || stock < 0 || stock > 100000)
    errors.push("Stock must be a whole number between 0 and 100,000.");
  if (!image) errors.push("A product image is required.");
  else if (!/^https?:\/\/\S+$/i.test(image) && !image.startsWith("/uploads/"))
    errors.push("Image must be a URL or an uploaded file.");
  if (video && !/^https?:\/\/\S+$/i.test(video) && !video.startsWith("/uploads/"))
    errors.push("Video must be a URL or an uploaded file.");
  if (description.length > 2000) errors.push("Description must be 2000 characters or fewer.");
  const featured = body.featured ? 1 : 0;
  const rating = Number(body.rating);
  const rate = Number.isFinite(rating) && rating >= 0 && rating <= 5 ? rating : 4.5;
  return {
    errors,
    values: {
      name, price, stock, image, video_url: video, description, featured, rating: rate,
      category_id: category ? category.id : null,
      category: category ? category.name : String(body.category || "").trim()
    }
  };
}

async function validateCategory(body, excludeId) {
  const errors = [];
  const name = String(body.name || "").trim();
  const rawSlug = String(body.slug || "").trim();
  const slug = rawSlug ? rawSlug.toLowerCase() : slugify(name);
  const description = String(body.description || "").trim();
  const image = String(body.image || "").trim();

  if (!name) errors.push("Category name is required.");
  else if (name.length > 60) errors.push("Category name must be 60 characters or fewer.");

  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    errors.push("Slug may only contain lowercase letters, numbers and dashes (e.g. \"home-and-living\").");
  }

  const excludeIdVal = Number.isInteger(excludeId) && excludeId > 0 ? excludeId : 0;
  if (name && await one(
    "SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND id <> ?", [name, excludeIdVal]
  )) {
    errors.push("A category with this name already exists.");
  }
  if (slug && await one(
    "SELECT id FROM categories WHERE LOWER(slug) = LOWER(?) AND id <> ?", [slug, excludeIdVal]
  )) {
    errors.push("This slug is already in use.");
  }
  if (description.length > 500) errors.push("Description must be 500 characters or fewer.");
  if (image && !/^https?:\/\/\S+$/i.test(image)) errors.push("Category image must be a valid http(s) URL.");
  return { errors, values: { name, slug, description, image } };
}

function deliveryFeeFor(subtotal) {
  return subtotal >= FREE_DELIVERY_THRESHOLD ? 0 : DELIVERY_FEE;
}
function nextOrderNumber(id) {
  return `NC-${String(id).padStart(6, "0")}`;
}

/* ------------------------------------------------------------------ */
/*  Mail helpers (SMTP via nodemailer; logs to console when SMTP is     */
/*  not configured, so local development still "works")                */
/* ------------------------------------------------------------------ */
const htmlEscape = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const naira = n => "₦" + Number(n || 0).toLocaleString("en-NG", { maximumFractionDigits: 0 });

/* Connection candidates for the SMTP server, newest first. Cloud hosts like
   Render (and various home/office ISPs) frequently filter one of the two
   standard submission ports, so if the configured port cannot be reached the
   mail layer automatically retries on the other standard port (587 STARTTLS
   vs 465 implicit TLS). Auth credentials are only ever used on the configured
   host (or the canonical smtp.gmail.com alias) — never on an arbitrary host.
   The candidate list stays deterministic for tests and debugging. */
function smtpCandidates() {
  const host = String(SMTP_HOST || "").trim();
  if (!host) return [];
  const canonical = host === "smtp.googlemail.com" ? "smtp.gmail.com" : host;
  const auth = SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined;
  const build = (useHost, usePort) => {
    const implicitTls = usePort === 465;
    return {
      label: `${useHost}:${usePort}${implicitTls ? " (implicit TLS)" : " (STARTTLS)"}`,
      host: useHost,
      port: usePort,
      secure: implicitTls ? true : SMTP_SECURE,
      requireTLS: implicitTls ? false : !SMTP_SECURE,
      tls: { minVersion: "TLSv1.2" },
      connectionTimeout: 6000,
      greetingTimeout: 6000,
      socketTimeout: 20000,
      socketOptions: { family: 4 },
      auth
    };
  };
  const out = [];
  out.push(build(canonical, SMTP_PORT));
  if (SMTP_PORT !== 465) out.push(build(canonical, 465));
  if (SMTP_PORT !== 587) out.push(build(canonical, 587));
  return out;
}

/* Nodemailer transporter for one candidate config. Not cached — each send
   builds a fresh connection so a "poisoned" socket never blocks later sends. */
function buildTransporter(cfg) {
  return nodemailer.createTransport(cfg);
}

/* ------------------------------------------------------------------ */
/*  HTTPS email API (primary delivery path where SMTP is blocked)      */
/*                                                                     */
/*  Render free web services block outbound SMTP ports 25/465/587      */
/*  (platform policy since Sept 2025), so direct SMTP can never work    */
/*  there — connections die before authentication. HTTPS (port 443) is  */
/*  always allowed, so mail is delivered through an email-API provider  */
/*  (Resend or Brevo) when EMAIL_API_PROVIDER + EMAIL_API_KEY are set.  */
/*  Locally / on paid instances SMTP still works and needs no key.      */
/* ------------------------------------------------------------------ */
function emailApiConfig() {
  const provider = String(process.env.EMAIL_API_PROVIDER || "").trim().toLowerCase();
  const key = String(process.env.EMAIL_API_KEY || "").trim();
  if ((provider === "resend" || provider === "brevo") && key) return { provider, key };
  return null;
}

/* Split `Some Name <user@host>` / `user@host` into name + address for the
   provider payloads (never fails — falls back to sane defaults). */
function apiParseFrom(from) {
  const s = String(from || "");
  const m = s.match(/^(.*)<([^>]+)>\s*$/);
  const name = (m ? m[1] : s).trim().replace(/^"|"$/g, "").trim();
  const email = (m ? m[2] : s).trim();
  return { name: name || BRAND_NAME, email };
}

/* Lightweight authenticated call proving the API key works. Safe — never
   returns or logs the key. */
async function apiVerify(cfg) {
  if (typeof fetch !== "function") throw new Error("fetch unavailable (Node 18+ required)");
  if (cfg.provider === "resend") {
    const r = await fetch("https://api.resend.com/keys", { headers: { Authorization: `Bearer ${cfg.key}` } });
    if (!r.ok) throw new Error(`Resend API ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    return true;
  }
  const r = await fetch("https://api.brevo.com/v3/account", { headers: { "api-key": cfg.key } });
  if (!r.ok) throw new Error(`Brevo API ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return true;
}

/* Deliver one message through the HTTPS provider. Throws on failure so the
   caller can log/report the true error. */
async function apiSend(cfg, { from, to, subject, text, html }) {
  if (typeof fetch !== "function") throw new Error("fetch unavailable (Node 18+ required)");
  if (cfg.provider === "resend") {
    const body = { from, to: [to], subject };
    if (text) body.text = text;
    if (html) body.html = html;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Resend API ${r.status}: ${String((data && (data.message || data.error)) || "request failed").slice(0, 200)}`);
    return { sent: true, messageId: String((data && data.id) || ""), accepted: [to], rejected: [] };
  }
  const parsed = apiParseFrom(from);
  const body = {
    sender: { name: parsed.name, email: parsed.email },
    to: [{ email: to }],
    subject
  };
  if (text) body.textContent = text;
  if (html) body.htmlContent = html;
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": cfg.key },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Brevo API ${r.status}: ${String((data && (data.message || data.name)) || "request failed").slice(0, 200)}`);
  return { sent: true, messageId: String((data && data.messageId) || ""), accepted: [to], rejected: [] };
}

let mailVerifyState = null;   /* boot + on-demand; never contains secrets */

function mailConfigSummary() {
  const api = emailApiConfig();
  return {
    configured: Boolean(api) || smtpConfigured(),
    transport: api ? `https-api:${api.provider}` : (smtpConfigured() ? "smtp" : "none"),
    api_provider: api ? api.provider : null,
    host: SMTP_HOST || "",
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    user_configured: Boolean(SMTP_USER),
    password_configured: Boolean(SMTP_PASS),
    from: MAIL_FROM,
    production_base_url: siteBaseUrl()
  };
}

/* Safe, credential-free SMTP error text: the password (if set) is redacted and
   the message is trimmed so Render logs never leak secrets. */
function safeMailError(err) {
  if (err === undefined || err === null) return "SMTP connection error (no details)";
  let msg = err && err.message ? String(err.message) : String(err);
  if (SMTP_PASS) {
    try { msg = msg.split(SMTP_PASS).join("***"); } catch (_) { /* ignore */ }
  }
  if (msg.length > 300) msg = msg.slice(0, 300) + "…";
  return msg;
}

/* Resolve a promise but never let it hang past `ms`. Emails, verifications and
   the checkout response must stay fast even when SMTP is slow or unreachable. */
function boundedPromise(promise, ms, label) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ sent: false, error: `${label} timed out after ${ms}ms` }), ms);
    Promise.resolve(promise).then(
      r => { clearTimeout(timer); resolve(r); },
      e => { clearTimeout(timer); resolve({ sent: false, error: safeMailError(e) }); }
    );
  });
}

/* Non-blocking delivery check (API or SMTP). Safe result only. Never prevents
   the web server from starting — mail problems are logged clearly instead.
   Prefers the HTTPS API when configured, otherwise tries every SMTP candidate
   (e.g. 587 then 465) so a single blocked port can't sink mail. */
async function verifyMail() {
  const api = emailApiConfig();
  if (api) {
    const attempt = await boundedPromise(apiVerify(api), 12000, `Verification via ${api.provider}`);
    if (attempt === true || (attempt && attempt.sent === true)) {
      mailVerifyState = { configured: true, ok: true, error: null, transport: `https-api:${api.provider}`, checkedAt: Date.now() };
      console.log(`[mail] Verification: SUCCESS (${api.provider} HTTPS API)`);
      return mailVerifyState;
    }
    mailVerifyState = { configured: true, ok: false, error: safeMailError(attempt && attempt.error), transport: `https-api:${api.provider}`, checkedAt: Date.now() };
    console.error(`[mail] Verification via ${api.provider} FAILED: ${mailVerifyState.error}`);
    return mailVerifyState;
  }
  const candidates = smtpCandidates();
  if (!candidates.length) {
    mailVerifyState = { configured: false, ok: false, error: "no mail transport configured", checkedAt: Date.now() };
    return mailVerifyState;
  }
  let lastError = "all candidates failed";
  for (const cfg of candidates) {
    const attempt = await boundedPromise(buildTransporter(cfg).verify(), 12000, `SMTP verification via ${cfg.label}`);
    if (attempt === true || (attempt && attempt.sent === true)) {
      mailVerifyState = { configured: true, ok: true, error: null, host: cfg.host, port: cfg.port, checkedAt: Date.now() };
      console.log(`[mail] SMTP verification: SUCCESS (${cfg.label})`);
      return mailVerifyState;
    }
    lastError = safeMailError(attempt && attempt.error);
    console.error(`[mail] SMTP verification via ${cfg.label} FAILED: ${lastError}`);
  }
  mailVerifyState = { configured: true, ok: false, error: lastError, host: SMTP_HOST, port: SMTP_PORT, checkedAt: Date.now() };
  console.error(`[mail] SMTP verification FAILED (all candidates): ${lastError}`);
  return mailVerifyState;
}

/* Truthful per-email result shape for API responses. Never reveals secrets. */
function emailStatusResult(r) {
  return {
    sent: r && r.sent === true,
    dev: !!(r && r.dev),
    messageId: (r && r.messageId) || null,
    rejected: (r && r.rejected && r.rejected.length) ? r.rejected : [],
    error: (r && r.sent) ? null : ((r && r.error) || null)
  };
}

/* Never throws — mail problems are logged, not surfaced to callers. Emails are
   sent after the database transaction that created them commits, so a send
   failure never rolls back the order/subscription. Returns a truthful result
   ({sent, messageId, accepted, rejected[, error]}) so callers and the API
   never claim success when the provider rejected the message. Delivery prefers
   the HTTPS email API (works on Render free tier), then SMTP, then console. */
async function sendMail({ to, subject, text, html }, label) {
  const labelText = label || "Email";
  const dumpDir = process.env.MAIL_WRITE_HTML;
  if (dumpDir) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      require("fs").writeFileSync(path.join(dumpDir, `mail-${stamp}.html`), String(html || ""), "utf8");
    } catch (_) { }
  }
  const api = emailApiConfig();
  if (api) {
    console.log(`[mail] Sending ${labelText} -> ${to} via ${api.provider} HTTPS API`);
    const attempt = await boundedPromise(apiSend(api, { from: MAIL_FROM, to, subject, text, html }), 15000, "Email API");
    if (attempt && attempt.sent) {
      console.log(`[mail] ${labelText} accepted -> ${to} via ${api.provider}${attempt.messageId ? ` messageId=${attempt.messageId}` : ""}`);
      return attempt;
    }
    console.error(`[mail] ${labelText} via ${api.provider} FAILED: ${attempt && attempt.error}`);
    console.error(`[mail] ${labelText} FAILED -> ${to}`);
    return { sent: false, messageId: null, accepted: [], rejected: [], error: (attempt && attempt.error) || "Email API failed" };
  }
  const candidates = smtpCandidates();
  if (!candidates.length) {
    console.log(`[mail::dev] ${labelText} email -> ${to}`);
    console.log(`[mail::dev] Subject: ${subject}`);
    console.log(`[mail::dev] ---`);
    console.log(`[mail::dev] ${String(text).split("\n").join("\n[mail::dev] ")}`);
    console.log(`[mail::dev] --- (no SMTP or email-API configured — configure one to deliver real mail)`);
    return { sent: false, dev: true, messageId: null, accepted: [], rejected: [] };
  }
  console.log(`[mail] Sending ${labelText} -> ${to}`);
  const msg = { from: MAIL_FROM, to, subject, text, html };
  let lastError = "SMTP error";
  for (const cfg of candidates) {
    try {
      const info = await buildTransporter(cfg).sendMail(msg);
      const messageId = info && info.messageId ? String(info.messageId) : "";
      const accepted = (info && info.accepted) || [];
      const rejected = (info && info.rejected) || [];
      console.log(`[mail] ${labelText} accepted -> ${to} via ${cfg.label}${messageId ? ` messageId=${messageId}` : ""}`);
      return { sent: true, messageId, accepted, rejected, via: `${cfg.host}:${cfg.port}` };
    } catch (err) {
      const safe = safeMailError(err);
      lastError = safe;
      const authError = /invalid login|EAUTH|535|534|authentication|credentials/i.test(String((err && err.message) || err || ""));
      console.error(`[mail] ${labelText} via ${cfg.label} FAILED: ${safe}${authError ? " (auth error — not retrying other ports)" : ""}`);
      if (authError) break; /* bad credentials — the port is not the problem */
    }
  }
  console.error(`[mail] ${labelText} FAILED -> ${to}`);
  return { sent: false, messageId: null, accepted: [], rejected: [], error: lastError };
}

/* Brand accent + status "pill" chips used inside emails. All styles inline for
   mail-client compatibility. */
const BRAND_ACCENT = "#b45309";

function emailPill(label, tone) {
  const tones = {
    ok: "background:#dcfce7;color:#166534;border:1px solid #bbf7d0;",
    info: "background:#e0f2fe;color:#075985;border:1px solid #bae6fd;",
    warn: "background:#fffbeb;color:#92400e;border:1px solid #fde68a;",
    bad: "background:#fee2e2;color:#991b1b;border:1px solid #fecaca;",
    dim: "background:#f1f0ee;color:#57534e;border:1px solid #e4e2df;"
  }[tone] || "background:#f5f5f4;color:#44403c;border:1px solid #e7e5e4;";
  return `<span style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:11.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;padding:5px 13px;border-radius:999px;${tones}">${label}</span>`;
}

function statusTone(status) {
  const s = String(status || "");
  if (s === "Confirmed" || s === "Delivered") return "ok";
  if (s === "Processing" || s === "Shipped") return "info";
  if (s === "Pending") return "warn";
  if (s === "Cancelled" || s === "Failed" || s === "Refunded") return "bad";
  return "dim";
}

function paymentTone(order) {
  const s = String(order.payment_status || "");
  if (s === "Paid") return "ok";
  if (s === "Refunded") return "dim";
  if (s === "Failed") return "bad";
  return "warn";
}

/* Branded email shell — shared header/footer so welcome, order and notification
   emails stay visually consistent. All styles are inline for mail clients. */
function mailShell({ title, content, unsubscribeUrl = "", footerNote = "" }) {
  const foot = unsubscribeUrl
    ? `You're receiving this because you subscribed to ${BRAND_NAME} updates.<br>
       <a href="${unsubscribeUrl}" style="color:#ffffff;text-decoration:underline">Unsubscribe</a> from these emails`
    : (footerNote ||
       `${BRAND_NAME} updates — new arrivals, exclusive offers and style inspiration.`);
  return `<div style="background-color:#f6f1eb;padding:36px 14px;">
    <div style="max-width:600px;margin:0 auto;font-family:Georgia,serif,Arial,sans-serif;color:#1c1917;">
      <div style="text-align:center;padding:6px 0 22px;">
        <a href="${siteBaseUrl()}" style="text-decoration:none;color:inherit;">
          <div style="font-size:34px;font-weight:700;letter-spacing:.5px;line-height:1;">
            ${BRAND_NAME}
          </div>
        </a>
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:2.6px;text-transform:uppercase;color:#8a837c;margin-top:9px;">
          Curated Fashion &middot; Footwear &middot; Accessories
        </div>
      </div>
      <div style="background:#ffffff;border:1px solid #eadfd3;border-radius:16px;padding:38px 34px;box-shadow:0 8px 28px rgba(60,40,10,.06);">
        ${content}
      </div>
      <div style="text-align:center;padding:28px 10px 8px;font-family:Arial,Helvetica,sans-serif;font-size:12.5px;color:#8a837c;line-height:1.7;">
        <div style="font-family:Georgia,serif;font-size:17px;font-weight:700;color:#57534e;">
          ${BRAND_NAME} <span style="color:${BRAND_ACCENT};">&middot;</span>
        </div>
        <div style="margin-top:6px;">WhatsApp: +234 915 259 5695 &middot; Victoria Island, Lagos, Nigeria</div>
        <div style="margin-top:14px;">${foot}</div>
        <div style="height:1px;background:#eadfd3;margin:18px 0 14px;"></div>
        &copy; ${new Date().getFullYear()} ${BRAND_NAME}. All rights reserved.
      </div>
    </div>
  </div>`;
}

function welcomeMail({ email, token }) {
  const unsubscribeUrl = `${siteBaseUrl()}/unsubscribe?token=${encodeURIComponent(token)}`;
  const text =
    `Welcome to ${BRAND_NAME}!\n\n` +
    `You're officially subscribed to our newsletter.\n\n` +
    `You'll receive:\n` +
    `- New product updates\n` +
    `- Special offers\n` +
    `- Promotions\n` +
    `- ${BRAND_NAME} news\n\n` +
    `Shop the latest collection: ${siteBaseUrl()}/shop\n\n` +
    `If you no longer wish to receive these emails, you can unsubscribe here: ${unsubscribeUrl}\n\n` +
    `— The ${BRAND_NAME} Team`;
  const html = mailShell({
    title: "You're on the list",
    unsubscribeUrl,
    content:
      `<h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 14px;line-height:1.25;">Welcome to ${BRAND_NAME}!</h1>
       <p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#44403c;line-height:1.7;margin:0 0 8px;">
         You're officially subscribed to our newsletter.
       </p>
       <p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#44403c;line-height:1.7;margin:0 0 22px;">
         You'll receive:
       </p>
       <ul style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#44403c;line-height:1.9;margin:0 0 26px;padding-left:20px;">
         <li>New product updates</li>
         <li>Special offers</li>
         <li>Promotions</li>
         <li>${BRAND_NAME} news</li>
       </ul>
       <a href="${siteBaseUrl()}/shop" style="display:inline-block;background:${BRAND_ACCENT};color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:14px;padding:14px 28px;border-radius:999px;box-shadow:0 4px 14px rgba(180,83,9,.28);">Shop the collection&nbsp;&rsaquo;</a>
       <p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#8a837c;margin-top:26px;">
         Premium fashion, footwear, accessories &amp; jewelry &middot; fast delivery across Nigeria.
       </p>`
  });
  return {
    to: email,
    subject: `Welcome to ${BRAND_NAME}! You're on the list 🛍`,
    text,
    html
  };
}

function newSubscriberMail({ email, totalCount, activeCount, isResubscribe }) {
  const text =
    `${email} just ${isResubscribe ? "re-subscribed to" : "subscribed to"} the ${BRAND_NAME} newsletter.\n` +
    `Total subscribers: ${totalCount}\nActive subscribers: ${activeCount}\n\n` +
    `Manage subscribers: ${siteBaseUrl()}/admin#subscribers`;
  const html = mailShell({
    title: "New subscriber",
    content:
      `<h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 12px;line-height:1.3;">New newsletter ${isResubscribe ? "re-subscription" : "subscriber"} 🎉</h1>
       <p style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#292524;margin:0 0 6px;">${htmlEscape(email)}</p>
       <p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#8a837c;margin:0 0 22px;">
         ${isResubscribe ? "They have re-joined the list." : "They have joined the " + BRAND_NAME + " list."}<br>
         ${totalCount} total &middot; ${activeCount} active subscribers
       </p>
       <a href="${siteBaseUrl()}/admin#subscribers" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:14px;padding:13px 26px;border-radius:999px;">View subscribers</a>`
  });
  return {
    to: STORE_EMAIL,
    subject: `New newsletter subscriber — ${email}`,
    text,
    html
  };
}

function unsubscribedMail({ email }) {
  return {
    to: STORE_EMAIL,
    subject: `Newsletter unsubscribe — ${email}`,
    text: `${email} unsubscribed from the ${BRAND_NAME} newsletter.\n\nManage subscribers: ${siteBaseUrl()}/admin#subscribers`
  };
}

/* Branded newsletter broadcast used by the admin "Send newsletter" feature.
   Each subscriber gets an individual email carrying their own unsubscribe
   link, so recipients never see one another's address. */
function newsletterCampaignMail({ email, unsubToken, subject, message }) {
  const base = siteBaseUrl();
  const unsubscribeUrl = `${base}/unsubscribe?token=${encodeURIComponent(unsubToken)}`;
  const paragraphs = String(message || "").trim()
    .split(/\r?\n{2,}/)
    .map(p => `<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#44403c;line-height:1.7;margin:0 0 14px;">${htmlEscape(p).replace(/\r?\n/g, "<br>")}</p>`)
    .join("");
  const text =
    `${subject}\n\n` +
    String(message || "").trim() + "\n\n" +
    `— The ${BRAND_NAME} Team\n\n` +
    `You're receiving this because you subscribed to ${BRAND_NAME} updates.\n` +
    `Unsubscribe: ${unsubscribeUrl}`;
  const html = mailShell({
    title: subject,
    unsubscribeUrl,
    content:
      `<div style="text-align:center;margin-bottom:20px;">${emailPill("Newsletter", "info")}</div>` +
      `<h1 style="font-family:Georgia,serif;font-size:26px;margin:0 0 14px;line-height:1.25;">${htmlEscape(subject)}</h1>` +
      paragraphs +
      `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#8a837c;margin-top:20px;line-height:1.6;">` +
      `You're receiving this because you subscribed to ${BRAND_NAME} updates. ` +
      `<a href="${unsubscribeUrl}" style="color:${BRAND_ACCENT};text-decoration:underline;">Unsubscribe</a></p>`
  });
  return { to: email, subject, text, html };
}

/* Human-friendly payment label. A COD order awaiting collection must read as
   "COD — Awaiting Payment", never as a plain (and easily misread) "Pending". */
function paymentLabel(order) {
  const method = String(order.payment_method || "");
  const status = String(order.payment_status || "Pending");
  if (/(cash on delivery|cod)/i.test(method) && status === "Pending") return "COD — Awaiting Payment";
  return status;
}

/* Order payload for customer-facing responses. Never leaks the tracking token
   or any internal/administrative columns to the browser. */
function publicOrderPayload(order) {
  if (!order) return null;
  return {
    id: order.id,
    order_number: order.order_number,
    customer: order.customer,
    email: order.email,
    phone: order.phone || "",
    address: order.address || "",
    city: order.city || "",
    state: order.state || "",
    country: order.country || "",
    subtotal: order.subtotal,
    delivery_fee: order.delivery_fee,
    total: order.total,
    payment_method: order.payment_method || "",
    payment_status: order.payment_status || "Pending",
    payment_label: paymentLabel(order),
    status: order.status || "Pending",
    status_updated_at: order.status_updated_at || null,
    created_at: order.created_at,
    shipping_carrier: order.shipping_carrier || "",
    tracking_number: order.tracking_number || ""
  };
}

/* Safe carrier tracking links. Only known carriers get a deep link — anything
   else just shows the carrier name + tracking number. */
function carrierTrackUrl(carrier, trackingNumber) {
  const c = String(carrier || "").trim().toLowerCase();
  const n = String(trackingNumber || "").trim();
  if (!c || !n) return "";
  try {
    const href = encodeURIComponent(n);
    if (/dhl/.test(c) && /^[0-9]{10,}$/.test(n)) return `https://www.dhl.com/ng-en/home/tracking.html?tracking-id=${href}`;
    if (/fedex/.test(c) && /^[0-9]{12,}$/.test(n)) return `https://www.fedex.com/fedextrack/?trknbr=${href}`;
    if (/ups/.test(c) && /^1Z[0-9A-Z]{16}$/i.test(n)) return `https://www.ups.com/track?tracknum=${href}`;
    if (/gig|glg/.test(c)) return `https://giglogistics.com/track/${href}`;
    if (/aps/.test(c)) return `https://apspayments.com/track/${href}`;
  } catch (_) { /* invalid input -> no link */ }
  return "";
}

/* WhatsApp deep link used on the tracking page. Returns "" when WHATSAPP_NUMBER
   is not configured so nothing broken renders before it is set. */
function whatsappHelpUrl(message) {
  if (!WHATSAPP_NUMBER) return "";
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message || `Hi ${BRAND_NAME}! I have a question about my order.`)}`;
}

function orderSummaryBlock(order, items) {
  const rows = (items || []).map(it =>
    `<tr>
       <td style="padding:11px 12px;border-bottom:1px solid #f2ede5;color:#292524">${htmlEscape(it.product_name)}</td>
       <td align="center" style="padding:11px 12px;border-bottom:1px solid #f2ede5;color:#57534e">${Number(it.quantity)}</td>
       <td align="right" style="padding:11px 12px;border-bottom:1px solid #f2ede5;color:#57534e;white-space:nowrap">${naira(it.price)}</td>
       <td align="right" style="padding:11px 12px;border-bottom:1px solid #f2ede5;color:#292524;white-space:nowrap;font-weight:700">${naira(Number(it.price) * Number(it.quantity))}</td>
     </tr>`).join("");
  const totalLine = (label, value, bold) =>
    `<tr><td colspan="3" align="right" style="padding:9px 12px;color:#57534e;${bold ? "font-weight:700;color:#292524;font-size:15px;" : ""}">${label}</td>
            <td align="right" style="padding:9px 12px;color:#292524;white-space:nowrap;${bold ? "font-weight:700;font-size:15px;" : ""}">${value}</td></tr>`;
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:14px;margin-top:26px;">
      <tr style="background:#1c1917;">
        <th align="left" style="padding:12px;color:#f5f5f4;font-size:11px;letter-spacing:1px;text-transform:uppercase;">Item</th>
        <th style="padding:12px;color:#f5f5f4;font-size:11px;letter-spacing:1px;text-transform:uppercase;">Qty</th>
        <th align="right" style="padding:12px;color:#f5f5f4;font-size:11px;letter-spacing:1px;text-transform:uppercase;">Unit</th>
        <th align="right" style="padding:12px;color:#f5f5f4;font-size:11px;letter-spacing:1px;text-transform:uppercase;">Total</th>
      </tr>
      ${rows}
      ${totalLine("Subtotal", naira(order.subtotal))}
      ${totalLine("Delivery", order.delivery_fee ? naira(order.delivery_fee) : "FREE")}
      ${totalLine("Total", naira(order.total), true)}
    </table>`;
}

function orderFactsBlock(order) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:13.5px;color:#44403c;margin-top:20px;">
    <tr>
      <td style="padding:13px 14px;border:1px solid #eadfd3;border-radius:12px 0 0 0;background:#faf9f7;"><b style="color:#1c1917">Order number</b><br style="line-height:1" /><span style="font-size:14.5px;color:#292524">${htmlEscape(order.order_number || "")}</span></td>
      <td style="padding:13px 14px;border:1px solid #eadfd3;border-left:0;border-radius:0 12px 0 0;background:#faf9f7;"><b style="color:#1c1917">Placed</b><br style="line-height:1" /><span style="font-size:14.5px;color:#292524">${new Date(order.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span></td>
    </tr>
    <tr>
      <td style="padding:13px 14px;border:1px solid #eadfd3;border-top:0;background:#faf9f7;"><b style="color:#1c1917">Payment method</b><br style="line-height:1" /><span style="font-size:14.5px;color:#292524">${htmlEscape(order.payment_method || "")}</span></td>
      <td style="padding:13px 14px;border:1px solid #eadfd3;border-top:0;border-left:0;background:#faf9f7;"><b style="color:#1c1917">Payment status</b><br style="line-height:1" />${emailPill(paymentLabel(order), paymentTone(order))}</td>
    </tr>
    <tr>
      <td style="padding:13px 14px;border:1px solid #eadfd3;border-top:0;border-radius:0 0 0 12px;background:#faf9f7;"><b style="color:#1c1917">Order status</b><br style="line-height:1" />${emailPill(String(order.status || "Pending"), statusTone(order.status))}</td>
      <td style="padding:13px 14px;border:1px solid #eadfd3;border-top:0;border-left:0;border-radius:0 0 12px 0;background:#faf9f7;"><b style="color:#1c1917">Delivery</b><br style="line-height:1" /><span style="font-size:14.5px;color:#292524">${order.delivery_fee ? naira(order.delivery_fee) : "Free"} &middot; ${htmlEscape(order.shipping_carrier || BRAND_NAME + " courier")}</span></td>
    </tr>
  </table>`;
}
function trackButtonHtml(trackingUrl) {
  return `<div style="margin:28px 0 6px;">
    <a href="${trackingUrl}" style="display:inline-block;background:${BRAND_ACCENT};color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:15px;padding:15px 34px;border-radius:999px;box-shadow:0 4px 14px rgba(180,83,9,.28);">Track My Order&nbsp;&rsaquo;</a>
    <p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#8a837c;margin-top:12px;line-height:1.7;">
      If the button doesn't work, copy and paste this link into your browser:<br>
      <a href="${trackingUrl}" style="color:#8a837c;word-break:break-all;">${trackingUrl}</a>
    </p>
  </div>`;
}

/* New-order internal notification to the store owner. */
function orderNotificationMail(order, items, trackingUrl) {
  const text =
    `New order ${order.order_number}\n\n` +
    `Customer: ${order.customer}\nEmail: ${order.email}\nPhone: ${order.phone}\n` +
    `Address: ${order.address}, ${order.city}, ${order.state}, ${order.country}\n\n` +
    `Payment: ${order.payment_method} (${paymentLabel(order)})\n` +
    `Status: ${order.status}\n\n` +
    `Items:\n${(items || []).map(it => `- ${it.product_name} x${it.quantity} — ${naira(Number(it.price) * Number(it.quantity))}`).join("\n")}\n` +
    `\nSubtotal: ${naira(order.subtotal)}\nDelivery: ${order.delivery_fee ? naira(order.delivery_fee) : "FREE"}\n` +
    `Total: ${naira(order.total)}\n\n` +
    `Customer tracking page: ${trackingUrl}`;
  const html = mailShell({
    title: `New order ${order.order_number}`,
    footerNote: "This is an automated order notification for the " + BRAND_NAME + " store team.",
    content:
      `<h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 16px;line-height:1.25;">New order ${htmlEscape(order.order_number)}</h1>
       <p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#44403c;line-height:1.7;margin:0 0 4px;">
         <b>${htmlEscape(order.customer)}</b><br>
         ${htmlEscape(order.email)} &middot; ${htmlEscape(order.phone || "")}<br>
         ${htmlEscape([order.address, order.city, order.state, order.country].filter(Boolean).join(", "))}
       </p>
       ${orderSummaryBlock(order, items)}
       ${orderFactsBlock(order)}
       <p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#44403c;line-height:1.7;margin:24px 0 0;">View the customer's tracking page:</p>
       ${trackButtonHtml(trackingUrl)}`
  });
  return { to: STORE_EMAIL, subject: `${BRAND_NAME} — New Order ${order.order_number}`, text, html };
}

/* Customer-facing order confirmation with Track My Order CTA. */
function orderConfirmationMail(order, items, trackingUrl) {
  const text =
    `Hi ${order.customer},\n\n` +
    `Thank you for your order!\n` +
    `Your ${BRAND_NAME} order ${order.order_number} has been received successfully and is currently ${order.status || "Pending"}.\n\n` +
    `Placed: ${new Date(order.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric" })}\n` +
    `Payment method: ${order.payment_method}\nPayment status: ${paymentLabel(order)}\nOrder status: ${order.status}\n\n` +
    `Items:\n${(items || []).map(it => `- ${it.product_name} x${it.quantity} — ${naira(Number(it.price) * Number(it.quantity))}`).join("\n")}\n` +
    `\nSubtotal: ${naira(order.subtotal)}\nDelivery: ${order.delivery_fee ? naira(order.delivery_fee) : "FREE"}\n` +
    `Total: ${naira(order.total)}\n\n` +
    `Follow your order live: ${trackingUrl}\n\n` +
    `— The ${BRAND_NAME} Team`;
  const html = mailShell({
    title: `Order ${order.order_number} confirmed`,
    footerNote: "This email is about your recent " + BRAND_NAME + " order.",
    content:
      `<div style="text-align:center;margin-bottom:22px;">${emailPill(order.status, statusTone(order.status))}</div>
       <h1 style="font-family:Georgia,serif;font-size:26px;margin:0 0 12px;line-height:1.25;">Thank you for your order, ${htmlEscape(order.customer.split(" ")[0])}!</h1>
       <p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#44403c;line-height:1.7;margin:0 0 4px;">
         Your <b>${BRAND_NAME}</b> order <b>${htmlEscape(order.order_number)}</b> has been received successfully
         and is currently <b>${htmlEscape(order.status || "Pending")}</b>.
         We'll email you at every step as it's processed and shipped.
       </p>
       ${trackButtonHtml(trackingUrl)}
       ${orderSummaryBlock(order, items)}
       ${orderFactsBlock(order)}
       <p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#44403c;line-height:1.7;margin:22px 0 0;">
         Questions? Reply to this email or reach us on WhatsApp and we'll help you out.
       </p>`
  });
  return { to: order.email, subject: `Order ${order.order_number} Received — ${BRAND_NAME}`, text, html };
}

/* Customer notification on an order-status change. Only ever called with a
   genuinely new status. Subjects/messages follow the documented ${BRAND_NAME}
   templates; the shipped and cancelled variants include extra specifics. */
function orderStatusMail(order, items, trackingUrl) {
  const orderNo = order.order_number;
  const conf = {
    Confirmed: {
      subject: `${BRAND_NAME} — Your Order Has Been Confirmed`,
      heading: "Your order is confirmed",
      copy: "Your order has been confirmed and is now moving forward."
    },
    Processing: {
      subject: `${BRAND_NAME} — Your Order Is Being Processed`,
      heading: "We're preparing your order",
      copy: "Your order is now being prepared. We'll let you know the moment it ships."
    },
    Shipped: {
      subject: `${BRAND_NAME} — Your Order Has Been Shipped`,
      heading: "Your order is on the way",
      copy: "Good news — your order has been shipped and is currently on its way to you."
    },
    Delivered: {
      subject: `${BRAND_NAME} — Your Order Has Been Delivered`,
      heading: "Your order has been delivered",
      copy: `Your order has been delivered. Thank you for shopping with ${BRAND_NAME} — we hope you love it!`
    },
    Cancelled: {
      subject: `${BRAND_NAME} — Your Order Has Been Cancelled`,
      heading: "Your order has been cancelled",
      copy: "Your order has been cancelled."
    }
  };
  const t = conf[order.status] || {
    subject: `${BRAND_NAME} — Order ${orderNo} Status Updated`,
    heading: order.status,
    copy: "Your order status has been updated."
  };
  const cancelled = order.status === "Cancelled";

  /* Shipped: carrier + tracking number (and a safe deep link when known). */
  let shipBlockHtml = "";
  let shipBlockText = "";
  if (order.status === "Shipped") {
    const carrier = String(order.shipping_carrier || "").trim();
    const trackingNumber = String(order.tracking_number || "").trim();
    const trackUrl = carrierTrackUrl(carrier, trackingNumber);
    if (carrier || trackingNumber) {
      const shipmentLine = `Shipping carrier: ${carrier || BRAND_NAME + " courier"}${trackingNumber ? `\nTracking number: ${trackingNumber}` : ""}${trackUrl ? `\nTrack your shipment: ${trackUrl}` : ""}`;
      shipBlockText = `\n${shipmentLine}\n\n`;
      shipBlockHtml = `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#44403c;margin-top:22px;">
        <tr><td style="padding:16px 18px;border:1px solid #eadfd3;border-radius:12px;background:#faf9f7;">
          <div style="font-family:Georgia,serif;font-size:18px;font-weight:700;color:#1c1917;margin-bottom:2px;">On its way to you</div>
          <div style="font-size:13.5px;color:#57534e;margin:0 0 8px;">${htmlEscape(carrier || BRAND_NAME + " courier")}${trackingNumber ? ` &middot; <b>${htmlEscape(trackingNumber)}</b>` : ""}</div>
          ${trackUrl ? `<a href="${trackUrl}" style="color:${BRAND_ACCENT};font-weight:700;text-decoration:none;">Track your shipment&nbsp;&rsaquo;</a>` : ""}
        </td></tr>
      </table>`;
    }
  }

  /* Cancelled: clear payment/refund guidance based on how the order was paid. */
  let refundBlockHtml = "";
  let refundBlockText = "";
  if (cancelled) {
    const pay = String(order.payment_status || "Pending");
    const isCod = /cash on delivery|cod/i.test(String(order.payment_method || ""));
    if (pay === "Paid") {
      refundBlockText = "Since your payment was already received, your refund is being processed. You'll receive a confirmation once it's complete.\n\n";
      refundBlockHtml = `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#44403c;line-height:1.7;margin:16px 0 0;background:#faf9f7;border:1px solid #eadfd3;border-radius:12px;padding:14px 16px;">
        Since your payment was already received, <b>your refund is being processed</b>. You'll be notified once it's complete.
      </p>`;
    } else if (isCod) {
      refundBlockText = "As you paid on delivery, no payment was taken and there is nothing to refund.\n\n";
      refundBlockHtml = `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#44403c;line-height:1.7;margin:16px 0 0;background:#faf9f7;border:1px solid #eadfd3;border-radius:12px;padding:14px 16px;">
        You paid on delivery, so <b>no payment was taken</b> and there is nothing to refund.
      </p>`;
    } else if (pay === "Failed") {
      refundBlockText = "No payment was captured for this order, so there is nothing to refund.\n\n";
      refundBlockHtml = `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#44403c;line-height:1.7;margin:16px 0 0;background:#faf9f7;border:1px solid #eadfd3;border-radius:12px;padding:14px 16px;">
        No payment was captured for this order, so there is nothing to refund.
      </p>`;
    } else {
      refundBlockText = "No payment was taken for this order.\n\n";
    }
  }

  const text =
    `Hi ${order.customer},\n\n` +
    `${t.copy}\n\n` +
    `Order: ${orderNo}\nCurrent status: ${order.status}\n` +
    `Order total: ${naira(order.total)}\nPayment: ${order.payment_method} (${paymentLabel(order)})\n\n` +
    `${shipBlockText}${refundBlockText}` +
    `${cancelled ? "" : `Follow your order live: ${trackingUrl}\n\n`}` +
    `— The ${BRAND_NAME} Team`;

  const html = mailShell({
    title: `Order ${orderNo} — ${order.status}`,
    footerNote: "This email is about your recent " + BRAND_NAME + " order.",
    content:
      `<div style="text-align:center;margin-bottom:22px;">${emailPill(order.status, statusTone(order.status))}</div>
       <h1 style="font-family:Georgia,serif;font-size:26px;margin:0 0 10px;line-height:1.25;">${t.heading}</h1>
       <p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#44403c;line-height:1.7;margin:0 0 6px;">
         ${t.copy}
       </p>
       <p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#57534e;margin:0 0 4px;">
         Order <b>${htmlEscape(orderNo)}</b> &middot; ${paymentLabel(order)} &middot; ${naira(order.total)}
       </p>
       ${shipBlockHtml}
       ${refundBlockHtml}
       ${cancelled ? "" : trackButtonHtml(trackingUrl)}
       ${orderSummaryBlock(order, items)}
       ${orderFactsBlock(order)}
       <p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#44403c;line-height:1.7;margin:22px 0 0;">
         Questions? Reply to this email or reach us on WhatsApp and we'll help you out.
       </p>`
  });
  return { to: order.email, subject: t.subject, text, html };
}

/* ------------------------------------------------------------------ */
/*  Uploads (admin product images / videos).                           */
/*  Files are staged briefly under the OS temp dir, then either pushed */
/*  to persistent object storage (production; S3_* configured) or put  */
/*  under public/uploads for localhost. The database only ever stores  */
/*  the final permanent URL.                                           */
/* ------------------------------------------------------------------ */
const UPLOAD_DIR = path.join(__dirname, "public", "uploads");
const UPLOAD_TMP = path.join(os.tmpdir(), "novacart-uploads");

const UPLOAD_IMAGE_EXTS = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const UPLOAD_VIDEO_EXTS = { ".mp4": "video/mp4", ".webm": "video/webm" };

function uploadStorage() {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(UPLOAD_TMP, { recursive: true });
      cb(null, UPLOAD_TMP);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`);
    }
  });
}
function uploadFileFilter(kind) {
  /* Validate extension AND MIME together — neither is trusted alone.   */
  return (req, file, cb) => {
    const exts = kind === "videos" ? UPLOAD_VIDEO_EXTS : UPLOAD_IMAGE_EXTS;
    const ext = path.extname(file.originalname || "").toLowerCase();
    const wants = kind === "videos" ? "MP4 or WebM video" : "JPEG, PNG or WebP image";
    if (!(ext in exts)) return cb(new Error(`Only ${wants} files are allowed.`));
    const mime = String(file.mimetype || "").toLowerCase();
    if (exts[ext] !== mime) return cb(new Error(`File contents do not match a valid ${wants} file.`));
    cb(null, true);
  };
}
const uploadImage = multer({
  storage: uploadStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: uploadFileFilter("images")
});
const uploadVideo = multer({
  storage: uploadStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: uploadFileFilter("videos")
});

/* Persists a staged multer file to object storage (S3 mode) or
   public/uploads (localhost mode) and resolves to the permanent URL.
   The temporary file is always removed afterwards. */
function finalizeUpload(file, kind) {
  return new Promise((resolve, reject) => {
    const removeTmp = () => { try { fs.unlinkSync(file.path); } catch (_) { /* ignore */ } };
    const key = file.filename;
    if (mediaStorage.isS3()) {
      const stream = fs.createReadStream(file.path);
      mediaStorage.put({ key, kind, size: file.size, stream, contentType: String(file.mimetype || "").toLowerCase() })
        .then(res => { removeTmp(); resolve(res.url); })
        .catch(err => { removeTmp(); reject(err); });
    } else {
      const dir = path.join(UPLOAD_DIR, kind);
      fs.mkdirSync(dir, { recursive: true });
      /* copy (not rename): the temp dir may be a different filesystem than
         public/uploads (e.g. /tmp is tmpfs), where rename would EXDEV */
      fs.copyFile(file.path, path.join(dir, key), err => {
        removeTmp();
        if (err) return reject(err);
        resolve(`/uploads/${kind}/${key}`);
      });
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Session store (PostgreSQL backed so logins survive restarts)        */
/* ------------------------------------------------------------------ */
class PostgresSessionStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    const sweep = async () => {
      try { await this.q("DELETE FROM sessions WHERE expires_at < ?", [Date.now()]); } catch (_) { /* ignore */ }
    };
    sweep();
    this._timer = setInterval(sweep, 30 * 60 * 1000);
    if (this._timer.unref) this._timer.unref();
  }
  /* The store talks to the pool directly, so placeholders must be converted
     here just like the query helpers do. */
  q(sql, params) {
    return this.db.query(pgPlaceholders(sql), params || []);
  }
  get(sid, cb) {
    this.q("SELECT data, expires_at FROM sessions WHERE sid = ?", [sid])
      .then(res => {
        const row = res.rows[0];
        if (!row) return cb(null, null);
        if (Number(row.expires_at) < Date.now()) return cb(null, null);
        try { cb(null, JSON.parse(row.data)); } catch (err) { cb(err); }
      })
      .catch(err => cb(err));
  }
  set(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires
      ? sess.cookie.expires.getTime()
      : Date.now() + 24 * 60 * 60 * 1000;
    this.q(
      `INSERT INTO sessions(sid, data, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (sid) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
      [sid, JSON.stringify(sess), expires]
    ).then(() => cb && cb(null)).catch(err => cb && cb(err));
  }
  destroy(sid, cb) {
    this.q("DELETE FROM sessions WHERE sid = ?", [sid])
      .then(() => cb && cb(null)).catch(err => cb && cb(err));
  }
  touch(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires
      ? sess.cookie.expires.getTime()
      : Date.now() + 24 * 60 * 60 * 1000;
    this.q("UPDATE sessions SET expires_at = ? WHERE sid = ?", [expires, sid])
      .then(() => cb && cb(null)).catch(err => cb && cb(err));
  }
}

(async function main() {
  await initDatabase();

  const app = express();
  const PORT = process.env.PORT || 3000;

  fs.mkdirSync(path.join(UPLOAD_DIR, "images"), { recursive: true });
  fs.mkdirSync(path.join(UPLOAD_DIR, "videos"), { recursive: true });

  /* Boot-time email diagnostics — helpful on Render where the variables are
     supplied by the dashboard. Cleartext credentials are never printed. */
  const mailCfg = mailConfigSummary();
  if (mailCfg.api_provider) {
    console.log(`[mail] Transport: ${mailCfg.transport} — HTTPS/443 is allowed on Render free tier (SMTP ports 25/465/587 are blocked since Sept 2025)`);
  } else {
    console.log(`[mail] SMTP config ${mailCfg.configured ? "detected" : "NOT detected — emails will be logged, not delivered"}`);
    if (mailCfg.configured) {
      console.log(`[mail] SMTP host: ${mailCfg.host}`);
      console.log(`[mail] SMTP port: ${mailCfg.port}`);
      console.log(`[mail] SMTP user: configured`);
      console.log(`[mail] SMTP password: configured`);
    }
  }
  console.log(`[mail] From: ${MAIL_FROM}`);
  console.log(`[mail] Base URL for email links: ${siteBaseUrl()}`);
  if (SMTP_HOST) {
    require("dns").lookup(SMTP_HOST, { all: true }, (err, addrs) => {
      if (err) {
        console.error(`[mail] DNS lookup for ${SMTP_HOST} failed: ${safeMailError(err)}`);
      } else if (addrs && addrs.length) {
        console.log(`[mail] ${SMTP_HOST} resolves to: ${addrs.map(a => `${a.address} (IPv${a.family})`).join(", ")}`);
      }
    });
    console.log(`[mail] SMTP candidates: ${smtpCandidates().map(c => c.label).join(" -> ")}`);
  }
  if (process.env.NODE_ENV === "production" && !mailCfg.configured) {
    console.warn("[mail] WARNING: no email transport is configured in production — no real emails will be delivered. " +
      "Set EMAIL_API_PROVIDER + EMAIL_API_KEY (resend or brevo) to deliver on Render free tier, " +
      "or EMAIL_HOST / EMAIL_USER / EMAIL_PASSWORD (SMTP_* aliases work) on a paid instance.");
  }
  if (process.env.NODE_ENV === "production" && /localhost|127\.0\.0\.1/.test(siteBaseUrl())) {
    console.warn("[mail] WARNING: base URL looks like localhost in production — set APP_BASE_URL or confirm " +
      "Render provides RENDER_EXTERNAL_URL so email tracking links are usable.");
  }
  verifyMail();   /* non-blocking; logs SUCCESS/FAILED and never blocks startup */

  /* Boot-time media-storage diagnostics. Object storage (S3_) keeps product
     images/videos alive across Render restarts and redeploys; the local
     filesystem does not. Credentials are never printed. */
  console.log(`[storage] Media storage: ${mediaStorage.describe()}`);
  mediaStorage.check()
    .then(state => {
      if (state === "bucket OK") console.log(`[storage] Bucket reachable and ready.`);
      else if (mediaStorage.isS3()) console.warn(`[storage] WARNING: S3 storage ${state}` +
        " — uploads will fail until the endpoint/bucket is reachable.");
    })
    .catch(() => { /* the route itself reports upload failures */ });
  if (process.env.NODE_ENV === "production" && !mediaStorage.isS3()) {
    console.warn("[storage] WARNING: running production with LOCAL media storage — uploaded images/videos live on " +
      "this instance's ephemeral disk and will be lost after a restart or redeploy. Configure the S3_* variables " +
      "(see .env.example) so product media persists in object storage.");
  }

  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));

  app.use(session({
    store: new PostgresSessionStore(pool),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false",
      maxAge: 24 * 60 * 60 * 1000
    }
  }));

  /* ------------------------------------------------------------------ */
  /*  Middleware                                                         */
  /* ------------------------------------------------------------------ */
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; base-uri 'self'; frame-ancestors 'self'"
    });
    next();
  });

  /* Basic same-origin protection for state-changing requests. */
  function sameOrigin(req, res, next) {
    const source = req.headers.origin || req.headers.referer || "";
    if (!source) return next();
    try {
      const host = req.headers.host || "";
      if (new URL(source).host === host) return next();
    } catch (_) { /* malformed header falls through to block */ }
    return res.status(403).json({ error: "Cross-site request blocked." });
  }

  function requireAdmin(req, res, next) {
    if (req.session && req.session.admin) return next();
    const wantsJson = req.headers.accept && req.headers.accept.includes("application/json");
    if (wantsJson || req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Unauthorized. Please sign in." });
    }
    return res.redirect("/admin/login");
  }

  const loginAttempts = new Map();
  function loginLimiter(req, res, next) {
    const ip = req.ip || "unknown";
    const now = Date.now();
    const rec = loginAttempts.get(ip) || { count: 0, first: now };
    if (now - rec.first > 15 * 60 * 1000) { rec.count = 0; rec.first = now; }
    if (rec.count >= 10) return res.status(429).json({ error: "Too many login attempts. Please wait 15 minutes." });
    rec.count += 1;
    loginAttempts.set(ip, rec);
    next();
  }

  /* Clean the limiter map periodically so it cannot grow unbounded. */
  setInterval(() => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [ip, rec] of loginAttempts) if (rec.first < cutoff) loginAttempts.delete(ip);
  }, 5 * 60 * 1000).unref();

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */
  app.get("/api/health", (req, res) => res.json({ ok: true }));

  app.get("/api/config", wrap(async (req, res) => {
    const cats = (await query("SELECT name FROM categories ORDER BY id ASC")).map(c => c.name);
    res.json({
      currency: "NGN",
      deliveryFee: DELIVERY_FEE,
      freeDeliveryThreshold: FREE_DELIVERY_THRESHOLD,
      categories: cats,
      whatsappNumber: WHATSAPP_NUMBER || "",
      whatsappUrl: WHATSAPP_NUMBER ? `https://wa.me/${WHATSAPP_NUMBER}` : ""
    });
  }));

  app.get("/api/categories", wrap(async (req, res) => {
    const slug = String(req.query.slug || "").trim();
    const sql = `
      SELECT c.*, (SELECT COUNT(*) FROM products WHERE category_id = c.id) AS product_count
      FROM categories c`;
    const rows = slug
      ? await query(sql + " WHERE LOWER(c.slug) = LOWER(?) LIMIT 1", [slug])
      : await query(sql + " ORDER BY c.id ASC");
    res.json(rows);
  }));

  app.get("/api/categories/:id", wrap(async (req, res) => {
    const category = await one(`
      SELECT c.*, (SELECT COUNT(*) FROM products WHERE category_id = c.id) AS product_count
      FROM categories c WHERE c.id = ?`, [Number(req.params.id)]);
    if (!category) return res.status(404).json({ error: "Category not found." });
    res.json(category);
  }));

  /* Shared product projection so every product row includes its category
     without a per-product API call. */
  const P = `
    SELECT p.id, p.name, p.image, p.video_url, p.price, p.stock, p.description, p.featured, p.rating,
      p.is_active, p.created_at, p.category_id,
      c.name AS category, c.slug AS category_slug
    FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

  app.get("/api/products", wrap(async (req, res) => {
    const { q, category, slug, category_id, sort, min, max, featured, limit } = req.query;
    const where = ["p.is_active"];
    const params = [];

    if (category && category !== "All") {
      where.push("(c.name = ? OR c.slug = ?)");
      params.push(category, category);
    }
    if (slug) {
      where.push("c.slug = ?");
      params.push(slug);
    }
    const catId = Number(category_id);
    if (Number.isInteger(catId) && catId > 0) {
      where.push("p.category_id = ?");
      params.push(catId);
    }
    if (q) {
      where.push("(p.name ILIKE ? OR c.name ILIKE ? OR p.description ILIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const minN = Number(min);
    if (Number.isFinite(minN) && minN >= 0) { where.push("p.price >= ?"); params.push(Math.round(minN)); }
    const maxN = Number(max);
    if (Number.isFinite(maxN) && maxN > 0) { where.push("p.price <= ?"); params.push(Math.round(maxN)); }
    if (featured === "1") where.push("p.featured");

    const sortMap = {
      newest: "p.id DESC",
      price_asc: "p.price ASC, p.id DESC",
      price_desc: "p.price DESC, p.id DESC",
      popular: "(SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE product_id = p.id) DESC, p.id DESC"
    };
    const orderBy = sortMap[String(sort || "newest").toLowerCase()] || "p.featured DESC, p.id DESC";
    const take = Math.min(Math.max(Number(limit) || 100, 1), 200);

    const sql = `${P} WHERE ${where.join(" AND ")} ORDER BY ${orderBy} LIMIT ${take}`;
    res.json(await query(sql, params));
  }));

  app.get("/api/products/:id/related", wrap(async (req, res) => {
    const product = await one(P + " WHERE p.id = ?", [req.params.id]);
    if (!product) return res.json([]);
    const rows = await query(
      `${P} WHERE p.is_active AND p.category_id = ? AND p.id != ? ORDER BY p.featured DESC, p.id DESC LIMIT 4`,
      [product.category_id, product.id]
    );
    res.json(rows);
  }));

  app.get("/api/products/:id", wrap(async (req, res) => {
    const product = await one(P + " WHERE p.id = ? AND p.is_active", [req.params.id]);
    if (!product) return res.status(404).json({ error: "Product not found." });
    res.json(product);
  }));

  app.get("/api/home", wrap(async (req, res) => {
    const featured = await query(`${P} WHERE p.is_active AND p.featured ORDER BY p.id DESC LIMIT 8`);
    const categories = await query(`
      SELECT c.id, c.name, c.slug, c.description, c.image,
        (SELECT COUNT(*) FROM products WHERE category_id = c.id AND is_active) AS count
      FROM categories c ORDER BY c.id ASC`);
    const bestsellers = await query(`
      SELECT p.id, p.name, p.image, p.price, p.rating, p.stock, c.name AS category, c.slug AS category_slug,
        COALESCE(SUM(oi.quantity), 0)::int AS sold
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN order_items oi ON oi.product_id = p.id
      LEFT JOIN orders o ON o.id = oi.order_id AND o.status != 'Cancelled'
      WHERE p.is_active
      GROUP BY p.id, p.name, p.image, p.price, p.rating, p.stock, c.name, c.slug
      ORDER BY sold DESC, p.id DESC LIMIT 4`);
    res.json({ featured, categories, bestsellers });
  }));

  app.post("/api/orders", sameOrigin, wrap(async (req, res) => {
    const { name, email, phone, address, city, state, country, items, payment_method } = req.body;
    const customerName = String(name || req.body.customer || "").trim();
    const customerEmail = String(email || "").trim().toLowerCase();
    const customerPhone = String(phone || "").trim();
    const customerAddress = String(address || "").trim();
    const customerCity = String(city || "").trim();
    const customerState = String(state || "").trim();
    const customerCountry = String(country || "Nigeria").trim();
    const method = payment_method === "Bank Transfer" ? "Bank Transfer" : "Cash on Delivery";

    const errors = [];
    if (customerName.length < 2) errors.push("Full name is required.");
    if (!EMAIL_RE.test(customerEmail)) errors.push("A valid email address is required.");
    if (customerPhone.length < 6) errors.push("A valid phone number is required.");
    if (customerAddress.length < 5) errors.push("Delivery address is required.");
    if (customerCity.length < 2) errors.push("City is required.");
    if (customerState.length < 2) errors.push("State is required.");
    if (customerCountry.length < 2) errors.push("Country is required.");
    if (!Array.isArray(items) || items.length === 0) errors.push("Your cart is empty.");

    if (errors.length) return res.status(400).json({ error: errors.join(" ") });

    let subtotal = 0;
    const checked = [];
    for (const item of items) {
      const productId = Number(item.productId);
      const qty = Number(item.quantity);
      if (!Number.isInteger(productId) || !Number.isInteger(qty) || qty < 1 || qty > 50) {
        return res.status(400).json({ error: "Invalid item in order." });
      }
      const product = await one("SELECT * FROM products WHERE id = ?", [productId]);
      if (!product || !product.is_active) {
        return res.status(400).json({ error: "A product in your cart is no longer available." });
      }
      if (product.stock < qty) {
        return res.status(409).json({ error: `Only ${product.stock} of "${product.name}" left in stock.` });
      }
      subtotal += Number(product.price) * qty;
      checked.push({ product, qty });
    }

    const delivery = deliveryFeeFor(subtotal);
    const total = subtotal + delivery;
    const trackingToken = crypto.randomBytes(24).toString("hex");

    const orderId = await withTx(async conn => {
      await conn.query(
        `INSERT INTO customers(name, email, phone, address, city, state, country)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone,
           address = EXCLUDED.address, city = EXCLUDED.city, state = EXCLUDED.state,
           country = EXCLUDED.country, updated_at = CURRENT_TIMESTAMP`,
        [customerName, customerEmail, customerPhone, customerAddress, customerCity, customerState, customerCountry]
      );
      const ordRes = await conn.query(
        `INSERT INTO orders(order_number, customer, email, phone, address, city, state, country,
           subtotal, delivery_fee, total, payment_method, payment_status, status, tracking_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'Pending', ?)
         RETURNING id`,
        [null, customerName, customerEmail, customerPhone, customerAddress,
         customerCity, customerState, customerCountry, subtotal, delivery, total, method, trackingToken]
      );
      const oid = ordRes.rows[0].id;
      for (const { product, qty } of checked) {
        await conn.query(
          "INSERT INTO order_items(order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)",
          [oid, product.id, qty, product.price]
        );
        await conn.query("UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?", [qty, product.id, qty]);
      }
      await conn.query("UPDATE orders SET order_number = ? WHERE id = ?", [nextOrderNumber(oid), oid]);
      await conn.query(
        "INSERT INTO order_status_history(order_id, old_status, new_status, changed_by, note) VALUES (?, '', 'Pending', 'system', 'Order placed')",
        [oid]
      );
      return oid;
    });

    const order = await one("SELECT * FROM orders WHERE id = ?", [orderId]);
    const orderItems = await query(
      "SELECT oi.*, p.name AS product_name, p.image FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?",
      [orderId]
    );
    const trackingUrl = `${siteBaseUrl()}/track-order?token=${encodeURIComponent(order.tracking_token || "")}`;
    console.log(`[order] Created ${order.order_number}`);

    /* Emails are attempted AFTER the order transaction commits and never block
       or roll back the order. Each send is independent — a customer-email
       failure does not stop the owner alert and vice versa. */
    /* Emails are attempted AFTER the order transaction commits and never block
       or roll back the order. Each send is independent — a customer-email
       failure does not stop the owner alert and vice versa. A 12s cap keeps
       the checkout response bounded even when SMTP is slow or unreachable. */
    const customerPromise = boundedPromise(
      sendMail(orderConfirmationMail(order, orderItems, trackingUrl), `Customer confirmation for ${order.order_number}`),
      12000, "Customer confirmation"
    );
    let ownerPromise;
    if (STORE_EMAIL) {
      ownerPromise = boundedPromise(
        sendMail(orderNotificationMail(order, orderItems, trackingUrl), `Owner notification for ${order.order_number}`),
        12000, "Owner notification"
      );
    } else {
      console.error(`[mail] Owner notification FAILED for ${order.order_number}: no store owner email configured (STORE_EMAIL/OWNER_EMAIL)`);
      ownerPromise = Promise.resolve({ sent: false, error: "no store owner email configured" });
    }
    const [customerMailResult, ownerMailResult] = await Promise.all([customerPromise, ownerPromise]);

    res.status(201).json({
      order: publicOrderPayload(order),
      items: orderItems,
      tracking_url: trackingUrl,
      email_status: {
        customer: emailStatusResult(customerMailResult),
        owner: emailStatusResult(ownerMailResult)
      }
    });
  }));

  app.get("/api/orders/:id", wrap(async (req, res) => {
    const order = await one("SELECT * FROM orders WHERE id = ? OR order_number = ?", [req.params.id, req.params.id]);
    if (!order) return res.status(404).json({ error: "Order not found." });
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email || order.email.trim().toLowerCase() !== email) {
      return res.status(403).json({ error: "Order details are not available for this account." });
    }
    const items = await query(
      "SELECT oi.*, p.name AS product_name, p.image FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?",
      [order.id]
    );
    res.json({ ...publicOrderPayload(order), items, tracking_url: `${siteBaseUrl()}/track-order?token=${encodeURIComponent(order.tracking_token || "")}` });
  }));

  app.post("/api/newsletter", sameOrigin, wrap(async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "A valid email address is required." });

    const existing = await one("SELECT id, status, unsub_token FROM newsletter_subscribers WHERE email = ?", [email]);
    let isResubscribe = false;
    let countRow;

    if (existing) {
      /* Already subscribed: don't re-send the welcome email, just confirm. */
      if (existing.status === "subscribed") {
        countRow = await one("SELECT COUNT(*) AS n FROM newsletter_subscribers");
        return res.json({ ok: true, already: true, total: Number(countRow.n) });
      }
      /* Previously unsubscribed: welcome them back with a fresh token. */
      await run(
        "UPDATE newsletter_subscribers SET status = 'subscribed', unsub_token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [crypto.randomBytes(24).toString("hex"), existing.id]
      );
      isResubscribe = true;
    } else {
      await run(
        "INSERT INTO newsletter_subscribers(email, unsub_token) VALUES (?, ?)",
        [email, crypto.randomBytes(24).toString("hex")]
      );
    }

    const sub = await one("SELECT id, email, status, unsub_token FROM newsletter_subscribers WHERE email = ?", [email]);
    sendMail(welcomeMail(sub), "Newsletter welcome email");
    const totalRow = await one("SELECT COUNT(*) AS n FROM newsletter_subscribers");
    const activeRow = await one("SELECT COUNT(*) AS n FROM newsletter_subscribers WHERE status = 'subscribed'");
    sendMail(newSubscriberMail({ email, totalCount: Number(totalRow.n), activeCount: Number(activeRow.n), isResubscribe }), "New-subscriber alert");
    res.json({ ok: true, already: false, resubscribed: isResubscribe, total: Number(totalRow.n) });
  }));

  app.post("/api/unsubscribe", sameOrigin, wrap(async (req, res) => {
    const token = String(req.body.token || "").trim();
    const existing = await one("SELECT id, email, status FROM newsletter_subscribers WHERE unsub_token = ?", [token]);
    if (!existing) return res.status(404).json({ error: "This unsubscribe link is not valid. It may have expired or the address was already removed." });
    if (existing.status === "unsubscribed") return res.json({ ok: true, already: true });

    await run("UPDATE newsletter_subscribers SET status = 'unsubscribed', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [existing.id]);
    sendMail(unsubscribedMail(existing), "Unsubscribe alert");
    res.json({ ok: true, email: existing.email });
  }));

  app.post("/api/contact", sameOrigin, wrap(async (req, res) => {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim();
    const subject = String(req.body.subject || "").trim();
    const message = String(req.body.message || "").trim();
    if (name.length < 2 || !EMAIL_RE.test(email) || message.length < 5) {
      return res.status(400).json({ error: "Please provide your name, a valid email and a message." });
    }
    await run("INSERT INTO contact_messages(name, email, subject, message) VALUES (?, ?, ?, ?)",
      [name, email, subject.slice(0, 120), message.slice(0, 4000)]);
    res.status(201).json({ ok: true });
  }));

  /* ------------------------------------------------------------------ */
  /*  Admin authentication                                               */
  /* ------------------------------------------------------------------ */
  app.get("/api/admin/me", (req, res) => {
    if (!req.session || !req.session.admin) return res.status(401).json({ error: "Unauthorized" });
    res.json({ email: req.session.admin.email });
  });

  app.post("/api/admin/login", loginLimiter, wrap(async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
    const admin = await one("SELECT * FROM admin_users WHERE email = ?", [email]);
    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      return res.status(401).json({ error: "Incorrect email or password." });
    }
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: "Could not start a secure session." });
      req.session.admin = { id: admin.id, email: admin.email };
      res.json({ ok: true, email: admin.email });
    });
  }));

  app.post("/api/admin/logout", (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  /* ------------------------------------------------------------------ */
  /*  Admin API — every route is server-side protected by requireAdmin   */
  /* ------------------------------------------------------------------ */
  app.get("/api/admin/stats", requireAdmin, wrap(async (req, res) => {
    const [products, orders, revenue, customers, lowStock, outOfStock] = await Promise.all([
      one("SELECT COUNT(*) AS n FROM products"),
      one("SELECT COUNT(*) AS n FROM orders"),
      one("SELECT COALESCE(SUM(total), 0) AS n FROM orders WHERE status != 'Cancelled'"),
      one("SELECT COUNT(DISTINCT email) AS n FROM orders"),
      one("SELECT COUNT(*) AS n FROM products WHERE stock > 0 AND stock < 10"),
      one("SELECT COUNT(*) AS n FROM products WHERE stock <= 0")
    ]);
    res.json({
      products: Number(products.n), orders: Number(orders.n), revenue: Number(revenue.n),
      customers: Number(customers.n), lowStock: Number(lowStock.n), outOfStock: Number(outOfStock.n)
    });
  }));

  app.get("/api/admin/analytics", requireAdmin, wrap(async (req, res) => {
    const bestSellers = await query(`
      SELECT p.id, p.name, p.image, p.price, p.stock, COALESCE(SUM(oi.quantity), 0) AS sold,
        COALESCE(SUM(oi.price * oi.quantity), 0) AS revenue
      FROM products p
      LEFT JOIN order_items oi ON oi.product_id = p.id
      LEFT JOIN orders o ON o.id = oi.order_id AND o.status != 'Cancelled'
      GROUP BY p.id, p.name, p.image, p.price, p.stock ORDER BY sold DESC LIMIT 8`);

    const categoryPerformance = await query(`
      SELECT c.name AS category, COALESCE(SUM(oi.quantity), 0) AS units, COALESCE(SUM(oi.price * oi.quantity), 0) AS revenue
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id AND p.is_active
      LEFT JOIN order_items oi ON oi.product_id = p.id
      LEFT JOIN orders o ON o.id = oi.order_id AND o.status != 'Cancelled'
      GROUP BY c.id, c.name ORDER BY revenue DESC`);

    const daily = await query(`
      SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS orders,
        COALESCE(SUM(total), 0) AS revenue
      FROM orders WHERE status != 'Cancelled'
      GROUP BY day ORDER BY day DESC LIMIT 30`);
    const dayMap = new Map(daily.map(d => [d.day, d]));
    const salesOverview = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      const row = dayMap.get(key);
      salesOverview.push({ day: key, orders: row ? row.orders : 0, revenue: row ? row.revenue : 0 });
    }

    const recentOrders = await query(`
      SELECT o.*, (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = o.id) AS item_qty
      FROM orders o ORDER BY o.id DESC LIMIT 10`);
    const ordersByStatus = await query("SELECT status, COUNT(*) AS count FROM orders GROUP BY status");
    const ordersByPayment = await query("SELECT payment_status, COUNT(*) AS count FROM orders GROUP BY payment_status");

    res.json({
      bestSellers,
      categoryPerformance,
      salesOverview,
      recentOrders: recentOrders.map(r => ({ ...r, payment_label: paymentLabel(r) })),
      ordersByStatus,
      ordersByPayment
    });
  }));

  /* Payment status is independent of order status. Only these transitions
   make sense; anything else is rejected before touching the database. */
  const PAYMENT_TRANSITIONS = {
    Pending: ["Paid", "Failed"],
    Paid: ["Refunded"],
    Failed: [],
    Refunded: []
  };

  /* Fetches an order with items + status history and resolves into the shape
     the admin UI consumes. The tracking token is folded into `tracking_url`
     so the secret never has to round-trip to the browser. */
  async function adminOrderDetail(id) {
    const order = await one("SELECT * FROM orders WHERE id = ?", [Number(id)]);
    if (!order) return null;
    const items = await query(
      "SELECT oi.*, p.name AS product_name, p.image FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?",
      [order.id]
    );
    const history = await query(
      "SELECT old_status, new_status, changed_at, note, changed_by FROM order_status_history WHERE order_id = ? ORDER BY id ASC",
      [order.id]
    );
    const { tracking_token, ...safe } = order;
    safe.payment_label = paymentLabel(order);
    safe.item_count = items.length;
    return { order: safe, items, history, tracking_url: `${siteBaseUrl()}/track-order?token=${encodeURIComponent(tracking_token || "")}` };
  }

  app.get("/api/admin/orders", requireAdmin, wrap(async (req, res) => {
    const rows = await query(`
      SELECT o.id, o.order_number, o.customer, o.email, o.phone, o.address, o.city, o.state, o.country,
        o.subtotal, o.delivery_fee, o.total, o.payment_method, o.payment_status, o.status, o.status_updated_at,
        o.shipping_carrier, o.tracking_number, o.created_at,
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS item_count,
        (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = o.id) AS item_qty
      FROM orders o ORDER BY o.id DESC LIMIT 300`);
    res.json(rows.map(r => ({ ...r, payment_label: paymentLabel(r) })));
  }));

  app.get("/api/admin/orders/:id", requireAdmin, wrap(async (req, res) => {
    const detail = await adminOrderDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: "Order not found." });
    res.json(detail);
  }));

  app.put("/api/admin/orders/:id/status", requireAdmin, sameOrigin, wrap(async (req, res) => {
    const status = String(req.body.status || "").trim();
    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Invalid order status." });
    }
    const existing = await one("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "Order not found." });

    /* No actual change (admin re-saved the same value): don't bump the
       timestamp, don't log history, and don't send an email. */
    if (existing.status === status) {
      const detail = await adminOrderDetail(existing.id);
      return res.json({ ...detail, updated: false, message: "Order status is already " + status + "." });
    }

    const changedBy = (req.session.admin && req.session.admin.email) || "admin";
    const oldStatus = existing.status;
    await withTx(async conn => {
      await conn.query(
        "UPDATE orders SET status = ?, status_updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [status, existing.id]
      );
      await conn.query(
        "INSERT INTO order_status_history(order_id, old_status, new_status, changed_by, note) VALUES (?, ?, ?, ?, ?)",
        [existing.id, oldStatus, status, changedBy, ""]
      );
    });

    /* Status change is saved first. A failed notification email never rolls
       the update back — it is reported separately in the response. */
    const items = await query(
      "SELECT oi.*, p.name AS product_name, p.image FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?",
      [existing.id]
    );
    const trackingUrl = `${siteBaseUrl()}/track-order?token=${encodeURIComponent(existing.tracking_token || "")}`;
    let email = { sent: false, skipped: true };
    if (["Confirmed", "Processing", "Shipped", "Delivered", "Cancelled"].includes(status)) {
      email = await sendMail(orderStatusMail({ ...existing, status }, items, trackingUrl), "Status update email");
    }
    const detail = await adminOrderDetail(existing.id);
    res.json({ ...detail, updated: true, old_status: oldStatus, email });
  }));

  app.put("/api/admin/orders/:id/payment-status", requireAdmin, sameOrigin, wrap(async (req, res) => {
    const next = String(req.body.payment_status || "").trim();
    if (!PAYMENT_STATUSES.includes(next)) {
      return res.status(400).json({ error: "Invalid payment status." });
    }
    const existing = await one("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "Order not found." });

    const from = existing.payment_status;
    if (from === next) {
      const detail = await adminOrderDetail(existing.id);
      return res.json({ ...detail, updated: false, message: "Payment status is already " + next + "." });
    }
    const allowed = PAYMENT_TRANSITIONS[from] || [];
    if (!allowed.includes(next)) {
      return res.status(400).json({
        error: `Cannot change payment status from "${from}" to "${next}". Allowed transitions: ${from} → ${allowed.join(" or ")}.`
      });
    }
    const changedBy = (req.session.admin && req.session.admin.email) || "admin";
    await withTx(async conn => {
      await conn.query("UPDATE orders SET payment_status = ? WHERE id = ?", [next, existing.id]);
      await conn.query(
        "INSERT INTO order_status_history(order_id, old_status, new_status, changed_by, note) VALUES (?, '', '', ?, ?)",
        [existing.id, changedBy, `Payment status: ${from} → ${next}`]
      );
    });
    const detail = await adminOrderDetail(existing.id);
    res.json({ ...detail, updated: true, from, message: `Payment status updated to ${next}.` });
  }));

  app.put("/api/admin/orders/:id/shipping", requireAdmin, sameOrigin, wrap(async (req, res) => {
    const existing = await one("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "Order not found." });
    const carrier = String(req.body.shipping_carrier || "").trim().slice(0, 80);
    const trackingNumber = String(req.body.tracking_number || "").trim().slice(0, 120);
    if (carrier && !/^[\w .&\-']+$/i.test(carrier)) {
      return res.status(400).json({ error: "Shipping carrier contains invalid characters." });
    }
    if (trackingNumber && !/^[A-Za-z0-9 \-]+$/.test(trackingNumber)) {
      return res.status(400).json({ error: "Tracking number contains invalid characters." });
    }
    await run(
      "UPDATE orders SET shipping_carrier = ?, tracking_number = ? WHERE id = ?",
      [carrier, trackingNumber, existing.id]
    );
    const detail = await adminOrderDetail(existing.id);
    res.json({ ...detail, updated: true, message: "Shipping information saved." });
  }));

  /* Mail diagnostics + admin test-send. Both are admin-protected and never
     return SMTP credentials (password / app-password are only "configured"). */
  app.get("/api/admin/email-status", requireAdmin, wrap(async (req, res) => {
    const cfg = mailConfigSummary();
    let verification = mailVerifyState;
    if (!verification || !verification.checkedAt || Date.now() - verification.checkedAt > 10 * 60 * 1000) {
      verification = await verifyMail();
    }
    res.json({
      configured: cfg.configured,
      transport: cfg.transport,
      api_provider: cfg.api_provider,
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      user_configured: cfg.user_configured,
      password_configured: cfg.password_configured,
      from: cfg.from,
      verification: verification.ok ? "success" : (cfg.configured ? "failure" : "not-configured"),
      verification_error: verification.ok ? null : (verification.error || null),
      production_base_url: cfg.production_base_url
    });
  }));

  app.post("/api/admin/test-email", requireAdmin, sameOrigin, wrap(async (req, res) => {
    const to = String((req.body && req.body.to) || "").trim().toLowerCase();
    const recipient = EMAIL_RE.test(to) ? to : STORE_EMAIL;
    const subject = `${BRAND_NAME} test email`;
    const text =
      `This is a test email from ${BRAND_NAME}.\n\n` +
      `If you're reading this, SMTP is configured correctly and ${BRAND_NAME} can deliver email from the server.\n\n` +
      `Production base URL: ${siteBaseUrl()}\n` +
      `Sent: ${new Date().toISOString()}`;
    const html = mailShell({
      title: "Test email",
      footerNote: "This is an automated test message from the " + BRAND_NAME + " admin settings.",
      content:
        `<h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 12px;line-height:1.25;">SMTP test</h1>
         <p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#44403c;line-height:1.7;margin:0;">
           This is a test email from <b>${BRAND_NAME}</b>.
         </p>
         <p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#57534e;line-height:1.7;margin:18px 0 0;">
           Production base URL: ${htmlEscape(siteBaseUrl())}<br>
           Sent: ${new Date().toISOString()}
         </p>`
    });
    const result = await sendMail({ to: recipient, subject, text, html }, "Test email (admin)");
    if (result.sent) {
      res.json({ success: true, message: "Test email accepted by SMTP server", to: recipient, email: emailStatusResult(result) });
    } else {
      res.json({
        success: false,
        message: result.dev ? "SMTP is not configured on this server" : "Email delivery failed",
        to: recipient,
        error: result.dev ? null : (result.error || "unknown SMTP error"),
        email: emailStatusResult(result)
      });
    }
  }));

  /* ------------------------------------------------------------------ */
  /*  Customer order tracking                                            */
  /* ------------------------------------------------------------------ */

  /* Safe generic message — never reveals whether the order number, the email,
     or both were wrong (prevents order-number enumeration). */
  const NOT_FOUND_MSG = "No order matches that order number and email. Please check your details.";

  const trackLookupAttempts = new Map();
  function trackLookupLimiter(req, res, next) {
    const ip = req.ip || "unknown";
    const now = Date.now();
    const rec = trackLookupAttempts.get(ip) || { count: 0, first: now };
    if (now - rec.first > 15 * 60 * 1000) { rec.count = 0; rec.first = now; }
    if (rec.count >= 15) return res.status(429).json({ error: "Too many lookup attempts. Please try again in 15 minutes." });
    rec.count += 1;
    trackLookupAttempts.set(ip, rec);
    next();
  }
  setInterval(() => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [ip, rec] of trackLookupAttempts) if (rec.first < cutoff) trackLookupAttempts.delete(ip);
  }, 5 * 60 * 1000).unref();

  /* Build the customer-facing tracking payload. Token is never included;
     the customer reached this via their own token or number+email proof. */
  async function customerTrackPayload(order, items) {
    let history = [];
    try {
      history = await query(
        "SELECT old_status, new_status, changed_at FROM order_status_history WHERE order_id = ? ORDER BY id ASC",
        [order.id]
      );
    } catch (_) { /* history table missing on ancient installs */ }
    const carrier = String(order.shipping_carrier || "");
    const trackingNumber = String(order.tracking_number || "");
    return {
      ...publicOrderPayload(order),
      items: items.map(it => ({
        product_name: it.product_name || "Item",
        image: it.image || "",
        quantity: Number(it.quantity),
        price: Number(it.price)
      })),
      history,
      carrier_links: { url: carrierTrackUrl(carrier, trackingNumber), has_number: Boolean(trackingNumber) },
      whatsapp_url: whatsappHelpUrl(`Hi Marygold Collections! I'd like help tracking my order ${order.order_number}.`)
    };
  }

  app.get("/api/track-order", wrap(async (req, res) => {
    const token = String(req.query.token || "").trim();
    if (!token || token.length < 20) return res.status(404).json({ error: "This tracking link is invalid or no longer works." });
    const order = await one("SELECT * FROM orders WHERE tracking_token = ?", [token]);
    if (!order) return res.status(404).json({ error: "This tracking link is invalid or no longer works." });
    const items = await query(
      "SELECT oi.*, p.name AS product_name, p.image FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?",
      [order.id]
    );
    res.json(await customerTrackPayload(order, items));
  }));

  app.post("/api/track-lookup", sameOrigin, trackLookupLimiter, wrap(async (req, res) => {
    const orderNumber = String(req.body.order_number || "").trim().toUpperCase();
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!orderNumber || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: "Please enter both your order number and the email you ordered with." });
    }
    const order = await one(
      "SELECT * FROM orders WHERE order_number = ? OR id = ?",
      [orderNumber, Number(orderNumber.replace(/^NC-0*/, "")) || 0]
    );
    if (!order || order.email.trim().toLowerCase() !== email) {
      return res.status(404).json({ error: NOT_FOUND_MSG });
    }
    const items = await query(
      "SELECT oi.*, p.name AS product_name, p.image FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?",
      [order.id]
    );
    res.json(await customerTrackPayload(order, items));
  }));

  app.post("/api/admin/upload", requireAdmin, sameOrigin, (req, res, next) => {
    const kind = req.query.kind === "video" ? "videos" : "images";
    const uploader = kind === "videos" ? uploadVideo : uploadImage;
    uploader.single("file")(req, res, err => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: "No file received." });
      finalizeUpload(req.file, kind)
        .then(url => res.status(201).json({ url }))
        .catch(uploadErr => {
          console.error("[upload] failed to persist media:", uploadErr && uploadErr.message ? uploadErr.message : uploadErr);
          res.status(500).json({ error: "Upload failed. Please try again." });
        });
    });
  });

  app.use("/uploads", express.static(path.join(__dirname, "public", "uploads"), { maxAge: "7d" }));

  app.get("/api/admin/products", requireAdmin, wrap(async (req, res) => {
    res.json(await query(
      "SELECT p.*, c.name AS category_name, c.slug AS category_slug FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.id DESC"
    ));
  }));

  app.post("/api/admin/products", requireAdmin, sameOrigin, wrap(async (req, res) => {
    const { errors, values } = await validateProduct(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(" ") });
    if (await one("SELECT id FROM products WHERE LOWER(name) = ?", [values.name.toLowerCase()]))
      return res.status(409).json({ error: "A product with this name already exists." });
    const inserted = await insertRow(
      "INSERT INTO products(name, category, category_id, price, image, video_url, stock, description, featured, rating) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      [values.name, values.category, values.category_id, values.price, values.image, values.video_url, values.stock, values.description, values.featured, values.rating]
    );
    res.status(201).json(await one(
      "SELECT p.*, c.name AS category_name, c.slug AS category_slug FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?",
      [inserted.id]
    ));
  }));

  app.put("/api/admin/products/:id", requireAdmin, sameOrigin, wrap(async (req, res) => {
    const existing = await one("SELECT * FROM products WHERE id = ?", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "Product not found." });
    const { errors, values } = await validateProduct(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(" ") });
    if (await one("SELECT id FROM products WHERE LOWER(name) = ? AND id <> ?", [values.name.toLowerCase(), existing.id]))
      return res.status(409).json({ error: "A product with this name already exists." });
    await run(
      "UPDATE products SET name = ?, category = ?, category_id = ?, price = ?, image = ?, video_url = ?, stock = ?, description = ?, featured = ?, rating = ? WHERE id = ?",
      [values.name, values.category, values.category_id, values.price, values.image, values.video_url, values.stock, values.description, values.featured, values.rating, existing.id]
    );
    res.json(await one(
      "SELECT p.*, c.name AS category_name, c.slug AS category_slug FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?",
      [existing.id]
    ));
  }));

  app.delete("/api/admin/products/:id", requireAdmin, sameOrigin, wrap(async (req, res) => {
    const existing = await one("SELECT image, video_url FROM products WHERE id = ?", [req.params.id]);
    const info = await run("DELETE FROM products WHERE id = ?", [req.params.id]);
    if (!info.rowCount) return res.status(404).json({ error: "Product not found." });
    if (existing) {
      for (const url of [existing.image, existing.video_url]) {
        if (url) mediaStorage.remove(url).catch(err => {
          console.warn("[upload] failed to remove stored media:", err && err.message ? err.message : err);
        });
      }
    }
    res.json({ ok: true });
  }));

  /* ------------------------------------------------------------------ */
  /*  Category management (admin protected)                              */
  /* ------------------------------------------------------------------ */
  async function categoryOrNull(id) {
    return one("SELECT * FROM categories WHERE id = ?", [Number(id)]);
  }

  app.post("/api/admin/categories", requireAdmin, sameOrigin, wrap(async (req, res) => {
    const { errors, values } = await validateCategory(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(" ") });
    const inserted = await insertRow(
      "INSERT INTO categories(name, slug, description, image) VALUES (?, ?, ?, ?) RETURNING id",
      [values.name, values.slug, values.description, values.image]
    );
    res.status(201).json(await one(`
      SELECT c.*, (SELECT COUNT(*) FROM products WHERE category_id = c.id) AS product_count
      FROM categories c WHERE c.id = ?`, [inserted.id]));
  }));

  app.put("/api/admin/categories/:id", requireAdmin, sameOrigin, wrap(async (req, res) => {
    const existing = await categoryOrNull(req.params.id);
    if (!existing) return res.status(404).json({ error: "Category not found." });
    const { errors, values } = await validateCategory(req.body, existing.id);
    if (errors.length) return res.status(400).json({ error: errors.join(" ") });

    await withTx(async conn => {
      await conn.query(
        "UPDATE categories SET name = ?, slug = ?, description = ?, image = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [values.name, values.slug, values.description, values.image, existing.id]
      );
      /* Keep the denormalised product category label in sync so every product
         in the renamed category continues to display its category correctly. */
      await conn.query("UPDATE products SET category = ? WHERE category_id = ?", [values.name, existing.id]);
    });

    res.json(await one(`
      SELECT c.*, (SELECT COUNT(*) FROM products WHERE category_id = c.id) AS product_count
      FROM categories c WHERE c.id = ?`, [existing.id]));
  }));

  app.delete("/api/admin/categories/:id", requireAdmin, sameOrigin, wrap(async (req, res) => {
    const existing = await categoryOrNull(req.params.id);
    if (!existing) return res.status(404).json({ error: "Category not found." });

    const productCount = Number((await one(
      "SELECT COUNT(*) AS n FROM products WHERE category_id = ?", [existing.id]
    )).n);

    if (productCount > 0) {
      const moveTo = Number(req.query.to);
      if (!Number.isInteger(moveTo) || moveTo <= 0 || moveTo === existing.id) {
        return res.status(409).json({
          error: `This category contains ${productCount} product${productCount === 1 ? "" : "s"}. Move or remove ${productCount === 1 ? "it" : "them"} before deleting the category.`,
          count: productCount
        });
      }
      const target = await categoryOrNull(moveTo);
      if (!target) return res.status(400).json({ error: "Please choose a valid category to move products to." });

      await withTx(async conn => {
        await conn.query("UPDATE products SET category_id = ?, category = ? WHERE category_id = ?",
          [target.id, target.name, existing.id]);
        await conn.query("DELETE FROM categories WHERE id = ?", [existing.id]);
      });
      return res.json({ ok: true, moved: productCount });
    }

    await run("DELETE FROM categories WHERE id = ?", [existing.id]);
    res.json({ ok: true });
  }));

  app.get("/api/admin/customers", requireAdmin, wrap(async (req, res) => {
    const rows = await query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM orders WHERE LOWER(orders.email) = c.email) AS order_count,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE LOWER(orders.email) = c.email AND orders.status != 'Cancelled') AS total_spent
      FROM customers c ORDER BY c.id DESC LIMIT 300`);
    res.json(rows);
  }));

  /* ------------------------------------------------------------------ */
  /*  Newsletter subscribers (admin)                                     */
  /* ------------------------------------------------------------------ */
  app.get("/api/admin/subscribers", requireAdmin, wrap(async (req, res) => {
    const search = String(req.query.q || "").trim().toLowerCase();
    const status = String(req.query.status || "").trim();
    const where = [];
    const params = [];
    if (search) { where.push("email ILIKE ?"); params.push(`%${search}%`); }
    if (status === "subscribed" || status === "unsubscribed") { where.push("status = ?"); params.push(status); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [subscribers, stats] = await Promise.all([
      query(`SELECT id, email, status, created_at, updated_at
             FROM newsletter_subscribers ${clause} ORDER BY created_at DESC, id DESC LIMIT 500`, params),
      one(`SELECT
        (SELECT COUNT(*) FROM newsletter_subscribers) AS total,
        (SELECT COUNT(*) FROM newsletter_subscribers WHERE status = 'subscribed') AS active,
        (SELECT COUNT(*) FROM newsletter_subscribers WHERE status = 'unsubscribed') AS unsubscribed,
        (SELECT COUNT(*) FROM newsletter_subscribers WHERE created_at >= date_trunc('month', CURRENT_TIMESTAMP)) AS new_this_month`)
    ]);
    res.json({
      stats: {
        total: Number(stats.total), active: Number(stats.active),
        unsubscribed: Number(stats.unsubscribed), newThisMonth: Number(stats.new_this_month)
      },
      subscribers
    });
  }));

  app.post("/api/admin/subscribers", requireAdmin, sameOrigin, wrap(async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const status = req.body.status === "unsubscribed" ? "unsubscribed" : "subscribed";
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "A valid email address is required." });
    if (await one("SELECT id FROM newsletter_subscribers WHERE email = ?", [email])) {
      return res.status(409).json({ error: "This email is already on the list." });
    }
    const inserted = await insertRow(
      "INSERT INTO newsletter_subscribers(email, status, unsub_token) VALUES (?, ?, ?) RETURNING id",
      [email, status, crypto.randomBytes(24).toString("hex")]
    );
    res.status(201).json(await one(
      "SELECT id, email, status, created_at, updated_at FROM newsletter_subscribers WHERE id = ?",
      [inserted.id]
    ));
  }));

  app.put("/api/admin/subscribers/:id", requireAdmin, sameOrigin, wrap(async (req, res) => {
    const existing = await one("SELECT id, email, unsub_token FROM newsletter_subscribers WHERE id = ?", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "Subscriber not found." });
    const email = String(req.body.email || existing.email).trim().toLowerCase();
    const status = req.body.status === "unsubscribed" ? "unsubscribed" : "subscribed";
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "A valid email address is required." });
    if (await one("SELECT id FROM newsletter_subscribers WHERE email = ? AND id <> ?", [email, existing.id])) {
      return res.status(409).json({ error: "Another subscriber already uses this email." });
    }
    /* Regenerate the unsubscribe token whenever an address is re-activated so
       the same link cannot be used twice. */
    const token = status === "subscribed" ? crypto.randomBytes(24).toString("hex") : existing.unsub_token;
    await run(
      "UPDATE newsletter_subscribers SET email = ?, status = ?, unsub_token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [email, status, token, existing.id]
    );
    res.json(await one(
      "SELECT id, email, status, created_at, updated_at FROM newsletter_subscribers WHERE id = ?",
      [existing.id]
    ));
  }));

  app.delete("/api/admin/subscribers/:id", requireAdmin, sameOrigin, wrap(async (req, res) => {
    const info = await run("DELETE FROM newsletter_subscribers WHERE id = ?", [req.params.id]);
    if (!info.rowCount) return res.status(404).json({ error: "Subscriber not found." });
    res.json({ ok: true });
  }));

  /* Newsletter broadcast. Sends individually (concurrency-limited) so no
     subscriber ever sees another subscriber's address in To/Cc/Bcc. A failed
     send is reported, never blocking the remaining recipients, and subscribers
     are never removed from the database because of a mail error. */
  app.post("/api/admin/newsletter/send", requireAdmin, sameOrigin, wrap(async (req, res) => {
    const subject = String(req.body.subject || "").trim();
    const message = String(req.body.message || "").trim();
    const testOnly = req.body.test === true;
    if (!subject || subject.length > 150) {
      return res.status(400).json({ error: "A subject between 1 and 150 characters is required." });
    }
    if (message.length < 2 || message.length > 40000) {
      return res.status(400).json({ error: "The newsletter message must be between 2 and 40,000 characters." });
    }

    if (testOnly) {
      const to = (req.session.admin && req.session.admin.email) || STORE_EMAIL;
      const result = await sendMail(
        newsletterCampaignMail({ email: to, unsubToken: "__test__", subject, message }),
        "Newsletter test email"
      );
      return res.json({
        ok: true, test: true, to,
        sent: result.sent ? 1 : 0, failed: result.sent ? 0 : 1,
        email: result
      });
    }

    const subscribers = await query(
      "SELECT id, email, unsub_token FROM newsletter_subscribers WHERE status = 'subscribed' ORDER BY id ASC"
    );
    if (!subscribers.length) {
      return res.status(400).json({ error: "There are no active subscribers to send to yet." });
    }

    const results = { total: subscribers.length, sent: 0, failed: 0, failures: [] };
    const CONCURRENCY = 5;
    let cursor = 0;
    const worker = async () => {
      while (cursor < subscribers.length) {
        const sub = subscribers[cursor++];
        try {
          const out = await sendMail(
            newsletterCampaignMail({ email: sub.email, unsubToken: sub.unsub_token, subject, message }),
            "Newsletter"
          );
          if (out.sent) results.sent += 1;
          else {
            results.failed += 1;
            results.failures.push({ email: sub.email, error: out.error || "send failed" });
          }
        } catch (err) {
          results.failed += 1;
          results.failures.push({ email: sub.email, error: err && err.message ? err.message : String(err) });
        }
      }
    };
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, subscribers.length) },
      () => worker()
    );
    await Promise.all(workers);

    console.log(`[newsletter] Broadcast "${subject}" -> ${results.sent}/${results.total} sent, ${results.failed} failed`);
    res.json({ ok: true, results });
  }));

  app.post("/api/admin/password", requireAdmin, sameOrigin, wrap(async (req, res) => {
    const current = String(req.body.current || "");
    const next = String(req.body.password || "");
    if (next.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });
    const admin = await one("SELECT * FROM admin_users WHERE id = ?", [req.session.admin.id]);
    if (!admin || !bcrypt.compareSync(current, admin.password_hash)) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }
    await run("UPDATE admin_users SET password_hash = ? WHERE id = ?", [bcrypt.hashSync(next, 12), admin.id]);
    res.json({ ok: true });
  }));

  /* ------------------------------------------------------------------ */
  /*  Admin pages                                                        */
  /* ------------------------------------------------------------------ */
  app.get("/admin/login", (req, res) => {
    if (req.session && req.session.admin) return res.redirect("/admin");
    res.sendFile(path.join(__dirname, "public", "admin", "login.html"));
  });
  app.get("/admin", requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, "public", "admin", "dashboard.html"));
  });

  /* ------------------------------------------------------------------ */
  /*  Category pages                                                     */
  /* ------------------------------------------------------------------ */
  app.get("/category/:slug", wrap(async (req, res) => {
    const category = await one("SELECT id, name, slug FROM categories WHERE LOWER(slug) = LOWER(?)", [req.params.slug]);
    if (!category) return res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
    res.sendFile(path.join(__dirname, "public", "category.html"));
  }));

  /* ------------------------------------------------------------------ */
  /*  Newsletter unsubscribe                                             */
  /* ------------------------------------------------------------------ */
  app.get("/unsubscribe", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "unsubscribe.html"));
  });

  /* ------------------------------------------------------------------ */
  /*  Customer order tracking page                                       */
  /*  Explicit routes (also covered by the static middleware below) so a  */
  /*  missing extension can never 404 in production. The page reads the   */
  /*  secure token from the query string and talks to /api/track-order.   */
  /* ------------------------------------------------------------------ */
  app.get(["/track-order", "/track-order.html"], (req, res) => {
    res.sendFile(path.join(__dirname, "public", "track-order.html"));
  });

  /* ------------------------------------------------------------------ */
  /*  Static files + friendly error pages                                */
  /* ------------------------------------------------------------------ */
  app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

  app.use((req, res) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found." });
    res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
  });

  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return next(err);
    if (req.path.startsWith("/api/")) return res.status(500).json({ error: "Something went wrong. Please try again." });
    res.status(500).sendFile(path.join(__dirname, "public", "500.html"));
  });

  app.listen(PORT, () => console.log(`${BRAND_NAME} running at http://localhost:${PORT}`));
})().catch(err => {
  const parts = [];
  if (err && Array.isArray(err.errors) && err.errors.length) {
    for (const sub of err.errors) parts.push(sub && sub.message ? sub.message : String(sub));
  }
  const summary = parts.length
    ? `${err.name || "AggregateError"}: ${parts.join("; ")}`
    : (err && err.message ? err.message : String(err));
  console.error("Failed to start Marygold Collections: " + summary);
  if (/ETIMEDOUT|ENETUNREACH|ECONNREFUSED|ENOTFOUND|SELF_SIGNED_CERT|CERT_HAS_EXPIRED/.test(summary)) {
    console.error(
      "The app could not reach its PostgreSQL database. Check that DATABASE_URL / PG* variables point at an " +
      "external, internet-accessible PostgreSQL server (Render instances have no local PostgreSQL and " +
      "localhost/127.0.0.1 will not work). Add ?sslmode=require to DATABASE_URL (or PGSSL=require) if the " +
      "provider requires TLS, and allowlist Render's egress IPs if the provider uses one."
    );
  }
  process.exit(1);
});