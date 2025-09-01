import express from "express";
import bodyParser from "body-parser";
import sqlite3 from "sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== DB =====
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
});

// генерация номера ORD-YYYYMM-####
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

// ===== API =====

// список заказов
app.get("/api/orders", (req, res) => {
  db.all(
    "SELECT id, order_number, client, status, currency, total_sale, gross_profit, created_at FROM orders ORDER BY id DESC",
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// детали заказа
app.get("/api/orders/:id", (req, res) => {
  db.get("SELECT * FROM orders WHERE id = ?", [req.params.id], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: "Not found" });
    db.all(
      "SELECT * FROM order_items WHERE order_id = ?",
      [req.params.id],
      (err, items) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ...order, items });
      }
    );
  });
});

// создать заказ
app.post("/api/orders", (req, res) => {
  const {
    client,
    status,
    currency,
    payment_terms,
    planned_start,
    planned_end,
    actual_ship,
    logistics,
    discount_percent = 0,
    extra_costs = 0,
    items = [],
  } = req.body;

  // подсчёт итогов
  let totalSale = 0,
    totalCost = 0;
  const preparedItems = items.map((it) => {
    const qty = Number(it.quantity || 0);
    const cost = Number(it.cost || 0);
    const price = Number(it.price || 0);
    const disc = Number(it.discount_percent || 0);
    const lineSale = qty * price * (1 - disc / 100);
    const lineCost = qty * cost;
    totalSale += lineSale;
    totalCost += lineCost;
    return { ...it, line_sale: lineSale, line_cost: lineCost };
  });

  const totalSaleAfterDisc =
    totalSale * (1 - Number(discount_percent || 0) / 100) + Number(extra_costs || 0);
  const grossProfit = totalSaleAfterDisc - totalCost - Number(extra_costs || 0);

  generateOrderNumber((err, order_number) => {
    if (err) return res.status(500).json({ error: err.message });

    db.run(
      `INSERT INTO orders (order_number, client, status, currency, payment_terms,
        planned_start, planned_end, actual_ship, logistics, discount_percent, extra_costs,
        total_sale, total_cost, gross_profit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order_number,
        client,
        status,
        currency,
        payment_terms,
        planned_start,
        planned_end,
        actual_ship,
        logistics,
        discount_percent,
        extra_costs,
        totalSaleAfterDisc,
        totalCost,
        grossProfit,
      ],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        const orderId = this.lastID;

        const stmt = db.prepare(
          `INSERT INTO order_items
           (order_id, product, sku, color, size, quantity, cost, price, line_sale, line_cost, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        preparedItems.forEach((it) => {
          stmt.run([
            orderId,
            it.product,
            it.sku,
            it.color,
            it.size,
            it.quantity,
            it.cost,
            it.price,
            it.line_sale,
            it.line_cost,
            it.note || "",
          ]);
        });
        stmt.finalize();

        res.json({ success: true, order_id: orderId, order_number });
      }
    );
  });
});

// ОБНОВИТЬ заказ (полная замена позиций)
app.put("/api/orders/:id", (req, res) => {
  const orderId = Number(req.params.id);
  const {
    client,
    status,
    currency,
    payment_terms,
    planned_start,
    planned_end,
    actual_ship,
    logistics,
    discount_percent = 0,
    extra_costs = 0,
    items = [],
  } = req.body;

  // пересчёт итогов
  let totalSale = 0,
    totalCost = 0;
  const preparedItems = items.map((it) => {
    const qty = Number(it.quantity || 0);
    const cost = Number(it.cost || 0);
    const price = Number(it.price || 0);
    const disc = Number(it.discount_percent || 0);
    const lineSale = qty * price * (1 - disc / 100);
    const lineCost = qty * cost;
    totalSale += lineSale;
    totalCost += lineCost;
    return { ...it, line_sale: lineSale, line_cost: lineCost };
  });

  const totalSaleAfterDisc =
    totalSale * (1 - Number(discount_percent || 0) / 100) + Number(extra_costs || 0);
  const grossProfit = totalSaleAfterDisc - totalCost - Number(extra_costs || 0);

  db.serialize(() => {
    db.run(
      `UPDATE orders SET
        client=?, status=?, currency=?, payment_terms=?, planned_start=?, planned_end=?,
        actual_ship=?, logistics=?, discount_percent=?, extra_costs=?,
        total_sale=?, total_cost=?, gross_profit=?
       WHERE id=?`,
      [
        client,
        status,
        currency,
        payment_terms,
        planned_start,
        planned_end,
        actual_ship,
        logistics,
        discount_percent,
        extra_costs,
        totalSaleAfterDisc,
        totalCost,
        grossProfit,
        orderId,
      ],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });

        db.run(`DELETE FROM order_items WHERE order_id=?`, [orderId], function (err2) {
          if (err2) return res.status(500).json({ error: err2.message });

          const stmt = db.prepare(
            `INSERT INTO order_items
             (order_id, product, sku, color, size, quantity, cost, price, line_sale, line_cost, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          );
          preparedItems.forEach((it) => {
            stmt.run([
              orderId,
              it.product,
              it.sku,
              it.color,
              it.size,
              it.quantity,
              it.cost,
              it.price,
              it.line_sale,
              it.line_cost,
              it.note || "",
            ]);
          });
          stmt.finalize((err3) => {
            if (err3) return res.status(500).json({ error: err3.message });
            res.json({ success: true, order_id: orderId });
          });
        });
      }
    );
  });
});

// index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// старт
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Orders CRM running on http://localhost:${PORT}`)
);
