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
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

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

    // 6. Category Sales (for Pie Chart)
    const categorySales = await db.query(
      `SELECT c.name as category_name, SUM(si.subtotal) as total_sales 
       FROM sale_items si 
       JOIN products p ON si.product_id = p.id 
       JOIN categories c ON p.category_id = c.id 
       GROUP BY c.name 
       ORDER BY total_sales DESC`
    );

    // 7. Branch Sales (for Bar Chart)
    const branchSales = await db.query(
      `SELECT b.name as branch_name, SUM(s.total) as total_sales 
       FROM sales s 
       JOIN branches b ON s.branch_id = b.id 
       GROUP BY b.name 
       ORDER BY total_sales DESC`
    );

    // 8. Cashier Sales Leaderboard
    const cashierSales = await db.query(
      `SELECT u.username, SUM(s.total) as total_sales 
       FROM sales s 
       JOIN users u ON s.cashier_id = u.id 
       GROUP BY u.username 
       ORDER BY total_sales DESC 
       LIMIT 5`
    );

    res.json({
      todaySales: salesData.revenue || 0,
      todayProfit: salesData.profit || 0,
      todayExpenses: (salesData.revenue - salesData.profit) || 0,
      inventoryValuation: valData.total_value || 0,
      outOfStockCount: stockData.out_of_stock || 0,
      lowStockCount: stockData.low_stock || 0,
      lowStockDetails,
      expiryDetails,
      categorySales,
      branchSales,
      cashierSales
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

const multer = require('multer');

// Configure multer storage for product images
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Upload Product Image Endpoint
app.post('/api/upload', authenticateToken, requireRoles('Admin', 'Manager'), (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.json({ image_url: imageUrl });
  });
});

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

// Inter-Branch Stock Transfers: List Transfers
app.get('/api/inventory/transfers', authenticateToken, async (req, res) => {
  const branchId = req.query.branch_id || req.user.branch_id;
  try {
    let queryStr = `
      SELECT 
        st.id, st.transfer_number, st.product_id, st.from_branch_id, st.to_branch_id, 
        st.quantity, st.batch_number, st.status, st.received_quantity, st.remarks, 
        st.created_at, st.updated_at,
        p.name as product_name, p.sku, p.unit,
        fb.name as from_branch_name, tb.name as to_branch_name, u.username as creator_username
      FROM stock_transfers st
      JOIN products p ON st.product_id = p.id
      JOIN branches fb ON st.from_branch_id = fb.id
      JOIN branches tb ON st.to_branch_id = tb.id
      LEFT JOIN users u ON st.created_by = u.id
    `;
    const params = [];
    if (branchId) {
      queryStr += ` WHERE st.from_branch_id = $1 OR st.to_branch_id = $1`;
      params.push(branchId);
    }
    queryStr += ` ORDER BY st.id DESC`;
    const list = await db.query(queryStr, params);
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching stock transfers', error: err.message });
  }
});

// Inter-Branch Stock Transfers: Request Transfer
app.post('/api/inventory/transfers', authenticateToken, requireRoles('Admin', 'Manager', 'Warehouse Staff'), async (req, res) => {
  const { product_id, from_branch_id, to_branch_id, quantity, batch_number, remarks } = req.body;

  if (!product_id || !from_branch_id || !to_branch_id || !quantity || quantity <= 0) {
    return res.status(400).json({ message: 'Product, Source Branch, Target Branch, and positive Quantity are required.' });
  }
  if (from_branch_id === to_branch_id) {
    return res.status(400).json({ message: 'Source and Target branches must be different.' });
  }

  try {
    const qty = parseFloat(quantity);
    const batch = batch_number || 'BAT-MAIN';

    // Verify source stock availability
    const sourceInv = await db.getOne(
      "SELECT * FROM inventory WHERE product_id = $1 AND branch_id = $2 AND batch_number = $3",
      [product_id, from_branch_id, batch]
    );

    if (!sourceInv || sourceInv.quantity < qty) {
      return res.status(400).json({ message: 'Insufficient stock in source branch for this batch.' });
    }

    const trNo = `TR-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    await db.execute(
      `INSERT INTO stock_transfers (transfer_number, product_id, from_branch_id, to_branch_id, quantity, batch_number, status, remarks, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'Pending', $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [trNo, product_id, from_branch_id, to_branch_id, qty, batch, remarks || '', req.user.id]
    );

    await logActivity(req.user.id, 'Create Stock Transfer', `Requested transfer ${trNo}: Qty ${qty} of Product ID ${product_id} from branch ${from_branch_id} to ${to_branch_id}`);
    res.status(201).json({ message: 'Stock transfer request created successfully.', transfer_number: trNo });
  } catch (err) {
    res.status(500).json({ message: 'Error creating stock transfer request', error: err.message });
  }
});

// Inter-Branch Stock Transfers: Receive Shipment & Reconcile
app.post('/api/inventory/transfers/:id/receive', authenticateToken, requireRoles('Admin', 'Manager', 'Warehouse Staff'), async (req, res) => {
  const { id } = req.params;
  const { received_quantity, remarks } = req.body;

  if (received_quantity === undefined || isNaN(parseFloat(received_quantity)) || parseFloat(received_quantity) < 0) {
    return res.status(400).json({ message: 'Valid received quantity is required.' });
  }

  try {
    const transferId = parseInt(id, 10);
    const transfer = await db.getOne("SELECT * FROM stock_transfers WHERE id = $1", [transferId]);
    if (!transfer) {
      return res.status(404).json({ message: 'Stock transfer request not found.' });
    }
    if (transfer.status !== 'Pending') {
      return res.status(400).json({ message: 'Stock transfer has already been processed.' });
    }

    const reqQty = parseFloat(transfer.quantity);
    const recQty = parseFloat(received_quantity);
    const status = recQty === reqQty ? 'Completed' : 'Discrepancy';

    // 1. Double check source stock availability
    const sourceInv = await db.getOne(
      "SELECT * FROM inventory WHERE product_id = $1 AND branch_id = $2 AND batch_number = $3",
      [transfer.product_id, transfer.from_branch_id, transfer.batch_number]
    );

    if (!sourceInv || sourceInv.quantity < reqQty) {
      return res.status(400).json({ message: 'Failed to process transfer. Source branch has insufficient stock now.' });
    }

    // 2. Decrement from Source inventory
    await db.execute(
      "UPDATE inventory SET quantity = quantity - $1 WHERE id = $2",
      [reqQty, sourceInv.id]
    );

    // 3. Increment to Target inventory
    if (recQty > 0) {
      const targetInv = await db.getOne(
        "SELECT * FROM inventory WHERE product_id = $1 AND branch_id = $2 AND batch_number = $3",
        [transfer.product_id, transfer.to_branch_id, transfer.batch_number]
      );

      if (targetInv) {
        await db.execute(
          "UPDATE inventory SET quantity = quantity + $1 WHERE id = $2",
          [recQty, targetInv.id]
        );
      } else {
        await db.execute(
          `INSERT INTO inventory (product_id, branch_id, quantity, reorder_level, batch_number, expiry_date, location_identifier)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [transfer.product_id, transfer.to_branch_id, recQty, sourceInv.reorder_level, transfer.batch_number, sourceInv.expiry_date, sourceInv.location_identifier || 'Aisle Main']
        );
      }
    }

    // 4. Update transfer status
    await db.execute(
      `UPDATE stock_transfers 
       SET status = $1, received_quantity = $2, remarks = $3, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $4`,
      [status, recQty, remarks || transfer.remarks || '', transferId]
    );

    // 5. Log stock movements
    await db.execute(
      `INSERT INTO stock_movements (product_id, from_branch_id, to_branch_id, quantity, movement_type, reference_no, created_by)
       VALUES ($1, $2, $3, $4, 'Transfer Out', $5, $6)`,
      [transfer.product_id, transfer.from_branch_id, transfer.to_branch_id, reqQty, transfer.transfer_number, req.user.id]
    );

    if (recQty > 0) {
      await db.execute(
        `INSERT INTO stock_movements (product_id, from_branch_id, to_branch_id, quantity, movement_type, reference_no, created_by)
         VALUES ($1, $2, $3, $4, 'Transfer In', $5, $6)`,
        [transfer.product_id, transfer.from_branch_id, transfer.to_branch_id, recQty, transfer.transfer_number, req.user.id]
      );
    }

    // Log discrepancy movements if any items went missing
    const discrepancy = reqQty - recQty;
    if (discrepancy > 0) {
      await db.execute(
        `INSERT INTO stock_movements (product_id, from_branch_id, quantity, movement_type, reference_no, created_by)
         VALUES ($1, $2, $3, 'Damaged', $4, $5)`,
        [transfer.product_id, transfer.from_branch_id, discrepancy, `${transfer.transfer_number}-DISC`, req.user.id]
      );
    }

    await logActivity(
      req.user.id,
      'Receive Stock Transfer',
      `Processed receipt of transfer ${transfer.transfer_number}: Received ${recQty}/${reqQty} units. Status: ${status}`
    );

    res.json({ message: 'Stock transfer received and reconciled successfully.', status });
  } catch (err) {
    res.status(500).json({ message: 'Error receiving stock transfer', error: err.message });
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
      loyalty_discount: parseFloat(sale.loyalty_discount || 0),
      tier_discount: parseFloat(sale.tier_discount || 0),
      promo_discount: parseFloat(sale.promo_discount || 0),
      coupon_discount: parseFloat(sale.coupon_discount || 0),
      coupon_code: sale.coupon_code || null,
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

// --- RAZORPAY UPI QR CODE INTEGRATION ---
const https = require('https');

// Mock storage for UPI QR Payments (in-memory map)
const mockQrPayments = new Map();

// Helper to generate a UPI QR Code
// function createRazorpayQrCode(amount, invoiceNumber) {
//   return new Promise(async (resolve, reject) => {
//     const keyId = process.env.RAZORPAY_KEY_ID;
//     const keySecret = process.env.RAZORPAY_KEY_SECRET;

//     if (!keyId || !keySecret) {
//       const mockId = `qr_mock_${Date.now()}`;
//       const upiUrl = `upi://pay?pa=aura.stores@razorpay&pn=Aura%20Stores&am=${amount.toFixed(2)}&cu=INR&tr=${mockId}`;
//       const encodedUpiUrl = encodeURIComponent(upiUrl);
//       resolve({
//         id: mockId,
//         image_url: `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodedUpiUrl}`,
//         payment_amount: Math.round(amount * 100),
//         status: 'active',
//         is_mock: true
//       });
//       return;
//     }

//     const payload = JSON.stringify({
//       type: 'upi_qr',
//       name: 'Aura Stores',
//       usage: 'single_use',
//       fixed_amount: true,
//       payment_amount: Math.round(amount * 100),
//       description: `Payment for Invoice ${invoiceNumber || 'POS Checkout'}`,
//       notes: {
//         invoice_number: invoiceNumber || ''
//       }
//     });

//     const Razorpay = require('razorpay');

//     const razorpay = new Razorpay({
//       key_id: process.env.RAZORPAY_KEY_ID,
//       key_secret: process.env.RAZORPAY_KEY_SECRET
//     });

//     const order = await razorpay.orders.create({
//       amount: 22800,
//       currency: 'INR',
//       receipt: `INV_${Date.now()}`
//     });

//     console.log('order', order);
//     console.log("payload", payload)
//     const options = {
//       hostname: 'api.razorpay.com',
//       port: 443,
//       path: '/v1/payments/qr_codes',
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json',
//         'Authorization': 'Basic ' + Buffer.from(keyId + ':' + keySecret).toString('base64'),
//         'Content-Length': Buffer.byteLength(payload)
//       }
//     };
//     console.log('opti,ons', options)
//     const req = https.request(options, (res) => {
//       let data = '';
//       res.on('data', (chunk) => data += chunk);
//       res.on('end', () => {
//         try {
//           const parsed = JSON.parse(data);
//           if (res.statusCode >= 200 && res.statusCode < 300) {
//             resolve({
//               id: parsed.id,
//               image_url: parsed.image_url,
//               payment_amount: parsed.payment_amount,
//               status: parsed.status,
//               is_mock: false
//             });
//           } else {
//             console.log("parsed", parsed)
//             // console.log("resresresresres", res)

//             reject(new Error(parsed.error ? parsed.error.description : 'Failed to create Razorpay QR Code'));
//           }
//         } catch (e) {
//           reject(e);
//         }
//       });
//     });

//     req.on('error', (e) => reject(e));
//     req.write(payload);
//     req.end();
//   });
// }
const QRCode = require('qrcode'); // npm install qrcode

async function createRazorpayQrCode(amount, invoiceNumber) {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  // ── Fallback: DIY QR (no Razorpay API needed) ──────────────────
  if (!keyId || !keySecret) {
    return await generateDIYQR(amount, invoiceNumber);
  }

  // ── Razorpay QR (needs API feature enabled) ────────────────────
  const payload = JSON.stringify({
    type: 'upi_qr',
    name: 'Aura Stores',
    usage: 'single_use',
    fixed_amount: true,
    payment_amount: Math.round(amount * 100),  // rupees → paise
    description: `Payment for Invoice ${invoiceNumber || 'POS Checkout'}`,
    close_by: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    notes: {
      invoice_number: invoiceNumber || ''
    }
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.razorpay.com',
      port: 443,
      path: '/v1/payments/qr_codes',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({
              id: parsed.id,
              image_url: parsed.image_url,
              short_url: parsed.short_url,
              payment_amount: parsed.payment_amount,
              close_by: parsed.close_by,
              status: parsed.status,
              is_mock: false
            });
          } else {
            // Razorpay API not enabled → fallback to DIY QR
            console.warn('Razorpay QR API failed, falling back to DIY QR:', parsed?.error?.description);
            generateDIYQR(amount, invoiceNumber).then(resolve).catch(reject);
          }

        } catch (e) {
          reject(new Error('Failed to parse Razorpay response: ' + e.message));
        }
      });
    });

    req.on('error', (e) => reject(new Error('Network error: ' + e.message)));
    req.write(payload);
    req.end();
  });
}

// ── DIY UPI QR (always works, no API approval needed) ────────────
async function generateDIYQR(amount, invoiceNumber) {
  const upiId = process.env.UPI_ID || 'success@razorpay';
  const name = process.env.STORE_NAME || 'Aura Stores';
  const txnRef = invoiceNumber || `TXN_${Date.now()}`;

  const upiString = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(name)}&am=${amount.toFixed(2)}&cu=INR&tr=${txnRef}&tn=${encodeURIComponent('Invoice ' + txnRef)}`;

  const qrBase64 = await QRCode.toDataURL(upiString, {
    errorCorrectionLevel: 'H',
    width: 400,
    margin: 2
  });

  return {
    id: `qr_diy_${Date.now()}`,
    image_url: qrBase64,       // base64 — use as <img src="..." />
    upi_string: upiString,
    payment_amount: Math.round(amount * 100),
    status: 'active',
    is_mock: true
  };
}

// module.exports = { createUPIQrCode };
// Helper to poll/check status of UPI QR Code payment
function checkRazorpayQrCodeStatus(qrCodeId) {
  return new Promise((resolve, reject) => {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret || qrCodeId.startsWith('qr_mock_')) {
      const mockPayment = mockQrPayments.get(qrCodeId);
      if (mockPayment) {
        resolve({
          status: 'closed',
          payment_id: mockPayment.payment_id,
          method: 'upi',
          amount: mockPayment.amount,
          is_mock: true
        });
      } else {
        resolve({
          status: 'active',
          is_mock: true
        });
      }
      return;
    }

    const options = {
      hostname: 'api.razorpay.com',
      port: 443,
      path: `/v1/payments?qr_code_id=${qrCodeId}`,
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(keyId + ':' + keySecret).toString('base64')
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const payments = parsed.items || [];
            const captured = payments.find(p => p.status === 'captured');
            if (captured) {
              resolve({
                status: 'closed',
                payment_id: captured.id,
                method: captured.method,
                amount: captured.amount / 100,
                is_mock: false
              });
            } else {
              resolve({
                status: 'active',
                is_mock: false
              });
            }
          } else {
            reject(new Error(parsed.error ? parsed.error.description : 'Failed to fetch payments for QR Code'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.end();
  });
}

// UPI QR Code generation endpoint
app.post('/api/pos/upi/create-qr', authenticateToken, async (req, res) => {
  const { amount, invoice_number } = req.body;
  if (!amount || isNaN(parseFloat(amount))) {
    return res.status(400).json({ message: 'Valid payment amount is required' });
  }

  try {
    const qrData = await createRazorpayQrCode(parseFloat(amount), invoice_number);
    res.json(qrData);
  } catch (err) {
    console.error('Error creating UPI QR Code:', err);
    res.status(500).json({ message: 'Failed to create UPI QR Code', error: err.message });
  }
});

// UPI Payment Status polling endpoint
app.get('/api/pos/upi/status/:qr_code_id', authenticateToken, async (req, res) => {
  const { qr_code_id } = req.params;
  try {
    const statusData = await checkRazorpayQrCodeStatus(qr_code_id);
    res.json(statusData);
  } catch (err) {
    console.error('Error checking UPI Payment status:', err);
    res.status(500).json({ message: 'Failed to check payment status', error: err.message });
  }
});

// UPI Mock payment success simulator
app.post('/api/pos/upi/simulate-success/:qr_code_id', authenticateToken, async (req, res) => {
  const { qr_code_id } = req.params;
  const mockPaymentId = `pay_mock_${Date.now()}`;
  mockQrPayments.set(qr_code_id, {
    payment_id: mockPaymentId,
    amount: 0,
    status: 'captured'
  });
  res.json({ message: 'Mock payment success simulated', payment_id: mockPaymentId });
});


// UPI Transaction statistics endpoint
app.get('/api/pos/upi/stats', authenticateToken, async (req, res) => {
  try {
    const stats = await db.getOne(`
      SELECT 
        COUNT(*) as total_count,
        SUM(total) as total_amount,
        SUM(CASE WHEN payment_status = 'Success' OR payment_status IS NULL THEN total ELSE 0 END) as success_amount,
        SUM(CASE WHEN payment_status = 'Success' OR payment_status IS NULL THEN 1 ELSE 0 END) as success_count
      FROM sales
      WHERE payment_method = 'UPI'
    `);

    const totalCount = stats ? parseInt(stats.total_count) || 0 : 0;
    const totalAmount = stats ? parseFloat(stats.total_amount) || 0 : 0;
    const successCount = stats ? parseInt(stats.success_count) || 0 : 0;
    const successAmount = stats ? parseFloat(stats.success_amount) || 0 : 0;

    const successRate = totalCount > 0 ? parseFloat(((successCount / totalCount) * 100).toFixed(1)) : 100;

    res.json({
      total_count: totalCount,
      total_amount: totalAmount,
      success_count: successCount,
      success_amount: successAmount,
      success_rate: successRate
    });
  } catch (err) {
    console.error('Error fetching UPI stats:', err);
    res.status(500).json({ message: 'Error fetching UPI stats', error: err.message });
  }
});

// POS Checkout
app.post('/api/pos/checkout', authenticateToken, async (req, res) => {
  const { customer_id, items, discount, payment_method, branch_id, invoice_type, mobile_number, razorpay_payment_id, razorpay_qr_id, payment_status, redeem_points, coupon_code } = req.body;
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
      const prod = await db.getOne("SELECT id, name, sku, sale_price, cost_price, gst_rate, unit, category_id FROM products WHERE id = $1", [item.product_id]);
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
          gst_rate: prod.gst_rate,
          category_id: prod.category_id
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

    const baseDiscount = parseFloat(discount || 0);

    // Fetch active promotions for calculations
    const today = new Date().toISOString().split('T')[0];
    const activePromos = await db.query(
      "SELECT * FROM promotions WHERE active = 1 AND start_date <= $1 AND end_date >= $2",
      [today, today]
    );

    // BOGO and Category Promotion Calculations
    let promoDiscountValue = 0;
    for (const item of itemDetails) {
      // Find BOGO promotion
      const bogoPromo = activePromos.find(
        p => p.promo_type === 'BOGO' && p.buy_product_id === item.product_id
      );
      if (bogoPromo) {
        const getProdId = bogoPromo.get_product_id || bogoPromo.buy_product_id;
        const matchingItem = itemDetails.find(i => i.product_id === getProdId);
        if (matchingItem) {
          const buyQty = item.quantity;
          const freeQty = Math.floor(buyQty / 2);
          if (freeQty > 0) {
            const getProd = await db.getOne("SELECT sale_price FROM products WHERE id = $1", [getProdId]);
            if (getProd) {
              promoDiscountValue += freeQty * parseFloat(getProd.sale_price);
            }
          }
        }
      }

      // Find Category promotion
      const catPromo = activePromos.find(
        p => p.promo_type === 'Category' && p.category_id === item.category_id
      );
      if (catPromo) {
        const discountPct = parseFloat(catPromo.discount_pct || 0);
        promoDiscountValue += (item.quantity * item.unit_price) * (discountPct / 100);
      }
    }
    promoDiscountValue = parseFloat(promoDiscountValue.toFixed(2));

    // Loyalty Tier Discount Calculation
    let tierDiscountValue = 0;
    let loyaltyTier = 'Silver';
    let defaultDiscountPct = 2;

    if (customer_id) {
      const oneYearAgo = new Date();
      oneYearAgo.setDate(oneYearAgo.getDate() - 365);
      const oneYearAgoStr = oneYearAgo.toISOString().split('T')[0];

      const spendRes = await db.getOne(
        `SELECT COALESCE(SUM(total), 0) as annual_spend 
         FROM sales 
         WHERE customer_id = $1 AND created_at >= $2 AND payment_status = 'Success'`,
        [customer_id, oneYearAgoStr]
      );
      const annualSpend = parseFloat(spendRes ? spendRes.annual_spend : 0);
      if (annualSpend >= 50000) {
        loyaltyTier = 'Platinum';
        defaultDiscountPct = 10;
      } else if (annualSpend >= 10000) {
        loyaltyTier = 'Gold';
        defaultDiscountPct = 5;
      }

      tierDiscountValue = parseFloat((subtotal * (defaultDiscountPct / 100.0)).toFixed(2));
    }

    // Coupon Code Validation and Discount Calculation
    let couponDiscountValue = 0;
    let appliedCouponCode = null;
    if (coupon_code) {
      const couponPromo = activePromos.find(
        p => p.promo_type === 'Coupon' && p.code.toUpperCase() === coupon_code.toUpperCase().trim()
      );
      if (couponPromo) {
        appliedCouponCode = couponPromo.code;
        const discountPct = parseFloat(couponPromo.discount_pct || 0);
        const remainingSubtotal = Math.max(0, subtotal - tierDiscountValue - promoDiscountValue);
        couponDiscountValue = parseFloat((remainingSubtotal * (discountPct / 100.0)).toFixed(2));
      } else {
        return res.status(400).json({ message: 'Invalid or expired coupon code.' });
      }
    }

    // Loyalty Point Redemption calculation
    let parsedRedeemPoints = 0;
    let loyaltyDiscountValue = 0;

    if (customer_id && redeem_points) {
      const parsedPoints = parseInt(redeem_points, 10);
      if (parsedPoints > 0) {
        const customer = await db.getOne("SELECT loyalty_points FROM customers WHERE id = $1", [customer_id]);
        if (customer && customer.loyalty_points >= parsedPoints) {
          parsedRedeemPoints = parsedPoints;
          loyaltyDiscountValue = parseFloat((parsedPoints * 1.00).toFixed(2));
        } else {
          return res.status(400).json({ message: 'Insufficient loyalty points balance.' });
        }
      }
    }

    const totalDiscountApplied = baseDiscount + loyaltyDiscountValue + tierDiscountValue + promoDiscountValue + couponDiscountValue;
    const finalDiscount = parseFloat(Math.min(subtotal, totalDiscountApplied).toFixed(2));

    // Dynamic GST calculation with proportionate discount distribution
    let taxAmount = 0;
    if (subtotal > 0) {
      for (const itemEntry of itemsList) {
        const itemDiscount = finalDiscount * (itemEntry.itemSubtotal / subtotal);
        const itemDiscountedSubtotal = Math.max(0, itemEntry.itemSubtotal - itemDiscount);
        const itemTax = itemDiscountedSubtotal * (itemEntry.gstRate / 100);
        taxAmount += itemTax;
      }
    }
    taxAmount = parseFloat(taxAmount.toFixed(2));
    const totalAmount = parseFloat((Math.max(0, subtotal - finalDiscount) + taxAmount).toFixed(2));

    // Accounts Receivable / Credit Validation
    if (payment_method === 'Credit') {
      if (!customer_id) {
        return res.status(400).json({ message: 'A registered loyalty customer is required for Credit payments.' });
      }
      const customer = await db.getOne("SELECT credit_limit, outstanding_payment FROM customers WHERE id = $1", [customer_id]);
      if (!customer) {
        return res.status(400).json({ message: 'Customer record not found.' });
      }
      const currentOutstanding = parseFloat(customer.outstanding_payment || 0);
      const limit = parseFloat(customer.credit_limit || 10000.00);
      if (currentOutstanding + totalAmount > limit) {
        return res.status(400).json({
          message: `Credit Limit Exceeded. Allowed Limit: ₹${limit.toFixed(2)}, Current Outstanding: ₹${currentOutstanding.toFixed(2)}, This Invoice: ₹${totalAmount.toFixed(2)}`
        });
      }
    }

    // 2. Generate unique Invoice Number
    const invNo = `INV-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

    // 3. Create Sale record
    const rpPaymentId = razorpay_payment_id || null;
    const rpQrId = razorpay_qr_id || null;
    const payStatus = payment_status || (payment_method === 'UPI' ? 'Pending' : (payment_method === 'Credit' ? 'Success' : 'Success'));

    const saleResult = await db.execute(
      `INSERT INTO sales (invoice_number, branch_id, customer_id, cashier_id, subtotal, discount, tax, total, payment_method, razorpay_payment_id, razorpay_qr_id, payment_status, loyalty_points_redeemed, loyalty_discount, tier_discount, promo_discount, coupon_discount, coupon_code) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        invNo,
        branchId,
        customer_id || null,
        req.user.id,
        subtotal,
        baseDiscount,
        taxAmount,
        totalAmount,
        payment_method,
        rpPaymentId,
        rpQrId,
        payStatus,
        parsedRedeemPoints,
        loyaltyDiscountValue,
        tierDiscountValue,
        promoDiscountValue,
        couponDiscountValue,
        appliedCouponCode
      ]
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

      // Update customer record: Add points earned, subtract points redeemed, set preferred invoice type
      // Also update outstanding payment if using Credit payment method
      const netPointsDiff = addedPoints - parsedRedeemPoints;

      if (payment_method === 'Credit') {
        await db.execute(
          "UPDATE customers SET loyalty_points = loyalty_points + $1, preferred_invoice_type = $2, outstanding_payment = outstanding_payment + $3 WHERE id = $4",
          [netPointsDiff, invoiceType, totalAmount, customer_id]
        );
      } else {
        await db.execute(
          "UPDATE customers SET loyalty_points = loyalty_points + $1, preferred_invoice_type = $2 WHERE id = $3",
          [netPointsDiff, invoiceType, customer_id]
        );
      }

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
      discount: baseDiscount,
      loyalty_discount: loyaltyDiscountValue,
      tier_discount: tierDiscountValue,
      promo_discount: promoDiscountValue,
      coupon_discount: couponDiscountValue,
      coupon_code: appliedCouponCode,
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
    const oneYearAgo = new Date();
    oneYearAgo.setDate(oneYearAgo.getDate() - 365);
    const oneYearAgoStr = oneYearAgo.toISOString().split('T')[0];

    const list = await db.query(
      `SELECT c.*, 
          COALESCE(
            (SELECT SUM(s.total) 
             FROM sales s 
             WHERE s.customer_id = c.id 
               AND s.created_at >= $1 
               AND s.payment_status = 'Success'
            ), 0
          ) as annual_spend
        FROM customers c 
        ORDER BY name ASC`,
      [oneYearAgoStr]
    );

    const enriched = list.map(c => {
      const spend = parseFloat(c.annual_spend || 0);
      let tier = 'Silver';
      let discountPct = 2;
      if (spend >= 50000) {
        tier = 'Platinum';
        discountPct = 10;
      } else if (spend >= 10000) {
        tier = 'Gold';
        discountPct = 5;
      }
      return {
        ...c,
        loyalty_tier: tier,
        default_discount_pct: discountPct
      };
    });

    res.json(enriched);
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

// --- MODULE: PROMOTIONS & MARKETING ENGINE ---

// List Promotions
app.get('/api/promotions', authenticateToken, async (req, res) => {
  const { active } = req.query;
  try {
    let sql = `
      SELECT p.*, pr.name as buy_product_name, pr2.name as get_product_name, c.name as category_name 
      FROM promotions p 
      LEFT JOIN products pr ON p.buy_product_id = pr.id 
      LEFT JOIN products pr2 ON p.get_product_id = pr2.id 
      LEFT JOIN categories c ON p.category_id = c.id`;
    const params = [];
    if (active === '1') {
      sql += " WHERE p.active = 1 AND p.start_date <= $1 AND p.end_date >= $2";
      const today = new Date().toISOString().split('T')[0];
      params.push(today, today);
    }
    sql += " ORDER BY p.id DESC";
    const list = await db.query(sql, params);
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Fetch promotions error', error: err.message });
  }
});

// Create Promotion
app.post('/api/promotions', authenticateToken, requireRoles('Admin', 'Manager'), async (req, res) => {
  const { name, promo_type, code, discount_pct, category_id, buy_product_id, get_product_id, start_date, end_date } = req.body;
  if (!name || !promo_type || !start_date || !end_date) {
    return res.status(400).json({ message: 'Name, Type, Start Date, and End Date are required' });
  }
  try {
    await db.execute(
      `INSERT INTO promotions (name, promo_type, code, discount_pct, category_id, buy_product_id, get_product_id, start_date, end_date, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)`,
      [
        name,
        promo_type,
        code ? code.toUpperCase().trim() : null,
        discount_pct ? parseFloat(discount_pct) : 0,
        category_id ? parseInt(category_id) : null,
        buy_product_id ? parseInt(buy_product_id) : null,
        get_product_id ? parseInt(get_product_id) : null,
        start_date,
        end_date
      ]
    );
    res.status(201).json({ message: 'Promotion created successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Create promotion error', error: err.message });
  }
});

// Update Promotion
app.put('/api/promotions/:id', authenticateToken, requireRoles('Admin', 'Manager'), async (req, res) => {
  const { id } = req.params;
  const { active, name, discount_pct, start_date, end_date } = req.body;
  try {
    const promo = await db.getOne("SELECT * FROM promotions WHERE id = $1", [id]);
    if (!promo) {
      return res.status(404).json({ message: 'Promotion not found' });
    }

    let sql = "UPDATE promotions SET created_at = created_at"; // dummy updates
    const params = [];
    let paramIndex = 1;

    if (active !== undefined) {
      sql += `, active = $${paramIndex}`;
      params.push(parseInt(active));
      paramIndex++;
    }
    if (name !== undefined) {
      sql += `, name = $${paramIndex}`;
      params.push(name);
      paramIndex++;
    }
    if (discount_pct !== undefined) {
      sql += `, discount_pct = $${paramIndex}`;
      params.push(parseFloat(discount_pct));
      paramIndex++;
    }
    if (start_date !== undefined) {
      sql += `, start_date = $${paramIndex}`;
      params.push(start_date);
      paramIndex++;
    }
    if (end_date !== undefined) {
      sql += `, end_date = $${paramIndex}`;
      params.push(end_date);
      paramIndex++;
    }

    sql += ` WHERE id = $${paramIndex}`;
    params.push(id);

    await db.execute(sql, params);
    res.json({ message: 'Promotion updated successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Update promotion error', error: err.message });
  }
});

// Delete Promotion
app.delete('/api/promotions/:id', authenticateToken, requireRoles('Admin', 'Manager'), async (req, res) => {
  const { id } = req.params;
  try {
    await db.execute("DELETE FROM promotions WHERE id = $1", [id]);
    res.json({ message: 'Promotion deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Delete promotion error', error: err.message });
  }
});

// Validate Coupon Code
app.post('/api/pos/validate-coupon', authenticateToken, async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ message: 'Coupon code is required' });
  }
  try {
    const today = new Date().toISOString().split('T')[0];
    const promo = await db.getOne(
      "SELECT * FROM promotions WHERE promo_type = 'Coupon' AND active = 1 AND UPPER(code) = $1 AND start_date <= $2 AND end_date >= $3",
      [code.toUpperCase().trim(), today, today]
    );
    if (!promo) {
      return res.status(404).json({ message: 'Invalid or expired coupon code.' });
    }
    res.json({
      name: promo.name,
      code: promo.code,
      discount_pct: promo.discount_pct
    });
  } catch (err) {
    res.status(500).json({ message: 'Validate coupon error', error: err.message });
  }
});


// Customer repayments: Record repayment made by a customer
app.post('/api/customers/:id/payments', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { amount, payment_mode, transaction_ref } = req.body;

  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return res.status(400).json({ message: 'Valid payment amount is required' });
  }
  if (!payment_mode) {
    return res.status(400).json({ message: 'Payment mode is required' });
  }

  try {
    const customer = await db.getOne("SELECT * FROM customers WHERE id = $1", [id]);
    if (!customer) {
      return res.status(404).json({ message: 'Customer record not found' });
    }

    const payAmt = parseFloat(amount);

    // Insert into customer_payments ledger
    await db.execute(
      "INSERT INTO customer_payments (customer_id, amount, payment_mode, transaction_ref) VALUES ($1, $2, $3, $4)",
      [id, payAmt, payment_mode, transaction_ref || '']
    );

    // Update customer's outstanding payment
    await db.execute(
      "UPDATE customers SET outstanding_payment = MAX(0, outstanding_payment - $1) WHERE id = $2",
      [payAmt, id]
    );

    await logActivity(req.user.id, 'Customer Payment', `Recorded repayment of ₹${payAmt} for Customer: ${customer.name} (ID: ${id})`);
    res.json({ message: 'Customer payment recorded successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Error recording customer payment', error: err.message });
  }
});

// Fetch customer payments history
app.get('/api/customers/:id/payments', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const list = await db.query(
      "SELECT * FROM customer_payments WHERE customer_id = $1 ORDER BY id DESC LIMIT 50",
      [id]
    );
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching customer payment history', error: err.message });
  }
});

// Fetch customer sales (purchase) history with items
app.get('/api/customers/:id/sales', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const sales = await db.query(
      `SELECT s.id, s.invoice_number, s.total, s.subtotal, s.discount, s.tax, s.payment_method, s.payment_status, s.created_at, b.name as branch_name
       FROM sales s
       JOIN branches b ON s.branch_id = b.id
       WHERE s.customer_id = $1
       ORDER BY s.id DESC`,
      [id]
    );

    const salesWithItems = [];
    for (const sale of sales) {
      const items = await db.query(
        `SELECT si.quantity, si.unit_price, si.subtotal, p.name as product_name, p.sku, p.unit
         FROM sale_items si
         JOIN products p ON si.product_id = p.id
         WHERE si.sale_id = $1`,
        [sale.id]
      );
      salesWithItems.push({
        ...sale,
        items
      });
    }

    res.json(salesWithItems);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching customer purchase history', error: err.message });
  }
});

// Supplier debt settlement: Record payment made to a supplier
app.post('/api/suppliers/:id/payments', authenticateToken, requireRoles('Admin', 'Manager'), async (req, res) => {
  const { id } = req.params;
  const { amount, payment_mode, transaction_ref } = req.body;

  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return res.status(400).json({ message: 'Valid payment amount is required' });
  }
  if (!payment_mode) {
    return res.status(400).json({ message: 'Payment mode is required' });
  }

  try {
    const supplier = await db.getOne("SELECT * FROM suppliers WHERE id = $1", [id]);
    if (!supplier) {
      return res.status(404).json({ message: 'Supplier record not found' });
    }

    const payAmt = parseFloat(amount);

    // Insert into supplier_payments ledger
    await db.execute(
      "INSERT INTO supplier_payments (supplier_id, amount, payment_mode, transaction_ref) VALUES ($1, $2, $3, $4)",
      [id, payAmt, payment_mode, transaction_ref || '']
    );

    // Update supplier's outstanding balance
    await db.execute(
      "UPDATE suppliers SET outstanding_balance = MAX(0, outstanding_balance - $1) WHERE id = $2",
      [payAmt, id]
    );

    await logActivity(req.user.id, 'Supplier Payment', `Recorded debt payment of ₹${payAmt} to Supplier: ${supplier.name} (ID: ${id})`);
    res.json({ message: 'Supplier payment recorded successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Error recording supplier payment', error: err.message });
  }
});

// Fetch supplier payments history
app.get('/api/suppliers/:id/payments', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const list = await db.query(
      "SELECT * FROM supplier_payments WHERE supplier_id = $1 ORDER BY id DESC LIMIT 50",
      [id]
    );
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching supplier payment history', error: err.message });
  }
});

// Low-Stock Auto PO Generator
app.post('/api/purchase-orders/auto-generate', authenticateToken, requireRoles('Admin', 'Manager'), async (req, res) => {
  try {
    // 1. Scan and find all items that fall below reorder level
    const lowStockItems = await db.query(
      `SELECT i.product_id, i.branch_id, SUM(i.quantity) as current_qty, i.reorder_level, p.supplier_id, p.cost_price, p.name as product_name
       FROM inventory i
       JOIN products p ON i.product_id = p.id
       WHERE p.supplier_id IS NOT NULL
       GROUP BY i.product_id, i.branch_id, i.reorder_level, p.supplier_id, p.cost_price, p.name
       HAVING SUM(i.quantity) < i.reorder_level`
    );

    if (lowStockItems.length === 0) {
      return res.json({ success: true, count: 0, message: 'All items are sufficiently stocked. No POs generated.' });
    }

    // 2. Group items by (supplier_id, branch_id)
    const grouped = {};
    for (const item of lowStockItems) {
      const key = `${item.supplier_id}_${item.branch_id}`;
      if (!grouped[key]) {
        grouped[key] = {
          supplier_id: item.supplier_id,
          branch_id: item.branch_id,
          items: []
        };
      }
      // Fill to reorder_level * 3 as target stock level
      const targetStock = item.reorder_level * 3;
      const orderQty = Math.ceil(targetStock - item.current_qty);
      if (orderQty > 0) {
        grouped[key].items.push({
          product_id: item.product_id,
          quantity: orderQty,
          cost_price: item.cost_price,
          product_name: item.product_name
        });
      }
    }

    let poCount = 0;
    // 3. Create Draft POs
    for (const key in grouped) {
      const group = grouped[key];
      if (group.items.length === 0) continue;

      let totalCost = 0;
      for (const item of group.items) {
        totalCost += item.cost_price * item.quantity;
      }

      const poNumber = `AUTO-PO-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`;

      const poRes = await db.execute(
        "INSERT INTO purchase_orders (po_number, supplier_id, branch_id, status, total_cost) VALUES ($1, $2, $3, 'Draft', $4)",
        [poNumber, group.supplier_id, group.branch_id, totalCost]
      );

      const purchaseId = poRes.insertId || (await db.getOne("SELECT id FROM purchase_orders WHERE po_number = $1", [poNumber])).id;

      for (const item of group.items) {
        await db.execute(
          "INSERT INTO purchase_items (purchase_id, product_id, quantity, cost_price) VALUES ($1, $2, $3, $4)",
          [purchaseId, item.product_id, item.quantity, item.cost_price]
        );
      }

      await logActivity(req.user.id, 'Auto PO Generator', `Auto-generated Draft PO: ${poNumber} for Supplier ID: ${group.supplier_id} (Total: ₹${totalCost})`);
      poCount++;
    }

    res.json({ success: true, count: poCount, message: `Successfully auto-generated ${poCount} draft purchase orders.` });
  } catch (err) {
    res.status(500).json({ message: 'Auto-generation PO failure', error: err.message });
  }
});

// Batch Expiry Markdown
app.post('/api/inventory/markdown', authenticateToken, requireRoles('Admin', 'Manager'), async (req, res) => {
  const { months_threshold, discount_percentage } = req.body;
  const months = months_threshold ? parseInt(months_threshold, 10) : 3;
  const pct = discount_percentage ? parseFloat(discount_percentage) : 20.0;

  if (months <= 0 || pct <= 0 || pct >= 100) {
    return res.status(400).json({ message: 'Valid months threshold (>0) and discount percentage (0-100) are required' });
  }

  try {
    const isSQLite = db.dbType === 'sqlite';
    const targetDate = new Date(Date.now() + months * 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const currentDate = new Date().toISOString().split('T')[0];

    // Find all products in inventory expiring within threshold
    const expiringItems = await db.query(
      `SELECT DISTINCT i.product_id, p.name, p.sale_price, p.sku
       FROM inventory i
       JOIN products p ON i.product_id = p.id
       WHERE i.expiry_date IS NOT NULL 
         AND i.expiry_date <= $1 
         AND i.expiry_date >= $2
         AND i.quantity > 0`,
      [targetDate, currentDate]
    );

    if (expiringItems.length === 0) {
      return res.json({ success: true, count: 0, message: 'No expiring stock batches found within threshold. No markdowns applied.' });
    }

    const markdownAmtRatio = (100 - pct) / 100;
    let updateCount = 0;

    for (const item of expiringItems) {
      const originalPrice = parseFloat(item.sale_price);
      const newPrice = parseFloat((originalPrice * markdownAmtRatio).toFixed(2));

      await db.execute(
        "UPDATE products SET sale_price = $1 WHERE id = $2",
        [newPrice, item.product_id]
      );

      await logActivity(req.user.id, 'Markdown Expiry', `Marked down soon-expiring Product '${item.name}' (SKU: ${item.sku}) from ₹${originalPrice} to ₹${newPrice} (${pct}% off)`);
      updateCount++;
    }

    res.json({ success: true, count: updateCount, message: `Successfully marked down ${updateCount} expiring products by ${pct}%.` });
  } catch (err) {
    res.status(500).json({ message: 'Markdown application failure', error: err.message });
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

// GST Tax Report: Compile aggregates grouped by HSN and Tax Slabs
app.get('/api/reports/gst', authenticateToken, async (req, res) => {
  const { start_date, end_date, branch_id } = req.query;
  try {
    let queryStr = `
      SELECT 
        p.hsn_code,
        p.gst_rate,
        SUM(si.quantity) as total_quantity,
        SUM(si.subtotal) as gross_amount,
        SUM(si.subtotal * (1.0 - COALESCE(CAST(s.discount AS REAL) / NULLIF(CAST(s.subtotal AS REAL), 0.0), 0.0))) as taxable_value
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      JOIN sales s ON si.sale_id = s.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (start_date) {
      queryStr += ` AND s.created_at >= $${paramIndex}`;
      params.push(start_date);
      paramIndex++;
    }
    if (end_date) {
      queryStr += ` AND s.created_at <= $${paramIndex}`;
      params.push(end_date);
      paramIndex++;
    }
    if (branch_id) {
      queryStr += ` AND s.branch_id = $${paramIndex}`;
      params.push(branch_id);
      paramIndex++;
    }

    queryStr += ` GROUP BY p.hsn_code, p.gst_rate ORDER BY p.hsn_code ASC`;

    const rows = await db.query(queryStr, params);

    const reports = rows.map(r => {
      const taxable = parseFloat(r.taxable_value || 0);
      const rate = parseFloat(r.gst_rate || 0);
      const tax = parseFloat((taxable * (rate / 100)).toFixed(2));
      const cgst = parseFloat((tax / 2).toFixed(2));
      const sgst = parseFloat((tax / 2).toFixed(2));

      return {
        hsn_code: r.hsn_code || 'HSN-9988',
        gst_rate: rate,
        total_quantity: parseFloat(r.total_quantity || 0),
        gross_amount: parseFloat(r.gross_amount || 0),
        taxable_value: parseFloat(taxable.toFixed(2)),
        cgst: cgst,
        sgst: sgst,
        igst: 0.00,
        total_gst: tax
      };
    });

    res.json(reports);
  } catch (err) {
    res.status(500).json({ message: 'Error compiling GST tax report', error: err.message });
  }
});

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
