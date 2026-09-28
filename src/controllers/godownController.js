import db from "../config/db.js";
import { syncPurchaseApprovalState } from "./purchaseController.js";
import {
  CARRY_FORWARD_DATE_EXPR,
  getDriverCarryForward,
} from "../utils/driverCarryForward.js";
import { recordPurchaseInDailySnapshot } from "../utils/stockLedger.js";

const DEFAULT_STOCK_AREA_ID = 1;
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const getTodayIsoDate = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const resolveDateRange = (query = {}) => {
  const rawStartDate = String(query?.startDate || "");
  const rawEndDate = String(query?.endDate || "");

  const startDate = DATE_ONLY_REGEX.test(rawStartDate) ? rawStartDate : null;
  const endDate = DATE_ONLY_REGEX.test(rawEndDate) ? rawEndDate : null;

  if (!startDate && !endDate) {
    const today = getTodayIsoDate();
    return { startDate: today, endDate: today };
  }

  const computedStartDate = startDate || endDate;
  const computedEndDate = endDate || startDate;

  if (computedStartDate <= computedEndDate) {
    return { startDate: computedStartDate, endDate: computedEndDate };
  }

  return { startDate: computedEndDate, endDate: computedStartDate };
};

const increaseStock = async (
  connection,
  {
    productId,
    quantity = 0,
    systemQuantity = 0,
    returnQuantity = 0,
    emptyQuantity = 0,
    systemEmptyQuantity = 0,
    defectiveQuantity = 0,
  },
  agencyId = 1
) => {
  const effectiveAgencyId = agencyId || 1;
  const qty = Number(quantity || 0);
  const sysQty = Number(systemQuantity || 0);
  const returnQty = Number(returnQuantity || 0);
  const emptyQty = Number(emptyQuantity || 0);
  const sysEmptyQty = Number(systemEmptyQuantity || 0);
  const defectiveQty = Number(defectiveQuantity || 0);

  if (qty === 0 && sysQty === 0 && returnQty === 0 && emptyQty === 0 && sysEmptyQty === 0 && defectiveQty === 0) {
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
    [productId, effectiveAgencyId, DEFAULT_STOCK_AREA_ID]
  );

  if (rows.length) {
    await connection.execute(
      `
      UPDATE stock
      SET
        quantity = COALESCE(quantity, 0) + ?,
        system_quantity = COALESCE(system_quantity, 0) + ?,
        quantity_return = COALESCE(quantity_return, 0) + ?,
        empty_quantity = COALESCE(empty_quantity, 0) + ?,
        system_empty_quantity = COALESCE(system_empty_quantity, 0) + ?,
        defective_quantity = COALESCE(defective_quantity, 0) + ?,
        updated_at = NOW()
      WHERE id = ?
      `,
      [qty, sysQty, returnQty, emptyQty, sysEmptyQty, defectiveQty, rows[0].id]
    );
    return;
  }

  await connection.execute(
    `
    INSERT INTO stock
    (
      product_id,
      stock_area_id,
      quantity,
      system_quantity,
      quantity_return,
      empty_quantity,
      system_empty_quantity,
      defective_quantity,
      agency_id
    )
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `,
    [productId, qty, sysQty, returnQty, emptyQty, sysEmptyQty, defectiveQty, effectiveAgencyId]
  );
};

const getAvailableStockForUpdate = async (connection, productId, agencyId) => {
  const [rows] = await connection.execute(
    `
    SELECT COALESCE(SUM(quantity), 0) AS quantity
    FROM stock
    WHERE product_id = ? AND agency_id = ?
    FOR UPDATE
    `,
    [productId, agencyId]
  );

  return Number(rows[0]?.quantity || 0);
};

const consumeStockQuantity = async (connection, productId, requiredQty, agencyId) => {
  let remaining = Number(requiredQty || 0);

  if (remaining <= 0) {
    return;
  }

  const [rows] = await connection.execute(
    `
    SELECT id, COALESCE(quantity, 0) AS quantity
    FROM stock
    WHERE product_id = ? AND agency_id = ?
    ORDER BY (stock_area_id = ?) DESC, id ASC
    FOR UPDATE
    `,
    [productId, agencyId, DEFAULT_STOCK_AREA_ID]
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

    await connection.execute(
      `
      UPDATE stock
      SET quantity = GREATEST(COALESCE(quantity, 0) - ?, 0),
          updated_at = NOW()
      WHERE id = ?
      `,
      [deductQty, row.id]
    );

    remaining -= deductQty;
  }
};

const getStockMetricTotalForUpdate = async (
  connection,
  productId,
  metricColumn,
  agencyId
) => {
  const safeColumn =
    metricColumn === "empty_quantity" ||
    metricColumn === "system_empty_quantity" ||
    metricColumn === "defective_quantity" ||
    metricColumn === "system_quantity"
      ? metricColumn
      : null;

  if (!safeColumn) {
    throw new Error("Unsupported stock metric");
  }

  const [rows] = await connection.execute(
    `
    SELECT COALESCE(SUM(${safeColumn}), 0) AS total
    FROM stock
    WHERE product_id = ? AND agency_id = ?
    FOR UPDATE
    `,
    [Number(productId), agencyId]
  );

  return Number(rows[0]?.total || 0);
};

const consumeStockMetric = async (
  connection,
  productId,
  metricColumn,
  requiredQty,
  agencyId
) => {
  const safeColumn =
    metricColumn === "empty_quantity" ||
    metricColumn === "system_empty_quantity" ||
    metricColumn === "defective_quantity" ||
    metricColumn === "system_quantity"
      ? metricColumn
      : null;

  if (!safeColumn) {
    throw new Error("Unsupported stock metric");
  }

  let remaining = Number(requiredQty || 0);

  if (remaining <= 0) {
    return;
  }

  const [rows] = await connection.execute(
    `
    SELECT id, COALESCE(${safeColumn}, 0) AS metric_qty
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
      SET ${safeColumn} = GREATEST(COALESCE(${safeColumn}, 0) - ?, 0),
          updated_at = NOW()
      WHERE id = ?
      `,
      [deductQty, row.id]
    );

    remaining -= deductQty;
  }
};

export const getGodownDashboardData = async (req, res) => {
  try {
    const { startDate, endDate } = resolveDateRange(req.query);

    const [stockRows] = await db.execute(`
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        p.type AS product_type,
        c.name AS category_name,
        COALESCE(SUM(s.quantity), 0) AS physical_quantity,
        COALESCE(SUM(s.system_quantity), 0) AS system_quantity,
        COALESCE(SUM(s.empty_quantity), 0) AS empty_quantity,
        COALESCE(SUM(s.system_empty_quantity), 0) AS system_empty_quantity,
        COALESCE(SUM(s.defective_quantity), 0) AS defective_quantity
      FROM products p
      LEFT JOIN stock s ON s.product_id = p.id AND s.agency_id = ?
      LEFT JOIN categories c ON c.id = p.category_id
      GROUP BY p.id, p.name, p.type, c.name
    `, [req.user.agency_id]);

    const [allocatedTodayRows] = await db.execute(`
      SELECT
        COALESCE(SUM(st.quantity), 0) AS allocated_today
      FROM stock_transactions st
      WHERE st.type = 'ADJUSTMENT_SUBTRACT'
        AND st.stock_from = 'godown'
        AND COALESCE(st.isApproved, 0) = 1
        AND st.agency_id = ?
        AND DATE(st.created_at) BETWEEN ? AND ?
    `, [req.user.agency_id, startDate, endDate]);

    // Stock in (approved full cylinders received into the godown) per product,
    // used to derive System = opening stock (IOC baseline) + stock in.
    const [stockInRows] = await db.execute(`
      SELECT
        st.product_id,
        COALESCE(SUM(st.quantity), 0) AS stock_in
      FROM stock_transactions st
      WHERE st.type IN ('PURCHASE', 'ADJUSTMENT_ADD')
        AND COALESCE(st.isApproved, 0) = 1
        AND COALESCE(st.is_defective, 0) = 0
        AND st.agency_id = ?
      GROUP BY st.product_id
    `, [req.user.agency_id]);
    const stockInByProduct = {};
    stockInRows.forEach((r) => {
      stockInByProduct[Number(r.product_id)] = Number(r.stock_in || 0);
    });

    const [returnedTodayRows] = await db.execute(`
      SELECT
        COALESCE(SUM(st.quantity), 0) AS returned_today
      FROM stock_transactions st
      LEFT JOIN sales linked_sale
        ON linked_sale.id = st.reference_id
       AND linked_sale.driver_id = st.driver_id
      WHERE st.driver_id IS NOT NULL
        AND COALESCE(st.isApproved, 0) = 1
        AND st.agency_id = ?
        AND DATE(st.created_at) BETWEEN ? AND ?
        AND st.type IN ('EMPTY_RETURN', 'PURCHASE_RETURN')
        AND (
          st.type <> 'EMPTY_RETURN'
          OR linked_sale.id IS NULL
        )
    `, [req.user.agency_id, startDate, endDate]);

    const [recentActivityRows] = await db.execute(
      `
      SELECT
        st.id,
        st.type,
        st.stock_from,
        st.quantity,
        st.created_at,
        COALESCE(st.is_defective, 0) AS is_defective,
        p.name AS product_name,
        COALESCE(u.name, cu.name) AS driver_name
      FROM stock_transactions st
      LEFT JOIN products p ON p.id = st.product_id
      LEFT JOIN drivers d ON d.id = st.driver_id
      LEFT JOIN users u ON u.id = d.user_id
      LEFT JOIN users cu ON cu.id = st.created_by
      WHERE st.agency_id = ? AND DATE(st.created_at) BETWEEN ? AND ?
      ORDER BY st.created_at DESC
      LIMIT 10
      `,
      [req.user.agency_id, startDate, endDate]
    );

    // Count cashier sales (office sales)
    const [cashierSalesRows] = await db.execute(`
      SELECT COUNT(*) AS cashier_sale_count
      FROM sales s
      WHERE s.sales_from = 'CASHIER'
        AND s.agency_id = ?
        AND DATE(s.created_at) BETWEEN ? AND ?
    `, [req.user.agency_id, startDate, endDate]);

    const normalizeType = (row) => {
      return String(row.product_type || "").toUpperCase() === "COMMERCIAL"
        ? "COMMERCIAL"
        : "DOMESTIC";
    };

    const cashierSaleStock = Number(cashierSalesRows[0]?.cashier_sale_count || 0);

    const initial = {
      available: {
        domestic: { total: 0, system: 0, defective: 0, items: [] },
        commercial: { total: 0, system: 0, defective: 0, items: [] },
      },
      empty: {
        domestic: { total: 0, system: 0, defective: 0, items: [] },
        commercial: { total: 0, system: 0, defective: 0, items: [] },
      },
      allocatedToday: 0,
      returnedToday: 0,
      totalDefectives: 0,
      cashierSaleStock,
      recentActivities: [],
    };

    stockRows.forEach((row) => {
      const group = normalizeType(row);
      const key = group === "COMMERCIAL" ? "commercial" : "domestic";

      // physical = actual on-hand stock (stock.quantity)
      // system   = stock.system_quantity, which now accumulates:
      //            IOC baseline (markIocOtpSent) + purchase approvals (approveStockInLoad)
      //            and is decremented by stock-out (createStockOutLoad)
      const physicalQty = Number(row.physical_quantity || 0);
      const systemQty = Number(row.system_quantity || 0);
      const systemTotal = Math.max(systemQty, 0);
      const emptyQty = Number(row.empty_quantity || 0);
      const systemEmptyQty = Number(row.system_empty_quantity || 0);
      const defectiveQty = Number(row.defective_quantity || 0);

      const availablePhysical = Math.max(physicalQty, 0);
      const defectivePhysical = Math.max(defectiveQty, 0);
      const emptyPhysical = Math.max(emptyQty, 0);
      const emptySystem = Math.max(systemEmptyQty, 0);

      initial.available[key].system += systemTotal;
      initial.available[key].defective += defectivePhysical;
      initial.available[key].total += availablePhysical;

      initial.empty[key].total += emptyPhysical;
      initial.empty[key].system += emptySystem;

      initial.available[key].items.push({
        product_id: row.product_id,
        item: row.product_name,
        physical: availablePhysical,
        system: systemTotal,
        diff: availablePhysical - systemTotal,
      });
    });

    // Keep empty cards sourced from stock.empty_quantity only.
    // This guarantees values change only after approval updates stock.

    initial.totalDefectives = stockRows.reduce(
      (sum, row) => sum + Number(row.defective_quantity || 0),
      0
    );
    initial.allocatedToday = Number(allocatedTodayRows[0]?.allocated_today || 0);
    initial.returnedToday = Number(returnedTodayRows[0]?.returned_today || 0);

    initial.recentActivities = recentActivityRows.map((row) => {
      const qty = Number(row.quantity || 0);
      const productName = row.product_name || "Cylinder";
      const driverName = row.driver_name || "Driver";
      const activityType = String(row.type || "").toUpperCase();

      if (activityType === "ADJUSTMENT_SUBTRACT") {
        return {
          id: row.id,
          title: `${qty} ${productName} allocated to ${driverName}`,
          icon: "arrow-up-circle-outline",
          color: "primary",
          createdAt: row.created_at,
        };
      }

      if (activityType === "ADJUSTMENT_ADD" || activityType === "PURCHASE") {
        return {
          id: row.id,
          title: `${qty} ${productName} received from Depot by ${driverName}`,
          icon: "arrow-down-circle-outline",
          color: "green",
          createdAt: row.created_at,
        };
      }

      if (activityType === "EMPTY_RETURN") {
        return {
          id: row.id,
          title: `${qty} empty ${productName} returned by ${driverName}`,
          icon: "refresh-outline",
          color: "orange",
          createdAt: row.created_at,
        };
      }

      if (activityType === "PURCHASE_RETURN" && Number(row.is_defective) === 1) {
        return {
          id: row.id,
          title: `${qty} defective ${productName} logged from ${driverName}`,
          icon: "warning-outline",
          color: "danger",
          createdAt: row.created_at,
        };
      }

      return {
        id: row.id,
        title: `${qty} ${productName} activity by ${driverName}`,
        icon: "time-outline",
        color: "primary",
        createdAt: row.created_at,
      };
    });

    return res.json({
      success: true,
      data: initial,
    });
  } catch (error) {
    console.error("getGodownDashboardData error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch godown dashboard data",
    });
  }
};

export const getStockDetailByType = async (req, res) => {
  try {
    const rawType = String(req.params.type || "").toLowerCase();
    const { startDate, endDate } = resolveDateRange(req.query);

    const isEmptyView = rawType.startsWith("empty-");

    const normalizedType = ["commercial", "empty-commercial"].includes(rawType)
      ? "COMMERCIAL"
      : ["domestic", "empty-domestic"].includes(rawType)
        ? "DOMESTIC"
        : null;

    if (!normalizedType) {
      return res.status(400).json({
        success: false,
        message: "Invalid stock type",
      });
    }

    const [rows] = await db.execute(
      `
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        p.type AS product_type,
        COALESCE(SUM(s.quantity), 0) AS quantity,
        COALESCE(SUM(s.system_quantity), 0) AS system_quantity,
        COALESCE(SUM(s.empty_quantity), 0) AS empty_quantity,
        COALESCE(SUM(s.system_empty_quantity), 0) AS system_empty_quantity,
        COALESCE(SUM(s.defective_quantity), 0) AS defective_quantity
      FROM products p
      LEFT JOIN stock s ON s.product_id = p.id AND s.agency_id = ?
      WHERE p.type = ?
      GROUP BY p.id, p.name, p.type
      ORDER BY p.name ASC
      `,
      [req.user.agency_id, normalizedType]
    );

    // For empty view:
    //   system   = sales_items.empty_cylinder_qty (what drivers collected — same source as driver app)
    //   physical = stock.empty_quantity (what godown has approved and received)
    let emptyReturnByProduct = {};
    if (isEmptyView) {
      const [emptyTxRows] = await db.execute(
        `
        SELECT
          si.product_id,
          COALESCE(SUM(si.empty_cylinder_qty), 0) AS total_returned
        FROM sales s
        INNER JOIN sales_items si ON si.sale_id = s.id
        WHERE s.status = 'DELIVERED'
          AND s.agency_id = ?
          AND si.empty_cylinder_status IN ('DELIVERED', 'PARTIAL_DELIVERED')
          AND COALESCE(si.empty_cylinder_qty, 0) > 0
          AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?
        GROUP BY si.product_id
        `,
        [req.user.agency_id, startDate, endDate]
      );
      emptyTxRows.forEach((r) => {
        emptyReturnByProduct[Number(r.product_id)] = Number(r.total_returned || 0);
      });
    }

    // For the available view we present TOTAL UNSOLD stock and its system value:
    //   Physical = stock.quantity (in godown) + cylinders in hand with drivers
    //   System   = Physical + cylinders sold whose OTP is still PENDING
    //              (i.e. Total unsold - OTP already marked sent from the
    //               customer-issues dashboard).
    // Both are derived from live data; no stock rows are mutated here.
    const driverInHandByProduct = {};
    const pendingOtpByProduct = {};
    if (!isEmptyView) {
      const [inHandRows] = await db.execute(
        `
        SELECT
          asi.product_id,
          COALESCE(SUM(GREATEST(
            COALESCE(asi.quantity, 0)
            - COALESCE(delivered_data.delivered_qty, 0)
            - COALESCE(return_data.return_qty, 0)
            - COALESCE(return_data.defective_qty, 0), 0
          )), 0) AS in_hand
        FROM sales_items asi
        INNER JOIN sales a ON a.id = asi.sale_id
        LEFT JOIN (
          SELECT child.allocation_sales_item_id,
                 SUM(COALESCE(child.delivered_qty, child.quantity, 0)) AS delivered_qty
          FROM sales_items child
          INNER JOIN sales cs ON cs.id = child.sale_id
          WHERE child.allocation_sales_item_id IS NOT NULL
            AND cs.status = 'DELIVERED'
            AND cs.agency_id = ?
          GROUP BY child.allocation_sales_item_id
        ) delivered_data ON delivered_data.allocation_sales_item_id = asi.id
        LEFT JOIN (
          SELECT st.allocation_sales_item_id,
                 SUM(CASE WHEN st.is_defective = 0 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS return_qty,
                 SUM(CASE WHEN st.is_defective = 1 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS defective_qty
          FROM stock_transactions st
          WHERE st.stock_from = 'driver'
            AND st.type = 'PURCHASE_RETURN'
            AND st.isApproved IN (0, 1)
            AND st.agency_id = ?
            AND st.allocation_sales_item_id IS NOT NULL
          GROUP BY st.allocation_sales_item_id
        ) return_data ON return_data.allocation_sales_item_id = asi.id
        WHERE a.status = 'ASSIGNED'
          AND a.agency_id = ?
          AND asi.allocation_sales_item_id IS NULL
        GROUP BY asi.product_id
        `,
        [req.user.agency_id, req.user.agency_id, req.user.agency_id]
      );
      inHandRows.forEach((r) => {
        driverInHandByProduct[Number(r.product_id)] = Number(r.in_hand || 0);
      });

      const [pendingOtpRows] = await db.execute(
        `
        SELECT
          si.product_id,
          COALESCE(SUM(COALESCE(si.delivered_qty, si.quantity, 0)), 0) AS pending_otp
        FROM sales_items si
        INNER JOIN sales s ON s.id = si.sale_id
        WHERE si.allocation_sales_item_id IS NOT NULL
          AND s.status = 'DELIVERED'
          AND s.agency_id = ?
          AND EXISTS (
            SELECT 1 FROM driver_sale_otps dso
            WHERE dso.sale_id = s.id AND dso.status = 'PENDING'
          )
        GROUP BY si.product_id
        `,
        [req.user.agency_id]
      );
      pendingOtpRows.forEach((r) => {
        pendingOtpByProduct[Number(r.product_id)] = Number(r.pending_otp || 0);
      });
    }

    const items = rows.map((row) => {
      const qty = Number(row.quantity || 0);
      const emptyQty = Number(row.empty_quantity || 0);   // stock.empty_quantity (in-stock / approved)
      const defectiveQty = Number(row.defective_quantity || 0);

      let physical, system, quantityValue;

      if (isEmptyView) {
        // physical = stock.empty_quantity (approved and received at godown)
        // system   = stock.system_empty_quantity (confirmed in IOC), fallback to collected empties if uninitialized
        physical = emptyQty;
        const trackedSysEmpty = Number(row.system_empty_quantity || 0);
        system = trackedSysEmpty > 0 ? trackedSysEmpty : (emptyReturnByProduct[Number(row.product_id)] ?? 0);
        quantityValue = Math.max(qty, 0);
      } else {
        // physical = total unsold = godown on-hand + cylinders in hand with drivers
        const inHand = driverInHandByProduct[Number(row.product_id)] ?? 0;
        physical = Math.max(qty, 0) + inHand;
        // Both Commercial and Domestic: system = physical + cylinders sold whose OTP is still pending
        const pendingOtp = pendingOtpByProduct[Number(row.product_id)] ?? 0;
        system = physical + pendingOtp;
        quantityValue = physical;
      }

      const compactName = String(row.product_name || "")
        .replace(/commercial|domestic/gi, "")
        .replace(/cylinder|cylinders/gi, "")
        .trim();

      return {
        productId: Number(row.product_id),
        productName: row.product_name,
        item: compactName || row.product_name,
        quantity: quantityValue,
        emptyQuantity: emptyQty,
        defectiveQuantity: defectiveQty,
        physical,
        system,
        diff: physical - system,
      };
    });

    const totalAvailable = items.reduce(
      (sum, item) => sum + Number(item.quantity || 0),
      0
    );

    const totalEmpty = items.reduce(
      (sum, item) => sum + Number(item.emptyQuantity || 0),
      0
    );

    const totalDefective = items.reduce(
      (sum, item) => sum + Number(item.defectiveQuantity || 0),
      0
    );

    const totalPhysical = items.reduce(
      (sum, item) => sum + Number(item.physical || 0),
      0
    );

    const totalSystem = items.reduce(
      (sum, item) => sum + Number(item.system || 0),
      0
    );

    // Stock breakdown: godown on-hand vs allocated (driver in-hand)
    let godownPhysical = 0;
    let godownSystem = 0;
    let allocatedPhysical = 0;
    let allocatedSystem = 0;

    if (!isEmptyView) {
      rows.forEach((row) => {
        const qty = Math.max(Number(row.quantity || 0), 0);
        const inHand = driverInHandByProduct[Number(row.product_id)] ?? 0;
        const pendingOtp = pendingOtpByProduct[Number(row.product_id)] ?? 0;

        godownPhysical += qty;
        godownSystem += qty + pendingOtp;
        allocatedPhysical += inHand;
        allocatedSystem += inHand;
      });
    }

    const titleMap = {
      domestic: "Domestic Available",
      commercial: "Commercial Available",
      "empty-domestic": "Domestic Empty",
      "empty-commercial": "Commercial Empty",
    };

    const title = titleMap[rawType] || (
      normalizedType === "COMMERCIAL" ? "Commercial Available" : "Domestic Available"
    );

    return res.json({
      success: true,
      data: {
        type: rawType,
        mode: isEmptyView ? "empty" : "available",
        title,
        totalAvailable,
        totalEmpty,
        totalDefective,
        totalStock: isEmptyView ? totalPhysical : totalAvailable,
        physical: totalPhysical,
        system: totalSystem,
        diff: totalPhysical - totalSystem,
        showBookings: rawType === "commercial",
        items,
        ...(!isEmptyView ? {
          stockBreakdown: {
            godownStock: { physical: godownPhysical, system: godownSystem },
            allocatedStock: { physical: allocatedPhysical, system: allocatedSystem },
            totalStock: { physical: totalPhysical, system: totalSystem },
          },
        } : {}),
      },
    });
  } catch (error) {
    console.error("getStockDetailByType error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock detail",
      error: error.message,
    });
  }
};

export const getStockInLoads = async (req, res) => {
  try {
    const agencyId = req.user?.agency_id || 1;

    // 1. Primary source: purchase_loads (from Purchase Manager load trip requests)
    const [purchaseLoads] = await db.execute(`
      SELECT
        pl.id AS load_id,
        DATE_FORMAT(pl.created_at, '%Y-%m-%d') AS load_date,
        pl.created_at,
        COALESCE(pl.total_quantity, SUM(pli.quantity), 0) AS total_quantity,
        pl.status AS load_status,
        pl.invoice_number,
        pl.invoice_url,
        pt.id AS trip_id,
        pt.status AS trip_status,
        pt.ended_at AS trip_ended_at,
        pu.id AS driver_id,
        pu.name AS driver_name,
        COALESCE(ujp.vehicle_number, d.vehicle_number, 'N/A') AS vehicle_number
      FROM purchase_loads pl
      LEFT JOIN purchase_load_items pli ON pli.load_id = pl.id
      LEFT JOIN purchase_trips pt ON pt.id = pl.trip_id
      LEFT JOIN users pu ON pu.id = COALESCE(pl.created_by, pt.purchase_manager_id)
      LEFT JOIN user_job_profiles ujp ON ujp.user_id = pu.id
      LEFT JOIN drivers d ON d.user_id = pu.id
      WHERE pl.agency_id = ? AND pl.status <> 'CANCELLED'
      GROUP BY
        pl.id,
        DATE_FORMAT(pl.created_at, '%Y-%m-%d'),
        pl.created_at,
        pl.total_quantity,
        pl.status,
        pl.invoice_number,
        pl.invoice_url,
        pt.id,
        pt.status,
        pt.ended_at,
        pu.id,
        pu.name,
        ujp.vehicle_number,
        d.vehicle_number
      ORDER BY pl.created_at DESC
    `, [agencyId]);

    const loadIdSet = new Set(purchaseLoads.map((r) => Number(r.load_id)));

    // 2. Fallback query for any standalone stock_transactions with type = 'PURCHASE' not linked to a purchase_load
    const [txRows] = await db.execute(`
      SELECT
        COALESCE(st.reference_id, st.driver_id) AS load_id,
        DATE_FORMAT(st.created_at, '%Y-%m-%d') AS load_date,
        MAX(st.created_at) AS created_at,
        SUM(st.quantity) AS total_quantity,
        MIN(st.isApproved) AS isApproved,
        d.id AS driver_id,
        COALESCE(ujp.vehicle_number, d.vehicle_number, 'N/A') AS vehicle_number,
        COALESCE(pu.name, u.name, 'Unknown Driver') AS driver_name,
        pt.id AS trip_id,
        pt.status AS trip_status,
        pt.ended_at AS trip_ended_at
      FROM stock_transactions st
      LEFT JOIN drivers d ON d.id = st.driver_id
      LEFT JOIN users u ON u.id = d.user_id
      LEFT JOIN purchase_loads pl ON pl.id = st.reference_id
      LEFT JOIN purchase_trips pt ON pt.id = pl.trip_id
      LEFT JOIN users pu ON pu.id = COALESCE(pl.created_by, pt.purchase_manager_id, st.created_by)
      LEFT JOIN user_job_profiles ujp ON ujp.user_id = COALESCE(pu.id, u.id)
      WHERE st.type = 'PURCHASE' AND st.agency_id = ?
      GROUP BY
        COALESCE(st.reference_id, st.driver_id),
        DATE_FORMAT(st.created_at, '%Y-%m-%d'),
        d.id,
        ujp.vehicle_number,
        d.vehicle_number,
        pu.name,
        u.name,
        pt.id,
        pt.status,
        pt.ended_at
      ORDER BY created_at DESC
    `, [agencyId]);

    const result = [];
    let index = 1;

    for (const row of purchaseLoads) {
      const isTripActive = Boolean(
        row.trip_id && (row.trip_status === "IN_PROGRESS" || !row.trip_ended_at)
      );
      const canApprove = !isTripActive && row.load_status === "PENDING";
      const status =
        row.load_status === "APPROVED"
          ? "APPROVED"
          : row.load_status === "CANCELLED"
          ? "CANCELLED"
          : isTripActive
          ? "TRIP_IN_PROGRESS"
          : row.load_status === "PENDING"
          ? "WAITING_APPROVAL"
          : "IN_PROGRESS";

      result.push({
        id: row.load_id,
        load: `Load-${index++}`,
        date: row.load_date,
        driver_id: row.driver_id,
        driver: row.driver_name || "Unknown Driver",
        invoice: row.invoice_number || `INV-${row.load_id}`,
        vehicle: row.vehicle_number || "N/A",
        qty: Number(row.total_quantity || 0),
        status,
        rawStatus: row.load_status,
        tripId: row.trip_id || null,
        tripStatus: row.trip_status || null,
        tripEndedAt: row.trip_ended_at || null,
        isTripActive,
        canApprove,
      });
    }

    for (const row of txRows) {
      if (!loadIdSet.has(Number(row.load_id))) {
        const isTripActive = Boolean(
          row.trip_id && (row.trip_status === "IN_PROGRESS" || !row.trip_ended_at)
        );
        const canApprove = !isTripActive && Number(row.isApproved) === 2;
        const status =
          Number(row.isApproved) === 1
            ? "APPROVED"
            : isTripActive
            ? "TRIP_IN_PROGRESS"
            : Number(row.isApproved) === 2
            ? "WAITING_APPROVAL"
            : "IN_PROGRESS";

        result.push({
          id: row.load_id,
          load: `Load-${index++}`,
          date: row.load_date,
          driver_id: row.driver_id,
          driver: row.driver_name || "Unknown Driver",
          invoice: `INV-${row.load_id}`,
          vehicle: row.vehicle_number || "N/A",
          qty: Number(row.total_quantity || 0),
          status,
          rawStatus:
            Number(row.isApproved) === 2
              ? "PENDING"
              : Number(row.isApproved) === 1
              ? "APPROVED"
              : "DRAFT",
          tripId: row.trip_id || null,
          tripStatus: row.trip_status || null,
          tripEndedAt: row.trip_ended_at || null,
          isTripActive,
          canApprove,
        });
      }
    }

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("getStockInLoads error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock in loads",
    });
  }
};

export const getStockInLoadDetail = async (req, res) => {
  try {
    const { loadId } = req.params;
    const agencyId = req.user?.agency_id || 1;

    // 1. Check purchase_loads
    const [loadRows] = await db.execute(
      `
      SELECT
        pli.id AS item_id,
        pli.product_id,
        pli.quantity,
        pl.id AS load_id,
        pl.created_at,
        pl.status AS load_status,
        pl.invoice_url,
        pl.invoice_number,
        pl.stock_area_id,
        pl.trip_id,
        pt.id AS pt_trip_id,
        pt.status AS trip_status,
        pt.ended_at AS trip_ended_at,
        p.name AS product_name,
        p.type AS product_type,
        c.name AS category_name,
        pu.name AS driver_name,
        COALESCE(ujp.vehicle_number, d.vehicle_number, 'N/A') AS vehicle_number
      FROM purchase_loads pl
      JOIN purchase_load_items pli ON pli.load_id = pl.id
      JOIN products p ON p.id = pli.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN purchase_trips pt ON pt.id = pl.trip_id
      LEFT JOIN users pu ON pu.id = COALESCE(pl.created_by, pt.purchase_manager_id)
      LEFT JOIN user_job_profiles ujp ON ujp.user_id = pu.id
      LEFT JOIN drivers d ON d.user_id = pu.id
      WHERE pl.id = ? AND pl.agency_id = ?
      ORDER BY pli.id ASC
      `,
      [loadId, agencyId]
    );

    if (loadRows.length) {
      const totalQty = loadRows.reduce(
        (sum, row) => sum + Number(row.quantity || 0),
        0
      );

      const tripId = loadRows[0].trip_id || loadRows[0].pt_trip_id || null;
      const tripStatus = loadRows[0].trip_status || null;
      const tripEndedAt = loadRows[0].trip_ended_at || null;
      const isTripActive = Boolean(tripId && (tripStatus === "IN_PROGRESS" || !tripEndedAt));
      const canApprove = !isTripActive && loadRows[0].load_status === "PENDING";

      const mapStatus = (status) => {
        if (status === "APPROVED") return "APPROVED";
        if (status === "CANCELLED") return "CANCELLED";
        if (isTripActive) return "TRIP_IN_PROGRESS";
        if (status === "PENDING") return "WAITING_APPROVAL";
        return "IN_PROGRESS";
      };

      return res.json({
        success: true,
        data: {
          id: loadId,
          load: `Load-${loadId}`,
          date: loadRows[0].created_at,
          driver: loadRows[0].driver_name || "Unknown Driver",
          vehicle: loadRows[0].vehicle_number || "N/A",
          depot: "HP Gas Depot - Sector 12",
          invoice: loadRows[0].invoice_number || `INV-${loadId}`,
          invoiceImageUrl: loadRows[0].invoice_url || null,
          qty: totalQty,
          status: mapStatus(loadRows[0].load_status),
          rawStatus: loadRows[0].load_status,
          tripId,
          tripStatus,
          tripEndedAt,
          isTripActive,
          canApprove,
          items: loadRows.map((row) => ({
            transaction_id: row.item_id,
            product_id: row.product_id,
            item: row.product_name,
            category: row.category_name,
            type: row.product_type,
            quantity: Number(row.quantity || 0),
          })),
        },
      });
    }

    // 2. Fallback: check stock_transactions
    const [rows] = await db.execute(
      `
      SELECT
        st.id,
        st.product_id,
        st.stock_area_id,
        st.quantity,
        st.isApproved,
        st.reference_id,
        st.driver_id,
        st.created_at,

        p.name AS product_name,
        p.type AS product_type,
        c.name AS category_name,

        COALESCE(ujp.vehicle_number, d.vehicle_number, 'N/A') AS vehicle_number,
        COALESCE(pu.name, u.name, 'Unknown Driver') AS driver_name,
        pl.invoice_url,
        pl.invoice_number,
        pl.trip_id,
        pt.id AS pt_trip_id,
        pt.status AS trip_status,
        pt.ended_at AS trip_ended_at
      FROM stock_transactions st
      JOIN products p ON p.id = st.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN drivers d ON d.id = st.driver_id
      LEFT JOIN users u ON u.id = d.user_id
      LEFT JOIN purchase_loads pl ON pl.id = st.reference_id
      LEFT JOIN purchase_trips pt ON pt.id = pl.trip_id
      LEFT JOIN users pu ON pu.id = COALESCE(pl.created_by, pt.purchase_manager_id)
      LEFT JOIN user_job_profiles ujp ON ujp.user_id = pu.id
      WHERE st.type = 'PURCHASE'
        AND COALESCE(st.reference_id, st.driver_id) = ?
        AND st.agency_id = ?
      ORDER BY st.id ASC
      `,
      [loadId, agencyId]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Stock in load not found",
      });
    }

    const totalQty = rows.reduce(
      (sum, row) => sum + Number(row.quantity || 0),
      0
    );

    const tripId = rows[0].trip_id || rows[0].pt_trip_id || null;
    const tripStatus = rows[0].trip_status || null;
    const tripEndedAt = rows[0].trip_ended_at || null;
    const isTripActive = Boolean(tripId && (tripStatus === "IN_PROGRESS" || !tripEndedAt));
    const canApprove = !isTripActive && Number(rows[0].isApproved) === 2;

    return res.json({
      success: true,
      data: {
        id: loadId,
        load: `Load-${loadId}`,
        date: rows[0].created_at,
        driver: rows[0].driver_name,
        vehicle: rows[0].vehicle_number,
        depot: "HP Gas Depot - Sector 12",
        invoice: rows[0].invoice_number || `INV-${loadId}`,
        invoiceImageUrl: rows[0].invoice_url || null,
        qty: totalQty,
        status:
          Number(rows[0].isApproved) === 1
            ? "APPROVED"
            : isTripActive
            ? "TRIP_IN_PROGRESS"
            : Number(rows[0].isApproved) === 2
              ? "WAITING_APPROVAL"
              : "IN_PROGRESS",
        rawStatus:
          Number(rows[0].isApproved) === 2
            ? "PENDING"
            : Number(rows[0].isApproved) === 1
            ? "APPROVED"
            : "DRAFT",
        tripId,
        tripStatus,
        tripEndedAt,
        isTripActive,
        canApprove,
        items: rows.map((row) => ({
          transaction_id: row.id,
          product_id: row.product_id,
          item: row.product_name,
          category: row.category_name,
          type: row.product_type,
          quantity: Number(row.quantity || 0),
        })),
      },
    });
  } catch (error) {
    console.error("getStockInLoadDetail error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock in load detail",
    });
  }
};

export const approveStockInLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { loadId } = req.params;
    const agencyId = req.user?.agency_id || 1;

    await connection.beginTransaction();

    // 1. Check purchase_loads first
    const [loadRows] = await connection.execute(
      `
      SELECT pl.id, pl.status, pl.stock_area_id, pl.created_by, pl.trip_id,
             pt.status AS trip_status, pt.ended_at AS trip_ended_at
      FROM purchase_loads pl
      LEFT JOIN purchase_trips pt ON pt.id = pl.trip_id
      WHERE pl.id = ? AND pl.agency_id = ?
      `,
      [loadId, agencyId]
    );

    let itemsToApprove = [];
    let isPurchaseLoad = false;

    if (loadRows.length) {
      isPurchaseLoad = true;
      if (loadRows[0].status === "APPROVED") {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "This load has already been approved",
        });
      }

      if (loadRows[0].status === "CANCELLED") {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "Cannot approve a cancelled load",
        });
      }

      // Check if associated trip is still active
      if (loadRows[0].trip_id) {
        const isTripActive = loadRows[0].trip_status === "IN_PROGRESS" || !loadRows[0].trip_ended_at;
        if (isTripActive) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: "Cannot approve stock while trip is active. The purchase driver must complete End Trip first.",
          });
        }
      }

      const [itemRows] = await connection.execute(
        `
        SELECT id, product_id, quantity
        FROM purchase_load_items
        WHERE load_id = ?
        `,
        [loadId]
      );

      itemsToApprove = itemRows;
    } else {
      // Fallback: check stock_transactions
      const [txRows] = await connection.execute(
        `
        SELECT st.id, st.product_id, st.quantity, pl.trip_id,
               pt.status AS trip_status, pt.ended_at AS trip_ended_at
        FROM stock_transactions st
        LEFT JOIN purchase_loads pl ON pl.id = st.reference_id
        LEFT JOIN purchase_trips pt ON pt.id = pl.trip_id
        WHERE st.type = 'PURCHASE'
          AND COALESCE(st.reference_id, st.driver_id) = ?
          AND st.isApproved = 2
          AND st.agency_id = ?
        `,
        [loadId, agencyId]
      );

      if (txRows.length && txRows[0].trip_id) {
        const isTripActive = txRows[0].trip_status === "IN_PROGRESS" || !txRows[0].trip_ended_at;
        if (isTripActive) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: "Cannot approve stock while trip is active. The purchase driver must complete End Trip first.",
          });
        }
      }

      itemsToApprove = txRows;
    }

    if (!itemsToApprove.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "No waiting-approval stock found for approval",
      });
    }

    // Increase physical + system stock in godown on purchase approval
    for (const row of itemsToApprove) {
      await increaseStock(connection, {
        productId: Number(row.product_id),
        quantity: Number(row.quantity || 0),
        systemQuantity: Number(row.quantity || 0), // system stock mirrors physical on purchase
      }, agencyId);

      const effectiveAreaId = loadRows[0]?.stock_area_id || DEFAULT_STOCK_AREA_ID || 1;
      await recordPurchaseInDailySnapshot(
        connection,
        agencyId,
        effectiveAreaId,
        Number(row.product_id),
        Number(row.quantity || 0)
      );
    }

    // Ensure stock_transactions are marked approved (isApproved = 1)
    if (isPurchaseLoad) {
      for (const row of itemsToApprove) {
        const [txCheck] = await connection.execute(
          `SELECT id FROM stock_transactions WHERE type = 'PURCHASE' AND reference_id = ? AND product_id = ? LIMIT 1`,
          [loadId, row.product_id]
        );
        if (txCheck.length) {
          await connection.execute(
            `UPDATE stock_transactions SET isApproved = 1 WHERE id = ?`,
            [txCheck[0].id]
          );
        } else {
          await connection.execute(
            `INSERT INTO stock_transactions (product_id, stock_area_id, type, quantity, isApproved, reference_id, created_by, stock_from, agency_id, created_at)
             VALUES (?, ?, 'PURCHASE', ?, 1, ?, ?, 'depot', ?, NOW())`,
            [
              row.product_id,
              loadRows[0]?.stock_area_id || null,
              row.quantity,
              loadId,
              loadRows[0]?.created_by || null,
              agencyId,
            ]
          );
        }
      }

      await syncPurchaseApprovalState(connection, loadId, agencyId);
    } else {
      await connection.execute(
        `
        UPDATE stock_transactions
        SET isApproved = 1
        WHERE type = 'PURCHASE'
          AND COALESCE(reference_id, driver_id) = ?
          AND isApproved = 2
          AND agency_id = ?
        `,
        [loadId, agencyId]
      );
      await syncPurchaseApprovalState(connection, loadId, agencyId);
    }

    await connection.commit();

    return res.json({
      success: true,
      message: "Stock approved successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error("approveStockInLoad error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to approve stock",
    });
  } finally {
    connection.release();
  }
};

export const getDriverLists = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT 
        d.id AS driver_id,
        d.vehicle_number,
        u.name AS driver_name
      FROM drivers d
      JOIN users u ON u.id = d.user_id
      WHERE u.agency_id = ?
      ORDER BY u.name ASC
    `, [req.user.agency_id]);

    return res.json({
      success: true,
      data: rows.map((row) => ({
        id: row.driver_id,
        name: row.driver_name,
        vehicle: row.vehicle_number || "N/A",
      })),
    });
  } catch (error) {
    console.error("getDriverLists error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch drivers",
    });
  }
};

export const getCylinderProducts = async (req, res) => {
  try {
    const mode = String(req.query.mode || "").toLowerCase();

    if (mode === "dispatch") {
      const [dispatchRows] = await db.execute(
        `
        SELECT
          p.id,
          p.name,
          p.type,
          c.name AS category_name,
          COALESCE(SUM(s.empty_quantity), 0) AS empty_available,
          COALESCE(SUM(s.defective_quantity), 0) AS defective_available
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN stock s ON s.product_id = p.id AND s.agency_id = ?
        GROUP BY p.id, p.name, p.type, c.name
        HAVING COALESCE(SUM(s.empty_quantity), 0) > 0
           OR COALESCE(SUM(s.defective_quantity), 0) > 0
        ORDER BY p.type ASC, p.name ASC
        `,
        [req.user.agency_id]
      );

      return res.json({
        success: true,
        data: {
          domestic: dispatchRows
            .filter(
              (item) =>
                String(item.type || "").toUpperCase() !== "COMMERCIAL"
            )
            .map((item) => ({
              id: item.id,
              name: item.name,
              category: item.category_name,
              emptyAvailable: Number(item.empty_available || 0),
              defectiveAvailable: Number(item.defective_available || 0),
            })),
          commercial: dispatchRows
            .filter(
              (item) =>
                String(item.type || "").toUpperCase() === "COMMERCIAL"
            )
            .map((item) => ({
              id: item.id,
              name: item.name,
              category: item.category_name,
              emptyAvailable: Number(item.empty_available || 0),
              defectiveAvailable: Number(item.defective_available || 0),
            })),
        },
      });
    }

    const [rows] = await db.execute(`
      SELECT
        p.id,
        p.name,
        p.type,
        c.name AS category_name,
        COALESCE(SUM(s.quantity), 0) AS available_quantity
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN stock s ON s.product_id = p.id AND s.agency_id = ?
      GROUP BY p.id, p.name, p.type, c.name
      ORDER BY p.type ASC, p.name ASC
    `, [req.user.agency_id]);

    return res.json({
      success: true,
      data: {
        domestic: rows
          .filter((item) =>
            `${item.type} ${item.category_name} ${item.name}`
              .toLowerCase()
              .includes("domestic")
          )
          .map((item) => ({
            id: item.id,
            name: item.name,
            category: item.category_name,
            availableQuantity: Number(item.available_quantity || 0),
          })),

        commercial: rows
          .filter((item) =>
            `${item.type} ${item.category_name} ${item.name}`
              .toLowerCase()
              .includes("commercial")
          )
          .map((item) => ({
            id: item.id,
            name: item.name,
            category: item.category_name,
            availableQuantity: Number(item.available_quantity || 0),
          })),
      },
    });
  } catch (error) {
    console.error("getCylinderProducts error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch products",
    });
  }
};

export const getStockOutLoads = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT
        COALESCE(st.reference_id, st.driver_id) AS load_id,
        DATE(st.created_at) AS load_date,
        MAX(st.created_at) AS created_at,

        SUM(CASE WHEN st.type = 'EMPTY_RETURN' THEN st.quantity ELSE 0 END) AS empty_quantity,
        SUM(CASE WHEN st.type = 'PURCHASE_RETURN' AND st.is_defective = 1 THEN st.quantity ELSE 0 END) AS defective_quantity,

        MIN(st.isApproved) AS isApproved,

        d.id AS driver_id,
        d.vehicle_number,
        u.name AS driver_name
      FROM stock_transactions st
      LEFT JOIN drivers d ON d.id = st.driver_id
      LEFT JOIN users u ON u.id = d.user_id
      WHERE (
        (st.type = 'EMPTY_RETURN' AND st.stock_from = 'godown')
        OR (
          st.type = 'PURCHASE_RETURN'
          AND st.is_defective = 1
          AND st.stock_from = 'stock_out'
        )
      ) AND st.agency_id = ?
      GROUP BY
        COALESCE(st.reference_id, st.driver_id),
        DATE(st.created_at),
        d.id,
        d.vehicle_number,
        u.name
      ORDER BY created_at DESC
    `, [req.user.agency_id]);

    return res.json({
      success: true,
      data: rows.map((row, index) => {
        const emptyQty = Number(row.empty_quantity || 0);
        const defectiveQty = Number(row.defective_quantity || 0);

        return {
          id: row.load_id,
          load: `Load-${index + 1}`,
          date: row.load_date,
          created_at: row.created_at,
          driver_id: row.driver_id,
          driver: row.driver_name || "Unknown Driver",
          invoice: `DSP-${row.load_id}`,
          vehicle: row.vehicle_number || "N/A",
          qty: emptyQty + defectiveQty,
          empty_qty: emptyQty,
          defective_qty: defectiveQty,
          status:
            Number(row.isApproved) === 1
              ? "APPROVED"
              : Number(row.isApproved) === 2
                ? "CANCELLED"
                : "PENDING",
        };
      }),
    });
  } catch (error) {
    console.error("getStockOutLoads error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock out loads",
    });
  }
};

export const createStockOutLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { driver_id, reference_id, items = [] } = req.body;

    if (!driver_id || !items.length) {
      return res.status(400).json({
        success: false,
        message: "Driver and items are required",
      });
    }

    const validItems = items.filter((item) => {
      const emptyQty = Number(item.empty_quantity || 0);
      const defectiveQty = Number(item.defective_quantity || 0);

      return Number(item.product_id) && (emptyQty > 0 || defectiveQty > 0);
    });

    if (!validItems.length) {
      return res.status(400).json({
        success: false,
        message: "At least one empty or defective quantity is required",
      });
    }

    await connection.beginTransaction();

    const finalReferenceId = reference_id || Date.now();
    const createdBy = req.user?.id || null;

    for (const item of validItems) {
      const productId = Number(item.product_id);
      const emptyQty = Number(item.empty_quantity || 0);
      const defectiveQty = Number(item.defective_quantity || 0);

      if (emptyQty > 0) {
        const availableEmpty = await getStockMetricTotalForUpdate(
          connection,
          productId,
          "empty_quantity",
          req.user.agency_id
        );

        if (emptyQty > availableEmpty) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: `Only ${availableEmpty} empty cylinder(s) available for product ${productId}`,
          });
        }
      }

      if (defectiveQty > 0) {
        const availableDefective = await getStockMetricTotalForUpdate(
          connection,
          productId,
          "defective_quantity",
          req.user.agency_id
        );

        if (defectiveQty > availableDefective) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: `Only ${availableDefective} defective cylinder(s) available for product ${productId}`,
          });
        }
      }

      if (emptyQty > 0) {
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
            driver_id,
            created_by,
            is_defective,
            stock_from,
            agency_id
          )
          VALUES (?, ?, 'EMPTY_RETURN', ?, 1, ?, ?, ?, 0, 'godown', ?)
          `,
          [
            productId,
            null,
            emptyQty,
            finalReferenceId,
            driver_id,
            createdBy,
            req.user.agency_id,
          ]
        );

        await consumeStockMetric(connection, productId, "empty_quantity", emptyQty, req.user.agency_id);
        // Deduct system empty stock — return trip reduces empty system stock (Image 2 - Section 6)
        await consumeStockMetric(connection, productId, "system_empty_quantity", emptyQty, req.user.agency_id);

        try {
          await connection.query(
            `
            UPDATE daily_stock_snapshots
            SET empty_closing = GREATEST(COALESCE(empty_closing, 0) - ?, 0),
                system_empty_closing = GREATEST(COALESCE(system_empty_closing, 0) - ?, 0),
                updated_at = NOW()
            WHERE agency_id = ? AND product_id = ? AND snapshot_date = CURDATE()
            `,
            [emptyQty, emptyQty, req.user.agency_id, productId]
          );
        } catch (e) {
          console.warn("Could not sync empty_closing in createStockOutLoad:", e.message);
        }
      }

      if (defectiveQty > 0) {
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
            driver_id,
            created_by,
            is_defective,
            stock_from,
            agency_id
          )
          VALUES (?, ?, 'PURCHASE_RETURN', ?, 1, ?, ?, ?, 1, 'stock_out', ?)
          `,
          [
            productId,
            null,
            defectiveQty,
            finalReferenceId,
            driver_id,
            createdBy,
            req.user.agency_id,
          ]
        );

        await consumeStockMetric(
          connection,
          productId,
          "defective_quantity",
          defectiveQty,
          req.user.agency_id
        );
      }
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Stock out load created and approved successfully",
      data: {
        reference_id: finalReferenceId,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createStockOutLoad error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create stock out load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getStockOutLoadDetail = async (req, res) => {
  try {
    const { loadId } = req.params;

    const [rows] = await db.execute(
      `
      SELECT
        st.id,
        st.product_id,
        st.stock_area_id,
        st.quantity,
        st.type AS transaction_type,
        st.is_defective,
        st.isApproved,
        st.reference_id,
        st.driver_id,
        st.created_at,

        p.name AS product_name,
        p.type AS product_type,
        c.name AS category_name,

        d.vehicle_number,
        u.name AS driver_name
      FROM stock_transactions st
      JOIN products p ON p.id = st.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN drivers d ON d.id = st.driver_id
      LEFT JOIN users u ON u.id = d.user_id
      WHERE COALESCE(st.reference_id, st.driver_id) = ?
        AND st.agency_id = ?
        AND (
          (st.type = 'EMPTY_RETURN' AND st.stock_from = 'godown')
          OR (
            st.type = 'PURCHASE_RETURN'
            AND st.is_defective = 1
            AND st.stock_from = 'stock_out'
          )
        )
      ORDER BY st.id ASC
      `,
      [loadId, req.user.agency_id]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Stock out load not found",
      });
    }

    const emptyItems = rows
      .filter((row) => row.transaction_type === "EMPTY_RETURN")
      .map((row) => ({
        transaction_id: row.id,
        product_id: row.product_id,
        item: row.product_name,
        category: row.category_name,
        type: row.product_type,
        quantity: Number(row.quantity || 0),
      }));

    const defectiveItems = rows
      .filter(
        (row) =>
          row.transaction_type === "PURCHASE_RETURN" &&
          Number(row.is_defective) === 1
      )
      .map((row) => ({
        transaction_id: row.id,
        product_id: row.product_id,
        item: row.product_name,
        category: row.category_name,
        type: row.product_type,
        quantity: Number(row.quantity || 0),
      }));

    const emptyQty = emptyItems.reduce(
      (sum, row) => sum + Number(row.quantity || 0),
      0
    );

    const defectiveQty = defectiveItems.reduce(
      (sum, row) => sum + Number(row.quantity || 0),
      0
    );

    return res.json({
      success: true,
      data: {
        id: loadId,
        load: "Load-1",
        date: rows[0].created_at,
        driver: rows[0].driver_name || "Unknown Driver",
        vehicle: rows[0].vehicle_number || "N/A",
        depot: "HP Gas Depot - Sector 12",
        invoice: `DSP-${loadId}`,
        qty: emptyQty + defectiveQty,
        empty_qty: emptyQty,
        defective_qty: defectiveQty,
        status:
          Number(rows[0].isApproved) === 1
            ? "APPROVED"
            : Number(rows[0].isApproved) === 2
              ? "CANCELLED"
              : "PENDING",
        items: emptyItems,
        defective_items: defectiveItems,
      },
    });
  } catch (error) {
    console.error("getStockOutLoadDetail error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock out load detail",
    });
  }
};

export const approveStockOutLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { loadId } = req.params;

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `
      SELECT 
        id,
        product_id,
        quantity,
        type,
        is_defective
      FROM stock_transactions
      WHERE COALESCE(reference_id, driver_id) = ?
        AND stock_from IN ('godown', 'stock_out')
        AND isApproved = 0
        AND agency_id = ?
        AND (
          type = 'EMPTY_RETURN'
          OR (type = 'PURCHASE_RETURN' AND is_defective = 1)
        )
      `,
      [loadId, req.user.agency_id]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "No pending stock out found for approval",
      });
    }

    for (const row of rows) {
      if (row.type === "EMPTY_RETURN") {
        await increaseStock(connection, {
          productId: Number(row.product_id),
          emptyQuantity: Number(row.quantity || 0),
        }, req.user.agency_id);
      }

      if (row.type === "PURCHASE_RETURN" && Number(row.is_defective) === 1) {
        await increaseStock(connection, {
          productId: Number(row.product_id),
          defectiveQuantity: Number(row.quantity || 0),
        }, req.user.agency_id);
      }
    }

    await connection.execute(
      `
      UPDATE stock_transactions
      SET isApproved = 1
      WHERE COALESCE(reference_id, driver_id) = ?
        AND stock_from IN ('godown', 'stock_out')
        AND isApproved = 0
        AND agency_id = ?
        AND (
          type = 'EMPTY_RETURN'
          OR (type = 'PURCHASE_RETURN' AND is_defective = 1)
        )
      `,
      [loadId, req.user.agency_id]
    );

    await connection.commit();

    return res.json({
      success: true,
      message: "Stock out approved successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error("approveStockOutLoad error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to approve stock out",
    });
  } finally {
    connection.release();
  }
};
export const getDefectiveLoads = async (req, res) => {
  try {
    const { startDate, endDate } = resolveDateRange(req.query);

    const [rows] = await db.execute(
      `
      SELECT
        COALESCE(st.reference_id, st.id) AS load_id,
        st.reference_id,
        st.stock_from,
        DATE(st.created_at) AS load_date,
        MAX(st.created_at) AS created_at,
        SUM(st.quantity) AS total_quantity,

        d.id AS driver_id,
        d.vehicle_number,
        u.name AS driver_name,

        GROUP_CONCAT(p.name SEPARATOR ', ') AS products
      FROM stock_transactions st
      JOIN products p ON p.id = st.product_id
      LEFT JOIN drivers d ON d.id = st.driver_id
      LEFT JOIN users u ON u.id = d.user_id
      WHERE st.type = 'PURCHASE_RETURN'
        AND COALESCE(st.is_defective, 0) = 1
        AND st.stock_from != 'stock_out'
        AND st.agency_id = ?
        AND DATE(st.created_at) BETWEEN ? AND ?
      GROUP BY
        COALESCE(st.reference_id, st.id),
        st.reference_id,
        st.stock_from,
        DATE(st.created_at),
        d.id,
        d.vehicle_number,
        u.name
      ORDER BY created_at DESC
      `,
      [req.user.agency_id, startDate, endDate]
    );

    const loads = rows.map((row) => {
      const source = row.stock_from || "default";

      let tag = "FOUND IN GODOWN";
      let title = "Godown Defective";
      let desc = "Defective cylinder found in stock";
      let person = "Storekeeper";
      let type = "godown";

      if (source === "depot") {
        tag = "FROM DEPOT LOAD";
        title = `Load-${row.load_id}`;
        desc = "Found during depot unload";
        person = row.driver_name || "Depot";
        type = "depot";
      }

      if (source === "driver") {
        tag = "DELIVERY BOY RETURN";
        title = `Trip-DLV-${row.load_id}`;
        desc = "Customer returned damaged cylinder";
        person = row.driver_name || "Driver";
        type = "delivery";
      }

      return {
        id: row.load_id,
        title,
        tag,
        desc,
        person,
        time: new Date(row.created_at).toLocaleTimeString("en-IN", {
          hour: "2-digit",
          minute: "2-digit",
        }),
        qty: Number(row.total_quantity || 0),
        type,
        stock_from: source,
        date: row.load_date,
      };
    });

    const summary = {
      depot: loads
        .filter((x) => x.stock_from === "depot")
        .reduce((sum, x) => sum + x.qty, 0),

      godown: loads
        .filter((x) => x.stock_from === "godown")
        .reduce((sum, x) => sum + x.qty, 0),

      delivery: loads
        .filter((x) => x.stock_from === "driver")
        .reduce((sum, x) => sum + x.qty, 0),
    };

    return res.json({
      success: true,
      data: {
        summary,
        loads,
      },
    });
  } catch (error) {
    console.error("getDefectiveLoads error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch defective loads",
    });
  }
};

export const createDefectiveLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      stock_from = "godown",
      driver_id = null,
      reference_id,
      items = [],
      notes = "",
      bay_location = "",
    } = req.body;

    const validStockFrom = ["depot", "godown", "driver"];

    if (!validStockFrom.includes(stock_from)) {
      return res.status(400).json({
        success: false,
        message: "Invalid stock_from value",
      });
    }

    if (stock_from === "driver" && !driver_id) {
      return res.status(400).json({
        success: false,
        message: "Driver is required when stock_from is driver",
      });
    }

    const validItems = items.filter(
      (item) => Number(item.product_id) && Number(item.quantity) > 0
    );

    if (!validItems.length) {
      return res.status(400).json({
        success: false,
        message: "At least one defective quantity is required",
      });
    }

    await connection.beginTransaction();

    const finalReferenceId = reference_id || Date.now();

    for (const item of validItems) {
      const productId = Number(item.product_id);
      const qty = Number(item.quantity || 0);

      // When marking cylinders from godown stock as defective, check and
      // consume from available (sellable) quantity first
      if (stock_from === "godown") {
        const availableQty = await getAvailableStockForUpdate(connection, productId, req.user.agency_id);

        if (availableQty < qty) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: `Insufficient available stock for product ${productId}. Available: ${availableQty}, required: ${qty}`,
          });
        }

        await consumeStockQuantity(connection, productId, qty, req.user.agency_id);
      }

      await connection.execute(
        `
        INSERT INTO stock_transactions
        (
          product_id,
          stock_area_id,
          type,
          quantity,
          isApproved,
          is_defective,
          reference_id,
          driver_id,
          created_by,
          stock_from,
          agency_id
        )
        VALUES (?, ?, 'PURCHASE_RETURN', ?, 1, 1, ?, ?, ?, ?, ?)
        `,
        [
          productId,
          null,
          qty,
          finalReferenceId,
          stock_from === "driver" ? driver_id : null,
          req.user?.id || null,
          stock_from,
          req.user.agency_id,
        ]
      );

      await increaseStock(connection, {
        productId,
        defectiveQuantity: qty,
      }, req.user.agency_id);
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Defective stock logged successfully",
      data: {
        reference_id: finalReferenceId,
        stock_from,
        notes,
        bay_location,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createDefectiveLoad error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to log defective stock",
    });
  } finally {
    connection.release();
  }
};

export const getDeliveryDrivers = async (req, res) => {
  try {
    const { filter = "today" } = req.query;

    let dateSalesCondition = "DATE(s.created_at) = CURDATE()";
    let dateReturnCondition = "DATE(st.created_at) = CURDATE()";
    // Allocations are dated by assigned_at (an approved booking is only handed
    // to the driver on the day it is approved), deliveries by created_at.
    let dateAllocationCondition =
      "DATE(COALESCE(s.assigned_at, s.created_at)) = CURDATE()";
    // Start of the reported period - everything still in hand before it is
    // carried forward into the period.
    let carryForwardBoundary = CARRY_FORWARD_DATE_EXPR.TODAY;

    if (filter === "yesterday") {
      dateSalesCondition = "DATE(s.created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)";
      dateReturnCondition = "DATE(st.created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)";
      dateAllocationCondition =
        "DATE(COALESCE(s.assigned_at, s.created_at)) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)";
      carryForwardBoundary = CARRY_FORWARD_DATE_EXPR.YESTERDAY;
    }

    if (filter === "week") {
      dateSalesCondition = "YEARWEEK(s.created_at, 1) = YEARWEEK(CURDATE(), 1)";
      dateReturnCondition = "YEARWEEK(st.created_at, 1) = YEARWEEK(CURDATE(), 1)";
      dateAllocationCondition =
        "YEARWEEK(COALESCE(s.assigned_at, s.created_at), 1) = YEARWEEK(CURDATE(), 1)";
      carryForwardBoundary = CARRY_FORWARD_DATE_EXPR.WEEK_START;
    }

    // Get all drivers from the database for the current agency
    const [allDrivers] = await db.execute(`
      SELECT
        d.id AS driver_id,
        d.vehicle_number,
        u.name AS driver_name
      FROM drivers d
      JOIN users u ON u.id = d.user_id
      WHERE u.agency_id = ?
      ORDER BY u.name ASC
    `, [req.user.agency_id]);

    // Get allocation stats for each driver within date range
    const [allocationStats] = await db.execute(`
      SELECT
        s.driver_id,
        COALESCE(SUM(
          CASE
            WHEN s.status = 'ASSIGNED'
              AND si.status = 'ASSIGNED'
              AND ${dateAllocationCondition}
            THEN si.quantity
            ELSE 0
          END
        ), 0) AS allocated,

        COALESCE(SUM(
          CASE
            WHEN s.status = 'DELIVERED'
              AND si.status = 'DELIVERED'
              AND ${dateSalesCondition}
            THEN COALESCE(si.delivered_qty, si.quantity, 0)
            ELSE 0
          END
        ), 0) AS delivered,

        COALESCE(SUM(
          CASE
            WHEN si.empty_cylinder_status IN ('DELIVERED', 'PARTIAL_DELIVERED')
              AND ${dateSalesCondition}
            THEN COALESCE(si.empty_cylinder_qty, 0)
            ELSE 0
          END
        ), 0) AS empty_collected

      FROM sales s
      JOIN sales_items si ON si.sale_id = s.id
      WHERE (${dateSalesCondition} OR ${dateAllocationCondition})
        AND s.agency_id = ?
      GROUP BY s.driver_id
    `, [req.user.agency_id]);

    // In-hand returns for each driver within date range. Requests awaiting
    // approval count too (isApproved IN (0, 1)) so this figure - and therefore
    // the in-hand total below - agrees with the driver app and with what gets
    // carried forward to the next day.
    const [returnStats] = await db.execute(`
      SELECT
        st.driver_id,
        COALESCE(SUM(
          CASE WHEN st.is_defective = 0 THEN st.quantity ELSE 0 END
        ), 0) AS returned_empty,
        COALESCE(SUM(
          CASE WHEN st.is_defective = 1 THEN st.quantity ELSE 0 END
        ), 0) AS returned_defective
      FROM stock_transactions st
      WHERE st.stock_from = 'driver'
        AND st.type = 'PURCHASE_RETURN'
        AND st.isApproved IN (0, 1)
        AND ${dateReturnCondition}
        AND st.agency_id = ?
      GROUP BY st.driver_id
    `, [req.user.agency_id]);

    // Cylinders left in hand from before the reported period. They are added to
    // the period's allocated figure instead of blocking the next allocation.
    const { byDriver: carryForwardByDriver } = await getDriverCarryForward(db, {
      driverId: null,
      asOfDate: carryForwardBoundary,
      openingBalance: true,
      agencyId: req.user.agency_id,
    });

    // Create maps for faster lookup
    const allocationMap = new Map();
    allocationStats.forEach((row) => {
      allocationMap.set(Number(row.driver_id), {
        allocated: Number(row.allocated || 0),
        delivered: Number(row.delivered || 0),
        empty: Number(row.empty_collected || 0),
      });
    });

    const returnMap = new Map();
    returnStats.forEach((row) => {
      returnMap.set(Number(row.driver_id), {
        empty: Number(row.returned_empty || 0),
        defective: Number(row.returned_defective || 0),
      });
    });

    // Combine all data for all drivers
    const result = allDrivers.map((driver) => {
      const driverId = Number(driver.driver_id);
      const allocation = allocationMap.get(driverId) || { allocated: 0, delivered: 0, empty: 0 };
      const returns = returnMap.get(driverId) || { empty: 0, defective: 0 };
      const carriedForward = Number(carryForwardByDriver.get(driverId) || 0);

      // Allocated now means "everything the driver is holding for this period":
      // freshly allocated cylinders plus the ones brought forward.
      const totalAllocated = allocation.allocated + carriedForward;

      return {
        id: driverId,
        name: driver.driver_name,
        vehicle: driver.vehicle_number || "N/A",
        allocated: totalAllocated,
        allocatedToday: allocation.allocated,
        carriedForward,
        delivered: allocation.delivered,
        empty: allocation.empty,
        inHand: Math.max(totalAllocated - allocation.delivered - returns.empty - returns.defective, 0),
      };
    });

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("getDeliveryDrivers error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch delivery drivers",
      error: error.message,
    });
  }
};

export const getDriverDayWiseSummary = async (req, res) => {
  try {
    const { driverId } = req.params;

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "Driver ID is required",
      });
    }

    // Day-wise allocations (the batches handed to the driver on that day).
    const [allocationRows] = await db.execute(`
      SELECT
        DATE(COALESCE(s.assigned_at, s.created_at)) AS activity_date,
        COALESCE(SUM(si.quantity), 0) AS allocated_qty
      FROM sales s
      JOIN sales_items si ON si.sale_id = s.id
      WHERE s.driver_id = ?
        AND s.status = 'ASSIGNED'
        AND s.agency_id = ?
        AND si.allocation_sales_item_id IS NULL
      GROUP BY DATE(COALESCE(s.assigned_at, s.created_at))
    `, [driverId, req.user.agency_id]);

    // Day-wise deliveries made out of those batches. Dated by the delivery
    // itself, so a cylinder allocated yesterday and delivered today reduces
    // today's in-hand - not yesterday's.
    const [deliveryRows] = await db.execute(`
      SELECT
        DATE(COALESCE(cs.delivered_at, cs.created_at)) AS activity_date,
        COALESCE(SUM(COALESCE(child.delivered_qty, child.quantity, 0)), 0) AS delivered_qty
      FROM sales_items child
      INNER JOIN sales cs ON cs.id = child.sale_id
      WHERE cs.driver_id = ?
        AND cs.status = 'DELIVERED'
        AND cs.agency_id = ?
        AND child.allocation_sales_item_id IS NOT NULL
      GROUP BY DATE(COALESCE(cs.delivered_at, cs.created_at))
    `, [driverId, req.user.agency_id]);

    // Day-wise returns to the godown. Pending requests count too (isApproved
    // IN (0, 1)) so the ledger matches the in-hand figure shown to the driver.
    const [returnRows] = await db.execute(`
      SELECT
        DATE(st.created_at) AS activity_date,
        COALESCE(SUM(
          CASE WHEN st.is_defective = 0 THEN st.quantity ELSE 0 END
        ), 0) AS empty_returned,
        COALESCE(SUM(
          CASE WHEN st.is_defective = 1 THEN st.quantity ELSE 0 END
        ), 0) AS defective_returned
      FROM stock_transactions st
      WHERE st.driver_id = ?
        AND st.stock_from = 'driver'
        AND st.type = 'PURCHASE_RETURN'
        AND st.isApproved IN (0, 1)
        AND st.agency_id = ?
        AND st.allocation_sales_item_id IS NOT NULL
      GROUP BY DATE(st.created_at)
    `, [driverId, req.user.agency_id]);

    const normalizeDateKey = (rawValue) => {
      if (!rawValue) {
        return null;
      }

      if (typeof rawValue === "string") {
        return rawValue.slice(0, 10);
      }

      if (rawValue instanceof Date && !Number.isNaN(rawValue.getTime())) {
        const y = rawValue.getFullYear();
        const m = String(rawValue.getMonth() + 1).padStart(2, "0");
        const d = String(rawValue.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
      }

      const parsed = new Date(rawValue);

      if (Number.isNaN(parsed.getTime())) {
        return null;
      }

      const y = parsed.getFullYear();
      const m = String(parsed.getMonth() + 1).padStart(2, "0");
      const d = String(parsed.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    };

    const dayWiseMap = new Map();

    const ensureDay = (dateStr) => {
      if (!dayWiseMap.has(dateStr)) {
        dayWiseMap.set(dateStr, {
          date: dateStr,
          carriedForward: 0,
          allocated: 0,
          totalAllocated: 0,
          delivered: 0,
          returned: 0,
          inHand: 0,
        });
      }

      return dayWiseMap.get(dateStr);
    };

    allocationRows.forEach((row) => {
      const dateStr = normalizeDateKey(row.activity_date);
      if (!dateStr) return;
      ensureDay(dateStr).allocated += Number(row.allocated_qty || 0);
    });

    deliveryRows.forEach((row) => {
      const dateStr = normalizeDateKey(row.activity_date);
      if (!dateStr) return;
      ensureDay(dateStr).delivered += Number(row.delivered_qty || 0);
    });

    returnRows.forEach((row) => {
      const dateStr = normalizeDateKey(row.activity_date);
      if (!dateStr) return;
      ensureDay(dateStr).returned +=
        Number(row.empty_returned || 0) + Number(row.defective_returned || 0);
    });

    // Walk the days oldest -> newest so each day opens with whatever was left
    // in the driver's hands at the close of the previous one.
    const ascendingDays = Array.from(dayWiseMap.values()).sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );

    let openingBalance = 0;

    ascendingDays.forEach((day) => {
      day.carriedForward = openingBalance;
      day.totalAllocated = openingBalance + day.allocated;
      day.inHand = Math.max(
        day.totalAllocated - day.delivered - day.returned,
        0
      );
      openingBalance = day.inHand;
    });

    const summary = ascendingDays.slice().reverse();

    return res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    console.error("getDriverDayWiseSummary error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch driver day-wise summary",
      error: error.message,
    });
  }
};

export const createDriverAllocation = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { driver_id, items = [] } = req.body;

    if (!driver_id) {
      return res.status(400).json({
        success: false,
        message: "Driver is required",
      });
    }

    const validItems = items.filter(
      (item) => Number(item.product_id) && Number(item.quantity) > 0
    );

    if (!validItems.length) {
      return res.status(400).json({
        success: false,
        message: "At least one product quantity is required",
      });
    }

    // Cylinders still in hand from a PREVIOUS day no longer block a new
    // allocation. They are carried forward instead: the old batches stay open
    // (the driver can keep delivering or returning against them) and their
    // outstanding quantity is reported alongside today's allocation so every
    // screen shows the full quantity the driver is holding.
    //
    // Nothing is re-issued from godown stock for the carried-forward part -
    // that stock was already deducted on the day it was originally allocated -
    // so no duplicate sales_items or stock_transactions rows are created here.
    const carryForward = await getDriverCarryForward(connection, {
      driverId: driver_id,
      asOfDate: CARRY_FORWARD_DATE_EXPR.TODAY,
      openingBalance: true,
      agencyId: req.user.agency_id,
    });

    const carriedForwardQty = carryForward.total;

    await connection.beginTransaction();

    const productIds = [
      ...new Set(validItems.map((item) => Number(item.product_id))),
    ];

    const placeholders = productIds.map(() => "?").join(",");

    const [productRows] = await connection.execute(
      `
      SELECT id, name, price
      FROM products
      WHERE id IN (${placeholders})
      `,
      productIds
    );

    const productMap = new Map(
      productRows.map((row) => [Number(row.id), row])
    );

    for (const item of validItems) {
      if (!productMap.has(Number(item.product_id))) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: `Product ${item.product_id} not found`,
        });
      }
    }

    const requiredByProduct = new Map();

    validItems.forEach((item) => {
      const productId = Number(item.product_id);
      const qty = Number(item.quantity || 0);
      requiredByProduct.set(
        productId,
        Number(requiredByProduct.get(productId) || 0) + qty
      );
    });

    for (const [productId, requiredQty] of requiredByProduct.entries()) {
      const availableQty = await getAvailableStockForUpdate(connection, productId, req.user.agency_id);

      if (availableQty < requiredQty) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for product ${productId}. Available ${availableQty}, required ${requiredQty}`,
        });
      }
    }

    let totalAmount = 0;

    validItems.forEach((item) => {
      const product = productMap.get(Number(item.product_id));
      totalAmount +=
        Number(product?.price || 0) * Number(item.quantity || 0);
    });

    const [saleResult] = await connection.execute(
      `
      INSERT INTO sales
      (
        driver_id,
        total_amount,
        payment_method,
        status,
        sale_type,
        sales_from,
        created_at,
        updated_at,
        assigned_at,
        agency_id
      )
      VALUES (?, ?, 'ONLINE', 'ASSIGNED', 'SALE', 'DRIVER', NOW(), NOW(), NOW(), ?)
      `,
      [driver_id, totalAmount, req.user.agency_id]
    );

    const saleId = saleResult.insertId;
    const batchNo = `B-${saleId}`;
    const createdBy = req.user?.id || null;

    for (const item of validItems) {
      const productId = Number(item.product_id);
      const quantity = Number(item.quantity || 0);

      const [salesItemResult] = await connection.execute(
        `
        INSERT INTO sales_items
        (
          sale_id,
          product_id,
          quantity,
          price,
          status,
          delivered_qty,
          empty_cylinder_qty,
          defective_qty,
          batch_no,
          allocation_sale_id,
          allocation_sales_item_id
        )
        VALUES (?, ?, ?, 0, 'ASSIGNED', 0, 0, 0, ?, ?, NULL)
        `,
        [saleId, productId, quantity, batchNo, saleId]
      );

      await consumeStockQuantity(connection, productId, quantity, req.user.agency_id);

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
          driver_id,
          created_by,
          stock_from,
          is_defective,
          batch_no,
          allocation_sale_id,
          allocation_sales_item_id,
          agency_id
        )
        VALUES (?, ?, 'ADJUSTMENT_SUBTRACT', ?, 1, ?, ?, ?, 'godown', 0, ?, ?, ?, ?)
        `,
        [
          productId,
          null,
          quantity,
          saleId,
          Number(driver_id),
          createdBy,
          batchNo,
          saleId,
          salesItemResult.insertId,
          req.user.agency_id,
        ]
      );
    }

    await connection.commit();

    const allocatedNow = validItems.reduce(
      (sum, item) => sum + Number(item.quantity || 0),
      0
    );

    return res.status(201).json({
      success: true,
      message: carriedForwardQty
        ? `Driver allocation created successfully. ${carriedForwardQty} cylinder(s) carried forward from previous day(s) are included in today's total.`
        : "Driver allocation created successfully",
      data: {
        sale_id: saleId,
        batch_no: batchNo,
        allocatedNow,
        carriedForward: carriedForwardQty,
        // Everything the driver is holding for today: freshly allocated plus
        // whatever was left over from previous days.
        totalAllocated: allocatedNow + carriedForwardQty,
        carriedForwardItems: carryForward.byProduct.map((item) => ({
          productId: item.productId,
          productName: item.productName,
          productType: item.productType,
          quantity: item.quantity,
        })),
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createDriverAllocation error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create driver allocation",
    });
  } finally {
    connection.release();
  }
};

export const getReturnsToday = async (req, res) => {
  try {
    const { startDate, endDate } = resolveDateRange(req.query);
    const agencyId = req.user?.agency_id || 1;

    const [drivers] = await db.execute(
      `
      SELECT DISTINCT
        d.id AS driver_id,
        d.vehicle_number,
        u.name AS driver_name
      FROM stock_transactions st
      LEFT JOIN sales linked_sale
        ON linked_sale.id = st.reference_id
       AND linked_sale.driver_id = st.driver_id
      JOIN drivers d ON d.id = st.driver_id
      JOIN users u ON u.id = d.user_id
      WHERE st.driver_id IS NOT NULL
        AND st.isApproved = 0
        AND (st.agency_id = ? OR d.agency_id = ? OR u.agency_id = ?)
        AND DATE(st.created_at) BETWEEN ? AND ?
        AND st.type IN ('EMPTY_RETURN', 'PURCHASE_RETURN')
        AND (
          st.type <> 'EMPTY_RETURN'
          OR linked_sale.id IS NULL
        )
      ORDER BY u.name ASC
      `,
      [agencyId, agencyId, agencyId, startDate, endDate]
    );

    const [rows] = await db.execute(
      `
      SELECT
        st.id,
        st.driver_id,
        st.product_id,
        st.type,
        st.quantity,
        st.isApproved,
        st.is_defective,
        st.created_at,

        p.name AS product_name,
        p.type AS product_type,
        c.name AS category_name
      FROM stock_transactions st
      LEFT JOIN sales linked_sale
        ON linked_sale.id = st.reference_id
       AND linked_sale.driver_id = st.driver_id
      JOIN products p ON p.id = st.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      JOIN drivers d ON d.id = st.driver_id
      JOIN users u ON u.id = d.user_id
      WHERE st.driver_id IS NOT NULL
        AND st.isApproved = 0
        AND (st.agency_id = ? OR d.agency_id = ? OR u.agency_id = ?)
        AND DATE(st.created_at) BETWEEN ? AND ?
        AND st.type IN ('EMPTY_RETURN', 'PURCHASE_RETURN')
        AND (
          st.type <> 'EMPTY_RETURN'
          OR linked_sale.id IS NULL
        )
      ORDER BY st.created_at DESC
      `,
      [agencyId, agencyId, agencyId, startDate, endDate]
    );

    const data = drivers.map((driver) => {
      const driverRows = rows.filter(
        (row) => Number(row.driver_id) === Number(driver.driver_id)
      );

      const emptyItems = driverRows.filter(
        (row) => row.type === "EMPTY_RETURN"
      );

      const normalItems = driverRows.filter(
        (row) => row.type === "PURCHASE_RETURN" && Number(row.is_defective) === 0
      );

      const defectiveItems = driverRows.filter(
        (row) => row.type === "PURCHASE_RETURN" && Number(row.is_defective) === 1
      );

      const totalEmpty = emptyItems.reduce(
        (sum, row) => sum + Number(row.quantity || 0),
        0
      );

      const totalNormal = normalItems.reduce(
        (sum, row) => sum + Number(row.quantity || 0),
        0
      );

      const totalDefective = defectiveItems.reduce(
        (sum, row) => sum + Number(row.quantity || 0),
        0
      );

      const total = totalEmpty + totalNormal + totalDefective;

      return {
        driver_id: driver.driver_id,
        driver_name: driver.driver_name,
        vehicle_number: driver.vehicle_number,
        time: driverRows[0]?.created_at || null,
        total,
        empty: totalEmpty,
        normal: totalNormal,
        defective: totalDefective,
        items: driverRows.map((row) => ({
          id: row.id,
          product_id: row.product_id,
          name: row.product_name,
          type: row.product_type,
          category: row.category_name,
          quantity: Number(row.quantity || 0),
          condition:
            row.type === "EMPTY_RETURN"
              ? "empty"
              : Number(row.is_defective) === 1
                ? "defective"
                : "normal",
        })),
      };
    });

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("getReturnsToday error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch returns today",
    });
  }
};

export const approveReturnByCondition = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { driver_id, condition } = req.body;

    if (!driver_id || !condition) {
      return res.status(400).json({
        success: false,
        message: "driver_id and condition are required",
      });
    }

    let targetAgencyId = req.user?.agency_id;
    if (!targetAgencyId && driver_id) {
      const [driverRows] = await connection.execute(
        `SELECT d.agency_id AS driver_agency_id, u.agency_id AS user_agency_id
         FROM drivers d
         LEFT JOIN users u ON u.id = d.user_id
         WHERE d.id = ?
         LIMIT 1`,
        [driver_id]
      );
      targetAgencyId = driverRows[0]?.driver_agency_id || driverRows[0]?.user_agency_id;
    }
    const effectiveAgencyId = targetAgencyId || 1;

    let selectTypeCondition = "";
    let updateTypeCondition = "";
    let params = [driver_id];

    if (condition === "empty") {
      selectTypeCondition = `st.type = 'EMPTY_RETURN'`;
      updateTypeCondition = `st.type = 'EMPTY_RETURN'`;
    } else if (condition === "normal") {
      selectTypeCondition = `st.type = 'PURCHASE_RETURN' AND st.is_defective = 0`;
      updateTypeCondition = `st.type = 'PURCHASE_RETURN' AND st.is_defective = 0`;
    } else if (condition === "defective") {
      selectTypeCondition = `st.type = 'PURCHASE_RETURN' AND st.is_defective = 1`;
      updateTypeCondition = `st.type = 'PURCHASE_RETURN' AND st.is_defective = 1`;
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid condition",
      });
    }

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `
      SELECT st.id, st.product_id, st.quantity, st.type, st.is_defective, st.agency_id
      FROM stock_transactions st
      LEFT JOIN sales linked_sale
        ON linked_sale.id = st.reference_id
       AND linked_sale.driver_id = st.driver_id
      WHERE st.driver_id = ?
        AND st.isApproved = 0
        AND (
          st.type <> 'EMPTY_RETURN'
          OR linked_sale.id IS NULL
        )
        AND ${selectTypeCondition}
      `,
      params
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "No pending returns found",
      });
    }

    for (const row of rows) {
      if (condition === "empty") {
        await increaseStock(connection, {
          productId: Number(row.product_id),
          emptyQuantity: Number(row.quantity || 0),
        }, effectiveAgencyId);

        try {
          await connection.query(
            `
            UPDATE daily_stock_snapshots
            SET empty_closing = COALESCE(empty_closing, 0) + ?,
                updated_at = NOW()
            WHERE agency_id = ? AND product_id = ? AND snapshot_date = CURDATE()
            `,
            [Number(row.quantity || 0), effectiveAgencyId, Number(row.product_id)]
          );
        } catch (e) {
          console.warn("Could not sync empty_closing in approveReturnByCondition:", e.message);
        }
      }

      if (condition === "normal") {
        await increaseStock(connection, {
          productId: Number(row.product_id),
          quantity: Number(row.quantity || 0),
        }, effectiveAgencyId);
      }

      if (condition === "defective") {
        await increaseStock(connection, {
          productId: Number(row.product_id),
          defectiveQuantity: Number(row.quantity || 0),
        }, effectiveAgencyId);
      }
    }

    await connection.execute(
      `
      UPDATE stock_transactions st
      SET isApproved = 1,
          agency_id = ?
      WHERE st.driver_id = ?
        AND st.isApproved = 0
        AND (
          st.type <> 'EMPTY_RETURN'
          OR st.reference_id IS NULL
          OR st.reference_id NOT IN (
            SELECT id FROM sales WHERE driver_id = ?
          )
        )
        AND ${updateTypeCondition}
      `,
      [effectiveAgencyId, driver_id, driver_id]
    );

    await connection.commit();

    return res.json({
      success: true,
      message: `${condition} returns approved successfully`,
    });
  } catch (error) {
    await connection.rollback();
    console.error("approveReturnByCondition error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to approve returns",
    });
  } finally {
    connection.release();
  }
};

// Empty-cylinder return requests raised by the customer-issues transfer flow.
// These have no driver (driver_id IS NULL) and reference a connection transfer,
// so they are surfaced and approved separately from the driver returns.
export const getTransferEmptyReturns = async (req, res) => {
  try {
    const [rows] = await db.execute(
      `
      SELECT
        st.id,
        st.product_id,
        st.quantity,
        st.created_at,
        t.id AS transfer_id,
        p.name AS product_name,
        p.type AS product_type,
        c.name AS category_name,
        eu.name AS from_customer_name,
        COALESCE(cta.agency_name, nu.name) AS to_customer_name
      FROM stock_transactions st
      JOIN customer_connection_transfers t ON t.id = st.reference_id
      JOIN products p ON p.id = st.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN users eu ON eu.id = t.existing_customer_id
      LEFT JOIN users nu ON nu.id = t.new_customer_id
      LEFT JOIN customer_transfer_agencies cta ON cta.transfer_id = t.id
      WHERE st.type = 'EMPTY_RETURN'
        AND st.driver_id IS NULL
        AND st.stock_from = 'default'
        AND COALESCE(st.isApproved, 0) = 0
      ORDER BY st.created_at DESC, st.id DESC
      `
    );

    const data = rows.map((row) => ({
      id: Number(row.id),
      transferId: Number(row.transfer_id),
      productId: Number(row.product_id),
      productName: row.product_name,
      productType: row.product_type,
      category: row.category_name,
      quantity: Number(row.quantity || 0),
      fromCustomer: row.from_customer_name || "",
      toCustomer: row.to_customer_name || "",
      createdAt: row.created_at,
    }));

    return res.json({ success: true, data });
  } catch (error) {
    console.error("getTransferEmptyReturns error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch transfer empty returns",
    });
  }
};

export const approveTransferEmptyReturn = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const txnId = Number(req.body?.id);

    if (!txnId) {
      return res.status(400).json({
        success: false,
        message: "id is required",
      });
    }

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `
      SELECT st.id, st.product_id, st.quantity
      FROM stock_transactions st
      JOIN customer_connection_transfers t ON t.id = st.reference_id
      WHERE st.id = ?
        AND st.type = 'EMPTY_RETURN'
        AND st.driver_id IS NULL
        AND st.stock_from = 'default'
        AND COALESCE(st.isApproved, 0) = 0
      LIMIT 1
      `,
      [txnId]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Pending transfer empty return not found",
      });
    }

    const row = rows[0];
    const agencyId = req.user?.agency_id || row.agency_id || 1;

    await increaseStock(connection, {
      productId: Number(row.product_id),
      emptyQuantity: Number(row.quantity || 0),
    }, agencyId);

    await connection.execute(
      `UPDATE stock_transactions SET isApproved = 1, agency_id = ? WHERE id = ?`,
      [agencyId, txnId]
    );

    await connection.commit();

    return res.json({
      success: true,
      message: "Transfer empty return approved successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error("approveTransferEmptyReturn error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to approve transfer empty return",
    });
  } finally {
    connection.release();
  }
};


export const cancelStockOutLoad = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { loadId } = req.params;
    const agencyId = req.user?.agency_id || 1;

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `
      SELECT
        id,
        product_id,
        quantity,
        type,
        is_defective,
        isApproved,
        agency_id
      FROM stock_transactions
      WHERE COALESCE(reference_id, driver_id) = ?
        AND stock_from IN ('godown', 'stock_out')
        AND isApproved = 1
        AND (
          type = 'EMPTY_RETURN'
          OR (type = 'PURCHASE_RETURN' AND is_defective = 1)
        )
      `,
      [loadId]
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "No approved stock out load found to cancel",
      });
    }

    for (const row of rows) {
      const productId = Number(row.product_id);
      const qty = Number(row.quantity || 0);
      const rowAgencyId = row.agency_id || agencyId;

      if (row.type === "EMPTY_RETURN") {
        await increaseStock(connection, {
          productId,
          emptyQuantity: qty,
        }, rowAgencyId);
      }

      if (row.type === "PURCHASE_RETURN" && Number(row.is_defective) === 1) {
        await increaseStock(connection, {
          productId,
          defectiveQuantity: qty,
        }, rowAgencyId);
      }
    }

    await connection.execute(
      `
      UPDATE stock_transactions
      SET isApproved = 2
      WHERE COALESCE(reference_id, driver_id) = ?
        AND stock_from IN ('godown', 'stock_out')
        AND isApproved = 1
        AND (
          type = 'EMPTY_RETURN'
          OR (type = 'PURCHASE_RETURN' AND is_defective = 1)
        )
      `,
      [loadId]
    );

    await connection.commit();

    return res.json({
      success: true,
      message: "Stock out load cancelled successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error("cancelStockOutLoad error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to cancel stock out load",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getCommercialDriverBookings = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "ALL").toUpperCase();

    const params = [];
    let searchFilter = "";
    let statusFilter = "";

    if (search) {
      searchFilter = `
        AND (
          du.name LIKE ?
          OR cu.name LIKE ?
          OR CAST(s.id AS CHAR) LIKE ?
        )
      `;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (status === "PENDING") {
      statusFilter = `AND st.isApproved = 0`;
    }

    if (status === "DONE") {
      statusFilter = `AND st.isApproved = 1`;
    }

    const [rows] = await db.execute(
      `
      SELECT
        s.id AS booking_id,
        s.status AS booking_status,
        s.total_amount,
        s.created_at,

        d.id AS driver_id,
        d.vehicle_number,
        du.name AS driver_name,
        du.phone AS driver_phone,

        cu.name AS customer_name,
        cu.phone AS customer_phone,
        a.address,

        st.id AS stock_transaction_id,
        st.product_id,
        st.quantity,
        st.isApproved,

        p.name AS product_name,
        p.type AS product_type,
        p.price AS product_price
      FROM stock_transactions st
      INNER JOIN sales s
        ON s.id = st.reference_id
      INNER JOIN drivers d
        ON d.id = st.driver_id
      INNER JOIN users du
        ON du.id = d.user_id
      INNER JOIN users cu
        ON cu.id = s.customer_id
      LEFT JOIN addresses a
        ON a.id = s.address_id
      INNER JOIN products p
        ON p.id = st.product_id
      WHERE s.sale_type = 'BOOKING'
        AND p.type = 'COMMERCIAL'
        AND st.type = 'BOOKING_ADD'
        AND st.stock_from = 'godown'
        ${searchFilter}
        ${statusFilter}
      ORDER BY du.name ASC, s.created_at DESC, s.id DESC
      `,
      params
    );

    const bookingMap = new Map();

    rows.forEach((row) => {
      const bookingId = Number(row.booking_id);

      if (!bookingMap.has(bookingId)) {
        bookingMap.set(bookingId, {
          bookingId,
          status: row.booking_status,
          isApproved: Number(row.isApproved || 0),
          totalAmount: Number(row.total_amount || 0),
          createdAt: row.created_at,
          driverId: Number(row.driver_id),
          driverName: row.driver_name || "Unknown Driver",
          driverPhone: row.driver_phone || "",
          vehicleNumber: row.vehicle_number || "N/A",
          customerName: row.customer_name || "Unknown Customer",
          customerPhone: row.customer_phone || "",
          address: row.address || "",
          totalQty: 0,
          items: [],
        });
      }

      const booking = bookingMap.get(bookingId);

      booking.totalQty += Number(row.quantity || 0);

      booking.items.push({
        stockTransactionId: Number(row.stock_transaction_id),
        productId: Number(row.product_id),
        productName: row.product_name,
        productType: row.product_type,
        quantity: Number(row.quantity || 0),
        price: Number(row.product_price || 0),
      });
    });

    const bookings = Array.from(bookingMap.values());
    const driverMap = new Map();

    bookings.forEach((booking) => {
      if (!driverMap.has(booking.driverId)) {
        driverMap.set(booking.driverId, {
          driverId: booking.driverId,
          driverName: booking.driverName,
          driverPhone: booking.driverPhone,
          vehicleNumber: booking.vehicleNumber,
          totalBookings: 0,
          totalCylinders: 0,
          openBookings: 0,
          bookings: [],
        });
      }

      const driver = driverMap.get(booking.driverId);
      driver.totalBookings += 1;
      driver.totalCylinders += booking.totalQty;

      if (Number(booking.isApproved) === 0) {
        driver.openBookings += 1;
      }

      driver.bookings.push(booking);
    });

    const drivers = Array.from(driverMap.values());

    return res.json({
      success: true,
      data: {
        summary: {
          bookings: bookings.length,
          cylinders: bookings.reduce((sum, item) => sum + item.totalQty, 0),
          drivers: drivers.length,
        },
        drivers,
      },
    });
  } catch (error) {
    console.error("getCommercialDriverBookings error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch commercial bookings",
      error: error.message,
    });
  }
};

export const approveCommercialDriverBooking = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const bookingId = Number(req.params.bookingId);

    if (!bookingId) {
      return res.status(400).json({
        success: false,
        message: "bookingId is required",
      });
    }

    await connection.beginTransaction();

    const [bookingRows] = await connection.execute(
      `
      SELECT id, status
      FROM sales
      WHERE id = ?
        AND sale_type = 'BOOKING'
      FOR UPDATE
      `,
      [bookingId]
    );

    if (!bookingRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    if (bookingRows[0].status !== "PENDING") {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Only pending bookings can be approved",
      });
    }

    const [transactions] = await connection.execute(
      `
      SELECT
        st.id,
        st.product_id,
        st.quantity
      FROM stock_transactions st
      WHERE st.reference_id = ?
        AND st.type = 'BOOKING_ADD'
        AND st.stock_from = 'godown'
        AND st.isApproved = 0
      FOR UPDATE
      `,
      [bookingId]
    );

    if (!transactions.length) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "No pending booking stock transaction found",
      });
    }

    const requiredByProduct = new Map();

    transactions.forEach((row) => {
      const productId = Number(row.product_id);
      const qty = Number(row.quantity || 0);
      requiredByProduct.set(
        productId,
        Number(requiredByProduct.get(productId) || 0) + qty
      );
    });

    for (const [productId, requiredQty] of requiredByProduct.entries()) {
      const availableQty = await getAvailableStockForUpdate(connection, productId);

      if (availableQty < requiredQty) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for product ${productId}. Available ${availableQty}, required ${requiredQty}`,
        });
      }
    }

    for (const row of transactions) {
      await consumeStockQuantity(
        connection,
        Number(row.product_id),
        Number(row.quantity || 0)
      );
    }

    await connection.execute(
      `
      UPDATE stock_transactions
      SET isApproved = 1
      WHERE reference_id = ?
        AND type = 'BOOKING_ADD'
        AND stock_from = 'godown'
      `,
      [bookingId]
    );

    await connection.execute(
      `
      UPDATE sales
      SET status = 'ASSIGNED',
          assigned_at = NOW(),
          updated_at = NOW()
      WHERE id = ?
      `,
      [bookingId]
    );

    await connection.execute(
      `
      UPDATE sales_items
      SET status = 'ASSIGNED'
      WHERE sale_id = ?
      `,
      [bookingId]
    );

    await connection.commit();

    return res.json({
      success: true,
      message: "Booking approved successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error("approveCommercialDriverBooking error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to approve booking",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
