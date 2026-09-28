import db from "../config/db.js";
import {
  completeEmptyLoadInTransaction,
  ensureEmptyCylinderLoadTables,
} from "./emptyCylinderLoadController.js";
import { recordPurchaseInDailySnapshot } from "../utils/stockLedger.js";

const DEFAULT_PURCHASE_STOCK_AREA_ID = 2;
const purchaseTripColumnCache = new Map();

// A trip is either the standard cylinder purchase run or the empty-cylinder
// return run created from a godown dispatch. Both live in purchase_trips so the
// trips list, the expense→trip time-window linkage and the cashier approval
// queue work identically for each.
const TRIP_TYPE = {
  CYLINDER: "CYLINDER",
  EMPTY: "EMPTY",
};

const hasPurchaseTripColumn = async (connection, columnName) => {
  if (purchaseTripColumnCache.has(columnName)) {
    return purchaseTripColumnCache.get(columnName);
  }

  const [rows] = await connection.query(
    `
    SELECT 1 AS has_column
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'purchase_trips'
      AND COLUMN_NAME = ?
    LIMIT 1
    `,
    [columnName],
  );

  const exists = rows.length > 0;
  purchaseTripColumnCache.set(columnName, exists);
  return exists;
};

// Older databases predate the two columns the empty-cylinder trip needs. MySQL
// has no ADD COLUMN IF NOT EXISTS, so add them defensively and swallow the
// duplicate-column error, matching ensureEmptyCylinderLoadTables' convention.
const ensurePurchaseTripEmptyColumns = async (connection) => {
  const additions = [
    [
      "trip_type",
      `ALTER TABLE purchase_trips ADD COLUMN trip_type VARCHAR(20) NOT NULL DEFAULT 'CYLINDER'`,
    ],
    [
      "empty_load_id",
      `ALTER TABLE purchase_trips ADD COLUMN empty_load_id BIGINT NULL`,
    ],
  ];

  for (const [columnName, statement] of additions) {
    if (await hasPurchaseTripColumn(connection, columnName)) {
      continue;
    }

    try {
      await connection.query(statement);
    } catch (error) {
      if (error?.code !== "ER_DUP_FIELDNAME") {
        throw error;
      }
    }

    purchaseTripColumnCache.set(columnName, true);
  }
};

const formatTripStatus = (status) => {
  switch (status) {
    case "IN_PROGRESS":
      return "IN_PROGRESS";
    case "WAITING_APPROVAL":
      return "WAITING_APPROVAL";
    case "APPROVED":
      return "APPROVED";
    case "COMPLETED":
      return "COMPLETED";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return status;
  }
};

const getFirstPurchaseManager = async (connection, agencyId, preferredUserId = null) => {
  if (preferredUserId) {
    const [rows] = await connection.query(
      `
      SELECT id, name, company_name, phone
      FROM users
      WHERE id = ? AND role = 'PURCHASE_MANAGER' AND agency_id = ?
      `,
      [preferredUserId, agencyId]
    );
    if (rows.length) return rows[0];
  }

  const [rows] = await connection.query(
    `
    SELECT id, name, company_name, phone
    FROM users
    WHERE role = 'PURCHASE_MANAGER' AND agency_id = ?
    ORDER BY id ASC
    LIMIT 1
    `,
    [agencyId]
  );

  return rows[0] || null;
};

const getDefaultStockArea = async (connection, agencyId) => {
  const [preferredRows] = await connection.query(
    `
    SELECT id, name
    FROM stock_areas
    WHERE id = ? AND agency_id = ?
    LIMIT 1
    `,
    [DEFAULT_PURCHASE_STOCK_AREA_ID, agencyId],
  );

  if (preferredRows.length) {
    return preferredRows[0];
  }

  const [rows] = await connection.query(
    `
    SELECT id, name
    FROM stock_areas
    WHERE agency_id = ?
    ORDER BY id ASC
    LIMIT 1
    `,
    [agencyId]
  );

  if (rows.length) {
    return rows[0];
  }

  // Auto-create default stock area if none exists for this agency
  try {
    const [result] = await connection.query(
      `INSERT INTO stock_areas (agency_id, name, address) VALUES (?, 'Main Godown', 'Default Godown')`,
      [agencyId]
    );
    return { id: result.insertId, name: 'Main Godown' };
  } catch (err) {
    return null;
  }
};

const derivePurchaseLoadType = (productRows) => {
  const uniqueTypes = [...new Set(productRows.map((row) => row.type))];

  if (uniqueTypes.length === 1) {
    return uniqueTypes[0];
  }

  return "MIXED";
};

const getTripOverview = async (connection, tripId, agencyId) => {
  const hasEndOdometerReading = await hasPurchaseTripColumn(
    connection,
    "end_odometer_reading",
  );
  const hasEndOdometerImage = await hasPurchaseTripColumn(
    connection,
    "end_odometer_image_url",
  );
  const hasTripType = await hasPurchaseTripColumn(connection, "trip_type");
  const hasEmptyLoadId = await hasPurchaseTripColumn(
    connection,
    "empty_load_id"
  );

  const [tripRows] = await connection.query(
    `
    SELECT
      pt.id,
      pt.purchase_manager_id,
      pt.stock_area_id,
      pt.odometer_reading,
      ${hasEndOdometerReading ? "pt.end_odometer_reading" : "NULL"} AS end_odometer_reading,
      pt.odometer_image_url,
      ${hasEndOdometerImage ? "pt.end_odometer_image_url" : "NULL"} AS end_odometer_image_url,
      ${hasTripType ? "pt.trip_type" : "'CYLINDER'"} AS trip_type,
      ${hasEmptyLoadId ? "pt.empty_load_id" : "NULL"} AS empty_load_id,
      pt.status,
      pt.started_at,
      pt.ended_at,
      sa.name AS stock_area_name,
      u.name AS purchase_manager_name
    FROM purchase_trips pt
    JOIN users u ON u.id = pt.purchase_manager_id
    LEFT JOIN stock_areas sa ON sa.id = pt.stock_area_id
    WHERE pt.id = ? AND pt.agency_id = ?
    `,
    [tripId, agencyId],
  );

  if (!tripRows.length) {
    return null;
  }

  const trip = tripRows[0];

  const [loadRows] = await connection.query(
    `
    SELECT
      pl.id,
      pl.product_type,
      pl.invoice_url,
      pl.invoice_source,
      pl.invoice_number,
      pl.total_quantity,
      pl.status,
      pl.created_at,
      COUNT(pli.id) AS items_count
    FROM purchase_loads pl
    LEFT JOIN purchase_load_items pli ON pli.load_id = pl.id
    WHERE pl.trip_id = ?
    GROUP BY pl.id, pl.product_type, pl.invoice_url, pl.invoice_source, pl.invoice_number, pl.total_quantity, pl.status, pl.created_at
    ORDER BY pl.created_at DESC, pl.id DESC
    `,
    [tripId],
  );

  const [expenseRows] = await connection.query(
    `
    SELECT
      id,
      category,
      description,
      amount,
      bill_url,
      status,
      created_at
    FROM expenses
    WHERE created_by = ?
      AND created_at >= ?
      AND (? IS NULL OR created_at <= ?)
    ORDER BY created_at DESC, id DESC
    `,
    [trip.purchase_manager_id, trip.started_at, trip.ended_at, trip.ended_at],
  );

  const tripType =
    String(trip.trip_type || TRIP_TYPE.CYLINDER).toUpperCase() ===
    TRIP_TYPE.EMPTY
      ? TRIP_TYPE.EMPTY
      : TRIP_TYPE.CYLINDER;

  // An empty trip carries no purchase_loads — the cylinders it moves are the
  // godown dispatch it was started from, so surface that instead.
  let emptyLoad = null;

  if (tripType === TRIP_TYPE.EMPTY && trip.empty_load_id) {
    const [emptyRows] = await connection.query(
      `
      SELECT
        ecl.id,
        ecl.vehicle_number,
        ecl.erv_number,
        ecl.status,
        ecl.invoice_url,
        ecl.dispatched_at,
        ecl.accepted_at,
        ecl.completed_at,
        assigner.name AS assigned_by_name,
        COALESCE(SUM(ecli.quantity), 0) AS total_qty,
        COALESCE(SUM(CASE WHEN ecli.category = 'DOMESTIC' THEN ecli.quantity ELSE 0 END), 0) AS domestic_qty,
        COALESCE(SUM(CASE WHEN ecli.category = 'COMMERCIAL' THEN ecli.quantity ELSE 0 END), 0) AS commercial_qty
      FROM empty_cylinder_loads ecl
      LEFT JOIN users assigner ON assigner.id = ecl.assigned_by
      LEFT JOIN empty_cylinder_load_items ecli ON ecli.load_id = ecl.id
      WHERE ecl.id = ?
      GROUP BY ecl.id, ecl.vehicle_number, ecl.erv_number, ecl.status,
        ecl.invoice_url, ecl.dispatched_at, ecl.accepted_at, ecl.completed_at,
        assigner.name
      `,
      [trip.empty_load_id]
    );

    if (emptyRows.length) {
      const row = emptyRows[0];
      emptyLoad = {
        id: Number(row.id),
        vehicleNumber: row.vehicle_number || "N/A",
        ervNumber: row.erv_number || null,
        assignedBy: row.assigned_by_name || "Godown",
        status: row.status,
        invoiceUrl: row.invoice_url || null,
        dispatchedAt: row.dispatched_at,
        acceptedAt: row.accepted_at,
        completedAt: row.completed_at,
        totalQuantity: Number(row.total_qty || 0),
        domesticQuantity: Number(row.domestic_qty || 0),
        commercialQuantity: Number(row.commercial_qty || 0),
      };
    }
  }

  return {
    id: trip.id,
    tripType,
    emptyLoadId: trip.empty_load_id ? Number(trip.empty_load_id) : null,
    emptyLoad,
    purchaseManagerId: trip.purchase_manager_id,
    purchaseManagerName: trip.purchase_manager_name,
    stockAreaId: trip.stock_area_id,
    stockAreaName: trip.stock_area_name,
    odometerReading: Number(trip.odometer_reading || 0),
    endOdometerReading: trip.end_odometer_reading
      ? Number(trip.end_odometer_reading)
      : null,
    odometerImageUrl: trip.odometer_image_url,
    endOdometerImageUrl: trip.end_odometer_image_url,
    status: trip.status,
    startedAt: trip.started_at,
    endedAt: trip.ended_at,
    loads: loadRows.map((row) => ({
      id: row.id,
      productType: row.product_type,
      invoiceUrl: row.invoice_url,
      invoiceSource: row.invoice_source,
      invoiceNumber: row.invoice_number,
      totalQuantity: Number(row.total_quantity || 0),
      itemsCount: Number(row.items_count || 0),
      status: row.status,
      createdAt: row.created_at,
    })),
    expenses: expenseRows.map((row) => ({
      id: row.id,
      category: row.category,
      description: row.description,
      amount: Number(row.amount || 0),
      billUrl: row.bill_url,
      status: row.status,
      createdAt: row.created_at,
    })),
  };
};

export const getPurchaseBootstrap = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const [manager, stockArea, productRows] = await Promise.all([
      getFirstPurchaseManager(connection, req.user.agency_id, req.user.id),
      getDefaultStockArea(connection, req.user.agency_id),
      connection.query(
        `
        SELECT
          p.id,
          p.name,
          p.type,
          c.name AS category_name
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        ORDER BY p.type ASC, p.name ASC
        `,
      ),
    ]);

    if (!manager) {
      return res.status(404).json({
        success: false,
        message: "No purchase manager user found",
      });
    }

    const productList = productRows[0];

    return res.json({
      success: true,
      data: {
        manager: {
          id: manager.id,
          name: manager.name,
          companyName: manager.company_name,
          phone: manager.phone,
          vehicleLabel: "TN 09 AB 1234 - 14T Truck",
        },
        defaultStockArea: stockArea,
        products: {
          domestic: productList
            .filter((item) => item.type === "DOMESTIC")
            .map((item) => ({
              id: item.id,
              name: item.name,
              category: item.category_name,
              type: item.type,
            })),
          commercial: productList
            .filter((item) => item.type === "COMMERCIAL")
            .map((item) => ({
              id: item.id,
              name: item.name,
              category: item.category_name,
              type: item.type,
            })),
        },
      },
    });
  } catch (error) {
    console.error("getPurchaseBootstrap error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load purchase bootstrap data",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getPurchaseDashboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = Number(req.query.userId);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const [summaryRows] = await connection.query(
      `
      SELECT
        (
          SELECT COALESCE(COUNT(*), 0)
          FROM purchase_loads pl
          JOIN purchase_trips pt ON pt.id = pl.trip_id
          WHERE pt.purchase_manager_id = ? AND pt.agency_id = ?
            AND pl.status = 'PENDING'
        ) AS pendingLoadApproval,
        (
          SELECT COALESCE(SUM(e.amount), 0)
          FROM expenses e
          WHERE e.created_by = ?
            AND e.status = 'PENDING'
        ) AS pendingExpenses,
        (
          SELECT COALESCE(COUNT(*), 0)
          FROM purchase_trips pt
          WHERE pt.purchase_manager_id = ? AND pt.agency_id = ?
            AND pt.status IN ('APPROVED', 'COMPLETED')
            AND YEAR(pt.started_at) = YEAR(CURDATE())
            AND MONTH(pt.started_at) = MONTH(CURDATE())
        ) AS completedTrips
      `,
      [userId, req.user.agency_id, userId, userId, req.user.agency_id],
    );

    const [recentRows] = await connection.query(
      `
      SELECT
        pt.id,
        pt.status,
        pt.started_at,
        (
          SELECT COUNT(*)
          FROM purchase_loads pl
          WHERE pl.trip_id = pt.id
            AND pl.status <> 'CANCELLED'
        ) AS loads_count,
        (
          SELECT COUNT(*)
          FROM expenses e
          WHERE e.created_by = pt.purchase_manager_id
            AND e.created_at >= pt.started_at
            AND (pt.ended_at IS NULL OR e.created_at <= pt.ended_at)
        ) AS expenses_count
      FROM purchase_trips pt
      WHERE pt.purchase_manager_id = ? AND pt.agency_id = ?
      ORDER BY pt.started_at DESC, pt.id DESC
      LIMIT 10
      `,
      [userId, req.user.agency_id],
    );

    const [activeRows] = await connection.query(
      `
      SELECT id
      FROM purchase_trips
      WHERE purchase_manager_id = ? AND agency_id = ?
        AND status = 'IN_PROGRESS'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
      `,
      [userId, req.user.agency_id],
    );

    const activeTrip = activeRows.length
      ? await getTripOverview(connection, activeRows[0].id, req.user.agency_id)
      : null;

    return res.json({
      success: true,
      data: {
        summary: {
          pendingLoadApproval: Number(summaryRows[0]?.pendingLoadApproval || 0),
          pendingExpenses: Number(summaryRows[0]?.pendingExpenses || 0),
          completedTrips: Number(summaryRows[0]?.completedTrips || 0),
        },
        activeTrip,
        recentTrips: recentRows.map((row) => ({
          id: row.id,
          loads: Number(row.loads_count || 0),
          expenses: Number(row.expenses_count || 0),
          status: formatTripStatus(row.status),
          startedAt: row.started_at,
        })),
      },
    });
  } catch (error) {
    console.error("getPurchaseDashboard error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch purchase dashboard",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const startPurchaseTrip = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      userId,
      stockAreaId = null,
      odometerReading,
      odometerImageUrl = null,
    } = req.body || {};

    const parsedUserId = Number(userId);
    const parsedOdometer = Number(odometerReading);

    let parsedStockAreaId = null;
    if (stockAreaId) {
      parsedStockAreaId = Number(stockAreaId);
    } else {
      const defaultArea = await getDefaultStockArea(connection, req.user.agency_id);
      if (defaultArea) {
        parsedStockAreaId = defaultArea.id;
      }
    }

    if (
      !parsedUserId ||
      !Number.isFinite(parsedOdometer) ||
      parsedOdometer <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "userId and a valid odometerReading are required",
      });
    }

    const [existingRows] = await connection.query(
      `
      SELECT id
      FROM purchase_trips
      WHERE purchase_manager_id = ? AND agency_id = ?
        AND status = 'IN_PROGRESS'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
      `,
      [parsedUserId, req.user.agency_id],
    );

    if (existingRows.length) {
      return res.status(409).json({
        success: false,
        message: "An active purchase trip already exists",
        data: await getTripOverview(connection, existingRows[0].id, req.user.agency_id),
      });
    }

    const [result] = await connection.query(
      `
      INSERT INTO purchase_trips (purchase_manager_id, stock_area_id, odometer_reading, odometer_image_url, status, agency_id)
      VALUES (?, ?, ?, ?, 'IN_PROGRESS', ?)
      `,
      [parsedUserId, parsedStockAreaId, parsedOdometer, odometerImageUrl, req.user.agency_id],
    );

    return res.status(201).json({
      success: true,
      message: "Purchase trip started successfully",
      data: await getTripOverview(connection, result.insertId, req.user.agency_id),
    });
  } catch (error) {
    console.error("startPurchaseTrip error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to start purchase trip",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

// POST /trips/start-empty — the purchase manager has accepted a godown empty
// dispatch and is now driving it out. Same odometer-in / odometer-out shape as a
// cylinder trip, but no load creation and no approval gate: the trip runs, takes
// expenses (which the cashier approves), and closes directly.
export const startEmptyCylinderTrip = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      userId,
      emptyLoadId,
      odometerReading,
      odometerImageUrl = null,
    } = req.body || {};

    const parsedUserId = Number(userId);
    const parsedLoadId = Number(emptyLoadId);
    const parsedOdometer = Number(odometerReading);

    if (!parsedUserId || !parsedLoadId) {
      return res.status(400).json({
        success: false,
        message: "userId and emptyLoadId are required",
      });
    }

    if (!Number.isFinite(parsedOdometer) || parsedOdometer <= 0) {
      return res.status(400).json({
        success: false,
        message: "A valid odometerReading is required",
      });
    }

    await ensureEmptyCylinderLoadTables(connection);
    await ensurePurchaseTripEmptyColumns(connection);

    await connection.beginTransaction();

    // One active trip per manager whatever its type: the driver and vehicle can
    // only be on one run, and the expense→trip window would otherwise be
    // ambiguous across two open trips.
    const [existingRows] = await connection.query(
      `
      SELECT id
      FROM purchase_trips
      WHERE purchase_manager_id = ? AND agency_id = ?
        AND status = 'IN_PROGRESS'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
      `,
      [parsedUserId, req.user.agency_id]
    );

    if (existingRows.length) {
      const overview = await getTripOverview(connection, existingRows[0].id, req.user.agency_id);
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message: "An active trip already exists",
        data: overview,
      });
    }

    const [loadRows] = await connection.query(
      `
      SELECT id, purchase_manager_id, status
      FROM empty_cylinder_loads
      WHERE id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [parsedLoadId]
    );

    if (!loadRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Empty cylinder load not found",
      });
    }

    if (Number(loadRows[0].purchase_manager_id) !== parsedUserId) {
      await connection.rollback();
      return res.status(403).json({
        success: false,
        message: "This load is assigned to a different purchase manager",
      });
    }

    if (loadRows[0].status !== "ACCEPTED") {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: `Accept the load before starting its trip (current: ${loadRows[0].status})`,
      });
    }

    const [duplicateRows] = await connection.query(
      `
      SELECT id
      FROM purchase_trips
      WHERE empty_load_id = ?
        AND status <> 'CANCELLED'
      ORDER BY id DESC
      LIMIT 1
      `,
      [parsedLoadId]
    );

    if (duplicateRows.length) {
      const overview = await getTripOverview(connection, duplicateRows[0].id, req.user.agency_id);
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message: "A trip has already been started for this load",
        data: overview,
      });
    }

    const [result] = await connection.query(
      `
      INSERT INTO purchase_trips
        (purchase_manager_id, stock_area_id, odometer_reading, odometer_image_url, status, trip_type, empty_load_id, agency_id)
      VALUES (?, ?, ?, ?, 'IN_PROGRESS', 'EMPTY', ?, ?)
      `,
      [
        parsedUserId,
        DEFAULT_PURCHASE_STOCK_AREA_ID,
        parsedOdometer,
        odometerImageUrl,
        parsedLoadId,
        req.user.agency_id,
      ]
    );

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Empty cylinder trip started successfully",
      data: await getTripOverview(connection, result.insertId, req.user.agency_id),
    });
  } catch (error) {
    await connection.rollback();
    console.error("startEmptyCylinderTrip error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to start empty cylinder trip",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getActivePurchaseTrip = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = Number(req.query.userId);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const [rows] = await connection.query(
      `
      SELECT id
      FROM purchase_trips
      WHERE purchase_manager_id = ? AND agency_id = ?
        AND status = 'IN_PROGRESS'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
      `,
      [userId, req.user.agency_id],
    );

    return res.json({
      success: true,
      data: rows.length ? await getTripOverview(connection, rows[0].id, req.user.agency_id) : null,
    });
  } catch (error) {
    console.error("getActivePurchaseTrip error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch active purchase trip",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

// GET /trips/empty/:loadId — the trip started for a given godown empty
// dispatch, or null if the driver has not started one yet. Lets the load screen
// show the running (or finished) trip without scanning the whole trip list.
export const getEmptyCylinderLoadTrip = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const loadId = Number(req.params.loadId);

    if (!loadId) {
      return res.status(400).json({
        success: false,
        message: "loadId is required",
      });
    }

    await ensurePurchaseTripEmptyColumns(connection);

    const [rows] = await connection.query(
      `
      SELECT id
      FROM purchase_trips
      WHERE empty_load_id = ? AND agency_id = ?
        AND status <> 'CANCELLED'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
      `,
      [loadId, req.user.agency_id]
    );

    return res.json({
      success: true,
      data: rows.length ? await getTripOverview(connection, rows[0].id, req.user.agency_id) : null,
    });
  } catch (error) {
    console.error("getEmptyCylinderLoadTrip error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch the trip for this load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getPurchaseTrips = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = Number(req.query.userId);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    await ensureEmptyCylinderLoadTables(connection);
    await ensurePurchaseTripEmptyColumns(connection);

    // An empty trip has no purchase_loads: it counts as the single godown
    // dispatch it was started from, and its cylinders come from that load's
    // items. Everything else (expense counts/totals) is type-agnostic.
    const [rows] = await connection.query(
      `
      SELECT
        pt.id,
        pt.status,
        pt.trip_type,
        pt.empty_load_id,
        pt.odometer_reading,
        pt.started_at,
        pt.ended_at,
        CASE
          WHEN pt.trip_type = 'EMPTY'
            THEN (CASE WHEN pt.empty_load_id IS NULL THEN 0 ELSE 1 END)
          ELSE (
            SELECT COUNT(*)
            FROM purchase_loads pl
            WHERE pl.trip_id = pt.id
              AND pl.status <> 'CANCELLED'
          )
        END AS loads_count,
        (
          SELECT COUNT(*)
          FROM expenses e
          WHERE e.created_by = pt.purchase_manager_id
            AND e.created_at >= pt.started_at
            AND (pt.ended_at IS NULL OR e.created_at <= pt.ended_at)
        ) AS expenses_count,
        CASE
          WHEN pt.trip_type = 'EMPTY'
            THEN (
              SELECT COALESCE(SUM(ecli.quantity), 0)
              FROM empty_cylinder_load_items ecli
              WHERE ecli.load_id = pt.empty_load_id
            )
          ELSE (
            SELECT COALESCE(SUM(pl.total_quantity), 0)
            FROM purchase_loads pl
            WHERE pl.trip_id = pt.id
              AND pl.status <> 'CANCELLED'
          )
        END AS total_cylinders,
        (
          SELECT COALESCE(SUM(e.amount), 0)
          FROM expenses e
          WHERE e.created_by = pt.purchase_manager_id
            AND e.created_at >= pt.started_at
            AND (pt.ended_at IS NULL OR e.created_at <= pt.ended_at)
        ) AS total_expenses
      FROM purchase_trips pt
      WHERE pt.purchase_manager_id = ? AND pt.agency_id = ?
      ORDER BY pt.started_at DESC, pt.id DESC
      `,
      [userId, req.user.agency_id],
    );

    return res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        tripType:
          String(row.trip_type || TRIP_TYPE.CYLINDER).toUpperCase() ===
          TRIP_TYPE.EMPTY
            ? TRIP_TYPE.EMPTY
            : TRIP_TYPE.CYLINDER,
        emptyLoadId: row.empty_load_id ? Number(row.empty_load_id) : null,
        status: formatTripStatus(row.status),
        startKm: Number(row.odometer_reading || 0),
        startedAt: row.started_at,
        endedAt: row.ended_at,
        loadsCount: Number(row.loads_count || 0),
        totalCylinders: Number(row.total_cylinders || 0),
        expensesCount: Number(row.expenses_count || 0),
        totalExpenses: Number(row.total_expenses || 0),
      })),
    });
  } catch (error) {
    console.error("getPurchaseTrips error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch purchase trips",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getPurchaseLoads = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = Number(req.query.userId);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const [rows] = await connection.query(
      `
      SELECT
        pl.id,
        pl.trip_id,
        pl.product_type,
        pl.invoice_url,
        pl.invoice_source,
        pl.invoice_number,
        pl.total_quantity,
        pl.status,
        pl.created_at,
        pt.status AS trip_status,
        COUNT(pli.id) AS items_count
      FROM purchase_loads pl
      JOIN purchase_trips pt ON pt.id = pl.trip_id
      LEFT JOIN purchase_load_items pli ON pli.load_id = pl.id
      WHERE pt.purchase_manager_id = ? AND pt.agency_id = ?
      GROUP BY pl.id, pl.trip_id, pl.product_type, pl.invoice_url, pl.invoice_source, pl.invoice_number, pl.total_quantity, pl.status, pl.created_at, pt.status
      ORDER BY pl.created_at DESC, pl.id DESC
      `,
      [userId, req.user.agency_id],
    );

    return res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        tripId: row.trip_id,
        productType: row.product_type,
        invoiceUrl: row.invoice_url,
        invoiceSource: row.invoice_source,
        invoiceNumber: row.invoice_number,
        totalQuantity: Number(row.total_quantity || 0),
        itemsCount: Number(row.items_count || 0),
        status: row.status,
        tripStatus: formatTripStatus(row.trip_status),
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error("getPurchaseLoads error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch purchase loads",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getPurchaseLoadDetail = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const loadId = Number(req.params.loadId);

    if (!loadId) {
      return res.status(400).json({
        success: false,
        message: "loadId is required",
      });
    }

    const [rows] = await connection.query(
      `
      SELECT
        pl.id,
        pl.trip_id,
        pl.product_type,
        pl.invoice_url,
        pl.invoice_source,
        pl.invoice_number,
        pl.total_quantity,
        pl.status,
        pl.created_at,
        pt.status AS trip_status,
        p.id AS product_id,
        p.name AS product_name,
        p.type AS product_type_name,
        c.name AS category_name,
        pli.quantity
      FROM purchase_loads pl
      JOIN purchase_trips pt ON pt.id = pl.trip_id
      LEFT JOIN purchase_load_items pli ON pli.load_id = pl.id
      LEFT JOIN products p ON p.id = pli.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE pl.id = ? AND pt.agency_id = ?
      ORDER BY pli.id ASC
      `,
      [loadId, req.user.agency_id],
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Purchase load not found",
      });
    }

    return res.json({
      success: true,
      data: {
        id: rows[0].id,
        tripId: rows[0].trip_id,
        productType: rows[0].product_type,
        invoiceUrl: rows[0].invoice_url,
        invoiceSource: rows[0].invoice_source,
        invoiceNumber: rows[0].invoice_number,
        totalQuantity: Number(rows[0].total_quantity || 0),
        status: rows[0].status,
        tripStatus: formatTripStatus(rows[0].trip_status),
        createdAt: rows[0].created_at,
        items: rows
          .filter((row) => row.product_id)
          .map((row) => ({
            productId: row.product_id,
            name: row.product_name,
            type: row.product_type_name,
            category: row.category_name,
            quantity: Number(row.quantity || 0),
          })),
      },
    });
  } catch (error) {
    console.error("getPurchaseLoadDetail error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch purchase load detail",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const createPurchaseLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { tripId, createdBy, stockAreaId, items } = req.body || {};

    const parsedTripId = Number(tripId);
    const parsedCreatedBy = Number(createdBy);
    const parsedStockAreaId =
      stockAreaId === undefined || stockAreaId === null || stockAreaId === ""
        ? null
        : Number(stockAreaId);

    if (
      !parsedTripId ||
      !parsedCreatedBy ||
      !Array.isArray(items) ||
      !items.length
    ) {
      return res.status(400).json({
        success: false,
        message: "tripId, createdBy and items are required",
      });
    }

    const normalizedItems = items
      .map((item) => ({
        productId: Number(item.productId),
        quantity: Number(item.quantity),
      }))
      .filter(
        (item) =>
          item.productId && Number.isFinite(item.quantity) && item.quantity > 0,
      );

    if (!normalizedItems.length) {
      return res.status(400).json({
        success: false,
        message: "At least one valid item is required",
      });
    }

    await ensurePurchaseTripEmptyColumns(connection);

    const [tripRows] = await connection.query(
      `
      SELECT id, status, stock_area_id, trip_type
      FROM purchase_trips
      WHERE id = ? AND agency_id = ?
      `,
      [parsedTripId, req.user.agency_id],
    );

    if (!tripRows.length) {
      return res.status(404).json({
        success: false,
        message: "Trip not found",
      });
    }

    if (String(tripRows[0].trip_type || "").toUpperCase() === TRIP_TYPE.EMPTY) {
      return res.status(400).json({
        success: false,
        message: "Purchase loads cannot be added to an empty cylinder trip",
      });
    }

    if (tripRows[0].status !== "IN_PROGRESS") {
      return res.status(400).json({
        success: false,
        message: "Loads can only be added while the trip is in progress",
      });
    }

    let effectiveStockAreaId = parsedStockAreaId;
    if (effectiveStockAreaId === null || effectiveStockAreaId === undefined) {
      if (tripRows[0].stock_area_id) {
        effectiveStockAreaId = Number(tripRows[0].stock_area_id);
      } else {
        const defaultArea = await getDefaultStockArea(connection, req.user.agency_id);
        effectiveStockAreaId = defaultArea ? defaultArea.id : null;
      }
    }

    if (effectiveStockAreaId !== null) {
      const [stockAreaRows] = await connection.query(
        `
        SELECT id
        FROM stock_areas
        WHERE id = ?
        LIMIT 1
        `,
        [effectiveStockAreaId],
      );

      if (!stockAreaRows.length) {
        return res.status(400).json({
          success: false,
          message: "Invalid stockAreaId. Selected stock area does not exist",
        });
      }
    }

    const productIds = normalizedItems.map((item) => item.productId);
    const placeholders = productIds.map(() => "?").join(",");
    const [productRows] = await connection.query(
      `
      SELECT id, type
      FROM products
      WHERE id IN (${placeholders})
      `,
      productIds,
    );

    if (productRows.length !== normalizedItems.length) {
      return res.status(400).json({
        success: false,
        message: "One or more products were not found",
      });
    }

    await connection.beginTransaction();

    const totalQuantity = normalizedItems.reduce(
      (sum, item) => sum + item.quantity,
      0,
    );
    const loadProductType = derivePurchaseLoadType(productRows);

    const [loadResult] = await connection.query(
      `
      INSERT INTO purchase_loads (trip_id, created_by, stock_area_id, product_type, total_quantity, status, agency_id)
      VALUES (?, ?, ?, ?, ?, 'DRAFT', ?)
      `,
      [
        parsedTripId,
        parsedCreatedBy,
        effectiveStockAreaId,
        loadProductType,
        totalQuantity,
        req.user.agency_id,
      ],
    );

    const loadId = loadResult.insertId;

    for (const item of normalizedItems) {
      await connection.query(
        `
        INSERT INTO purchase_load_items (load_id, product_id, quantity)
        VALUES (?, ?, ?)
        `,
        [loadId, item.productId, item.quantity],
      );

      if (effectiveStockAreaId !== null) {
        await connection.query(
          `
          INSERT INTO stock_transactions (
            product_id,
            stock_area_id,
            type,
            quantity,
            isApproved,
            reference_id,
            created_by,
            stock_from,
            agency_id
          )
          VALUES (?, ?, 'PURCHASE', ?, 0, ?, ?, 'depot', ?)
          `,
          [
            item.productId,
            effectiveStockAreaId,
            item.quantity,
            loadId,
            parsedCreatedBy,
            req.user.agency_id,
          ],
        );

        await connection.query(
          `
          INSERT INTO stock (product_id, stock_area_id, quantity, quantity_return, empty_quantity, defective_quantity, agency_id)
          VALUES (?, ?, 0, 0, 0, 0, ?)
          ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP
          `,
          [item.productId, effectiveStockAreaId, req.user.agency_id],
        );
      }
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Purchase load created successfully",
      data: await getPurchaseLoadDetailData(connection, loadId, req.user.agency_id),
    });
  } catch (error) {
    await connection.rollback();
    console.error("createPurchaseLoad error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create purchase load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const updatePurchaseLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const loadId = Number(req.params.loadId);
    const { stockAreaId, items } = req.body || {};

    const parsedStockAreaId =
      stockAreaId === undefined || stockAreaId === null || stockAreaId === ""
        ? null
        : Number(stockAreaId);

    if (!loadId || !Array.isArray(items) || !items.length) {
      return res.status(400).json({
        success: false,
        message: "loadId and items are required",
      });
    }

    const normalizedItems = items
      .map((item) => ({
        productId: Number(item.productId),
        quantity: Number(item.quantity),
      }))
      .filter(
        (item) =>
          item.productId && Number.isFinite(item.quantity) && item.quantity > 0,
      );

    if (!normalizedItems.length) {
      return res.status(400).json({
        success: false,
        message: "At least one valid item is required",
      });
    }

    const [loadRows] = await connection.query(
      `
      SELECT pl.id, pl.trip_id, pl.created_by, pl.stock_area_id, pl.status, pt.status AS trip_status, pt.stock_area_id AS trip_stock_area_id
      FROM purchase_loads pl
      JOIN purchase_trips pt ON pt.id = pl.trip_id
      WHERE pl.id = ?
      `,
      [loadId],
    );

    if (!loadRows.length) {
      return res.status(404).json({
        success: false,
        message: "Purchase load not found",
      });
    }

    if (loadRows[0].trip_status !== "IN_PROGRESS") {
      return res.status(400).json({
        success: false,
        message: "Loads can only be edited while the trip is in progress",
      });
    }

    if (loadRows[0].status !== "DRAFT") {
      return res.status(400).json({
        success: false,
        message: "Only draft loads can be edited",
      });
    }

    let effectiveStockAreaId = parsedStockAreaId;
    if (effectiveStockAreaId === null || effectiveStockAreaId === undefined) {
      if (loadRows[0].trip_stock_area_id) {
        effectiveStockAreaId = Number(loadRows[0].trip_stock_area_id);
      } else if (loadRows[0].stock_area_id) {
        effectiveStockAreaId = Number(loadRows[0].stock_area_id);
      } else {
        const defaultArea = await getDefaultStockArea(connection, req.user.agency_id);
        effectiveStockAreaId = defaultArea ? defaultArea.id : null;
      }
    }

    if (effectiveStockAreaId !== null) {
      const [stockAreaRows] = await connection.query(
        `
        SELECT id
        FROM stock_areas
        WHERE id = ? AND agency_id = ?
        LIMIT 1
        `,
        [effectiveStockAreaId, req.user.agency_id],
      );

      if (!stockAreaRows.length) {
        return res.status(400).json({
          success: false,
          message: "Invalid stockAreaId. Selected stock area does not exist",
        });
      }
    }

    const productIds = normalizedItems.map((item) => item.productId);
    const placeholders = productIds.map(() => "?").join(",");
    const [productRows] = await connection.query(
      `
      SELECT id, type
      FROM products
      WHERE id IN (${placeholders})
      `,
      productIds,
    );

    if (productRows.length !== normalizedItems.length) {
      return res.status(400).json({
        success: false,
        message: "One or more products were not found",
      });
    }

    await connection.beginTransaction();

    const totalQuantity = normalizedItems.reduce(
      (sum, item) => sum + item.quantity,
      0,
    );
    const loadProductType = derivePurchaseLoadType(productRows);

    await connection.query(
      `
      UPDATE purchase_loads
      SET stock_area_id = ?, product_type = ?, total_quantity = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `,
      [effectiveStockAreaId, loadProductType, totalQuantity, loadId],
    );

    await connection.query(
      `
      DELETE FROM purchase_load_items
      WHERE load_id = ?
      `,
      [loadId],
    );

    await connection.query(
      `
      DELETE FROM stock_transactions
      WHERE type = 'PURCHASE'
        AND reference_id = ?
        AND isApproved = 0
      `,
      [loadId],
    );

    for (const item of normalizedItems) {
      await connection.query(
        `
        INSERT INTO purchase_load_items (load_id, product_id, quantity)
        VALUES (?, ?, ?)
        `,
        [loadId, item.productId, item.quantity],
      );

      if (effectiveStockAreaId !== null) {
        await connection.query(
          `
          INSERT INTO stock_transactions (
            product_id,
            stock_area_id,
            type,
            quantity,
            isApproved,
            reference_id,
            created_by,
            stock_from,
            agency_id
          )
          VALUES (?, ?, 'PURCHASE', ?, 0, ?, ?, 'depot', ?)
          `,
          [
            item.productId,
            effectiveStockAreaId,
            item.quantity,
            loadId,
            Number(loadRows[0].created_by),
            req.user.agency_id,
          ],
        );

        await connection.query(
          `
          INSERT INTO stock (product_id, stock_area_id, quantity, quantity_return, empty_quantity, defective_quantity, agency_id)
          VALUES (?, ?, 0, 0, 0, 0, ?)
          ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP
          `,
          [item.productId, effectiveStockAreaId, req.user.agency_id],
        );
      }
    }

    await connection.commit();

    return res.json({
      success: true,
      message: "Purchase load updated successfully",
      data: await getPurchaseLoadDetailData(connection, loadId, req.user.agency_id),
    });
  } catch (error) {
    await connection.rollback();
    console.error("updatePurchaseLoad error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update purchase load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

const getPurchaseLoadDetailData = async (connection, loadId, agencyId) => {
  const [rows] = await connection.query(
    `
    SELECT
      pl.id,
      pl.trip_id,
      pl.product_type,
      pl.invoice_url,
      pl.invoice_source,
      pl.invoice_number,
      pl.total_quantity,
      pl.status,
      pl.created_at,
      pt.status AS trip_status,
      p.id AS product_id,
      p.name AS product_name,
      p.type AS product_type_name,
      c.name AS category_name,
      pli.quantity
    FROM purchase_loads pl
    JOIN purchase_trips pt ON pt.id = pl.trip_id
    LEFT JOIN purchase_load_items pli ON pli.load_id = pl.id
    LEFT JOIN products p ON p.id = pli.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE pl.id = ? AND pt.agency_id = ?
    ORDER BY pli.id ASC
    `,
    [loadId, agencyId],
  );

  if (!rows.length) {
    return null;
  }

  return {
    id: rows[0].id,
    tripId: rows[0].trip_id,
    productType: rows[0].product_type,
    invoiceUrl: rows[0].invoice_url,
    invoiceSource: rows[0].invoice_source,
    invoiceNumber: rows[0].invoice_number,
    totalQuantity: Number(rows[0].total_quantity || 0),
    status: rows[0].status,
    tripStatus: formatTripStatus(rows[0].trip_status),
    createdAt: rows[0].created_at,
    items: rows
      .filter((row) => row.product_id)
      .map((row) => ({
        productId: row.product_id,
        name: row.product_name,
        type: row.product_type_name,
        category: row.category_name,
        quantity: Number(row.quantity || 0),
      })),
  };
};

/**
 * Marks in-progress stock_transactions as waiting-approval for a load.
 * Must be called inside an active transaction.
 */
const _markLoadStockWaiting = async (connection, loadId) => {
  const [updated] = await connection.query(
    `
    UPDATE stock_transactions
    SET isApproved = 2, created_at = CURRENT_TIMESTAMP
    WHERE type = 'PURCHASE'
      AND reference_id = ?
      AND isApproved IN (0, 2)
    `,
    [loadId],
  );

  if (updated.affectedRows === 0) {
    const [loadRows] = await connection.query(
      `SELECT pl.id, pl.agency_id, pl.created_by, pl.stock_area_id, pt.stock_area_id as trip_stock_area_id, pt.agency_id as trip_agency_id
       FROM purchase_loads pl
       LEFT JOIN purchase_trips pt ON pt.id = pl.trip_id
       WHERE pl.id = ?`,
      [loadId]
    );

    if (loadRows.length) {
      const agencyId = loadRows[0].agency_id || loadRows[0].trip_agency_id || 1;
      let stockAreaId = loadRows[0].stock_area_id || loadRows[0].trip_stock_area_id;
      if (!stockAreaId) {
        const defaultArea = await getDefaultStockArea(connection, agencyId);
        stockAreaId = defaultArea ? defaultArea.id : null;
        if (stockAreaId) {
          await connection.query(`UPDATE purchase_loads SET stock_area_id = ? WHERE id = ?`, [stockAreaId, loadId]);
        }
      }

      const [items] = await connection.query(
        `SELECT product_id, quantity FROM purchase_load_items WHERE load_id = ?`,
        [loadId]
      );

      for (const item of items) {
        await connection.query(
          `INSERT INTO stock_transactions (
            product_id, stock_area_id, type, quantity, isApproved, reference_id, created_by, stock_from, agency_id, created_at
          ) VALUES (?, ?, 'PURCHASE', ?, 2, ?, ?, 'depot', ?, NOW())`,
          [item.product_id, stockAreaId, item.quantity, loadId, loadRows[0].created_by, agencyId]
        );
      }
    }
  }
};

/**
 * Approves waiting stock_transactions for a load and updates the stock table.
 * Must be called inside an active transaction.
 */
const _approveLoadStock = async (connection, loadId) => {
  const [txRows] = await connection.query(
    `
    SELECT id, product_id, stock_area_id, quantity, agency_id
    FROM stock_transactions
    WHERE type = 'PURCHASE'
      AND reference_id = ?
      AND isApproved = 2
    FOR UPDATE
    `,
    [loadId],
  );

  for (const tx of txRows) {
    const productId = Number(tx.product_id);
    const stockAreaId = Number(tx.stock_area_id);
    const qty = Number(tx.quantity || 0);
    const agencyId = Number(tx.agency_id || 1);

    const [stockRows] = await connection.query(
      `
      SELECT id
      FROM stock
      WHERE product_id = ? AND stock_area_id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [productId, stockAreaId],
    );

    if (stockRows.length) {
      await connection.query(
        `UPDATE stock SET quantity = quantity + ? WHERE product_id = ? AND stock_area_id = ?`,
        [qty, productId, stockAreaId],
      );
    } else {
      await connection.query(
        `INSERT INTO stock (product_id, stock_area_id, quantity, quantity_return, empty_quantity, defective_quantity, agency_id)
         VALUES (?, ?, ?, 0, 0, 0, ?)`,
        [productId, stockAreaId, qty, agencyId],
      );
    }

    // Increment today's purchase_qty and closing_stock in daily snapshot without touching opening_stock
    await recordPurchaseInDailySnapshot(connection, agencyId, stockAreaId, productId, qty);
  }

  if (txRows.length) {
    await connection.query(
      `
      UPDATE stock_transactions
      SET isApproved = 1
      WHERE type = 'PURCHASE'
        AND reference_id = ?
        AND isApproved = 2
      `,
      [loadId],
    );
  }
};

const ensurePurchaseLoadInvoiceNumberColumn = async (connection) => {
  const [cols] = await connection.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_loads' AND COLUMN_NAME = 'invoice_number'`,
  );
  if (!cols.length) {
    await connection.query(
      `ALTER TABLE purchase_loads ADD COLUMN invoice_number VARCHAR(100) DEFAULT NULL AFTER product_type`,
    );
  }
};

export const attachPurchaseLoadInvoice = async (req, res) => {
  const connection = await db.getConnection();
  await ensurePurchaseLoadInvoiceNumberColumn(connection);

  try {
    const loadId = Number(req.params.loadId);
    const {
      invoiceUrl = null,
      invoiceSource = null,
      invoiceNumber = null,
    } = req.body || {};

    if (!loadId) {
      return res.status(400).json({
        success: false,
        message: "loadId is required",
      });
    }

    const [rows] = await connection.query(
      `
      SELECT pl.id, pl.status, pt.status AS trip_status
      FROM purchase_loads pl
      JOIN purchase_trips pt ON pt.id = pl.trip_id
      WHERE pl.id = ? AND pt.agency_id = ?
      `,
      [loadId, req.user.agency_id],
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Purchase load not found",
      });
    }

    if (rows[0].trip_status !== "IN_PROGRESS") {
      return res.status(400).json({
        success: false,
        message: "Load can only be submitted while the trip is in progress",
      });
    }

    if (rows[0].status === "APPROVED" || rows[0].status === "CANCELLED") {
      return res.status(400).json({
        success: false,
        message: "This load cannot be submitted again",
      });
    }

    await connection.beginTransaction();

    // 1. Promote load to PENDING with optional invoice
    await connection.query(
      `
      UPDATE purchase_loads
      SET invoice_url = ?, invoice_source = ?, invoice_number = ?, status = 'PENDING'
      WHERE id = ?
      `,
      [invoiceUrl, invoiceSource, invoiceNumber, loadId],
    );

    // 2. Move stock_transactions to waiting approval for this load
    await _markLoadStockWaiting(connection, loadId);

    await connection.commit();

    return res.json({
      success: true,
      message: "Load submitted for approval successfully",
      data: await getPurchaseLoadDetailData(connection, loadId),
    });
  } catch (error) {
    await connection.rollback();
    console.error("attachPurchaseLoadInvoice error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to submit load for approval",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const cancelPurchaseLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const loadId = Number(req.params.loadId);

    if (!loadId) {
      return res.status(400).json({
        success: false,
        message: "loadId is required",
      });
    }

    await connection.beginTransaction();

    const [rows] = await connection.query(
      `
      SELECT pl.id, pl.status, pt.status AS trip_status
      FROM purchase_loads pl
      JOIN purchase_trips pt ON pt.id = pl.trip_id
      WHERE pl.id = ? AND pt.agency_id = ?
      `,
      [loadId, req.user.agency_id],
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Purchase load not found",
      });
    }

    if (rows[0].trip_status !== "IN_PROGRESS") {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Only in-progress trip loads can be cancelled",
      });
    }

    if (rows[0].status !== "DRAFT") {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Only in-progress (draft) loads can be cancelled",
      });
    }

    await connection.query(
      `
      DELETE FROM stock_transactions
      WHERE type = 'PURCHASE'
        AND reference_id = ?
        AND isApproved IN (0, 2)
      `,
      [loadId],
    );

    await connection.query(
      `
      UPDATE purchase_loads
      SET status = 'CANCELLED'
      WHERE id = ?
      `,
      [loadId],
    );

    await connection.commit();

    return res.json({
      success: true,
      message: "Purchase load cancelled successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error("cancelPurchaseLoad error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to cancel purchase load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const submitPurchaseTrip = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const tripId = Number(req.params.tripId);

    const {
      endOdometerImageUrl = null,
      endOdometerReading,
      emptyLoadId,
      invoiceUrl = null,
    } = req.body || {};
    const parsedEndOdometer = Number(endOdometerReading);
    const parsedEmptyLoadId = emptyLoadId ? Number(emptyLoadId) : null;

    if (!tripId) {
      return res.status(400).json({
        success: false,
        message: "tripId is required",
      });
    }

    if (!endOdometerImageUrl) {
      return res.status(400).json({
        success: false,
        message: "endOdometerImageUrl is required",
      });
    }

    if (!Number.isFinite(parsedEndOdometer) || parsedEndOdometer <= 0) {
      return res.status(400).json({
        success: false,
        message: "A valid endOdometerReading is required",
      });
    }

    // Runs before beginTransaction: the defensive ALTERs are DDL, which would
    // implicitly commit an open transaction.
    await ensurePurchaseTripEmptyColumns(connection);

    await connection.beginTransaction();

    const [tripRows] = await connection.query(
      `
      SELECT id, status, trip_type
      FROM purchase_trips
      WHERE id = ? AND agency_id = ?
      `,
      [tripId, req.user.agency_id],
    );

    if (!tripRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Trip not found",
      });
    }

    if (
      !["IN_PROGRESS", "WAITING_APPROVAL", "APPROVED"].includes(
        tripRows[0].status,
      )
    ) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Trip is not in a valid state for end odometer submission",
      });
    }

    const hasEndOdometerReading = await hasPurchaseTripColumn(
      connection,
      "end_odometer_reading",
    );
    const hasEndOdometerImage = await hasPurchaseTripColumn(
      connection,
      "end_odometer_image_url",
    );

    // 2. ADD THIS ENTIRE BLOCK: Handle Empty Cylinder Trips
    if (parsedEmptyLoadId) {
      const [emptyLoadRows] = await connection.query(
        `SELECT id, status FROM empty_cylinder_loads WHERE id = ? AND agency_id = ?`,
        [parsedEmptyLoadId, req.user.agency_id]
      );
      if (!emptyLoadRows.length) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: "Empty cylinder load not found" });
      }

      // Complete the empty cylinder load
      await connection.query(
        `UPDATE empty_cylinder_loads SET status = 'COMPLETED', completed_at = NOW(), invoice_url = COALESCE(?, invoice_url) WHERE id = ?`,
        [invoiceUrl, parsedEmptyLoadId]
      );

      const nextTripStatus = "COMPLETED"; // Empty trips complete immediately
      if (hasEndOdometerReading && hasEndOdometerImage) {
        await connection.query(
          `UPDATE purchase_trips SET status = ?, ended_at = CURRENT_TIMESTAMP, end_odometer_image_url = ?, end_odometer_reading = ? WHERE id = ?`,
          [nextTripStatus, endOdometerImageUrl, parsedEndOdometer, tripId]
        );
      } else {
        await connection.query(
          `UPDATE purchase_trips SET status = ?, ended_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [nextTripStatus, tripId]
        );
      }

      await connection.commit();
      return res.json({
        success: true,
        message: "Empty cylinder trip and load completed successfully",
      });
    }

    // 3. EXISTING LOGIC STARTS HERE (leave this unchanged, it runs for regular trips)
    const [loadRows] = await connection.query(
      `
      SELECT id, status
      FROM purchase_loads
      WHERE trip_id = ?
        AND status <> 'CANCELLED'
      `,
      [tripId],
    );

    if (!loadRows.length) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Create at least one load before submitting the trip",
      });
    }

    const hasDraftLoad = loadRows.some((load) => load.status === "DRAFT");

    if (hasDraftLoad) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Submit all loads for approval before ending the trip",
      });
    }

    // For every active load: ensure approval pipeline state.
    for (const load of loadRows) {
      if (load.status !== "PENDING" && load.status !== "APPROVED") {
        await connection.query(
          `UPDATE purchase_loads SET status = 'PENDING' WHERE id = ?`,
          [load.id],
        );
      }

      await _markLoadStockWaiting(connection, load.id);
    }

    const nextTripStatus =
      tripRows[0].status === "APPROVED" ? "APPROVED" : "WAITING_APPROVAL";

    if (hasEndOdometerReading && hasEndOdometerImage) {
      await connection.query(
        `
        UPDATE purchase_trips
        SET status = ?, ended_at = CURRENT_TIMESTAMP, end_odometer_image_url = ?, end_odometer_reading = ?
        WHERE id = ?
        `,
        [nextTripStatus, endOdometerImageUrl, parsedEndOdometer, tripId],
      );
    } else {
      await connection.query(
        `
        UPDATE purchase_trips
        SET status = ?, ended_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        [nextTripStatus, tripId],
      );
    }

    await connection.commit();

    return res.json({
      success: true,
      message: "Trip submitted for approval successfully",
      data: await getTripOverview(connection, tripId),
    });
  } catch (error) {
    await connection.rollback();
    console.error("submitPurchaseTrip error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to submit purchase trip",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

// PUT /trips/:tripId/submit-empty — closes an empty-cylinder trip. Unlike the
// cylinder flow there is no approval gate: the end odometer (plus the optional
// IOC invoice) completes the trip and its underlying godown load in one
// transaction, so the godown manager sees COMPLETED immediately. Expenses raised
// during the trip keep their own PENDING → cashier-review lifecycle.
export const submitEmptyCylinderTrip = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const tripId = Number(req.params.tripId);
    const {
      endOdometerImageUrl = null,
      endOdometerReading,
      invoiceUrl = null,
    } = req.body || {};
    const parsedEndOdometer = Number(endOdometerReading);

    if (!tripId) {
      return res.status(400).json({
        success: false,
        message: "tripId is required",
      });
    }

    if (!endOdometerImageUrl) {
      return res.status(400).json({
        success: false,
        message: "endOdometerImageUrl is required",
      });
    }

    if (!Number.isFinite(parsedEndOdometer) || parsedEndOdometer <= 0) {
      return res.status(400).json({
        success: false,
        message: "A valid endOdometerReading is required",
      });
    }

    await ensureEmptyCylinderLoadTables(connection);
    await ensurePurchaseTripEmptyColumns(connection);

    await connection.beginTransaction();

    const [tripRows] = await connection.query(
      `
      SELECT id, status, trip_type, empty_load_id, odometer_reading
      FROM purchase_trips
      WHERE id = ? AND agency_id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [tripId, req.user.agency_id]
    );

    if (!tripRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Trip not found",
      });
    }

    const trip = tripRows[0];

    if (String(trip.trip_type || "").toUpperCase() !== TRIP_TYPE.EMPTY) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message:
          "Not an empty cylinder trip — use the standard trip submission instead",
      });
    }

    if (trip.status !== "IN_PROGRESS") {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: `This trip is already closed (current: ${trip.status})`,
      });
    }

    if (parsedEndOdometer < Number(trip.odometer_reading || 0)) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: `End reading cannot be lower than the start reading (${Number(
          trip.odometer_reading || 0
        )} km)`,
      });
    }

    const hasEndOdometerReading = await hasPurchaseTripColumn(
      connection,
      "end_odometer_reading"
    );
    const hasEndOdometerImage = await hasPurchaseTripColumn(
      connection,
      "end_odometer_image_url"
    );

    if (hasEndOdometerReading && hasEndOdometerImage) {
      await connection.query(
        `
        UPDATE purchase_trips
        SET status = 'COMPLETED', ended_at = CURRENT_TIMESTAMP, end_odometer_image_url = ?, end_odometer_reading = ?
        WHERE id = ?
        `,
        [endOdometerImageUrl, parsedEndOdometer, tripId]
      );
    } else {
      await connection.query(
        `
        UPDATE purchase_trips
        SET status = 'COMPLETED', ended_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        [tripId]
      );
    }

    const completion = await completeEmptyLoadInTransaction(
      connection,
      trip.empty_load_id,
      invoiceUrl
    );

    if (!completion.ok) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: completion.message,
      });
    }

    await connection.commit();

    return res.json({
      success: true,
      message: "Empty cylinder trip completed successfully",
      data: await getTripOverview(connection, tripId),
    });
  } catch (error) {
    await connection.rollback();
    console.error("submitEmptyCylinderTrip error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to complete empty cylinder trip",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getPurchaseExpenses = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = Number(req.query.userId);

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

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
        (
          SELECT pt.id
          FROM purchase_trips pt
          WHERE pt.purchase_manager_id = e.created_by AND pt.agency_id = ?
            AND e.created_at >= pt.started_at
            AND (pt.ended_at IS NULL OR e.created_at <= pt.ended_at)
          ORDER BY pt.started_at DESC
          LIMIT 1
        ) AS trip_id
      FROM expenses e
      WHERE e.created_by = ? AND e.agency_id = ?
      ORDER BY e.created_at DESC, e.id DESC
      `,
      [req.user.agency_id, userId, req.user.agency_id],
    );

    return res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        tripId: row.trip_id ?? undefined,
        category: row.category,
        description: row.description,
        amount: Number(row.amount || 0),
        billUrl: row.bill_url,
        status: row.status,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error("getPurchaseExpenses error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch purchase expenses",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const syncPurchaseApprovalState = async (connection, loadId, agencyId) => {
  if (!loadId) {
    return;
  }

  const [loadRows] = await connection.query(
    `
    SELECT id, trip_id
    FROM purchase_loads
    WHERE id = ? AND agency_id = ?
    `,
    [loadId, agencyId],
  );

  if (!loadRows.length) {
    return;
  }

  const tripId = loadRows[0].trip_id;

  await connection.query(
    `
    UPDATE purchase_loads
    SET status = 'APPROVED'
    WHERE id = ?
    `,
    [loadId],
  );

  const [pendingRows] = await connection.query(
    `
    SELECT COUNT(*) AS pendingCount
    FROM purchase_loads
    WHERE trip_id = ?
      AND status IN ('DRAFT', 'PENDING')
    `,
    [tripId],
  );

  if (Number(pendingRows[0]?.pendingCount || 0) === 0) {
    await connection.query(
      `
      UPDATE purchase_trips
      SET status = 'APPROVED'
      WHERE id = ?
        AND status IN ('WAITING_APPROVAL', 'COMPLETED')
        AND ended_at IS NOT NULL
      `,
      [tripId],
    );
  }
};
