const express = require("express");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------ */
/*  Configuration (all secrets come from environment variables)        */
/* ------------------------------------------------------------------ */
const SESSION_SECRET = process.env.SESSION_SECRET || "nova-local-dev-secret-change-me";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@novacart.com").trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "novacart.db");
const DELIVERY_FEE = 2500;
const FREE_DELIVERY_THRESHOLD = 100000;
const ORDER_STATUSES = ["Pending", "Confirmed", "Processing", "Shipped", "Delivered", "Cancelled"];

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

/* ------------------------------------------------------------------ */
/*  Database — schema + safe migrations (existing data is preserved)   */
/* ------------------------------------------------------------------ */
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, category TEXT NOT NULL, price INTEGER NOT NULL,
  image TEXT NOT NULL, stock INTEGER NOT NULL DEFAULT 20,
  description TEXT DEFAULT '', featured INTEGER NOT NULL DEFAULT 0,
  rating REAL NOT NULL DEFAULT 4.5, is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT, customer TEXT NOT NULL, email TEXT NOT NULL,
  phone TEXT DEFAULT '', address TEXT DEFAULT '', city TEXT DEFAULT '',
  state TEXT DEFAULT '', country TEXT DEFAULT 'Nigeria',
  subtotal INTEGER NOT NULL DEFAULT 0, delivery_fee INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT DEFAULT 'Cash on Delivery',
  payment_status TEXT NOT NULL DEFAULT 'Pending',
  status TEXT NOT NULL DEFAULT 'Pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL, quantity INTEGER NOT NULL, price INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '', email TEXT UNIQUE NOT NULL,
  phone TEXT DEFAULT '', address TEXT DEFAULT '', city TEXT DEFAULT '',
  state TEXT DEFAULT '', country TEXT DEFAULT 'Nigeria',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '', image TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name_lower ON categories(LOWER(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_slug_lower ON categories(LOWER(slug));
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);
`);

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/* Migrate existing databases without destroying data. */
ensureColumn("products", "featured", "featured INTEGER NOT NULL DEFAULT 0");
ensureColumn("products", "rating", "rating REAL NOT NULL DEFAULT 4.5");
ensureColumn("products", "is_active", "is_active INTEGER NOT NULL DEFAULT 1");
ensureColumn("products", "created_at", "created_at TEXT DEFAULT CURRENT_TIMESTAMP");
ensureColumn("products", "category_id", "category_id INTEGER REFERENCES categories(id)");
ensureColumn("orders", "order_number", "order_number TEXT");
ensureColumn("orders", "phone", "phone TEXT DEFAULT ''");
ensureColumn("orders", "address", "address TEXT DEFAULT ''");
ensureColumn("orders", "city", "city TEXT DEFAULT ''");
ensureColumn("orders", "state", "state TEXT DEFAULT ''");
ensureColumn("orders", "country", "country TEXT DEFAULT 'Nigeria'");
ensureColumn("orders", "subtotal", "subtotal INTEGER DEFAULT 0");
ensureColumn("orders", "delivery_fee", "delivery_fee INTEGER DEFAULT 0");
ensureColumn("orders", "payment_method", "payment_method TEXT DEFAULT 'Cash on Delivery'");
ensureColumn("orders", "payment_status", "payment_status TEXT DEFAULT 'Pending'");

db.exec("CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id)");

/* Normalise the legacy "Clothes" category and backfill order numbers. */
db.prepare("UPDATE products SET category=? WHERE category IN (?, ?)")
  .run("Clothing", "Clothes", "CLOTHES");
db.exec(`UPDATE orders SET order_number = 'NC-' || printf('%06d', id)
         WHERE order_number IS NULL OR order_number = ''`);

/* Seed default categories. Idempotent: safe to run on every boot and never
   duplicates categories that already exist (matches name or slug). */
const DEFAULT_CATEGORIES = [
  { name: "Clothing", slug: "clothing", description: "Tailored and everyday essentials.", image: "" },
  { name: "Shoes", slug: "shoes", description: "From sneakers to statement styles.", image: "" },
  { name: "Jewelry", slug: "jewelry", description: "Pieces that finish every outfit.", image: "" },
  { name: "Accessories", slug: "accessories", description: "Watches, belts and finishing touches.", image: "" },
  { name: "Bags", slug: "bags", description: "Carry everyday in style.", image: "" }
];
{
  const insertCat = db.prepare(
    "INSERT OR IGNORE INTO categories(name, slug, description, image) VALUES(?, ?, ?, ?)"
  );
  const catByKey = new Map(
    db.prepare("SELECT id, name, slug FROM categories").all()
      .flatMap(r => [[r.name.toLowerCase(), r.id], [r.slug.toLowerCase(), r.id]])
  );
  for (const c of DEFAULT_CATEGORIES) {
    if (catByKey.has(c.name.toLowerCase()) || catByKey.has(c.slug.toLowerCase())) continue;
    insertCat.run(c.name, c.slug, c.description, c.image);
    const row = db.prepare("SELECT id FROM categories WHERE LOWER(name) = LOWER(?)").get(c.name);
    catByKey.set(c.name.toLowerCase(), row.id);
    catByKey.set(c.slug.toLowerCase(), row.id);
  }
}

/* Relational migration: point existing products at categories by id. Rows that
   reference a category not in the table are auto-created instead of lost. */
{
  const findByName = db.prepare("SELECT id FROM categories WHERE LOWER(name) = LOWER(?)");
  const findBySlug = db.prepare("SELECT id FROM categories WHERE LOWER(slug) = LOWER(?)");
  const insertCat = db.prepare("INSERT OR IGNORE INTO categories(name, slug) VALUES(?, ?)");
  const setCat = db.prepare("UPDATE products SET category_id = ? WHERE id = ?");
  const rows = db.prepare("SELECT id, category FROM products WHERE category_id IS NULL").all();
  const tx = db.transaction(rows => {
    for (const r of rows) {
      const name = String(r.category || "").trim();
      if (!name) continue;
      let cat = findByName.get(name) || findBySlug.get(name);
      if (!cat) {
        insertCat.run(name, slugify(name));
        cat = findByName.get(name) || findBySlug.get(name);
      }
      if (cat) setCat.run(cat.id, r.id);
    }
  });
  tx(rows);
}

/* Seed the catalog only when the products table is empty. */
const productCount = db.prepare("SELECT COUNT(*) AS n FROM products").get().n;
if (!productCount) {
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
  const insert = db.prepare(
    "INSERT INTO products(name,category,category_id,price,image,stock,description,featured,rating) VALUES(?,?,?,?,?,?,?,?,?)"
  );
  const catFor = db.prepare("SELECT id FROM categories WHERE LOWER(name) = LOWER(?)");
  const tx = db.transaction(rows => {
    for (const r of rows) {
      const cat = catFor.get(r[1]);
      insert.run(r[0], r[1], cat ? cat.id : null, ...r.slice(2));
    }
  });
  tx(seed);
}

/* Seed admin user (hashed password) from environment variables. */
{
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
  db.prepare(`INSERT INTO admin_users(email, password_hash) VALUES(?, ?)
              ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash`)
    .run(ADMIN_EMAIL, hash);
}

/* ------------------------------------------------------------------ */
/*  Session store (better-sqlite3 backed so logins survive restarts)   */
/* ------------------------------------------------------------------ */
class SQLiteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
  }
  get(sid, cb) {
    const row = this.db.prepare("SELECT data, expires_at FROM sessions WHERE sid = ?").get(sid);
    if (!row) return cb(null, null);
    if (row.expires_at < Date.now()) return cb(null, null);
    try { cb(null, JSON.parse(row.data)); } catch (err) { cb(err); }
  }
  set(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires
      ? sess.cookie.expires.getTime()
      : Date.now() + 24 * 60 * 60 * 1000;
    this.db.prepare(`INSERT INTO sessions(sid, data, expires_at) VALUES(?, ?, ?)
                     ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`)
      .run(sid, JSON.stringify(sess), expires);
    if (cb) cb(null);
  }
  destroy(sid, cb) {
    this.db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
    if (cb) cb(null);
  }
  touch(sid, sess, cb) {
    const expires = sess.cookie && sess.cookie.expires
      ? sess.cookie.expires.getTime()
      : Date.now() + 24 * 60 * 60 * 1000;
    this.db.prepare("UPDATE sessions SET expires_at = ? WHERE sid = ?").run(expires, sid);
    if (cb) cb(null);
  }
}

app.use(session({
  store: new SQLiteSessionStore(db),
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateProduct(body) {
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
    category = db.prepare("SELECT id, name, slug FROM categories WHERE id = ?").get(categoryId);
  } else if (String(body.category || "").trim()) {
    category = db.prepare("SELECT id, name, slug FROM categories WHERE LOWER(name) = LOWER(?)")
      .get(String(body.category).trim());
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

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function validateCategory(body, excludeId) {
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

  if (name && db.prepare(
    `SELECT id FROM categories WHERE LOWER(name) = LOWER(?) AND id != COALESCE(?, -1)`
  ).get(name, excludeId || -1)) {
    errors.push("A category with this name already exists.");
  }
  if (slug && db.prepare(
    `SELECT id FROM categories WHERE LOWER(slug) = LOWER(?) AND id != COALESCE(?, -1)`
  ).get(slug, excludeId || -1)) {
    errors.push("This slug is already in use.");
  }
  if (description.length > 500) errors.push("Description must be 500 characters or fewer.");
  if (image && !/^https?:\/\/\S+$/i.test(image)) errors.push("Category image must be a valid http(s) URL.");
  return { errors, values: { name, slug, description, image } };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function deliveryFeeFor(subtotal) {
  return subtotal >= FREE_DELIVERY_THRESHOLD ? 0 : DELIVERY_FEE;
}
function nextOrderNumber(id) {
  return `NC-${String(id).padStart(6, "0")}`;
}
function money(n) {
  return Number(n) || 0;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/config", (req, res) => {
  const cats = db.prepare("SELECT name FROM categories ORDER BY id ASC").all().map(c => c.name);
  res.json({ currency: "NGN", deliveryFee: DELIVERY_FEE, freeDeliveryThreshold: FREE_DELIVERY_THRESHOLD, categories: cats });
});

app.get("/api/categories", (req, res) => {
  const slug = String(req.query.slug || "").trim();
  let rows;
  if (slug) {
    rows = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM products WHERE category_id = c.id) AS product_count
      FROM categories c WHERE LOWER(c.slug) = LOWER(?) LIMIT 1
    `).all(slug);
  } else {
    rows = db.prepare(`
      SELECT c.*, (SELECT COUNT(*) FROM products WHERE category_id = c.id) AS product_count
      FROM categories c ORDER BY c.id ASC
    `).all();
  }
  res.json(rows);
});

app.get("/api/categories/:id", (req, res) => {
  const category = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM products WHERE category_id = c.id) AS product_count
    FROM categories c WHERE c.id = ?
  `).get(Number(req.params.id));
  if (!category) return res.status(404).json({ error: "Category not found." });
  res.json(category);
});

/* Shared product projection so every product row includes its category
   without a per-product API call. */
const P = `
  SELECT p.id, p.name, p.image, p.price, p.stock, p.description, p.featured, p.rating,
    p.is_active, p.created_at, p.category_id,
    c.name AS category, c.slug AS category_slug
  FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

app.get("/api/products", (req, res) => {
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
    popular: "(SELECT COALESCE(SUM(quantity),0) FROM order_items WHERE product_id = p.id) DESC, p.id DESC"
  };
  const orderBy = sortMap[String(sort || "newest").toLowerCase()] || "p.featured DESC, p.id DESC";
  const take = Math.min(Math.max(Number(limit) || 100, 1), 200);

  const sql = `${P} WHERE ${where.join(" AND ")} ORDER BY ${orderBy} LIMIT ${take}`;
  res.json(db.prepare(sql).all(...params));
});

app.get("/api/products/:id/related", (req, res) => {
  const product = db.prepare(P + " WHERE p.id = ?").get(req.params.id);
  if (!product) return res.json([]);
  const rows = db.prepare(
    `${P} WHERE p.is_active = 1 AND p.category_id = ? AND p.id != ? ORDER BY p.featured DESC, p.id DESC LIMIT 4`
  ).all(product.category_id, product.id);
  res.json(rows);
});

app.get("/api/products/:id", (req, res) => {
  const product = db.prepare(P + " WHERE p.id = ? AND p.is_active = 1").get(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found." });
  res.json(product);
});

app.get("/api/home", (req, res) => {
  const featured = db.prepare(`${P} WHERE p.is_active = 1 AND p.featured = 1 ORDER BY p.id DESC LIMIT 8`).all();
  const categories = db.prepare(`
    SELECT c.id, c.name, c.slug, c.description, c.image,
      (SELECT COUNT(*) FROM products WHERE category_id = c.id AND is_active = 1) AS count
    FROM categories c ORDER BY c.id ASC`).all();
  const bestsellers = db.prepare(`
    SELECT p.id, p.name, p.image, p.price, p.rating, p.stock, c.name AS category, c.slug AS category_slug,
      COALESCE(SUM(oi.quantity), 0) AS sold
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN order_items oi ON oi.product_id = p.id
    LEFT JOIN orders o ON o.id = oi.order_id AND o.status != 'Cancelled'
    WHERE p.is_active = 1
    GROUP BY p.id ORDER BY sold DESC, p.id DESC LIMIT 4`).all();
  res.json({ featured, categories, bestsellers });
});

app.post("/api/orders", sameOrigin, (req, res) => {
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
    const product = db.prepare("SELECT * FROM products WHERE id = ?").get(productId);
    if (!product || !product.is_active) {
      return res.status(400).json({ error: "A product in your cart is no longer available." });
    }
    if (product.stock < qty) {
      return res.status(409).json({ error: `Only ${product.stock} of "${product.name}" left in stock.` });
    }
    subtotal += product.price * qty;
    checked.push({ product, qty });
  }

  const delivery = deliveryFeeFor(subtotal);
  const total = subtotal + delivery;

  const insertCustomer = db.prepare(`INSERT INTO customers(name, email, phone, address, city, state, country)
    VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET name = excluded.name, phone = excluded.phone,
      address = excluded.address, city = excluded.city, state = excluded.state,
      country = excluded.country, updated_at = CURRENT_TIMESTAMP`);
  const insertOrder = db.prepare(`INSERT INTO orders(order_number, customer, email, phone, address, city, state, country,
    subtotal, delivery_fee, total, payment_method, payment_status, status)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'Pending')`);
  const insertItem = db.prepare("INSERT INTO order_items(order_id, product_id, quantity, price) VALUES(?, ?, ?, ?)");
  const reduceStock = db.prepare("UPDATE products SET stock = stock - ? WHERE id = ?");
  const setOrderNumber = db.prepare("UPDATE orders SET order_number = ? WHERE id = ?");

  let orderId;
  const tx = db.transaction(() => {
    insertCustomer.run(customerName, customerEmail, customerPhone, customerAddress, customerCity, customerState, customerCountry);
    const info = insertOrder.run(null, customerName, customerEmail, customerPhone, customerAddress,
      customerCity, customerState, customerCountry, subtotal, delivery, total, method);
    orderId = Number(info.lastInsertRowid);
    for (const { product, qty } of checked) {
      insertItem.run(orderId, product.id, qty, product.price);
      reduceStock.run(qty, product.id);
    }
    setOrderNumber.run(nextOrderNumber(orderId), orderId);
  });
  tx();

  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  const orderItems = db.prepare(
    "SELECT oi.*, p.name AS product_name, p.image FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?"
  ).all(orderId);
  res.status(201).json({ order, items: orderItems });
});

app.get("/api/orders/:id", (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ? OR order_number = ?").get(req.params.id, req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found." });
  const email = String(req.query.email || "").trim().toLowerCase();
  if (!email || order.email.trim().toLowerCase() !== email) {
    return res.status(403).json({ error: "Order details are not available for this account." });
  }
  const items = db.prepare(
    "SELECT oi.*, p.name AS product_name, p.image FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?"
  ).all(order.id);
  res.json({ ...order, items });
});

app.post("/api/newsletter", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "A valid email address is required." });
  db.prepare("INSERT OR IGNORE INTO newsletter_subscribers(email) VALUES(?)").run(email);
  res.json({ ok: true });
});

app.post("/api/contact", sameOrigin, (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim();
  const subject = String(req.body.subject || "").trim();
  const message = String(req.body.message || "").trim();
  if (name.length < 2 || !EMAIL_RE.test(email) || message.length < 5) {
    return res.status(400).json({ error: "Please provide your name, a valid email and a message." });
  }
  db.prepare("INSERT INTO contact_messages(name, email, subject, message) VALUES(?, ?, ?, ?)")
    .run(name, email, subject.slice(0, 120), message.slice(0, 4000));
  res.status(201).json({ ok: true });
});

/* ------------------------------------------------------------------ */
/*  Admin authentication                                               */
/* ------------------------------------------------------------------ */
app.get("/api/admin/me", (req, res) => {
  if (!req.session || !req.session.admin) return res.status(401).json({ error: "Unauthorized" });
  res.json({ email: req.session.admin.email });
});

app.post("/api/admin/login", loginLimiter, (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  const admin = db.prepare("SELECT * FROM admin_users WHERE email = ?").get(email);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Could not start a secure session." });
    req.session.admin = { id: admin.id, email: admin.email };
    res.json({ ok: true, email: admin.email });
  });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

/* ------------------------------------------------------------------ */
/*  Admin API — every route is server-side protected by requireAdmin   */
/* ------------------------------------------------------------------ */
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const products = db.prepare("SELECT COUNT(*) AS n FROM products").get().n;
  const orders = db.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
  const revenue = db.prepare("SELECT COALESCE(SUM(total), 0) AS n FROM orders WHERE status != 'Cancelled'").get().n;
  const customers = db.prepare("SELECT COUNT(DISTINCT email) AS n FROM orders").get().n;
  const lowStock = db.prepare("SELECT COUNT(*) AS n FROM products WHERE stock > 0 AND stock < 10").get().n;
  const outOfStock = db.prepare("SELECT COUNT(*) AS n FROM products WHERE stock <= 0").get().n;
  res.json({ products, orders, revenue, customers, lowStock, outOfStock });
});

app.get("/api/admin/analytics", requireAdmin, (req, res) => {
  const bestSellers = db.prepare(`
    SELECT p.id, p.name, p.image, p.price, p.stock, COALESCE(SUM(oi.quantity), 0) AS sold,
      COALESCE(SUM(oi.price * oi.quantity), 0) AS revenue
    FROM products p
    LEFT JOIN order_items oi ON oi.product_id = p.id
    LEFT JOIN orders o ON o.id = oi.order_id AND o.status != 'Cancelled'
    GROUP BY p.id ORDER BY sold DESC LIMIT 8`).all();

  const categoryPerformance = db.prepare(`
    SELECT c.name AS category, COALESCE(SUM(oi.quantity), 0) AS units, COALESCE(SUM(oi.price * oi.quantity), 0) AS revenue
    FROM categories c
    LEFT JOIN products p ON p.category_id = c.id AND p.is_active = 1
    LEFT JOIN order_items oi ON oi.product_id = p.id
    LEFT JOIN orders o ON o.id = oi.order_id AND o.status != 'Cancelled'
    GROUP BY c.id, c.name ORDER BY revenue DESC`).all();

  const daily = db.prepare(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS orders,
      COALESCE(SUM(total), 0) AS revenue
    FROM orders WHERE status != 'Cancelled'
    GROUP BY day ORDER BY day DESC LIMIT 30`).all();
  const dayMap = new Map(daily.map(d => [d.day, d]));
  const salesOverview = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const row = dayMap.get(key);
    salesOverview.push({ day: key, orders: row ? row.orders : 0, revenue: row ? row.revenue : 0 });
  }

  const recentOrders = db.prepare(`
    SELECT o.*, (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = o.id) AS item_qty
    FROM orders o ORDER BY o.id DESC LIMIT 10`).all();
  const ordersByStatus = db.prepare("SELECT status, COUNT(*) AS count FROM orders GROUP BY status").all();

  res.json({ bestSellers, categoryPerformance, salesOverview, recentOrders, ordersByStatus });
});

app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT o.*, (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) AS item_count,
      (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = o.id) AS item_qty
    FROM orders o ORDER BY o.id DESC LIMIT 300`).all();
  res.json(rows);
});

app.put("/api/admin/orders/:id/status", requireAdmin, sameOrigin, (req, res) => {
  const status = String(req.body.status || "").trim();
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: "Invalid order status." });
  const info = db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, req.params.id);
  if (!info.changes) return res.status(404).json({ error: "Order not found." });
  res.json(db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id));
});

app.get("/api/admin/products", requireAdmin, (req, res) => {
  res.json(db.prepare(
    "SELECT p.*, c.name AS category_name, c.slug AS category_slug FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.id DESC"
  ).all());
});

app.post("/api/admin/products", requireAdmin, sameOrigin, (req, res) => {
  const { errors, values } = validateProduct(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });
  if (db.prepare("SELECT id FROM products WHERE LOWER(name) = ?").get(values.name.toLowerCase()))
    return res.status(409).json({ error: "A product with this name already exists." });
  const info = db.prepare(
    "INSERT INTO products(name, category, category_id, price, image, stock, description, featured, rating) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(values.name, values.category, values.category_id, values.price, values.image, values.stock, values.description, values.featured, values.rating);
  res.status(201).json(db.prepare(
    "SELECT p.*, c.name AS category_name, c.slug AS category_slug FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?"
  ).get(info.lastInsertRowid));
});

app.put("/api/admin/products/:id", requireAdmin, sameOrigin, (req, res) => {
  const existing = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Product not found." });
  const { errors, values } = validateProduct(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });
  if (db.prepare("SELECT id FROM products WHERE LOWER(name) = ? AND id != ?")
    .get(values.name.toLowerCase(), existing.id))
    return res.status(409).json({ error: "A product with this name already exists." });
  db.prepare(
    "UPDATE products SET name = ?, category = ?, category_id = ?, price = ?, image = ?, stock = ?, description = ?, featured = ?, rating = ? WHERE id = ?"
  ).run(values.name, values.category, values.category_id, values.price, values.image, values.stock, values.description, values.featured, values.rating, existing.id);
  res.json(db.prepare(
    "SELECT p.*, c.name AS category_name, c.slug AS category_slug FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?"
  ).get(existing.id));
});

app.delete("/api/admin/products/:id", requireAdmin, sameOrigin, (req, res) => {
  const info = db.prepare("DELETE FROM products WHERE id = ?").run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: "Product not found." });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/*  Category management (admin protected)                              */
/* ------------------------------------------------------------------ */
function categoryOrNull(id) {
  return db.prepare("SELECT * FROM categories WHERE id = ?").get(Number(id));
}

app.post("/api/admin/categories", requireAdmin, sameOrigin, (req, res) => {
  const { errors, values } = validateCategory(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });
  const info = db.prepare(
    "INSERT INTO categories(name, slug, description, image) VALUES(?, ?, ?, ?)"
  ).run(values.name, values.slug, values.description, values.image);
  res.status(201).json(db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM products WHERE category_id = c.id) AS product_count
     FROM categories c WHERE c.id = ?`
  ).get(info.lastInsertRowid));
});

app.put("/api/admin/categories/:id", requireAdmin, sameOrigin, (req, res) => {
  const existing = categoryOrNull(req.params.id);
  if (!existing) return res.status(404).json({ error: "Category not found." });
  const { errors, values } = validateCategory(req.body, existing.id);
  if (errors.length) return res.status(400).json({ error: errors.join(" ") });

  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE categories SET name = ?, slug = ?, description = ?, image = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(values.name, values.slug, values.description, values.image, existing.id);
    /* Keep the denormalised product category label in sync so every product
       in the renamed category continues to display its category correctly. */
    db.prepare("UPDATE products SET category = ? WHERE category_id = ?")
      .run(values.name, existing.id);
  });
  tx();

  res.json(db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM products WHERE category_id = c.id) AS product_count
     FROM categories c WHERE c.id = ?`
  ).get(existing.id));
});

app.delete("/api/admin/categories/:id", requireAdmin, sameOrigin, (req, res) => {
  const existing = categoryOrNull(req.params.id);
  if (!existing) return res.status(404).json({ error: "Category not found." });

  const productCount = db.prepare(
    "SELECT COUNT(*) AS n FROM products WHERE category_id = ?"
  ).get(existing.id).n;

  if (productCount > 0) {
    const moveTo = Number(req.query.to);
    if (!Number.isInteger(moveTo) || moveTo <= 0 || moveTo === existing.id) {
      return res.status(409).json({
        error: `This category contains ${productCount} product${productCount === 1 ? "" : "s"}. Move or remove ${productCount === 1 ? "it" : "them"} before deleting the category.`,
        count: productCount
      });
    }
    const target = categoryOrNull(moveTo);
    if (!target) return res.status(400).json({ error: "Please choose a valid category to move products to." });

    const tx = db.transaction(() => {
      db.prepare("UPDATE products SET category_id = ?, category = ? WHERE category_id = ?")
        .run(target.id, target.name, existing.id);
      db.prepare("DELETE FROM categories WHERE id = ?").run(existing.id);
    });
    tx();
    return res.json({ ok: true, moved: productCount });
  }

  db.prepare("DELETE FROM categories WHERE id = ?").run(existing.id);
  res.json({ ok: true });
});

app.get("/api/admin/customers", requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM orders WHERE LOWER(orders.email) = c.email) AS order_count,
      (SELECT COALESCE(SUM(total), 0) FROM orders WHERE LOWER(orders.email) = c.email AND orders.status != 'Cancelled') AS total_spent
    FROM customers c ORDER BY c.id DESC LIMIT 300`).all();
  res.json(rows);
});

app.post("/api/admin/password", requireAdmin, sameOrigin, (req, res) => {
  const current = String(req.body.current || "");
  const next = String(req.body.password || "");
  if (next.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });
  const admin = db.prepare("SELECT * FROM admin_users WHERE id = ?").get(req.session.admin.id);
  if (!admin || !bcrypt.compareSync(current, admin.password_hash)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }
  db.prepare("UPDATE admin_users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(next, 12), admin.id);
  res.json({ ok: true });
});

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
app.get("/category/:slug", (req, res) => {
  const category = db.prepare("SELECT id, name, slug FROM categories WHERE LOWER(slug) = LOWER(?)")
    .get(req.params.slug);
  if (!category) return res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
  res.sendFile(path.join(__dirname, "public", "category.html"));
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

app.listen(PORT, () => console.log(`NovaCart running at http://localhost:${PORT}`));