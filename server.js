import express from "express";
import bodyParser from "body-parser";
import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import fs from "fs";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// === ensure uploads dir
const uploadsDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// === Multer: принимаем только изображения, до 10 МБ, в память
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|jpg)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error("Only image files (jpg, png, webp) are allowed"));
  },
});

// === DB
const db = new sqlite3.Database("./orders.db");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT,
      client TEXT,
      status TEXT,
      currency TEXT,
      payment_terms TEXT,
      planned_start TEXT,
      planned_end TEXT,
      actual_ship TEXT,
      logistics TEXT,
      discount_percent REAL DEFAULT 0,
      extra_costs REAL DEFAULT 0,
      wedrive_folder TEXT,
      attachments TEXT,
      total_sale REAL DEFAULT 0,
      total_cost REAL DEFAULT 0,
      gross_profit REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      product TEXT,
      sku TEXT,
      color TEXT,
      size TEXT,
      quantity INTEGER,
      cost REAL,
      price REAL,
      line_sale REAL,
      line_cost REAL,
      note TEXT,
      FOREIGN KEY(order_id) REFERENCES orders(id)
    )
  `);

  // безопасные попытки добавить недостающие поля (если уже есть — тихо игнорим)
  db.run(`ALTER TABLE orders ADD COLUMN wedrive_folder TEXT`, () => {});
  db.run(`ALTER TABLE orders ADD COLUMN attachments TEXT`, () => {});
});

// Генерация номера ORD-YYYYMM-####
function generateOrderNumber(cb) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `ORD-${y}${m}`;
  db.get(
    `SELECT COUNT(*) as c FROM orders WHERE order_number LIKE ?`,
    [`${prefix}%`],
    (err, row) => {
      if (err) return cb(err);
      const seq = String((row?.c || 0) + 1).padStart(4, "0");
      cb(null, `${prefix}-${seq}`);
    }
  );
}

// ===== API

// список
app.get("/api/orders", (req, res) => {
  db.all(
    `SELECT id, order_number, client, status, currency, total_sale, gross_profit, created_at
     FROM orders ORDER BY id DESC`,
    (err, rows) => (err ? res.status(500).json({ error: err.message }) : res.json(rows))
  );
});

// детали
app.get("/api/orders/:id", (req, res) => {
  db.get("SELECT * FROM orders WHERE id = ?", [req.params.id], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: "Not found" });
    db.all("SELECT * FROM order_items WHERE order_id = ?", [req.params.id], (e2, items) => {
      if (e2) return res.status(500).json({ error: e2.message });
      const attachments = order.attachments ? JSON.parse(order.attachments) : [];
      res.json({ ...order, attachments, items });
    });
  });
});

// создать
app.post("/api/orders", (req, res) => {
  const {
    client, status, currency, payment_terms, planned_start, planned_end,
    actual_ship, logistics, discount_percent = 0, extra_costs = 0,
    wedrive_folder = "", attachments = [], items = [],
  } = req.body;

  let totalSale = 0, totalCost = 0;
  const prepared = items.map(it => {
    const qty = +it.quantity || 0, cost = +it.cost || 0, price = +it.price || 0, disc = +it.discount_percent || 0;
    const line_sale = qty * price * (1 - disc / 100);
    const line_cost = qty * cost;
    totalSale += line_sale; totalCost += line_cost;
    return { ...it, line_sale, line_cost };
  });

  const totalSaleAfterDisc = totalSale * (1 - (+discount_percent || 0) / 100) + (+extra_costs || 0);
  const grossProfit = totalSaleAfterDisc - totalCost - (+extra_costs || 0);

  generateOrderNumber((err, order_number) => {
    if (err) return res.status(500).json({ error: err.message });
    db.run(
      `INSERT INTO orders (order_number, client, status, currency, payment_terms, planned_start, planned_end,
        actual_ship, logistics, discount_percent, extra_costs, wedrive_folder, attachments,
        total_sale, total_cost, gross_profit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order_number, client, status, currency, payment_terms, planned_start, planned_end,
        actual_ship, logistics, discount_percent, extra_costs, wedrive_folder, JSON.stringify(attachments),
        totalSaleAfterDisc, totalCost, grossProfit,
      ],
      function (e2) {
        if (e2) return res.status(500).json({ error: e2.message });
        const orderId = this.lastID;
        const stmt = db.prepare(
          `INSERT INTO order_items
           (order_id, product, sku, color, size, quantity, cost, price, line_sale, line_cost, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        prepared.forEach(it => {
          stmt.run([
            orderId, it.product, it.sku, it.color, it.size,
            it.quantity, it.cost, it.price, it.line_sale, it.line_cost, it.note || ""
          ]);
        });
        stmt.finalize();
        res.json({ success: true, order_id: orderId, order_number });
      }
    );
  });
});

// обновить
app.put("/api/orders/:id", (req, res) => {
  const orderId = +req.params.id;
  const {
    client, status, currency, payment_terms, planned_start, planned_end,
    actual_ship, logistics, discount_percent = 0, extra_costs = 0,
    wedrive_folder = "", attachments = [], items = [],
  } = req.body;

  let totalSale = 0, totalCost = 0;
  const prepared = items.map(it => {
    const qty = +it.quantity || 0, cost = +it.cost || 0, price = +it.price || 0, disc = +it.discount_percent || 0;
    const line_sale = qty * price * (1 - disc / 100);
    const line_cost = qty * cost;
    totalSale += line_sale; totalCost += line_cost;
    return { ...it, line_sale, line_cost };
  });

  const totalSaleAfterDisc = totalSale * (1 - (+discount_percent || 0) / 100) + (+extra_costs || 0);
  const grossProfit = totalSaleAfterDisc - totalCost - (+extra_costs || 0);

  db.serialize(() => {
    db.run(
      `UPDATE orders SET
        client=?, status=?, currency=?, payment_terms=?, planned_start=?, planned_end=?,
        actual_ship=?, logistics=?, discount_percent=?, extra_costs=?,
        wedrive_folder=?, attachments=?, total_sale=?, total_cost=?, gross_profit=?
       WHERE id=?`,
      [
        client, status, currency, payment_terms, planned_start, planned_end,
        actual_ship, logistics, discount_percent, extra_costs,
        wedrive_folder, JSON.stringify(attachments),
        totalSaleAfterDisc, totalCost, grossProfit, orderId,
      ],
      function (e2) {
        if (e2) return res.status(500).json({ error: e2.message });
        db.run(`DELETE FROM order_items WHERE order_id=?`, [orderId], function (e3) {
          if (e3) return res.status(500).json({ error: e3.message });
          const stmt = db.prepare(
            `INSERT INTO order_items
             (order_id, product, sku, color, size, quantity, cost, price, line_sale, line_cost, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          );
          prepared.forEach(it => {
            stmt.run([
              orderId, it.product, it.sku, it.color, it.size,
              it.quantity, it.cost, it.price, it.line_sale, it.line_cost, it.note || ""
            ]);
          });
          stmt.finalize(err => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, order_id: orderId });
          });
        });
      }
    );
  });
});

// === Upload + конвертация в JPEG
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // имя файла .jpg
    const base = (req.file.originalname || "image")
      .replace(/\.[^/.]+$/g, "")            // без расширения
      .replace(/[^\w\-]+/g, "_")            // безопасно
      .slice(0, 40);                        // не слишком длинно
    const filename = `${Date.now()}-${base}.jpg`;
    const outPath = path.join(uploadsDir, filename);

    // конвертация (auto-rotate EXIF)
    await sharp(req.file.buffer).rotate().jpeg({ quality: 85 }).toFile(outPath);

    const url = "/uploads/" + filename;
    res.json({ success: true, url });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    res.status(500).json({ error: e.message || "Upload failed" });
  }
});

// index
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Orders CRM running on http://localhost:${PORT}`);
});
