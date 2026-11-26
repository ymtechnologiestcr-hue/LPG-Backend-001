import db from "../config/db.js";

let migrated = false;
let migrationPromise = null;

export const ensureSchemaUpdated = async (executor = db) => {
  if (migrated) return;
  if (migrationPromise) return migrationPromise;

  migrationPromise = (async () => {
    try {
      // 1. Modify sales payment_method enum to include 'CREDIT' only if not already present
      try {
        const [enumCol] = await executor.query(`
          SELECT COLUMN_TYPE 
          FROM information_schema.COLUMNS 
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales' AND COLUMN_NAME = 'payment_method'
        `);
        const colType = enumCol[0]?.COLUMN_TYPE || "";
        if (!colType.includes("'CREDIT'")) {
          await executor.query(`
            ALTER TABLE sales 
            MODIFY COLUMN payment_method ENUM('CASH','ONLINE','UPI','PART_PAYMENT','CREDIT') NULL DEFAULT 'CASH'
          `);
        }
      } catch (e) {
        console.warn("Notice: payment_method enum update:", e.message);
      }

      // 2. Add amount_received, pending_amount, credit_status to sales
      const [salesCols] = await executor.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales'`
      );
      const sColNames = new Set(salesCols.map((c) => c.COLUMN_NAME));

      // Stable client request IDs let retried driver mutations resolve to the
      // original committed transaction, including after a server restart.
      if (!sColNames.has("client_tx_id")) {
        await executor.query(
          "ALTER TABLE sales ADD COLUMN client_tx_id VARCHAR(80) NULL"
        );
      }

      const [salesIndexes] = await executor.query(
        `SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales' AND INDEX_NAME = 'uq_sales_driver_client_tx'`
      );
      if (!salesIndexes.length) {
        await executor.query(
          "ALTER TABLE sales ADD UNIQUE INDEX uq_sales_driver_client_tx (agency_id, driver_id, client_tx_id)"
        );
      }

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

      // 5. Create vehicles table and backfill existing driver vehicles
      await executor.query(`
        CREATE TABLE IF NOT EXISTS vehicles (
          id INT AUTO_INCREMENT PRIMARY KEY,
          agency_id INT NOT NULL,
          driver_id INT NULL,
          vehicle_number VARCHAR(50) NOT NULL,
          vehicle_type VARCHAR(50) NULL,
          pollution_expiry DATE NULL,
          fitness_expiry DATE NULL,
          explosives_expiry DATE NULL,
          insurance_expiry DATE NULL,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_vehicles_agency (agency_id),
          INDEX idx_vehicles_driver (driver_id),
          UNIQUE KEY uq_vehicles_agency_number (agency_id, vehicle_number)
        )
      `);

      await executor.query(`
        INSERT IGNORE INTO vehicles (
          agency_id,
          driver_id,
          vehicle_number,
          pollution_expiry,
          fitness_expiry,
          explosives_expiry,
          insurance_expiry
        )
        SELECT
          COALESCE(d.agency_id, u.agency_id, 1) AS agency_id,
          d.id AS driver_id,
          UPPER(TRIM(d.vehicle_number)) AS vehicle_number,
          d.pollution_expiry,
          d.fitness_expiry,
          d.explosives_expiry,
          d.insurance_expiry
        FROM drivers d
        INNER JOIN users u ON u.id = d.user_id
        WHERE d.vehicle_number IS NOT NULL
          AND TRIM(d.vehicle_number) <> ''
      `);

      migrated = true;
      console.log("Schema migration successfully completed.");
    } catch (error) {
      console.error("Schema migration error:", error);
    } finally {
      migrationPromise = null;
    }
  })();

  return migrationPromise;
};

