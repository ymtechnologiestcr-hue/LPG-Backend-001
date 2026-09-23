import db from "../config/db.js";

const cashierDayLog = {
  opening: null,
  closing: null,
};

let pettyCashColumnEnsured = false;
let closingColumnsEnsured = false;
let cashierOpeningsTableEnsured = false;
let settlementSettledAtColumnEnsured = false;
let expensePaymentColumnsEnsured = false;
let officeExpensePaymentColumnsEnsured = false;
let newConnectionCashierTablesEnsured = false;
let splitPaymentsColumnsEnsured = false;
let transferVoucherPaymentColumnsEnsured = false;
let cashierReceiptsTableEnsured = false;

const getTodayIST = () => {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
};

let cachedSchemaColumnPresence = null;
const getSchemaColumnPresence = async (executor = db) => {
  if (cachedSchemaColumnPresence) return cachedSchemaColumnPresence;
  try {
    const [rows] = await executor.query(`
      SELECT TABLE_NAME, COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND (
          (TABLE_NAME = 'expenses' AND COLUMN_NAME = 'payment_mode') OR
          (TABLE_NAME = 'office_expenses' AND COLUMN_NAME IN ('status', 'payment_mode'))
        )
    `);
    const set = new Set(rows.map((r) => `${r.TABLE_NAME}.${r.COLUMN_NAME}`));
    cachedSchemaColumnPresence = {
      hasExpensePaymentMode: set.has("expenses.payment_mode"),
      hasOfficeExpenseStatus: set.has("office_expenses.status"),
      hasOfficeExpensePaymentMode: set.has("office_expenses.payment_mode"),
    };
  } catch (err) {
    console.warn("getSchemaColumnPresence error, defaulting to enabled:", err.message);
    cachedSchemaColumnPresence = {
      hasExpensePaymentMode: true,
      hasOfficeExpenseStatus: true,
      hasOfficeExpensePaymentMode: true,
    };
  }
  return cachedSchemaColumnPresence;
};

// Petty cash the cashier keeps aside at Close Day. Stored on the closing row so
// the next Start Day can read back how much was held over.
const ensureCashierClosingPettyCashColumn = async (connection) => {
  if (pettyCashColumnEnsured) return;
  const [cols] = await connection.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cashier_closings' AND COLUMN_NAME = 'petty_cash'`,
  );

  if (!cols.length) {
    await connection.query(
      `ALTER TABLE cashier_closings ADD COLUMN petty_cash DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER total_cash`,
    );
  }
  pettyCashColumnEnsured = true;
};

const ensureCashierClosingColumns = async (connection) => {
  if (closingColumnsEnsured) return;
  await ensureCashierClosingPettyCashColumn(connection);

  const requiredColumns = {
    difference_reason:
      "ALTER TABLE cashier_closings ADD COLUMN difference_reason VARCHAR(255) NULL AFTER petty_cash",
    reason_disposition:
      "ALTER TABLE cashier_closings ADD COLUMN reason_disposition VARCHAR(100) NULL AFTER difference_reason",
    note:
      "ALTER TABLE cashier_closings ADD COLUMN note TEXT NULL AFTER reason_disposition",
    denominations:
      "ALTER TABLE cashier_closings ADD COLUMN denominations JSON NULL AFTER note",
  };

  const [rows] = await connection.query(
    `
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'cashier_closings'
      AND COLUMN_NAME IN ('difference_reason', 'reason_disposition', 'note', 'denominations')
    `,
  );

  const existing = new Set(rows.map((row) => String(row.COLUMN_NAME)));
  for (const [columnName, ddl] of Object.entries(requiredColumns)) {
    if (existing.has(columnName)) continue;
    try {
      await connection.query(ddl);
    } catch (error) {
      if (error?.code !== "ER_DUP_FIELDNAME") {
        throw error;
      }
    }
  }
  closingColumnsEnsured = true;
};

// Returns the retained in-office cash (petty cash) carried forward from the latest close.
// This is the cash that remains under cashier custody and becomes tomorrow's required opening.
const getLatestClosingBalance = async (connection, agency_id) => {
  const latest = await getLatestClosing(connection, agency_id);
  return latest ? Number(latest.pettyCash || 0) : null;
};

// The most recent closing row, including total cash and the petty cash carried over from it.
const getLatestClosing = async (connection, agency_id) => {
  await ensureCashierClosingColumns(connection);

  const [rows] = await connection.query(
    `SELECT total_cash, petty_cash, created_at FROM cashier_closings WHERE agency_id = ? ORDER BY id DESC LIMIT 1`,
    [agency_id]
  );

  if (!rows.length) {
    return null;
  }

  return {
    totalCash: Number(rows[0].total_cash || 0),
    pettyCash: Number(rows[0].petty_cash || 0),
    closedAt: rows[0].created_at,
  };
};

// created_at of the most recent day-close. Null if the day was never closed.
const getLastClosingAt = async (connection, agency_id) => {
  const [rows] = await connection.query(
    `SELECT created_at FROM cashier_closings WHERE agency_id = ? ORDER BY id DESC LIMIT 1`,
    [agency_id]
  );
  return rows.length ? rows[0].created_at : null;
};

// Checks whether the cashier day is currently OPEN:
// A day is open if started_at is more recent than closed_at (or if it was started and never closed).
const isCashierDayOpen = async (connection, agency_id) => {
  const [closeAt, openAt] = await Promise.all([
    getLastClosingAt(connection, agency_id),
    getLastOpeningAt(connection, agency_id),
  ]);
  if (!openAt) return false;
  if (!closeAt) return true;
  return new Date(openAt).getTime() >= new Date(closeAt).getTime();
};

// Persists each "Start Day" so the running-day window can be anchored at the
// moment the cashier opened the day (not just the previous close).
const ensureCashierOpeningsTable = async (connection) => {
  if (cashierOpeningsTableEnsured) return;
  await connection.query(`
    CREATE TABLE IF NOT EXISTS cashier_openings (
      id INT NOT NULL AUTO_INCREMENT,
      opening_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      denominations JSON NULL,
      started_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      agency_id INT NOT NULL DEFAULT 1,
      PRIMARY KEY (id),
      KEY idx_cashier_openings_started_at (started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  cashierOpeningsTableEnsured = true;
};

// started_at of the most recent Start Day. Null if a day was never started.
const getLastOpeningAt = async (connection, agency_id) => {
  await ensureCashierOpeningsTable(connection);
  const [rows] = await connection.query(
    `SELECT started_at FROM cashier_openings WHERE agency_id = ? ORDER BY id DESC LIMIT 1`,
    [agency_id]
  );
  return rows.length ? rows[0].started_at : null;
};

// Anchor for the current running day = the timestamp of the last day-close.
// All transactions after this close belong to the current running day.
// We do NOT anchor to openAt (Start Day) because driver collections, office
// sales, or other transactions may occur earlier on the day before the cashier
// formally enters opening cash, or Start Day may be re-submitted. Anchoring to
// openAt would erase those real cash inflows/outflows from the dashboard.
// If the day has never been closed, returns null (which falls back to CURDATE()
// in makeSinceCloseDateCond).
const getCurrentDayAnchor = async (connection, agency_id) => {
  const closeAt = await getLastClosingAt(connection, agency_id);
  return closeAt;
};

// Opening balance of the CURRENT open day (the amount entered at Start Day).
// Returns 0 when the day is closed — i.e. no Start Day has happened since the
// last Close Day — so figures anchored on this reset to 0 right after a close
// and pick the opening balance back up only once the next day is started.
const getCurrentDayOpeningBalance = async (connection, agency_id) => {
  await ensureCashierOpeningsTable(connection);
  const [closeAt, [openRows]] = await Promise.all([
    getLastClosingAt(connection, agency_id),
    connection.query(
      `SELECT opening_amount, started_at FROM cashier_openings WHERE agency_id = ? ORDER BY id DESC LIMIT 1`,
      [agency_id]
    ),
  ]);
  if (!openRows.length) return 0;
  const openAt = openRows[0].started_at;
  const dayIsOpen =
    !closeAt || new Date(openAt).getTime() >= new Date(closeAt).getTime();
  return dayIsOpen ? Number(openRows[0].opening_amount || 0) : 0;
};

// settlement_history.settled_at is stamped when the cashier verifies a driver's
// collection, so cash-in can be dated by when it actually reached the drawer.
const ensureSettlementSettledAtColumn = async (connection) => {
  if (settlementSettledAtColumnEnsured) return;
  const [cols] = await connection.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'settlement_history' AND COLUMN_NAME = 'settled_at'`,
  );
  if (!cols.length) {
    await connection.query(
      `ALTER TABLE settlement_history ADD COLUMN settled_at DATETIME NULL AFTER status`,
    );
  }
  settlementSettledAtColumnEnsured = true;
};

// Driver/purchase expense requests carry the payment mode chosen by the cashier
// at approval time (CASH / UPI / CARD / BANK_TRANSFER). The cash ledger only
// counts CASH approvals as cash outflow, so the column must exist for non-cash
// expenses to be excluded correctly.
const ensureExpensePaymentColumns = async (connection) => {
  if (expensePaymentColumnsEnsured) return;
  const requiredColumns = {
    payment_mode:
      "ALTER TABLE expenses ADD COLUMN payment_mode enum('CASH','UPI','CARD','BANK_TRANSFER') DEFAULT NULL AFTER status",
    payment_reference:
      "ALTER TABLE expenses ADD COLUMN payment_reference varchar(120) DEFAULT NULL AFTER payment_mode",
  };

  const [rows] = await connection.query(
    `
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'expenses'
      AND COLUMN_NAME IN ('payment_mode', 'payment_reference')
    `,
  );

  const existing = new Set(rows.map((row) => String(row.COLUMN_NAME)));
  for (const [columnName, ddl] of Object.entries(requiredColumns)) {
    if (existing.has(columnName)) {
      continue;
    }

    try {
      await connection.query(ddl);
    } catch (error) {
      // Ignore duplicate column race conditions from parallel requests.
      if (error?.code !== "ER_DUP_FIELDNAME") {
        throw error;
      }
    }
  }
  expensePaymentColumnsEnsured = true;
};

// Office expense entries carry the payment mode the cashier used to pay the
// operational expense (CASH / UPI / CARD / BANK_TRANSFER) plus a reference id.
// The cash ledger only counts CASH office expenses as cash outflow.
const ensureOfficeExpensePaymentColumns = async (connection) => {
  if (officeExpensePaymentColumnsEnsured) return;
  const requiredColumns = {
    payment_mode:
      "ALTER TABLE office_expenses ADD COLUMN payment_mode enum('CASH','UPI','CARD','BANK_TRANSFER') DEFAULT NULL AFTER description",
    payment_reference:
      "ALTER TABLE office_expenses ADD COLUMN payment_reference varchar(120) DEFAULT NULL AFTER payment_mode",
  };

  const [rows] = await connection.query(
    `
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'office_expenses'
      AND COLUMN_NAME IN ('payment_mode', 'payment_reference')
    `,
  );

  const existing = new Set(rows.map((row) => String(row.COLUMN_NAME)));
  for (const [columnName, ddl] of Object.entries(requiredColumns)) {
    if (existing.has(columnName)) {
      continue;
    }

    try {
      await connection.query(ddl);
    } catch (error) {
      // Ignore duplicate column race conditions from parallel requests.
      if (error?.code !== "ER_DUP_FIELDNAME") {
        throw error;
      }
    }
  }
  officeExpensePaymentColumnsEnsured = true;
};

// Safely resolve a valid user ID referencing users(id) to avoid foreign key violations
// when sessions hold obsolete user IDs (e.g. after database cleanup/reseeding).
const resolveValidUserId = async (
  connection,
  preferredUserId,
  agencyId,
  preferredRole = "CASHIER",
) => {
  if (preferredUserId) {
    try {
      const [rows] = await connection.query(
        "SELECT id FROM users WHERE id = ? LIMIT 1",
        [preferredUserId],
      );
      if (rows.length > 0) {
        return rows[0].id;
      }
    } catch (err) {
      console.warn("resolveValidUserId check error:", err.message);
    }
  }

  if (agencyId) {
    try {
      const [fallbackRows] = await connection.query(
        `SELECT id FROM users 
         WHERE agency_id = ? AND status = 'ACTIVE' AND role IN (?, 'CASHIER', 'OWNER', 'SUPER_ADMIN')
         ORDER BY (role = ?) DESC, id ASC 
         LIMIT 1`,
        [agencyId, preferredRole, preferredRole],
      );
      if (fallbackRows.length > 0) {
        return fallbackRows[0].id;
      }
    } catch (err) {
      console.warn("resolveValidUserId fallback error:", err.message);
    }
  }

  return null;
};

// Dashboard window: honor an optional [startDate,endDate]; no range => today.
const makeRangeDateCond = (startDate, endDate) => (dateExpr) => {
  if (startDate && endDate) {
    return {
      sql: `AND DATE(${dateExpr}) BETWEEN ? AND ?`,
      params: [startDate, endDate],
    };
  }
  return { sql: `AND DATE(${dateExpr}) = CURDATE()`, params: [] };
};

// Running-day window: everything AFTER the given anchor (see getCurrentDayAnchor
// = latest of last close / last start). Right after a Close Day or a Start Day
// this returns nothing, so the running totals restart from 0 and only accumulate
// as new activity happens on the freshly opened day.
const makeSinceCloseDateCond = (anchorAt) => (dateExpr) => {
  if (anchorAt) {
    return { sql: `AND ${dateExpr} > ?`, params: [anchorAt] };
  }
  return { sql: `AND DATE(${dateExpr}) = CURDATE()`, params: [] };
};

// Single source of truth for cashier cash accounting. `makeDateCond(dateExpr)`
// returns the date predicate + params for a source's own timestamp column.
//
// CASH IN (cash) = driver-collection cash (settled) + office cash sales
//                  + approved cashier-request cash (PR penalty, name change,
//                  new connection) — TRANSFER VOUCHERS ARE NOT CASH IN.
// ONLINE (upi)   = UPI + CARD equivalents of the same sources.
// BANK           = bank-transfer equivalents.
// CASH OUT (cash)= approved driver/purchase expenses (cash) + approved office
//                  expenses (cash) + approved transfer-voucher payouts (cash).
//                  A transfer voucher is a CASH OUT (deposit refunded to the
//                  customer), so it lowers the drawer when paid in cash.
const getCashLedger = async (connection, makeDateCond, agency_id) => {
  const executor = connection || db;
  await ensureNewConnectionCashierTables(executor);
  await ensureSplitPaymentsColumns(executor);
  await ensureTransferVoucherPaymentColumns(executor);
  await ensureSettlementSettledAtColumn(executor);
  await ensureExpensePaymentColumns(executor);
  await ensureOfficeExpensePaymentColumns(executor);
  await ensureCashierReceiptsTable(executor);

  const num = (v) => Number(v || 0);

  const schemaInfo = await getSchemaColumnPresence(executor);
  const expenseCashOnly = schemaInfo.hasExpensePaymentMode
    ? "SUM(CASE WHEN e.payment_mode = 'CASH' OR e.payment_mode IS NULL THEN e.amount ELSE 0 END)"
    : "SUM(e.amount)";
  const expenseUpiOnly = schemaInfo.hasExpensePaymentMode
    ? "SUM(CASE WHEN e.payment_mode IN ('UPI', 'CARD') THEN e.amount ELSE 0 END)"
    : "0";
  const expenseBankOnly = schemaInfo.hasExpensePaymentMode
    ? "SUM(CASE WHEN e.payment_mode = 'BANK_TRANSFER' THEN e.amount ELSE 0 END)"
    : "0";

  const officeCashOnly = schemaInfo.hasOfficeExpensePaymentMode
    ? "SUM(CASE WHEN oe.payment_mode = 'CASH' OR oe.payment_mode IS NULL THEN oe.amount ELSE 0 END)"
    : "SUM(oe.amount)";
  const officeUpiOnly = schemaInfo.hasOfficeExpensePaymentMode
    ? "SUM(CASE WHEN oe.payment_mode IN ('UPI', 'CARD') THEN oe.amount ELSE 0 END)"
    : "0";
  const officeBankOnly = schemaInfo.hasOfficeExpensePaymentMode
    ? "SUM(CASE WHEN oe.payment_mode = 'BANK_TRANSFER' THEN oe.amount ELSE 0 END)"
    : "0";
  const oeStatusFilter = schemaInfo.hasOfficeExpenseStatus ? "AND oe.status = 'APPROVED'" : "";

  // Date predicates for each stream
  const drvC = makeDateCond("COALESCE(sh.settled_at, sh.created_at)");
  const offC = makeDateCond("p.created_at");
  const prC = makeDateCond("pr.paid_at");
  const ncC = makeDateCond("nc.approved_at");
  const cnC = makeDateCond("cnc.paid_at");
  const crC = makeDateCond("cr.created_at");
  const expC = makeDateCond("e.created_at");
  const oeC = makeDateCond("COALESCE(oe.created_at, oe.updated_at)");
  const tvC = makeDateCond("t.updated_at");

  // Execute all 9 independent aggregation streams concurrently via pool
  const [
    [drv],
    [off],
    [pr],
    [nc],
    [cn],
    [cr],
    [exp],
    [oe],
    [tv],
  ] = await Promise.all([
    db.query(
      `SELECT
         COALESCE(SUM(CASE 
           WHEN s.payment_method IN ('UPI', 'ONLINE') OR sh.method IN ('UPI', 'ONLINE', 'CARD') THEN 0
           ELSE sh.amount 
         END), 0) AS cash,
         COALESCE(SUM(CASE 
           WHEN s.payment_method IN ('UPI', 'ONLINE') OR sh.method IN ('UPI', 'ONLINE', 'CARD') THEN sh.amount 
           ELSE 0 
         END), 0) AS upi,
         COUNT(*) AS cnt
       FROM settlement_history sh
       LEFT JOIN sales s ON s.id = sh.sale_id
       WHERE sh.status = 'SETTLED' AND sh.agency_id = ? ${drvC.sql}`,
      [agency_id, ...drvC.params],
    ),
    db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN p.method = 'CASH' THEN p.amount ELSE 0 END), 0) AS cash,
         COALESCE(SUM(CASE WHEN p.method IN ('UPI','CARD') THEN p.amount ELSE 0 END), 0) AS upi,
         COALESCE(SUM(CASE WHEN p.method = 'BANK_TRANSFER' THEN p.amount ELSE 0 END), 0) AS bank,
         COUNT(*) AS cnt
       FROM payments p
       INNER JOIN sales s ON s.id = p.sale_id
       WHERE p.status = 'SUCCESS' AND s.sales_from = 'CASHIER' AND s.agency_id = ? ${offC.sql}`,
      [agency_id, ...offC.params],
    ),
    db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN pr.payment_mode = 'CASH' THEN pr.penalty_amount ELSE 0 END), 0) AS cash,
         COALESCE(SUM(CASE WHEN pr.payment_mode IN ('UPI','CARD') THEN pr.penalty_amount ELSE 0 END), 0) AS upi,
         COALESCE(SUM(CASE WHEN pr.payment_mode = 'BANK_TRANSFER' THEN pr.penalty_amount ELSE 0 END), 0) AS bank,
         COUNT(*) AS cnt
       FROM customer_pr_penalties pr
       WHERE pr.payment_status = 'PAID' AND pr.agency_id = ? ${prC.sql}`,
      [agency_id, ...prC.params],
    ),
    db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN nc.payment_mode = 'CASH' THEN nc.service_fee ELSE 0 END), 0) AS cash,
         COALESCE(SUM(CASE WHEN nc.payment_mode IN ('UPI','CARD') THEN nc.service_fee ELSE 0 END), 0) AS upi,
         COALESCE(SUM(CASE WHEN nc.payment_mode = 'BANK_TRANSFER' THEN nc.service_fee ELSE 0 END), 0) AS bank,
         COUNT(*) AS cnt
       FROM customer_name_change_requests nc
       WHERE nc.status = 'APPROVED' AND nc.agency_id = ? ${ncC.sql}`,
      [agency_id, ...ncC.params],
    ),
    db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN cnc.payment_mode = 'CASH' THEN cnc.total_amount ELSE 0 END), 0) AS cash,
         COALESCE(SUM(CASE WHEN cnc.payment_mode IN ('UPI','CARD') THEN cnc.total_amount ELSE 0 END), 0) AS upi,
         COALESCE(SUM(CASE WHEN cnc.payment_mode = 'BANK_TRANSFER' THEN cnc.total_amount ELSE 0 END), 0) AS bank,
         COUNT(*) AS cnt
       FROM customer_new_connections cnc
       WHERE cnc.payment_status = 'PAID' AND cnc.agency_id = ? ${cnC.sql}`,
      [agency_id, ...cnC.params],
    ),
    db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN cr.payment_mode = 'CASH' THEN cr.amount ELSE 0 END), 0) AS cash,
         COALESCE(SUM(CASE WHEN cr.payment_mode IN ('UPI','CARD') THEN cr.amount ELSE 0 END), 0) AS upi,
         COALESCE(SUM(CASE WHEN cr.payment_mode = 'BANK_TRANSFER' THEN cr.amount ELSE 0 END), 0) AS bank,
         COUNT(*) AS cnt
       FROM cashier_receipts cr
       WHERE cr.agency_id = ? ${crC.sql}`,
      [agency_id, ...crC.params],
    ),
    db.query(
      `SELECT COALESCE(SUM(e.amount), 0) AS total,
              COALESCE(${expenseCashOnly}, 0) AS cash,
              COALESCE(${expenseUpiOnly}, 0) AS upi,
              COALESCE(${expenseBankOnly}, 0) AS bank,
              COUNT(*) AS cnt
       FROM expenses e
       WHERE e.status = 'APPROVED' AND e.agency_id = ? ${expC.sql}`,
      [agency_id, ...expC.params],
    ),
    db.query(
      `SELECT COALESCE(SUM(oe.amount), 0) AS total,
              COALESCE(${officeCashOnly}, 0) AS cash,
              COALESCE(${officeUpiOnly}, 0) AS upi,
              COALESCE(${officeBankOnly}, 0) AS bank,
              COUNT(*) AS cnt
       FROM office_expenses oe
       WHERE oe.agency_id = ? ${oeStatusFilter} ${oeC.sql}`,
      [agency_id, ...oeC.params],
    ),
    db.query(
      `SELECT COALESCE(SUM(t.deposit_liability), 0) AS total,
              COALESCE(SUM(CASE WHEN t.payment_mode = 'CASH' THEN t.deposit_liability ELSE 0 END), 0) AS cash,
              COALESCE(SUM(CASE WHEN t.payment_mode IN ('UPI','CARD') THEN t.deposit_liability ELSE 0 END), 0) AS upi,
              COALESCE(SUM(CASE WHEN t.payment_mode = 'BANK_TRANSFER' THEN t.deposit_liability ELSE 0 END), 0) AS bank,
              COUNT(*) AS cnt
       FROM customer_connection_transfers t
       WHERE t.status = 'APPROVED' AND t.agency_id = ? ${tvC.sql}`,
      [agency_id, ...tvC.params],
    ),
  ]);

  const cashIn = {
    cash:
      num(drv[0]?.cash) +
      num(off[0]?.cash) +
      num(pr[0]?.cash) +
      num(nc[0]?.cash) +
      num(cn[0]?.cash) +
      num(cr[0]?.cash),
    online:
      num(drv[0]?.upi) +
      num(off[0]?.upi) +
      num(pr[0]?.upi) +
      num(nc[0]?.upi) +
      num(cn[0]?.upi) +
      num(cr[0]?.upi),
    bank:
      num(off[0]?.bank) + num(pr[0]?.bank) + num(nc[0]?.bank) + num(cn[0]?.bank) + num(cr[0]?.bank),
    count:
      num(drv[0]?.cnt) +
      num(off[0]?.cnt) +
      num(pr[0]?.cnt) +
      num(nc[0]?.cnt) +
      num(cn[0]?.cnt) +
      num(cr[0]?.cnt),
  };
  cashIn.total = cashIn.cash + cashIn.online + cashIn.bank;

  const office = oe[0] || { total: 0, cash: 0, upi: 0, bank: 0, cnt: 0 };

  const cashOut = {
    cash: num(exp[0]?.cash) + num(office.cash) + num(tv[0]?.cash),
    online: num(exp[0]?.upi) + num(office.upi) + num(tv[0]?.upi),
    bank: num(exp[0]?.bank) + num(office.bank) + num(tv[0]?.bank),
    total: num(exp[0]?.total) + num(office.total) + num(tv[0]?.total),
    count: num(exp[0]?.cnt) + num(office.cnt) + num(tv[0]?.cnt),
  };

  return { cashIn, cashOut };
};

// Cash physically available in the drawer right now:
// - If the day is closed, only the retained in-office cash (petty cash) remains in cashier custody.
// - If the day is open, opening balance (amount declared at Start Day) + approved cash in − approved cash out.
// This is the ceiling for any new cash payout: you can never pay out more cash than you are holding.
const getAvailableCashBalance = async (connection, agency_id = 1) => {
  const dayIsOpen = await isCashierDayOpen(connection, agency_id);
  if (!dayIsOpen) {
    const latest = await getLatestClosing(connection, agency_id);
    return Number(latest?.pettyCash || 0);
  }

  const dayOpening = await getCurrentDayOpeningBalance(connection, agency_id);
  const openingBalance = Number(dayOpening || 0);
  const anchorAt = await getCurrentDayAnchor(connection, agency_id);
  const ledger = await getCashLedger(
    connection,
    makeSinceCloseDateCond(anchorAt),
    agency_id
  );
  return (
    openingBalance +
    Number(ledger.cashIn.cash || 0) -
    Number(ledger.cashOut.cash || 0)
  );
};

const purchaseExpenseTripJoin = `
  LEFT JOIN purchase_trips pt ON pt.id = (
    SELECT pt2.id
    FROM purchase_trips pt2
    WHERE pt2.purchase_manager_id = e.created_by
      AND e.created_at >= pt2.started_at
      AND (pt2.ended_at IS NULL OR e.created_at <= pt2.ended_at)
    ORDER BY pt2.started_at DESC, pt2.id DESC
    LIMIT 1
  )
`;

const DEFAULT_STOCK_AREA_ID = 1;
const ALLOWED_CASHIER_REQUEST_PAYMENT_MODES = [
  "CASH",
  "UPI",
  "CARD",
  "BANK_TRANSFER",
  "SPLIT",
];

const consumeStockForCashierSale = async (
  connection,
  productId,
  requiredQty,
  agencyId
) => {
  let remaining = Number(requiredQty || 0);
  let sourceStockAreaId = null;

  if (remaining <= 0) {
    return;
  }

  const [availableRows] = await connection.query(
    `
    SELECT COALESCE(SUM(quantity), 0) AS available_qty
    FROM stock
    WHERE product_id = ? AND agency_id = ?
    FOR UPDATE
    `,
    [Number(productId), agencyId],
  );

  const availableQty = Number(availableRows[0]?.available_qty || 0);

  if (availableQty < remaining) {
    throw new Error(
      `Insufficient stock for product ${productId}. Available ${availableQty}, required ${remaining}`,
    );
  }

  const [rows] = await connection.query(
    `
    SELECT id, stock_area_id, COALESCE(quantity, 0) AS quantity
    FROM stock
    WHERE product_id = ? AND agency_id = ?
    ORDER BY (stock_area_id = ?) DESC, id ASC
    FOR UPDATE
    `,
    [Number(productId), agencyId, DEFAULT_STOCK_AREA_ID],
  );

  for (const row of rows) {
    if (remaining <= 0) {
      break;
    }

    const currentQty = Number(row.quantity || 0);
    if (currentQty <= 0) {
      continue;
    }

    const deductQty = Math.min(currentQty, remaining);

    if (
      sourceStockAreaId === null &&
      row.stock_area_id !== null &&
      row.stock_area_id !== undefined
    ) {
      sourceStockAreaId = Number(row.stock_area_id);
    }

    await connection.query(
      `
      UPDATE stock
      SET quantity = GREATEST(COALESCE(quantity, 0) - ?, 0),
          updated_at = NOW()
      WHERE id = ?
      `,
      [deductQty, row.id],
    );

    remaining -= deductQty;
  }

  return sourceStockAreaId;
};

const validateCashierRequestPayment = (paymentMode, paymentId) => {
  if (!ALLOWED_CASHIER_REQUEST_PAYMENT_MODES.includes(paymentMode)) {
    return "Invalid payment mode";
  }

  if (paymentMode !== "CASH" && paymentMode !== "SPLIT" && !paymentId) {
    return "Payment ID is required for non-cash modes";
  }

  return "";
};

const ensureNewConnectionCashierTables = async (connection) => {
  if (newConnectionCashierTablesEnsured) return;
  await connection.query(`
    CREATE TABLE IF NOT EXISTS customer_new_connection_products (
      id INT NOT NULL AUTO_INCREMENT,
      connection_id INT NOT NULL,
      product_id INT NOT NULL,
      product_name_snapshot VARCHAR(255) DEFAULT NULL,
      product_type_snapshot VARCHAR(80) DEFAULT NULL,
      product_price_snapshot DECIMAL(10,2) DEFAULT 0,
      status ENUM('PENDING','APPROVED') NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_new_connection_products_connection (connection_id),
      KEY idx_new_connection_products_product (product_id),
      KEY idx_new_connection_products_status (status),
      CONSTRAINT fk_new_connection_products_connection
        FOREIGN KEY (connection_id) REFERENCES customer_new_connections(id) ON DELETE CASCADE,
      CONSTRAINT fk_new_connection_products_product
        FOREIGN KEY (product_id) REFERENCES products(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);

  const requiredColumns = {
    product_id:
      "ALTER TABLE customer_new_connections ADD COLUMN product_id INT DEFAULT NULL AFTER product_details",
    id_proof_url:
      "ALTER TABLE customer_new_connections ADD COLUMN id_proof_url VARCHAR(500) DEFAULT NULL AFTER id_proof_details",
    payment_mode:
      "ALTER TABLE customer_new_connections ADD COLUMN payment_mode enum('CASH','UPI','CARD','BANK_TRANSFER') DEFAULT NULL AFTER payment_status",
    payment_reference_id:
      "ALTER TABLE customer_new_connections ADD COLUMN payment_reference_id varchar(120) DEFAULT NULL AFTER payment_mode",
    cashier_remarks:
      "ALTER TABLE customer_new_connections ADD COLUMN cashier_remarks text AFTER payment_reference_id",
    paid_at:
      "ALTER TABLE customer_new_connections ADD COLUMN paid_at timestamp NULL DEFAULT NULL AFTER cashier_remarks",
  };

  const [rows] = await connection.query(
    `
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'customer_new_connections'
      AND COLUMN_NAME IN ('product_id', 'id_proof_url', 'payment_mode', 'payment_reference_id', 'cashier_remarks', 'paid_at')
    `,
  );

  const existing = new Set(rows.map((row) => String(row.COLUMN_NAME)));
  for (const [columnName, ddl] of Object.entries(requiredColumns)) {
    if (existing.has(columnName)) continue;

    try {
      await connection.query(ddl);
    } catch (error) {
      if (error?.code !== "ER_DUP_FIELDNAME") {
        throw error;
      }
    }
  }
  newConnectionCashierTablesEnsured = true;
};

export const getCashierDashboard = async (req, res) => {
  try {
    const agencyId = req.user.agency_id;

    // Optional date-range filter (YYYY-MM-DD). No range => all-time (default).
    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    let startDate = DATE_ONLY.test(String(req.query.startDate || ""))
      ? String(req.query.startDate)
      : null;
    let endDate = DATE_ONLY.test(String(req.query.endDate || ""))
      ? String(req.query.endDate)
      : null;
    if (startDate && !endDate) endDate = startDate;
    if (endDate && !startDate) startDate = endDate;
    if (startDate && endDate && startDate > endDate) {
      const tmp = startDate;
      startDate = endDate;
      endDate = tmp;
    }
    const hasRange = Boolean(startDate && endDate);
    const rangeParams = hasRange ? [startDate, endDate] : [];

    const expenseWhereClause = hasRange
      ? "WHERE e.agency_id = ? AND DATE(e.created_at) BETWEEN ? AND ?"
      : "WHERE e.agency_id = ?";
    const pendingExpenseDateClause = hasRange
      ? "AND e.agency_id = ? AND DATE(e.created_at) BETWEEN ? AND ?"
      : "AND e.agency_id = ?";
    const settlementDateClause = hasRange
      ? "AND sh.agency_id = ? AND DATE(sh.created_at) BETWEEN ? AND ?"
      : "AND sh.agency_id = ?";
    const driverWhereClause = "WHERE u.agency_id = ?";
    
    const queryParams = [agencyId, ...rangeParams];

    const todayIST = getTodayIST();
    const requestIsTodayOnly = Boolean(hasRange && startDate === endDate && startDate === todayIST);
    const useRunningDay = !hasRange || requestIsTodayOnly;

    // Ensure required closing & opening schema if not already initialized
    await ensureCashierClosingColumns(db);
    await ensureCashierOpeningsTable(db);

    // Run primary dashboard queries + closing/opening metadata concurrently across pool
    const [
      [expenseRows],
      [pendingExpenses],
      [driverRows],
      [closingRows],
      [openingRows],
    ] = await Promise.all([
      db.query(
        `
        SELECT
          COALESCE(SUM(e.amount), 0) AS totalExpenses,
          COALESCE(SUM(CASE WHEN e.status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pendingApproval
        FROM expenses e
        ${expenseWhereClause}
        `,
        queryParams,
      ),
      db.query(
        `
        SELECT
          e.id,
          e.category,
          e.description,
          e.amount,
          DATE_FORMAT(e.created_at, '%Y-%m-%d') AS date,
          COALESCE(u.name, 'Unknown') AS createdBy,
          e.status
        FROM expenses e
        LEFT JOIN users u ON u.id = e.created_by
        WHERE e.status = 'PENDING'
        ${pendingExpenseDateClause}
        ORDER BY e.created_at DESC
        LIMIT 2
        `,
        queryParams,
      ),
      db.query(
        `
        SELECT
          d.id AS driver_id,
          u.name AS driverName,
          COALESCE(SUM(CASE WHEN (s.payment_method = 'CASH' OR (s.payment_method IS NULL AND sh.method = 'CASH')) AND sh.status = 'ASSIGNED' THEN sh.amount ELSE 0 END), 0) AS cashAssigned,
          COALESCE(SUM(CASE WHEN (s.payment_method IN ('UPI', 'ONLINE') OR sh.method IN ('UPI', 'ONLINE', 'CARD')) AND sh.status = 'ASSIGNED' THEN sh.amount ELSE 0 END), 0) AS upiAssigned,
          COALESCE(SUM(CASE WHEN sh.status = 'ASSIGNED' THEN sh.amount ELSE 0 END), 0) AS totalAssigned,
          COALESCE(SUM(CASE WHEN (s.payment_method = 'CASH' OR (s.payment_method IS NULL AND sh.method = 'CASH')) AND sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) AS cashPending,
          COALESCE(SUM(CASE WHEN (s.payment_method IN ('UPI', 'ONLINE') OR sh.method IN ('UPI', 'ONLINE', 'CARD')) AND sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) AS upiPending,
          COALESCE(SUM(CASE WHEN sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) AS totalPending,
          COALESCE(SUM(CASE WHEN sh.status = 'SETTLED' THEN sh.amount ELSE 0 END), 0) AS totalSettled,
          CASE
            WHEN COALESCE(SUM(CASE WHEN sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) > 0 THEN 'Pending'
            WHEN COALESCE(SUM(CASE WHEN sh.status = 'ASSIGNED' THEN sh.amount ELSE 0 END), 0) > 0 THEN 'Assigned'
            WHEN COALESCE(SUM(CASE WHEN sh.status = 'SETTLED' THEN sh.amount ELSE 0 END), 0) > 0 THEN 'Settled'
            ELSE 'None'
          END AS status
        FROM drivers d
        INNER JOIN users u ON u.id = d.user_id
        LEFT JOIN settlement_history sh ON sh.driver_id = d.id AND sh.status IN ('ASSIGNED', 'PENDING', 'SETTLED') ${settlementDateClause}
        LEFT JOIN sales s ON s.id = sh.sale_id
        ${driverWhereClause}
        GROUP BY d.id, u.name
        ORDER BY totalPending DESC, u.name ASC
        LIMIT 4
        `,
        [...queryParams, agencyId],
      ),
      db.query(
        `SELECT total_cash, petty_cash, created_at FROM cashier_closings WHERE agency_id = ? ORDER BY id DESC LIMIT 1`,
        [agencyId],
      ),
      db.query(
        `SELECT opening_amount, started_at FROM cashier_openings WHERE agency_id = ? ORDER BY id DESC LIMIT 1`,
        [agencyId],
      ),
    ]);

    const expenseSummary = expenseRows[0] || {
      totalExpenses: 0,
      pendingApproval: 0,
    };

    const latestClosing = closingRows.length
      ? {
          totalCash: Number(closingRows[0].total_cash || 0),
          pettyCash: Number(closingRows[0].petty_cash || 0),
          closedAt: closingRows[0].created_at,
        }
      : null;

    const closeAt = latestClosing?.closedAt || null;
    const openAt = openingRows.length ? openingRows[0].started_at : null;
    const dayIsOpen = Boolean(openAt && (!closeAt || new Date(openAt).getTime() >= new Date(closeAt).getTime()));
    const dayOpening = dayIsOpen && openingRows.length ? Number(openingRows[0].opening_amount || 0) : 0;

    const ledgerCond = useRunningDay
      ? makeSinceCloseDateCond(closeAt)
      : makeRangeDateCond(startDate, endDate);
    const ledger = await getCashLedger(db, ledgerCond, agencyId);

    let openingBalance = 0;
    let totalCashIn = 0;
    let totalCashOut = 0;
    let currentBalance = 0;
    let onlineIn = 0;
    let bankIn = 0;
    let onlineOut = 0;
    let bankOut = 0;

    if (!useRunningDay) {
      // Historical date range view
      openingBalance = 0;
      totalCashIn = ledger.cashIn.cash;
      totalCashOut = ledger.cashOut.cash;
      currentBalance =
        Number(ledger.cashIn.cash || 0) - Number(ledger.cashOut.cash || 0);
      onlineIn = ledger.cashIn.online;
      bankIn = ledger.cashIn.bank;
      onlineOut = ledger.cashOut.online;
      bankOut = ledger.cashOut.bank;
    } else if (dayIsOpen) {
      // Running day is OPEN
      openingBalance = Number(dayOpening || 0);
      totalCashIn = ledger.cashIn.cash;
      totalCashOut = ledger.cashOut.cash;
      currentBalance =
        openingBalance +
        Number(ledger.cashIn.cash || 0) -
        Number(ledger.cashOut.cash || 0);
      onlineIn = ledger.cashIn.online;
      bankIn = ledger.cashIn.bank;
      onlineOut = ledger.cashOut.online;
      bankOut = ledger.cashOut.bank;
    } else {
      // Running day is CLOSED:
      // Cash handed over to Owner / Bank has left cashier custody.
      // Current balance retained under cashier custody is the in-office petty cash.
      const retainedCash = Number(latestClosing?.pettyCash || 0);
      openingBalance = retainedCash;
      totalCashIn = 0;
      totalCashOut = 0;
      currentBalance = retainedCash;
      onlineIn = 0;
      bankIn = 0;
      onlineOut = 0;
      bankOut = 0;
    }

    return res.status(200).json({
      success: true,
      lastClosingBalance: latestClosing?.pettyCash ?? 0,
      lastClosingTotal: latestClosing?.totalCash ?? 0,
      isDayOpen: dayIsOpen,
      metrics: [
        {
          title: "Opening Balance",
          value: `₹${Number(openingBalance).toLocaleString("en-IN")}`,
          description: !useRunningDay
            ? "Filtered date range"
            : dayIsOpen
              ? "Today's opening cash"
              : latestClosing !== null
                ? "In-office cash (Day closed)"
                : "Day not started",
          variant: "neutral",
          icon: "💼",
        },
        {
          title: "Total Cash In",
          value: `₹${totalCashIn.toLocaleString("en-IN")}`,
          description: !useRunningDay || dayIsOpen
            ? `${driverRows.length} driver entries`
            : "Day is closed",
          variant: "success",
          badge: !useRunningDay || dayIsOpen ? "+4.2%" : undefined,
          icon: "⬆️",
          paymentMethods: {
            online: onlineIn,
            bank: bankIn,
          },
        },
        {
          title: "Total Cash Out",
          value: `₹${totalCashOut.toLocaleString("en-IN")}`,
          description: !useRunningDay || dayIsOpen
            ? `${expenseSummary.pendingApproval} pending approvals`
            : "Day is closed",
          variant: "danger",
          badge:
            (!useRunningDay || dayIsOpen) && expenseSummary.pendingApproval > 0
              ? `+${expenseSummary.pendingApproval}`
              : undefined,
          icon: "⬇️",
          paymentMethods: {
            online: onlineOut,
            bank: bankOut,
          },
        },
        {
          title: "Current Balance",
          value: `₹${currentBalance.toLocaleString("en-IN")}`,
          description: !useRunningDay
            ? "Date range net balance"
            : dayIsOpen
              ? "Live · last sync just now"
              : "In-office cash · Day closed",
          variant: currentBalance >= 0 ? "success" : "danger",
          icon: "💚",
        },
      ],
      chart: {
        labels: ["9", "10", "11", "12", "1", "2", "3", "4", "5", "6", "7", "8"],
        cashIn: [28, 45, 60, 55, 68, 75, 82, 78, 85, 90, 95, 103],
        cashOut: [18, 24, 31, 29, 34, 35, 38, 37, 39, 41, 43, 45],
      },
      actions: [
        {
          title: "driver collections to verify",
          description: `${driverRows.filter((row) => row.status === "Pending").length} drivers awaiting confirmation`,
          badge: `${driverRows.filter((row) => row.status === "Pending").length}`,
          theme: "warning",
        },
        {
          title: "expense approvals pending",
          description: "Vehicle fuel · Office supplies",
          badge: `${expenseSummary.pendingApproval}`,
          theme: "danger",
        },
        {
          title: "large transaction flagged",
          description: "Review transfers above ₹50,000",
          badge: "1",
          theme: "info",
        },
      ],
      drivers: driverRows.map((driver) => ({
        initials: driver.driverName
          .split(" ")
          .map((part) => part[0])
          .join("")
          .slice(0, 2),
        name: driver.driverName,
        subtitle: `${driver.totalPending ? "Pending collections" : "Verified"}`,
        amount: `₹${Number(driver.totalPending || 0).toLocaleString("en-IN")}`,
        status: driver.status,
      })),
      approvals: pendingExpenses.map((expense) => ({
        id: expense.id,
        label: expense.category,
        category: expense.category,
        amount: `₹${Number(expense.amount || 0).toLocaleString("en-IN")}`,
        time: expense.date,
      })),
      receipts: [
        {
          type: "UPI / Online",
          count: 0,
          amount: `₹${Number(onlineIn || 0).toLocaleString("en-IN")}`,
          icon: "📱",
        },
        {
          type: "Bank / Card",
          count: 0,
          amount: `₹${Number(bankIn || 0).toLocaleString("en-IN")}`,
          icon: "🏦",
        },
      ],
    });
  } catch (error) {
    console.error("getCashierDashboard error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch cashier dashboard",
      error: error.message,
    });
  }
};

export const getCashierDriverCollections = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
    const offset = (page - 1) * limit;

    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    let startDate = DATE_ONLY.test(String(req.query.startDate || ""))
      ? String(req.query.startDate)
      : null;
    let endDate = DATE_ONLY.test(String(req.query.endDate || ""))
      ? String(req.query.endDate)
      : null;
    if (startDate && !endDate) endDate = startDate;
    if (endDate && !startDate) startDate = endDate;
    if (startDate && endDate && startDate > endDate) {
      const tmp = startDate;
      startDate = endDate;
      endDate = tmp;
    }
    const hasRange = Boolean(startDate && endDate);

    let joinCondition =
      "sh.driver_id = d.id AND sh.status IN ('ASSIGNED', 'PENDING', 'SETTLED') AND sh.agency_id = ?";
    const queryParams = [req.user.agency_id];
    if (hasRange) {
      joinCondition += " AND DATE(sh.created_at) BETWEEN ? AND ?";
      queryParams.push(startDate, endDate); // for settlement_history JOIN
    }
    // The iocOnlineCount correlated subquery also needs date params when range is set.
    // These must come AFTER the JOIN params but BEFORE limit/offset.
    queryParams.push(req.user.agency_id);
    if (hasRange) {
      queryParams.push(startDate, endDate); // for iocOnlineCount subquery
    }
    queryParams.push(req.user.agency_id); // for u.agency_id = ?
    queryParams.push(limit, offset);
    const [rows] = await connection.query(
      `
      SELECT
        d.id AS driver_id,
        u.name AS driverName,
        -- cash/upi collected: based on the original sale's payment method.
        -- This ensures that even if a driver settles CASH via UPI, the collected stats remain true to the source.
        COALESCE(SUM(CASE WHEN s.payment_method = 'CASH' THEN sh.amount ELSE 0 END), 0) AS cashCollected,
        COALESCE(SUM(CASE WHEN s.payment_method IN ('UPI', 'ONLINE') THEN sh.amount ELSE 0 END), 0) AS upiCollected,
        -- total collected = ALL statuses (ASSIGNED + PENDING + SETTLED)
        COALESCE(SUM(sh.amount), 0) AS totalCollected,
        COALESCE(SUM(CASE WHEN sh.status = 'ASSIGNED' THEN sh.amount ELSE 0 END), 0) AS totalAssigned,
        COALESCE(SUM(CASE WHEN (s.payment_method = 'CASH' OR (s.payment_method IS NULL AND sh.method = 'CASH')) AND sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) AS cashPending,
        COALESCE(SUM(CASE WHEN (s.payment_method IN ('UPI', 'ONLINE') OR sh.method IN ('UPI', 'ONLINE')) AND sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) AS upiPending,
        COALESCE(SUM(CASE WHEN sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) AS totalPending,
        COALESCE(SUM(CASE WHEN (s.payment_method = 'CASH' OR (s.payment_method IS NULL AND sh.method = 'CASH')) AND sh.status = 'SETTLED' THEN sh.amount ELSE 0 END), 0) AS cashSettled,
        COALESCE(SUM(CASE WHEN (s.payment_method IN ('UPI', 'ONLINE') OR sh.method IN ('UPI', 'ONLINE')) AND sh.status = 'SETTLED' THEN sh.amount ELSE 0 END), 0) AS upiSettled,
        COALESCE(SUM(CASE WHEN sh.status = 'SETTLED' THEN sh.amount ELSE 0 END), 0) AS totalSettled,
        COALESCE(SUM(CASE WHEN sh.status = 'ASSIGNED' THEN 1 ELSE 0 END), 0) AS assignedCount,
        COALESCE(SUM(CASE WHEN sh.status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pendingCount,
        COALESCE(SUM(CASE WHEN sh.status = 'SETTLED' THEN 1 ELSE 0 END), 0) AS settledCount,
        -- iocOnlineCount: count of distinct DELIVERED sales whose payment_method = 'ONLINE'
        -- (uses the sale's original payment_method, not settlement_history.method which
        --  changes when the driver settles with a different method)
        COALESCE((
          SELECT COUNT(DISTINCT s2.id)
          FROM sales s2
          WHERE s2.driver_id = d.id
            AND s2.payment_method = 'ONLINE'
            AND s2.status = 'DELIVERED'
            AND s2.agency_id = ?
            ${hasRange ? "AND DATE(COALESCE(s2.delivered_at, s2.created_at)) BETWEEN ? AND ?" : ""}
        ), 0) AS iocOnlineCount,
        CASE
          WHEN COALESCE(SUM(CASE WHEN sh.status = 'PENDING' THEN sh.amount ELSE 0 END), 0) > 0 THEN 'Pending'
          WHEN COALESCE(SUM(CASE WHEN sh.status = 'ASSIGNED' THEN sh.amount ELSE 0 END), 0) > 0 THEN 'Assigned'
          WHEN COALESCE(SUM(CASE WHEN sh.status = 'SETTLED' THEN sh.amount ELSE 0 END), 0) > 0 THEN 'Settled'
          ELSE 'None'
        END AS status
      FROM drivers d
      INNER JOIN users u ON u.id = d.user_id
      LEFT JOIN settlement_history sh ON ${joinCondition}
      LEFT JOIN sales s ON s.id = sh.sale_id
      WHERE u.agency_id = ?
      GROUP BY d.id, u.name
      ORDER BY totalPending DESC, u.name ASC
      LIMIT ?
      OFFSET ?
      `,
      queryParams,
    );

    return res.status(200).json({
      success: true,
      data: rows.map((driver) => {
        // cash/upi = total collected by payment method across ALL statuses.
        // total = grand total collected across ALL statuses (constant regardless of settlement state).
        const cash = Number(driver.cashCollected || 0);
        const upi = Number(driver.upiCollected || 0);
        const total = Number(driver.totalCollected || 0);

        return {
          driver_id: driver.driver_id,
          driverName: driver.driverName,
          cash,
          upi,
          total,
          settled: Number(driver.totalSettled || 0),
          status: driver.status,
          pendingCash: Number(driver.cashPending || 0),
          pendingUpi: Number(driver.upiPending || 0),
          // requested = amount driver has submitted to cashier but not yet approved (PENDING status)
          requested: Number(driver.totalPending || 0),
          // pendingTotal = total collection still unsettled with the driver
          //              = totalCollected - settled = ASSIGNED + PENDING
          pendingTotal:
            Number(driver.totalAssigned || 0) +
            Number(driver.totalPending || 0),
          assignedCash:
            Number(driver.cashCollected || 0) - Number(driver.cashSettled || 0),
          assignedUpi:
            Number(driver.upiCollected || 0) - Number(driver.upiSettled || 0),
          assignedTotal: Number(driver.totalAssigned || 0),
          pendingCount: Number(driver.pendingCount || 0),
          assignedCount: Number(driver.assignedCount || 0),
          settledCount: Number(driver.settledCount || 0),
          iocOnlineCount: Number(driver.iocOnlineCount || 0),
        };
      }),
      pagination: {
        page,
        limit,
        total: rows.length,
      },
    });
  } catch (error) {
    console.error("getCashierDriverCollections error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch driver collections",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getCashierPenaltyRequests = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    let startDate = DATE_ONLY.test(String(req.query.startDate || ""))
      ? String(req.query.startDate)
      : null;
    let endDate = DATE_ONLY.test(String(req.query.endDate || ""))
      ? String(req.query.endDate)
      : null;
    if (startDate && !endDate) endDate = startDate;
    if (endDate && !startDate) startDate = endDate;
    if (startDate && endDate && startDate > endDate) {
      const tmp = startDate;
      startDate = endDate;
      endDate = tmp;
    }
    const hasRange = Boolean(startDate && endDate);
    const dateClause = hasRange ? "AND DATE(p.created_at) BETWEEN ? AND ?" : "";
    const queryParams = [req.user.agency_id];
    if (hasRange) {
      queryParams.push(startDate, endDate);
    }

    const status = String(req.query.status || "ALL").toUpperCase();
    const whereClause =
      status === "PENDING"
        ? "AND p.payment_status = 'UNPAID'"
        : status === "PAID"
          ? "AND p.payment_status = 'PAID'"
          : "";

    const [rows] = await connection.query(
      `
      SELECT
        p.id,
        p.customer_id,
        p.customer_name_snapshot AS customer_name,
        p.consumer_number_snapshot AS consumer_number,
        p.penalty_reason,
        p.penalty_amount,
        p.payment_mode,
        p.payment_reference_id,
        p.cashier_remarks,
        p.payment_status,
        DATE_FORMAT(p.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(p.paid_at, '%Y-%m-%d %H:%i:%s') AS paid_at,
        COALESCE(u.phone, '') AS customer_phone,
        COALESCE((
          SELECT a.address
          FROM addresses a
          WHERE a.user_id = p.customer_id
          ORDER BY a.is_default DESC, a.id DESC
          LIMIT 1
        ), '') AS address
      FROM customer_pr_penalties p
      LEFT JOIN users u ON u.id = p.customer_id
      WHERE p.agency_id = ?
      ${whereClause}
      ${dateClause}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 100
      `,
      queryParams,
    );

    return res.status(200).json({
      success: true,
      data: rows.map((row) => ({
        id: Number(row.id),
        customerId: Number(row.customer_id),
        customerName: row.customer_name,
        consumerNumber: row.consumer_number,
        phone: row.customer_phone,
        address: row.address,
        reason: row.penalty_reason,
        amount: Number(row.penalty_amount || 0),
        paymentMode: row.payment_mode || "",
        paymentId: row.payment_reference_id || "",
        remarks: row.cashier_remarks || "",
        status:
          String(row.payment_status || "UNPAID").toUpperCase() === "PAID"
            ? "APPROVED"
            : "PENDING",
        createdAt: row.created_at,
        paidAt: row.paid_at,
      })),
    });
  } catch (error) {
    console.error("getCashierPenaltyRequests error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch cashier penalty requests",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const collectCashierPenaltyRequest = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureSplitPaymentsColumns(connection);
    const requestId = Number(req.params.requestId);
    const payments = Array.isArray(req.body?.payments)
      ? req.body.payments
      : null;
    let paymentMode = String(req.body?.paymentMode || "CASH").toUpperCase();
    let paymentId = String(req.body?.paymentId || "").trim();
    let splitPaymentsJson = null;

    if (payments && payments.length > 0) {
      paymentMode = "SPLIT";
      paymentId =
        payments
          .map((p) => p.paymentId)
          .filter(Boolean)
          .join(",") || null;
      splitPaymentsJson = JSON.stringify(payments);
    }
    const remarks = String(req.body?.remarks || "").trim();

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "Valid request id is required",
      });
    }

    const allowedModes = ["CASH", "UPI", "CARD", "BANK_TRANSFER", "SPLIT"];
    if (!allowedModes.includes(paymentMode)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment mode",
      });
    }

    if (paymentMode !== "CASH" && paymentMode !== "SPLIT" && !paymentId) {
      return res.status(400).json({
        success: false,
        message: "Payment ID is required for non-cash modes",
      });
    }

    const [result] = await connection.query(
      `
      UPDATE customer_pr_penalties
      SET
        payment_mode = ?,
        payment_reference_id = ?,
        split_payments = ?,
        cashier_remarks = ?,
        payment_status = 'PAID',
        paid_at = NOW()
      WHERE id = ? AND payment_status = 'UNPAID' AND agency_id = ?
      `,
      [
        paymentMode,
        paymentId || null,
        splitPaymentsJson,
        remarks || null,
        requestId,
        req.user.agency_id,
      ],
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        success: false,
        message: "Pending request not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Request collected and marked as paid",
    });
  } catch (error) {
    console.error("collectCashierPenaltyRequest error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update cashier request",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getCashierNameChangeRequests = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    let startDate = DATE_ONLY.test(String(req.query.startDate || ""))
      ? String(req.query.startDate)
      : null;
    let endDate = DATE_ONLY.test(String(req.query.endDate || ""))
      ? String(req.query.endDate)
      : null;
    if (startDate && !endDate) endDate = startDate;
    if (endDate && !startDate) startDate = endDate;
    if (startDate && endDate && startDate > endDate) {
      const tmp = startDate;
      startDate = endDate;
      endDate = tmp;
    }
    const hasRange = Boolean(startDate && endDate);
    const dateClause = hasRange ? "AND DATE(r.created_at) BETWEEN ? AND ?" : "";
    const queryParams = [req.user.agency_id];
    if (hasRange) {
      queryParams.push(startDate, endDate);
    }

    const status = String(req.query.status || "ALL").toUpperCase();
    const whereClause =
      status === "PENDING"
        ? "AND r.status = 'PENDING'"
        : status === "APPROVED"
          ? "AND r.status = 'APPROVED'"
          : "";

    const [rows] = await connection.query(
      `
      SELECT
        r.id,
        r.customer_id,
        u.consumer_number AS consumer_number,
        r.old_name_snapshot,
        r.new_name_requested,
        r.service_fee,
        r.payment_mode,
        r.payment_reference_id,
        r.cashier_remarks,
        r.status,
        DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(r.approved_at, '%Y-%m-%d %H:%i:%s') AS approved_at,
        COALESCE(u.phone, '') AS customer_phone,
        COALESCE((
          SELECT a.address
          FROM addresses a
          WHERE a.user_id = r.customer_id
          ORDER BY a.is_default DESC, a.id DESC
          LIMIT 1
        ), '') AS address
      FROM customer_name_change_requests r
      LEFT JOIN users u ON u.id = r.customer_id
      WHERE r.agency_id = ?
      ${whereClause}
      ${dateClause}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 100
      `,
      queryParams,
    );

    return res.status(200).json({
      success: true,
      data: rows.map((row) => ({
        id: Number(row.id),
        customerId: Number(row.customer_id),
        customerName: row.new_name_requested,
        consumerNumber: row.consumer_number,
        phone: row.customer_phone,
        address: row.address,
        oldName: row.old_name_snapshot,
        newName: row.new_name_requested,
        amount: Number(row.service_fee || 0),
        paymentMode: row.payment_mode || "",
        paymentId: row.payment_reference_id || "",
        remarks: row.cashier_remarks || "",
        status:
          String(row.status || "PENDING").toUpperCase() === "APPROVED"
            ? "APPROVED"
            : "PENDING",
        createdAt: row.created_at,
        approvedAt: row.approved_at,
      })),
    });
  } catch (error) {
    console.error("getCashierNameChangeRequests error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch cashier name change requests",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const collectCashierNameChangeRequest = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureSplitPaymentsColumns(connection);
    const requestId = Number(req.params.requestId);
    const payments = Array.isArray(req.body?.payments)
      ? req.body.payments
      : null;
    let paymentMode = String(req.body?.paymentMode || "CASH").toUpperCase();
    let paymentId = String(req.body?.paymentId || "").trim();
    let splitPaymentsJson = null;

    if (payments && payments.length > 0) {
      paymentMode = "SPLIT";
      paymentId =
        payments
          .map((p) => p.paymentId)
          .filter(Boolean)
          .join(",") || null;
      splitPaymentsJson = JSON.stringify(payments);
    }
    const remarks = String(req.body?.remarks || "").trim();

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "Valid request id is required",
      });
    }

    const allowedModes = ["CASH", "UPI", "CARD", "BANK_TRANSFER", "SPLIT"];
    if (!allowedModes.includes(paymentMode)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment mode",
      });
    }

    if (paymentMode !== "CASH" && paymentMode !== "SPLIT" && !paymentId) {
      return res.status(400).json({
        success: false,
        message: "Payment ID is required for non-cash modes",
      });
    }

    await connection.beginTransaction();

    const [requests] = await connection.query(
      `SELECT customer_id, new_name_requested FROM customer_name_change_requests WHERE id = ? AND status = 'PENDING' AND agency_id = ? FOR UPDATE`,
      [requestId, req.user.agency_id],
    );

    if (!requests.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Pending request not found",
      });
    }

    const { customer_id, new_name_requested } = requests[0];

    await connection.query(
      `
      UPDATE customer_name_change_requests
      SET
        payment_mode = ?,
        payment_reference_id = ?,
        split_payments = ?,
        cashier_remarks = ?,
        status = 'APPROVED',
        approved_at = NOW()
      WHERE id = ? AND agency_id = ?
      `,
      [
        paymentMode,
        paymentId || null,
        splitPaymentsJson,
        remarks || null,
        requestId,
        req.user.agency_id,
      ],
    );

    await connection.query(`UPDATE users SET name = ? WHERE id = ?`, [
      new_name_requested,
      customer_id,
    ]);

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "Name change request approved and name updated successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error("collectCashierNameChangeRequest error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update name change request",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

const ensureSplitPaymentsColumns = async (connection) => {
  if (splitPaymentsColumnsEnsured) return;
  const tables = [
    "customer_pr_penalties",
    "customer_name_change_requests",
    "customer_connection_transfers",
    "customer_new_connections",
    "cashier_receipts",
  ];

  for (const table of tables) {
    try {
      const [rows] = await connection.query(
        `SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'payment_mode'`,
        [table],
      );
      if (rows.length && rows[0].COLUMN_TYPE.includes("enum")) {
        await connection.query(
          `ALTER TABLE ${table} MODIFY COLUMN payment_mode VARCHAR(50) DEFAULT NULL`,
        );
      }
    } catch (err) {
      console.error(`Error modifying payment_mode for ${table}:`, err.message);
    }

    try {
      const [rows] = await connection.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'split_payments'`,
        [table],
      );
      if (!rows.length) {
        await connection.query(
          `ALTER TABLE ${table} ADD COLUMN split_payments JSON DEFAULT NULL`,
        );
      }
    } catch (err) {
      console.error(`Error adding split_payments for ${table}:`, err.message);
    }
  }
  splitPaymentsColumnsEnsured = true;
};

const ensureTransferVoucherPaymentColumns = async (connection) => {
  if (transferVoucherPaymentColumnsEnsured) return;
  const requiredColumns = {
    payment_mode:
      "ALTER TABLE customer_connection_transfers ADD COLUMN payment_mode enum('CASH','UPI','CARD','BANK_TRANSFER') DEFAULT NULL AFTER reason",
    payment_reference_id:
      "ALTER TABLE customer_connection_transfers ADD COLUMN payment_reference_id varchar(120) DEFAULT NULL AFTER payment_mode",
    cashier_remarks:
      "ALTER TABLE customer_connection_transfers ADD COLUMN cashier_remarks text AFTER payment_reference_id",
  };

  const [rows] = await connection.query(
    `
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'customer_connection_transfers'
      AND COLUMN_NAME IN ('payment_mode', 'payment_reference_id', 'cashier_remarks')
    `,
  );

  const existing = new Set(rows.map((row) => String(row.COLUMN_NAME)));
  for (const [columnName, ddl] of Object.entries(requiredColumns)) {
    if (existing.has(columnName)) {
      continue;
    }

    try {
      await connection.query(ddl);
    } catch (error) {
      // Ignore duplicate column race conditions from parallel requests.
      if (error?.code !== "ER_DUP_FIELDNAME") {
        throw error;
      }
    }
  }
  transferVoucherPaymentColumnsEnsured = true;
};

export const getCashierTransferVoucherRequests = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    let startDate = DATE_ONLY.test(String(req.query.startDate || ""))
      ? String(req.query.startDate)
      : null;
    let endDate = DATE_ONLY.test(String(req.query.endDate || ""))
      ? String(req.query.endDate)
      : null;
    if (startDate && !endDate) endDate = startDate;
    if (endDate && !startDate) startDate = endDate;
    if (startDate && endDate && startDate > endDate) {
      const tmp = startDate;
      startDate = endDate;
      endDate = tmp;
    }
    const hasRange = Boolean(startDate && endDate);
    const dateClause = hasRange ? "AND DATE(t.created_at) BETWEEN ? AND ?" : "";
    const queryParams = hasRange ? [startDate, endDate] : [];

    await ensureTransferVoucherPaymentColumns(connection);

    const status = String(req.query.status || "ALL").toUpperCase();
    const whereClause =
      status === "PENDING"
        ? "WHERE t.status = 'PENDING_MANAGER'"
        : status === "APPROVED"
          ? "WHERE t.status = 'APPROVED'"
          : "";

    const [rows] = await connection.query(
      `
      SELECT
        t.id,
        t.existing_customer_id,
        t.new_customer_id,
        t.deposit_liability,
        t.reason,
        t.payment_mode,
        t.payment_reference_id,
        t.cashier_remarks,
        t.status,
        DATE_FORMAT(t.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(t.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at,
        old_u.name AS old_customer_name,
        old_u.consumer_number AS consumer_number,
        COALESCE(cta.agency_name, new_u.name) AS new_customer_name,
        COALESCE(cta.agency_phone, new_u.phone, '') AS new_customer_phone,
        COALESCE(
          cta.agency_address,
          (
            SELECT a.address
            FROM addresses a
            WHERE a.user_id = t.new_customer_id
            ORDER BY a.is_default DESC, a.id DESC
            LIMIT 1
          ),
          ''
        ) AS new_customer_address
      FROM customer_connection_transfers t
      INNER JOIN users old_u ON old_u.id = t.existing_customer_id
      LEFT JOIN users new_u ON new_u.id = t.new_customer_id
      LEFT JOIN customer_transfer_agencies cta ON cta.transfer_id = t.id
      ${whereClause}
      ${dateClause}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT 100
      `,
      queryParams,
    );

    return res.status(200).json({
      success: true,
      data: rows.map((row) => ({
        id: Number(row.id),
        customerId: Number(row.new_customer_id),
        customerName: row.new_customer_name,
        consumerNumber: row.consumer_number,
        phone: row.new_customer_phone,
        address: row.new_customer_address,
        oldName: row.old_customer_name,
        newName: row.new_customer_name,
        newMobile: row.new_customer_phone,
        newAddress: row.new_customer_address,
        amount: Number(row.deposit_liability || 0),
        reason: row.reason || "",
        paymentMode: row.payment_mode || "",
        paymentId: row.payment_reference_id || "",
        remarks: row.cashier_remarks || "",
        status:
          String(row.status || "PENDING_MANAGER").toUpperCase() === "APPROVED"
            ? "APPROVED"
            : "PENDING",
        createdAt: row.created_at,
        approvedAt: row.updated_at,
      })),
    });
  } catch (error) {
    console.error("getCashierTransferVoucherRequests error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch cashier transfer voucher requests",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const collectCashierTransferVoucherRequest = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureTransferVoucherPaymentColumns(connection);

    const requestId = Number(req.params.requestId);
    const payments = Array.isArray(req.body?.payments)
      ? req.body.payments
      : null;
    let paymentMode = String(req.body?.paymentMode || "CASH").toUpperCase();
    let paymentId = String(req.body?.paymentId || "").trim();
    let splitPaymentsJson = null;

    if (payments && payments.length > 0) {
      paymentMode = "SPLIT";
      paymentId =
        payments
          .map((p) => p.paymentId)
          .filter(Boolean)
          .join(",") || null;
      splitPaymentsJson = JSON.stringify(payments);
    }
    const remarks = String(req.body?.remarks || "").trim();

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "Valid request id is required",
      });
    }

    const allowedModes = ["CASH", "UPI", "CARD", "BANK_TRANSFER", "SPLIT"];
    if (!allowedModes.includes(paymentMode)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment mode",
      });
    }

    if (paymentMode !== "CASH" && paymentMode !== "SPLIT" && !paymentId) {
      return res.status(400).json({
        success: false,
        message: "Payment ID is required for non-cash modes",
      });
    }

    // A transfer voucher is a CASH OUT (deposit refund). A cash payout can never
    // exceed the cash currently in the drawer.
    if (paymentMode === "CASH") {
      const [transferRows] = await connection.query(
        "SELECT deposit_liability FROM customer_connection_transfers WHERE id = ? AND status = 'PENDING_MANAGER' LIMIT 1",
        [requestId],
      );

      if (!transferRows.length) {
        return res.status(404).json({
          success: false,
          message: "Pending request not found",
        });
      }

      const transferAmount = Number(transferRows[0].deposit_liability || 0);
      const availableCash = await getAvailableCashBalance(
        connection,
        req.user?.agency_id || 1,
      );
      if (transferAmount > availableCash) {
        return res.status(400).json({
          success: false,
          message: `Insufficient cash balance. Available ₹${availableCash.toLocaleString("en-IN")}, transfer voucher ₹${transferAmount.toLocaleString("en-IN")}. Pay via UPI/Card/Bank Transfer or reduce the amount.`,
          availableCash,
          requestedAmount: transferAmount,
        });
      }
    }

    const [result] = await connection.query(
      `
      UPDATE customer_connection_transfers
      SET
        payment_mode = ?,
        payment_reference_id = ?,
        split_payments = ?,
        cashier_remarks = ?,
        status = 'APPROVED',
        updated_at = NOW()
      WHERE id = ? AND status = 'PENDING_MANAGER'
      `,
      [
        paymentMode,
        paymentId || null,
        splitPaymentsJson,
        remarks || null,
        requestId,
      ],
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        success: false,
        message: "Pending request not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Transfer voucher request approved",
    });
  } catch (error) {
    console.error("collectCashierTransferVoucherRequest error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update transfer voucher request",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getCashierNewConnectionRequests = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    let startDate = DATE_ONLY.test(String(req.query.startDate || ""))
      ? String(req.query.startDate)
      : null;
    let endDate = DATE_ONLY.test(String(req.query.endDate || ""))
      ? String(req.query.endDate)
      : null;
    if (startDate && !endDate) endDate = startDate;
    if (endDate && !startDate) startDate = endDate;
    if (startDate && endDate && startDate > endDate) {
      const tmp = startDate;
      startDate = endDate;
      endDate = tmp;
    }
    const hasRange = Boolean(startDate && endDate);
    const dateClause = hasRange
      ? "AND DATE(cnc.created_at) BETWEEN ? AND ?"
      : "";
    const queryParams = hasRange ? [startDate, endDate] : [];

    await ensureNewConnectionCashierTables(connection);

    const status = String(req.query.status || "ALL").toUpperCase();
    const whereClause =
      status === "PENDING"
        ? "WHERE cnc.payment_status = 'PENDING_PAYMENT'"
        : status === "APPROVED" || status === "PAID"
          ? "WHERE cnc.payment_status = 'PAID'"
          : "";

    const [rows] = await connection.query(
      `
      SELECT
        cnc.id,
        cnc.user_id,
        u.consumer_number AS consumer_number,
        cnc.product_details,
        cnc.deposit_amount,
        cnc.gst_amount,
        cnc.total_amount,
        cnc.payment_mode,
        cnc.payment_reference_id,
        cnc.cashier_remarks,
        cnc.payment_status,
        DATE_FORMAT(cnc.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(cnc.paid_at, '%Y-%m-%d %H:%i:%s') AS paid_at,
        u.name AS customer_name,
        COALESCE(u.phone, '') AS customer_phone,
        COALESCE((
          SELECT a.address
          FROM addresses a
          WHERE a.user_id = cnc.user_id
          ORDER BY a.is_default DESC, a.id DESC
          LIMIT 1
        ), '') AS address,
        GROUP_CONCAT(
          DISTINCT COALESCE(ncp.product_name_snapshot, p.name)
          ORDER BY COALESCE(ncp.product_name_snapshot, p.name)
          SEPARATOR ', '
        ) AS selected_products,
        GROUP_CONCAT(
          DISTINCT CONCAT_WS('::', 
            ncp.product_id, 
            COALESCE(ncp.product_name_snapshot, p.name, ''), 
            COALESCE(p.type, ''), 
            COALESCE(ncp.product_price_snapshot, p.price, 0)
          )
          SEPARATOR '||'
        ) AS products_detailed,
        GROUP_CONCAT(
          DISTINCT ncp.product_id
          ORDER BY ncp.product_id
          SEPARATOR ','
        ) AS product_ids
      FROM customer_new_connections cnc
      INNER JOIN users u ON u.id = cnc.user_id
      LEFT JOIN customer_new_connection_products ncp ON ncp.connection_id = cnc.id
      LEFT JOIN products p ON p.id = ncp.product_id
      ${whereClause}
      ${dateClause}
      GROUP BY
        cnc.id,
        cnc.user_id,
        cnc.product_details,
        cnc.deposit_amount,
        cnc.gst_amount,
        cnc.total_amount,
        cnc.payment_mode,
        cnc.payment_reference_id,
        cnc.cashier_remarks,
        cnc.payment_status,
        cnc.created_at,
        cnc.paid_at,
        u.name,
        u.phone
      ORDER BY cnc.created_at DESC, cnc.id DESC
      LIMIT 100
      `,
      queryParams,
    );

    return res.status(200).json({
      success: true,
      data: rows.map((row) => {
        const parsedProducts = row.products_detailed
          ? row.products_detailed.split("||").map((pStr) => {
              const [id, name, type, price] = pStr.split("::");
              return {
                id: Number(id),
                name: name || "",
                type: type || "",
                price: Number(price || 0),
              };
            })
          : [];

        return {
          id: Number(row.id),
          customerId: Number(row.user_id),
          customerName: row.customer_name,
          consumerNumber: row.consumer_number,
          phone: row.customer_phone,
          address: row.address,
          connectionId: `NC-${String(row.id).padStart(4, "0")}`,
          productDetails: row.selected_products || row.product_details || "",
          productIds: parsedProducts.map((p) => p.id),
          products: parsedProducts,
          depositAmount: Number(row.deposit_amount || 0),
          gstAmount: Number(row.gst_amount || 0),
          amount: Number(row.total_amount || 0),
          paymentMode: row.payment_mode || "",
          paymentId: row.payment_reference_id || "",
          remarks: row.cashier_remarks || "",
          status:
            String(row.payment_status || "PENDING_PAYMENT").toUpperCase() ===
            "PAID"
              ? "APPROVED"
              : "PENDING",
          createdAt: row.created_at,
          approvedAt: row.paid_at,
        };
      }),
    });
  } catch (error) {
    console.error("getCashierNewConnectionRequests error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch cashier new connection requests",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const collectCashierNewConnectionRequest = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureNewConnectionCashierTables(connection);

    const requestId = Number(req.params.requestId);
    const payments = Array.isArray(req.body?.payments)
      ? req.body.payments
      : null;
    let paymentMode = String(req.body?.paymentMode || "CASH").toUpperCase();
    let paymentId = String(req.body?.paymentId || "").trim();
    let splitPaymentsJson = null;

    if (payments && payments.length > 0) {
      paymentMode = "SPLIT";
      paymentId =
        payments
          .map((p) => p.paymentId)
          .filter(Boolean)
          .join(",") || null;
      splitPaymentsJson = JSON.stringify(payments);
    }
    const remarks = String(req.body?.remarks || "").trim();

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "Valid request id is required",
      });
    }

    const paymentError = validateCashierRequestPayment(paymentMode, paymentId);
    if (paymentError) {
      return res.status(400).json({
        success: false,
        message: paymentError,
      });
    }

    await connection.beginTransaction();

    const [result] = await connection.query(
      `
      UPDATE customer_new_connections
      SET
        payment_mode = ?,
        payment_reference_id = ?,
        split_payments = ?,
        cashier_remarks = ?,
        payment_status = 'PAID',
        paid_at = NOW(),
        updated_at = NOW()
      WHERE id = ? AND payment_status = 'PENDING_PAYMENT'
      `,
      [
        paymentMode,
        paymentId || null,
        splitPaymentsJson,
        remarks || null,
        requestId,
      ],
    );

    if (!result.affectedRows) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Pending request not found",
      });
    }

    await connection.query(
      `
      UPDATE customer_new_connection_products
      SET status = 'APPROVED', updated_at = NOW()
      WHERE connection_id = ?
      `,
      [requestId],
    );

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "New connection request approved",
    });
  } catch (error) {
    await connection.rollback();
    console.error("collectCashierNewConnectionRequest error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update new connection request",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const recordOtherPayment = async (req, res) => {
  const connection = await db.getConnection();
  const { customer_name, method, transfer_id, amount, note } = req.body;

  if (!customer_name || !method || amount === undefined || amount === null) {
    return res.status(400).json({
      success: false,
      message: "Customer name, method, and amount are required",
    });
  }

  const normalizedMethod = method.toUpperCase();
  const validMethods = ["UPI", "BANK_TRANSFER", "CARD"];
  if (!validMethods.includes(normalizedMethod)) {
    return res.status(400).json({
      success: false,
      message: "Invalid payment method",
    });
  }

  const numericAmount = Number(amount);
  if (Number.isNaN(numericAmount) || numericAmount < 0) {
    return res.status(400).json({
      success: false,
      message: "Amount must be a valid non-negative number",
    });
  }

  try {
    const rawCashierId = req.user?.id;
    const cashierId = await resolveValidUserId(
      connection,
      rawCashierId,
      req.user?.agency_id,
      "CASHIER",
    );

    let result;
    try {
      [result] = await connection.query(
        `
        INSERT INTO other_payments (
          cashier_id,
          customer_name,
          method,
          transfer_id,
          amount,
          note,
          status,
          created_at,
          updated_at,
          agency_id
        ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
        `,
        [
          cashierId,
          customer_name.trim(),
          normalizedMethod,
          transfer_id?.trim() || null,
          numericAmount,
          note?.trim() || null,
          req.user.agency_id,
        ],
      );
    } catch (queryErr) {
      if (queryErr?.code === "ER_NO_REFERENCED_ROW_2" || queryErr?.errno === 1452) {
        console.warn(
          "other_payments foreign key constraint failed on cashier_id. Retrying with cashier_id = null:",
          queryErr.message,
        );
        [result] = await connection.query(
          `
          INSERT INTO other_payments (
            cashier_id,
            customer_name,
            method,
            transfer_id,
            amount,
            note,
            status,
            created_at,
            updated_at,
            agency_id
          ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
          `,
          [
            null,
            customer_name.trim(),
            normalizedMethod,
            transfer_id?.trim() || null,
            numericAmount,
            note?.trim() || null,
            req.user.agency_id,
          ],
        );
      } else {
        throw queryErr;
      }
    }

    return res.status(201).json({
      success: true,
      message: "Other payment saved",
      paymentId: result.insertId,
    });
  } catch (error) {
    console.error("recordOtherPayment error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to save other payment",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

// Optional [startDate,endDate] (YYYY-MM-DD) filter on other_payments.created_at.
// No valid range => no filter (caller/UI decides the default window).
const buildOtherPaymentsDateFilter = (query = {}, agencyId) => {
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  let startDate = DATE_ONLY.test(String(query.startDate || ""))
    ? String(query.startDate)
    : null;
  let endDate = DATE_ONLY.test(String(query.endDate || ""))
    ? String(query.endDate)
    : null;
  if (startDate && !endDate) endDate = startDate;
  if (endDate && !startDate) startDate = endDate;
  if (startDate && endDate && startDate > endDate) {
    const tmp = startDate;
    startDate = endDate;
    endDate = tmp;
  }
  if (startDate && endDate) {
    return {
      whereClause: "WHERE agency_id = ? AND DATE(created_at) BETWEEN ? AND ?",
      params: [agencyId, startDate, endDate],
    };
  }
  return { whereClause: "WHERE agency_id = ?", params: [agencyId] };
};

export const getOtherPayments = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { whereClause, params } = buildOtherPaymentsDateFilter(req.query, req.user.agency_id);

    const [rows] = await connection.query(
      `
      SELECT
        id,
        customer_name,
        method,
        transfer_id,
        amount,
        note,
        status,
        DATE_FORMAT(created_at, '%Y-%m-%d') AS date
      FROM other_payments
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT 100
      `,
      params,
    );

    return res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("getOtherPayments error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch other payments",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getOtherPaymentsSummary = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { whereClause, params } = buildOtherPaymentsDateFilter(req.query, req.user.agency_id);

    const [rows] = await connection.query(
      `
      SELECT
        method,
        COUNT(*) AS count,
        COALESCE(SUM(amount), 0) AS totalAmount
      FROM other_payments
      ${whereClause}
      GROUP BY method
      `,
      params,
    );

    const summary = {
      UPI: { count: 0, totalAmount: 0 },
      BANK_TRANSFER: { count: 0, totalAmount: 0 },
      CARD: { count: 0, totalAmount: 0 },
    };

    rows.forEach((row) => {
      summary[row.method] = {
        count: Number(row.count || 0),
        totalAmount: Number(row.totalAmount || 0),
      };
    });

    return res.status(200).json({
      success: true,
      summary,
    });
  } catch (error) {
    console.error("getOtherPaymentsSummary error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch other payments summary",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const verifyDriverCollections = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const driverId = Number(req.params.driverId);

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "Driver id is required",
      });
    }

    // Stamp when cash actually reaches the drawer (used to date cash-in). ALTER
    // outside the transaction so it doesn't trigger an implicit commit mid-txn.
    await ensureSettlementSettledAtColumn(connection);

    await connection.beginTransaction();

    const [rows] = await connection.query(
      `
      SELECT id, amount, created_at
      FROM settlement_history
      WHERE driver_id = ?
        AND status = 'PENDING'
        AND agency_id = ?
      FOR UPDATE
      `,
      [driverId, req.user.agency_id],
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "No pending collections found for this driver",
      });
    }

    const totalsByDate = rows.reduce((acc, row) => {
      const rowDate = new Date(row.created_at).toISOString().split("T")[0];
      acc[rowDate] = (acc[rowDate] || 0) + Number(row.amount || 0);
      return acc;
    }, {});

    const [updateResult] = await connection.execute(
      `
      UPDATE settlement_history
      SET status = 'SETTLED',
          settled_at = NOW()
      WHERE driver_id = ?
        AND status = 'PENDING'
        AND agency_id = ?
      `,
      [driverId, req.user.agency_id],
    );

    for (const [settlementDate, amount] of Object.entries(totalsByDate)) {
      await connection.execute(
        `
        INSERT INTO settlements (
          driver_id,
          amount,
          status,
          settlement_date,
          agency_id
        ) VALUES (?, ?, 'SETTLED', ?, ?)
        ON DUPLICATE KEY UPDATE
          amount = VALUES(amount),
          status = VALUES(status)
        `,
        [driverId, amount, settlementDate, req.user.agency_id],
      );
    }

    await connection.commit();

    const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);

    return res.status(200).json({
      success: true,
      message: "Driver collections verified and settled",
      data: {
        updatedCount: updateResult.affectedRows,
        totalSettled: total,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("verifyDriverCollections error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to verify driver collections",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getLastClosingBalance = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const latest = await getLatestClosing(connection, req.user.agency_id);

    return res.status(200).json({
      success: true,
      // The required opening balance for tomorrow is the in-office cash retained:
      total_cash: latest?.pettyCash ?? 0,
      expected_opening: latest?.pettyCash ?? 0,
      carried_forward: latest?.pettyCash ?? 0,
      // The total physical cash counted at the last close (before handover/deposit):
      last_closing_total: latest?.totalCash ?? 0,
      petty_cash: latest?.pettyCash ?? 0,
      pettyCash: latest?.pettyCash ?? 0,
      hasPrevious: latest !== null,
    });
  } catch (error) {
    console.error("getLastClosingBalance error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch last closing balance",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getClosingSummary = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const dayIsOpen = await isCashierDayOpen(connection, req.user.agency_id);
    if (!dayIsOpen) {
      return res.status(200).json({
        success: true,
        cashTotal: 0,
      });
    }

    const anchorAt = await getCurrentDayAnchor(connection, req.user.agency_id);
    const ledger = await getCashLedger(
      connection,
      makeSinceCloseDateCond(anchorAt),
      req.user.agency_id
    );
    const dayOpening = await getCurrentDayOpeningBalance(connection, req.user.agency_id);
    const cashTotal =
      Number(dayOpening || 0) +
      Number(ledger.cashIn.cash || 0) -
      Number(ledger.cashOut.cash || 0);

    return res.status(200).json({
      success: true,
      cashTotal,
    });
  } catch (error) {
    console.error("getClosingSummary error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch closing summary",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const startCashierDay = async (req, res) => {
  const { totalAmount, denominations } = req.body;

  if (totalAmount === undefined || !denominations) {
    return res.status(400).json({
      success: false,
      message: "totalAmount and denominations are required",
    });
  }

  const connection = await db.getConnection();

  try {
    const latest = await getLatestClosing(connection, req.user.agency_id);
    const expectedOpening = latest !== null ? Number(latest.pettyCash || 0) : null;

    if (expectedOpening !== null && expectedOpening > 0 && Number(totalAmount) !== expectedOpening) {
      return res.status(400).json({
        success: false,
        message: `Opening balance must match retained in-office cash of ₹${expectedOpening.toLocaleString("en-IN")}`,
      });
    }

    // Persist the Start Day so the running-day window anchors here: cash in/out
    // reset to 0 and only the opening balance carries into the new day.
    await ensureCashierOpeningsTable(connection);
    const [result] = await connection.execute(
      `INSERT INTO cashier_openings (opening_amount, denominations, agency_id) VALUES (?, ?, ?)`,
      [Number(totalAmount) || 0, JSON.stringify(denominations), req.user.agency_id],
    );

    cashierDayLog.opening = {
      startedAt: new Date().toLocaleString("en-IN", { hour12: true }),
      totalAmount,
      denominations,
      openingId: result.insertId,
    };

    return res.status(200).json({
      success: true,
      message: "Cashier day started successfully",
      opening: cashierDayLog.opening,
      lastClosingBalance: expectedOpening ?? 0,
    });
  } catch (error) {
    console.error("startCashierDay error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to start cashier day",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const closeCashierDay = async (req, res) => {
  const {
    closingAmount,
    denominations,
    differenceReason,
    pettyCash,
    reasonDisposition,
    note,
  } = req.body;

  if (closingAmount === undefined || !denominations) {
    return res.status(400).json({
      success: false,
      message: "closingAmount and denominations are required",
    });
  }

  // Petty cash is optional - an unsent or blank value closes the day with 0.
  const pettyCashAmount =
    pettyCash === undefined || pettyCash === null || pettyCash === ""
      ? 0
      : Number(pettyCash);

  if (Number.isNaN(pettyCashAmount) || pettyCashAmount < 0) {
    return res.status(400).json({
      success: false,
      message: "pettyCash must be a non-negative amount",
    });
  }

  const connection = await db.getConnection();

  try {
    await ensureCashierClosingColumns(connection);

    await connection.beginTransaction();
    const [result] = await connection.execute(
      `
      INSERT INTO cashier_closings (
        total_cash,
        petty_cash,
        difference_reason,
        reason_disposition,
        note,
        denominations,
        agency_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        closingAmount,
        pettyCashAmount,
        differenceReason || null,
        reasonDisposition || null,
        note || null,
        JSON.stringify(denominations),
        req.user.agency_id,
      ],
    );

    await connection.commit();

    cashierDayLog.closing = {
      closedAt: new Date().toLocaleString("en-IN", { hour12: true }),
      closingAmount,
      denominations,
      differenceReason: differenceReason || null,
      pettyCash: pettyCashAmount,
      reasonDisposition: reasonDisposition || null,
      note: note || null,
      closingId: result.insertId,
    };

    return res.status(200).json({
      success: true,
      message: "Cashier day closed successfully",
      closing: cashierDayLog.closing,
      retainedCash: pettyCashAmount,
      handoverAmount: Math.max(0, Number(closingAmount) - pettyCashAmount),
    });
  } catch (error) {
    await connection.rollback();
    console.error("closeCashierDay error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to close cashier day",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const recordOfficeSale = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      customer_name,
      phone,
      address,
      items = [],
      payment_method: originalPaymentMethod = "CASH",
      payments = null,
    } = req.body;
    const payment_method =
      payments && payments.length > 0 ? "SPLIT" : originalPaymentMethod;

    if (!customer_name || !address || !items.length) {
      return res.status(400).json({
        success: false,
        message: "customer_name, address and items are required",
      });
    }

    const parsedItems = items.map((item) => ({
      product_id: Number(item.product_id),
      quantity: Number(item.quantity),
      price: Number(item.price),
    }));

    if (
      parsedItems.some(
        (item) => !item.product_id || item.quantity <= 0 || item.price < 0,
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Each item must have a valid product_id, positive quantity and price",
      });
    }

    const totalAmount = parsedItems.reduce(
      (sum, item) => sum + item.quantity * item.price,
      0,
    );

    await connection.beginTransaction();

    const uniqueProductIds = [
      ...new Set(parsedItems.map((item) => Number(item.product_id))),
    ];
    const productPlaceholders = uniqueProductIds.map(() => "?").join(",");
    const [productRows] = await connection.query(
      `
      SELECT id, name, type, price
      FROM products
      WHERE id IN (${productPlaceholders})
      `,
      uniqueProductIds,
    );

    if (productRows.length !== uniqueProductIds.length) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "One or more selected products are invalid",
      });
    }

    const productMap = new Map(productRows.map((row) => [Number(row.id), row]));

    const deductedStockAreaIds = [];

    for (const item of parsedItems) {
      const product = productMap.get(Number(item.product_id));
      if (!product) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "One or more selected products are invalid",
        });
      }

      const sourceStockAreaId = await consumeStockForCashierSale(
        connection,
        item.product_id,
        item.quantity,
        req.user.agency_id
      );
      deductedStockAreaIds.push(sourceStockAreaId);
    }

    const cashierUserId = await resolveValidUserId(
      connection,
      req.user?.id,
      req.user?.agency_id,
      "CASHIER",
    );

    let customerId = null;

    if (phone) {
      const [existingCustomers] = await connection.execute(
        `
        SELECT id
        FROM users
        WHERE phone = ?
        LIMIT 1
        `,
        [phone],
      );

      if (existingCustomers.length) {
        customerId = existingCustomers[0].id;
        await connection.execute(
          `
          UPDATE users
          SET name = ?, role = 'CUSTOMER', updated_at = NOW()
          WHERE id = ?
          `,
          [customer_name, customerId],
        );
      }
    }

    if (!customerId) {
      const [customerResult] = await connection.execute(
        `
        INSERT INTO users
          (name, phone, role, created_at, updated_at, agency_id)
        VALUES (?, ?, 'CUSTOMER', NOW(), NOW(), ?)
        `,
        [customer_name, phone || null, req.user.agency_id],
      );
      customerId = customerResult.insertId;
    }

    let addressId = null;
    const [addressRows] = await connection.execute(
      `
      SELECT id
      FROM addresses
      WHERE user_id = ?
        AND address = ?
      LIMIT 1
      `,
      [customerId, address],
    );

    if (addressRows.length) {
      addressId = addressRows[0].id;
    } else {
      const [addressResult] = await connection.execute(
        `
        INSERT INTO addresses
          (user_id, address, created_at, updated_at)
        VALUES (?, ?, NOW(), NOW())
        `,
        [customerId, address],
      );
      addressId = addressResult.insertId;
    }

    const totalQuantity = parsedItems.reduce(
      (sum, item) => sum + item.quantity,
      0,
    );

    const [saleResult] = await connection.execute(
      `
      INSERT INTO sales
        (customer_id, driver_id, address_id, total_amount, payment_method, status, created_at, assigned_at, updated_at, empty_cylinder_qty, empty_cylinder_status, sale_type, sales_from, agency_id)
      VALUES (?, NULL, ?, ?, ?, 'DELIVERED', NOW(), NOW(), NOW(), ?, 'DELIVERED', 'SALE', 'CASHIER', ?)
      `,
      [customerId, addressId, totalAmount, payment_method, totalQuantity, req.user.agency_id],
    );

    const saleId = saleResult.insertId;

    for (const [index, item] of parsedItems.entries()) {
      const sourceStockAreaId = deductedStockAreaIds[index] ?? null;

      await connection.execute(
        `
        INSERT INTO sales_items
          (sale_id, product_id, quantity, price, status, delivered_qty, empty_cylinder_qty, empty_cylinder_status, defective_qty, agency_id)
        VALUES (?, ?, ?, ?, 'DELIVERED', ?, ?, 'DELIVERED', 0, ?)
        `,
        [
          saleId,
          item.product_id,
          item.quantity,
          item.price,
          item.quantity,
          item.quantity,
          req.user.agency_id,
        ],
      );

      await connection.execute(
        `
        INSERT INTO stock_transactions
        (
          product_id,
          stock_area_id,
          type,
          quantity,
          isApproved,
          reference_id,
          created_by,
          driver_id,
          stock_from,
          is_defective,
          agency_id
        )
        VALUES (?, ?, 'ADJUSTMENT_SUBTRACT', ?, 1, ?, ?, NULL, 'godown', 0, ?)
        `,
        [
          item.product_id,
          sourceStockAreaId,
          item.quantity,
          saleId,
          cashierUserId,
          req.user.agency_id,
        ],
      );

      // Auto-raise empty cylinder return request to godown manager with sold quantity.
      await connection.execute(
        `
        INSERT INTO stock_transactions
        (
          product_id,
          stock_area_id,
          type,
          quantity,
          isApproved,
          reference_id,
          created_by,
          driver_id,
          stock_from,
          is_defective,
          agency_id
        )
        VALUES (?, NULL, 'EMPTY_RETURN', ?, 0, ?, ?, NULL, 'godown', 0, ?)
        `,
        [item.product_id, item.quantity, saleId, cashierUserId, req.user.agency_id],
      );
    }

    if (payments && payments.length > 0) {
      let sum = 0;
      for (const p of payments) {
        sum += Number(p.amount);
      }
      if (Math.abs(sum - totalAmount) > 0.01) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "Sum of split payments must equal the total amount",
        });
      }

      for (const p of payments) {
        if (Number(p.amount) > 0) {
          await connection.execute(
            `
            INSERT INTO payments
              (sale_id, amount, method, status, type, created_at, agency_id)
            VALUES (?, ?, ?, 'SUCCESS', 'COMPANY', NOW(), ?)
            `,
            [saleId, Number(p.amount), p.method || "CASH", req.user.agency_id],
          );
        }
      }
    } else if (payment_method === "PART_PAYMENT") {
      // Split a part payment into two payment rows: cash portion + bank/UTR portion.
      const rawCash = Number(req.body.cash_amount);
      const cashPart = Math.min(
        Math.max(Number.isFinite(rawCash) ? rawCash : 0, 0),
        totalAmount,
      );
      const bankPart = Math.max(totalAmount - cashPart, 0);

      if (cashPart > 0) {
        await connection.execute(
          `
          INSERT INTO payments
            (sale_id, amount, method, status, type, created_at, agency_id)
          VALUES (?, ?, 'CASH', 'SUCCESS', 'COMPANY', NOW(), ?)
          `,
          [saleId, cashPart, req.user.agency_id],
        );
      }

      if (bankPart > 0) {
        await connection.execute(
          `
          INSERT INTO payments
            (sale_id, amount, method, status, type, created_at, agency_id)
          VALUES (?, ?, 'UPI', 'SUCCESS', 'COMPANY', NOW(), ?)
          `,
          [saleId, bankPart, req.user.agency_id],
        );
      }

      // Guarantee at least one payment row exists (e.g. zero-value edge case).
      if (cashPart <= 0 && bankPart <= 0) {
        await connection.execute(
          `
          INSERT INTO payments
            (sale_id, amount, method, status, type, created_at, agency_id)
          VALUES (?, ?, 'CASH', 'SUCCESS', 'COMPANY', NOW(), ?)
          `,
          [saleId, 0, req.user.agency_id],
        );
      }
    } else {
      // payments.method only supports CASH/UPI/CARD; map anything else to UPI.
      const paymentMethodForRow = ["CASH", "UPI", "CARD"].includes(
        payment_method,
      )
        ? payment_method
        : "UPI";

      await connection.execute(
        `
        INSERT INTO payments
          (sale_id, amount, method, status, type, created_at, agency_id)
        VALUES (?, ?, ?, 'SUCCESS', 'COMPANY', NOW(), ?)
        `,
        [saleId, totalAmount, paymentMethodForRow, req.user.agency_id],
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Office sale created successfully",
      data: {
        saleId,
        totalAmount,
        customerId,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("recordOfficeSale error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create office sale",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getTodayOfficeSales = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    let startDate = DATE_ONLY.test(String(req.query.startDate || ""))
      ? String(req.query.startDate)
      : null;
    let endDate = DATE_ONLY.test(String(req.query.endDate || ""))
      ? String(req.query.endDate)
      : null;
    if (startDate && !endDate) endDate = startDate;
    if (endDate && !startDate) startDate = endDate;
    if (startDate && endDate && startDate > endDate) {
      const tmp = startDate;
      startDate = endDate;
      endDate = tmp;
    }
    const hasRange = Boolean(startDate && endDate);
    const dateClause = hasRange
      ? "AND DATE(s.created_at) BETWEEN ? AND ?"
      : "AND DATE(s.created_at) = CURDATE()";
    const queryParams = [req.user.agency_id];
    if (hasRange) {
      queryParams.push(startDate, endDate);
    }

    const [rows] = await connection.query(
      `
      SELECT
        s.id,
        CONCAT('B-', LPAD(s.id, 4, '0')) AS billId,
        COALESCE(u.name, 'Walk-in') AS customer,
        COALESCE(GROUP_CONCAT(CONCAT(p.name, ' x', si.quantity) SEPARATOR ', '), '') AS notes,
        s.total_amount AS amount
      FROM sales s
      LEFT JOIN users u ON u.id = s.customer_id
      LEFT JOIN sales_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      WHERE s.sales_from = 'CASHIER' AND s.agency_id = ?
        ${dateClause}
      GROUP BY s.id, u.name, s.total_amount
      ORDER BY s.created_at DESC
      `,
      queryParams,
    );

    return res.status(200).json({
      success: true,
      data: rows.map((row) => ({
        billId: row.billId,
        customer: row.customer,
        notes: row.notes,
        amount: Number(row.amount || 0),
      })),
    });
  } catch (error) {
    console.error("getTodayOfficeSales error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch today office sales",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const recordOfficeExpense = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      category,
      amount,
      description,
      bill_url: billUrl,
      payment_mode: rawPaymentMode,
      payment_method: rawPaymentMethod,
      transaction_id: rawTransactionId,
      payment_reference: rawPaymentReference,
    } = req.body;
    const rawAdminId = req.user?.id;

    if (!rawAdminId && !req.user?.agency_id) {
      return res
        .status(400)
        .json({
          success: false,
          message: "admin_id is required. Please ensure you are logged in.",
        });
    }

    const adminId = await resolveValidUserId(
      connection,
      rawAdminId,
      req.user?.agency_id,
      req.user?.role || "CASHIER",
    );

    if (!category || amount === undefined) {
      return res
        .status(400)
        .json({ success: false, message: "category and amount are required" });
    }

    const numericAmount = Number(amount);
    if (Number.isNaN(numericAmount) || numericAmount < 0) {
      return res.status(400).json({
        success: false,
        message: "amount must be a non-negative number",
      });
    }

    const validPaymentModes = ["CASH", "UPI", "CARD", "BANK_TRANSFER"];
    const paymentMode = String(rawPaymentMode || rawPaymentMethod || "CASH")
      .trim()
      .toUpperCase();
    if (!validPaymentModes.includes(paymentMode)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid payment mode" });
    }

    const paymentReference = String(
      rawTransactionId || rawPaymentReference || "",
    ).trim();
    if (paymentMode !== "CASH" && !paymentReference) {
      return res.status(400).json({
        success: false,
        message: "Transaction ID is required for non-cash payments",
      });
    }

    // A cash payout can never exceed the cash currently in the drawer.
    if (paymentMode === "CASH") {
      const availableCash = await getAvailableCashBalance(
        connection,
        req.user?.agency_id || 1,
      );
      if (numericAmount > availableCash) {
        return res.status(400).json({
          success: false,
          message: `Insufficient cash balance. Available ₹${availableCash.toLocaleString("en-IN")}, expense ₹${numericAmount.toLocaleString("en-IN")}. Pay via UPI/Card/Bank Transfer or reduce the amount.`,
          availableCash,
          requestedAmount: numericAmount,
        });
      }
    }

    // Ensure a receipt column exists so the uploaded bill can be persisted.
    const [billColumns] = await connection.query(
      `SHOW COLUMNS FROM office_expenses LIKE 'bill_url'`,
    );
    let hasBillUrl = billColumns.length > 0;
    if (!hasBillUrl && billUrl) {
      try {
        await connection.query(
          `ALTER TABLE office_expenses ADD COLUMN bill_url TEXT NULL`,
        );
        hasBillUrl = true;
      } catch (alterError) {
        console.warn(
          "Could not add bill_url column to office_expenses:",
          alterError.message,
        );
      }
    }

    // Ensure the payment columns exist so mode + reference can be persisted.
    await ensureOfficeExpensePaymentColumns(connection);

    const extraCols = `${hasBillUrl ? ", bill_url" : ""}, payment_mode, payment_reference, agency_id`;
    const extraPlaceholder = `${hasBillUrl ? ", ?" : ""}, ?, ?, ?`;
    const billParams = hasBillUrl ? [billUrl || null] : [];
    const paymentParams = [paymentMode, paymentReference || null, req.user.agency_id];

    const executeInsert = async (withStatus, effectiveAdminId) => {
      const currentBaseParams = [effectiveAdminId, category, numericAmount, description || null];
      const statusSql = withStatus ? ", status" : "";
      const statusVal = withStatus ? ", 'APPROVED'" : "";
      return connection.execute(
        `
        INSERT INTO office_expenses (admin_id, category, amount, description${extraCols}${statusSql}, created_at, updated_at)
        VALUES (?, ?, ?, ?${extraPlaceholder}${statusVal}, NOW(), NOW())
        `,
        [...currentBaseParams, ...billParams, ...paymentParams],
      );
    };

    let result;

    try {
      [result] = await executeInsert(true, adminId);
    } catch (queryError) {
      const isBadField = queryError?.code === "ER_BAD_FIELD_ERROR";
      const isFkError =
        queryError?.code === "ER_NO_REFERENCED_ROW_2" || queryError?.errno === 1452;

      if (isFkError) {
        console.warn(
          "office_expenses foreign key constraint failed on admin_id. Retrying with admin_id = null:",
          queryError.message,
        );
        try {
          [result] = await executeInsert(true, null);
        } catch (retryErr) {
          if (retryErr?.code === "ER_BAD_FIELD_ERROR") {
            [result] = await executeInsert(false, null);
          } else {
            throw retryErr;
          }
        }
      } else if (isBadField) {
        try {
          [result] = await executeInsert(false, adminId);
        } catch (retryErr) {
          if (retryErr?.code === "ER_NO_REFERENCED_ROW_2" || retryErr?.errno === 1452) {
            [result] = await executeInsert(false, null);
          } else {
            throw retryErr;
          }
        }
      } else {
        throw queryError;
      }
    }

    return res.status(201).json({
      success: true,
      message: "Office expense recorded",
      expenseId: result.insertId,
    });
  } catch (error) {
    console.error("recordOfficeExpense error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to record office expense",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getTodayOfficeExpenses = async (req, res) => {
  const connection = await db.getConnection();

  try {
    let rows;

    try {
      [rows] = await connection.query(
        `
        SELECT
          o.id,
          o.category,
          o.description,
          o.amount,
          o.payment_mode,
          o.payment_reference,
          DATE_FORMAT(o.created_at, '%Y-%m-%d') AS date,
          COALESCE(u.name, 'Unknown') AS createdBy,
          COALESCE(o.status, 'PENDING') AS status
        FROM office_expenses o
        LEFT JOIN users u ON u.id = o.admin_id
        WHERE DATE(o.created_at) = CURDATE() AND o.agency_id = ?
        ORDER BY o.created_at DESC
        `,
        [req.user.agency_id]
      );
    } catch (queryError) {
      if (queryError?.code !== "ER_BAD_FIELD_ERROR") {
        throw queryError;
      }

      [rows] = await connection.query(
        `
        SELECT
          o.id,
          o.category,
          o.description,
          o.amount,
          DATE_FORMAT(o.created_at, '%Y-%m-%d') AS date,
          COALESCE(u.name, 'Unknown') AS createdBy
        FROM office_expenses o
        LEFT JOIN users u ON u.id = o.admin_id
        WHERE DATE(o.created_at) = CURDATE() AND o.agency_id = ?
        ORDER BY o.created_at DESC
        `,
        [req.user.agency_id]
      );
    }

    return res.status(200).json({
      success: true,
      data: rows.map((r) => ({
        id: `OE-${String(r.id).padStart(3, "0")}`,
        category: r.category,
        description: r.description,
        amount: Number(r.amount || 0),
        paymentMode: r.payment_mode || null,
        paymentReference: r.payment_reference || null,
        date: r.date,
        by: r.createdBy,
        status: r.status || "PENDING",
      })),
    });
  } catch (error) {
    console.error("getTodayOfficeExpenses error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch today office expenses",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getCashOutExpenseRequests = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    let startDate = DATE_ONLY.test(String(req.query.startDate || ""))
      ? String(req.query.startDate)
      : null;
    let endDate = DATE_ONLY.test(String(req.query.endDate || ""))
      ? String(req.query.endDate)
      : null;
    if (startDate && !endDate) endDate = startDate;
    if (endDate && !startDate) startDate = endDate;
    if (startDate && endDate && startDate > endDate) {
      const tmp = startDate;
      startDate = endDate;
      endDate = tmp;
    }
    const hasRange = Boolean(startDate && endDate);
    const dateClause = hasRange ? "AND DATE(e.created_at) BETWEEN ? AND ?" : "";
    const queryParams = hasRange ? [startDate, endDate] : [];

    const [summaryRows] = await connection.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN e.status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pendingApprovals,
        COALESCE(SUM(CASE WHEN e.status = 'APPROVED' AND DATE(e.created_at) = CURDATE() THEN e.amount ELSE 0 END), 0) AS approvedToday
      FROM expenses e
      INNER JOIN users u ON u.id = e.created_by
      WHERE u.role = 'PURCHASE_MANAGER' AND e.agency_id = ?
      `,
      [req.user.agency_id, ...queryParams],
    );

    const [rows] = await connection.query(
      `
      SELECT
        e.id,
        e.category,
        e.description,
        e.amount,
        e.bill_url,
        e.status,
        e.created_at,
        u.name AS created_by_name,
        pt.id AS trip_id,
        pt.odometer_reading,
        pt.end_odometer_reading,
        pt.odometer_image_url,
        pt.end_odometer_image_url,
        pt.started_at,
        pt.ended_at
      FROM expenses e
      INNER JOIN users u ON u.id = e.created_by
      ${purchaseExpenseTripJoin}
      WHERE u.role = 'PURCHASE_MANAGER'
        AND e.status = 'PENDING'
        AND e.agency_id = ?
      ORDER BY e.created_at DESC, e.id DESC
      `,
      [req.user.agency_id]
    );

    return res.status(200).json({
      success: true,
      summary: {
        pendingApprovals: Number(summaryRows[0]?.pendingApprovals || 0),
        approvedToday: Number(summaryRows[0]?.approvedToday || 0),
      },
      data: rows.map((row) => ({
        id: row.id,
        category: row.category,
        description: row.description,
        amount: Number(row.amount || 0),
        billUrl: row.bill_url,
        status: row.status,
        createdAt: row.created_at,
        createdByName: row.created_by_name,
        tripId: row.trip_id,
        startOdometerReading: Number(row.odometer_reading || 0),
        endOdometerReading: row.end_odometer_reading
          ? Number(row.end_odometer_reading)
          : null,
        startOdometerImageUrl: row.odometer_image_url,
        endOdometerImageUrl: row.end_odometer_image_url,
        tripStartedAt: row.started_at,
        tripEndedAt: row.ended_at,
      })),
    });
  } catch (error) {
    console.error("getCashOutExpenseRequests error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch expense requests",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const reviewCashOutExpenseRequest = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const expenseId = Number(req.params.expenseId);
    const status = String(req.body?.status || "").toUpperCase();
    const rawPaymentMode = String(
      req.body?.paymentMode || req.body?.payment_method || "",
    )
      .trim()
      .toUpperCase();
    const rawTransactionId = String(
      req.body?.transactionId || req.body?.transaction_id || "",
    ).trim();

    if (!expenseId || !["APPROVED", "REJECTED"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "expenseId and a valid status are required",
      });
    }

    const validPaymentModes = ["CASH", "UPI", "CARD", "BANK_TRANSFER"];
    const paymentMode = status === "APPROVED" ? rawPaymentMode || "CASH" : null;
    const transactionId = status === "APPROVED" ? rawTransactionId : null;

    if (status === "APPROVED" && !validPaymentModes.includes(paymentMode)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment mode",
      });
    }

    if (status === "APPROVED" && paymentMode !== "CASH" && !transactionId) {
      return res.status(400).json({
        success: false,
        message: "Transaction ID is required for non-cash payments",
      });
    }

    await ensureExpensePaymentColumns(connection);

    const [rows] = await connection.query(
      `
      SELECT e.id, e.status, e.description, e.amount
      FROM expenses e
      INNER JOIN users u ON u.id = e.created_by
      WHERE e.id = ?
        AND u.role = 'PURCHASE_MANAGER'
        AND e.agency_id = ?
      LIMIT 1
      `,
      [expenseId, req.user.agency_id],
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Expense request not found",
      });
    }

    if (rows[0].status !== "PENDING") {
      return res.status(400).json({
        success: false,
        message: "Only pending expense requests can be reviewed",
      });
    }

    // A cash payout can never exceed the cash currently in the drawer.
    if (status === "APPROVED" && paymentMode === "CASH") {
      const expenseAmount = Number(rows[0].amount || 0);
      const availableCash = await getAvailableCashBalance(
        connection,
        req.user?.agency_id || 1,
      );
      if (expenseAmount > availableCash) {
        return res.status(400).json({
          success: false,
          message: `Insufficient cash balance. Available ₹${availableCash.toLocaleString("en-IN")}, expense ₹${expenseAmount.toLocaleString("en-IN")}. Pay via UPI/Card/Bank Transfer or reduce the amount.`,
          availableCash,
          requestedAmount: expenseAmount,
        });
      }
    }

    let savedViaColumns = false;

    try {
      if (status === "APPROVED") {
        await connection.query(
          `
          UPDATE expenses
          SET status = ?,
              payment_mode = ?,
              payment_reference = ?
          WHERE id = ? AND agency_id = ?
          `,
          [status, paymentMode, transactionId || null, expenseId, req.user.agency_id],
        );
      } else {
        await connection.query(
          `
          UPDATE expenses
          SET status = ?
          WHERE id = ? AND agency_id = ?
          `,
          [status, expenseId, req.user.agency_id],
        );
      }

      savedViaColumns = true;
    } catch (queryError) {
      // Keep compatibility with environments where migration is not yet applied.
      if (queryError?.code !== "ER_BAD_FIELD_ERROR") {
        throw queryError;
      }

      if (status === "APPROVED") {
        const existingDescription = rows[0]?.description
          ? String(rows[0].description).trim()
          : "";
        const paymentTag = `[Payment: ${paymentMode}${transactionId ? ` | ${transactionId}` : ""}]`;
        const nextDescription = [existingDescription, paymentTag]
          .filter(Boolean)
          .join(" ");

        await connection.query(
          `
          UPDATE expenses
          SET status = ?,
              description = ?
          WHERE id = ? AND agency_id = ?
          `,
          [status, nextDescription, expenseId, req.user.agency_id],
        );
      } else {
        await connection.query(
          `
          UPDATE expenses
          SET status = ?
          WHERE id = ? AND agency_id = ?
          `,
          [status, expenseId, req.user.agency_id],
        );
      }
    }

    return res.status(200).json({
      success: true,
      message:
        status === "APPROVED"
          ? "Expense approved successfully"
          : "Expense rejected successfully",
      paymentSavedInColumns: savedViaColumns,
    });
  } catch (error) {
    console.error("reviewCashOutExpenseRequest error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to review expense request",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const recordCashierReceipt = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { customer_id, amount, payment_method, receipt_type, notes } =
      req.body;

    if (!customer_id || !amount || !payment_method) {
      return res.status(400).json({
        success: false,
        message: "customer_id, amount and payment_method are required",
      });
    }

    await connection.beginTransaction();

    const [saleResult] = await connection.execute(
      `
      INSERT INTO sales
        (customer_id, driver_id, total_amount, payment_method, status, address_id, created_at, assigned_at, updated_at, sale_type, sales_from, agency_id)
      VALUES
        (?, NULL, ?, ?, 'DELIVERED', NULL, NOW(), NOW(), NOW(), 'SALE', 'CASHIER', ?)
      `,
      [customer_id, amount, payment_method, req.user.agency_id],
    );

    const saleId = saleResult.insertId;

    await connection.execute(
      `
      INSERT INTO payments
        (sale_id, amount, method, status, type, created_at, agency_id)
      VALUES
        (?, ?, ?, 'SUCCESS', ?, NOW(), ?)
      `,
      [saleId, amount, payment_method, receipt_type || "COMPANY", req.user.agency_id],
    );

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Cashier receipt recorded successfully",
      saleId,
    });
  } catch (error) {
    await connection.rollback();
    console.error("recordCashierReceipt error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to record cashier receipt",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

// ---------------------------------------------------------------------------
// Cash In → "Other Receipts": advances, due collections and miscellaneous cash
// the cashier takes in over the counter. These have no customer/sale attached,
// so they live in their own table rather than being faked as a sale.
// ---------------------------------------------------------------------------

const RECEIPT_TYPES = ["ADVANCE", "DUE_COLLECTION", "OTHER"];
const RECEIPT_PAYMENT_MODES = ["CASH", "UPI", "BANK_TRANSFER", "CARD"];

const RECEIPT_TYPE_LABELS = {
  ADVANCE: "ADVANCE",
  DUE_COLLECTION: "DUE COLLECTION",
  OTHER: "OTHER",
};

const RECEIPT_PAYMENT_MODE_LABELS = {
  CASH: "Cash",
  UPI: "UPI",
  BANK_TRANSFER: "Bank Transfer",
  CARD: "Card",
};

// Accepts what the UI sends in any casing/spacing - "Due Collection",
// "due-collection", "DUE_COLLECTION" all normalise to DUE_COLLECTION.
const normalizeReceiptEnum = (value) =>
  String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

const ensureCashierReceiptsTable = async (connection) => {
  if (cashierReceiptsTableEnsured) return;
  await connection.query(`
    CREATE TABLE IF NOT EXISTS cashier_receipts (
      id INT NOT NULL AUTO_INCREMENT,
      cashier_id INT NULL,
      receipt_type ENUM('ADVANCE','DUE_COLLECTION','OTHER') NOT NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      description VARCHAR(255) NULL,
      payment_mode ENUM('CASH','UPI','BANK_TRANSFER','CARD') NOT NULL DEFAULT 'CASH',
      transfer_id VARCHAR(255) NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_cashier_receipts_created_at (created_at),
      KEY idx_cashier_receipts_type (receipt_type),
      KEY idx_cashier_receipts_cashier (cashier_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  cashierReceiptsTableEnsured = true;
};

const mapReceiptRow = (row) => ({
  id: Number(row.id),
  type: row.receipt_type,
  typeLabel: RECEIPT_TYPE_LABELS[row.receipt_type] || row.receipt_type,
  amount: Number(row.amount || 0),
  description: row.description || null,
  paymentMode: row.payment_mode,
  paymentModeLabel:
    RECEIPT_PAYMENT_MODE_LABELS[row.payment_mode] || row.payment_mode,
  transferId: row.transfer_id || null,
  createdAt: row.created_at,
  date: row.date,
});

// POST /api/cashier/receipts - "+ Add Receipt"
export const createCashierReceipt = async (req, res) => {
  const {
    type,
    receipt_type,
    amount,
    description,
    payment_mode,
    paymentMode,
    transfer_id,
    transferId,
    payments = null,
  } = req.body || {};

  const normalizedType = normalizeReceiptEnum(type ?? receipt_type);

  if (!RECEIPT_TYPES.includes(normalizedType)) {
    return res.status(400).json({
      success: false,
      message: `type must be one of ${RECEIPT_TYPES.join(", ")}`,
    });
  }

  const numericAmount = Number(amount);

  if (
    amount === undefined ||
    amount === null ||
    amount === "" ||
    Number.isNaN(numericAmount)
  ) {
    return res.status(400).json({
      success: false,
      message: "amount is required and must be a valid number",
    });
  }

  if (numericAmount <= 0) {
    return res.status(400).json({
      success: false,
      message: "amount must be greater than 0",
    });
  }

  // Payment mode defaults to Cash, matching the form's default selection.
  let rawMode = payment_mode ?? paymentMode;
  let splitPaymentsJson = null;

  if (payments && payments.length > 0) {
    let sum = 0;
    for (const p of payments) {
      sum += Number(p.amount);
    }
    if (Math.abs(sum - Number(amount)) > 0.01) {
      return res.status(400).json({
        success: false,
        message: "Sum of split payments must equal the total amount",
      });
    }
    rawMode = "SPLIT";
    splitPaymentsJson = JSON.stringify(payments);
  }

  const normalizedMode =
    rawMode === "SPLIT"
      ? "SPLIT"
      : rawMode
        ? normalizeReceiptEnum(rawMode)
        : "CASH";

  if (
    normalizedMode !== "SPLIT" &&
    !RECEIPT_PAYMENT_MODES.includes(normalizedMode)
  ) {
    return res.status(400).json({
      success: false,
      message: `payment_mode must be one of ${RECEIPT_PAYMENT_MODES.join(", ")}`,
    });
  }

  const connection = await db.getConnection();

  try {
    await ensureCashierReceiptsTable(connection);
    await ensureSplitPaymentsColumns(connection);

    const cashierId = await resolveValidUserId(
      connection,
      req.user?.id,
      req.user?.agency_id,
      "CASHIER",
    );
    const trimmedDescription = String(description || "").trim() || null;
    const trimmedTransferId =
      String(transfer_id ?? transferId ?? "").trim() || null;

    const [result] = await connection.execute(
      `
      INSERT INTO cashier_receipts (
        cashier_id,
        receipt_type,
        amount,
        description,
        payment_mode,
        split_payments,
        transfer_id,
        created_at,
        updated_at,
        agency_id
      )
      VALUES (
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        NOW(),
        NOW(),
        ?
      )
      `,
      [
        cashierId,
        normalizedType,
        numericAmount,
        trimmedDescription,
        normalizedMode,
        splitPaymentsJson,
        trimmedTransferId,
        req.user.agency_id,
      ],
    );

    return res.status(201).json({
      success: true,
      message: "Receipt added successfully",
      data: {
        id: result.insertId,
        type: normalizedType,
        typeLabel: RECEIPT_TYPE_LABELS[normalizedType],
        amount: numericAmount,
        description: trimmedDescription,
        paymentMode: normalizedMode,
        paymentModeLabel: RECEIPT_PAYMENT_MODE_LABELS[normalizedMode],
        transferId: trimmedTransferId,
      },
    });
  } catch (error) {
    console.error("createCashierReceipt error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to add receipt",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

// GET /api/cashier/receipts/recent - the "Recent Receipts / Today" list.
// Defaults to today; pass startDate/endDate (YYYY-MM-DD) for any other window
// and limit (1-100) to change how many rows come back.
export const getRecentCashierReceipts = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureCashierReceiptsTable(connection);

    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    let startDate = DATE_ONLY.test(String(req.query.startDate || ""))
      ? String(req.query.startDate)
      : null;
    let endDate = DATE_ONLY.test(String(req.query.endDate || ""))
      ? String(req.query.endDate)
      : null;

    if (startDate && !endDate) endDate = startDate;
    if (endDate && !startDate) startDate = endDate;
    if (startDate && endDate && startDate > endDate) {
      const tmp = startDate;
      startDate = endDate;
      endDate = tmp;
    }

    // No explicit range => today, which is what the panel shows by default.
    const whereClause = startDate
      ? "WHERE DATE(created_at) BETWEEN ? AND ? AND agency_id = ?"
      : "WHERE DATE(created_at) = CURDATE() AND agency_id = ?";
    const whereParams = startDate ? [startDate, endDate, req.user.agency_id] : [req.user.agency_id];

    const requestedLimit = Number(req.query.limit);
    const limit =
      Number.isInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 100)
        : 20;

    const [rows] = await connection.query(
      `
      SELECT
        id,
        receipt_type,
        amount,
        description,
        payment_mode,
        transfer_id,
        created_at,
        DATE_FORMAT(created_at, '%Y-%m-%d') AS date
      FROM cashier_receipts
      ${whereClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
      `,
      whereParams,
    );

    const receipts = rows.map(mapReceiptRow);

    return res.status(200).json({
      success: true,
      data: receipts,
      summary: {
        count: receipts.length,
        totalAmount: receipts.reduce((sum, item) => sum + item.amount, 0),
      },
    });
  } catch (error) {
    console.error("getRecentCashierReceipts error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch recent receipts",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getTodaysCashFlow = async (req, res) => {
  const connection = await db.getConnection();
  const { date } = req.query;

  try {
    let openingBalance = 0;
    let anchorCond;

    if (date) {
      const [rows] = await connection.query(
        `SELECT total_cash, petty_cash FROM cashier_closings WHERE agency_id = ? AND DATE(created_at) < ? ORDER BY id DESC LIMIT 1`,
        [req.user.agency_id, date]
      );
      openingBalance = rows.length ? Number(rows[0].petty_cash ?? rows[0].total_cash ?? 0) : 0;
      
      anchorCond = (dateExpr) => {
        return { sql: `AND DATE(${dateExpr}) = ?`, params: [date] };
      };
    } else {
      const dayIsOpen = await isCashierDayOpen(connection, req.user.agency_id);
      const latestClosing = await getLatestClosing(connection, req.user.agency_id);

      if (dayIsOpen) {
        const dayOpening = await getCurrentDayOpeningBalance(connection, req.user.agency_id);
        openingBalance = Number(dayOpening || 0);
      } else {
        // Day is closed: in-office petty cash retained from the last close remains under custody
        openingBalance = Number(latestClosing?.pettyCash || 0);
      }

      // Everything for the current running day, anchored at the latest of last close / last start.
      const anchorAt = await getCurrentDayAnchor(connection, req.user.agency_id);
      anchorCond = makeSinceCloseDateCond(anchorAt);
    }

    const ledger = await getCashLedger(
      connection,
      anchorCond,
      req.user.agency_id
    );

    // Inflow = CASH received for the current running day (cash only, per spec).
    const inflowCashTotal = ledger.cashIn.cash;
    const inflowUpiTotal = ledger.cashIn.online;
    const inflowBankTotal = ledger.cashIn.bank;
    const inflowTotal = inflowCashTotal;
    const inflowCount = ledger.cashIn.count;

    // Outflow = APPROVED cash paid out since the last close.
    const outflowCashTotal = ledger.cashOut.cash;
    const outflowUpiTotal = ledger.cashOut.online;
    const outflowBankTotal = ledger.cashOut.bank;
    const outflowTotal = outflowCashTotal;
    const outflowCount = ledger.cashOut.count;

    // Current cash balance = opening cash + cash in − cash out.
    const currentBalance = openingBalance + inflowCashTotal - outflowCashTotal;

    return res.status(200).json({
      success: true,
      openingBalance,
      inflow: {
        total: inflowTotal,
        count: inflowCount,
        cashTotal: inflowCashTotal,
        onlineTotal: inflowUpiTotal,
        bankTotal: inflowBankTotal,
      },
      outflow: {
        total: outflowTotal,
        count: outflowCount,
        cashTotal: outflowCashTotal,
        onlineTotal: outflowUpiTotal,
        bankTotal: outflowBankTotal,
      },
      cashInflow: inflowCashTotal,
      cashOutflow: outflowCashTotal,
      currentBalance,
      breakdown: {
        cash: inflowCashTotal,
        online: inflowUpiTotal,
        bank: inflowBankTotal,
      },
      outflowBreakdown: {
        cash: outflowCashTotal,
        online: outflowUpiTotal,
        bank: outflowBankTotal,
      },
    });
  } catch (error) {
    console.error("getTodaysCashFlow error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch todays cash flow",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const findCustomerForCashierApp = async (req, res) => {
  try {
    const { query } = req.query;

    if (!query || !String(query).trim()) {
      return res.status(400).json({
        success: false,
        message: "query is required",
      });
    }

    const searchValue = String(query).trim();
    const likeValue = `%${searchValue}%`;
    const numericId = Number(searchValue);

    const [rows] = await db.execute(
      `
      SELECT
        u.id,
        u.name,
        u.phone,
        u.email,
        (
          SELECT a.address
          FROM addresses a
          WHERE a.user_id = u.id
          ORDER BY a.is_default DESC, a.id DESC
          LIMIT 1
        ) AS address
      FROM users u
      WHERE u.role = 'CUSTOMER'
        AND u.agency_id = ?
        AND (
          u.name LIKE ?
          OR u.phone LIKE ?
          ${!Number.isNaN(numericId) ? "OR u.id = ?" : ""}
        )
      ORDER BY u.name ASC
      LIMIT 20
      `,
      !Number.isNaN(numericId)
        ? [req.user.agency_id, likeValue, likeValue, numericId]
        : [req.user.agency_id, likeValue, likeValue],
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Customers fetched successfully",
      data: rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        phone: row.phone,
        email: row.email,
        address: row.address || "",
      })),
    });
  } catch (error) {
    console.error("findCustomerForCashierApp error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to find customers",
      error: error.message,
    });
  }
};

export const getCashFlowEntriesByDate = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { date } = req.query;
    if (!date) {
      return res
        .status(400)
        .json({ success: false, message: "date query parameter is required" });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format. Use YYYY-MM-DD",
      });
    }

    const summary = await getCashLedger(
      connection,
      makeRangeDateCond(date, date),
      req.user.agency_id
    );

    const schemaInfo = await getSchemaColumnPresence(connection);
    const ePaymentMode = schemaInfo.hasExpensePaymentMode ? "e.payment_mode" : "NULL";
    const oePaymentMode = schemaInfo.hasOfficeExpensePaymentMode ? "oe.payment_mode" : "NULL";
    const oeStatusFilter = schemaInfo.hasOfficeExpenseStatus ? "AND oe.status = 'APPROVED'" : "";

    const query = `
      SELECT 
        'DRIVER_SETTLEMENT' as type,
        sh.id as reference_id,
        sh.amount,
        CASE 
          WHEN s.payment_method IN ('UPI', 'ONLINE') THEN s.payment_method
          WHEN sh.method IN ('UPI', 'ONLINE', 'CARD') THEN sh.method
          ELSE 'CASH'
        END as payment_mode,
        'IN' as direction,
        COALESCE(sh.settled_at, sh.created_at) as timestamp,
        'Driver Collection Settlement' as description,
        COALESCE(u.name, 'Driver') as source
      FROM settlement_history sh
      LEFT JOIN sales s ON s.id = sh.sale_id
      LEFT JOIN drivers d ON d.id = sh.driver_id
      LEFT JOIN users u ON u.id = d.user_id
      WHERE sh.status = 'SETTLED' AND DATE(COALESCE(sh.settled_at, sh.created_at)) = ? AND sh.agency_id = ?

      UNION ALL

      SELECT 
        'OFFICE_SALE' as type,
        p.id as reference_id,
        p.amount,
        p.method as payment_mode,
        'IN' as direction,
        p.created_at as timestamp,
        'Office Sale Payment' as description,
        COALESCE(cu.name, 'Customer') as source
      FROM payments p
      INNER JOIN sales s ON s.id = p.sale_id
      LEFT JOIN users cu ON cu.id = s.customer_id
      WHERE p.status = 'SUCCESS' AND s.sales_from = 'CASHIER' AND DATE(p.created_at) = ? AND p.agency_id = ?

      UNION ALL

      SELECT 
        'PR_PENALTY' as type,
        pr.id as reference_id,
        pr.penalty_amount as amount,
        pr.payment_mode,
        'IN' as direction,
        pr.paid_at as timestamp,
        'PR Penalty Collection' as description,
        COALESCE(u.name, 'Customer') as source
      FROM customer_pr_penalties pr
      LEFT JOIN users u ON u.id = pr.customer_id
      WHERE pr.payment_status = 'PAID' AND DATE(pr.paid_at) = ? AND pr.agency_id = ?

      UNION ALL

      SELECT 
        'NAME_CHANGE' as type,
        nc.id as reference_id,
        nc.service_fee as amount,
        nc.payment_mode,
        'IN' as direction,
        nc.approved_at as timestamp,
        'Name Change Request Fee' as description,
        COALESCE(u.name, 'Customer') as source
      FROM customer_name_change_requests nc
      LEFT JOIN users u ON u.id = nc.customer_id
      WHERE nc.status = 'APPROVED' AND DATE(nc.approved_at) = ? AND nc.agency_id = ?

      UNION ALL

      SELECT 
        'NEW_CONNECTION' as type,
        cnc.id as reference_id,
        cnc.total_amount as amount,
        cnc.payment_mode,
        'IN' as direction,
        cnc.paid_at as timestamp,
        'New Connection Payment' as description,
        COALESCE(u.name, 'Customer') as source
      FROM customer_new_connections cnc
      LEFT JOIN users u ON u.id = cnc.user_id
      WHERE cnc.payment_status = 'PAID' AND DATE(cnc.paid_at) = ? AND cnc.agency_id = ?

      UNION ALL

      SELECT 
        'CASHIER_RECEIPT' as type,
        cr.id as reference_id,
        cr.amount,
        cr.payment_mode,
        'IN' as direction,
        cr.created_at as timestamp,
        COALESCE(cr.description, 'Cashier Other Receipt') as description,
        COALESCE(cr.receipt_type, 'Receipt') as source
      FROM cashier_receipts cr
      WHERE DATE(cr.created_at) = ? AND cr.agency_id = ?

      UNION ALL

      SELECT 
        'DRIVER_PURCHASE_EXPENSE' as type,
        e.id as reference_id,
        e.amount,
        ${ePaymentMode} as payment_mode,
        'OUT' as direction,
        e.created_at as timestamp,
        e.description as description,
        COALESCE(u.name, 'Staff') as source
      FROM expenses e
      LEFT JOIN users u ON u.id = e.created_by
      WHERE e.status = 'APPROVED' AND DATE(e.created_at) = ? AND e.agency_id = ?

      UNION ALL

      SELECT 
        'OFFICE_EXPENSE' as type,
        oe.id as reference_id,
        oe.amount,
        ${oePaymentMode} as payment_mode,
        'OUT' as direction,
        COALESCE(oe.created_at, oe.updated_at) as timestamp,
        oe.description as description,
        COALESCE(oe.category, 'Office Expense') as source
      FROM office_expenses oe
      WHERE DATE(COALESCE(oe.created_at, oe.updated_at)) = ? AND oe.agency_id = ? ${oeStatusFilter}

      UNION ALL

      SELECT 
        'TRANSFER_VOUCHER' as type,
        t.id as reference_id,
        t.deposit_liability as amount,
        t.payment_mode,
        'OUT' as direction,
        t.updated_at as timestamp,
        'Transfer Voucher Deposit Refund' as description,
        COALESCE(u.name, 'Customer') as source
      FROM customer_connection_transfers t
      LEFT JOIN users u ON u.id = t.existing_customer_id
      WHERE t.status = 'APPROVED' AND DATE(t.updated_at) = ? AND t.agency_id = ?

      ORDER BY timestamp DESC
    `;

    const params = [
      date, req.user.agency_id,
      date, req.user.agency_id,
      date, req.user.agency_id,
      date, req.user.agency_id,
      date, req.user.agency_id,
      date, req.user.agency_id,
      date, req.user.agency_id,
      date, req.user.agency_id,
      date, req.user.agency_id
    ];
    const [entries] = await connection.query(query, params);

    return res.status(200).json({
      success: true,
      date,
      summary,
      entries,
    });
  } catch (error) {
    console.error("getCashFlowEntriesByDate error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch cash flow entries by date",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
