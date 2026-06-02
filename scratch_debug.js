const db = require('./db');

async function checkDatabase() {
  try {
    const sales = await db.query("SELECT id, invoice_number, created_at FROM sales ORDER BY id DESC LIMIT 10");
    console.log("=== Latest Sales ===");
    console.log(sales);

    const history = await db.query("SELECT * FROM invoice_history ORDER BY id DESC LIMIT 10");
    console.log("=== Latest History ===");
    console.log(history);

    // Let's check columns and table existence
    const tableCheck = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
    );
    console.log("=== Tables in DB ===");
    console.log(tableCheck.map(t => t.table_name));
  } catch (err) {
    console.error("Failed:", err.message);
  }
}

checkDatabase();
