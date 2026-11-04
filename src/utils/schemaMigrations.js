import db from "../config/db.js";

let migrated = false;

export const ensureSchemaUpdated = async (executor = db) => {
  if (migrated) return;
  try {
    // 1. Modify sales payment_method enum to include 'CREDIT'
    try {
      await executor.query(`
        ALTER TABLE sales 
        MODIFY COLUMN payment_method ENUM('CASH','ONLINE','UPI','PART_PAYMENT','CREDIT') NULL DEFAULT 'CASH'
      `);
    } catch (e) {
      console.warn("Notice: payment_method enum update:", e.message);
    }

    // 2. Add amount_received, pending_amount, credit_status to sales
    const [salesCols] = await executor.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales'`
    );
    const sColNames = new Set(salesCols.map((c) => c.COLUMN_NAME));

    if (!sColNames.has("amount_received")) {
      await executor.query(
        "ALTER TABLE sales ADD COLUMN amount_received DECIMAL(10,2) NOT NULL DEFAULT 0.00"
      );
    }
    if (!sColNames.has("pending_amount")) {
      await executor.query(
        "ALTER TABLE sales ADD COLUMN pending_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00"
      );
    }
    if (!sColNames.has("credit_status")) {
      await executor.query(
        "ALTER TABLE sales ADD COLUMN credit_status ENUM('PENDING','PARTIAL','PAID') NOT NULL DEFAULT 'PENDING'"
      );
    }

    // Initialize pending_amount for any existing credit sales where pending_amount is 0 and status is PENDING
    await executor.query(`
      UPDATE sales 
      SET pending_amount = total_amount 
      WHERE payment_method = 'CREDIT' 
        AND pending_amount = 0 
        AND (credit_status IS NULL OR credit_status = 'PENDING')
    `);

    // 3. Create credit_sales_payments table
    await executor.query(`
      CREATE TABLE IF NOT EXISTS credit_sales_payments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        agency_id INT NOT NULL,
        sale_id INT NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        payment_method ENUM('CASH','UPI','BANK_TRANSFER','CHEQUE') NOT NULL DEFAULT 'CASH',
        payment_date DATE NOT NULL,
        notes TEXT,
        recorded_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_credit_sale (sale_id),
        INDEX idx_credit_agency (agency_id)
      )
    `);

    // 4. Add vehicle document expiry columns to drivers table
    const [driverCols] = await executor.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'drivers'`
    );
    const dColNames = new Set(driverCols.map((c) => c.COLUMN_NAME));

    if (!dColNames.has("pollution_expiry")) {
      await executor.query(
        "ALTER TABLE drivers ADD COLUMN pollution_expiry DATE NULL"
      );
    }
    if (!dColNames.has("fitness_expiry")) {
      await executor.query(
        "ALTER TABLE drivers ADD COLUMN fitness_expiry DATE NULL"
      );
    }
    if (!dColNames.has("explosives_expiry")) {
      await executor.query(
        "ALTER TABLE drivers ADD COLUMN explosives_expiry DATE NULL"
      );
    }
    if (!dColNames.has("insurance_expiry")) {
      await executor.query(
        "ALTER TABLE drivers ADD COLUMN insurance_expiry DATE NULL"
      );
    }

    migrated = true;
    console.log("Schema migration successfully completed.");
  } catch (error) {
    console.error("Schema migration error:", error);
  }
};

