import db from "../config/db.js";

const DEFAULT_STOCK_AREA_ID = 1;

const LOAD_STATUS = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  REJECTED: "REJECTED",
  COMPLETED: "COMPLETED",
};

// Stock-transaction approval markers, matching the convention used across the
// godown stock-out flow (0 = pending/reserved, 1 = approved/finalized,
// 2 = cancelled/voided).
const TXN_PENDING = 0;
const TXN_APPROVED = 1;
const TXN_VOID = 2;

// --- Small stock helpers (replicated from godownController's private helpers so
// this parallel flow does not have to modify the existing controller). ---

const getAvailableEmptyForUpdate = async (connection, productId, agencyId) => {
  const [rows] = await connection.execute(
    `
    SELECT COALESCE(SUM(empty_quantity), 0) AS total
    FROM stock
    WHERE product_id = ? AND agency_id = ?
    FOR UPDATE
    `,
    [Number(productId), agencyId]
  );

  return Number(rows[0]?.total || 0);
};

const getAvailableDefectiveForUpdate = async (connection, productId, agencyId) => {
  const [rows] = await connection.execute(
    `
    SELECT COALESCE(SUM(defective_quantity), 0) AS total
    FROM stock
    WHERE product_id = ? AND agency_id = ?
    FOR UPDATE
    `,
    [Number(productId), agencyId]
  );

  return Number(rows[0]?.total || 0);
};

// Reserve (deduct) empty cylinders from the godown's available empty stock.
const consumeEmptyStock = async (connection, productId, requiredQty, agencyId) => {
  let remaining = Number(requiredQty || 0);

  if (remaining <= 0) {
    return;
  }

  const [rows] = await connection.execute(
    `
    SELECT id, COALESCE(empty_quantity, 0) AS metric_qty
    FROM stock
    WHERE product_id = ? AND agency_id = ?
    ORDER BY (stock_area_id = ?) DESC, id ASC
    FOR UPDATE
    `,
    [Number(productId), agencyId, DEFAULT_STOCK_AREA_ID]
  );

  for (const row of rows) {
    if (remaining <= 0) {
      break;
    }

    const currentQty = Number(row.metric_qty || 0);

    if (currentQty <= 0) {
      continue;
    }

    const deductQty = Math.min(currentQty, remaining);

    await connection.execute(
      `
      UPDATE stock
      SET empty_quantity = GREATEST(COALESCE(empty_quantity, 0) - ?, 0),
          system_empty_quantity = GREATEST(COALESCE(system_empty_quantity, 0) - ?, 0),
          updated_at = NOW()
      WHERE id = ?
      `,
      [deductQty, deductQty, row.id]
    );

    remaining -= deductQty;
  }
};

// Reserve (deduct) defective cylinders from the godown's available defective stock.
const consumeDefectiveStock = async (connection, productId, requiredQty, agencyId) => {
  let remaining = Number(requiredQty || 0);

  if (remaining <= 0) {
    return;
  }

  const [rows] = await connection.execute(
    `
    SELECT id, COALESCE(defective_quantity, 0) AS metric_qty
    FROM stock
    WHERE product_id = ? AND agency_id = ?
    ORDER BY (stock_area_id = ?) DESC, id ASC
    FOR UPDATE
    `,
    [Number(productId), agencyId, DEFAULT_STOCK_AREA_ID]
  );

  for (const row of rows) {
    if (remaining <= 0) {
      break;
    }

    const currentQty = Number(row.metric_qty || 0);

    if (currentQty <= 0) {
      continue;
    }

    const deductQty = Math.min(currentQty, remaining);

    await connection.execute(
      `
      UPDATE stock
      SET defective_quantity = GREATEST(COALESCE(defective_quantity, 0) - ?, 0),
          updated_at = NOW()
      WHERE id = ?
      `,
      [deductQty, row.id]
    );

    remaining -= deductQty;
  }
};

// Restore empty cylinders back into godown empty stock (used when a load is
// rejected). Mirrors the add-back path in godownController.
const restoreEmptyStock = async (connection, productId, qty, agencyId) => {
  const quantity = Number(qty || 0);

  if (!quantity || quantity <= 0) {
    return;
  }

  const [rows] = await connection.execute(
    `
    SELECT id
    FROM stock
    WHERE product_id = ? AND agency_id = ?
    ORDER BY (stock_area_id = ?) DESC, id ASC
    LIMIT 1
    FOR UPDATE
    `,
    [Number(productId), agencyId, DEFAULT_STOCK_AREA_ID]
  );

  if (rows.length) {
    await connection.execute(
      `
      UPDATE stock
      SET empty_quantity = COALESCE(empty_quantity, 0) + ?,
          system_empty_quantity = COALESCE(system_empty_quantity, 0) + ?,
          updated_at = NOW()
      WHERE id = ?
      `,
      [quantity, quantity, rows[0].id]
    );
    return;
  }

  await connection.execute(
    `
    INSERT INTO stock (product_id, stock_area_id, quantity, empty_quantity, system_empty_quantity, defective_quantity, agency_id)
    VALUES (?, NULL, 0, ?, ?, 0, ?)
    `,
    [Number(productId), quantity, quantity, agencyId]
  );
};

const restoreDefectiveStock = async (connection, productId, qty, agencyId) => {
  const quantity = Number(qty || 0);

  if (!quantity || quantity <= 0) {
    return;
  }

  const [rows] = await connection.execute(
    `
    SELECT id
    FROM stock
    WHERE product_id = ? AND agency_id = ?
    ORDER BY (stock_area_id = ?) DESC, id ASC
    LIMIT 1
    FOR UPDATE
    `,
    [Number(productId), agencyId, DEFAULT_STOCK_AREA_ID]
  );

  if (rows.length) {
    await connection.execute(
      `
      UPDATE stock
      SET defective_quantity = COALESCE(defective_quantity, 0) + ?,
          updated_at = NOW()
      WHERE id = ?
      `,
      [quantity, rows[0].id]
    );
    return;
  }

  await connection.execute(
    `
    INSERT INTO stock (product_id, stock_area_id, quantity, empty_quantity, defective_quantity, agency_id)
    VALUES (?, NULL, 0, 0, ?, ?)
    `,
    [Number(productId), quantity, agencyId]
  );
};

// Ensures the tables backing the empty-cylinder-load flow exist. Follows the
// same CREATE TABLE IF NOT EXISTS convention used elsewhere in the codebase.
// Exported because the purchase-trip flow reads these tables too and cannot
// assume a godown dispatch has already created them.
let tablesEnsured = false;

export const ensureEmptyCylinderLoadTables = async (connection) => {
  if (tablesEnsured) return;

  await connection.execute(
    `
    CREATE TABLE IF NOT EXISTS empty_cylinder_loads (
      id BIGINT NOT NULL AUTO_INCREMENT,
      assigned_by INT NULL,
      purchase_manager_id INT NOT NULL,
      agency_id INT NOT NULL DEFAULT 1,
      vehicle_number VARCHAR(50) NULL,
      erv_number VARCHAR(50) NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      reject_reason VARCHAR(255) NULL,
      invoice_url VARCHAR(512) NULL,
      dispatched_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      accepted_at TIMESTAMP NULL,
      completed_at TIMESTAMP NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_ecl_purchase_manager (purchase_manager_id),
      KEY idx_ecl_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `
  );

  await connection.execute(
    `
    CREATE TABLE IF NOT EXISTS empty_cylinder_load_items (
      id BIGINT NOT NULL AUTO_INCREMENT,
      load_id BIGINT NOT NULL,
      product_id INT NOT NULL,
      category VARCHAR(20) NULL,
      quantity INT NOT NULL,
      stock_transaction_id BIGINT NULL,
      PRIMARY KEY (id),
      KEY idx_ecli_load_id (load_id),
      KEY idx_ecli_product_id (product_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `
  );

  // Defensive: if the loads table was created by an earlier build without the
  // erv_number column, add it. MySQL has no ADD COLUMN IF NOT EXISTS, so ignore
  // the duplicate-column error.
  try {
    await connection.execute(
      `ALTER TABLE empty_cylinder_loads ADD COLUMN erv_number VARCHAR(50) NULL AFTER vehicle_number`
    );
  } catch (error) {
    if (error?.code !== "ER_DUP_FIELDNAME") {
      throw error;
    }
  }

  try {
    await connection.execute(
      `ALTER TABLE empty_cylinder_loads ADD COLUMN agency_id INT NOT NULL DEFAULT 1 AFTER purchase_manager_id`
    );
  } catch (error) {
    if (error?.code !== "ER_DUP_FIELDNAME") {
      throw error;
    }
  }

  try {
    await connection.execute(
      `ALTER TABLE empty_cylinder_load_items ADD COLUMN defective_quantity INT NOT NULL DEFAULT 0 AFTER quantity`
    );
  } catch (error) {
    if (error?.code !== "ER_DUP_FIELDNAME") {
      throw error;
    }
  }

  try {
    await connection.execute(
      `ALTER TABLE empty_cylinder_load_items ADD COLUMN defective_stock_transaction_id BIGINT NULL AFTER stock_transaction_id`
    );
  } catch (error) {
    if (error?.code !== "ER_DUP_FIELDNAME") {
      throw error;
    }
  }

  tablesEnsured = true;
};

// GET /purchase-managers — assignee list for the godown dispatch screen.
export const getPurchaseManagers = async (req, res) => {
  try {
    const [rows] = await db.execute(
      `
      SELECT id, name, phone
      FROM users
      WHERE role = 'PURCHASE_MANAGER' AND agency_id = ?
      ORDER BY name ASC
      `,
      [req.user.agency_id]
    );

    return res.json({
      success: true,
      data: rows.map((row) => ({
        id: Number(row.id),
        name: row.name || "Purchase Manager",
        phone: row.phone || "",
      })),
    });
  } catch (error) {
    console.error("getPurchaseManagers error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch purchase managers",
    });
  }
};

// POST / — godown creates an empty-cylinder dispatch assigned to a purchase
// manager. Reserves the empties from godown empty stock immediately (pending)
// so they cannot be dispatched twice; the removal is finalized only on accept.
export const createEmptyCylinderLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      assigned_by = null,
      purchase_manager_id,
      vehicle_number = null,
      erv_number = null,
      items = [],
    } = req.body || {};

    const numericPmId = Number(purchase_manager_id);

    if (!numericPmId || Number.isNaN(numericPmId)) {
      return res.status(400).json({
        success: false,
        message: "purchase_manager_id is required",
      });
    }

    const validItems = (Array.isArray(items) ? items : [])
      .map((item) => ({
        product_id: Number(item.product_id),
        quantity: Number(item.quantity || 0),
        defective_quantity: Number(item.defective_quantity || 0),
      }))
      .filter((item) => item.product_id && (item.quantity > 0 || item.defective_quantity > 0));

    if (!validItems.length) {
      return res.status(400).json({
        success: false,
        message: "At least one empty or defective cylinder quantity is required",
      });
    }

    await ensureEmptyCylinderLoadTables(connection);
    await connection.beginTransaction();

    const agencyId = req.user.agency_id;

    // Confirm the assignee is actually a purchase manager.
    const [pmRows] = await connection.execute(
      `SELECT id FROM users WHERE id = ? AND role = 'PURCHASE_MANAGER' AND agency_id = ? LIMIT 1`,
      [numericPmId, agencyId]
    );

    if (!pmRows.length) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Assigned user is not a purchase manager",
      });
    }

    // Validate product + availability up front.
    for (const item of validItems) {
      const [productRows] = await connection.execute(
        `SELECT id, type FROM products WHERE id = ? LIMIT 1`,
        [item.product_id]
      );

      if (!productRows.length) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: `Product ${item.product_id} not found`,
        });
      }

      item.category = String(productRows[0].type || "").toUpperCase();

      const availableEmpty = await getAvailableEmptyForUpdate(
        connection,
        item.product_id,
        agencyId
      );

      if (item.quantity > availableEmpty) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Only ${availableEmpty} empty cylinder(s) available for product ${item.product_id}`,
        });
      }

      const availableDefective = await getAvailableDefectiveForUpdate(
        connection,
        item.product_id,
        agencyId
      );

      if (item.defective_quantity > availableDefective) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Only ${availableDefective} defective cylinder(s) available for product ${item.product_id}`,
        });
      }
    }

    const createdBy =
      assigned_by != null ? Number(assigned_by) : req.user?.id || null;

    const [loadResult] = await connection.execute(
      `
      INSERT INTO empty_cylinder_loads
      (assigned_by, purchase_manager_id, agency_id, vehicle_number, erv_number, status, dispatched_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'PENDING', NOW(), NOW())
      `,
      [createdBy, numericPmId, agencyId, vehicle_number || null, erv_number || null]
    );

    const loadId = loadResult.insertId;

    for (const item of validItems) {
      let txnId = null;
      let defTxnId = null;

      if (item.quantity > 0) {
        // Reserve the empties out of available godown stock.
        await consumeEmptyStock(connection, item.product_id, item.quantity, agencyId);

        // Pending stock movement — finalized on accept, voided on reject.
        const [txnResult] = await connection.execute(
          `
          INSERT INTO stock_transactions
          (product_id, stock_area_id, type, quantity, isApproved, reference_id, driver_id, created_by, is_defective, stock_from, agency_id)
          VALUES (?, NULL, 'EMPTY_RETURN', ?, ?, ?, NULL, ?, 0, 'godown', ?)
          `,
          [item.product_id, item.quantity, TXN_PENDING, loadId, createdBy, agencyId]
        );
        txnId = txnResult.insertId;
      }

      if (item.defective_quantity > 0) {
        // Reserve the defectives out of available godown stock.
        await consumeDefectiveStock(connection, item.product_id, item.defective_quantity, agencyId);

        const [defTxnResult] = await connection.execute(
          `
          INSERT INTO stock_transactions
          (product_id, stock_area_id, type, quantity, isApproved, reference_id, driver_id, created_by, is_defective, stock_from, agency_id)
          VALUES (?, NULL, 'EMPTY_RETURN', ?, ?, ?, NULL, ?, 1, 'godown', ?)
          `,
          [item.product_id, item.defective_quantity, TXN_PENDING, loadId, createdBy, agencyId]
        );
        defTxnId = defTxnResult.insertId;
      }

      await connection.execute(
        `
        INSERT INTO empty_cylinder_load_items
        (load_id, product_id, category, quantity, defective_quantity, stock_transaction_id, defective_stock_transaction_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          loadId,
          item.product_id,
          item.category || null,
          item.quantity,
          item.defective_quantity,
          txnId,
          defTxnId,
        ]
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Empty cylinder load dispatched successfully",
      data: { id: Number(loadId) },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createEmptyCylinderLoad error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to dispatch empty cylinder load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

const mapLoadStatusLabel = (status) => {
  switch (status) {
    case LOAD_STATUS.PENDING:
      return "Pending Acceptance";
    case LOAD_STATUS.ACCEPTED:
      return "Accepted";
    case LOAD_STATUS.REJECTED:
      return "Rejected";
    case LOAD_STATUS.COMPLETED:
      return "Completed";
    default:
      return status || "";
  }
};

// GET /?purchaseManagerId= — list loads. Optionally filter by assignee (the
// purchase manager tab) so a manager only sees their own loads.
export const getEmptyCylinderLoads = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureEmptyCylinderLoadTables(connection);

    const purchaseManagerId = Number(req.query.purchaseManagerId);
    const status = String(req.query.status || "").toUpperCase();

    const filters = [`ecl.agency_id = ?`];
    const params = [req.user.agency_id];

    if (purchaseManagerId && !Number.isNaN(purchaseManagerId)) {
      filters.push("ecl.purchase_manager_id = ?");
      params.push(purchaseManagerId);
    }

    if (status && LOAD_STATUS[status]) {
      filters.push("ecl.status = ?");
      params.push(status);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const [rows] = await connection.query(
      `
      SELECT
        ecl.id,
        ecl.vehicle_number,
        ecl.erv_number,
        ecl.status,
        ecl.reject_reason,
        ecl.invoice_url,
        ecl.dispatched_at,
        ecl.accepted_at,
        ecl.completed_at,
        assigner.name AS assigned_by_name,
        (
          SELECT pt.id
          FROM purchase_trips pt
          WHERE pt.empty_load_id = ecl.id
            AND pt.status <> 'CANCELLED'
          ORDER BY pt.id DESC
          LIMIT 1
        ) AS trip_id,
        COALESCE(SUM(ecli.quantity), 0) AS total_qty,
        COALESCE(SUM(CASE WHEN ecli.category = 'DOMESTIC' THEN ecli.quantity ELSE 0 END), 0) AS domestic_qty,
        COALESCE(SUM(CASE WHEN ecli.category = 'COMMERCIAL' THEN ecli.quantity ELSE 0 END), 0) AS commercial_qty,
        COALESCE(SUM(ecli.defective_quantity), 0) AS total_defective_qty,
        COALESCE(SUM(CASE WHEN ecli.category = 'DOMESTIC' THEN ecli.defective_quantity ELSE 0 END), 0) AS domestic_defective_qty,
        COALESCE(SUM(CASE WHEN ecli.category = 'COMMERCIAL' THEN ecli.defective_quantity ELSE 0 END), 0) AS commercial_defective_qty
      FROM empty_cylinder_loads ecl
      LEFT JOIN users assigner ON assigner.id = ecl.assigned_by
      LEFT JOIN empty_cylinder_load_items ecli ON ecli.load_id = ecl.id
      ${whereClause}
      GROUP BY ecl.id, ecl.vehicle_number, ecl.erv_number, ecl.status,
        ecl.reject_reason, ecl.invoice_url, ecl.dispatched_at, ecl.accepted_at,
        ecl.completed_at, assigner.name
      ORDER BY ecl.dispatched_at DESC, ecl.id DESC
      `,
      params
    );

    return res.json({
      success: true,
      data: rows.map((row) => ({
        id: Number(row.id),
        tripId: row.trip_id ? Number(row.trip_id) : undefined,
        vehicleNumber: row.vehicle_number || "N/A",
        ervNumber: row.erv_number || null,
        assignedBy: row.assigned_by_name || "Godown",
        status: row.status,
        statusLabel: mapLoadStatusLabel(row.status),
        rejectReason: row.reject_reason || null,
        invoiceUrl: row.invoice_url || null,
        dispatchedAt: row.dispatched_at,
        acceptedAt: row.accepted_at,
        completedAt: row.completed_at,
        totalQuantity: Number(row.total_qty || 0),
        domesticQuantity: Number(row.domestic_qty || 0),
        commercialQuantity: Number(row.commercial_qty || 0),
        totalDefectiveQuantity: Number(row.total_defective_qty || 0),
        domesticDefectiveQuantity: Number(row.domestic_defective_qty || 0),
        commercialDefectiveQuantity: Number(row.commercial_defective_qty || 0),
      })),
    });
  } catch (error) {
    console.error("getEmptyCylinderLoads error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch empty cylinder loads",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

// GET /:loadId — detail with domestic/commercial breakdown + dispatch summary.
export const getEmptyCylinderLoadDetail = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureEmptyCylinderLoadTables(connection);

    const loadId = Number(req.params.loadId);

    if (!loadId || Number.isNaN(loadId)) {
      return res.status(400).json({
        success: false,
        message: "loadId is required",
      });
    }

    const [loadRows] = await connection.query(
      `
      SELECT
        ecl.id,
        ecl.vehicle_number,
        ecl.erv_number,
        ecl.status,
        ecl.reject_reason,
        ecl.invoice_url,
        ecl.dispatched_at,
        ecl.accepted_at,
        ecl.completed_at,
        assigner.name AS assigned_by_name,
        pm.name AS purchase_manager_name
      FROM empty_cylinder_loads ecl
      LEFT JOIN users assigner ON assigner.id = ecl.assigned_by
      LEFT JOIN users pm ON pm.id = ecl.purchase_manager_id
      WHERE ecl.id = ? AND ecl.agency_id = ?
      LIMIT 1
      `,
      [loadId, req.user.agency_id]
    );

    if (!loadRows.length) {
      return res.status(404).json({
        success: false,
        message: "Empty cylinder load not found",
      });
    }

    const [itemRows] = await connection.query(
      `
      SELECT
        ecli.product_id,
        ecli.category,
        ecli.quantity,
        ecli.defective_quantity,
        p.name AS product_name,
        c.name AS category_name
      FROM empty_cylinder_load_items ecli
      LEFT JOIN products p ON p.id = ecli.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE ecli.load_id = ?
      ORDER BY ecli.id ASC
      `,
      [loadId]
    );

    const load = loadRows[0];

    const mapItem = (row) => ({
      productId: Number(row.product_id),
      name: row.product_name || "Cylinder",
      category: row.category || "",
      categoryName: row.category_name || "",
      quantity: Number(row.quantity || 0),
      defectiveQuantity: Number(row.defective_quantity || 0),
    });

    const domesticItems = itemRows
      .filter((row) => String(row.category || "").toUpperCase() === "DOMESTIC")
      .map(mapItem);

    const commercialItems = itemRows
      .filter((row) => String(row.category || "").toUpperCase() === "COMMERCIAL")
      .map(mapItem);

    const domesticQty = domesticItems.reduce((s, i) => s + i.quantity, 0);
    const commercialQty = commercialItems.reduce((s, i) => s + i.quantity, 0);
    const domesticDefectiveQty = domesticItems.reduce((s, i) => s + i.defectiveQuantity, 0);
    const commercialDefectiveQty = commercialItems.reduce((s, i) => s + i.defectiveQuantity, 0);

    return res.json({
      success: true,
      data: {
        id: Number(load.id),
        vehicleNumber: load.vehicle_number || "N/A",
        ervNumber: load.erv_number || null,
        assignedBy: load.assigned_by_name || "Godown",
        purchaseManager: load.purchase_manager_name || "",
        status: load.status,
        statusLabel: mapLoadStatusLabel(load.status),
        rejectReason: load.reject_reason || null,
        invoiceUrl: load.invoice_url || null,
        dispatchedAt: load.dispatched_at,
        acceptedAt: load.accepted_at,
        completedAt: load.completed_at,
        totalQuantity: domesticQty + commercialQty,
        domesticQuantity: domesticQty,
        commercialQuantity: commercialQty,
        totalDefectiveQuantity: domesticDefectiveQty + commercialDefectiveQty,
        domesticDefectiveQuantity: domesticDefectiveQty,
        commercialDefectiveQuantity: commercialDefectiveQty,
        domesticItems,
        commercialItems,
      },
    });
  } catch (error) {
    console.error("getEmptyCylinderLoadDetail error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch empty cylinder load detail",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

// PUT /:loadId/accept — PENDING → ACCEPTED. Finalizes the reserved stock
// movement (isApproved = 1). Stock was already reserved at dispatch.
export const acceptEmptyCylinderLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const loadId = Number(req.params.loadId);

    if (!loadId || Number.isNaN(loadId)) {
      return res.status(400).json({
        success: false,
        message: "loadId is required",
      });
    }

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT id, status FROM empty_cylinder_loads WHERE id = ? AND agency_id = ? LIMIT 1 FOR UPDATE`,
      [loadId, req.user.agency_id]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Empty cylinder load not found",
      });
    }

    if (rows[0].status !== LOAD_STATUS.PENDING) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: `Only a pending load can be accepted (current: ${rows[0].status})`,
      });
    }

    await connection.execute(
      `UPDATE empty_cylinder_loads SET status = 'ACCEPTED', accepted_at = NOW() WHERE id = ?`,
      [loadId]
    );

    await connection.execute(
      `
      UPDATE stock_transactions
      SET isApproved = ?
      WHERE reference_id = ?
        AND type = 'EMPTY_RETURN'
        AND stock_from = 'godown'
        AND isApproved = ?
      `,
      [TXN_APPROVED, loadId, TXN_PENDING]
    );

    await connection.commit();

    return res.json({
      success: true,
      message: "Load accepted",
    });
  } catch (error) {
    await connection.rollback();
    console.error("acceptEmptyCylinderLoad error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to accept load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

// PUT /:loadId/reject — PENDING → REJECTED. Restores the reserved empties to
// godown stock and voids the pending stock movements.
export const rejectEmptyCylinderLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const loadId = Number(req.params.loadId);
    const reason = String(req.body?.reason || "").trim();

    if (!loadId || Number.isNaN(loadId)) {
      return res.status(400).json({
        success: false,
        message: "loadId is required",
      });
    }

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: "A rejection reason is required",
      });
    }

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT id, status FROM empty_cylinder_loads WHERE id = ? AND agency_id = ? LIMIT 1 FOR UPDATE`,
      [loadId, req.user.agency_id]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Empty cylinder load not found",
      });
    }

    if (rows[0].status !== LOAD_STATUS.PENDING) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: `Only a pending load can be rejected (current: ${rows[0].status})`,
      });
    }

    const [items] = await connection.execute(
      `SELECT product_id, quantity, defective_quantity FROM empty_cylinder_load_items WHERE load_id = ?`,
      [loadId]
    );

    for (const item of items) {
      if (item.quantity > 0) {
        await restoreEmptyStock(
          connection,
          Number(item.product_id),
          Number(item.quantity || 0),
          req.user.agency_id
        );
      }
      if (item.defective_quantity > 0) {
        await restoreDefectiveStock(
          connection,
          Number(item.product_id),
          Number(item.defective_quantity || 0),
          req.user.agency_id
        );
      }
    }

    await connection.execute(
      `
      UPDATE stock_transactions
      SET isApproved = ?
      WHERE reference_id = ?
        AND type = 'EMPTY_RETURN'
        AND stock_from = 'godown'
        AND isApproved = ?
      `,
      [TXN_VOID, loadId, TXN_PENDING]
    );

    await connection.execute(
      `UPDATE empty_cylinder_loads SET status = 'REJECTED', reject_reason = ? WHERE id = ?`,
      [reason, loadId]
    );

    await connection.commit();

    return res.json({
      success: true,
      message: "Load rejected and empties returned to godown stock",
    });
  } catch (error) {
    await connection.rollback();
    console.error("rejectEmptyCylinderLoad error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to reject load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

// ACCEPTED → COMPLETED, inside a transaction the caller already owns. Shared
// with the purchase-trip flow, where ending an empty-cylinder trip completes
// the underlying load atomically with the trip close. Returns a result object
// instead of an HTTP response so both callers can shape their own reply.
export const completeEmptyLoadInTransaction = async (
  connection,
  loadId,
  invoiceUrl = null,
  agencyId
) => {
  const [rows] = await connection.execute(
    `SELECT id, status FROM empty_cylinder_loads WHERE id = ? AND agency_id = ? LIMIT 1 FOR UPDATE`,
    [Number(loadId), agencyId]
  );

  if (!rows.length) {
    return { ok: false, message: "Empty cylinder load not found" };
  }

  if (rows[0].status !== LOAD_STATUS.ACCEPTED) {
    return {
      ok: false,
      message: `Only an accepted load can be completed (current: ${rows[0].status})`,
    };
  }

  await connection.execute(
    `
    UPDATE empty_cylinder_loads
    SET status = 'COMPLETED', completed_at = NOW(), invoice_url = COALESCE(?, invoice_url)
    WHERE id = ?
    `,
    [invoiceUrl, Number(loadId)]
  );

  return { ok: true };
};

// PUT /:loadId/complete — ACCEPTED → COMPLETED. Records optional IOC invoice
// and completion time. Stock is already deducted; the stock_transactions rows
// stand as the inventory-history / audit trail.
export const completeEmptyCylinderLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const loadId = Number(req.params.loadId);
    const invoiceUrl = req.body?.invoiceUrl ? String(req.body.invoiceUrl) : null;

    if (!loadId || Number.isNaN(loadId)) {
      return res.status(400).json({
        success: false,
        message: "loadId is required",
      });
    }

    await connection.beginTransaction();

    const completion = await completeEmptyLoadInTransaction(
      connection,
      loadId,
      invoiceUrl,
      req.user.agency_id
    );

    if (!completion.ok) {
      await connection.rollback();
      return res
        .status(completion.message.includes("not found") ? 404 : 400)
        .json({
          success: false,
          message: completion.message,
        });
    }

    await connection.commit();

    return res.json({
      success: true,
      message: "Load completed",
    });
  } catch (error) {
    await connection.rollback();
    console.error("completeEmptyCylinderLoad error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to complete load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
