import db from "../config/db.js";

let dailyStockTableEnsured = false;

/**
 * Ensures the `daily_stock_snapshots` table exists in the database.
 * Matches schema required for daily stock rollover and ledger tracking.
 */
export const ensureDailyStockTable = async (connection) => {
  if (dailyStockTableEnsured) return;

  const conn = connection || (await db.getConnection());
  const shouldRelease = !connection;

  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`daily_stock_snapshots\` (
        \`id\` INT NOT NULL AUTO_INCREMENT,
        \`agency_id\` INT NOT NULL DEFAULT 1,
        \`stock_area_id\` INT NOT NULL DEFAULT 1,
        \`product_id\` INT NOT NULL,
        \`snapshot_date\` DATE NOT NULL,
        \`opening_stock\` INT NOT NULL DEFAULT 0,
        \`purchase_qty\` INT NOT NULL DEFAULT 0,
        \`sales_qty\` INT NOT NULL DEFAULT 0,
        \`system_sales_qty\` INT NOT NULL DEFAULT 0,
        \`sales_return_qty\` INT NOT NULL DEFAULT 0,
        \`purchase_return_qty\` INT NOT NULL DEFAULT 0,
        \`defective_qty\` INT NOT NULL DEFAULT 0,
        \`empty_opening\` INT NOT NULL DEFAULT 0,
        \`empty_closing\` INT NOT NULL DEFAULT 0,
        \`closing_stock\` INT NOT NULL DEFAULT 0,
        \`system_opening\` INT NOT NULL DEFAULT 0,
        \`system_closing\` INT NOT NULL DEFAULT 0,
        \`system_empty_opening\` INT NOT NULL DEFAULT 0,
        \`system_empty_closing\` INT NOT NULL DEFAULT 0,
        \`is_finalized\` TINYINT(1) NOT NULL DEFAULT 0,
        \`created_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_agency_area_prod_date\` (\`agency_id\`, \`stock_area_id\`, \`product_id\`, \`snapshot_date\`),
        KEY \`idx_snapshot_date\` (\`snapshot_date\`),
        KEY \`idx_product_date\` (\`product_id\`, \`snapshot_date\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `);

    // Ensure system_empty_quantity exists in stock table
    try {
      const [stockCols] = await conn.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock' AND COLUMN_NAME = 'system_empty_quantity'`
      );
      if (!stockCols.length) {
        await conn.query(
          `ALTER TABLE stock ADD COLUMN system_empty_quantity INT NOT NULL DEFAULT 0 AFTER empty_quantity`
        );
      }
    } catch (e) {
      console.warn("Could not alter stock table for system_empty_quantity:", e.message);
    }

    // Ensure extra columns exist in daily_stock_snapshots if table was created previously
    try {
      const [dssCols] = await conn.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_stock_snapshots'`
      );
      const colSet = new Set(dssCols.map((c) => c.COLUMN_NAME));
      if (!colSet.has("system_sales_qty")) {
        await conn.query(`ALTER TABLE daily_stock_snapshots ADD COLUMN system_sales_qty INT NOT NULL DEFAULT 0 AFTER sales_qty`);
      }
      if (!colSet.has("empty_opening")) {
        await conn.query(`ALTER TABLE daily_stock_snapshots ADD COLUMN empty_opening INT NOT NULL DEFAULT 0 AFTER defective_qty`);
      }
      if (!colSet.has("empty_closing")) {
        await conn.query(`ALTER TABLE daily_stock_snapshots ADD COLUMN empty_closing INT NOT NULL DEFAULT 0 AFTER empty_opening`);
      }
      if (!colSet.has("system_empty_opening")) {
        await conn.query(`ALTER TABLE daily_stock_snapshots ADD COLUMN system_empty_opening INT NOT NULL DEFAULT 0 AFTER system_closing`);
      }
      if (!colSet.has("system_empty_closing")) {
        await conn.query(`ALTER TABLE daily_stock_snapshots ADD COLUMN system_empty_closing INT NOT NULL DEFAULT 0 AFTER system_empty_opening`);
      }
    } catch (e) {
      console.warn("Could not alter daily_stock_snapshots columns:", e.message);
    }

    dailyStockTableEnsured = true;
  } finally {
    if (shouldRelease) {
      conn.release();
    }
  }
};

/**
 * Resolves available stock_area IDs for an agency.
 */
const resolveStockAreaIds = async (conn, agencyId, stockAreaId) => {
  if (stockAreaId && Number(stockAreaId) > 0) {
    return [Number(stockAreaId)];
  }

  const [areas] = await conn.query(
    `SELECT id FROM stock_areas WHERE agency_id = ? ORDER BY id ASC`,
    [agencyId]
  );
  if (areas.length > 0) {
    return areas.map((a) => Number(a.id));
  }

  const [stockRows] = await conn.query(
    `SELECT DISTINCT stock_area_id FROM stock WHERE agency_id = ? AND stock_area_id IS NOT NULL`,
    [agencyId]
  );
  if (stockRows.length > 0) {
    return stockRows.map((s) => Number(s.stock_area_id));
  }

  return [1];
};

/**
 * Ensures daily stock snapshot records exist for the given agency, date, and stock area(s).
 * Implements lazy evaluation:
 * - If records exist: returns them.
 * - If records do not exist:
 *   - For every product, checks the latest previous snapshot before targetDate.
 *   - If previous snapshot exists:
 *       today.opening_stock = previous.closing_stock
 *       today.system_opening = previous.system_closing
 *   - If no previous snapshot exists (Bootstrap / Day 1):
 *       today.opening_stock = stock.quantity
 *       today.system_opening = stock.system_quantity
 *   - Inserts row with is_finalized = 0.
 *
 * @param {object} connection - Active db connection or null
 * @param {number} agencyId - Agency ID
 * @param {string|null} targetDate - Date string in 'YYYY-MM-DD' format (or null for CURDATE())
 * @param {number|null} stockAreaId - Optional stock area ID
 * @returns {Promise<Array>} Snapshot rows for the target date
 */
export const ensureDailyStockSnapshot = async (
  connection,
  agencyId,
  targetDate,
  stockAreaId = null
) => {
  const conn = connection || (await db.getConnection());
  const shouldRelease = !connection;

  try {
    await ensureDailyStockTable(conn);

    let resolvedDate = targetDate;
    if (!resolvedDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(resolvedDate).slice(0, 10))) {
      const [[todayRow]] = await conn.query(`SELECT CAST(CURDATE() AS CHAR) AS today`);
      resolvedDate = todayRow.today;
    } else {
      resolvedDate = String(resolvedDate).slice(0, 10);
    }

    const safeAgencyId = Number(agencyId || 1);
    const areaIds = await resolveStockAreaIds(conn, safeAgencyId, stockAreaId);

    const [products] = await conn.query(
      `SELECT id FROM products ORDER BY id ASC`
    );

    for (const areaId of areaIds) {
      // Find which products already have snapshots for this date & area
      const [existingRows] = await conn.query(
        `
        SELECT product_id
        FROM daily_stock_snapshots
        WHERE agency_id = ? AND stock_area_id = ? AND snapshot_date = ?
        `,
        [safeAgencyId, areaId, resolvedDate]
      );

      const existingProductIdSet = new Set(
        existingRows.map((r) => Number(r.product_id))
      );

      for (const prod of products) {
        const prodId = Number(prod.id);
        if (existingProductIdSet.has(prodId)) {
          continue;
        }

        // Look for the most recent previous snapshot before resolvedDate
        const [prevSnapshots] = await conn.query(
          `
          SELECT closing_stock, system_closing, empty_closing, system_empty_closing, snapshot_date, is_finalized, opening_stock, purchase_qty, sales_qty
          FROM daily_stock_snapshots
          WHERE agency_id = ? AND stock_area_id = ? AND product_id = ? AND snapshot_date < ?
          ORDER BY snapshot_date DESC
          LIMIT 1
          `,
          [safeAgencyId, areaId, prodId, resolvedDate]
        );

        let openingStock = 0;
        let systemOpening = 0;
        let emptyOpening = 0;
        let systemEmptyOpening = 0;

        if (prevSnapshots.length > 0) {
          const prev = prevSnapshots[0];
          openingStock = Number(prev.closing_stock || 0);
          systemOpening = Number(prev.system_closing || 0);
          emptyOpening = Number(prev.empty_closing || 0);
          systemEmptyOpening = Number(prev.system_empty_closing || 0);
        } else {
          // Bootstrap / Day 1: Read current value in stock table
          const [stockRows] = await conn.query(
            `
            SELECT quantity, system_quantity, empty_quantity, system_empty_quantity
            FROM stock
            WHERE agency_id = ? AND stock_area_id = ? AND product_id = ?
            LIMIT 1
            `,
            [safeAgencyId, areaId, prodId]
          );

          if (stockRows.length > 0) {
            openingStock = Math.max(Number(stockRows[0].quantity || 0), 0);
            systemOpening = Math.max(Number(stockRows[0].system_quantity || 0), 0);
            emptyOpening = Math.max(Number(stockRows[0].empty_quantity || 0), 0);
            systemEmptyOpening = Math.max(Number(stockRows[0].system_empty_quantity || 0), 0);
          } else {
            // Fallback: check stock by product & agency if stock_area_id was unassigned
            const [fallbackStock] = await conn.query(
              `
              SELECT quantity, system_quantity, empty_quantity, system_empty_quantity
              FROM stock
              WHERE agency_id = ? AND product_id = ?
              LIMIT 1
              `,
              [safeAgencyId, prodId]
            );
            if (fallbackStock.length > 0) {
              openingStock = Math.max(Number(fallbackStock[0].quantity || 0), 0);
              systemOpening = Math.max(Number(fallbackStock[0].system_quantity || 0), 0);
              emptyOpening = Math.max(Number(fallbackStock[0].empty_quantity || 0), 0);
              systemEmptyOpening = Math.max(Number(fallbackStock[0].system_empty_quantity || 0), 0);
            }
          }
        }

        // Initial closing stock equals opening stock at beginning of the day
        const closingStock = openingStock;
        const systemClosing = systemOpening;
        const emptyClosing = emptyOpening;
        const systemEmptyClosing = systemEmptyOpening;

        await conn.query(
          `
          INSERT INTO daily_stock_snapshots (
            agency_id,
            stock_area_id,
            product_id,
            snapshot_date,
            opening_stock,
            purchase_qty,
            sales_qty,
            system_sales_qty,
            sales_return_qty,
            purchase_return_qty,
            defective_qty,
            empty_opening,
            empty_closing,
            closing_stock,
            system_opening,
            system_closing,
            system_empty_opening,
            system_empty_closing,
            is_finalized
          ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0)
          ON DUPLICATE KEY UPDATE id = id
          `,
          [
            safeAgencyId,
            areaId,
            prodId,
            resolvedDate,
            openingStock,
            emptyOpening,
            emptyClosing,
            closingStock,
            systemOpening,
            systemClosing,
            systemEmptyOpening,
            systemEmptyClosing,
          ]
        );
      }
    }

    // Return the snapshot rows
    const areaFilter =
      stockAreaId && Number(stockAreaId) > 0
        ? `AND stock_area_id = ?`
        : `AND stock_area_id IN (${areaIds.map(() => "?").join(",")})`;
    const areaParams =
      stockAreaId && Number(stockAreaId) > 0
        ? [Number(stockAreaId)]
        : areaIds;

    const [results] = await conn.query(
      `
      SELECT *
      FROM daily_stock_snapshots
      WHERE agency_id = ? AND snapshot_date = ?
      ${areaFilter}
      ORDER BY product_id ASC
      `,
      [safeAgencyId, resolvedDate, ...areaParams]
    );

    return results;
  } finally {
    if (shouldRelease) {
      conn.release();
    }
  }
};

/**
 * Increments today's purchase quantity and closing stock in daily_stock_snapshots.
 * opening_stock is strictly preserved.
 */
export const recordPurchaseInDailySnapshot = async (
  connection,
  agencyId,
  stockAreaId,
  productId,
  quantity
) => {
  const qty = Number(quantity || 0);
  if (qty <= 0) return;

  const conn = connection || (await db.getConnection());
  const shouldRelease = !connection;

  try {
    await ensureDailyStockSnapshot(conn, agencyId, null, stockAreaId);

    await conn.query(
      `
      UPDATE daily_stock_snapshots
      SET purchase_qty = purchase_qty + ?,
          closing_stock = closing_stock + ?,
          system_closing = system_closing + ?,
          updated_at = NOW()
      WHERE agency_id = ? AND stock_area_id = ? AND product_id = ? AND snapshot_date = CURDATE()
      `,
      [qty, qty, qty, Number(agencyId || 1), Number(stockAreaId || 1), Number(productId)]
    );
  } finally {
    if (shouldRelease) {
      conn.release();
    }
  }
};
