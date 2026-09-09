const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;
const db = new Database("novacart.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, category TEXT NOT NULL, price INTEGER NOT NULL,
  image TEXT NOT NULL, stock INTEGER NOT NULL DEFAULT 20,
  description TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer TEXT NOT NULL, email TEXT NOT NULL, total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'Processing',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL, quantity INTEGER NOT NULL, price INTEGER NOT NULL
);
`);

const count = db.prepare("SELECT COUNT(*) AS n FROM products").get().n;
if (!count) {
  const seed = [
    ["Satin Evening Dress","Clothes",89000,"https://images.unsplash.com/photo-1566174053879-31528523f8ae?auto=format&fit=crop&w=900&q=85",18,"Elegant satin dress for evening occasions."],
    ["Minimal Linen Shirt","Clothes",52000,"https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?auto=format&fit=crop&w=900&q=85",30,"Relaxed premium linen shirt."],
    ["Classic Leather Sneakers","Shoes",68000,"https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=900&q=85",24,"Everyday leather sneakers."],
    ["Urban Running Shoes","Shoes",76000,"https://images.unsplash.com/photo-1552346154-21d32810aba3?auto=format&fit=crop&w=900&q=85",16,"Lightweight performance trainers."],
    ["Gold Statement Necklace","Jewelry",125000,"https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?auto=format&fit=crop&w=900&q=85",12,"Statement necklace with a polished finish."],
    ["Pearl Drop Earrings","Jewelry",54000,"https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?auto=format&fit=crop&w=900&q=85",20,"Elegant pearl drop earrings."],
    ["Chrono Wristwatch","Accessories",145000,"https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=900&q=85",10,"Modern stainless-steel wristwatch."],
    ["Structured Handbag","Bags",98000,"https://images.unsplash.com/photo-1584917865442-de89df76afd3?auto=format&fit=crop&w=900&q=85",14,"Structured everyday handbag."]
  ];
  const insert = db.prepare("INSERT INTO products(name,category,price,image,stock,description) VALUES(?,?,?,?,?,?)");
  const tx = db.transaction(rows => rows.forEach(r => insert.run(...r)));
  tx(seed);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/products", (req,res) => {
  const { category, q } = req.query;
  let sql = "SELECT * FROM products WHERE 1=1", params = {};
  if (category && category !== "All") { sql += " AND category=@category"; params.category = category; }
  if (q) { sql += " AND (name LIKE @q OR description LIKE @q)"; params.q = `%${q}%`; }
  sql += " ORDER BY id DESC";
  res.json(db.prepare(sql).all(params));
});

app.get("/api/stats", (req,res) => {
  const products = db.prepare("SELECT COUNT(*) n FROM products").get().n;
  const orders = db.prepare("SELECT COUNT(*) n FROM orders").get().n;
  const revenue = db.prepare("SELECT COALESCE(SUM(total),0) n FROM orders").get().n;
  const customers = db.prepare("SELECT COUNT(DISTINCT email) n FROM orders").get().n;
  const lowStock = db.prepare("SELECT COUNT(*) n FROM products WHERE stock < 10").get().n;
  const byCategory = db.prepare("SELECT category, COUNT(*) count FROM products GROUP BY category").all();
  const recent = db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 8").all();
  res.json({products,orders,revenue,customers,lowStock,byCategory,recent});
});

app.post("/api/orders", (req,res) => {
  const {customer,email,items} = req.body;
  if (!customer || !email || !Array.isArray(items) || !items.length) return res.status(400).json({error:"Invalid order"});
  const get = db.prepare("SELECT * FROM products WHERE id=?");
  let total = 0, checked = [];
  for (const item of items) {
    const p = get.get(item.productId);
    const qty = Math.max(1, Number(item.quantity) || 1);
    if (!p || p.stock < qty) return res.status(400).json({error:`Insufficient stock for ${p?.name || "product"}`});
    total += p.price * qty; checked.push({p,qty});
  }
  const createOrder = db.prepare("INSERT INTO orders(customer,email,total) VALUES(?,?,?)");
  const addItem = db.prepare("INSERT INTO order_items(order_id,product_id,quantity,price) VALUES(?,?,?,?)");
  const reduce = db.prepare("UPDATE products SET stock=stock-? WHERE id=?");
  const tx = db.transaction(() => {
    const order = createOrder.run(customer,email,total);
    checked.forEach(({p,qty}) => { addItem.run(order.lastInsertRowid,p.id,qty,p.price); reduce.run(qty,p.id); });
    return order.lastInsertRowid;
  });
  const orderId = tx();
  res.status(201).json({orderId,total});
});

app.post("/api/products", (req,res) => {
  const {name,category,price,image,stock,description} = req.body;
  if (!name || !category || !price || !image) return res.status(400).json({error:"Name, category, price and image are required"});
  const r = db.prepare("INSERT INTO products(name,category,price,image,stock,description) VALUES(?,?,?,?,?,?)")
    .run(name,category,Number(price),image,Number(stock)||0,description||"");
  res.status(201).json(db.prepare("SELECT * FROM products WHERE id=?").get(r.lastInsertRowid));
});

app.put("/api/products/:id", (req,res) => {
  const {name,category,price,image,stock,description} = req.body;
  db.prepare("UPDATE products SET name=?,category=?,price=?,image=?,stock=?,description=? WHERE id=?")
    .run(name,category,Number(price),image,Number(stock),description||"",req.params.id);
  res.json(db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id));
});

app.delete("/api/products/:id", (req,res) => {
  db.prepare("DELETE FROM products WHERE id=?").run(req.params.id);
  res.json({ok:true});
});

app.listen(PORT, () => console.log(`NovaCart running at http://localhost:${PORT}`));