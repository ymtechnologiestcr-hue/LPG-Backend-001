import db from "../config/db.js";
import bcrypt from "bcryptjs";
import { getSalesDashboard } from "./salesController.js";
import { getDriverDashboard } from "./driverController.js";
import {
  createOwnerStockCategoryWithItem,
  createOwnerStockItem,
  getOwnerStockItemContext,
  getOwnerStockPriceCatalog,
  getStockDashboard,
  getStockAreas,
  searchOwnerStockCategories,
  searchOwnerStockItems,
  updateOwnerStockPrices,
  upsertOwnerStockEntry,
  updateOwnerStockProduct,
  deleteOwnerStockProduct,
} from "./stockController.js";

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const JOB_ROLE_TO_SYSTEM_ROLE = {
  GODOWN_MANAGER: "GODOWN_MANAGER",
  PURCHASE_DRIVER: "PURCHASE_MANAGER",
  DELIVERY_AGENT: "DRIVER",
  CASHIER: "CASHIER",
  CUSTOMER_SERVICE: "SUPPORT",
  MANAGER: "SUPPORT",
};

const JOB_ROLE_LABELS = {
  GODOWN_MANAGER: "Godown Manager",
  PURCHASE_DRIVER: "Purchase Driver",
  DELIVERY_AGENT: "Delivery Agent",
  CASHIER: "Cashier",
  CUSTOMER_SERVICE: "Customer Service",
  MANAGER: "Manager",
};

const DEFAULT_JOB_ASSIGNMENT_PASSWORD = "Password@123";

const resolveExpenseDateRange = (query) => {
  const rawStartDate = String(query?.startDate || "");
  const rawEndDate = String(query?.endDate || "");

  const startDate = DATE_ONLY_REGEX.test(rawStartDate) ? rawStartDate : null;
  const endDate = DATE_ONLY_REGEX.test(rawEndDate) ? rawEndDate : null;

  if (!startDate && !endDate) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString()
      .split("T")[0];
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)
      .toISOString()
      .split("T")[0];

    return { startDate: monthStart, endDate: monthEnd };
  }

  const computedStartDate = startDate || endDate;
  const computedEndDate = endDate || startDate;

  if (computedStartDate <= computedEndDate) {
    return { startDate: computedStartDate, endDate: computedEndDate };
  }

  return { startDate: computedEndDate, endDate: computedStartDate };
};

const resolveDateRange = (query) => {
  const rawStartDate = String(query?.startDate || "");
  const rawEndDate = String(query?.endDate || "");

  const startDate = DATE_ONLY_REGEX.test(rawStartDate) ? rawStartDate : null;
  const endDate = DATE_ONLY_REGEX.test(rawEndDate) ? rawEndDate : null;

  if (!startDate && !endDate) {
    const today = new Date().toISOString().split("T")[0];
    return { startDate: today, endDate: today };
  }

  const computedStartDate = startDate || endDate;
  const computedEndDate = endDate || startDate;

  if (computedStartDate <= computedEndDate) {
    return { startDate: computedStartDate, endDate: computedEndDate };
  }

  return { startDate: computedEndDate, endDate: computedStartDate };
};

export const getOwnerDashboard = async (req, res) => {
  try {
    const { startDate, endDate } = resolveDateRange(req.query);

    // Total Sales for date range
    const [salesRows] = await db.execute(
      `
      SELECT COALESCE(SUM(total_amount), 0) AS total_sales
      FROM sales
      WHERE status = 'DELIVERED'
        AND agency_id = ?
        AND DATE(COALESCE(delivered_at, created_at)) BETWEEN ? AND ?
      `,
      [req.user.agency_id, startDate, endDate],
    );

    const totalSales = Number(salesRows[0]?.total_sales || 0);

    // Cylinders Delivered for date range
    const [deliveredRows] = await db.execute(
      `
      SELECT COALESCE(SUM(si.delivered_qty), 0) AS delivered_qty
      FROM sales s
      INNER JOIN sales_items si ON si.sale_id = s.id
      WHERE s.status = 'DELIVERED'
        AND s.driver_id IS NOT NULL
        AND s.agency_id = ?
        AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?
      `,
      [req.user.agency_id, startDate, endDate],
    );

    const cylindersDelivered = Number(deliveredRows[0]?.delivered_qty || 0);

    // Cash Pending with Drivers (settlement_history with status ASSIGNED or PENDING)
    const [pendingCollectionRows] = await db.execute(
      `
      SELECT COALESCE(SUM(amount), 0) AS pending_amount
      FROM settlement_history
      WHERE status IN ('ASSIGNED', 'PENDING')
        AND agency_id = ?
        AND DATE(created_at) BETWEEN ? AND ?
      `,
      [req.user.agency_id, startDate, endDate],
    );

    const cashPendingWithDrivers = Number(
      pendingCollectionRows[0]?.pending_amount || 0,
    );

    // Godown on-hand stock (Domestic and Commercial only)
    const [stockRows] = await db.execute(
      `
      SELECT
        p.type AS product_type,
        COALESCE(SUM(s.quantity), 0) AS total_quantity,
        COALESCE(SUM(s.empty_quantity), 0) AS empty_quantity
      FROM stock s
      INNER JOIN products p ON p.id = s.product_id
      WHERE p.type IN ('DOMESTIC', 'COMMERCIAL')
        AND s.agency_id = ?
      GROUP BY p.type
      `,
      [req.user.agency_id]
    );

    // Cylinders currently in-hand with drivers (allocated but not yet delivered/returned)
    // Same logic as godown stock-detail controller.
    const [driverInHandRows] = await db.execute(
      `
      SELECT
        p.type AS product_type,
        COALESCE(SUM(GREATEST(
          COALESCE(asi.quantity, 0)
          - COALESCE(delivered_data.delivered_qty, 0)
          - COALESCE(return_data.return_qty, 0)
          - COALESCE(return_data.defective_qty, 0), 0
        )), 0) AS in_hand
      FROM sales_items asi
      INNER JOIN sales a ON a.id = asi.sale_id
      INNER JOIN products p ON p.id = asi.product_id
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
        AND p.type IN ('DOMESTIC', 'COMMERCIAL')
      GROUP BY p.type
      `,
      [req.user.agency_id, req.user.agency_id, req.user.agency_id]
    );

    // Cylinders sold whose OTP has been submitted to IOC within the date range
    const [sentOtpRows] = await db.execute(
      `
      SELECT
        p.type AS product_type,
        COALESCE(SUM(COALESCE(si.delivered_qty, si.quantity, 0)), 0) AS sent_otp
      FROM sales_items si
      INNER JOIN sales s ON s.id = si.sale_id
      INNER JOIN products p ON p.id = si.product_id
      WHERE si.allocation_sales_item_id IS NOT NULL
        AND s.status = 'DELIVERED'
        AND s.agency_id = ?
        AND p.type IN ('DOMESTIC', 'COMMERCIAL')
        AND EXISTS (
          SELECT 1 FROM driver_sale_otps dso
          WHERE dso.sale_id = s.id
            AND dso.status = 'SENT'
            AND DATE(dso.created_at) BETWEEN ? AND ?
        )
      GROUP BY p.type
      `,
      [req.user.agency_id, startDate, endDate]
    );

    let domesticStock = 0;
    let commercialStock = 0;
    let emptyDomestic = 0;
    let emptyCommercial = 0;
    let allocatedDomestic = 0;
    let allocatedCommercial = 0;
    let otpSentDomestic = 0;
    let otpSentCommercial = 0;

    stockRows.forEach((row) => {
      if (row.product_type === "DOMESTIC") {
        domesticStock = Number(row.total_quantity || 0);
        emptyDomestic = Number(row.empty_quantity || 0);
      } else if (row.product_type === "COMMERCIAL") {
        commercialStock = Number(row.total_quantity || 0);
        emptyCommercial = Number(row.empty_quantity || 0);
      }
    });

    driverInHandRows.forEach((row) => {
      if (row.product_type === "DOMESTIC") {
        allocatedDomestic = Number(row.in_hand || 0);
      } else if (row.product_type === "COMMERCIAL") {
        allocatedCommercial = Number(row.in_hand || 0);
      }
    });

    sentOtpRows.forEach((row) => {
      if (row.product_type === "DOMESTIC") {
        otpSentDomestic = Number(row.sent_otp || 0);
      } else if (row.product_type === "COMMERCIAL") {
        otpSentCommercial = Number(row.sent_otp || 0);
      }
    });

    // Physical = godown on-hand + cylinders in-hand with drivers (same as godown stock-detail)
    const physicalDomestic = domesticStock + allocatedDomestic;
    const physicalCommercial = commercialStock + allocatedCommercial;

    // System = physical + cylinders sold with OTP still pending (same as godown stock-detail)
    const systemDomestic = physicalDomestic + otpSentDomestic;
    const systemCommercial = physicalCommercial + otpSentCommercial;

    const totalGodownStock = domesticStock + commercialStock;
    const totalPhysical = physicalDomestic + physicalCommercial;
    const totalEmpty = emptyDomestic + emptyCommercial;
    const totalSystem = systemDomestic + systemCommercial;
    const totalOtpSent = otpSentDomestic + otpSentCommercial;
    const totalAllocated = allocatedDomestic + allocatedCommercial;

    // Total Expenses (Driver Expense from expenses table + Office Expense from office_expenses table)
    const [driverExpenseRows] = await db.execute(
      `
      SELECT COALESCE(SUM(e.amount), 0) AS driver_expense
      FROM expenses e
      INNER JOIN users u ON u.id = e.created_by
      WHERE u.role = 'DRIVER'
        AND e.status = 'APPROVED'
        AND e.agency_id = ?
        AND DATE(e.created_at) BETWEEN ? AND ?
      `,
      [req.user.agency_id, startDate, endDate],
    );

    const [officeExpenseRows] = await db.execute(
      `
      SELECT COALESCE(SUM(amount), 0) AS office_expense
      FROM office_expenses
      WHERE agency_id = ?
        AND DATE(created_at) BETWEEN ? AND ?
      `,
      [req.user.agency_id, startDate, endDate],
    );

    const driverExpense = Number(driverExpenseRows[0]?.driver_expense || 0);
    const officeExpense = Number(officeExpenseRows[0]?.office_expense || 0);
    const totalExpenses = driverExpense + officeExpense;

    // Payment breakdown for top sales cards
    const [paymentSummaryRows] = await db.execute(
      `
      SELECT
        COALESCE(SUM(CASE WHEN p.method = 'CASH' AND p.type = 'DRIVER' AND (s.payment_method != 'ONLINE' OR s.payment_method IS NULL) AND p.status = 'SUCCESS' THEN p.amount ELSE 0 END), 0) AS cash_sales,
        COALESCE(SUM(CASE WHEN p.method = 'UPI' AND p.type = 'DRIVER' AND (s.payment_method != 'ONLINE' OR s.payment_method IS NULL) AND p.status = 'SUCCESS' THEN p.amount ELSE 0 END), 0) AS gpay_sales,
        COALESCE(SUM(CASE WHEN (p.type = 'COMPANY' OR p.method = 'CARD' OR s.payment_method = 'ONLINE') AND p.status = 'SUCCESS' THEN p.amount ELSE 0 END), 0) AS online_sales
      FROM payments p
      INNER JOIN sales s ON s.id = p.sale_id
      WHERE s.status = 'DELIVERED'
        AND s.agency_id = ?
        AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?
      `,
      [req.user.agency_id, startDate, endDate],
    );

    const paymentSummary = {
      cashSales: Number(paymentSummaryRows[0]?.cash_sales || 0),
      gpaySales: Number(paymentSummaryRows[0]?.gpay_sales || 0),
      onlineSales: Number(paymentSummaryRows[0]?.online_sales || 0),
    };

    // Driver-wise collection breakdown (Cash & GPay)
    const [driverBreakdownRows] = await db.execute(
      `
      SELECT
        d.id AS driver_id,
        u.name AS driver_name,
        COUNT(DISTINCT s.id) AS deliveries,
        COALESCE(SUM(CASE WHEN p.method = 'CASH' AND p.type = 'DRIVER' AND (s.payment_method != 'ONLINE' OR s.payment_method IS NULL) AND p.status = 'SUCCESS' THEN p.amount ELSE 0 END), 0) AS cash,
        COALESCE(SUM(CASE WHEN p.method = 'UPI' AND p.type = 'DRIVER' AND (s.payment_method != 'ONLINE' OR s.payment_method IS NULL) AND p.status = 'SUCCESS' THEN p.amount ELSE 0 END), 0) AS gpay,
        COALESCE(SUM(CASE WHEN p.method IN ('CASH', 'UPI') AND p.type = 'DRIVER' AND (s.payment_method != 'ONLINE' OR s.payment_method IS NULL) AND p.status = 'SUCCESS' THEN p.amount ELSE 0 END), 0) AS total_sales
      FROM drivers d
      INNER JOIN users u ON u.id = d.user_id
      LEFT JOIN sales s
        ON s.driver_id = d.id
       AND s.status = 'DELIVERED'
       AND s.agency_id = ?
       AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?
      LEFT JOIN payments p ON p.sale_id = s.id
      WHERE u.agency_id = ?
      GROUP BY d.id, u.name
      HAVING deliveries > 0 OR total_sales > 0
      ORDER BY total_sales DESC
      `,
      [req.user.agency_id, startDate, endDate, req.user.agency_id],
    );

    const driverCollectionBreakdown = driverBreakdownRows.map((row) => ({
      driverId: Number(row.driver_id),
      driverName: row.driver_name,
      totalSales: Number(row.total_sales || 0),
      cash: Number(row.cash || 0),
      gpay: Number(row.gpay || 0),
      deliveries: Number(row.deliveries || 0),
    }));

    // Recent sales list for owner dashboard table
    const [recentSalesRows] = await db.execute(
      `
      SELECT
        s.id AS sale_id,
        c.name AS customer_name,
        COALESCE(
          CASE
            WHEN COUNT(DISTINCT pr.type) > 1 THEN 'MIXED'
            ELSE MAX(pr.type)
          END,
          'DOMESTIC'
        ) AS sale_type,
        COALESCE(
          SUM(
            CASE
              WHEN COALESCE(si.delivered_qty, 0) > 0 THEN si.delivered_qty
              ELSE COALESCE(si.quantity, 0)
            END
          ),
          0
        ) AS total_qty,
        COALESCE(s.total_amount, 0) AS amount,
        COALESCE(SUM(CASE WHEN p.method = 'CASH' AND p.status = 'SUCCESS' THEN p.amount ELSE 0 END), 0) AS cash_amount,
        COALESCE(SUM(CASE WHEN p.method = 'UPI' AND p.status = 'SUCCESS' THEN p.amount ELSE 0 END), 0) AS upi_amount,
        COALESCE(SUM(CASE WHEN (p.type = 'COMPANY' OR p.method = 'CARD') AND p.status = 'SUCCESS' THEN p.amount ELSE 0 END), 0) AS online_amount,
        du.name AS driver_name,
        s.status
      FROM sales s
      INNER JOIN users c ON c.id = s.customer_id
      LEFT JOIN drivers d ON d.id = s.driver_id
      LEFT JOIN users du ON du.id = d.user_id
      LEFT JOIN sales_items si ON si.sale_id = s.id
      LEFT JOIN products pr ON pr.id = si.product_id
      LEFT JOIN payments p ON p.sale_id = s.id
      WHERE s.agency_id = ?
        AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?
      GROUP BY s.id, c.name, du.name, s.status, s.total_amount
      ORDER BY COALESCE(s.delivered_at, s.created_at) DESC, s.id DESC
      LIMIT 8
      `,
      [req.user.agency_id, startDate, endDate],
    );

    const recentSales = recentSalesRows.map((row) => {
      const cashAmount = Number(row.cash_amount || 0);
      const upiAmount = Number(row.upi_amount || 0);
      const onlineAmount = Number(row.online_amount || 0);

      let payment = "-";
      const paymentModes = [
        cashAmount > 0 ? "Cash" : null,
        upiAmount > 0 ? "GPay" : null,
        onlineAmount > 0 ? "Online" : null,
      ].filter(Boolean);

      if (paymentModes.length === 1) {
        payment = paymentModes[0];
      } else if (paymentModes.length > 1) {
        payment = "Mixed";
      }

      return {
        orderId: `S-${String(row.sale_id).padStart(3, "0")}`,
        customer: row.customer_name,
        type:
          row.sale_type === "COMMERCIAL"
            ? "Commercial"
            : row.sale_type === "MIXED"
              ? "Mixed"
              : "Domestic",
        quantity: Number(row.total_qty || 0),
        amount: Number(row.amount || 0),
        payment,
        driver: row.driver_name || "-",
        status: String(row.status || "PENDING"),
      };
    });

    return res.status(200).json({
      success: true,
      message: "Owner dashboard data fetched successfully",
      data: {
        dateRange: {
          startDate,
          endDate,
        },
        totalSales,
        cylindersDelivered,
        cashPendingWithDrivers,
        stock: {
          domestic: domesticStock,
          commercial: commercialStock,
          total: totalGodownStock,
        },
        empty: {
          domestic: emptyDomestic,
          commercial: emptyCommercial,
          total: totalEmpty,
        },
        systemStock: {
          domestic: systemDomestic,
          commercial: systemCommercial,
          total: totalSystem,
          godownStock: {
            domestic: domesticStock,
            commercial: commercialStock,
            total: totalGodownStock,
          },
          allocatedStock: {
            domestic: allocatedDomestic,
            commercial: allocatedCommercial,
            total: totalAllocated,
          },
          otpSent: {
            domestic: otpSentDomestic,
            commercial: otpSentCommercial,
            total: totalOtpSent,
          },
        },
        totalExpenses,
        paymentSummary,
        driverCollectionBreakdown,
        recentSales,
      },
    });
  } catch (error) {
    console.error("getOwnerDashboard error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch owner dashboard data",
      error: error.message,
    });
  }
};

export const getOwnerDashboardInsights = async (req, res) => {
  try {
    const { startDate, endDate } = resolveDateRange(req.query);

    // ---- Sales Performance: daily trend (independent 7 / 30 day toggle) ----
    const requestedDays = Number(req.query.days);
    const trendDays = requestedDays === 30 ? 30 : 7;

    const trendStartObj = new Date();
    trendStartObj.setHours(0, 0, 0, 0);
    trendStartObj.setDate(trendStartObj.getDate() - (trendDays - 1));

    const toKey = (value) => {
      const d = new Date(value);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };

    const trendStart = toKey(trendStartObj);
    const trendEnd = toKey(new Date());

    const [salesTrendRows] = await db.execute(
      `
      SELECT DATE(COALESCE(delivered_at, created_at)) AS day,
             COALESCE(SUM(total_amount), 0) AS sales
      FROM sales
      WHERE status = 'DELIVERED'
        AND agency_id = ?
        AND DATE(COALESCE(delivered_at, created_at)) BETWEEN ? AND ?
      GROUP BY day
      `,
      [req.user.agency_id, trendStart, trendEnd],
    );

    const [deliveredTrendRows] = await db.execute(
      `
      SELECT DATE(COALESCE(s.delivered_at, s.created_at)) AS day,
             COALESCE(SUM(si.delivered_qty), 0) AS delivered
      FROM sales s
      INNER JOIN sales_items si ON si.sale_id = s.id
      WHERE s.status = 'DELIVERED'
        AND s.driver_id IS NOT NULL
        AND s.agency_id = ?
        AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?
      GROUP BY day
      `,
      [req.user.agency_id, trendStart, trendEnd],
    );

    const salesByDay = {};
    salesTrendRows.forEach((row) => {
      salesByDay[toKey(row.day)] = Number(row.sales || 0);
    });

    const deliveredByDay = {};
    deliveredTrendRows.forEach((row) => {
      deliveredByDay[toKey(row.day)] = Number(row.delivered || 0);
    });

    const trendPoints = [];
    for (let i = 0; i < trendDays; i += 1) {
      const d = new Date(trendStartObj);
      d.setDate(d.getDate() + i);
      const key = toKey(d);
      trendPoints.push({
        date: key,
        label: d.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
        sales: salesByDay[key] || 0,
        delivered: deliveredByDay[key] || 0,
      });
    }

    // ---- Stock Overview (capacity = full + empty + defective per fleet) ----
    const [stockRows] = await db.execute(
      `
      SELECT
        COALESCE(SUM(CASE WHEN p.type = 'DOMESTIC' THEN s.quantity ELSE 0 END), 0) AS dom_full,
        COALESCE(SUM(CASE WHEN p.type = 'DOMESTIC' THEN COALESCE(s.empty_quantity, 0) + COALESCE(s.defective_quantity, 0) ELSE 0 END), 0) AS dom_rest,
        COALESCE(SUM(CASE WHEN p.type = 'COMMERCIAL' THEN s.quantity ELSE 0 END), 0) AS com_full,
        COALESCE(SUM(CASE WHEN p.type = 'COMMERCIAL' THEN COALESCE(s.empty_quantity, 0) + COALESCE(s.defective_quantity, 0) ELSE 0 END), 0) AS com_rest,
        COALESCE(SUM(COALESCE(s.empty_quantity, 0)), 0) AS empty_total
      FROM stock s
      INNER JOIN products p ON p.id = s.product_id
      WHERE p.type IN ('DOMESTIC', 'COMMERCIAL')
        AND s.agency_id = ?
      `,
      [req.user.agency_id]
    );

    const sr = stockRows[0] || {};
    const domFull = Number(sr.dom_full || 0);
    const domTotal = domFull + Number(sr.dom_rest || 0);
    const comFull = Number(sr.com_full || 0);
    const comTotal = comFull + Number(sr.com_rest || 0);
    const emptyCurrent = Number(sr.empty_total || 0);
    const fleetTotal = domTotal + comTotal;

    const ratio = (current, total) => (total > 0 ? current / total : 0);

    const stockOverview = {
      domestic: {
        current: domFull,
        total: domTotal,
        low: domTotal > 0 && ratio(domFull, domTotal) < 0.3,
      },
      commercial: {
        current: comFull,
        total: comTotal,
        low: comTotal > 0 && ratio(comFull, comTotal) < 0.3,
      },
      empty: {
        current: emptyCurrent,
        total: fleetTotal,
        low: fleetTotal > 0 && ratio(emptyCurrent, fleetTotal) < 0.4,
      },
    };

    // ---- Driver Cash Tracking (collected / settled / pending per driver) ----
    const [driverCashRows] = await db.execute(
      `
      SELECT
        d.id AS driver_id,
        u.name AS driver_name,
        COALESCE(dc.cylinders, 0) AS cylinders,
        COALESCE(pc.collected, 0) AS collected,
        COALESCE(st.settled, 0) AS settled,
        COALESCE(pc.collected, 0) - COALESCE(st.settled, 0) AS pending
      FROM drivers d
      INNER JOIN users u ON u.id = d.user_id
      LEFT JOIN (
        SELECT s.driver_id, SUM(si.delivered_qty) AS cylinders
        FROM sales s
        INNER JOIN sales_items si ON si.sale_id = s.id
        WHERE s.status = 'DELIVERED'
          AND s.agency_id = ?
          AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?
        GROUP BY s.driver_id
      ) dc ON dc.driver_id = d.id
      LEFT JOIN (
        SELECT s.driver_id, SUM(p.amount) AS collected
        FROM sales s
        INNER JOIN payments p ON p.sale_id = s.id
        WHERE s.status = 'DELIVERED' AND p.type = 'DRIVER' AND p.status = 'SUCCESS'
          AND (s.payment_method != 'ONLINE' OR s.payment_method IS NULL)
          AND p.method IN ('CASH', 'UPI')
          AND s.agency_id = ?
          AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?
        GROUP BY s.driver_id
      ) pc ON pc.driver_id = d.id
      LEFT JOIN (
        SELECT driver_id, SUM(amount) AS settled
        FROM settlement_history
        WHERE status = 'SETTLED'
          AND agency_id = ?
          AND DATE(created_at) BETWEEN ? AND ?
        GROUP BY driver_id
      ) st ON st.driver_id = d.id
      WHERE u.agency_id = ?
      HAVING cylinders > 0 OR collected > 0 OR settled > 0
      ORDER BY collected DESC
      `,
      [req.user.agency_id, startDate, endDate, req.user.agency_id, startDate, endDate, req.user.agency_id, startDate, endDate, req.user.agency_id],
    );

    const driverCashTracking = driverCashRows.map((row) => {
      const collected = Number(row.collected || 0);
      const settled = Number(row.settled || 0);
      const pending = collected - settled;

      let status = "Pending";
      if (collected === 0) status = "No Activity";
      else if (pending <= 0) status = "Settled";

      return {
        driverId: Number(row.driver_id),
        driverName: row.driver_name,
        cylinders: Number(row.cylinders || 0),
        collected,
        settled,
        pending: Math.max(pending, 0),
        status,
      };
    });

    // ---- Recent Activity (unified feed across the system) ----
    const [activityRows] = await db.query(
      `
      (
        SELECT 'SETTLEMENT' AS kind, u.name AS actor, sh.amount AS amount, NULL AS qty, NULL AS extra, sh.created_at AS ts
        FROM settlement_history sh
        INNER JOIN drivers d ON d.id = sh.driver_id
        INNER JOIN users u ON u.id = d.user_id
        WHERE sh.status = 'SETTLED' AND sh.agency_id = ?
        ORDER BY sh.created_at DESC
        LIMIT 6
      )
      UNION ALL
      (
        SELECT 'STOCK' AS kind, p.name AS actor, NULL AS amount, stt.quantity AS qty, stt.type AS extra, stt.created_at AS ts
        FROM stock_transactions stt
        LEFT JOIN products p ON p.id = stt.product_id
        WHERE stt.agency_id = ?
        ORDER BY stt.created_at DESC
        LIMIT 6
      )
      UNION ALL
      (
        SELECT 'DELIVERY' AS kind, u.name AS actor, NULL AS amount, NULL AS qty, NULL AS extra, s.delivered_at AS ts
        FROM sales s
        INNER JOIN drivers d ON d.id = s.driver_id
        INNER JOIN users u ON u.id = d.user_id
        WHERE s.status = 'DELIVERED' AND s.delivered_at IS NOT NULL AND s.agency_id = ?
        ORDER BY s.delivered_at DESC
        LIMIT 6
      )
      UNION ALL
      (
        SELECT 'EXPENSE' AS kind, u.name AS actor, e.amount AS amount, NULL AS qty, e.category AS extra, e.created_at AS ts
        FROM expenses e
        LEFT JOIN users u ON u.id = e.created_by
        WHERE e.agency_id = ?
        ORDER BY e.created_at DESC
        LIMIT 6
      )
      UNION ALL
      (
        SELECT 'ORDER' AS kind, c.name AS actor, NULL AS amount, NULL AS qty, NULL AS extra, s.created_at AS ts
        FROM sales s
        INNER JOIN users c ON c.id = s.customer_id
        WHERE s.agency_id = ?
        ORDER BY s.created_at DESC
        LIMIT 6
      )
      ORDER BY ts DESC
      LIMIT 10
      `,
      [req.user.agency_id, req.user.agency_id, req.user.agency_id, req.user.agency_id, req.user.agency_id]
    );

    const formatInr = (value) => Number(value || 0).toLocaleString("en-IN");

    const recentActivity = activityRows.map((row) => {
      const amount = row.amount != null ? Number(row.amount) : null;
      const qty = row.qty != null ? Number(row.qty) : null;
      let title = "Activity";

      switch (row.kind) {
        case "SETTLEMENT":
          title = `${row.actor || "Driver"} settled ₹${formatInr(amount)} cash`;
          break;
        case "STOCK": {
          const sign = qty != null && qty >= 0 ? "+" : "";
          title = `Stock updated: ${sign}${qty ?? 0} ${row.actor || "cylinders"}`;
          break;
        }
        case "DELIVERY":
          title = `${row.actor || "Driver"} completed a delivery`;
          break;
        case "EXPENSE":
          title = `${row.extra || "Expense"} ₹${formatInr(amount)} submitted by ${row.actor || "staff"}`;
          break;
        case "ORDER":
          title = `New delivery order for ${row.actor || "customer"}`;
          break;
        default:
          title = "Activity";
      }

      return {
        type: row.kind,
        title,
        createdAt: row.ts,
      };
    });

    // ---- Expense Breakdown (by category) ----
    const [expenseRows] = await db.execute(
      `
      SELECT COALESCE(NULLIF(TRIM(category), ''), 'Other') AS category,
             COALESCE(SUM(amount), 0) AS amount
      FROM expenses
      WHERE status = 'APPROVED'
        AND agency_id = ?
        AND DATE(created_at) BETWEEN ? AND ?
      GROUP BY COALESCE(NULLIF(TRIM(category), ''), 'Other')
      ORDER BY amount DESC
      `,
      [req.user.agency_id, startDate, endDate],
    );

    const expenseItems = expenseRows.map((row) => ({
      category: row.category,
      amount: Number(row.amount || 0),
    }));
    const expenseTotal = expenseItems.reduce(
      (sum, item) => sum + item.amount,
      0,
    );

    // ---- Top Drivers Today (by deliveries completed) ----
    const [topDriverRows] = await db.execute(
      `
      SELECT
        d.id AS driver_id,
        u.name AS driver_name,
        COUNT(DISTINCT s.id) AS deliveries
      FROM drivers d
      INNER JOIN users u ON u.id = d.user_id
      LEFT JOIN sales s
        ON s.driver_id = d.id
       AND s.status = 'DELIVERED'
       AND s.agency_id = ?
       AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?
      WHERE u.agency_id = ?
      GROUP BY d.id, u.name
      HAVING deliveries > 0
      ORDER BY deliveries DESC, u.name ASC
      LIMIT 5
      `,
      [req.user.agency_id, startDate, endDate, req.user.agency_id],
    );

    const topDrivers = topDriverRows.map((row) => ({
      driverId: Number(row.driver_id),
      driverName: row.driver_name,
      deliveries: Number(row.deliveries || 0),
    }));

    return res.status(200).json({
      success: true,
      message: "Owner dashboard insights fetched successfully",
      data: {
        dateRange: { startDate, endDate },
        salesTrend: { days: trendDays, points: trendPoints },
        stockOverview,
        driverCashTracking,
        recentActivity,
        expenseBreakdown: { items: expenseItems, total: expenseTotal },
        topDrivers,
      },
    });
  } catch (error) {
    console.error("getOwnerDashboardInsights error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch owner dashboard insights",
      error: error.message,
    });
  }
};

export const getOwnerSalesDashboard = async (req, res) => {
  return getSalesDashboard(req, res);
};

export const getOwnerDriversDashboard = async (req, res) => {
  return getDriverDashboard(req, res);
};

export const getOwnerStocksDashboard = async (req, res) => {
  return getStockDashboard(req, res);
};

export const getOwnerStockAreas = async (req, res) => {
  return getStockAreas(req, res);
};

export const getOwnerStockCategories = async (req, res) => {
  return searchOwnerStockCategories(req, res);
};

export const getOwnerStockItems = async (req, res) => {
  return searchOwnerStockItems(req, res);
};

export const getOwnerStockItemDetails = async (req, res) => {
  return getOwnerStockItemContext(req, res);
};

export const postOwnerStockCategoryWithItem = async (req, res) => {
  return createOwnerStockCategoryWithItem(req, res);
};

export const postOwnerStockItem = async (req, res) => {
  return createOwnerStockItem(req, res);
};

export const postOwnerStockEntry = async (req, res) => {
  return upsertOwnerStockEntry(req, res);
};

export const getOwnerStockPriceList = async (req, res) => {
  return getOwnerStockPriceCatalog(req, res);
};

export const postOwnerStockPriceUpdates = async (req, res) => {
  return updateOwnerStockPrices(req, res);
};

export const putOwnerStockProduct = async (req, res) => {
  return updateOwnerStockProduct(req, res);
};

export const deleteOwnerStockProductEndpoint = async (req, res) => {
  return deleteOwnerStockProduct(req, res);
};

export const getOwnerExpensesDashboard = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
    const offset = (page - 1) * limit;
    const search = String(req.query.search || "").trim();
    const { startDate, endDate } = resolveExpenseDateRange(req.query);

    const [officeStatusColumns] = await connection.query(
      `SHOW COLUMNS FROM office_expenses LIKE 'status'`,
    );
    const officeExpenseHasStatus = officeStatusColumns.length > 0;

    const expenseSourceQuery = `
      SELECT
        e.id AS expense_id,
        CONCAT('PM-', LPAD(e.id, 4, '0')) AS expense_code,
        e.category,
        e.description,
        e.amount,
        DATE_FORMAT(e.created_at, '%Y-%m-%d') AS date,
        e.created_at,
        COALESCE(u.name, 'Unknown') AS created_by,
        COALESCE(u.role, 'PURCHASE_MANAGER') AS created_by_role,
        e.status,
        'PURCHASE_MANAGER' AS source
      FROM expenses e
      LEFT JOIN users u ON u.id = e.created_by
      WHERE u.role = 'PURCHASE_MANAGER'
        AND e.agency_id = ?

      UNION ALL

      SELECT
        o.id AS expense_id,
        CONCAT('OE-', LPAD(o.id, 4, '0')) AS expense_code,
        o.category,
        o.description,
        o.amount,
        DATE_FORMAT(o.created_at, '%Y-%m-%d') AS date,
        o.created_at,
        COALESCE(u.name, 'Cashier Office') AS created_by,
        COALESCE(u.role, 'CASHIER') AS created_by_role,
        ${officeExpenseHasStatus ? "COALESCE(o.status, 'PENDING')" : "'PENDING'"} AS status,
        'CASHIER_OFFICE' AS source
      FROM office_expenses o
      LEFT JOIN users u ON u.id = o.admin_id
      WHERE o.agency_id = ?
    `;

    const filters = [];
    const params = [req.user.agency_id, req.user.agency_id];

    if (search) {
      filters.push(`(
        expense_code LIKE ?
        OR category LIKE ?
        OR description LIKE ?
        OR created_by LIKE ?
        OR created_by_role LIKE ?
        OR source LIKE ?
        OR status LIKE ?
      )`);
      const searchTerm = `%${search}%`;
      params.push(
        searchTerm,
        searchTerm,
        searchTerm,
        searchTerm,
        searchTerm,
        searchTerm,
        searchTerm,
      );
    }

    filters.push(`created_at >= ?`);
    params.push(`${startDate} 00:00:00`);
    filters.push(`created_at <= ?`);
    params.push(`${endDate} 23:59:59`);

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const [summaryRows] = await connection.query(
      `
      SELECT
        COALESCE(SUM(amount), 0) AS totalExpense,
        COALESCE(SUM(CASE WHEN source = 'CASHIER_OFFICE' AND status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pendingApproval
      FROM (
        ${expenseSourceQuery}
      ) expense_items
      ${whereClause}
      `,
      [...params],
    );

    const [salesRows] = await connection.query(
      `
      SELECT COALESCE(SUM(total_amount), 0) AS monthlyTotalSales
      FROM sales
      WHERE status = 'DELIVERED'
        AND agency_id = ?
        AND DATE(COALESCE(delivered_at, created_at)) BETWEEN ? AND ?
      `,
      [req.user.agency_id, startDate, endDate],
    );

    const [countRows] = await connection.query(
      `
      SELECT COUNT(*) AS total
      FROM (
        ${expenseSourceQuery}
      ) expense_items
      ${whereClause}
      `,
      [...params],
    );

    const [rows] = await connection.query(
      `
      SELECT
        expense_id,
        expense_code,
        category,
        description,
        amount,
        date,
        created_at,
        created_by,
        created_by_role,
        status,
        source
      FROM (
        ${expenseSourceQuery}
      ) expense_items
      ${whereClause}
      ORDER BY created_at DESC, expense_id DESC
      LIMIT ?
      OFFSET ?
      `,
      [...params, limit, offset],
    );

    const total = Number(countRows[0]?.total || 0);
    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      success: true,
      summary: {
        totalExpense: Number(summaryRows[0]?.totalExpense || 0),
        monthlyTotalSales: Number(salesRows[0]?.monthlyTotalSales || 0),
        pendingApproval: Number(summaryRows[0]?.pendingApproval || 0),
      },
      dateRange: {
        startDate,
        endDate,
      },
      data: rows.map((row) => ({
        id: row.expense_code,
        rawId: Number(row.expense_id),
        category: row.category,
        description: row.description,
        amount: Number(row.amount || 0),
        date: row.date,
        by: row.created_by,
        byRole: row.created_by_role,
        status: row.status,
        source: row.source,
        canApprove: row.source === "CASHIER_OFFICE" && row.status === "PENDING",
      })),
      pagination: {
        total,
        page,
        limit,
        totalPages,
      },
    });
  } catch (error) {
    console.error("getOwnerExpensesDashboard error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch owner expenses dashboard",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const approveOwnerOfficeExpense = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const expenseId = Number(req.params.expenseId);

    if (!expenseId) {
      return res.status(400).json({
        success: false,
        message: "expenseId is required",
      });
    }

    const [officeStatusColumns] = await connection.query(
      `SHOW COLUMNS FROM office_expenses LIKE 'status'`,
    );

    if (!officeStatusColumns.length) {
      // Column missing — add it automatically and default all existing rows to PENDING
      await connection.query(
        `ALTER TABLE office_expenses ADD COLUMN status ENUM('PENDING','APPROVED') NOT NULL DEFAULT 'PENDING' AFTER description`,
      );
    }

    const [rows] = await connection.query(
      `
      SELECT id, COALESCE(status, 'PENDING') AS status
      FROM office_expenses
      WHERE id = ? AND agency_id = ?
      LIMIT 1
      `,
      [expenseId, req.user.agency_id],
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Office expense not found",
      });
    }

    if (rows[0].status !== "PENDING") {
      return res.status(400).json({
        success: false,
        message: "Only pending office expenses can be approved",
      });
    }

    await connection.query(
      `
      UPDATE office_expenses
      SET status = 'APPROVED',
          updated_at = NOW()
      WHERE id = ? AND agency_id = ?
      `,
      [expenseId, req.user.agency_id],
    );

    return res.status(200).json({
      success: true,
      message: "Office expense approved successfully",
    });
  } catch (error) {
    console.error("approveOwnerOfficeExpense error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to approve office expense",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getOwnerJobAssignmentUsers = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const [profileTableRows] = await connection.query(
      `SHOW TABLES LIKE 'user_job_profiles'`,
    );
    const hasProfileTable = profileTableRows.length > 0;

    const [aadhaarColumnRows] = await connection.query(
      `SHOW COLUMNS FROM users LIKE 'aadhaar_number'`,
    );
    const hasExtendedUserColumns = aadhaarColumnRows.length > 0;

    const [rows] = await connection.query(
      `
      SELECT
        u.id,
        u.name,
        u.phone,
        u.email,
        u.role,
        u.status,
        ${hasProfileTable ? "up.display_role" : "NULL"} AS display_role,
        ${hasProfileTable ? "up.age" : "NULL"} AS age,
        ${hasProfileTable ? "DATE_FORMAT(up.date_of_birth, '%Y-%m-%d')" : "NULL"} AS date_of_birth,
        ${hasProfileTable ? "up.gender" : "NULL"} AS gender,
        ${hasProfileTable ? "up.address" : "NULL"} AS address,
        ${hasProfileTable ? "up.vehicle_number" : "NULL"} AS vehicle_number,
        ${hasProfileTable ? "up.vehicle_type" : "NULL"} AS vehicle_type,
        ${hasProfileTable ? "up.driving_license_number" : "NULL"} AS driving_license_number,
        ${hasExtendedUserColumns ? "u.aadhaar_number" : "NULL"} AS aadhaar_number,
        ${hasExtendedUserColumns ? "u.bank_account_holder_name" : "NULL"} AS bank_account_holder_name,
        ${hasExtendedUserColumns ? "u.bank_name" : "NULL"} AS bank_name,
        ${hasExtendedUserColumns ? "u.bank_account_number" : "NULL"} AS bank_account_number,
        ${hasExtendedUserColumns ? "u.bank_ifsc_code" : "NULL"} AS bank_ifsc_code,
        DATE_FORMAT(u.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
      FROM users u
      ${hasProfileTable ? "LEFT JOIN user_job_profiles up ON up.user_id = u.id" : ""}
      WHERE u.role IN ('GODOWN_MANAGER', 'PURCHASE_MANAGER', 'DRIVER', 'CASHIER', 'SUPPORT')
        AND u.agency_id = ?
      ORDER BY u.created_at DESC, u.id DESC
      `,
      [req.user.agency_id]
    );

    return res.status(200).json({
      success: true,
      data: rows.map((row) => ({
        id: Number(row.id),
        fullName: row.name,
        phoneNumber: row.phone,
        email: row.email,
        role: row.display_role || row.role,
        roleLabel: JOB_ROLE_LABELS[row.display_role] || row.role,
        systemRole: row.role,
        status: row.status,
        age: row.age === null ? null : Number(row.age),
        dateOfBirth: row.date_of_birth,
        gender: row.gender,
        address: row.address,
        vehicleNumber: row.vehicle_number,
        vehicleType: row.vehicle_type,
        drivingLicenseNumber: row.driving_license_number,
        aadhaarNumber: row.aadhaar_number,
        bankAccountHolderName: row.bank_account_holder_name,
        bankName: row.bank_name,
        bankAccountNumber: row.bank_account_number,
        bankIfscCode: row.bank_ifsc_code,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error("getOwnerJobAssignmentUsers error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch job assignment users",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const createOwnerJobAssignmentUser = async (req, res) => {
  const connection = await db.getConnection();
  let transactionStarted = false;

  try {
    const {
      role,
      fullName,
      phoneNumber,
      email,
      age,
      dateOfBirth,
      gender,
      address,
      aadhaarNumber,
      bankAccountHolderName,
      bankName,
      bankAccountNumber,
      bankIfscCode,
      vehicleNumber,
      vehicleType,
      drivingLicenseNumber,
    } = req.body || {};

    const normalizedRole = String(role || "")
      .trim()
      .toUpperCase();
    const systemRole = JOB_ROLE_TO_SYSTEM_ROLE[normalizedRole];

    if (!systemRole) {
      return res.status(400).json({
        success: false,
        message: "A valid role is required",
      });
    }

    if (!fullName || !phoneNumber || !email) {
      return res.status(400).json({
        success: false,
        message: "fullName, phoneNumber and email are required",
      });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedPhone = String(phoneNumber).trim();

    if (!normalizedEmail) {
      return res.status(400).json({
        success: false,
        message: "email is required",
      });
    }

    const hashedDefaultPassword = await bcrypt.hash(
      DEFAULT_JOB_ASSIGNMENT_PASSWORD,
      10,
    );

    const [existingPhone] = await connection.query(
      `SELECT id FROM users WHERE phone = ? LIMIT 1`,
      [normalizedPhone],
    );

    if (existingPhone.length) {
      return res.status(400).json({
        success: false,
        message: "Phone number already exists",
      });
    }

    const [existingEmail] = await connection.query(
      `SELECT id FROM users WHERE email = ? LIMIT 1`,
      [normalizedEmail],
    );

    if (existingEmail.length) {
      return res.status(400).json({
        success: false,
        message: "Email already exists",
      });
    }

    await connection.beginTransaction();
    transactionStarted = true;

    const [profileTableRows] = await connection.query(
      `SHOW TABLES LIKE 'user_job_profiles'`,
    );
    const hasProfileTable = profileTableRows.length > 0;

    let userInsert;

    try {
      [userInsert] = await connection.query(
        `
        INSERT INTO users (
          name,
          email,
          phone,
          password,
          role,
          status,
          aadhaar_number,
          bank_account_holder_name,
          bank_name,
          bank_account_number,
          bank_ifsc_code,
          agency_id
        ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?)
        `,
        [
          String(fullName).trim(),
          normalizedEmail,
          normalizedPhone,
          hashedDefaultPassword,
          systemRole,
          aadhaarNumber ? String(aadhaarNumber).trim() : null,
          bankAccountHolderName ? String(bankAccountHolderName).trim() : null,
          bankName ? String(bankName).trim() : null,
          bankAccountNumber ? String(bankAccountNumber).trim() : null,
          bankIfscCode ? String(bankIfscCode).trim().toUpperCase() : null,
          req.user.agency_id,
        ],
      );
    } catch (insertError) {
      if (insertError?.code !== "ER_BAD_FIELD_ERROR") {
        throw insertError;
      }

      [userInsert] = await connection.query(
        `
        INSERT INTO users (
          name,
          email,
          phone,
          password,
          role,
          status,
          agency_id
        ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)
        `,
        [
          String(fullName).trim(),
          normalizedEmail,
          normalizedPhone,
          hashedDefaultPassword,
          systemRole,
          req.user.agency_id,
        ],
      );
    }

    const userId = Number(userInsert.insertId);

    if (hasProfileTable) {
      await connection.query(
        `
        INSERT INTO user_job_profiles (
          user_id,
          display_role,
          age,
          date_of_birth,
          gender,
          address,
          vehicle_number,
          vehicle_type,
          driving_license_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          userId,
          normalizedRole,
          age === undefined || age === null || age === "" ? null : Number(age),
          dateOfBirth || null,
          gender || null,
          address ? String(address).trim() : null,
          vehicleNumber ? String(vehicleNumber).trim() : null,
          vehicleType ? String(vehicleType).trim() : null,
          drivingLicenseNumber ? String(drivingLicenseNumber).trim() : null,
        ],
      );
    }

    if (normalizedRole === "DELIVERY_AGENT") {
      await connection.query(
        `
        INSERT INTO drivers (
          user_id,
          agency_id,
          vehicle_number,
          license_number,
          is_available,
          rating
        ) VALUES (?, ?, ?, ?, 1, 0.0)
        `,
        [
          userId,
          req.user.agency_id,
          vehicleNumber ? String(vehicleNumber).trim() : null,
          drivingLicenseNumber ? String(drivingLicenseNumber).trim() : null,
        ],
      );
    }

    if (address && String(address).trim()) {
      await connection.query(
        `
        INSERT INTO addresses (user_id, address, is_default)
        VALUES (?, ?, 1)
        `,
        [userId, String(address).trim()],
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "User created successfully",
      data: {
        id: userId,
        role: normalizedRole,
        systemRole,
      },
    });
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
    }
    console.error("createOwnerJobAssignmentUser error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create job assignment user",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const updateOwnerJobAssignmentUserStatus = async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const status = String(req.body.status || "").toUpperCase();

    if (!userId || Number.isNaN(userId)) {
      return res.status(400).json({
        success: false,
        message: "Valid user id is required",
      });
    }

    if (status !== "ACTIVE" && status !== "INACTIVE") {
      return res.status(400).json({
        success: false,
        message: "status must be either ACTIVE or INACTIVE",
      });
    }

    const [result] = await db.execute(
      `
      UPDATE users
      SET status = ?
      WHERE id = ?
        AND role IN ('GODOWN_MANAGER', 'PURCHASE_MANAGER', 'DRIVER', 'CASHIER', 'SUPPORT')
        AND agency_id = ?
      `,
      [status, userId, req.user.agency_id],
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "User status updated successfully",
      data: { id: userId, status },
    });
  } catch (error) {
    console.error("updateOwnerJobAssignmentUserStatus error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update user status",
      error: error.message,
    });
  }
};

export const updateOwnerJobAssignmentUser = async (req, res) => {
  const connection = await db.getConnection();
  let transactionStarted = false;

  try {
    const userId = Number(req.params.id);
    if (!userId || Number.isNaN(userId)) {
      return res
        .status(400)
        .json({ success: false, message: "Valid user id is required" });
    }

    const {
      fullName,
      phoneNumber,
      email,
      age,
      dateOfBirth,
      gender,
      address,
      vehicleNumber,
      vehicleType,
      drivingLicenseNumber,
      aadhaarNumber,
      bankAccountHolderName,
      bankName,
      bankAccountNumber,
      bankIfscCode,
    } = req.body;

    await connection.beginTransaction();
    transactionStarted = true;

    // Update users table (ignore null/undefined to keep existing data, or you can allow explicitly passing null to clear)
    // To handle updating, we check if the field is provided in the body. If undefined, we don't update.
    const updateUsersQuery = `
      UPDATE users 
      SET 
        name = COALESCE(?, name),
        phone = COALESCE(?, phone),
        email = COALESCE(?, email),
        aadhaar_number = COALESCE(?, aadhaar_number),
        bank_account_holder_name = COALESCE(?, bank_account_holder_name),
        bank_name = COALESCE(?, bank_name),
        bank_account_number = COALESCE(?, bank_account_number),
        bank_ifsc_code = COALESCE(?, bank_ifsc_code)
      WHERE id = ? AND agency_id = ?
    `;

    await connection.query(updateUsersQuery, [
      fullName !== undefined
        ? fullName
          ? String(fullName).trim()
          : null
        : null,
      phoneNumber !== undefined
        ? phoneNumber
          ? String(phoneNumber).trim()
          : null
        : null,
      email !== undefined
        ? email
          ? String(email).trim().toLowerCase()
          : null
        : null,
      aadhaarNumber !== undefined
        ? aadhaarNumber
          ? String(aadhaarNumber).trim()
          : null
        : null,
      bankAccountHolderName !== undefined
        ? bankAccountHolderName
          ? String(bankAccountHolderName).trim()
          : null
        : null,
      bankName !== undefined
        ? bankName
          ? String(bankName).trim()
          : null
        : null,
      bankAccountNumber !== undefined
        ? bankAccountNumber
          ? String(bankAccountNumber).trim()
          : null
        : null,
      bankIfscCode !== undefined
        ? bankIfscCode
          ? String(bankIfscCode).trim().toUpperCase()
          : null
        : null,
      userId,
      req.user.agency_id,
    ]);

    // Check if profile exists
    const [profileTableRows] = await connection.query(
      `SHOW TABLES LIKE 'user_job_profiles'`,
    );
    if (profileTableRows.length > 0) {
      const updateProfileQuery = `
        UPDATE user_job_profiles
        SET
          age = COALESCE(?, age),
          date_of_birth = COALESCE(?, date_of_birth),
          gender = COALESCE(?, gender),
          address = COALESCE(?, address),
          vehicle_number = COALESCE(?, vehicle_number),
          vehicle_type = COALESCE(?, vehicle_type),
          driving_license_number = COALESCE(?, driving_license_number)
        WHERE user_id = ?
      `;
      await connection.query(updateProfileQuery, [
        age !== undefined
          ? age === null || age === ""
            ? null
            : Number(age)
          : null,
        dateOfBirth !== undefined ? dateOfBirth || null : null,
        gender !== undefined ? gender || null : null,
        address !== undefined
          ? address
            ? String(address).trim()
            : null
          : null,
        vehicleNumber !== undefined
          ? vehicleNumber
            ? String(vehicleNumber).trim()
            : null
          : null,
        vehicleType !== undefined
          ? vehicleType
            ? String(vehicleType).trim()
            : null
          : null,
        drivingLicenseNumber !== undefined
          ? drivingLicenseNumber
            ? String(drivingLicenseNumber).trim()
            : null
          : null,
        userId,
      ]);
    }

    // Update address if exists
    if (address !== undefined) {
      const [addressRows] = await connection.query(
        `SELECT id FROM addresses WHERE user_id = ?`,
        [userId],
      );
      if (addressRows.length > 0) {
        await connection.query(
          `UPDATE addresses SET address = ? WHERE user_id = ?`,
          [String(address).trim(), userId],
        );
      } else {
        await connection.query(
          `INSERT INTO addresses (user_id, address, is_default) VALUES (?, ?, 1)`,
          [userId, String(address).trim()],
        );
      }
    }

    // Update drivers table if applicable
    const [driverRows] = await connection.query(
      `SELECT id FROM drivers WHERE user_id = ?`,
      [userId],
    );
    if (driverRows.length > 0) {
      await connection.query(
        `
        UPDATE drivers 
        SET 
          vehicle_number = COALESCE(?, vehicle_number),
          license_number = COALESCE(?, license_number)
        WHERE user_id = ?
      `,
        [
          vehicleNumber !== undefined
            ? vehicleNumber
              ? String(vehicleNumber).trim()
              : null
            : null,
          drivingLicenseNumber !== undefined
            ? drivingLicenseNumber
              ? String(drivingLicenseNumber).trim()
              : null
            : null,
          userId,
        ],
      );
    }

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "User details updated successfully",
    });
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
    }
    console.error("updateOwnerJobAssignmentUser error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update user",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const deleteOwnerJobAssignmentUser = async (req, res) => {
  const connection = await db.getConnection();
  let transactionStarted = false;

  try {
    const userId = Number(req.params.id);
    if (!userId || Number.isNaN(userId)) {
      return res
        .status(400)
        .json({ success: false, message: "Valid user id is required" });
    }

    await connection.beginTransaction();
    transactionStarted = true;

    // Delete related records
    const [profileTableRows] = await connection.query(
      `SHOW TABLES LIKE 'user_job_profiles'`,
    );
    if (profileTableRows.length > 0) {
      await connection.query(
        `DELETE FROM user_job_profiles WHERE user_id = ?`,
        [userId],
      );
    }

    await connection.query(`DELETE FROM drivers WHERE user_id = ?`, [userId]);
    await connection.query(`DELETE FROM addresses WHERE user_id = ?`, [userId]);

    const [result] = await connection.query(`DELETE FROM users WHERE id = ?`, [
      userId,
    ]);

    await connection.commit();

    if (!result.affectedRows) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "User deleted successfully",
    });
  } catch (error) {
    if (transactionStarted) {
      await connection.rollback();
    }
    console.error("deleteOwnerJobAssignmentUser error:", error);

    if (
      error.code === "ER_ROW_IS_REFERENCED_2" ||
      error.code === "ER_ROW_IS_REFERENCED"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot delete user because they have associated records (e.g., sales, payments, or stock transactions). Consider making them INACTIVE instead.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to delete user",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
