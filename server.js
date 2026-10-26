require("dotenv").config();
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === "production";
const sessionSecret = process.env.SESSION_SECRET || "";
const adminUsername = process.env.ADMIN_USERNAME || "";
const adminPassword = process.env.ADMIN_PASSWORD || "";

if (sessionSecret.length < 32 || adminPassword.length < 12 || !adminUsername) {
  console.error("Setup required: set SESSION_SECRET (32+ chars), ADMIN_USERNAME, and ADMIN_PASSWORD (12+ chars) in .env.");
  process.exit(1);
}

const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "store.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 category TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 price_paisa INTEGER NOT NULL CHECK(price_paisa >= 0),
 stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
 image_url TEXT NOT NULL DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_code TEXT NOT NULL UNIQUE,
 customer_name TEXT NOT NULL,
 phone TEXT NOT NULL,
 email TEXT NOT NULL DEFAULT '',
 address TEXT NOT NULL,
 notes TEXT NOT NULL DEFAULT '',
 payment_method TEXT NOT NULL CHECK(payment_method IN ('cod','bkash','nagad')),
 payment_number TEXT NOT NULL DEFAULT '',
 transaction_id TEXT NOT NULL DEFAULT '',
 payment_status TEXT NOT NULL DEFAULT 'unverified',
 status TEXT NOT NULL DEFAULT 'pending',
 subtotal_paisa INTEGER NOT NULL,
 delivery_paisa INTEGER NOT NULL,
 total_paisa INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 product_id INTEGER,
 product_name TEXT NOT NULL,
 unit_price_paisa INTEGER NOT NULL,
 quantity INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 email TEXT NOT NULL,
 message TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admins (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const productCount = db.prepare("SELECT COUNT(*) AS n FROM products").get().n;
if (productCount === 0) {
  const insert = db.prepare("INSERT INTO products (name,category,description,price_paisa,stock,image_url) VALUES (?,?,?,?,?,?)");
  const seed = [
    ["Everyday Runner","Men","Lightweight everyday sneaker.",649900,12,""],
    ["Classic White Sneaker","Women","Minimal white sneaker for daily wear.",529900,8,""],
    ["Kids Active Shoe","Kids","Comfortable shoes for active kids.",299900,15,""],
    ["Sport Flex Pro","Men","Supportive sporty footwear.",749900,6,""]
  ];
  const tx = db.transaction(items => items.forEach(p => insert.run(...p)));
  tx(seed);
}
const existingAdmin = db.prepare("SELECT id FROM admins WHERE username=?").get(adminUsername);
if (!existingAdmin) {
  const hash = bcrypt.hashSync(adminPassword, 12);
  db.prepare("INSERT INTO admins (username,password_hash) VALUES (?,?)").run(adminUsername, hash);
}

app.disable("x-powered-by");
if (isProd) app.set("trust proxy", 1);
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:", "https:"],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"]
};
if (isProd) cspDirectives.upgradeInsecureRequests = [];
app.use(helmet({ contentSecurityPolicy: { directives: cspDirectives } }));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(session({
  name: "brandedshoes.sid",
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "strict", secure: isProd, maxAge: 1000 * 60 * 60 * 4 }
  // IMPORTANT: Express MemoryStore is for local development only.
  // Configure a persistent production session store before public launch.
}));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/admin/login", rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false }));

const money = paisa => Math.round(paisa) / 100;
const bdt = paisa => `৳${money(paisa).toLocaleString("en-BD",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const clean = (v, max=500) => String(v ?? "").trim().slice(0,max);
const validPhone = v => /^[0-9+\-\s()]{8,20}$/.test(v);
const validEmail = v => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const csrfToken = req => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString("hex");
  return req.session.csrf;
};
function requireCsrf(req,res,next) {
  const sent = req.get("x-csrf-token") || req.body?._csrf;
  if (!sent || !req.session.csrf) {
    return res.status(403).json({error:"Security token expired. Refresh and try again."});
  }
  const sentBuffer = Buffer.from(String(sent));
  const expectedBuffer = Buffer.from(String(req.session.csrf));
  if (sentBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sentBuffer, expectedBuffer)) {
    return res.status(403).json({error:"Security token expired. Refresh and try again."});
  }
  next();
}
function requireAdmin(req,res,next) {
  if (!req.session.adminId) return res.status(401).json({error:"Admin login required."});
  next();
}
app.get("/api/config", (req,res) => res.json({
  storeName: process.env.STORE_NAME || "Branded Shoes.com",
  csrfToken: csrfToken(req),
  bkashNumber: process.env.BKASH_MERCHANT_NUMBER || "",
  nagadNumber: process.env.NAGAD_MERCHANT_NUMBER || ""
}));
app.get("/api/products", (req,res) => {
  const rows = db.prepare("SELECT id,name,category,description,price_paisa,stock,image_url FROM products WHERE active=1 ORDER BY id DESC").all();
  res.json(rows.map(p => ({...p, price:money(p.price_paisa)})));
});
app.post("/api/contact", requireCsrf, (req,res) => {
  const name=clean(req.body.name,100), email=clean(req.body.email,150), message=clean(req.body.message,3000);
  if (!name || !validEmail(email) || !email || message.length < 5) return res.status(400).json({error:"Please provide your name, valid email, and message."});
  db.prepare("INSERT INTO messages (name,email,message) VALUES (?,?,?)").run(name,email,message);
  res.status(201).json({message:"Your message has been saved. The store team can review it in Admin."});
});
app.post("/api/orders", requireCsrf, (req,res) => {
  const name=clean(req.body.name,100), phone=clean(req.body.phone,20), email=clean(req.body.email,150);
  const address=clean(req.body.address,1000), notes=clean(req.body.notes,1000);
  const payment=clean(req.body.payment_method,10);
  const paymentNumber=clean(req.body.payment_number,30), trx=clean(req.body.transaction_id,100);
  const items=Array.isArray(req.body.items)?req.body.items:[];
  if (!name || !validPhone(phone) || !address || !validEmail(email)) return res.status(400).json({error:"Please check your name, phone, email, and delivery address."});
  if (!["cod","bkash","nagad"].includes(payment)) return res.status(400).json({error:"Choose a valid payment method."});
  if (!items.length || items.length > 30) return res.status(400).json({error:"Your cart is empty or contains too many items."});
  if (payment !== "cod" && (!paymentNumber || !trx)) return res.status(400).json({error:"For mobile payment, enter the number used and transaction ID."});
  const ids = new Set();
  const normalized = [];
  for (const item of items) {
    const id=Number(item.id), quantity=Number(item.quantity);
    if (!Number.isInteger(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 20 || ids.has(id)) return res.status(400).json({error:"Invalid cart item."});
    ids.add(id);
    const product=db.prepare("SELECT id,name,price_paisa,stock FROM products WHERE id=? AND active=1").get(id);
    if (!product) return res.status(400).json({error:"A product in your cart is no longer available."});
    if (quantity > product.stock) return res.status(400).json({error:`Not enough stock for ${product.name}.`});
    normalized.push({...product,quantity});
  }
  const subtotal=normalized.reduce((sum,p)=>sum+p.price_paisa*p.quantity,0);
  const delivery=subtotal >= 500000 ? 0 : 8000; // Free delivery at ৳5,000; otherwise ৳80.
  const total=subtotal+delivery;
  const orderCode="BS"+Date.now().toString().slice(-8)+crypto.randomBytes(2).toString("hex").toUpperCase();
  const createOrder=db.transaction(()=>{
    const result=db.prepare(`INSERT INTO orders (order_code,customer_name,phone,email,address,notes,payment_method,payment_number,transaction_id,payment_status,subtotal_paisa,delivery_paisa,total_paisa)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(orderCode,name,phone,email,address,notes,payment,paymentNumber,trx,payment==="cod"?"not_required":"unverified",subtotal,delivery,total);
    const orderId=Number(result.lastInsertRowid);
    const insertItem=db.prepare("INSERT INTO order_items (order_id,product_id,product_name,unit_price_paisa,quantity) VALUES (?,?,?,?,?)");
    const stockUpdate=db.prepare("UPDATE products SET stock=stock-? WHERE id=? AND stock>=?");
    for(const p of normalized){
      insertItem.run(orderId,p.id,p.name,p.price_paisa,p.quantity);
      const changed=stockUpdate.run(p.quantity,p.id,p.quantity);
      if(changed.changes!==1) throw new Error("Stock changed while processing order.");
    }
    return orderId;
  });
  try {
    createOrder();
    res.status(201).json({message:"Order placed successfully.",order_code:orderCode,subtotal:money(subtotal),delivery:money(delivery),total:money(total),payment_status:payment==="cod"?"not_required":"unverified"});
  } catch(e) {
    res.status(409).json({error:"We couldn't complete this order. Please refresh your cart and try again."});
  }
});
app.get("/api/admin/session", (req,res) => res.json({loggedIn:!!req.session.adminId,username:req.session.adminUsername||null,csrfToken:csrfToken(req)}));
app.post("/api/admin/login", requireCsrf, async (req,res) => {
  const username=clean(req.body.username,100), password=String(req.body.password||"");
  const admin=db.prepare("SELECT id,username,password_hash FROM admins WHERE username=?").get(username);
  const ok=admin ? await bcrypt.compare(password,admin.password_hash) : await bcrypt.compare(password,"$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid");
  if(!ok || !admin) return res.status(401).json({error:"Invalid username or password."});
  req.session.regenerate(err=>{
    if(err) return res.status(500).json({error:"Unable to start admin session."});
    req.session.adminId=admin.id; req.session.adminUsername=admin.username; req.session.csrf=crypto.randomBytes(24).toString("hex");
    res.json({message:"Logged in.",csrfToken:req.session.csrf});
  });
});
app.post("/api/admin/logout", requireAdmin, requireCsrf, (req,res)=>req.session.destroy(()=>res.json({message:"Logged out."})));
app.get("/api/admin/orders", requireAdmin, (req,res)=>{
  const orders=db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 200").all();
  const items=db.prepare("SELECT product_name,unit_price_paisa,quantity FROM order_items WHERE order_id=?");
  res.json(orders.map(o=>({...o,total:bdt(o.total_paisa),items:items.all(o.id)})));
});
app.patch("/api/admin/orders/:id", requireAdmin, requireCsrf, (req,res)=>{
  const id=Number(req.params.id), status=clean(req.body.status,20), payment_status=clean(req.body.payment_status,20);
  const statuses=["pending","confirmed","shipped","delivered","cancelled"];
  const payments=["unverified","verified","failed","not_required"];
  if(!Number.isInteger(id)||!statuses.includes(status)||!payments.includes(payment_status)) return res.status(400).json({error:"Invalid order update."});
  const result=db.prepare("UPDATE orders SET status=?,payment_status=? WHERE id=?").run(status,payment_status,id);
  if(!result.changes) return res.status(404).json({error:"Order not found."});
  res.json({message:"Order updated."});
});
app.get("/api/admin/products", requireAdmin, (req,res)=>res.json(db.prepare("SELECT * FROM products ORDER BY id DESC").all().map(p=>({...p,price:money(p.price_paisa)}))));
app.post("/api/admin/products", requireAdmin, requireCsrf, (req,res)=>{
  const name=clean(req.body.name,150), category=clean(req.body.category,30), description=clean(req.body.description,1000), image=clean(req.body.image_url,1000);
  const price=Number(req.body.price), stock=Number(req.body.stock);
  if(!name||!["Men","Women","Kids","Unisex"].includes(category)||!Number.isFinite(price)||price<0||price>1000000||!Number.isInteger(stock)||stock<0||stock>100000) return res.status(400).json({error:"Check product name, category, price, and stock."});
  if(image && !/^https:\/\/|^\/images\//.test(image)) return res.status(400).json({error:"Use an HTTPS image URL or a local /images/ path."});
  const result=db.prepare("INSERT INTO products (name,category,description,price_paisa,stock,image_url) VALUES (?,?,?,?,?,?)").run(name,category,description,Math.round(price*100),stock,image);
  res.status(201).json({id:Number(result.lastInsertRowid),message:"Product added."});
});
app.patch("/api/admin/products/:id", requireAdmin, requireCsrf, (req,res)=>{
  const id=Number(req.params.id), active=req.body.active===false?0:1, stock=Number(req.body.stock);
  if(!Number.isInteger(id)||!Number.isInteger(stock)||stock<0||stock>100000) return res.status(400).json({error:"Invalid product or stock."});
  const result=db.prepare("UPDATE products SET stock=?,active=? WHERE id=?").run(stock,active,id);
  if(!result.changes) return res.status(404).json({error:"Product not found."});
  res.json({message:"Product updated."});
});
app.get("/api/admin/messages", requireAdmin, (req,res)=>res.json(db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 200").all()));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:"Unexpected server error."});});
app.listen(PORT,()=>console.log(`Branded Shoes.com running on http://localhost:${PORT}`));
