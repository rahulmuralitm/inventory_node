const bcrypt = require('bcryptjs');
const db = require('./db');

async function seed() {
  console.log('Starting database seeding...');
  
  // Ensure tables exist
  await db.initDb();

  // Clear existing tables to ensure a clean slate
  const tables = [
    'users', 'branches', 'categories', 'suppliers', 'products', 
    'inventory', 'stock_movements', 'customers', 'sales', 
    'sale_items', 'purchase_orders', 'purchase_items', 'audit_logs'
  ];
  
  for (const table of tables) {
    try {
      await db.execute(`DELETE FROM ${table}`);
    } catch (e) {
      console.log(`Table ${table} was empty or does not exist yet.`);
    }
  }

  // Reset sqlite autoincrement sequences if possible
  if (db.dbType === 'sqlite') {
    try {
      await db.execute("DELETE FROM sqlite_sequence");
    } catch (e) {}
  }

  console.log('Database tables cleared.');

  // 1. Seed Branches
  console.log('Seeding branches...');
  await db.execute(
    "INSERT INTO branches (name, code, address, phone, tax_number) VALUES ($1, $2, $3, $4, $5)",
    ["Central Warehouse", "BR-CWH", "100 Logistics Blvd, Warehouse District", "+1-555-0100", "TAX-US-99901"]
  );
  await db.execute(
    "INSERT INTO branches (name, code, address, phone, tax_number) VALUES ($1, $2, $3, $4, $5)",
    ["Uptown Supermarket", "BR-UPS", "450 Fashion Ave, Uptown Galleria", "+1-555-0101", "TAX-US-99902"]
  );
  await db.execute(
    "INSERT INTO branches (name, code, address, phone, tax_number) VALUES ($1, $2, $3, $4, $5)",
    ["Downtown Retail Store", "BR-DTR", "12 Main St, Downtown Hub", "+1-555-0102", "TAX-US-99903"]
  );

  const branches = await db.query("SELECT * FROM branches");
  const cwhId = branches.find(b => b.code === 'BR-CWH').id;
  const upsId = branches.find(b => b.code === 'BR-UPS').id;
  const dtrId = branches.find(b => b.code === 'BR-DTR').id;

  // 2. Seed Users
  console.log('Seeding users...');
  const salt = bcrypt.genSaltSync(10);
  const adminHash = bcrypt.hashSync('admin123', salt);
  const managerHash = bcrypt.hashSync('manager123', salt);
  const cashierHash = bcrypt.hashSync('cashier123', salt);
  const warehouseHash = bcrypt.hashSync('warehouse123', salt);

  await db.execute(
    "INSERT INTO users (username, password_hash, email, role, branch_id) VALUES ($1, $2, $3, $4, $5)",
    ["admin", adminHash, "admin@inventory.com", "Admin", cwhId]
  );
  await db.execute(
    "INSERT INTO users (username, password_hash, email, role, branch_id) VALUES ($1, $2, $3, $4, $5)",
    ["manager", managerHash, "manager@inventory.com", "Manager", upsId]
  );
  await db.execute(
    "INSERT INTO users (username, password_hash, email, role, branch_id) VALUES ($1, $2, $3, $4, $5)",
    ["cashier", cashierHash, "cashier@inventory.com", "Cashier", dtrId]
  );
  await db.execute(
    "INSERT INTO users (username, password_hash, email, role, branch_id) VALUES ($1, $2, $3, $4, $5)",
    ["warehouse", warehouseHash, "warehouse@inventory.com", "Warehouse Staff", cwhId]
  );

  const users = await db.query("SELECT * FROM users");

  // 3. Seed Categories
  console.log('Seeding categories...');
  await db.execute("INSERT INTO categories (name, parent_category) VALUES ($1, $2)", ["Electronics", null]);
  await db.execute("INSERT INTO categories (name, parent_category) VALUES ($1, $2)", ["Groceries", null]);
  await db.execute("INSERT INTO categories (name, parent_category) VALUES ($1, $2)", ["Pharmaceuticals", null]);
  await db.execute("INSERT INTO categories (name, parent_category) VALUES ($1, $2)", ["Apparel", null]);
  
  const categories = await db.query("SELECT * FROM categories");
  const elecId = categories.find(c => c.name === 'Electronics').id;
  const grocId = categories.find(c => c.name === 'Groceries').id;
  const pharmId = categories.find(c => c.name === 'Pharmaceuticals').id;
  const appId = categories.find(c => c.name === 'Apparel').id;

  // 4. Seed Suppliers
  console.log('Seeding suppliers...');
  await db.execute(
    "INSERT INTO suppliers (name, contact_name, phone, email, tax_id, outstanding_balance) VALUES ($1, $2, $3, $4, $5, $6)",
    ["Acme Wholesale Corp", "John Miller", "+1-555-8881", "sales@acmewholesale.com", "TX-ACME-11", 45000.00]
  );
  await db.execute(
    "INSERT INTO suppliers (name, contact_name, phone, email, tax_id, outstanding_balance) VALUES ($1, $2, $3, $4, $5, $6)",
    ["MedLife Pharmaceuticals", "Dr. Sarah Lin", "+1-555-8882", "orders@medlife.com", "TX-MEDL-22", 0.00]
  );
  await db.execute(
    "INSERT INTO suppliers (name, contact_name, phone, email, tax_id, outstanding_balance) VALUES ($1, $2, $3, $4, $5, $6)",
    ["Apex Tech Distributors", "Robert Chen", "+1-555-8883", "apextech@apex.com", "TX-APEX-33", 125000.50]
  );

  const suppliers = await db.query("SELECT * FROM suppliers");
  const acmeId = suppliers.find(s => s.name === 'Acme Wholesale Corp').id;
  const medlifeId = suppliers.find(s => s.name === 'MedLife Pharmaceuticals').id;
  const apexId = suppliers.find(s => s.name === 'Apex Tech Distributors').id;

  // 5. Seed Customers
  console.log('Seeding customers...');
  await db.execute(
    "INSERT INTO customers (name, phone, email, loyalty_points, outstanding_payment) VALUES ($1, $2, $3, $4, $5)",
    ["Alice Johnson", "1234567890", "alice@gmail.com", 320, 0.00]
  );
  await db.execute(
    "INSERT INTO customers (name, phone, email, loyalty_points, outstanding_payment) VALUES ($1, $2, $3, $4, $5)",
    ["Bob Smith", "9876543210", "bob.smith@yahoo.com", 150, 500.00]
  );
  await db.execute(
    "INSERT INTO customers (name, phone, email, loyalty_points, outstanding_payment) VALUES ($1, $2, $3, $4, $5)",
    ["Charlie Davis", "5551234567", "charlie@outlook.com", 890, 2500.00]
  );

  const customers = await db.query("SELECT * FROM customers");
  const aliceId = customers.find(c => c.name === 'Alice Johnson').id;

  // 6. Seed Products
  console.log('Seeding products...');
  // Format: [name, sku, barcode, description, category_id, cost_price, sale_price, image_url, is_variant, parent_product_id, manage_expiry, supplier_id, unit, gst_rate]
  const prodData = [
    ["Wireless Mechanical Keyboard", "SKU-KBD-WRLS", "880123456789", "Premium rgb tactile wireless mechanical keyboard.", elecId, 2500.00, 5499.00, "assets/images/products/keyboard.jpg", 0, null, 0, apexId, "pc", 18.00],
    ["USB-C Fast Charger 65W", "SKU-CHG-65WC", "880123456790", "GaN technology ultra-fast travel charger.", elecId, 850.00, 1999.00, "assets/images/products/charger.jpg", 0, null, 0, apexId, "pc", 18.00],
    ["Organic Almond Milk 1L", "SKU-GOC-AM1L", "880123456791", "Sugar-free unsweetened organic almond milk.", grocId, 150.00, 299.00, "assets/images/products/almond_milk.jpg", 0, null, 1, acmeId, "pc", 5.00],
    ["Premium Arabica Coffee Beans 1kg", "SKU-GOC-CF1K", "880123456792", "Medium roast single origin organic Arabica beans.", grocId, 800.00, 1650.00, "assets/images/products/coffee.jpg", 0, null, 1, acmeId, "pc", 12.00],
    ["Paracetamol 500mg (100 Tabs)", "SKU-MED-PARA", "880123456793", "Analgesic and antipyretic pain reliever.", pharmId, 60.00, 150.00, "assets/images/products/paracetamol.jpg", 0, null, 1, medlifeId, "pc", 12.00],
    ["Vitamin C 1000mg Chewable", "SKU-MED-VITC", "880123456794", "Immune support antioxidant chewables (90 count).", pharmId, 180.00, 450.00, "assets/images/products/vit_c.jpg", 0, null, 1, medlifeId, "pc", 12.00],
    ["Cotton Crewneck T-Shirt Black (M)", "SKU-APL-TS-BLK-M", "880123456795", "100% organic cotton crewneck tee.", appId, 350.00, 899.00, "assets/images/products/tshirt.jpg", 1, null, 0, acmeId, "pc", 5.00],
    ["Cotton Crewneck T-Shirt Black (L)", "SKU-APL-TS-BLK-L", "880123456796", "100% organic cotton crewneck tee.", appId, 350.00, 899.00, "assets/images/products/tshirt.jpg", 1, null, 0, acmeId, "pc", 5.00],
    ["Organic Vine Tomatoes", "SKU-GOC-VMTM", "880123456797", "Fresh farm organic vine tomatoes.", grocId, 30.00, 60.00, "assets/images/products/tomatoes.jpg", 0, null, 1, acmeId, "kg", 0.00],
    ["Fresh Spinach Bunch", "SKU-GOC-SPNH", "880123456798", "Organic washed green spinach leaves.", grocId, 15.00, 30.00, "assets/images/products/spinach.jpg", 0, null, 1, acmeId, "kg", 0.00]
  ];

  for (const p of prodData) {
    await db.execute(
      `INSERT INTO products (name, sku, barcode, description, category_id, cost_price, sale_price, image_url, is_variant, parent_product_id, manage_expiry, supplier_id, unit, gst_rate) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      p
    );
  }

  const products = await db.query("SELECT * FROM products");
  const kbdId = products.find(p => p.sku === 'SKU-KBD-WRLS').id;
  const chgId = products.find(p => p.sku === 'SKU-CHG-65WC').id;
  const milkId = products.find(p => p.sku === 'SKU-GOC-AM1L').id;
  const coffeeId = products.find(p => p.sku === 'SKU-GOC-CF1K').id;
  const paraId = products.find(p => p.sku === 'SKU-MED-PARA').id;
  const vitcId = products.find(p => p.sku === 'SKU-MED-VITC').id;
  const tsMId = products.find(p => p.sku === 'SKU-APL-TS-BLK-M').id;
  const tsLId = products.find(p => p.sku === 'SKU-APL-TS-BLK-L').id;
  const tomatoId = products.find(p => p.sku === 'SKU-GOC-VMTM').id;
  const spinachId = products.find(p => p.sku === 'SKU-GOC-SPNH').id;

  // 7. Seed Inventory
  console.log('Seeding inventory levels...');
  // Format: [product_id, branch_id, quantity, reorder_level, batch_number, expiry_date, location_identifier]
  const today = new Date();
  
  // Date helpers
  const getFutureDate = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };

  const getPastDate = (days) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().split('T')[0];
  };

  const inventoryData = [
    // Central Warehouse (CWH) - High stock levels
    [kbdId, cwhId, 150, 20, "BAT-E101", null, "Aisle A-Shelf 4"],
    [chgId, cwhId, 300, 30, "BAT-E102", null, "Aisle A-Shelf 5"],
    [milkId, cwhId, 50, 40, "BAT-M909", getFutureDate(10), "Aisle B-Cold 1"], // Expiring in 10 days! LOW STOCK!
    [coffeeId, cwhId, 80, 15, "BAT-C202", getFutureDate(180), "Aisle B-Shelf 2"],
    [paraId, cwhId, 1200, 100, "BAT-P801", getFutureDate(365), "Aisle C-Shelf 1"],
    [vitcId, cwhId, 500, 50, "BAT-V702", getFutureDate(400), "Aisle C-Shelf 2"],
    [tsMId, cwhId, 100, 15, "BAT-A301", null, "Aisle D-Rack 3"],
    [tsLId, cwhId, 120, 15, "BAT-A302", null, "Aisle D-Rack 3"],
    [tomatoId, cwhId, 80.5, 10, "BAT-M911", null, "Aisle B-Cold 2"],
    [spinachId, cwhId, 45.0, 10, "BAT-M912", null, "Aisle B-Cold 2"],

    // Uptown Supermarket (UPS) - Medium stock levels (some out of stock / low stock)
    [kbdId, upsId, 12, 10, "BAT-E101", null, "Shelf E-2"],
    [chgId, upsId, 8, 15, "BAT-E102", null, "Shelf E-3"], // Low stock alert!
    [milkId, upsId, 0, 15, "BAT-M910", getFutureDate(15), "Cold Store 2"], // Out of stock alert!
    [coffeeId, upsId, 25, 10, "BAT-C202", getFutureDate(120), "Shelf G-1"],
    [paraId, upsId, 220, 50, "BAT-P802", getFutureDate(300), "Pharma Isle 1"],
    [vitcId, upsId, 8, 20, "BAT-V701", getPastDate(5), "Pharma Isle 2"], // Expired 5 days ago! Expiry notification!
    [tsMId, upsId, 20, 10, "BAT-A301", null, "Apparel Rack 1"],
    [tomatoId, upsId, 32.2, 10, "BAT-M911", null, "Produce Aisle 1"],
    [spinachId, upsId, 15.6, 5, "BAT-M912", null, "Produce Aisle 1"],

    // Downtown Retail Store (DTR)
    [kbdId, dtrId, 5, 5, "BAT-E101", null, "Sales Counter"],
    [chgId, dtrId, 18, 10, "BAT-E102", null, "Sales Counter"],
    [coffeeId, dtrId, 12, 5, "BAT-C202", getFutureDate(150), "Grocery Rack"],
    [paraId, dtrId, 95, 30, "BAT-P802", getFutureDate(280), "Pharma Drawer"],
    [tomatoId, dtrId, 15.4, 5, "BAT-M911", null, "Produce Corner"],
    [spinachId, dtrId, 8.8, 5, "BAT-M912", null, "Produce Corner"]
  ];

  for (const inv of inventoryData) {
    await db.execute(
      `INSERT INTO inventory (product_id, branch_id, quantity, reorder_level, batch_number, expiry_date, location_identifier)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      inv
    );
  }

  // 8. Seed Stock Movements (Initial logs)
  console.log('Seeding stock movement history...');
  await db.execute(
    `INSERT INTO stock_movements (product_id, from_branch_id, to_branch_id, quantity, movement_type, reference_no, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [kbdId, null, cwhId, 150, "Stock In", "REC-001", users[0].id]
  );
  await db.execute(
    `INSERT INTO stock_movements (product_id, from_branch_id, to_branch_id, quantity, movement_type, reference_no, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [kbdId, cwhId, upsId, 20, "Transfer", "TR-001", users[3].id]
  );

  // 9. Seed Historical Sales (For Charts & AI Sales Forecasting)
  // Let's create realistic monthly sales over the past 6 months to train the AI projection model.
  // We'll generate transactions scattered throughout the last 6 months (roughly Dec, Jan, Feb, Mar, Apr, May).
  console.log('Generating 6 months of historical transactions for forecasting...');
  
  const generateSalesForMonth = async (monthOffset, baselineSalesCount, multiplier = 1.0) => {
    const saleDate = new Date();
    saleDate.setDate(15); // Set to middle of month to avoid overflow roll-overs (e.g. Feb 30th)
    saleDate.setMonth(saleDate.getMonth() - monthOffset);
    
    for (let i = 0; i < baselineSalesCount; i++) {
      // Pick random day in that month
      const transactionDate = new Date(saleDate);
      transactionDate.setDate(Math.floor(Math.random() * 28) + 1);
      transactionDate.setHours(Math.floor(Math.random() * 10) + 9, Math.floor(Math.random() * 59));
      
      const invNo = `INV-${saleDate.getFullYear()}${(saleDate.getMonth()+1).toString().padStart(2, '0')}-${(i+100)}`;
      
      // Determine items in sale
      const items = [];
      const itemSelection = [
        { id: kbdId, price: 89.99, cost: 45.00, gst_rate: 18.00 },
        { id: chgId, price: 29.99, cost: 12.50, gst_rate: 18.00 },
        { id: coffeeId, price: 19.99, cost: 8.50, gst_rate: 12.00 },
        { id: paraId, price: 8.50, cost: 3.20, gst_rate: 12.00 }
      ];

      // Add 1 to 3 items
      const numItems = Math.floor(Math.random() * 3) + 1;
      let subtotal = 0;
      for (let k = 0; k < numItems; k++) {
        const prod = itemSelection[Math.floor(Math.random() * itemSelection.length)];
        // Prevent duplicates in same invoice
        if (items.find(item => item.product_id === prod.id)) continue;
        const qty = Math.floor(Math.random() * 2) + 1;
        const itemTotal = prod.price * qty;
        subtotal += itemTotal;
        items.push({
          product_id: prod.id,
          quantity: qty,
          unit_price: prod.price,
          subtotal: itemTotal
        });
      }

      const discount = Math.random() < 0.3 ? parseFloat((subtotal * 0.1).toFixed(2)) : 0;
      
      let tax = 0;
      if (subtotal > 0) {
        for (const item of items) {
          const itemDiscount = discount * (item.subtotal / subtotal);
          const itemDiscountedSubtotal = Math.max(0, item.subtotal - itemDiscount);
          const itemEntry = itemSelection.find(x => x.id === item.product_id);
          const itemTax = itemDiscountedSubtotal * (itemEntry.gst_rate / 100);
          tax += itemTax;
        }
      }
      tax = parseFloat(tax.toFixed(2));
      const total = parseFloat((subtotal - discount + tax).toFixed(2));
      const payMethod = ["Cash", "Card", "UPI", "Net Banking"][Math.floor(Math.random() * 4)];
      
      const createdDateStr = db.dbType === 'sqlite' 
        ? transactionDate.toISOString() 
        : transactionDate;

      // Insert Sale
      const res = await db.execute(
        `INSERT INTO sales (invoice_number, branch_id, customer_id, cashier_id, subtotal, discount, tax, total, payment_method, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [invNo, upsId, aliceId, users[2].id, subtotal, discount, tax, total, payMethod, createdDateStr]
      );
      
      const saleId = res.insertId || (await db.getOne("SELECT id FROM sales WHERE invoice_number = $1", [invNo])).id;

      // Insert Sale Items
      for (const item of items) {
        await db.execute(
          `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, subtotal)
           VALUES ($1, $2, $3, $4, $5)`,
          [saleId, item.product_id, item.quantity, item.unit_price, item.subtotal]
        );
      }
    }
  };

  // Generate an upward trending sales volume to show clear forecasting
  // Offset 5 (5 months ago): ~12 transactions
  // Offset 4: ~15 transactions
  // Offset 3: ~20 transactions
  // Offset 2: ~25 transactions
  // Offset 1: ~32 transactions
  // Current month (Offset 0): ~38 transactions
  await generateSalesForMonth(5, 12);
  await generateSalesForMonth(4, 15);
  await generateSalesForMonth(3, 20);
  await generateSalesForMonth(2, 25);
  await generateSalesForMonth(1, 32);
  await generateSalesForMonth(0, 38);

  console.log('Seeding completed successfully!');
  
  if (db.dbType === 'sqlite') {
    process.exit(0);
  }
}

seed().catch(err => {
  console.error('Seeding process encountered an error:', err);
  process.exit(1);
});
