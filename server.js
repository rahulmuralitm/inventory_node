const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { generateInvoicePDF } = require('./pdfGenerator');
const { sendWhatsAppInvoice } = require('./whatsappService');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key';

app.use(cors());
app.use(express.json());
app.use('/invoices', express.static(path.join(__dirname, 'public', 'invoices')));

// Log incoming requests for debugging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Middleware: Authenticate JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Authorization token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Middleware: Verify roles (variadic helper)
function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: `Access denied. Role '${req.user.role}' is not authorized.` });
    }
    next();
  };
}

// Helper: Log activities to audit logs
async function logActivity(userId, action, details) {
  try {
    await db.execute(
      "INSERT INTO audit_logs (user_id, action, details) VALUES ($1, $2, $3)",
      [userId || null, action, details]
    );
  } catch (err) {
    console.error('Failed to log audit activity:', err);
  }
}

// --- MODULE 10: USER & ROLE MANAGEMENT & AUTH ---

// Login Endpoint
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  try {
    const user = await db.getOne("SELECT * FROM users WHERE username = $1", [username]);
    if (!user) {
      return res.status(400).json({ message: 'User not found' });
    }

    const isValidPassword = bcrypt.compareSync(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(400).json({ message: 'Invalid password' });
    }

    // Get branch details if exists
    let branchCode = null;
    let branchName = null;
    if (user.branch_id) {
      const branch = await db.getOne("SELECT * FROM branches WHERE id = $1", [user.branch_id]);
      if (branch) {
        branchCode = branch.code;
        branchName = branch.name;
      }
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, branch_id: user.branch_id },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    await logActivity(user.id, 'User Login', `Logged in from branch: ${branchName || 'Central'}`);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        branch_id: user.branch_id,
        branch_code: branchCode,
        branch_name: branchName
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Login error', error: err.message });
  }
});

// Get Current Profile details
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await db.getOne("SELECT id, username, email, role, branch_id FROM users WHERE id = $1", [req.user.id]);
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Profile fetch error', error: err.message });
  }
});

// List Users
app.get('/api/users', authenticateToken, requireRoles('Admin'), async (req, res) => {
  try {
    const users = await db.query(
      `SELECT u.id, u.username, u.email, u.role, u.branch_id, u.created_at, b.name as branch_name 
       FROM users u LEFT JOIN branches b ON u.branch_id = b.id`
    );
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: 'Fetch users error', error: err.message });
  }
});

// Audit log viewer
app.get('/api/audit-logs', authenticateToken, requireRoles('Admin', 'Manager'), async (req, res) => {
  try {
    const logs = await db.query(
      `SELECT a.id, a.action, a.details, a.created_at, u.username 
       FROM audit_logs a LEFT JOIN users u ON a.user_id = u.id 
       ORDER BY a.id DESC LIMIT 100`
    );
    res.json(logs);
  } catch (err) {
    res.status(500).json({ message: 'Fetch audit logs error', error: err.message });
  }
});


// --- MODULE 1: DASHBOARD ---

app.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
  const branchId = req.query.branch_id || req.user.branch_id;
  const isSQLite = db.dbType === 'sqlite';

  try {
    // 1. Sales Calculation (Today)
    let todaySalesQuery = `SELECT SUM(total) as revenue, SUM(subtotal - (cost_sum.total_cost)) as profit 
                           FROM sales s
                           JOIN (
                             SELECT sale_id, SUM(quantity * cost_price) as total_cost 
                             FROM sale_items si 
                             JOIN products p ON si.product_id = p.id
                             GROUP BY sale_id
                           ) cost_sum ON s.id = cost_sum.sale_id
                           WHERE s.created_at >= $1`;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTodayStr = isSQLite ? startOfToday.toISOString() : startOfToday;

    let salesParams = [startOfTodayStr];
    if (branchId) {
      todaySalesQuery += " AND s.branch_id = $2";
      salesParams.push(branchId);
    }

    const salesData = await db.getOne(todaySalesQuery, salesParams) || { revenue: 0, profit: 0 };

    // 2. Inventory Valuation (Sum of stock * cost_price)
    let valuationQuery = `SELECT SUM(i.quantity * p.cost_price) as total_value 
                          FROM inventory i 
                          JOIN products p ON i.product_id = p.id`;
    const valuationParams = [];
    if (branchId) {
      valuationQuery += " WHERE i.branch_id = $1";
      valuationParams.push(branchId);
    }
    const valData = await db.getOne(valuationQuery, valuationParams) || { total_value: 0 };

    // 3. Low stock and Out of stock counts
    let stockStatusQuery = `SELECT 
                              SUM(CASE WHEN quantity = 0 THEN 1 ELSE 0 END) as out_of_stock,
                              SUM(CASE WHEN quantity > 0 AND quantity <= reorder_level THEN 1 ELSE 0 END) as low_stock
                            FROM inventory`;
    const stockParams = [];
    if (branchId) {
      stockStatusQuery += " WHERE branch_id = $1";
      stockParams.push(branchId);
    }
    const stockData = await db.getOne(stockStatusQuery, stockParams) || { out_of_stock: 0, low_stock: 0 };

    // 4. Low stock products detailed list
    let lowStockProductsQuery = `SELECT p.name, p.sku, i.quantity, i.reorder_level, b.name as branch_name
                                 FROM inventory i 
                                 JOIN products p ON i.product_id = p.id
                                 JOIN branches b ON i.branch_id = b.id
                                 WHERE i.quantity <= i.reorder_level`;
    const lowStockDetailsParams = [];
    if (branchId) {
      lowStockProductsQuery += " AND i.branch_id = $1";
      lowStockDetailsParams.push(branchId);
    }
    lowStockProductsQuery += " ORDER BY i.quantity ASC LIMIT 10";
    const lowStockDetails = await db.query(lowStockProductsQuery, lowStockDetailsParams);

    // 5. Expiry warning products detailed list
    let expiryWarningQuery = `SELECT p.name, p.sku, i.quantity, i.expiry_date, i.batch_number, b.name as branch_name
                               FROM inventory i
                               JOIN products p ON i.product_id = p.id
                               JOIN branches b ON i.branch_id = b.id
                               WHERE i.expiry_date IS NOT NULL AND i.quantity > 0`;
    const expiryParams = [];
    if (branchId) {
      expiryWarningQuery += " AND i.branch_id = $1";
      expiryParams.push(branchId);
    }
    // Sort by soonest expiry
    expiryWarningQuery += " ORDER BY i.expiry_date ASC LIMIT 10";
    const expiryDetails = await db.query(expiryWarningQuery, expiryParams);

    res.json({
      todaySales: salesData.revenue || 0,
      todayProfit: salesData.profit || 0,
      todayExpenses: (salesData.revenue - salesData.profit) || 0,
      inventoryValuation: valData.total_value || 0,
      outOfStockCount: stockData.out_of_stock || 0,
      lowStockCount: stockData.low_stock || 0,
      lowStockDetails,
      expiryDetails
    });
  } catch (err) {
    res.status(500).json({ message: 'Dashboard stats load error', error: err.message });
  }
});

// Recent Transactions
app.get('/api/dashboard/recent-transactions', authenticateToken, async (req, res) => {
  const branchId = req.query.branch_id || req.user.branch_id;
  try {
    let salesQuery = `SELECT s.id, s.invoice_number, s.total, s.created_at, b.name as branch_name, c.name as customer_name
                      FROM sales s 
                      JOIN branches b ON s.branch_id = b.id
                      LEFT JOIN customers c ON s.customer_id = c.id`;
    const params = [];
    if (branchId) {
      salesQuery += " WHERE s.branch_id = $1";
      params.push(branchId);
    }
    salesQuery += " ORDER BY s.id DESC LIMIT 10";
    const recent = await db.query(salesQuery, params);
    res.json(recent);
  } catch (err) {
    res.status(500).json({ message: 'Dashboard recent sales load error', error: err.message });
  }
});

// Top Selling Products
app.get('/api/dashboard/top-products', authenticateToken, async (req, res) => {
  const branchId = req.query.branch_id || req.user.branch_id;
  try {
    let topQuery = `SELECT p.name, p.sku, SUM(si.quantity) as units_sold, SUM(si.subtotal) as total_revenue
                    FROM sale_items si
                    JOIN products p ON si.product_id = p.id
                    JOIN sales s ON si.sale_id = s.id`;
    const params = [];
    if (branchId) {
      topQuery += " WHERE s.branch_id = $1";
      params.push(branchId);
    }
    topQuery += " GROUP BY p.id, p.name, p.sku ORDER BY units_sold DESC LIMIT 5";
    const topProducts = await db.query(topQuery, params);
    res.json(topProducts);
  } catch (err) {
    res.status(500).json({ message: 'Dashboard top products load error', error: err.message });
  }
});


// --- MODULE 2: PRODUCT MANAGEMENT ---

// List Products
app.get('/api/products', authenticateToken, async (req, res) => {
  try {
    const products = await db.query(
      `SELECT p.id, p.name, p.sku, p.barcode, p.description, p.cost_price, p.sale_price, p.image_url, 
              p.is_variant, p.parent_product_id, p.manage_expiry, p.supplier_id, p.unit, p.gst_rate,
              c.name as category_name, c.id as category_id, s.name as supplier_name
       FROM products p 
       LEFT JOIN categories c ON p.category_id = c.id
       LEFT JOIN suppliers s ON p.supplier_id = s.id
       ORDER BY p.name ASC`
    );
    res.json(products);
  } catch (err) {
    res.status(500).json({ message: 'Fetch products error', error: err.message });
  }
});

// Add Product
app.post('/api/products', authenticateToken, requireRoles('Admin', 'Manager'), async (req, res) => {
  const { name, sku, barcode, description, category_id, cost_price, sale_price, image_url, manage_expiry, supplier_id, initial_stock, branch_id, unit, gst_rate } = req.body;

  if (!name || !cost_price || !sale_price) {
    return res.status(400).json({ message: 'Name, cost price, and sale price are required' });
  }

  // Generate SKU and Barcode if not provided
  const parsedSku = sku || `SKU-${name.substring(0, 3).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
  const parsedBarcode = barcode || `880${Math.floor(100000000 + Math.random() * 900000000)}`;
  const bId = branch_id || req.user.branch_id || 1; // Default branch

  try {
    // Insert into Products
    const result = await db.execute(
      `INSERT INTO products (name, sku, barcode, description, category_id, cost_price, sale_price, image_url, manage_expiry, supplier_id, unit, gst_rate) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [name, parsedSku, parsedBarcode, description || '', category_id || null, cost_price, sale_price, image_url || 'assets/images/products/placeholder.jpg', manage_expiry ? 1 : 0, supplier_id || null, unit || 'pc', gst_rate !== undefined ? parseFloat(gst_rate) : 18.00]
    );

    const productId = result.insertId || (await db.getOne("SELECT id FROM products WHERE sku = $1", [parsedSku])).id;

    // Seed initial inventory level
    const parsedStock = initial_stock ? parseFloat(initial_stock) : 0;
    const parsedBranchId = bId ? parseInt(bId, 10) : 1;

    if (parsedStock > 0) {
      await db.execute(
        `INSERT INTO inventory (product_id, branch_id, quantity, reorder_level, batch_number, expiry_date, location_identifier)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [productId, parsedBranchId, parsedStock, 10, 'BAT-INIT-' + Math.floor(100 + Math.random() * 900), manage_expiry ? new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] : null, 'Aisle 1']
      );

      // Log the Stock In movement
      await db.execute(
        `INSERT INTO stock_movements (product_id, to_branch_id, quantity, movement_type, reference_no, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [productId, parsedBranchId, parsedStock, 'Stock In', 'Initial Seeding', req.user.id]
      );
    }

    await logActivity(req.user.id, 'Add Product', `Added Product: ${name} (SKU: ${parsedSku})`);

    res.status(201).json({ message: 'Product added successfully', id: productId });
  } catch (err) {
    res.status(500).json({ message: 'Add product error', error: err.message });
  }
});

// Edit Product
app.put('/api/products/:id', authenticateToken, requireRoles('Admin', 'Manager'), async (req, res) => {
  const { id } = req.params;
  const { name, sku, barcode, description, category_id, cost_price, sale_price, image_url, manage_expiry, supplier_id, unit, gst_rate } = req.body;

  try {
    await db.execute(
      `UPDATE products SET name = $1, sku = $2, barcode = $3, description = $4, category_id = $5, cost_price = $6, sale_price = $7, image_url = $8, manage_expiry = $9, supplier_id = $10, unit = $11, gst_rate = $12 
       WHERE id = $13`,
      [name, sku, barcode, description, category_id, cost_price, sale_price, image_url, manage_expiry ? 1 : 0, supplier_id, unit || 'pc', gst_rate !== undefined ? parseFloat(gst_rate) : 18.00, id]
    );

    await logActivity(req.user.id, 'Edit Product', `Updated Product ID: ${id} (${name})`);
    res.json({ message: 'Product updated successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Update product error', error: err.message });
  }
});

// Delete Product
app.delete('/api/products/:id', authenticateToken, requireRoles('Admin'), async (req, res) => {
  const { id } = req.params;
  try {
    const product = await db.getOne("SELECT name FROM products WHERE id = $1", [id]);
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    await db.execute("DELETE FROM products WHERE id = $1", [id]);
    await db.execute("DELETE FROM inventory WHERE product_id = $1", [id]);

    await logActivity(req.user.id, 'Delete Product', `Deleted Product: ${product.name} (ID: ${id})`);
    res.json({ message: 'Product deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Delete product error', error: err.message });
  }
});

// Fetch Categories
app.get('/api/categories', authenticateToken, async (req, res) => {
  try {
    const cats = await db.query("SELECT * FROM categories ORDER BY name ASC");
    res.json(cats);
  } catch (err) {
    res.status(500).json({ message: 'Fetch categories error', error: err.message });
  }
});

// Create Category
app.post('/api/categories', authenticateToken, requireRoles('Admin', 'Manager'), async (req, res) => {
  const { name, parent_category } = req.body;
  if (!name) {
    return res.status(400).json({ message: 'Category name is required' });
  }
  try {
    await db.execute("INSERT INTO categories (name, parent_category) VALUES ($1, $2)", [name, parent_category || null]);
    await logActivity(req.user.id, 'Add Category', `Created Category: ${name}`);
    res.status(201).json({ message: 'Category created' });
  } catch (err) {
    res.status(500).json({ message: 'Create category error', error: err.message });
  }
});


// --- MODULE 4: STOCK MANAGEMENT & WAREHOUSES ---

// Fetch Inventory Levels
app.get('/api/inventory', authenticateToken, async (req, res) => {
  let branchId = req.query.branch_id;
  if (!branchId && req.user.role === 'Cashier') {
    branchId = req.user.branch_id;
  }
  try {
    let invQuery = `SELECT i.id, i.product_id, i.branch_id, i.quantity, i.reorder_level, i.batch_number, 
                           i.expiry_date, i.location_identifier, p.name as product_name, p.sku, p.barcode, 
                           p.cost_price, p.sale_price, p.unit, b.name as branch_name
                    FROM inventory i
                    JOIN products p ON i.product_id = p.id
                    JOIN branches b ON i.branch_id = b.id`;
    const params = [];
    if (branchId) {
      invQuery += " WHERE i.branch_id = $1";
      params.push(branchId);
    }
    invQuery += " ORDER BY p.name ASC";
    const data = await db.query(invQuery, params);
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: 'Fetch inventory error', error: err.message });
  }
});

// Direct Edit Inventory Item Details
app.put('/api/inventory/:id', authenticateToken, requireRoles('Admin', 'Manager', 'Warehouse Staff'), async (req, res) => {
  const { id } = req.params;
  const { quantity, reorder_level, batch_number, expiry_date, location_identifier } = req.body;

  if (quantity === undefined || reorder_level === undefined) {
    return res.status(400).json({ message: 'Quantity and Reorder Level are required.' });
  }

  try {
    const invId = parseInt(id, 10);
    if (isNaN(invId)) {
      return res.status(400).json({ message: 'Invalid inventory ID format.' });
    }

    const inv = await db.getOne("SELECT i.*, p.name as product_name FROM inventory i JOIN products p ON i.product_id = p.id WHERE i.id = $1", [invId]);
    if (!inv) {
      return res.status(404).json({ message: 'Inventory record not found.' });
    }

    const qty = parseFloat(quantity);
    const minLvl = parseFloat(reorder_level);

    const oldQty = inv.quantity;

    await db.execute(
      `UPDATE inventory 
       SET quantity = $1, reorder_level = $2, batch_number = $3, expiry_date = $4, location_identifier = $5 
       WHERE id = $6`,
      [qty, minLvl, batch_number || 'BAT-MAIN', expiry_date || null, location_identifier || '', invId]
    );

    // Record stock movement if quantity changed
    if (qty !== oldQty) {
      const difference = qty - oldQty;

      await db.execute(
        `INSERT INTO stock_movements (product_id, from_branch_id, to_branch_id, quantity, movement_type, reference_no, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          inv.product_id,
          difference < 0 ? inv.branch_id : null,
          difference > 0 ? inv.branch_id : null,
          Math.abs(difference),
          'Adjustment',
          `EDIT-REC-${invId}`,
          req.user.id
        ]
      );
    }

    await logActivity(req.user.id, 'Edit Inventory Record', `Directly edited stock record for ${inv.product_name} (ID: ${invId})`);
    res.json({ message: 'Inventory record updated successfully.' });
  } catch (err) {
    res.status(500).json({ message: 'Update inventory record failed.', error: err.message });
  }
});

// Stock Adjustments / Transfer / In / Out
app.post('/api/inventory/movement', authenticateToken, requireRoles('Admin', 'Manager', 'Warehouse Staff'), async (req, res) => {
  const { product_id, from_branch_id, to_branch_id, quantity, movement_type, reference_no, batch_number, expiry_date, location_identifier } = req.body;

  if (!product_id || !quantity || !movement_type) {
    return res.status(400).json({ message: 'Product ID, quantity, and movement type are required' });
  }

  try {
    const qty = parseFloat(quantity);
    const ref = reference_no || `MOV-${Date.now()}`;
    const batch = batch_number || 'BAT-MAIN';
    const loc = location_identifier || 'Shelf A';

    // 1. Decrement Stock from source branch if applicable (Stock Out, Transfer, Adjustment decreasing stock)
    if (from_branch_id) {
      const sourceInv = await db.getOne(
        "SELECT * FROM inventory WHERE product_id = $1 AND branch_id = $2 AND batch_number = $3",
        [product_id, from_branch_id, batch]
      );

      if (!sourceInv || sourceInv.quantity < qty) {
        return res.status(400).json({ message: 'Insufficient stock in source branch / batch.' });
      }

      await db.execute(
        "UPDATE inventory SET quantity = quantity - $1 WHERE id = $2",
        [qty, sourceInv.id]
      );
    }

    // 2. Increment Stock at target branch (Stock In, Transfer)
    if (to_branch_id) {
      const targetInv = await db.getOne(
        "SELECT * FROM inventory WHERE product_id = $1 AND branch_id = $2 AND batch_number = $3",
        [product_id, to_branch_id, batch]
      );

      if (targetInv) {
        await db.execute(
          "UPDATE inventory SET quantity = quantity + $1 WHERE id = $2",
          [qty, targetInv.id]
        );
      } else {
        await db.execute(
          `INSERT INTO inventory (product_id, branch_id, quantity, reorder_level, batch_number, expiry_date, location_identifier) 
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [product_id, to_branch_id, qty, 10, batch, expiry_date || null, loc]
        );
      }
    }

    // Adjustments without source/target (like purely setting quantity)
    if (!from_branch_id && !to_branch_id && movement_type === 'Adjustment') {
      const bId = req.user.branch_id || 1;
      const exist = await db.getOne(
        "SELECT * FROM inventory WHERE product_id = $1 AND branch_id = $2 AND batch_number = $3",
        [product_id, bId, batch]
      );
      if (exist) {
        await db.execute(
          "UPDATE inventory SET quantity = $1 WHERE id = $2",
          [qty, exist.id]
        );
      } else {
        await db.execute(
          `INSERT INTO inventory (product_id, branch_id, quantity, reorder_level, batch_number, expiry_date, location_identifier) 
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [product_id, bId, qty, 10, batch, expiry_date || null, loc]
        );
      }
    }

    // 3. Log Stock Movement
    await db.execute(
      `INSERT INTO stock_movements (product_id, from_branch_id, to_branch_id, quantity, movement_type, reference_no, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [product_id, from_branch_id || null, to_branch_id || null, qty, movement_type, ref, req.user.id]
    );

    await logActivity(req.user.id, 'Stock Movement', `${movement_type}: Qty ${qty} of Product ID: ${product_id} (${ref})`);

    res.json({ message: 'Stock movement successfully updated' });
  } catch (err) {
    res.status(500).json({ message: 'Stock movement error', error: err.message });
  }
});

// Stock movement log log list
app.get('/api/inventory/movements', authenticateToken, async (req, res) => {
  try {
    const movements = await db.query(
      `SELECT sm.id, sm.quantity, sm.movement_type, sm.reference_no, sm.created_at,
              p.name as product_name, p.sku, 
              fb.name as from_branch_name, tb.name as to_branch_name, u.username
       FROM stock_movements sm
       JOIN products p ON sm.product_id = p.id
       LEFT JOIN branches fb ON sm.from_branch_id = fb.id
       LEFT JOIN branches tb ON sm.to_branch_id = tb.id
       LEFT JOIN users u ON sm.created_by = u.id
       ORDER BY sm.id DESC LIMIT 100`
    );
    res.json(movements);
  } catch (err) {
    res.status(500).json({ message: 'Fetch movement log error', error: err.message });
  }
});


// --- MODULE 5: POS & BILLING SYSTEM ---

// Reusable WhatsApp PDF generation & delivery handler (uses Meta API or falls back to simulation)
async function processWhatsAppDelivery(invoiceNumber, mobileNumber, reqUser) {
  const invoicesDir = path.join(__dirname, 'public', 'invoices');
  if (!fs.existsSync(invoicesDir)) {
    fs.mkdirSync(invoicesDir, { recursive: true });
  }

  const filePath = path.join(invoicesDir, `${invoiceNumber}.pdf`);

  if (!fs.existsSync(filePath)) {
    console.log(`[WhatsApp Delivery] PDF not found for ${invoiceNumber}. Generating now...`);
    // Retrieve sale data from database
    const sale = await db.getOne("SELECT * FROM sales WHERE invoice_number = $1", [invoiceNumber]);
    if (!sale) {
      throw new Error(`Sale not found for invoice number: ${invoiceNumber}`);
    }

    // Retrieve sale items
    const saleItems = await db.query(
      `SELECT si.quantity, si.unit_price, si.subtotal,
              p.name as name, p.sku, p.unit, p.gst_rate
       FROM sale_items si
       JOIN products p ON si.product_id = p.id
       WHERE si.sale_id = $1`,
      [sale.id]
    );

    // Retrieve cashier info
    let cashierName = 'Terminal Operator';
    const cashier = await db.getOne("SELECT username FROM users WHERE id = $1", [sale.cashier_id]);
    if (cashier) cashierName = cashier.username;

    // Retrieve branch info
    let branchName = 'Central Outlet';
    const branch = await db.getOne("SELECT name FROM branches WHERE id = $1", [sale.branch_id]);
    if (branch) branchName = branch.name;

    // Retrieve customer details
    let customerName = 'Anonymous';
    if (sale.customer_id) {
      const cust = await db.getOne("SELECT name FROM customers WHERE id = $1", [sale.customer_id]);
      if (cust) customerName = cust.name;
    }

    // Generate PDF
    await generateInvoicePDF({
      invoice_number: invoiceNumber,
      date: new Date(sale.created_at || Date.now()).toLocaleString(),
      branch_name: branchName,
      cashier_name: cashierName,
      customer_name: customerName,
      mobile_number: mobileNumber,
      subtotal: parseFloat(sale.subtotal),
      discount: parseFloat(sale.discount),
      tax: parseFloat(sale.tax),
      total: parseFloat(sale.total),
      payment_method: sale.payment_method,
      points_earned: sale.customer_id ? Math.floor(parseFloat(sale.total) / 100) : 0
    }, saleItems, filePath);
  }

  // 2. Dispatch message using Meta WhatsApp API
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const pdfUrl = `http://localhost:3000/invoices/${invoiceNumber}.pdf`;

  let status = 'Failed';
  if (phoneId && accessToken) {
    const apiSuccess = await sendWhatsAppInvoice(mobileNumber, invoiceNumber, pdfUrl);
    status = apiSuccess ? 'Sent' : 'Failed';
  } else {
    console.log('[WhatsApp Delivery] WhatsApp API credentials missing. Simulating 90% delivery rate...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    const success = Math.random() < 0.90;
    status = success ? 'Sent' : 'Failed';
  }

  // 3. Update database
  await db.execute(
    "UPDATE invoice_history SET delivery_status = $1, mobile_number = $2, invoice_type = 'Digital' WHERE invoice_number = $3",
    [status, mobileNumber, invoiceNumber]
  );

  // 4. Log audit log
  await db.execute(
    "INSERT INTO audit_logs (user_id, action, details) VALUES ($1, $2, $3)",
    [reqUser.id, 'WhatsApp Delivery', `WhatsApp Meta API delivery status for ${invoiceNumber} to ${mobileNumber}: ${status}`]
  );

  return status;
}
app.post('/webhook', (req, res) => {
  console.log('WEBHOOK EVENT');
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});
// POS Checkout
app.post('/api/pos/checkout', authenticateToken, async (req, res) => {
  const { customer_id, items, discount, payment_method, branch_id, invoice_type, mobile_number } = req.body;
  const branchId = branch_id || req.user.branch_id || 1; // Default cashier branch
  const invoiceType = invoice_type || 'Printed';
  const mobileNumber = mobile_number || '';

  if (!items || items.length === 0) {
    return res.status(400).json({ message: 'Purchase items are required' });
  }

  try {
    // 1. Calculate prices
    let subtotal = 0;
    const itemDetails = [];
    const itemsList = [];

    for (const item of items) {
      const prod = await db.getOne("SELECT id, name, sku, sale_price, cost_price, gst_rate, unit FROM products WHERE id = $1", [item.product_id]);
      if (!prod) {
        return res.status(400).json({ message: `Product ID ${item.product_id} not found.` });
      }

      // Check current stock levels in cashier's branch
      const inv = await db.query(
        "SELECT * FROM inventory WHERE product_id = $1 AND branch_id = $2 AND quantity >= $3 ORDER BY expiry_date ASC",
        [item.product_id, branchId, item.quantity]
      );

      let remainingToDeduct = item.quantity;
      if (inv.length === 0) {
        // Find if any stock exists at all
        const anyInv = await db.getOne("SELECT SUM(quantity) as total FROM inventory WHERE product_id = $1 AND branch_id = $2", [item.product_id, branchId]);
        const avail = anyInv ? anyInv.total : 0;
        return res.status(400).json({ message: `Insufficient stock for product '${prod.name}'. Requested: ${item.quantity}, Available: ${avail}` });
      }

      // Prepare deduction transactions (FIFO for expiring items)
      for (const batch of inv) {
        if (remainingToDeduct <= 0) break;
        const deductQty = Math.min(batch.quantity, remainingToDeduct);

        // Push batch details for audit trail
        itemDetails.push({
          product_id: prod.id,
          name: prod.name,
          sku: prod.sku,
          quantity: deductQty,
          unit_price: prod.sale_price,
          subtotal: prod.sale_price * deductQty,
          inventory_id: batch.id,
          batch_number: batch.batch_number,
          unit: prod.unit,
          gst_rate: prod.gst_rate
        });

        remainingToDeduct -= deductQty;
      }

      const itemSubtotal = prod.sale_price * item.quantity;
      subtotal += itemSubtotal;

      const itemGstRate = prod.gst_rate !== undefined && prod.gst_rate !== null ? parseFloat(prod.gst_rate) : 18.00;
      itemsList.push({
        itemSubtotal: itemSubtotal,
        gstRate: itemGstRate
      });
    }

    const discAmount = parseFloat(discount || 0);

    // Dynamic GST calculation with proportionate discount distribution
    let taxAmount = 0;
    if (subtotal > 0) {
      for (const itemEntry of itemsList) {
        const itemDiscount = discAmount * (itemEntry.itemSubtotal / subtotal);
        const itemDiscountedSubtotal = Math.max(0, itemEntry.itemSubtotal - itemDiscount);
        const itemTax = itemDiscountedSubtotal * (itemEntry.gstRate / 100);
        taxAmount += itemTax;
      }
    }
    taxAmount = parseFloat(taxAmount.toFixed(2));
    const totalAmount = parseFloat((Math.max(0, subtotal - discAmount) + taxAmount).toFixed(2));

    // 2. Generate unique Invoice Number
    const invNo = `INV-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    // 3. Create Sale record
    const saleResult = await db.execute(
      `INSERT INTO sales (invoice_number, branch_id, customer_id, cashier_id, subtotal, discount, tax, total, payment_method) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [invNo, branchId, customer_id || null, req.user.id, subtotal, discAmount, taxAmount, totalAmount, payment_method]
    );

    const saleId = saleResult.insertId || (await db.getOne("SELECT id FROM sales WHERE invoice_number = $1", [invNo])).id;

    // 4. Record Items & Deduct Stock
    for (const d of itemDetails) {
      await db.execute(
        `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, subtotal) 
         VALUES ($1, $2, $3, $4, $5)`,
        [saleId, d.product_id, d.quantity, d.unit_price, d.subtotal]
      );

      // Decrement Inventory Batch
      await db.execute(
        "UPDATE inventory SET quantity = quantity - $1 WHERE id = $2",
        [d.quantity, d.inventory_id]
      );

      // Log stock movement
      await db.execute(
        `INSERT INTO stock_movements (product_id, from_branch_id, quantity, movement_type, reference_no, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [d.product_id, branchId, d.quantity, 'Stock Out', invNo, req.user.id]
      );
    }

    // 5. Loyalty rewards logic (1 point per ₹100 spent) & Preference memory
    let customerName = 'Anonymous';
    if (customer_id) {
      const addedPoints = Math.floor(totalAmount / 100);
      await db.execute(
        "UPDATE customers SET loyalty_points = loyalty_points + $1, preferred_invoice_type = $2 WHERE id = $3",
        [addedPoints, invoiceType, customer_id]
      );

      const cust = await db.getOne("SELECT name FROM customers WHERE id = $1", [customer_id]);
      if (cust) {
        customerName = cust.name;
      }
    } else if (mobileNumber) {
      customerName = `Guest (${mobileNumber})`;
    }

    // 6. Record Invoice History
    const deliveryStatus = invoiceType === 'Printed' ? 'Printed' : 'Pending';
    await db.execute(
      `INSERT INTO invoice_history (invoice_number, customer_name, mobile_number, invoice_type, delivery_status)
       VALUES ($1, $2, $3, $4, $5)`,
      [invNo, customerName, mobileNumber, invoiceType, deliveryStatus]
    );

    // 7. Async WhatsApp Dispatcher & real PDF generator
    if (invoiceType === 'Digital') {
      setTimeout(async () => {
        try {
          console.log(`[WhatsApp Delivery] Dispatching asynchronous WhatsApp dispatch process for ${invNo}...`);
          const status = await processWhatsAppDelivery(invNo, mobileNumber, req.user);
          console.log(`[WhatsApp Delivery] Completed async dispatch for ${invNo}. Result: ${status}`);
        } catch (err) {
          console.error(`[WhatsApp Delivery] Async delivery error for ${invNo}:`, err);
        }
      }, 100);
    }

    await logActivity(req.user.id, 'POS Checkout', `Completed Sale Invoice: ${invNo} (Total: ₹${totalAmount})`);

    res.status(201).json({
      message: 'Checkout successful',
      invoice_number: invNo,
      sale_id: saleId,
      subtotal,
      discount: discAmount,
      tax: taxAmount,
      total: totalAmount,
      points_earned: customer_id ? Math.floor(totalAmount / 100) : 0,
      invoice_type: invoiceType,
      delivery_status: deliveryStatus
    });
  } catch (err) {
    res.status(500).json({ message: 'Checkout error', error: err.message });
  }
});

// 1. Get Delivery Status of Invoice
app.get('/api/pos/invoices/:invoice_number/status', authenticateToken, async (req, res) => {
  const { invoice_number } = req.params;
  try {
    const statusRecord = await db.getOne(
      "SELECT invoice_number, customer_name, mobile_number, invoice_type, delivery_status, sent_at FROM invoice_history WHERE invoice_number = $1",
      [invoice_number]
    );
    if (!statusRecord) {
      return res.status(404).json({ message: 'Invoice delivery status not found' });
    }
    res.json(statusRecord);
  } catch (err) {
    res.status(500).json({ message: 'Error checking status', error: err.message });
  }
});

// 2. Retry WhatsApp Dispatch
app.post('/api/pos/invoices/:invoice_number/retry', authenticateToken, async (req, res) => {
  const { invoice_number } = req.params;
  const { mobile_number } = req.body;
  try {
    const record = await db.getOne("SELECT * FROM invoice_history WHERE invoice_number = $1", [invoice_number]);
    if (!record) {
      return res.status(404).json({ message: 'Invoice not found in history logs' });
    }

    const targetMobile = mobile_number || record.mobile_number;
    if (!targetMobile) {
      return res.status(400).json({ message: 'Mobile number is required to send WhatsApp invoice' });
    }

    // Reset status to Pending in DB
    await db.execute(
      "UPDATE invoice_history SET delivery_status = 'Pending', mobile_number = $1 WHERE invoice_number = $2",
      [targetMobile, invoice_number]
    );

    // Re-trigger WhatsApp Dispatcher
    setTimeout(async () => {
      try {
        console.log(`[WhatsApp Retry] Re-dispatching WhatsApp process for ${invoice_number}...`);
        const status = await processWhatsAppDelivery(invoice_number, targetMobile, req.user);
        console.log(`[WhatsApp Retry] Completed retry async dispatch for ${invoice_number}. Result: ${status}`);
      } catch (err) {
        console.error(`[WhatsApp Retry] Async retry error for ${invoice_number}:`, err);
      }
    }, 100);

    res.json({ message: 'Retry initiated successfully', delivery_status: 'Pending' });
  } catch (err) {
    res.status(500).json({ message: 'Error initiating retry', error: err.message });
  }
});

// 3. List Invoice Delivery History logs
app.get('/api/pos/invoice-history', authenticateToken, async (req, res) => {
  try {
    const list = await db.query(
      "SELECT id, invoice_number, customer_name, mobile_number, invoice_type, delivery_status, sent_at FROM invoice_history ORDER BY sent_at DESC LIMIT 100"
    );
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching invoice delivery logs', error: err.message });
  }
});


// --- MODULE 6 & 7: CUSTOMER & SUPPLIER MANAGEMENT ---

// List Customers
app.get('/api/customers', authenticateToken, async (req, res) => {
  try {
    const list = await db.query("SELECT * FROM customers ORDER BY name ASC");
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Fetch customers error', error: err.message });
  }
});

// Add Customer
app.post('/api/customers', authenticateToken, async (req, res) => {
  const { name, phone, email } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ message: 'Name and Phone are required' });
  }
  try {
    const result = await db.execute(
      "INSERT INTO customers (name, phone, email, loyalty_points, outstanding_payment) VALUES ($1, $2, $3, 0, 0)",
      [name, phone, email || '']
    );
    const customerId = result.insertId || (await db.getOne("SELECT id FROM customers WHERE phone = $1", [phone])).id;
    res.status(201).json({ message: 'Customer added successfully', id: customerId });
  } catch (err) {
    res.status(500).json({ message: 'Create customer error', error: err.message });
  }
});

// List Suppliers
app.get('/api/suppliers', authenticateToken, async (req, res) => {
  try {
    const list = await db.query("SELECT * FROM suppliers ORDER BY name ASC");
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Fetch suppliers error', error: err.message });
  }
});

// Add Supplier
app.post('/api/suppliers', authenticateToken, requireRoles('Admin', 'Manager'), async (req, res) => {
  const { name, contact_name, phone, email, tax_id } = req.body;
  if (!name) {
    return res.status(400).json({ message: 'Supplier Name is required' });
  }
  try {
    await db.execute(
      "INSERT INTO suppliers (name, contact_name, phone, email, tax_id) VALUES ($1, $2, $3, $4, $5)",
      [name, contact_name || '', phone || '', email || '', tax_id || '']
    );
    res.status(201).json({ message: 'Supplier added' });
  } catch (err) {
    res.status(500).json({ message: 'Create supplier error', error: err.message });
  }
});


// --- MODULE 8: PURCHASE MANAGEMENT ---

// List Purchase Orders
app.get('/api/purchase-orders', authenticateToken, async (req, res) => {
  try {
    const poList = await db.query(
      `SELECT po.id, po.po_number, po.status, po.total_cost, po.created_at, s.name as supplier_name, b.name as branch_name
       FROM purchase_orders po
       JOIN suppliers s ON po.supplier_id = s.id
       JOIN branches b ON po.branch_id = b.id
       ORDER BY po.id DESC`
    );
    res.json(poList);
  } catch (err) {
    res.status(500).json({ message: 'Fetch POs error', error: err.message });
  }
});

// Create Purchase Order
app.post('/api/purchase-orders', authenticateToken, requireRoles('Admin', 'Manager', 'Warehouse Staff'), async (req, res) => {
  const { supplier_id, items, branch_id } = req.body;
  const bId = branch_id || req.user.branch_id || 1;

  if (!supplier_id || !items || items.length === 0) {
    return res.status(400).json({ message: 'Supplier ID and purchase items are required' });
  }

  try {
    let totalCost = 0;
    const poItems = [];

    for (const item of items) {
      const prod = await db.getOne("SELECT cost_price FROM products WHERE id = $1", [item.product_id]);
      if (!prod) {
        return res.status(400).json({ message: `Product ID ${item.product_id} not found.` });
      }
      const cost = prod.cost_price * item.quantity;
      totalCost += cost;
      poItems.push({
        product_id: item.product_id,
        quantity: item.quantity,
        cost_price: prod.cost_price
      });
    }

    const poNumber = `PO-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    const poRes = await db.execute(
      "INSERT INTO purchase_orders (po_number, supplier_id, branch_id, status, total_cost) VALUES ($1, $2, $3, 'Draft', $4)",
      [poNumber, supplier_id, bId, totalCost]
    );

    const purchaseId = poRes.insertId || (await db.getOne("SELECT id FROM purchase_orders WHERE po_number = $1", [poNumber])).id;

    for (const item of poItems) {
      await db.execute(
        "INSERT INTO purchase_items (purchase_id, product_id, quantity, cost_price) VALUES ($1, $2, $3, $4)",
        [purchaseId, item.product_id, item.quantity, item.cost_price]
      );
    }

    await logActivity(req.user.id, 'Create PO', `Created PO: ${poNumber} (Total: ₹${totalCost})`);
    res.status(201).json({ message: 'Purchase Order created in Draft', po_number: poNumber, id: purchaseId });
  } catch (err) {
    res.status(500).json({ message: 'Create PO error', error: err.message });
  }
});

// Receive Goods Process (Receiving items, increments stock, updates PO state)
app.post('/api/purchase-orders/:id/receive', authenticateToken, requireRoles('Admin', 'Manager', 'Warehouse Staff'), async (req, res) => {
  const { id } = req.params;
  const { batch_number, expiry_date, location_identifier } = req.body;

  try {
    const po = await db.getOne("SELECT * FROM purchase_orders WHERE id = $1", [id]);
    if (!po) {
      return res.status(404).json({ message: 'Purchase Order not found' });
    }
    if (po.status === 'Received') {
      return res.status(400).json({ message: 'Goods already received for this PO.' });
    }

    const items = await db.query("SELECT * FROM purchase_items WHERE purchase_id = $1", [id]);
    const batch = batch_number || `BAT-PO-${Date.now()}`;
    const loc = location_identifier || 'Aisle Main';

    for (const item of items) {
      // Check if item exists in inventory batch
      const exist = await db.getOne(
        "SELECT * FROM inventory WHERE product_id = $1 AND branch_id = $2 AND batch_number = $3",
        [item.product_id, po.branch_id, batch]
      );

      if (exist) {
        await db.execute(
          "UPDATE inventory SET quantity = quantity + $1 WHERE id = $2",
          [item.quantity, exist.id]
        );
      } else {
        await db.execute(
          `INSERT INTO inventory (product_id, branch_id, quantity, reorder_level, batch_number, expiry_date, location_identifier)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [item.product_id, po.branch_id, item.quantity, 10, batch, expiry_date || null, loc]
        );
      }

      // Log Stock movement
      await db.execute(
        `INSERT INTO stock_movements (product_id, to_branch_id, quantity, movement_type, reference_no, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [item.product_id, po.branch_id, item.quantity, 'Stock In', po.po_number, req.user.id]
      );
    }

    // Update PO Status
    await db.execute("UPDATE purchase_orders SET status = 'Received' WHERE id = $1", [id]);

    // Add to Supplier outstanding debt
    await db.execute(
      "UPDATE suppliers SET outstanding_balance = outstanding_balance + $1 WHERE id = $2",
      [po.total_cost, po.supplier_id]
    );

    await logActivity(req.user.id, 'Receive Goods', `Received goods for PO: ${po.po_number}. Stock auto-updated.`);
    res.json({ message: 'Goods received successfully. Inventory has been updated.' });
  } catch (err) {
    res.status(500).json({ message: 'Receive goods error', error: err.message });
  }
});


// --- MODULE 9: ADVANCED REPORTS & AI FORECASTING ---

// AI forecasting engine
app.get('/api/analytics/forecast', authenticateToken, async (req, res) => {
  const branchId = req.query.branch_id || req.user.branch_id;
  const isSQLite = db.dbType === 'sqlite';

  try {
    // 1. Fetch 6 Months sales aggregated monthly to perform regression
    // Standard SQLite date parsing vs Postgres parsing
    let salesHistoryQuery = '';
    if (isSQLite) {
      salesHistoryQuery = `
        SELECT 
          strftime('%Y-%m', created_at) as month_label,
          SUM(total) as revenue
        FROM sales
        ${branchId ? 'WHERE branch_id = $1' : ''}
        GROUP BY month_label
        ORDER BY month_label ASC
        LIMIT 6
      `;
    } else {
      salesHistoryQuery = `
        SELECT 
          to_char(created_at, 'YYYY-MM') as month_label,
          SUM(total) as revenue
        FROM sales
        ${branchId ? 'WHERE branch_id = $1' : ''}
        GROUP BY month_label
        ORDER BY month_label ASC
        LIMIT 6
      `;
    }

    const params = branchId ? [branchId] : [];
    const salesHistory = await db.query(salesHistoryQuery, params);

    if (salesHistory.length < 2) {
      return res.json({
        message: 'Insufficient transaction data to calculate accurate AI forecasts. Need at least 2 months of records.',
        forecast: [],
        deadStock: [],
        fastMoving: []
      });
    }

    // 2. Perform Mathematical Simple Linear Regression
    // X is month index (1 to N)
    // Y is total monthly revenue
    const n = salesHistory.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;

    salesHistory.forEach((row, i) => {
      const x = i + 1; // Month index
      const y = parseFloat(row.revenue);
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumXX += x * x;
    });

    const meanX = sumX / n;
    const meanY = sumY / n;

    // Slope (m) = Sum((x_i - meanX)*(y_i - meanY)) / Sum((x_i - meanX)^2)
    let numerator = 0;
    let denominator = 0;
    salesHistory.forEach((row, i) => {
      const x = i + 1;
      const y = parseFloat(row.revenue);
      numerator += (x - meanX) * (y - meanY);
      denominator += Math.pow(x - meanX, 2);
    });

    const slope = denominator === 0 ? 0 : numerator / denominator;
    const intercept = meanY - slope * meanX;

    // Project next 3 months (Indices: n+1, n+2, n+3)
    const forecast = [];
    const lastMonth = new Date(salesHistory[n - 1].month_label + "-15"); // Mid-month anchor

    for (let j = 1; j <= 3; j++) {
      const targetIndex = n + j;
      const predictedRevenue = Math.max(0, slope * targetIndex + intercept);

      const futureMonth = new Date(lastMonth);
      futureMonth.setMonth(futureMonth.getMonth() + j);

      const label = futureMonth.toISOString().substring(0, 7);
      forecast.push({
        month_label: label,
        predicted_revenue: parseFloat(predictedRevenue.toFixed(2)),
        confidence: slope >= 0 ? 'High Growth' : 'Stable/Downward Trend'
      });
    }

    // 3. AI Insights: Identify Fast-Moving Products (top 20% total revenue generated in last 60 days)
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
    const dateStr = isSQLite ? sixtyDaysAgo.toISOString() : sixtyDaysAgo;

    let fastQuery = `
      SELECT p.id, p.name, p.sku, SUM(si.subtotal) as total_sales
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      JOIN sales s ON si.sale_id = s.id
      WHERE s.created_at >= $1
      ${branchId ? 'AND s.branch_id = $2' : ''}
      GROUP BY p.id, p.name, p.sku
      ORDER BY total_sales DESC
    `;
    const fastParams = branchId ? [dateStr, branchId] : [dateStr];
    const salesByProd = await db.query(fastQuery, fastParams);

    const grandTotal = salesByProd.reduce((acc, row) => acc + parseFloat(row.total_sales), 0);
    let cumulative = 0;
    const fastMoving = [];

    for (const row of salesByProd) {
      cumulative += parseFloat(row.total_sales);
      fastMoving.push({
        id: row.id,
        name: row.name,
        sku: row.sku,
        total_sales: parseFloat(row.total_sales).toFixed(2),
        pct: grandTotal > 0 ? ((row.total_sales / grandTotal) * 100).toFixed(1) : 0
      });
      // Capture items composing top 60% of total revenue
      if (grandTotal > 0 && cumulative / grandTotal >= 0.6) break;
    }

    // 4. AI Insights: Identify Dead Stock (zero sales in the last 60 days)
    let deadQuery = `
      SELECT p.id, p.name, p.sku, p.cost_price 
      FROM products p
      WHERE p.id NOT IN (
        SELECT DISTINCT si.product_id 
        FROM sale_items si
        JOIN sales s ON si.sale_id = s.id
        WHERE s.created_at >= $1
      )
    `;
    const deadStock = await db.query(deadQuery, [dateStr]);

    res.json({
      historical: salesHistory,
      forecast,
      regressionLine: { slope: parseFloat(slope.toFixed(4)), intercept: parseFloat(intercept.toFixed(2)) },
      fastMoving,
      deadStock
    });
  } catch (err) {
    res.status(500).json({ message: 'Forecast analytics error', error: err.message });
  }
});

// Branch list
app.get('/api/branches', authenticateToken, async (req, res) => {
  try {
    const list = await db.query("SELECT * FROM branches");
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Fetch branches error', error: err.message });
  }
});

// Start Server
app.listen(PORT, async () => {
  console.log(`Enterprise Inventory System Backend running on port ${PORT}`);
  try {
    await db.initDb();
    console.log('Database initialized successfully.');
  } catch (err) {
    console.error('Database connection failed on startup:', err);
  }
});
