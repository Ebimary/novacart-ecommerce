const express = require("express");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");

/* ------------------------------------------------------------------ */
/*  Configuration (all secrets come from environment variables)        */
/* ------------------------------------------------------------------ */
const SESSION_SECRET = process.env.SESSION_SECRET || "nova-local-dev-secret-change-me";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@novacart.com").trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const DELIVERY_FEE = 2500;
const FREE_DELIVERY_THRESHOLD = 100000;
const ORDER_STATUSES = ["Pending", "Confirmed", "Processing", "Shipped", "Delivered", "Cancelled"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_DATABASE = "novacart";

/* Database connection settings. Prefer a single DATABASE_URL
   (e.g. mysql://user:pass@host:port/novacart) or individual
   MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE. */
function dbConfig() {
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    return {
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username || ""),
      password: decodeURIComponent(u.password || ""),
      database: (u.pathname.replace(/^\//, "") || DEFAULT_DATABASE).replace(/`/g, "")
    };
  }
  return {
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "novacart",
    password: process.env.MYSQL_PASSWORD || "",
    database: (process.env.MYSQL_DATABASE || DEFAULT_DATABASE).replace(/`/g, "")
  };
}

let pool;

async function initDatabase() {
  const cfg = dbConfig();
  const bootstrap = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, charset: "utf8mb4"
  });
  try {
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await bootstrap.end();
  }

  pool = mysql.createPool({
    ...cfg,
    charset: "utf8mb4",
    timezone: "Z",
    dateStrings: true,
    connectionLimit: 10,
    waitForConnections: true
  });

  /* Schema — created idempotently, existing data is preserved. */
  const schema = [
    `CREATE TABLE IF NOT EXISTS categories (
       id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       name VARCHAR(80) NOT NULL UNIQUE,
       slug VARCHAR(80) NOT NULL UNIQUE,
       description TEXT,
       image TEXT,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS products (
       id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       name VARCHAR(160) NOT NULL,
       category VARCHAR(80) NOT NULL,
       price INT NOT NULL,
       image TEXT NOT NULL,
       stock INT NOT NULL DEFAULT 20,
       description TEXT,
       featured TINYINT(1) NOT NULL DEFAULT 0,
       rating DECIMAL(3,2) NOT NULL DEFAULT 4.50,
       is_active TINYINT(1) NOT NULL DEFAULT 1,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       category_id INT NULL,
       INDEX idx_products_category (category),
       INDEX idx_products_category_id (category_id),
       CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories(id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS orders (
       id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       order_number VARCHAR(20) NULL,
       customer VARCHAR(160) NOT NULL,
       email VARCHAR(254) NOT NULL,
       phone VARCHAR(40) DEFAULT '',
       address VARCHAR(255) DEFAULT '',
       city VARCHAR(100) DEFAULT '',
       state VARCHAR(100) DEFAULT '',
       country VARCHAR(100) DEFAULT 'Nigeria',
       subtotal INT NOT NULL DEFAULT 0,
       delivery_fee INT NOT NULL DEFAULT 0,
       total INT NOT NULL DEFAULT 0,
       payment_method VARCHAR(40) DEFAULT 'Cash on Delivery',
       payment_status VARCHAR(20) NOT NULL DEFAULT 'Pending',
       status VARCHAR(20) NOT NULL DEFAULT 'Pending',
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_orders_status (status),
       INDEX idx_orders_email (email)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS order_items (
       id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       order_id INT NOT NULL,
       product_id INT NOT NULL,
       quantity INT NOT NULL,
       price INT NOT NULL,
       INDEX idx_order_items_order (order_id),
       INDEX idx_order_items_product (product_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS customers (
       id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       name VARCHAR(160) NOT NULL DEFAULT '',
       email VARCHAR(254) NOT NULL UNIQUE,
       phone VARCHAR(40) DEFAULT '',
       address VARCHAR(255) DEFAULT '',
       city VARCHAR(100) DEFAULT '',
       state VARCHAR(100) DEFAULT '',
       country VARCHAR(100) DEFAULT 'Nigeria',
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS admin_users (
       id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       email VARCHAR(254) NOT NULL UNIQUE,
       password_hash VARCHAR(255) NOT NULL,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS sessions (
       sid VARCHAR(128) NOT NULL PRIMARY KEY,
       data TEXT NOT NULL,
       expires_at BIGINT NOT NULL
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS newsletter_subscribers (
       id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       email VARCHAR(254) NOT NULL UNIQUE,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS contact_messages (
       id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       name VARCHAR(160) NOT NULL DEFAULT '',
       email VARCHAR(254) NOT NULL DEFAULT '',
       subject VARCHAR(200) NOT NULL DEFAULT '',
       message TEXT NOT NULL,
       created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  ];
  for (const ddl of schema) await pool.query(ddl);

  await ensureColumn("products", "featured", "featured TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn("products", "rating", "rating DECIMAL(3,2) NOT NULL DEFAULT 4.50");
  await ensureColumn("products", "is_active", "is_active TINYINT(1) NOT NULL DEFAULT 1");
  await ensureColumn("products", "created_at", "created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP");
  await ensureColumn("products", "category_id", "category_id INT NULL");
  await ensureColumn("orders", "order_number", "order_number VARCHAR(20) NULL");
  await ensureColumn("orders", "phone", "phone VARCHAR(40) DEFAULT ''");
  await ensureColumn("orders", "address", "address VARCHAR(255) DEFAULT ''");
  await ensureColumn("orders", "city", "city VARCHAR(100) DEFAULT ''");
  await ensureColumn("orders", "state", "state VARCHAR(100) DEFAULT ''");
  await ensureColumn("orders", "country", "country VARCHAR(100) DEFAULT 'Nigeria'");
  await ensureColumn("orders", "subtotal", "subtotal INT NOT NULL DEFAULT 0");
  await ensureColumn("orders", "delivery_fee", "delivery_fee INT NOT NULL DEFAULT 0");
  await ensureColumn("orders", "payment_method", "payment_method VARCHAR(40) DEFAULT 'Cash on Delivery'");
  await ensureColumn("orders", "payment_status", "payment_status VARCHAR(20) NOT NULL DEFAULT 'Pending'");

  /* Normalise the legacy "Clothes" category and backfill order numbers. */
  await pool.query("UPDATE products SET category = 'Clothing' WHERE category IN ('Clothes', 'CLOTHES')");
  await pool.query(
    `UPDATE orders SET order_number = CONCAT('NC-', LPAD(id, 6, '0'))
     WHERE order_number IS NULL OR order_number = ''`
  );

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
      await run("INSERT IGNORE INTO categories(name, slug) VALUES (?, ?)", [name, slugify(name)]);
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
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
    [ADMIN_EMAIL, hash]
  );
}

/* Query helpers ------------------------------------------------------ */
async function query(sql, params) {
  const [rows] = await pool.query(sql, params || []);
  return rows;
}
async function one(sql, params) {
  const [rows] = await pool.query(sql, params || []);
  return rows[0];
}
async function run(sql, params) {
  const [result] = await pool.query(sql, params || []);
  return result;
}

async function columnExists(table, column) {
  const rows = await query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
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
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* connection may have failed */ }
    throw err;
  } finally {
    conn.release();
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
  if (!image) errors.push("A product image URL is required.");
  else if (!/^https?:\/\/\S+$/i.test(image)) errors.push("Image must be a valid http(s) URL.");
  if (description.length > 2000) errors.push("Description must be 2000 characters or fewer.");
  const featured = body.featured ? 1 : 0;
  const rating = Number(body.rating);
  const rate = Number.isFinite(rating) && rating >= 0 && rating <= 5 ? rating : 4.5;
  return {
    errors,
    values: {
      name, price, stock, image, description, featured, rating: rate,
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
/*  Session store (MySQL backed so logins survive restarts)            */
/* ------------------------------------------------------------------ */
class MySQLSessionStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    const sweep = async () => {
      try { await this.db.query("DELETE FROM sessions WHERE expires_at < ?", [Date.now()]); } catch (_) { /* ignore */ }
    };
    sweep();
    this._timer = setInterval(sweep, 30 * 60 * 1000);
    if (this._timer.unref) this._timer.unref();
  }
  get(sid, cb) {
    this.db.query("SELECT data, expires_at FROM sessions WHERE sid = ?", [sid])
      .then(([rows]) => {
        const row = rows[0];
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
    this.db.query(
      `INSERT INTO sessions(sid, data, expires_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data), expires_at = VALUES(expires_at)`,
      [sid, JSON.stringify(sess), expires]
    ).then(() => cb && cb(null)).catch(err => cb && cb(err));
  }
  destroy(sid, cb) {
    this.db.query("DELETE FROM sessions WHERE sid = ?", [sid])
      .then(() => cb && cb(null)).catch(err => cb && cb(err));
  }
  touch(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires
      ? sess.cookie.expires.getTime()
      : Date.now() + 24 * 60 * 60 * 1000;
    this.db.query("UPDATE sessions SET expires_at = ? WHERE sid = ?", [expires, sid])
      .then(() => cb && cb(null)).catch(err => cb && cb(err));
  }
}

(async function main() {
  await initDatabase();

  const app = express();
  const PORT = process.env.PORT || 3000;

  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));

  app.use(session({
    store: new MySQLSessionStore(pool),
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
    res.json({ currency: "NGN", deliveryFee: DELIVERY_FEE, freeDeliveryThreshold: FREE_DELIVERY_THRESHOLD, categories: cats });
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
    SELECT p.id, p.name, p.image, p.price, p.stock, p.description, p.featured, p.rating,
      p.is_active, p.created_at, p.category_id,
      c.name AS category, c.slug AS category_slug
    FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

  app.get("/api/products", wrap(async (req, res) => {
    const { q, category, slug, category_id, sort, min, max, featured, limit } = req.query;
    const where = ["p.is_active = 1"];
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
      where.push("(p.name LIKE ? OR c.name LIKE ? OR p.description LIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const minN = Number(min);
    if (Number.isFinite(minN) && minN >= 0) { where.push("p.price >= ?"); params.push(Math.round(minN)); }
    const maxN = Number(max);
    if (Number.isFinite(maxN) && maxN > 0) { where.push("p.price <= ?"); params.push(Math.round(maxN)); }
    if (featured === "1") where.push("p.featured = 1");

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
      `${P} WHERE p.is_active = 1 AND p.category_id = ? AND p.id != ? ORDER BY p.featured DESC, p.id DESC LIMIT 4`,
      [product.category_id, product.id]
    );
    res.json(rows);
  }));

  app.get("/api/products/:id", wrap(async (req, res) => {
    const product = await one(P + " WHERE p.id = ? AND p.is_active = 1", [req.params.id]);
    if (!product) return res.status(404).json({ error: "Product not found." });
    res.json(product);
  }));

  app.get("/api/home", wrap(async (req, res) => {
    const featured = await query(`${P} WHERE p.is_active = 1 AND p.featured = 1 ORDER BY p.id DESC LIMIT 8`);
    const categories = await query(`
      SELECT c.id, c.name, c.slug, c.description, c.image,
        (SELECT COUNT(*) FROM products WHERE category_id = c.id AND is_active = 1) AS count
      FROM categories c ORDER BY c.id ASC`);
    const bestsellers = await query(`
      SELECT p.id, p.name, p.image, p.price, p.rating, p.stock, c.name AS category, c.slug AS category_slug,
        COALESCE(SUM(oi.quantity), 0) AS sold
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN order_items oi ON oi.product_id = p.id
      LEFT JOIN orders o ON o.id = oi.order_id AND o.status != 'Cancelled'
      WHERE p.is_active = 1
      GROUP BY p.id ORDER BY sold DESC, p.id DESC LIMIT 4`);
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

    const orderId = await withTx(async conn => {
      await conn.query(
        `INSERT INTO customers(name, email, phone, address, city, state, country)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), phone = VALUES(phone),
           address = VALUES(address), city = VALUES(city), state = VALUES(state),
           country = VALUES(country), updated_at = CURRENT_TIMESTAMP`,
        [customerName, customerEmail, customerPhone, customerAddress, customerCity, customerState, customerCountry]
      );
      const [ordRes] = await conn.query(
        `INSERT INTO orders(order_number, customer, email, phone, address, city, state, country,
           subtotal, delivery_fee, total, payment_method, payment_status, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'Pending')`,
        [null, customerName, customerEmail, customerPhone, customerAddress,
         customerCity, customerState, customerCountry, subtotal, delivery, total, method]
      );
      const oid = ordRes.insertId;
      for (const { product, qty } of checked) {
        await conn.query(
          "INSERT INTO order_items(order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)",
          [oid, product.id, qty, product.price]
        );
        await conn.query("UPDATE products SET stock = stock - ? WHERE id = ?", [qty, product.id]);
      }
      await conn.query("UPDATE orders SET order_number = ? WHERE id = ?", [nextOrderNumber(oid), oid]);
      return oid;
    });

    const order = await one("SELECT * FROM orders WHERE id = ?", [orderId]);
    const orderItems = await query(
      "SELECT oi.*, p.name AS product_name, p.image FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?",
      [orderId]
    );
    res.status(201).json({ order, items: orderItems });
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
    res.json({ ...order, items });
  }));

  app.post("/api/newsletter", wrap(async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "A valid email address is required." });
    await run("INSERT IGNORE INTO newsletter_subscribers(email) VALUES (?)", [email]);
    res.json({ ok: true });
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
      GROUP BY p.id ORDER BY sold DESC LIMIT 8`);

    const categoryPerformance = await query(`
      SELECT c.name AS category, COALESCE(SUM(oi.quantity), 0) AS units, COALESCE(SUM(oi.price * oi.quantity), 0) AS revenue
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id AND p.is_active = 1
      LEFT JOIN order_items oi ON oi.product_id = p.id
      LEFT JOIN orders o ON o.id = oi.order_id AND o.status != 'Cancelled'
      GROUP BY c.id, c.name ORDER BY revenue DESC`);

    const daily = await query(`
      SELECT SUBSTR(created_at, 1, 10) AS day, COUNT(*) AS orders,
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

    res.json({ bestSellers, categoryPerformance, salesOverview, recentOrders, ordersByStatus });
  }));

  app.get("/api/admin/orders", requireAdmin, wrap(async (req, res) => {
    const rows = await query(`
      SELECT o.*, (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS item_count,
        (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = o.id) AS item_qty
      FROM orders o ORDER BY o.id DESC LIMIT 300`);
    res.json(rows);
  }));

  app.put("/api/admin/orders/:id/status", requireAdmin, sameOrigin, wrap(async (req, res) => {
    const status = String(req.body.status || "").trim();
    if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: "Invalid order status." });
    const existing = await one("SELECT id FROM orders WHERE id = ?", [req.params.id]);
    if (!existing) return res.status(404).json({ error: "Order not found." });
    await run("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id]);
    res.json(await one("SELECT * FROM orders WHERE id = ?", [req.params.id]));
  }));

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
    const info = await run(
      "INSERT INTO products(name, category, category_id, price, image, stock, description, featured, rating) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [values.name, values.category, values.category_id, values.price, values.image, values.stock, values.description, values.featured, values.rating]
    );
    res.status(201).json(await one(
      "SELECT p.*, c.name AS category_name, c.slug AS category_slug FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?",
      [info.insertId]
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
      "UPDATE products SET name = ?, category = ?, category_id = ?, price = ?, image = ?, stock = ?, description = ?, featured = ?, rating = ? WHERE id = ?",
      [values.name, values.category, values.category_id, values.price, values.image, values.stock, values.description, values.featured, values.rating, existing.id]
    );
    res.json(await one(
      "SELECT p.*, c.name AS category_name, c.slug AS category_slug FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?",
      [existing.id]
    ));
  }));

  app.delete("/api/admin/products/:id", requireAdmin, sameOrigin, wrap(async (req, res) => {
    const info = await run("DELETE FROM products WHERE id = ?", [req.params.id]);
    if (!info.affectedRows) return res.status(404).json({ error: "Product not found." });
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
    const info = await run(
      "INSERT INTO categories(name, slug, description, image) VALUES (?, ?, ?, ?)",
      [values.name, values.slug, values.description, values.image]
    );
    res.status(201).json(await one(`
      SELECT c.*, (SELECT COUNT(*) FROM products WHERE category_id = c.id) AS product_count
      FROM categories c WHERE c.id = ?`, [info.insertId]));
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

  app.listen(PORT, () => console.log(`NovaCart running at http://localhost:${PORT}`));
})().catch(err => {
  console.error("Failed to start NovaCart: " + (err && err.message ? err.message : err));
  process.exit(1);
});