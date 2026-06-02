const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3');
require('dotenv').config();

const dbType = process.env.DB_TYPE || 'sqlite';
let pgPool = null;
let sqliteDb = null;

// Initialize the database connection
if (dbType === 'postgres') {
  console.log('Database dialect set to PostgreSQL.');
  pgPool = new Pool({
    connectionString: process.env.PG_CONNECTION_STRING,
  });
} else {
  console.log('Database dialect set to SQLite.');
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const dbPath = path.join(dataDir, 'inventory.db');
  sqliteDb = new sqlite3.Database(dbPath);
}

// Helper to convert PG $1, $2 style queries to SQLite ? style
function translateQuery(sql, params = []) {
  if (dbType === 'postgres') {
    return { sql, params };
  }
  // SQLite replaces $1, $2 with ?
  // Simple regex replacement: replaces $1, $2, etc. with ?
  const sqliteSql = sql.replace(/\$\d+/g, '?');
  return { sql: sqliteSql, params };
}

// Asynchronous query wrapper returning array of rows
function query(sql, params = []) {
  const parsed = translateQuery(sql, params);

  if (dbType === 'postgres') {
    return pgPool.query(parsed.sql, parsed.params)
      .then(res => res.rows)
      .catch(err => {
        console.error('PostgreSQL Query Error:', err, sql);
        throw err;
      });
  } else {
    return new Promise((resolve, reject) => {
      sqliteDb.all(parsed.sql, parsed.params, (err, rows) => {
        if (err) {
          console.error('SQLite Query Error:', err, sql);
          reject(err);
        } else {
          resolve(rows || []);
        }
      });
    });
  }
}

// Asynchronous query helper returning a single row
async function getOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

// Asynchronous execute query (inserts, updates, deletes)
function execute(sql, params = []) {
  const parsed = translateQuery(sql, params);

  if (dbType === 'postgres') {
    return pgPool.query(parsed.sql, parsed.params)
      .then(res => ({
        rowCount: res.rowCount,
        insertId: res.rows && res.rows[0] ? res.rows[0].id : null
      }))
      .catch(err => {
        console.error('PostgreSQL Execute Error:', err, sql);
        throw err;
      });
  } else {
    return new Promise((resolve, reject) => {
      // Use sqliteDb.run to get lastID and changes
      sqliteDb.run(parsed.sql, parsed.params, function (err) {
        if (err) {
          console.error('SQLite Execute Error:', err, sql);
          reject(err);
        } else {
          resolve({
            rowCount: this.changes,
            insertId: this.lastID
          });
        }
      });
    });
  }
}

// Initialise Database schemas
async function initDb() {
  const isSQLite = dbType === 'sqlite';
  const serial = isSQLite ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'SERIAL PRIMARY KEY';
  const datetime = isSQLite ? 'TEXT DEFAULT CURRENT_TIMESTAMP' : 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP';
  const numeric = isSQLite ? 'REAL' : 'NUMERIC(12, 2)';
  const dateType = isSQLite ? 'TEXT' : 'DATE';

  const tables = [
    // 1. Branches
    `CREATE TABLE IF NOT EXISTS branches (
      id ${serial},
      name VARCHAR(100) NOT NULL,
      code VARCHAR(20) NOT NULL UNIQUE,
      address TEXT,
      phone VARCHAR(20),
      tax_number VARCHAR(50),
      created_at ${datetime}
    )`,

    // 2. Categories
    `CREATE TABLE IF NOT EXISTS categories (
      id ${serial},
      name VARCHAR(100) NOT NULL UNIQUE,
      parent_category VARCHAR(100),
      created_at ${datetime}
    )`,

    // 3. Suppliers
    `CREATE TABLE IF NOT EXISTS suppliers (
      id ${serial},
      name VARCHAR(100) NOT NULL,
      contact_name VARCHAR(100),
      phone VARCHAR(20),
      email VARCHAR(100),
      tax_id VARCHAR(50),
      outstanding_balance ${numeric} DEFAULT 0,
      created_at ${datetime}
    )`,

    // 4. Products
    `CREATE TABLE IF NOT EXISTS products (
      id ${serial},
      name VARCHAR(100) NOT NULL,
      sku VARCHAR(50) NOT NULL UNIQUE,
      barcode VARCHAR(50) NOT NULL UNIQUE,
      description TEXT,
      category_id INTEGER,
      cost_price ${numeric} NOT NULL,
      sale_price ${numeric} NOT NULL,
      image_url TEXT,
      is_variant INTEGER DEFAULT 0,
      parent_product_id INTEGER,
      manage_expiry INTEGER DEFAULT 0,
      supplier_id INTEGER,
      unit VARCHAR(20) DEFAULT 'pc',
      gst_rate ${numeric} DEFAULT 18.00,
      created_at ${datetime}
    )`,

    // 5. Inventory
    `CREATE TABLE IF NOT EXISTS inventory (
      id ${serial},
      product_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL,
      quantity ${numeric} NOT NULL DEFAULT 0,
      reorder_level ${numeric} NOT NULL DEFAULT 10,
      batch_number VARCHAR(50),
      expiry_date ${dateType},
      location_identifier VARCHAR(100),
      created_at ${datetime},
      UNIQUE(product_id, branch_id, batch_number)
    )`,

    // 6. Stock Movements
    `CREATE TABLE IF NOT EXISTS stock_movements (
      id ${serial},
      product_id INTEGER NOT NULL,
      from_branch_id INTEGER,
      to_branch_id INTEGER,
      quantity ${numeric} NOT NULL,
      movement_type VARCHAR(50) NOT NULL, -- 'Stock In', 'Stock Out', 'Transfer', 'Adjustment', 'Damaged'
      reference_no VARCHAR(100),
      created_by INTEGER,
      created_at ${datetime}
    )`,

    // 7. Customers
    `CREATE TABLE IF NOT EXISTS customers (
      id ${serial},
      name VARCHAR(100) NOT NULL,
      phone VARCHAR(20) NOT NULL UNIQUE,
      email VARCHAR(100),
      loyalty_points INTEGER DEFAULT 0,
      outstanding_payment ${numeric} DEFAULT 0,
      created_at ${datetime}
    )`,

    // 8. Sales
    `CREATE TABLE IF NOT EXISTS sales (
      id ${serial},
      invoice_number VARCHAR(100) NOT NULL UNIQUE,
      branch_id INTEGER NOT NULL,
      customer_id INTEGER,
      cashier_id INTEGER NOT NULL,
      subtotal ${numeric} NOT NULL,
      discount ${numeric} DEFAULT 0,
      tax ${numeric} DEFAULT 0,
      total ${numeric} NOT NULL,
      payment_method VARCHAR(50) NOT NULL, -- 'Cash', 'Card', 'UPI', 'Net Banking', 'Wallet'
      created_at ${datetime}
    )`,

    // 9. Sale Items
    `CREATE TABLE IF NOT EXISTS sale_items (
      id ${serial},
      sale_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity ${numeric} NOT NULL,
      unit_price ${numeric} NOT NULL,
      subtotal ${numeric} NOT NULL
    )`,

    // 10. Purchase Orders
    `CREATE TABLE IF NOT EXISTS purchase_orders (
      id ${serial},
      po_number VARCHAR(100) NOT NULL UNIQUE,
      supplier_id INTEGER NOT NULL,
      branch_id INTEGER NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'Draft', -- 'Draft', 'Sent', 'Received', 'Cancelled'
      total_cost ${numeric} NOT NULL DEFAULT 0,
      created_at ${datetime}
    )`,

    // 11. Purchase Items
    `CREATE TABLE IF NOT EXISTS purchase_items (
      id ${serial},
      purchase_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity ${numeric} NOT NULL,
      cost_price ${numeric} NOT NULL
    )`,

    // 12. Audit Logs
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id ${serial},
      user_id INTEGER,
      action VARCHAR(100) NOT NULL,
      details TEXT,
      created_at ${datetime}
    )`,

    // 13. Users
    `CREATE TABLE IF NOT EXISTS users (
      id ${serial},
      username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      email VARCHAR(100) NOT NULL UNIQUE,
      role VARCHAR(50) NOT NULL, -- 'Admin', 'Manager', 'Cashier', 'Warehouse Staff'
      branch_id INTEGER,
      created_at ${datetime}
    )`,

    // 14. Invoice History (WhatsApp vs Printed)
    `CREATE TABLE IF NOT EXISTS invoice_history (
      id ${serial},
      invoice_number VARCHAR(100) NOT NULL UNIQUE,
      customer_name VARCHAR(100),
      mobile_number VARCHAR(20),
      invoice_type VARCHAR(50) NOT NULL, -- 'Digital', 'Printed'
      delivery_status VARCHAR(50) NOT NULL, -- 'Pending', 'Sent', 'Failed', 'Printed'
      sent_at ${datetime}
    )`
  ];

  for (const sql of tables) {
    try {
      await execute(sql);
    } catch (err) {
      console.error('Failed to create table query:', sql, err);
    }
  }

  // Run dynamic schema migrations/upgrades
  try {
    await execute("ALTER TABLE products ADD COLUMN unit VARCHAR(20) DEFAULT 'pc'");
    console.log("Migration: Added 'unit' column to 'products' table.");
  } catch (err) {
    // Column already exists, safe to ignore
  }

  try {
    await execute("ALTER TABLE products ADD COLUMN gst_rate NUMERIC(5,2) DEFAULT 18.00");
    console.log("Migration: Added 'gst_rate' column to 'products' table.");
  } catch (err) {
    // Column already exists, safe to ignore
  }

  try {
    await execute("ALTER TABLE customers ADD COLUMN preferred_invoice_type VARCHAR(50) DEFAULT 'Printed'");
    console.log("Migration: Added 'preferred_invoice_type' column to 'customers' table.");
  } catch (err) {
    // Column already exists, safe to ignore
  }

  if (dbType === 'postgres') {
    const alterQueries = [
      "ALTER TABLE inventory ALTER COLUMN quantity TYPE NUMERIC(12, 2)",
      "ALTER TABLE inventory ALTER COLUMN reorder_level TYPE NUMERIC(12, 2)",
      "ALTER TABLE stock_movements ALTER COLUMN quantity TYPE NUMERIC(12, 2)",
      "ALTER TABLE sale_items ALTER COLUMN quantity TYPE NUMERIC(12, 2)",
      "ALTER TABLE purchase_items ALTER COLUMN quantity TYPE NUMERIC(12, 2)"
    ];
    for (const q of alterQueries) {
      try {
        await execute(q);
      } catch (err) {
        // Safe to ignore or already altered
      }
    }
  }

  console.log('All database tables verified/created successfully.');
}

module.exports = {
  query,
  getOne,
  execute,
  initDb,
  dbType
};
