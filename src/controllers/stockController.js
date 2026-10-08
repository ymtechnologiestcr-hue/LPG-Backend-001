import db from "../config/db.js";
import { ensureDailyStockSnapshot } from "../utils/stockLedger.js";

export const getStockDashboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
    const offset = (page - 1) * limit;

    const search = String(req.query.search || "").trim();
    const rawStartDate = String(req.query.startDate || "");
    const rawEndDate = String(req.query.endDate || "");
    const stockAreaId = req.query.stockAreaId ? Number(req.query.stockAreaId) : null;

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    const safeStartDate = dateRegex.test(rawStartDate) ? rawStartDate : null;
    const safeEndDate = dateRegex.test(rawEndDate) ? rawEndDate : null;

    const [[todayRow]] = await connection.query(`SELECT CAST(CURDATE() AS CHAR) AS today`);
    const today = todayRow?.today;

    let startDate = safeStartDate || today;
    let endDate = safeEndDate || startDate;

    if (startDate > endDate) {
      const swap = startDate;
      startDate = endDate;
      endDate = swap;
    }

    // Ensure snapshot baseline exists for the selected date(s)
    await ensureDailyStockSnapshot(connection, req.user.agency_id, startDate, stockAreaId);
    if (startDate !== today && endDate >= today) {
      await ensureDailyStockSnapshot(connection, req.user.agency_id, today, stockAreaId);
    }

    const productSearchFilter = search
      ? `AND CONCAT_WS(' ', p.name, c.name, p.type) LIKE ?`
      : "";
    const productSearchParams = search ? [`%${search}%`] : [];

    const stockAreaProductFilter = stockAreaId
      ? `
        AND EXISTS (
          SELECT 1
          FROM stock stk_area
          WHERE stk_area.product_id = p.id
            AND stk_area.agency_id = ?
            AND stk_area.stock_area_id = ?
        )
      `
      : "";
    const stockAreaProductParams = stockAreaId ? [req.user.agency_id, stockAreaId] : [];

    const snapshotAreaFilter = stockAreaId
      ? `AND dss.agency_id = ? AND dss.stock_area_id = ?`
      : `AND dss.agency_id = ?`;
    const snapshotAreaParams = stockAreaId ? [req.user.agency_id, stockAreaId] : [req.user.agency_id];

    const stockSubAreaFilter = stockAreaId ? `WHERE s.agency_id = ? AND s.stock_area_id = ?` : `WHERE s.agency_id = ?`;
    const stockSubAreaParams = stockAreaId ? [req.user.agency_id, stockAreaId] : [req.user.agency_id];

    const salesDateFilter =
      startDate && endDate
        ? `AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?`
        : "";
    const salesDateParams = startDate && endDate ? [startDate, endDate] : [];

    const txDateFilter =
      startDate && endDate
        ? `AND st.created_at BETWEEN ? AND ?`
        : "";
    const txDateParams =
      startDate && endDate
        ? [`${startDate} 00:00:00`, `${endDate} 23:59:59`]
        : [];

    const txAreaFilter = stockAreaId ? `AND st.agency_id = ? AND st.stock_area_id = ?` : `AND st.agency_id = ?`;
    const txAreaParams = stockAreaId ? [req.user.agency_id, stockAreaId] : [req.user.agency_id];

    const salesAreaFilter = stockAreaId
      ? `
        AND s.agency_id = ?
        AND EXISTS (
          SELECT 1
          FROM stock stk
          WHERE stk.product_id = p.id
            AND stk.agency_id = ?
            AND stk.stock_area_id = ?
        )
      `
      : "AND s.agency_id = ?";
    const salesAreaParams = stockAreaId ? [req.user.agency_id, req.user.agency_id, stockAreaId] : [req.user.agency_id];

    const [summaryRows] = await connection.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN p.type = 'DOMESTIC' THEN COALESCE(stk.opening, 0) ELSE 0 END), 0) AS domestic,
        COALESCE(SUM(CASE WHEN p.type = 'COMMERCIAL' THEN COALESCE(stk.opening, 0) ELSE 0 END), 0) AS commercial,
        COALESCE(SUM(CASE WHEN LOWER(CONCAT_WS(' ', p.name, c.name)) LIKE '%5kg%' THEN COALESCE(stk.opening, 0) ELSE 0 END), 0) AS fiveKg
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN (
        SELECT
          dss.product_id,
          COALESCE(SUM(dss.opening_stock), 0) AS opening
        FROM daily_stock_snapshots dss
        WHERE dss.snapshot_date = ?
          ${snapshotAreaFilter}
        GROUP BY dss.product_id
      ) stk ON stk.product_id = p.id
      WHERE 1=1
      ${productSearchFilter}
      ${stockAreaProductFilter}
      `,
      [startDate, ...snapshotAreaParams, ...productSearchParams, ...stockAreaProductParams]
    );

    const [countRows] = await connection.query(
      `
      SELECT COUNT(*) AS total
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE 1=1
      ${productSearchFilter}
      ${stockAreaProductFilter}
      `,
      [...productSearchParams, ...stockAreaProductParams]
    );

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.ceil(total / limit);

    const [detailsRows] = await connection.query(
      `
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        p.type AS product_type,
        p.price AS product_price,
        c.id AS category_id,
        c.name AS category_name,
        CONCAT(p.name, ' - ', CASE WHEN p.type = 'DOMESTIC' THEN 'Domestic' ELSE 'Commercial' END) AS category,

        COALESCE(stk.opening, 0) AS opening,
        COALESCE(stk.system_opening, 0) AS system_opening,
        COALESCE(stk.saved_closing_stock, 0) AS saved_closing_stock,
        COALESCE(stk.saved_system_closing, 0) AS saved_system_closing,
        COALESCE(stk.empty_opening, 0) AS empty_opening,
        COALESCE(stk.system_empty_opening, 0) AS system_empty_opening,
        COALESCE(stk.saved_empty_closing, 0) AS saved_empty_closing,
        COALESCE(stk.saved_system_empty_closing, 0) AS saved_system_empty_closing,
        COALESCE(stk.is_finalized, 0) AS is_finalized,

        COALESCE(sa.sales, 0) AS sales,
        COALESCE(sa.systemSales, 0) AS systemSales,
        COALESCE(sa.salesReturn, 0) AS salesReturn,
        COALESCE(pur.purchase, 0) AS purchase,
        COALESCE(pr.purchaseReturn, 0) AS purchaseReturn,
        COALESCE(def.defective, 0) AS defective,
        COALESCE(stk_live.emptyQty, 0) AS liveEmptyQty,
        COALESCE(stk_live.systemEmptyQty, 0) AS liveSystemEmptyQty,
        COALESCE(empties.collected, 0) AS collectedEmpties,
        COALESCE(ret.returned, 0) AS returnedEmpties,
        (
          COALESCE(stk_live.emptyQty, 0) +
          GREATEST(COALESCE(empties.collected, 0) - COALESCE(ret.returned, 0), 0)
        ) AS emptyCylinders,
        COALESCE(stk.system_opening, stk_live.systemQty, 0) AS systemStock

      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id

      LEFT JOIN (
        SELECT
          dss.product_id,
          COALESCE(SUM(dss.opening_stock), 0) AS opening,
          COALESCE(SUM(dss.system_opening), 0) AS system_opening,
          COALESCE(SUM(dss.closing_stock), 0) AS saved_closing_stock,
          COALESCE(SUM(dss.system_closing), 0) AS saved_system_closing,
          COALESCE(SUM(dss.empty_opening), 0) AS empty_opening,
          COALESCE(SUM(dss.system_empty_opening), 0) AS system_empty_opening,
          COALESCE(SUM(dss.empty_closing), 0) AS saved_empty_closing,
          COALESCE(SUM(dss.system_empty_closing), 0) AS saved_system_empty_closing,
          MIN(dss.is_finalized) AS is_finalized
        FROM daily_stock_snapshots dss
        WHERE dss.snapshot_date = ?
          ${snapshotAreaFilter}
        GROUP BY dss.product_id
      ) stk ON stk.product_id = p.id

      LEFT JOIN (
        SELECT
          s.product_id,
          COALESCE(SUM(COALESCE(s.quantity, 0)), 0) AS liveGodownQty,
          COALESCE(SUM(COALESCE(s.system_quantity, 0)), 0) AS systemQty,
          COALESCE(SUM(COALESCE(s.empty_quantity, 0)), 0) AS emptyQty,
          COALESCE(SUM(COALESCE(s.system_empty_quantity, 0)), 0) AS systemEmptyQty
        FROM stock s
        ${stockSubAreaFilter}
        GROUP BY s.product_id
      ) stk_live ON stk_live.product_id = p.id

      LEFT JOIN (
        SELECT
          st.product_id,
          COALESCE(SUM(st.quantity), 0) AS purchase
        FROM stock_transactions st
        WHERE st.type = 'PURCHASE'
          AND COALESCE(st.isApproved, 0) = 1
          ${txDateFilter}
          ${txAreaFilter}
        GROUP BY st.product_id
      ) pur ON pur.product_id = p.id

      LEFT JOIN (
        SELECT
          st.product_id,
          COALESCE(SUM(st.quantity), 0) AS purchaseReturn
        FROM stock_transactions st
        WHERE COALESCE(st.isApproved, 0) = 1
          AND (
            (st.type = 'EMPTY_RETURN' AND st.stock_from = 'godown')
            OR (st.type = 'PURCHASE_RETURN' AND st.stock_from = 'stock_out' AND COALESCE(st.is_defective, 0) = 1)
          )
          ${txDateFilter}
          ${txAreaFilter}
        GROUP BY st.product_id
      ) pr ON pr.product_id = p.id

      LEFT JOIN (
        SELECT
          st.product_id,
          COALESCE(SUM(st.quantity), 0) AS defective
        FROM stock_transactions st
        WHERE COALESCE(st.isApproved, 0) = 1
          AND COALESCE(st.is_defective, 0) = 1
          ${txDateFilter}
          ${txAreaFilter}
        GROUP BY st.product_id
      ) def ON def.product_id = p.id

      LEFT JOIN (
        SELECT
          si.product_id,
          SUM(CASE WHEN s.status = 'DELIVERED' THEN COALESCE(NULLIF(si.delivered_qty, 0), si.quantity, 0) ELSE 0 END) AS sales,
          SUM(
            CASE
              WHEN s.status = 'DELIVERED' AND EXISTS (
                SELECT 1 FROM driver_sale_otps dso
                WHERE dso.sale_id = s.id AND dso.status = 'SENT'
              ) THEN COALESCE(NULLIF(si.delivered_qty, 0), si.quantity, 0)
              ELSE 0
            END
          ) AS systemSales,
          SUM(CASE WHEN s.status = 'CANCELLED' THEN COALESCE(NULLIF(si.delivered_qty, 0), si.quantity, 0) ELSE 0 END) AS salesReturn
        FROM sales_items si
        INNER JOIN sales s ON s.id = si.sale_id
        INNER JOIN products p ON p.id = si.product_id
        WHERE s.status IN ('DELIVERED', 'CANCELLED')
        ${salesDateFilter}
        ${salesAreaFilter}
        GROUP BY si.product_id
      ) sa ON sa.product_id = p.id

      LEFT JOIN (
        SELECT
          si.product_id,
          COALESCE(SUM(si.empty_cylinder_qty), 0) AS collected
        FROM sales_items si
        INNER JOIN sales s ON s.id = si.sale_id
        WHERE s.agency_id = ?
          AND s.status = 'DELIVERED'
          ${salesDateFilter}
        GROUP BY si.product_id
      ) empties ON empties.product_id = p.id

      LEFT JOIN (
        SELECT
          st.product_id,
          COALESCE(SUM(st.quantity), 0) AS returned
        FROM stock_transactions st
        WHERE st.agency_id = ?
          AND st.type = 'EMPTY_RETURN'
          AND st.stock_from = 'driver'
          AND COALESCE(st.isApproved, 0) = 1
          ${txDateFilter}
        GROUP BY st.product_id
      ) ret ON ret.product_id = p.id

      WHERE 1=1
      ${productSearchFilter}
      ${stockAreaProductFilter}
      ORDER BY p.name ASC, p.type ASC
      LIMIT ?
      OFFSET ?
      `,
      [
        startDate,
        ...snapshotAreaParams,
        ...stockSubAreaParams,
        ...txDateParams,
        ...txAreaParams,
        ...txDateParams,
        ...txAreaParams,
        ...txDateParams,
        ...txAreaParams,
        ...salesDateParams,
        ...salesAreaParams,
        req.user.agency_id,
        ...salesDateParams,
        req.user.agency_id,
        ...txDateParams,
        ...productSearchParams,
        ...stockAreaProductParams,
        limit,
        offset,
      ]
    );

    const [purchaseMovementRows] = await connection.query(
      `
      SELECT
        st.created_at AS movementDate,
        'Purchase' AS movementType,
        CONCAT(p.name, ' - ', CASE WHEN p.type = 'DOMESTIC' THEN 'Domestic' ELSE 'Commercial' END) AS item,
        st.quantity AS qty,
        COALESCE(u.name, 'System') AS movedBy
      FROM stock_transactions st
      INNER JOIN products p ON p.id = st.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN users u ON u.id = st.created_by
      WHERE st.type = 'PURCHASE'
        AND COALESCE(st.isApproved, 0) = 1
        ${txDateFilter}
        ${txAreaFilter}
        ${productSearchFilter}
      ORDER BY st.created_at DESC
      LIMIT 30
      `,
      [...txDateParams, ...txAreaParams, ...productSearchParams]
    );

    const [purchaseReturnMovementRows] = await connection.query(
      `
      SELECT
        st.created_at AS movementDate,
        'Purchase Return' AS movementType,
        CONCAT(p.name, ' - ', CASE WHEN p.type = 'DOMESTIC' THEN 'Domestic' ELSE 'Commercial' END) AS item,
        st.quantity AS qty,
        COALESCE(du.name, u.name, 'Godown') AS movedBy
      FROM stock_transactions st
      INNER JOIN products p ON p.id = st.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN drivers d ON d.id = st.driver_id
      LEFT JOIN users du ON du.id = d.user_id
      LEFT JOIN users u ON u.id = st.created_by
      WHERE COALESCE(st.isApproved, 0) = 1
        AND (
          (st.type = 'EMPTY_RETURN' AND st.stock_from = 'godown')
          OR (st.type = 'PURCHASE_RETURN' AND st.stock_from = 'stock_out' AND COALESCE(st.is_defective, 0) = 1)
        )
        ${txDateFilter}
        ${txAreaFilter}
        ${productSearchFilter}
      ORDER BY st.created_at DESC
      LIMIT 30
      `,
      [...txDateParams, ...txAreaParams, ...productSearchParams]
    );

    const [salesMovementRows] = await connection.query(
      `
      SELECT
        COALESCE(s.delivered_at, s.created_at) AS movementDate,
        CASE WHEN s.status = 'DELIVERED' THEN 'Sales' ELSE 'Sales Return' END AS movementType,
        CONCAT(p.name, ' - ', CASE WHEN p.type = 'DOMESTIC' THEN 'Domestic' ELSE 'Commercial' END) AS item,
        si.quantity AS qty,
        COALESCE(du.name, CASE WHEN s.sales_from = 'CASHIER' THEN 'Cashier' ELSE 'System' END) AS movedBy
      FROM sales_items si
      INNER JOIN sales s ON s.id = si.sale_id
      INNER JOIN products p ON p.id = si.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN drivers d ON d.id = s.driver_id
      LEFT JOIN users du ON du.id = d.user_id
      WHERE s.status IN ('DELIVERED', 'CANCELLED')
      ${salesDateFilter}
      ${salesAreaFilter}
      ${productSearchFilter}
      ORDER BY movementDate DESC
      LIMIT 40
      `,
      [...salesDateParams, ...salesAreaParams, ...productSearchParams]
    );

    const movements = [
      ...purchaseMovementRows,
      ...purchaseReturnMovementRows,
      ...salesMovementRows,
    ]
      .sort((a, b) => new Date(b.movementDate).getTime() - new Date(a.movementDate).getTime())
      .slice(0, 50)
      .map((row) => ({
        date: row.movementDate,
        type: row.movementType,
        item: row.item,
        qty: Number(row.qty || 0),
        by: row.movedBy || "System",
      }));

    // Recent Stock Entries (created via the "Add Stock" flow → type = 'NEW_VALUE')
    const [recentEntryRows] = await connection.query(
      `
      SELECT
        st.created_at AS date,
        c.name AS category,
        p.name AS item,
        sa.name AS location,
        st.quantity AS qty,
        p.price AS price,
        st.batch_no AS note
      FROM stock_transactions st
      INNER JOIN products p ON p.id = st.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN stock_areas sa ON sa.id = st.stock_area_id
      WHERE st.type = 'NEW_VALUE'
        AND st.agency_id = ?
      ORDER BY st.created_at DESC, st.id DESC
      LIMIT 15
      `,
      [req.user.agency_id]
    );

    const recentEntries = recentEntryRows.map((row) => ({
      date: row.date,
      category: row.category || "-",
      item: row.item || "-",
      location: row.location || "-",
      qty: Number(row.qty || 0),
      price: row.price == null ? null : Number(row.price),
      note: row.note || null,
    }));

    // If viewing the current day, sync live purchases, sales, and closing stock into daily_stock_snapshots
    if (startDate === today && startDate === endDate) {
      for (const row of detailsRows) {
        const pOpening = Number(row.opening || 0);
        const pPurchase = Number(row.purchase || 0);
        const pSales = Number(row.sales || 0);
        const pSysSales = Number(row.systemSales || 0);
        const pSalesReturn = Number(row.salesReturn || 0);
        const pPurchaseReturn = Number(row.purchaseReturn || 0);
        const pDefective = Number(row.defective || 0);
        const pClosing = pOpening + pPurchase - pSales;
        const pSysOpening = Number(row.system_opening != null ? row.system_opening : row.systemStock || 0);
        const pSysClosing = pSysOpening + pPurchase - pSysSales;

        const pLiveEmptyQty = Number(row.liveEmptyQty != null ? row.liveEmptyQty : row.emptyQty || 0);
        const pCollectedEmpties = Number(row.collectedEmpties || 0);
        const pReturnedEmpties = Number(row.returnedEmpties || 0);
        const pEmptyPhysical = pLiveEmptyQty + Math.max(pCollectedEmpties - pReturnedEmpties, 0);

        const pLiveSystemEmptyQty = Number(row.liveSystemEmptyQty != null ? row.liveSystemEmptyQty : row.systemEmptyQty || 0);
        const pEmptyStock = pLiveSystemEmptyQty > 0 ? pLiveSystemEmptyQty : (pCollectedEmpties > 0 ? pCollectedEmpties : 0);

        if (stockAreaId) {
          await connection.query(
            `
            UPDATE daily_stock_snapshots
            SET purchase_qty = ?,
                sales_qty = ?,
                system_sales_qty = ?,
                sales_return_qty = ?,
                purchase_return_qty = ?,
                defective_qty = ?,
                closing_stock = ?,
                system_closing = ?,
                empty_closing = ?,
                system_empty_closing = ?,
                updated_at = NOW()
            WHERE agency_id = ? AND stock_area_id = ? AND product_id = ? AND snapshot_date = CURDATE()
            `,
            [
              pPurchase,
              pSales,
              pSysSales,
              pSalesReturn,
              pPurchaseReturn,
              pDefective,
              pClosing,
              pSysClosing,
              pEmptyPhysical,
              pEmptyStock,
              req.user.agency_id,
              stockAreaId,
              row.product_id,
            ]
          );
        } else {
          const [snapshots] = await connection.query(
            `SELECT id, opening_stock, system_opening FROM daily_stock_snapshots WHERE agency_id = ? AND product_id = ? AND snapshot_date = CURDATE()`,
            [req.user.agency_id, row.product_id]
          );
          for (const ps of snapshots) {
            const snapOpen = Number(ps.opening_stock || 0);
            const snapSysOpen = Number(ps.system_opening || 0);
            const snapClosing = snapOpen + pPurchase - pSales;
            const snapSysClosing = snapSysOpen + pPurchase - pSysSales;

            await connection.query(
              `
              UPDATE daily_stock_snapshots
              SET purchase_qty = ?,
                  sales_qty = ?,
                  system_sales_qty = ?,
                  sales_return_qty = ?,
                  purchase_return_qty = ?,
                  defective_qty = ?,
                  closing_stock = ?,
                  system_closing = ?,
                  empty_closing = ?,
                  system_empty_closing = ?,
                  updated_at = NOW()
              WHERE id = ?
              `,
              [
                pPurchase,
                pSales,
                pSysSales,
                pSalesReturn,
                pPurchaseReturn,
                pDefective,
                snapClosing,
                snapSysClosing,
                pEmptyPhysical,
                pEmptyStock,
                ps.id,
              ]
            );
          }
        }
      }
    }

    return res.status(200).json({
      success: true,
      summary: {
        domestic: Number(summaryRows[0]?.domestic || 0),
        commercial: Number(summaryRows[0]?.commercial || 0),
        fiveKg: Number(summaryRows[0]?.fiveKg || 0),
      },
      data: detailsRows.map((row) => {
        const opening = Number(row.opening || 0);
        const sales = Number(row.sales || 0);
        const systemSales = Number(row.systemSales || 0);
        const purchase = Number(row.purchase || 0);
        const purchaseReturn = Number(row.purchaseReturn || 0);
        const defective = Number(row.defective || 0);
        const emptyCylinders = Number(row.emptyCylinders || 0);

        // System Opening
        const systemOpening = Number(row.system_opening != null ? row.system_opening : row.systemStock || 0);

        // Physical Closing = Opening + Purchase - Sales
        let physicalClosing = opening + purchase - sales;

        // System Closing = System Opening + Purchase - System Sales (Domestic & Commercial OTP confirmed)
        let systemClosing = systemOpening + purchase - systemSales;

        // Empty physical: godown approved empty stock + in-transit empties collected by drivers
        const liveEmptyQty = Number(row.liveEmptyQty != null ? row.liveEmptyQty : row.emptyQty || 0);
        const collectedEmpties = Number(row.collectedEmpties || 0);
        const returnedEmpties = Number(row.returnedEmpties || 0);
        let emptyPhysical = liveEmptyQty + Math.max(collectedEmpties - returnedEmpties, 0);

        // Empty system stock: tracked system_empty_quantity, fallback to collected/confirmed empties
        const liveSystemEmptyQty = Number(row.liveSystemEmptyQty != null ? row.liveSystemEmptyQty : row.systemEmptyQty || 0);
        let emptyStock = liveSystemEmptyQty > 0 ? liveSystemEmptyQty : (collectedEmpties > 0 ? collectedEmpties : 0);

        // If the requested date is in the past and is_finalized = 1, read the saved closing_stock directly:
        if (startDate < today && Number(row.is_finalized) === 1 && startDate === endDate) {
          physicalClosing = Number(row.saved_closing_stock || 0);
          systemClosing = Number(row.saved_system_closing || 0);
          if (row.saved_empty_closing != null && Number(row.saved_empty_closing) > 0) {
            emptyPhysical = Number(row.saved_empty_closing);
          }
          if (row.saved_system_empty_closing != null && Number(row.saved_system_empty_closing) > 0) {
            emptyStock = Number(row.saved_system_empty_closing);
          }
        }

        const systemStock = systemClosing;

        return {
          product_id: row.product_id,
          product_name: row.product_name || "",
          product_type: row.product_type || "DOMESTIC",
          product_price: row.product_price == null ? null : Number(row.product_price),
          category_id: row.category_id || null,
          category_name: row.category_name || "",
          category: row.category,
          opening,
          system_opening: systemOpening,
          sales,
          systemSales,
          salesReturn: Number(row.salesReturn || 0),
          purchase,
          purchaseReturn,
          defective,
          emptyCylinders,
          emptyPhysical,
          emptyStock,
          systemEmptyStock: emptyStock,
          emptyClosing: emptyPhysical,
          systemStock,
          // Closing Stock = Opening Stock + Purchase Stock - Sales
          closingStock: physicalClosing,
          physicalClosing,
          systemClosing,
          difference: physicalClosing - systemClosing,
          diff: physicalClosing - systemClosing,
        };
      }),
      movements,
      recentEntries,
      pagination: {
        total,
        page,
        limit,
        totalPages,
      },
    });
  } catch (error) {
    console.error("getStockDashboard error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock dashboard",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getStockAreas = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const [rows] = await connection.query(`
      SELECT
        sa.id,
        sa.name,
        sa.address,
        sa.manager_id
      FROM stock_areas sa
      WHERE sa.agency_id = ?
      ORDER BY sa.name ASC
    `, [req.user.agency_id]);

    return res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("getStockAreas error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock areas",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

const inferProductType = (categoryName, itemName) => {
  const text = `${String(categoryName || "")} ${String(itemName || "")}`.toLowerCase();
  return text.includes("commercial") ? "COMMERCIAL" : "DOMESTIC";
};

export const searchOwnerStockCategories = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const search = String(req.query.search || "").trim();
    const params = [];
    let filter = "";

    if (search) {
      filter = "WHERE c.name LIKE ?";
      params.push(`%${search}%`);
    }

    const [rows] = await connection.query(
      `
      SELECT c.id, c.name
      FROM categories c
      ${filter}
      ORDER BY c.name ASC
      LIMIT 30
      `,
      params
    );

    return res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("searchOwnerStockCategories error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock categories",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const searchOwnerStockItems = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const categoryId = Number(req.query.categoryId || 0);
    const search = String(req.query.search || "").trim();

    if (!categoryId) {
      return res.status(400).json({
        success: false,
        message: "categoryId is required",
      });
    }

    const params = [categoryId];
    let searchFilter = "";

    if (search) {
      searchFilter = "AND p.name LIKE ?";
      params.push(`%${search}%`);
    }

    const [rows] = await connection.query(
      `
      SELECT
        p.id,
        p.name,
        p.type,
        p.price,
        p.category_id AS categoryId
      FROM products p
      WHERE p.category_id = ?
      ${searchFilter}
      ORDER BY p.name ASC
      LIMIT 40
      `,
      params
    );

    return res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("searchOwnerStockItems error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock items",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getOwnerStockItemContext = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const itemId = Number(req.query.itemId || 0);

    if (!itemId) {
      return res.status(400).json({
        success: false,
        message: "itemId is required",
      });
    }

    const [[product]] = await connection.query(
      `
      SELECT p.id, p.name, p.price
      FROM products p
      WHERE p.id = ?
      LIMIT 1
      `,
      [itemId]
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Item not found",
      });
    }

    const [[existingArea]] = await connection.query(
      `SELECT id FROM stock_areas WHERE agency_id = ? LIMIT 1`,
      [req.user.agency_id]
    );

    let stockAreaId = existingArea ? existingArea.id : null;

    let stockRow = null;
    if (stockAreaId) {
      [[stockRow]] = await connection.query(
        `
        SELECT quantity, system_quantity, empty_quantity, system_empty_quantity
        FROM stock
        WHERE product_id = ? AND stock_area_id = ? AND agency_id = ?
        LIMIT 1
        `,
        [itemId, stockAreaId, req.user.agency_id]
      );
    }

    return res.status(200).json({
      success: true,
      data: {
        quantity: stockRow ? Number(stockRow.quantity || 0) : null,
        systemQuantity: stockRow ? Number(stockRow.system_quantity || 0) : null,
        emptyQuantity: stockRow ? Number(stockRow.empty_quantity || 0) : null,
        systemEmptyQuantity: stockRow ? Number(stockRow.system_empty_quantity || 0) : null,
        price: product.price != null ? Number(product.price) : null,
        hasExistingData: Boolean(stockRow || product.price != null),
      },
    });
  } catch (error) {
    console.error("getOwnerStockItemContext error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch item context",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const createOwnerStockCategoryWithItem = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const categoryName = String(req.body.categoryName || "").trim();
    const itemName = String(req.body.itemName || "").trim();

    if (!categoryName || !itemName) {
      return res.status(400).json({
        success: false,
        message: "categoryName and itemName are required",
      });
    }

    await connection.beginTransaction();

    let categoryId;
    const [[existingCategory]] = await connection.query(
      `SELECT id, name FROM categories WHERE LOWER(name) = LOWER(?) LIMIT 1`,
      [categoryName]
    );

    if (existingCategory) {
      categoryId = existingCategory.id;
    } else {
      const [catInsert] = await connection.query(
        `INSERT INTO categories (name) VALUES (?)`,
        [categoryName]
      );
      categoryId = catInsert.insertId;
    }

    const [[existingItem]] = await connection.query(
      `
      SELECT id, name, type, price, category_id AS categoryId
      FROM products
      WHERE category_id = ? AND LOWER(name) = LOWER(?)
      LIMIT 1
      `,
      [categoryId, itemName]
    );

    let item;
    if (existingItem) {
      item = existingItem;
    } else {
      const type = inferProductType(categoryName, itemName);
      const [itemInsert] = await connection.query(
        `INSERT INTO products (name, type, category_id, price) VALUES (?, ?, ?, NULL)`,
        [itemName, type, categoryId]
      );
      item = {
        id: itemInsert.insertId,
        name: itemName,
        type,
        price: null,
        categoryId,
      };
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Category and item saved",
      data: {
        category: {
          id: categoryId,
          name: existingCategory?.name || categoryName,
        },
        item,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createOwnerStockCategoryWithItem error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to save category and item",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const createOwnerStockItem = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const categoryId = Number(req.body.categoryId || 0);
    const itemName = String(req.body.itemName || "").trim();

    if (!categoryId || !itemName) {
      return res.status(400).json({
        success: false,
        message: "categoryId and itemName are required",
      });
    }

    const [[category]] = await connection.query(
      `SELECT id, name FROM categories WHERE id = ? LIMIT 1`,
      [categoryId]
    );

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    const [[existingItem]] = await connection.query(
      `
      SELECT id, name, type, price, category_id AS categoryId
      FROM products
      WHERE category_id = ? AND LOWER(name) = LOWER(?)
      LIMIT 1
      `,
      [categoryId, itemName]
    );

    if (existingItem) {
      return res.status(200).json({
        success: true,
        message: "Item already exists",
        data: existingItem,
      });
    }

    const type = inferProductType(category.name, itemName);
    const [insertResult] = await connection.query(
      `INSERT INTO products (name, type, category_id, price) VALUES (?, ?, ?, NULL)`,
      [itemName, type, categoryId]
    );

    return res.status(201).json({
      success: true,
      message: "Item created",
      data: {
        id: insertResult.insertId,
        name: itemName,
        type,
        price: null,
        categoryId,
      },
    });
  } catch (error) {
    console.error("createOwnerStockItem error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create item",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const upsertOwnerStockEntry = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const itemId = Number(req.body.itemId || 0);
    const quantity = Number(req.body.quantity);
    const rawSystemQty = req.body.systemQuantity !== undefined && req.body.systemQuantity !== null && req.body.systemQuantity !== ""
      ? req.body.systemQuantity
      : req.body.systemStock;
    const systemQuantity = rawSystemQty !== undefined && rawSystemQty !== null && rawSystemQty !== ""
      ? Number(rawSystemQty)
      : 0;

    const rawEmptyQty = req.body.emptyQuantity !== undefined && req.body.emptyQuantity !== null && req.body.emptyQuantity !== ""
      ? req.body.emptyQuantity
      : req.body.emptyPhysicalQuantity;
    const emptyQuantity = rawEmptyQty !== undefined && rawEmptyQty !== null && rawEmptyQty !== ""
      ? Number(rawEmptyQty)
      : null;

    const rawSystemEmptyQty = req.body.systemEmptyQuantity !== undefined && req.body.systemEmptyQuantity !== null && req.body.systemEmptyQuantity !== ""
      ? req.body.systemEmptyQuantity
      : req.body.emptySystemStock || req.body.emptySystemQuantity;
    const systemEmptyQuantity = rawSystemEmptyQty !== undefined && rawSystemEmptyQty !== null && rawSystemEmptyQty !== ""
      ? Number(rawSystemEmptyQty)
      : null;

    const price = Number(req.body.price);
    const note = String(req.body.note || "").trim();

    if (!itemId) {
      return res.status(400).json({
        success: false,
        message: "itemId is required",
      });
    }

    if (!Number.isFinite(quantity) || quantity < 0) {
      return res.status(400).json({
        success: false,
        message: "Physical quantity must be a non-negative number",
      });
    }

    if (!Number.isFinite(systemQuantity) || systemQuantity < 0) {
      return res.status(400).json({
        success: false,
        message: "System stock must be a non-negative number",
      });
    }

    if (emptyQuantity !== null && (!Number.isFinite(emptyQuantity) || emptyQuantity < 0)) {
      return res.status(400).json({
        success: false,
        message: "Empty physical quantity must be a non-negative number",
      });
    }

    if (systemEmptyQuantity !== null && (!Number.isFinite(systemEmptyQuantity) || systemEmptyQuantity < 0)) {
      return res.status(400).json({
        success: false,
        message: "Empty system stock must be a non-negative number",
      });
    }

    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({
        success: false,
        message: "price must be a non-negative number",
      });
    }

    await connection.beginTransaction();

    const [[existingProduct]] = await connection.query(
      `SELECT id FROM products WHERE id = ? LIMIT 1`,
      [itemId]
    );
    if (!existingProduct) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Item not found",
      });
    }

    const [[existingArea]] = await connection.query(
      `SELECT id FROM stock_areas WHERE agency_id = ? LIMIT 1`,
      [req.user.agency_id]
    );
    let stockAreaId;

    if (!existingArea) {
      const areaName = 'Main Godown - ' + req.user.agency_id;
      const [insertResult] = await connection.query(
        `INSERT INTO stock_areas (agency_id, name, address) VALUES (?, ?, 'Default Address')`,
        [req.user.agency_id, areaName]
      );
      stockAreaId = insertResult.insertId;
    } else {
      stockAreaId = existingArea.id;
    }

    const [[existingStock]] = await connection.query(
      `SELECT quantity, system_quantity, empty_quantity, system_empty_quantity 
       FROM stock 
       WHERE product_id = ? AND stock_area_id = ? AND agency_id = ? FOR UPDATE`,
      [itemId, stockAreaId, req.user.agency_id]
    );

    const physicalDelta = Math.floor(quantity) - Number(existingStock?.quantity || 0);
    const systemDelta = Math.floor(systemQuantity) - Number(existingStock?.system_quantity || 0);
    const emptyPhysicalDelta = emptyQuantity !== null 
      ? Math.floor(emptyQuantity) - Number(existingStock?.empty_quantity || 0) 
      : 0;
    const emptySystemDelta = systemEmptyQuantity !== null 
      ? Math.floor(systemEmptyQuantity) - Number(existingStock?.system_empty_quantity || 0) 
      : 0;

    const targetEmptyQuantity = emptyQuantity !== null 
      ? Math.floor(emptyQuantity) 
      : Number(existingStock?.empty_quantity || 0);
    const targetSystemEmptyQuantity = systemEmptyQuantity !== null 
      ? Math.floor(systemEmptyQuantity) 
      : Number(existingStock?.system_empty_quantity || 0);

    await connection.query(`UPDATE products SET price = ? WHERE id = ?`, [price, itemId]);

    await connection.query(
      `
      INSERT INTO stock (
        product_id, stock_area_id, quantity, system_quantity, 
        quantity_return, empty_quantity, system_empty_quantity, 
        defective_quantity, agency_id
      )
      VALUES (?, ?, ?, ?, 0, ?, ?, 0, ?)
      ON DUPLICATE KEY UPDATE
        quantity = VALUES(quantity),
        system_quantity = VALUES(system_quantity),
        empty_quantity = VALUES(empty_quantity),
        system_empty_quantity = VALUES(system_empty_quantity),
        updated_at = CURRENT_TIMESTAMP
      `,
      [
        itemId,
        stockAreaId,
        Math.floor(quantity),
        Math.floor(systemQuantity),
        targetEmptyQuantity,
        targetSystemEmptyQuantity,
        req.user.agency_id,
      ]
    );

    for (const [delta, metric] of [
      [physicalDelta, "physical"],
      [systemDelta, "system"],
      [emptyPhysicalDelta, "empty physical"],
      [emptySystemDelta, "empty system"],
    ]) {
      if (delta === 0) continue;

      const transactionNote = `${metric} delta${note ? `: ${note}` : ""}`.slice(0, 50);
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
          is_defective,
          batch_no,
          agency_id
        ) VALUES (?, ?, 'NEW_VALUE', ?, 1, NULL, ?, 'default', 0, ?, ?)
        `,
        [itemId, stockAreaId, delta, req.user.id || null, transactionNote, req.user.agency_id]
      );
    }

    // Ensure today's snapshot baseline exists
    await ensureDailyStockSnapshot(connection, req.user.agency_id, null, stockAreaId);

    const [todaySnapshots] = await connection.query(
      `SELECT id, opening_stock, system_opening, empty_opening, system_empty_opening, 
              purchase_qty, sales_qty, system_sales_qty, empty_closing, system_empty_closing
       FROM daily_stock_snapshots 
       WHERE agency_id = ? AND stock_area_id = ? AND product_id = ? AND snapshot_date = CURDATE() FOR UPDATE`,
      [req.user.agency_id, stockAreaId, itemId]
    );

    if (todaySnapshots.length > 0) {
      const snap = todaySnapshots[0];
      const newEmptyOpening = emptyQuantity !== null 
        ? Math.floor(emptyQuantity) 
        : Number(snap.empty_opening || 0);
      const newSystemEmptyOpening = systemEmptyQuantity !== null 
        ? Math.floor(systemEmptyQuantity) 
        : Number(snap.system_empty_opening || 0);

      const updatedOpening = Math.floor(quantity);
      const updatedSystemOpening = Math.floor(systemQuantity);
      const purchaseQty = Number(snap.purchase_qty || 0);
      const salesQty = Number(snap.sales_qty || 0);
      const systemSalesQty = Number(snap.system_sales_qty || 0);
      const newClosing = updatedOpening + purchaseQty - salesQty;
      const newSystemClosing = updatedSystemOpening + purchaseQty - systemSalesQty;

      await connection.query(
        `
        UPDATE daily_stock_snapshots
        SET opening_stock = ?,
            closing_stock = ?,
            system_opening = ?,
            system_closing = ?,
            empty_opening = ?,
            system_empty_opening = ?,
            empty_closing = ?,
            system_empty_closing = ?,
            updated_at = NOW()
        WHERE id = ?
        `,
        [
          updatedOpening,
          newClosing,
          updatedSystemOpening,
          newSystemClosing,
          newEmptyOpening,
          newSystemEmptyOpening,
          targetEmptyQuantity,
          targetSystemEmptyQuantity,
          snap.id,
        ]
      );
    }

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "Stock saved successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error("upsertOwnerStockEntry error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to save stock",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getOwnerStockPriceCatalog = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const [rows] = await connection.query(
      `
      SELECT
        p.id,
        p.name,
        p.price,
        p.type,
        c.id AS categoryId,
        c.name AS categoryName
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      ORDER BY c.name ASC, p.name ASC
      `
    );

    return res.status(200).json({
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        currentPrice: row.price == null ? null : Number(row.price),
        categoryId: row.categoryId,
        categoryName: row.categoryName || "Uncategorized",
      })),
    });
  } catch (error) {
    console.error("getOwnerStockPriceCatalog error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch stock price catalog",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const updateOwnerStockPrices = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    const effectiveDate = String(req.body?.effectiveDate || "").trim();
    const reason = String(req.body?.reason || "").trim();

    if (!updates.length) {
      return res.status(400).json({
        success: false,
        message: "At least one updated price is required",
      });
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (effectiveDate && !dateRegex.test(effectiveDate)) {
      return res.status(400).json({
        success: false,
        message: "effectiveDate must be in YYYY-MM-DD format",
      });
    }

    const normalizedUpdates = updates
      .map((item) => ({
        productId: Number(item?.productId || 0),
        newPrice: Number(item?.newPrice),
      }))
      .filter((item) => item.productId > 0 && Number.isFinite(item.newPrice) && item.newPrice >= 0);

    if (!normalizedUpdates.length) {
      return res.status(400).json({
        success: false,
        message: "No valid price updates provided",
      });
    }

    const uniqueProductIds = [...new Set(normalizedUpdates.map((item) => item.productId))];
    const placeholders = uniqueProductIds.map(() => "?").join(", ");

    const [existingProducts] = await connection.query(
      `SELECT id, price FROM products WHERE id IN (${placeholders})`,
      uniqueProductIds
    );

    const currentById = new Map(
      existingProducts.map((row) => [Number(row.id), row.price == null ? null : Number(row.price)])
    );

    const changedUpdates = normalizedUpdates.filter((item) => {
      const current = currentById.get(item.productId);
      if (current == null) return true;
      return Number(current) !== Number(item.newPrice);
    });

    if (!changedUpdates.length) {
      return res.status(200).json({
        success: true,
        message: "No price changes detected",
        changedCount: 0,
      });
    }

    await connection.beginTransaction();

    await connection.query(
      `
      CREATE TABLE IF NOT EXISTS stock_price_history (
        id BIGINT NOT NULL AUTO_INCREMENT,
        product_id INT NOT NULL,
        old_price DECIMAL(10,2) NULL,
        new_price DECIMAL(10,2) NOT NULL,
        effective_date DATE NULL,
        reason VARCHAR(255) NULL,
        created_by INT NULL,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_stock_price_history_product_id (product_id),
        CONSTRAINT fk_stock_price_history_product FOREIGN KEY (product_id) REFERENCES products(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
      `
    );

    for (const item of changedUpdates) {
      const currentPrice = currentById.get(item.productId);

      await connection.query(`UPDATE products SET price = ? WHERE id = ?`, [
        item.newPrice,
        item.productId,
      ]);

      await connection.query(
        `
        INSERT INTO stock_price_history (
          product_id,
          old_price,
          new_price,
          effective_date,
          reason,
          created_by
        ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          item.productId,
          currentPrice,
          item.newPrice,
          effectiveDate || null,
          reason || null,
          null,
        ]
      );
    }

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "Prices updated successfully",
      changedCount: changedUpdates.length,
    });
  } catch (error) {
    await connection.rollback();
    console.error("updateOwnerStockPrices error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update prices",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const updateOwnerStockProduct = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const productId = Number(req.params.productId || req.params.id || 0);
    const {
      name,
      type,
      price,
      categoryName,
      openingStock,
      systemStock,
      emptyPhysical,
      emptyQuantity,
      emptyOpeningStock,
      emptyStock,
      systemEmptyStock,
      systemEmptyQuantity,
    } = req.body;

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Valid productId is required",
      });
    }

    const [[existingProduct]] = await connection.query(
      `SELECT p.*, c.name AS current_category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ? LIMIT 1`,
      [productId]
    );

    if (!existingProduct) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const rawEmptyPhysical = emptyPhysical ?? emptyQuantity ?? emptyOpeningStock;
    const newEmptyPhysical =
      rawEmptyPhysical !== undefined && rawEmptyPhysical !== null && rawEmptyPhysical !== ""
        ? Number(rawEmptyPhysical)
        : null;

    const rawSystemEmpty = systemEmptyStock ?? systemEmptyQuantity ?? emptyStock;
    const newSystemEmpty =
      rawSystemEmpty !== undefined && rawSystemEmpty !== null && rawSystemEmpty !== ""
        ? Number(rawSystemEmpty)
        : null;

    if (newEmptyPhysical !== null && (!Number.isFinite(newEmptyPhysical) || newEmptyPhysical < 0)) {
      return res.status(400).json({
        success: false,
        message: "Empty physical quantity must be a non-negative number",
      });
    }

    if (newSystemEmpty !== null && (!Number.isFinite(newSystemEmpty) || newSystemEmpty < 0)) {
      return res.status(400).json({
        success: false,
        message: "Empty system stock must be a non-negative number",
      });
    }

    await connection.beginTransaction();

    let categoryId = existingProduct.category_id;
    if (categoryName && String(categoryName).trim()) {
      const cleanCatName = String(categoryName).trim();
      const [[foundCat]] = await connection.query(
        `SELECT id FROM categories WHERE LOWER(name) = LOWER(?) LIMIT 1`,
        [cleanCatName]
      );
      if (foundCat) {
        categoryId = foundCat.id;
      } else {
        const [catResult] = await connection.query(
          `INSERT INTO categories (name) VALUES (?)`,
          [cleanCatName]
        );
        categoryId = catResult.insertId;
      }
    }

    const updatedName = name !== undefined && String(name).trim() ? String(name).trim() : existingProduct.name;
    const updatedType = type && ["DOMESTIC", "COMMERCIAL"].includes(String(type).toUpperCase())
      ? String(type).toUpperCase()
      : existingProduct.type;
    const updatedPrice = price !== undefined && price !== null && price !== "" ? Number(price) : existingProduct.price;

    await connection.query(
      `UPDATE products SET name = ?, type = ?, price = ?, category_id = ? WHERE id = ?`,
      [updatedName, updatedType, updatedPrice, categoryId, productId]
    );

    const hasStockUpdate =
      openingStock !== undefined ||
      systemStock !== undefined ||
      rawEmptyPhysical !== undefined ||
      rawSystemEmpty !== undefined;

    let targetQuantity = null;
    let targetSystemQuantity = null;
    let targetEmptyQuantity = null;
    let targetSystemEmptyQuantity = null;

    if (hasStockUpdate) {
      const [[stockArea]] = await connection.query(
        `SELECT id FROM stock_areas WHERE agency_id = ? LIMIT 1`,
        [req.user.agency_id]
      );
      const stockAreaId = stockArea?.id || 1;

      const newOpening = openingStock !== undefined && openingStock !== null && openingStock !== ""
        ? Number(openingStock)
        : null;
      const newSystem = systemStock !== undefined && systemStock !== null && systemStock !== ""
        ? Number(systemStock)
        : null;

      // Ensure today's snapshot exists
      await ensureDailyStockSnapshot(connection, req.user.agency_id, null, stockAreaId);

      const [[existingStock]] = await connection.query(
        `SELECT quantity, system_quantity, empty_quantity, system_empty_quantity FROM stock WHERE product_id = ? AND stock_area_id = ? AND agency_id = ? LIMIT 1`,
        [productId, stockAreaId, req.user.agency_id]
      );

      targetQuantity = newOpening !== null ? Math.floor(newOpening) : Number(existingStock?.quantity || 0);
      targetSystemQuantity = newSystem !== null ? Math.floor(newSystem) : Number(existingStock?.system_quantity || 0);
      targetEmptyQuantity = newEmptyPhysical !== null ? Math.floor(newEmptyPhysical) : Number(existingStock?.empty_quantity || 0);
      targetSystemEmptyQuantity = newSystemEmpty !== null ? Math.floor(newSystemEmpty) : Number(existingStock?.system_empty_quantity || 0);

      await connection.query(
        `
        INSERT INTO stock (
          product_id, stock_area_id, quantity, system_quantity, 
          quantity_return, empty_quantity, system_empty_quantity, 
          defective_quantity, agency_id
        )
        VALUES (?, ?, ?, ?, 0, ?, ?, 0, ?)
        ON DUPLICATE KEY UPDATE 
          quantity = VALUES(quantity), 
          system_quantity = VALUES(system_quantity), 
          empty_quantity = VALUES(empty_quantity), 
          system_empty_quantity = VALUES(system_empty_quantity), 
          updated_at = CURRENT_TIMESTAMP
        `,
        [
          productId,
          stockAreaId,
          targetQuantity,
          targetSystemQuantity,
          targetEmptyQuantity,
          targetSystemEmptyQuantity,
          req.user.agency_id,
        ]
      );

      // Update today's daily_stock_snapshots for snapshot_date = CURDATE()
      const [todaySnapshots] = await connection.query(
        `SELECT id, opening_stock, system_opening, empty_opening, system_empty_opening, empty_closing, system_empty_closing, purchase_qty, sales_qty, system_sales_qty FROM daily_stock_snapshots WHERE agency_id = ? AND stock_area_id = ? AND product_id = ? AND snapshot_date = CURDATE() FOR UPDATE`,
        [req.user.agency_id, stockAreaId, productId]
      );

      if (todaySnapshots.length) {
        const snap = todaySnapshots[0];
        const updatedOpening = newOpening !== null ? Math.floor(newOpening) : Number(snap.opening_stock || 0);
        const updatedSystemOpening = newSystem !== null ? Math.floor(newSystem) : Number(snap.system_opening || 0);
        const purchaseQty = Number(snap.purchase_qty || 0);
        const salesQty = Number(snap.sales_qty || 0);
        const systemSalesQty = Number(snap.system_sales_qty || 0);
        const newClosing = updatedOpening + purchaseQty - salesQty;
        const newSystemClosing = updatedSystemOpening + purchaseQty - systemSalesQty;

        const updatedEmptyOpening = newEmptyPhysical !== null ? Math.floor(newEmptyPhysical) : Number(snap.empty_opening || 0);
        const updatedSystemEmptyOpening = newSystemEmpty !== null ? Math.floor(newSystemEmpty) : Number(snap.system_empty_opening || 0);
        const updatedEmptyClosing = newEmptyPhysical !== null ? targetEmptyQuantity : Number(snap.empty_closing != null ? snap.empty_closing : targetEmptyQuantity);
        const updatedSystemEmptyClosing = newSystemEmpty !== null ? targetSystemEmptyQuantity : Number(snap.system_empty_closing != null ? snap.system_empty_closing : targetSystemEmptyQuantity);

        await connection.query(
          `
          UPDATE daily_stock_snapshots
          SET opening_stock = ?,
              closing_stock = ?,
              system_opening = ?,
              system_closing = ?,
              empty_opening = ?,
              empty_closing = ?,
              system_empty_opening = ?,
              system_empty_closing = ?,
              updated_at = NOW()
          WHERE id = ?
          `,
          [
            updatedOpening,
            newClosing,
            updatedSystemOpening,
            newSystemClosing,
            updatedEmptyOpening,
            updatedEmptyClosing,
            updatedSystemEmptyOpening,
            updatedSystemEmptyClosing,
            snap.id,
          ]
        );
      }
    }

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "Category and product updated successfully",
      data: {
        id: productId,
        name: updatedName,
        type: updatedType,
        price: updatedPrice,
        categoryId,
        ...(hasStockUpdate && {
          openingStock: targetQuantity,
          systemStock: targetSystemQuantity,
          emptyPhysical: targetEmptyQuantity,
          systemEmptyStock: targetSystemEmptyQuantity,
        }),
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("updateOwnerStockProduct error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update category/product",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const deleteOwnerStockProduct = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const productId = Number(req.params.productId || req.params.id || 0);

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "Valid productId is required",
      });
    }

    const [[existingProduct]] = await connection.query(
      `SELECT id, name, category_id FROM products WHERE id = ? LIMIT 1`,
      [productId]
    );

    if (!existingProduct) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    // Check if sales exist for this product
    const [[salesCount]] = await connection.query(
      `SELECT COUNT(*) AS count FROM sales_items WHERE product_id = ?`,
      [productId]
    );

    if (salesCount && salesCount.count > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete "${existingProduct.name}" because it has ${salesCount.count} existing sales record(s).`,
      });
    }

    // Check if purchase records exist for this product
    const [[purchaseCount]] = await connection.query(
      `SELECT COUNT(*) AS count FROM purchase_load_items WHERE product_id = ?`,
      [productId]
    );

    if (purchaseCount && purchaseCount.count > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete "${existingProduct.name}" because it has ${purchaseCount.count} existing purchase record(s).`,
      });
    }

    // Check if customer new connection records exist for this product
    const [[connCount]] = await connection.query(
      `SELECT COUNT(*) AS count FROM customer_new_connection_products WHERE product_id = ?`,
      [productId]
    );

    if (connCount && connCount.count > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete "${existingProduct.name}" because it is linked to ${connCount.count} new connection record(s).`,
      });
    }

    await connection.beginTransaction();

    await connection.query(
      `DELETE FROM stock_price_history WHERE product_id = ?`,
      [productId]
    );

    await connection.query(
      `DELETE FROM daily_stock_snapshots WHERE product_id = ? AND agency_id = ?`,
      [productId, req.user.agency_id]
    );

    await connection.query(
      `DELETE FROM stock WHERE product_id = ? AND agency_id = ?`,
      [productId, req.user.agency_id]
    );

    await connection.query(
      `DELETE FROM stock_transactions WHERE product_id = ? AND agency_id = ?`,
      [productId, req.user.agency_id]
    );

    await connection.query(`DELETE FROM products WHERE id = ?`, [productId]);

    // Clean up category if empty
    if (existingProduct.category_id) {
      const [[catCount]] = await connection.query(
        `SELECT COUNT(*) AS count FROM products WHERE category_id = ?`,
        [existingProduct.category_id]
      );
      if (catCount && catCount.count === 0) {
        await connection.query(`DELETE FROM categories WHERE id = ?`, [existingProduct.category_id]);
      }
    }

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: `Category/item "${existingProduct.name}" deleted successfully`,
    });
  } catch (error) {
    await connection.rollback();
    console.error("deleteOwnerStockProduct error:", error);
    return res.status(500).json({
      success: false,
      message: error.sqlMessage || error.message || "Failed to delete category/product",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
