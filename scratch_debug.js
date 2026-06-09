const db = require('./db');

async function checkDatabase() {
  try {
    const columns = await db.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'sales'"
    );
    console.log("=== Sales Table Columns ===");
    columns.forEach(c => {
      if (['tier_discount', 'promo_discount', 'coupon_discount', 'coupon_code'].includes(c.column_name)) {
        console.log(`Column: ${c.column_name} (${c.data_type})`);
      }
    });

    const promos = await db.query("SELECT * FROM promotions LIMIT 5");
    console.log("=== Active/Existing Promotions ===");
    console.log(promos);

    const tables = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
    );
    console.log("=== Promotions Table Exists? ===");
    console.log(tables.map(t => t.table_name).includes('promotions') ? 'Yes' : 'No');
  } catch (err) {
    console.error("Failed:", err.message);
  }
}

checkDatabase();
