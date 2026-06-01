const db = require('./db');

async function test() {
  try {
    const sales = await db.query("SELECT branch_id, COUNT(*) as count, SUM(total) as revenue FROM sales GROUP BY branch_id");
    console.log("Sales distribution by branch:", sales);
    
    const totalSales = await db.query("SELECT COUNT(*) as count FROM sales");
    console.log("Total sales in database:", totalSales[0].count);
  } catch (err) {
    console.error("Database query failed:", err.message);
  }
}

test();
