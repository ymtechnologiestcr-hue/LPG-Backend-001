import db from "../config/db.js";

/**
 * Cashier Reports Controller
 * Supports:
 *  1. Daily Sales Report (Domestic 5% GST & Commercial 18% GST with GST & Taxable breakdown)
 *  2. Total Collection Report (Cash, UPI, Online Sales, Office Sales, Customer Service, Other Receipts)
 *  3. Expenses Report (Driver Expense Requests & Office Expense Entries)
 *  4. Consolidated Cash Report (Opening Cash, Cash In, Cash Out, Closing Cash reconciliation)
 *  5. Closing Cash Report with Denomination (₹500, ₹200, ₹100, ₹50, ₹20, ₹10, ₹5, ₹2, ₹1, System vs Physical reconciliation, History)
 */

let closingColumnsExtended = false;

const ensureClosingColumnsExtended = async (executor = db) => {
  if (closingColumnsExtended) return;
  try {
    const [rows] = await executor.query(`
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'cashier_closings'
        AND COLUMN_NAME IN ('system_cash', 'cash_difference', 'cashier_name')
    `);
    const existing = new Set(rows.map((r) => String(r.COLUMN_NAME)));
    const needed = {
      system_cash: "ALTER TABLE cashier_closings ADD COLUMN system_cash DECIMAL(12,2) NULL AFTER denominations",
      cash_difference: "ALTER TABLE cashier_closings ADD COLUMN cash_difference DECIMAL(12,2) NULL AFTER system_cash",
      cashier_name: "ALTER TABLE cashier_closings ADD COLUMN cashier_name VARCHAR(100) NULL AFTER cash_difference",
    };
    for (const [col, ddl] of Object.entries(needed)) {
      if (!existing.has(col)) {
        try {
          await executor.query(ddl);
        } catch (err) {
          if (err?.code !== "ER_DUP_FIELDNAME") console.warn("Col add err:", err.message);
        }
      }
    }
    closingColumnsExtended = true;
  } catch (err) {
    console.warn("ensureClosingColumnsExtended error:", err.message);
  }
};

const getISTTodayStr = () => {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
};

const parseReportDateRange = (req) => {
  const { timeframe, startDate, endDate, date } = req.query;
  const todayStr = getISTTodayStr();

  if (date) {
    return {
      start: `${date} 00:00:00`,
      end: `${date} 23:59:59`,
      startDate: date,
      endDate: date,
      label: `Date: ${date}`,
      isSingleDay: true,
    };
  }

  if (startDate && endDate) {
    return {
      start: `${startDate} 00:00:00`,
      end: `${endDate} 23:59:59`,
      startDate,
      endDate,
      label: `${startDate} to ${endDate}`,
      isSingleDay: startDate === endDate,
    };
  }

  if (timeframe === "today" || timeframe === "day") {
    return {
      start: `${todayStr} 00:00:00`,
      end: `${todayStr} 23:59:59`,
      startDate: todayStr,
      endDate: todayStr,
      label: "Today",
      isSingleDay: true,
    };
  } else if (timeframe === "week") {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    const pastStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
    return {
      start: `${pastStr} 00:00:00`,
      end: `${todayStr} 23:59:59`,
      startDate: pastStr,
      endDate: todayStr,
      label: "Last 7 Days",
      isSingleDay: false,
    };
  } else if (timeframe === "month") {
    const now = new Date();
    const firstDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    return {
      start: `${firstDay} 00:00:00`,
      end: `${todayStr} 23:59:59`,
      startDate: firstDay,
      endDate: todayStr,
      label: "This Month",
      isSingleDay: false,
    };
  }

  return {
    start: `${todayStr} 00:00:00`,
    end: `${todayStr} 23:59:59`,
    startDate: todayStr,
    endDate: todayStr,
    label: "Today",
    isSingleDay: true,
  };
};

/**
 * 1. Daily Sales Report
 * Separate Domestic (5% GST) and Commercial (18% GST) Sales reports.
 */
export const getCashierDailySalesReport = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const agencyId = req.user?.agency_id || 1;
    const { start, end, startDate, endDate, label } = parseReportDateRange(req);
    const { driverId, productId, category } = req.query;

    let filterSql = "";
    const filterParams = [agencyId, start, end];

    if (driverId && driverId !== "ALL") {
      filterSql += " AND s.driver_id = ?";
      filterParams.push(Number(driverId));
    }
    if (productId && productId !== "ALL") {
      filterSql += " AND si.product_id = ?";
      filterParams.push(Number(productId));
    }

    const [rows] = await connection.query(
      `
      SELECT
        s.id AS sale_id,
        si.id AS item_id,
        DATE_FORMAT(CONVERT_TZ(s.created_at, '+00:00', '+05:30'), '%d/%m/%Y') AS voucher_date,
        CONCAT('VCH-', s.id) AS voucher_number,
        COALESCE(du.name, CASE WHEN s.sales_from = 'CASHIER' THEN 'Direct Office' ELSE 'Unassigned' END) AS delivery_boy_name,
        COALESCE(cu.name, 'Walk-in Customer') AS customer_name,
        cu.consumer_number,
        p.id AS product_id,
        p.name AS item_name,
        COALESCE(p.type, 'DOMESTIC') AS product_type,
        COALESCE(si.quantity, 1) AS total_quantity,
        COALESCE(si.price, p.price, 0) AS unit_rate,
        s.status,
        s.sales_from,
        s.payment_method
      FROM sales_items si
      INNER JOIN sales s ON s.id = si.sale_id
      INNER JOIN products p ON p.id = si.product_id
      LEFT JOIN users cu ON cu.id = s.customer_id
      LEFT JOIN drivers d ON d.id = s.driver_id
      LEFT JOIN users du ON du.id = d.user_id
      WHERE s.agency_id = ?
        AND s.created_at BETWEEN ? AND ?
        AND s.status IN ('DELIVERED', 'COMPLETED')
        ${filterSql}
      ORDER BY s.created_at DESC, si.id ASC
      `,
      filterParams
    );

    const domesticSales = [];
    const commercialSales = [];

    let domesticTotals = { totalQty: 0, totalTaxable: 0, totalCgst: 0, totalSgst: 0, totalAmount: 0 };
    let commercialTotals = { totalQty: 0, totalTaxable: 0, totalCgst: 0, totalSgst: 0, totalAmount: 0 };

    for (const r of rows) {
      const isCommercial = r.product_type === "COMMERCIAL";
      const qty = Number(r.total_quantity || 0);
      const rate = Number(r.unit_rate || 0);
      const totalSalesValue = rate * qty;

      if (isCommercial) {
        // Commercial 18% GST (CGST 9% + SGST 9%)
        // Taxable Value = Total sales value ÷ 1.18
        const taxableValue = Math.round((totalSalesValue / 1.18) * 100) / 100;
        const cgst = Math.round((taxableValue * 0.09) * 100) / 100;
        const sgst = Math.round((taxableValue * 0.09) * 100) / 100;
        const totalAmount = Math.round((taxableValue + cgst + sgst) * 100) / 100;

        const record = {
          date: r.voucher_date,
          voucherNumber: r.voucher_number,
          deliveryBoyName: r.delivery_boy_name,
          customerName: r.customer_name,
          consumerNumber: r.consumer_number || "-",
          category: "Commercial",
          itemName: r.item_name,
          totalQuantity: qty,
          rate: rate,
          taxableValue,
          cgst,
          sgst,
          totalAmount,
        };

        commercialSales.push(record);
        commercialTotals.totalQty += qty;
        commercialTotals.totalTaxable += taxableValue;
        commercialTotals.totalCgst += cgst;
        commercialTotals.totalSgst += sgst;
        commercialTotals.totalAmount += totalAmount;
      } else {
        // Domestic 5% GST (CGST 2.5% + SGST 2.5%)
        // Taxable Value = Total sales value ÷ 1.05
        const taxableValue = Math.round((totalSalesValue / 1.05) * 100) / 100;
        const cgst = Math.round((taxableValue * 0.025) * 100) / 100;
        const sgst = Math.round((taxableValue * 0.025) * 100) / 100;
        const totalAmount = Math.round((taxableValue + cgst + sgst) * 100) / 100;

        const record = {
          date: r.voucher_date,
          voucherNumber: r.voucher_number,
          deliveryBoyName: r.delivery_boy_name,
          category: "Domestic",
          itemName: r.item_name,
          totalQuantity: qty,
          rate: rate,
          taxableValue,
          cgst,
          sgst,
          totalAmount,
        };

        domesticSales.push(record);
        domesticTotals.totalQty += qty;
        domesticTotals.totalTaxable += taxableValue;
        domesticTotals.totalCgst += cgst;
        domesticTotals.totalSgst += sgst;
        domesticTotals.totalAmount += totalAmount;
      }
    }

    // Round totals
    domesticTotals = {
      totalQty: domesticTotals.totalQty,
      totalTaxable: Math.round(domesticTotals.totalTaxable * 100) / 100,
      totalCgst: Math.round(domesticTotals.totalCgst * 100) / 100,
      totalSgst: Math.round(domesticTotals.totalSgst * 100) / 100,
      totalAmount: Math.round(domesticTotals.totalAmount * 100) / 100,
    };

    commercialTotals = {
      totalQty: commercialTotals.totalQty,
      totalTaxable: Math.round(commercialTotals.totalTaxable * 100) / 100,
      totalCgst: Math.round(commercialTotals.totalCgst * 100) / 100,
      totalSgst: Math.round(commercialTotals.totalSgst * 100) / 100,
      totalAmount: Math.round(commercialTotals.totalAmount * 100) / 100,
    };

    // Filter metadata
    const [drivers] = await connection.query(
      `SELECT d.id, u.name FROM drivers d INNER JOIN users u ON u.id = d.user_id WHERE u.agency_id = ? ORDER BY u.name`,
      [agencyId]
    );
    const [products] = await connection.query(
      `SELECT id, name, type, price FROM products ORDER BY type DESC, name ASC`
    );

    return res.status(200).json({
      success: true,
      filter: {
        label,
        startDate,
        endDate,
      },
      metadata: {
        drivers,
        products,
      },
      data: {
        domestic: {
          items: domesticSales,
          totals: domesticTotals,
        },
        commercial: {
          items: commercialSales,
          totals: commercialTotals,
        },
        combinedSummary: {
          totalQuantity: domesticTotals.totalQty + commercialTotals.totalQty,
          totalTaxable: Math.round((domesticTotals.totalTaxable + commercialTotals.totalTaxable) * 100) / 100,
          totalGst: Math.round((domesticTotals.totalCgst + domesticTotals.totalSgst + commercialTotals.totalCgst + commercialTotals.totalSgst) * 100) / 100,
          totalAmount: Math.round((domesticTotals.totalAmount + commercialTotals.totalAmount) * 100) / 100,
        },
      },
    });
  } catch (error) {
    console.error("getCashierDailySalesReport error:", error);
    return res.status(500).json({ success: false, message: "Failed to generate daily sales report", error: error.message });
  } finally {
    connection.release();
  }
};

/**
 * 2. Total Collection Report
 * 6 separate collection reports: Cash, UPI, Online Sales, Office Sales, Customer Service, Other Receipts.
 */
export const getCashierTotalCollectionReport = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const agencyId = req.user?.agency_id || 1;
    const { start, end, startDate, endDate, label } = parseReportDateRange(req);

    // 1. Cash Collection Report (Driver-wise cash collected)
    const [cashRows] = await connection.query(
      `
      SELECT
        sh.id,
        DATE_FORMAT(CONVERT_TZ(COALESCE(sh.settled_at, sh.created_at), '+00:00', '+05:30'), '%d/%m/%Y') AS date,
        CONCAT('VCH-', COALESCE(sh.sale_id, sh.id)) AS voucher_number,
        COALESCE(du.name, 'Unknown Driver') AS driver_name,
        sh.amount AS cash_collection
      FROM settlement_history sh
      LEFT JOIN drivers d ON d.id = sh.driver_id
      LEFT JOIN users du ON du.id = d.user_id
      LEFT JOIN sales s ON s.id = sh.sale_id
      WHERE sh.agency_id = ?
        AND COALESCE(sh.settled_at, sh.created_at) BETWEEN ? AND ?
        AND sh.status = 'SETTLED'
        AND (s.payment_method = 'CASH' OR (s.payment_method IS NULL AND sh.method = 'CASH'))
      ORDER BY COALESCE(sh.settled_at, sh.created_at) DESC
      `,
      [agencyId, start, end]
    );

    // Driver-wise aggregation for cash
    const cashDriverSummary = {};
    let totalCashCollection = 0;
    const cashList = cashRows.map((r, idx) => {
      const amt = Number(r.cash_collection || 0);
      totalCashCollection += amt;
      cashDriverSummary[r.driver_name] = (cashDriverSummary[r.driver_name] || 0) + amt;
      return {
        slNo: idx + 1,
        date: r.date,
        voucherNumber: r.voucher_number,
        driverName: r.driver_name,
        cashCollection: amt,
        totalCashCollection: cashDriverSummary[r.driver_name],
      };
    });

    // 2. UPI Payment Collection Report (Driver-wise UPI collected)
    const [upiRows] = await connection.query(
      `
      SELECT
        sh.id,
        DATE_FORMAT(CONVERT_TZ(COALESCE(sh.settled_at, sh.created_at), '+00:00', '+05:30'), '%d/%m/%Y') AS date,
        CONCAT('VCH-', COALESCE(sh.sale_id, sh.id)) AS voucher_number,
        COALESCE(du.name, 'Unknown Driver') AS driver_name,
        sh.amount AS upi_collection
      FROM settlement_history sh
      LEFT JOIN drivers d ON d.id = sh.driver_id
      LEFT JOIN users du ON du.id = d.user_id
      LEFT JOIN sales s ON s.id = sh.sale_id
      WHERE sh.agency_id = ?
        AND COALESCE(sh.settled_at, sh.created_at) BETWEEN ? AND ?
        AND sh.status = 'SETTLED'
        AND (s.payment_method IN ('UPI', 'ONLINE') OR sh.method IN ('UPI', 'ONLINE', 'CARD'))
      ORDER BY COALESCE(sh.settled_at, sh.created_at) DESC
      `,
      [agencyId, start, end]
    );

    const upiDriverSummary = {};
    let totalUpiCollection = 0;
    const upiList = upiRows.map((r, idx) => {
      const amt = Number(r.upi_collection || 0);
      totalUpiCollection += amt;
      upiDriverSummary[r.driver_name] = (upiDriverSummary[r.driver_name] || 0) + amt;
      return {
        slNo: idx + 1,
        date: r.date,
        voucherNumber: r.voucher_number,
        driverName: r.driver_name,
        totalUpiCollection: amt,
      };
    });

    // 3. Online Sales Collection Report (Customer direct online payments)
    const [onlineRows] = await connection.query(
      `
      SELECT
        s.id,
        DATE_FORMAT(CONVERT_TZ(s.created_at, '+00:00', '+05:30'), '%d/%m/%Y') AS date,
        COALESCE(du.name, 'Direct Booking') AS driver_name,
        COALESCE(cu.name, 'Online Customer') AS customer_name,
        COALESCE(cu.consumer_number, '-') AS consumer_number,
        s.total_amount
      FROM sales s
      LEFT JOIN users cu ON cu.id = s.customer_id
      LEFT JOIN drivers d ON d.id = s.driver_id
      LEFT JOIN users du ON du.id = d.user_id
      WHERE s.agency_id = ?
        AND s.created_at BETWEEN ? AND ?
        AND (
          s.payment_method = 'ONLINE' OR
          EXISTS (SELECT 1 FROM payments pm WHERE pm.sale_id = s.id AND pm.type = 'COMPANY' AND pm.status = 'SUCCESS')
        )
      ORDER BY s.created_at DESC
      `,
      [agencyId, start, end]
    );

    let totalOnlineSales = 0;
    const onlineSalesList = onlineRows.map((r, idx) => {
      const amt = Number(r.total_amount || 0);
      totalOnlineSales += amt;
      return {
        slNo: idx + 1,
        date: r.date,
        driverName: r.driver_name,
        customerName: r.customer_name,
        consumerNumber: r.consumer_number,
        totalAmount: amt,
      };
    });

    // 4. Office Sales Report (Direct walk-in counter sales by Cashier)
    const [officeRows] = await connection.query(
      `
      SELECT
        s.id,
        DATE_FORMAT(CONVERT_TZ(s.created_at, '+00:00', '+05:30'), '%d/%m/%Y') AS date,
        CONCAT('VCH-', s.id) AS voucher_number,
        COALESCE(cu.name, 'Counter Customer') AS customer_name,
        COALESCE(cu.consumer_number, '-') AS consumer_number,
        COALESCE(p.name, 'LPG Cylinder') AS item_name,
        COALESCE(si.quantity, 1) AS quantity,
        COALESCE(p_sub.method, s.payment_method, 'CASH') AS payment_mode,
        COALESCE(si.price * si.quantity, s.total_amount) AS total_amount
      FROM sales s
      LEFT JOIN users cu ON cu.id = s.customer_id
      LEFT JOIN sales_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      LEFT JOIN payments p_sub ON p_sub.sale_id = s.id
      WHERE s.agency_id = ?
        AND s.created_at BETWEEN ? AND ?
        AND s.sales_from = 'CASHIER'
      ORDER BY s.created_at DESC
      `,
      [agencyId, start, end]
    );

    let totalOfficeSales = 0;
    const officeSalesList = officeRows.map((r, idx) => {
      const amt = Number(r.total_amount || 0);
      totalOfficeSales += amt;
      return {
        slNo: idx + 1,
        date: r.date,
        voucherNumber: r.voucher_number,
        customerName: r.customer_name,
        consumerNumber: r.consumer_number,
        itemName: r.item_name,
        quantity: Number(r.quantity || 1),
        paymentMode: r.payment_mode,
        totalAmount: amt,
      };
    });

    // 5. Customer Service Collection Report (PR Penalty, Name Change, New Connection)
    const [prPenalties] = await connection.query(
      `
      SELECT
        pr.id,
        DATE_FORMAT(CONVERT_TZ(COALESCE(pr.paid_at, pr.created_at), '+00:00', '+05:30'), '%d/%m/%Y') AS date,
        CONCAT('PR-', pr.id) AS voucher_number,
        COALESCE(pr.customer_name_snapshot, cu.name, 'Customer') AS customer_name,
        COALESCE(pr.consumer_number_snapshot, cu.consumer_number, '-') AS consumer_number,
        'PR Penalty' AS service_type,
        COALESCE(pr.payment_mode, 'CASH') AS payment_mode,
        pr.penalty_amount AS amount_received
      FROM customer_pr_penalties pr
      LEFT JOIN users cu ON cu.id = pr.customer_id
      WHERE pr.agency_id = ?
        AND pr.payment_status = 'PAID'
        AND COALESCE(pr.paid_at, pr.created_at) BETWEEN ? AND ?
      `,
      [agencyId, start, end]
    );

    const [nameChanges] = await connection.query(
      `
      SELECT
        nc.id,
        DATE_FORMAT(CONVERT_TZ(COALESCE(nc.approved_at, nc.created_at), '+00:00', '+05:30'), '%d/%m/%Y') AS date,
        CONCAT('NC-', nc.id) AS voucher_number,
        COALESCE(nc.new_name_requested, nc.old_name_snapshot, cu.name) AS customer_name,
        COALESCE(cu.consumer_number, '-') AS consumer_number,
        'Name Change' AS service_type,
        COALESCE(nc.payment_mode, 'CASH') AS payment_mode,
        nc.service_fee AS amount_received
      FROM customer_name_change_requests nc
      LEFT JOIN users cu ON cu.id = nc.customer_id
      WHERE nc.agency_id = ?
        AND nc.status = 'APPROVED'
        AND COALESCE(nc.approved_at, nc.created_at) BETWEEN ? AND ?
      `,
      [agencyId, start, end]
    );

    const [newConnections] = await connection.query(
      `
      SELECT
        cnc.id,
        DATE_FORMAT(CONVERT_TZ(COALESCE(cnc.paid_at, cnc.created_at), '+00:00', '+05:30'), '%d/%m/%Y') AS date,
        CONCAT('CONN-', cnc.id) AS voucher_number,
        COALESCE(cu.name, 'Customer') AS customer_name,
        COALESCE(cu.consumer_number, '-') AS consumer_number,
        'New Connection' AS service_type,
        COALESCE(cnc.payment_mode, 'CASH') AS payment_mode,
        cnc.total_amount AS amount_received
      FROM customer_new_connections cnc
      LEFT JOIN users cu ON cu.id = cnc.user_id
      WHERE cnc.agency_id = ?
        AND cnc.payment_status = 'PAID'
        AND COALESCE(cnc.paid_at, cnc.created_at) BETWEEN ? AND ?
      `,
      [agencyId, start, end]
    );

    const combinedCustomerService = [...prPenalties, ...nameChanges, ...newConnections];
    let totalCustomerService = 0;
    const customerServiceList = combinedCustomerService.map((r, idx) => {
      const amt = Number(r.amount_received || 0);
      totalCustomerService += amt;
      return {
        slNo: idx + 1,
        date: r.date,
        voucherNumber: r.voucher_number,
        customerName: r.customer_name,
        consumerNumber: r.consumer_number,
        serviceType: r.service_type,
        paymentMode: r.payment_mode,
        amountReceived: amt,
      };
    });

    // 6. Other Receipts Report (cashier_receipts: Advance, Due Collection, Other)
    const [receiptsRows] = await connection.query(
      `
      SELECT
        cr.id,
        DATE_FORMAT(CONVERT_TZ(cr.created_at, '+00:00', '+05:30'), '%d/%m/%Y') AS date,
        CONCAT('REC-', cr.id) AS voucher_number,
        COALESCE(u.name, 'Cashier Counter') AS received_from,
        COALESCE(cr.description, cr.receipt_type, 'General Receipt') AS receipt_description,
        COALESCE(cr.payment_mode, 'CASH') AS payment_mode,
        cr.amount AS amount_received
      FROM cashier_receipts cr
      LEFT JOIN users u ON u.id = cr.cashier_id
      WHERE cr.agency_id = ?
        AND cr.created_at BETWEEN ? AND ?
      ORDER BY cr.created_at DESC
      `,
      [agencyId, start, end]
    );

    let totalOtherReceipts = 0;
    const otherReceiptsList = receiptsRows.map((r, idx) => {
      const amt = Number(r.amount_received || 0);
      totalOtherReceipts += amt;
      return {
        slNo: idx + 1,
        date: r.date,
        voucherNumber: r.voucher_number,
        receivedFrom: r.received_from,
        receiptDescription: r.receipt_description,
        paymentMode: r.payment_mode,
        amountReceived: amt,
      };
    });

    return res.status(200).json({
      success: true,
      filter: {
        label,
        startDate,
        endDate,
      },
      data: {
        cashCollection: {
          items: cashList,
          totalAmount: Math.round(totalCashCollection * 100) / 100,
          driverSummary: cashDriverSummary,
        },
        upiCollection: {
          items: upiList,
          totalAmount: Math.round(totalUpiCollection * 100) / 100,
          driverSummary: upiDriverSummary,
        },
        onlineSales: {
          items: onlineSalesList,
          totalAmount: Math.round(totalOnlineSales * 100) / 100,
        },
        officeSales: {
          items: officeSalesList,
          totalAmount: Math.round(totalOfficeSales * 100) / 100,
        },
        customerService: {
          items: customerServiceList,
          totalAmount: Math.round(totalCustomerService * 100) / 100,
        },
        otherReceipts: {
          items: otherReceiptsList,
          totalAmount: Math.round(totalOtherReceipts * 100) / 100,
        },
        grandTotal: {
          physicalCash: Math.round(
            (totalCashCollection +
              officeSalesList.filter((x) => x.paymentMode === "CASH").reduce((s, x) => s + x.totalAmount, 0) +
              customerServiceList.filter((x) => x.paymentMode === "CASH").reduce((s, x) => s + x.amountReceived, 0) +
              otherReceiptsList.filter((x) => x.paymentMode === "CASH").reduce((s, x) => s + x.amountReceived, 0)) *
              100
          ) / 100,
          allCollections: Math.round(
            (totalCashCollection + totalUpiCollection + totalOnlineSales + totalOfficeSales + totalCustomerService + totalOtherReceipts) * 100
          ) / 100,
        },
      },
    });
  } catch (error) {
    console.error("getCashierTotalCollectionReport error:", error);
    return res.status(500).json({ success: false, message: "Failed to generate total collection report", error: error.message });
  } finally {
    connection.release();
  }
};

/**
 * 3. Expenses Report
 * Driver Expense Requests & Office Expense Entries
 */
export const getCashierExpensesReport = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const agencyId = req.user?.agency_id || 1;
    const { start, end, startDate, endDate, label } = parseReportDateRange(req);
    const { status } = req.query;

    let driverStatusFilter = "";
    const driverParams = [agencyId, start, end];
    if (status && status !== "ALL") {
      driverStatusFilter = " AND e.status = ?";
      driverParams.push(status);
    }

    // 1. Driver Expense Requests Report
    const [driverExpensesRows] = await connection.query(
      `
      SELECT
        e.id,
        DATE_FORMAT(CONVERT_TZ(e.created_at, '+00:00', '+05:30'), '%d/%m/%Y') AS date,
        CONCAT('EXP-', e.id) AS voucher_number,
        COALESCE(u.name, 'Driver') AS driver_name,
        COALESCE(e.category, 'General') AS expense_head,
        e.amount AS total_amount,
        COALESCE(e.description, '-') AS description,
        e.status AS approval_status,
        COALESCE(e.payment_mode, 'CASH') AS payment_mode
      FROM expenses e
      LEFT JOIN users u ON u.id = e.created_by
      WHERE e.agency_id = ?
        AND e.created_at BETWEEN ? AND ?
        ${driverStatusFilter}
      ORDER BY e.created_at DESC
      `,
      driverParams
    );

    let driverTotal = 0;
    let approvedDriverTotal = 0;
    const driverList = driverExpensesRows.map((r, idx) => {
      const amt = Number(r.total_amount || 0);
      driverTotal += amt;
      if (r.approval_status === "APPROVED") approvedDriverTotal += amt;
      return {
        slNo: idx + 1,
        date: r.date,
        voucherNumber: r.voucher_number,
        driverName: r.driver_name,
        expenseHead: r.expense_head,
        totalAmount: amt,
        description: r.description,
        approvalStatus: r.approval_status,
        paymentMode: r.payment_mode,
      };
    });

    // 2. Office Expense Entry Report
    const [officeExpensesRows] = await connection.query(
      `
      SELECT
        oe.id,
        DATE_FORMAT(CONVERT_TZ(oe.created_at, '+00:00', '+05:30'), '%d/%m/%Y') AS date,
        CONCAT('OFF-EXP-', oe.id) AS voucher_number,
        COALESCE(u.name, 'Office Admin / Cashier') AS payee_name,
        COALESCE(oe.category, 'General Office') AS expense_head,
        oe.amount AS total_amount,
        COALESCE(oe.description, '-') AS description,
        COALESCE(oe.payment_mode, 'CASH') AS payment_mode,
        COALESCE(oe.status, 'APPROVED') AS status
      FROM office_expenses oe
      LEFT JOIN users u ON u.id = oe.admin_id
      WHERE oe.agency_id = ?
        AND oe.created_at BETWEEN ? AND ?
      ORDER BY oe.created_at DESC
      `,
      [agencyId, start, end]
    );

    let officeTotal = 0;
    const officeList = officeExpensesRows.map((r, idx) => {
      const amt = Number(r.total_amount || 0);
      officeTotal += amt;
      return {
        slNo: idx + 1,
        date: r.date,
        voucherNumber: r.voucher_number,
        payeeName: r.payee_name,
        expenseHead: r.expense_head,
        totalAmount: amt,
        description: r.description,
        paymentMode: r.payment_mode,
        status: r.status,
      };
    });

    return res.status(200).json({
      success: true,
      filter: {
        label,
        startDate,
        endDate,
      },
      data: {
        driverExpenses: {
          items: driverList,
          totalAmount: Math.round(driverTotal * 100) / 100,
          approvedAmount: Math.round(approvedDriverTotal * 100) / 100,
        },
        officeExpenses: {
          items: officeList,
          totalAmount: Math.round(officeTotal * 100) / 100,
        },
        combinedSummary: {
          grandTotal: Math.round((driverTotal + officeTotal) * 100) / 100,
          totalApprovedExpenses: Math.round((approvedDriverTotal + officeTotal) * 100) / 100,
        },
      },
    });
  } catch (error) {
    console.error("getCashierExpensesReport error:", error);
    return res.status(500).json({ success: false, message: "Failed to generate expenses report", error: error.message });
  } finally {
    connection.release();
  }
};

/**
 * 4. Consolidated Cash Report
 * Reconciles Opening Cash, Total Cash In, Total Cash Out, and Closing Cash.
 */
export const getCashierConsolidatedCashReport = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const agencyId = req.user?.agency_id || 1;
    const { start, end, startDate, endDate, label, isSingleDay } = parseReportDateRange(req);

    // Opening Cash Balance
    // Read from cashier_closings prior to startDate, or cashier_openings on/before startDate
    const [priorClosing] = await connection.query(
      `
      SELECT total_cash, petty_cash, created_at
      FROM cashier_closings
      WHERE agency_id = ? AND DATE(created_at) < ?
      ORDER BY id DESC LIMIT 1
      `,
      [agencyId, startDate]
    );

    let openingCashBalance = 0;
    if (priorClosing.length > 0) {
      openingCashBalance = Number(priorClosing[0].petty_cash ?? priorClosing[0].total_cash ?? 0);
    } else {
      // Check first opening record
      const [firstOpening] = await connection.query(
        `
        SELECT opening_amount
        FROM cashier_openings
        WHERE agency_id = ? AND DATE(started_at) <= ?
        ORDER BY id DESC LIMIT 1
        `,
        [agencyId, startDate]
      );
      if (firstOpening.length > 0) {
        openingCashBalance = Number(firstOpening[0].opening_amount || 0);
      }
    }

    // Cash In Streams (Physical Cash ONLY - UPI/Online strictly excluded)
    // 1. Driver Collections Cash (SETTLED)
    const [driverCashIn] = await connection.query(
      `
      SELECT COALESCE(SUM(sh.amount), 0) AS total, COUNT(*) AS count
      FROM settlement_history sh
      LEFT JOIN sales s ON s.id = sh.sale_id
      WHERE sh.agency_id = ?
        AND COALESCE(sh.settled_at, sh.created_at) BETWEEN ? AND ?
        AND sh.status = 'SETTLED'
        AND (s.payment_method = 'CASH' OR (s.payment_method IS NULL AND sh.method = 'CASH'))
      `,
      [agencyId, start, end]
    );

    // 2. Office Sales Cash
    const [officeCashIn] = await connection.query(
      `
      SELECT COALESCE(SUM(p.amount), 0) AS total, COUNT(*) AS count
      FROM payments p
      INNER JOIN sales s ON s.id = p.sale_id
      WHERE p.status = 'SUCCESS'
        AND s.sales_from = 'CASHIER'
        AND s.agency_id = ?
        AND p.method = 'CASH'
        AND p.created_at BETWEEN ? AND ?
      `,
      [agencyId, start, end]
    );

    // 3. Customer Service Cash (PR, Name Change, New Connection)
    const [prCashIn] = await connection.query(
      `
      SELECT COALESCE(SUM(penalty_amount), 0) AS total, COUNT(*) AS count
      FROM customer_pr_penalties
      WHERE agency_id = ? AND payment_status = 'PAID' AND payment_mode = 'CASH'
        AND COALESCE(paid_at, created_at) BETWEEN ? AND ?
      `,
      [agencyId, start, end]
    );

    const [ncCashIn] = await connection.query(
      `
      SELECT COALESCE(SUM(service_fee), 0) AS total, COUNT(*) AS count
      FROM customer_name_change_requests
      WHERE agency_id = ? AND status = 'APPROVED' AND payment_mode = 'CASH'
        AND COALESCE(approved_at, created_at) BETWEEN ? AND ?
      `,
      [agencyId, start, end]
    );

    const [connCashIn] = await connection.query(
      `
      SELECT COALESCE(SUM(total_amount), 0) AS total, COUNT(*) AS count
      FROM customer_new_connections
      WHERE agency_id = ? AND payment_status = 'PAID' AND payment_mode = 'CASH'
        AND COALESCE(paid_at, created_at) BETWEEN ? AND ?
      `,
      [agencyId, start, end]
    );

    // 4. Other Cash Receipts
    const [otherCashIn] = await connection.query(
      `
      SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
      FROM cashier_receipts
      WHERE agency_id = ? AND payment_mode = 'CASH'
        AND created_at BETWEEN ? AND ?
      `,
      [agencyId, start, end]
    );

    const cashInBreakdown = {
      driverCollectionsCash: Number(driverCashIn[0]?.total || 0),
      driverCollectionsCount: Number(driverCashIn[0]?.count || 0),
      officeSalesCash: Number(officeCashIn[0]?.total || 0),
      officeSalesCount: Number(officeCashIn[0]?.count || 0),
      prPenaltiesCash: Number(prCashIn[0]?.total || 0),
      nameChangesCash: Number(ncCashIn[0]?.total || 0),
      newConnectionsCash: Number(connCashIn[0]?.total || 0),
      customerServiceCash:
        Number(prCashIn[0]?.total || 0) + Number(ncCashIn[0]?.total || 0) + Number(connCashIn[0]?.total || 0),
      otherReceiptsCash: Number(otherCashIn[0]?.total || 0),
    };

    const totalCashIn =
      cashInBreakdown.driverCollectionsCash +
      cashInBreakdown.officeSalesCash +
      cashInBreakdown.customerServiceCash +
      cashInBreakdown.otherReceiptsCash;

    // Cash Out Streams (Physical Cash Expenses ONLY)
    // 1. Approved Driver Expenses (CASH)
    const [driverCashOut] = await connection.query(
      `
      SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
      FROM expenses
      WHERE agency_id = ? AND status = 'APPROVED'
        AND (payment_mode = 'CASH' OR payment_mode IS NULL)
        AND created_at BETWEEN ? AND ?
      `,
      [agencyId, start, end]
    );

    // 2. Approved Office Expenses (CASH)
    const [officeCashOut] = await connection.query(
      `
      SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
      FROM office_expenses
      WHERE agency_id = ?
        AND (payment_mode = 'CASH' OR payment_mode IS NULL)
        AND (status = 'APPROVED' OR status IS NULL)
        AND created_at BETWEEN ? AND ?
      `,
      [agencyId, start, end]
    );

    // 3. Customer Connection Transfers Payouts (CASH)
    const [transferCashOut] = await connection.query(
      `
      SELECT COALESCE(SUM(deposit_liability), 0) AS total, COUNT(*) AS count
      FROM customer_connection_transfers
      WHERE agency_id = ? AND status = 'APPROVED'
        AND (payment_mode = 'CASH' OR payment_mode IS NULL)
        AND updated_at BETWEEN ? AND ?
      `,
      [agencyId, start, end]
    );

    const cashOutBreakdown = {
      driverExpensesCash: Number(driverCashOut[0]?.total || 0),
      driverExpensesCount: Number(driverCashOut[0]?.count || 0),
      officeExpensesCash: Number(officeCashOut[0]?.total || 0),
      officeExpensesCount: Number(officeCashOut[0]?.count || 0),
      transferRefundsCash: Number(transferCashOut[0]?.total || 0),
      transferRefundsCount: Number(transferCashOut[0]?.count || 0),
    };

    const totalCashOut =
      cashOutBreakdown.driverExpensesCash +
      cashOutBreakdown.officeExpensesCash +
      cashOutBreakdown.transferRefundsCash;

    const closingCashBalance = Math.round((openingCashBalance + totalCashIn - totalCashOut) * 100) / 100;

    return res.status(200).json({
      success: true,
      filter: {
        label,
        startDate,
        endDate,
        isSingleDay,
      },
      data: {
        statement: [
          { slNo: 1, particulars: "Opening Cash Balance", amount: Math.round(openingCashBalance * 100) / 100, isHighlight: true },
          { slNo: 2, particulars: "Add: Total Cash In", amount: Math.round(totalCashIn * 100) / 100, isAdd: true },
          { slNo: 3, particulars: "Less: Total Cash Out", amount: Math.round(totalCashOut * 100) / 100, isSubtract: true },
          { slNo: 4, particulars: "Closing Cash Balance", amount: closingCashBalance, isTotal: true },
        ],
        openingCashBalance: Math.round(openingCashBalance * 100) / 100,
        totalCashIn: Math.round(totalCashIn * 100) / 100,
        totalCashOut: Math.round(totalCashOut * 100) / 100,
        closingCashBalance,
        cashInBreakdown,
        cashOutBreakdown,
        formula: "Closing Cash = Opening Cash + Cash In - Cash Out",
        notes: "Strictly reconciles physical cash only. All UPI, cards, and online collections are excluded from physical drawer balance.",
      },
    });
  } catch (error) {
    console.error("getCashierConsolidatedCashReport error:", error);
    return res.status(500).json({ success: false, message: "Failed to generate consolidated cash report", error: error.message });
  } finally {
    connection.release();
  }
};

/**
 * 5. Closing Cash Report with Denomination
 * - Denominations: ₹500, ₹200, ₹100, ₹50, ₹20, ₹10, ₹5, ₹2, ₹1
 * - Compares physical cash against system closing cash
 * - Date-wise closing history
 */
export const getCashierClosingCashReport = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const agencyId = req.user?.agency_id || 1;
    await ensureClosingColumnsExtended(connection);

    const todayStr = getISTTodayStr();
    const targetDate = req.query.date || todayStr;

    // Fetch consolidated cash for target date to get system closing cash
    // We can simulate consolidated calculation for single day
    const [priorClosing] = await connection.query(
      `
      SELECT total_cash, petty_cash FROM cashier_closings
      WHERE agency_id = ? AND DATE(created_at) < ?
      ORDER BY id DESC LIMIT 1
      `,
      [agencyId, targetDate]
    );

    let openingCash = 0;
    if (priorClosing.length > 0) {
      openingCash = Number(priorClosing[0].petty_cash ?? priorClosing[0].total_cash ?? 0);
    } else {
      const [openRows] = await connection.query(
        `SELECT opening_amount FROM cashier_openings WHERE agency_id = ? AND DATE(started_at) <= ? ORDER BY id DESC LIMIT 1`,
        [agencyId, targetDate]
      );
      if (openRows.length > 0) openingCash = Number(openRows[0].opening_amount || 0);
    }

    const start = `${targetDate} 00:00:00`;
    const end = `${targetDate} 23:59:59`;

    // Cash In for target date
    const [cashInRes] = await connection.query(
      `
      SELECT
        (
          SELECT COALESCE(SUM(sh.amount), 0)
          FROM settlement_history sh
          LEFT JOIN sales s ON s.id = sh.sale_id
          WHERE sh.agency_id = ? AND COALESCE(sh.settled_at, sh.created_at) BETWEEN ? AND ?
            AND sh.status = 'SETTLED'
            AND (s.payment_method = 'CASH' OR (s.payment_method IS NULL AND sh.method = 'CASH'))
        ) AS driver_cash,
        (
          SELECT COALESCE(SUM(p.amount), 0)
          FROM payments p
          INNER JOIN sales s ON s.id = p.sale_id
          WHERE p.status = 'SUCCESS' AND s.sales_from = 'CASHIER' AND s.agency_id = ?
            AND p.method = 'CASH' AND p.created_at BETWEEN ? AND ?
        ) AS office_cash,
        (
          SELECT COALESCE(SUM(penalty_amount), 0)
          FROM customer_pr_penalties
          WHERE agency_id = ? AND payment_status = 'PAID' AND payment_mode = 'CASH'
            AND COALESCE(paid_at, created_at) BETWEEN ? AND ?
        ) AS pr_cash,
        (
          SELECT COALESCE(SUM(service_fee), 0)
          FROM customer_name_change_requests
          WHERE agency_id = ? AND status = 'APPROVED' AND payment_mode = 'CASH'
            AND COALESCE(approved_at, created_at) BETWEEN ? AND ?
        ) AS nc_cash,
        (
          SELECT COALESCE(SUM(total_amount), 0)
          FROM customer_new_connections
          WHERE agency_id = ? AND payment_status = 'PAID' AND payment_mode = 'CASH'
            AND COALESCE(paid_at, created_at) BETWEEN ? AND ?
        ) AS conn_cash,
        (
          SELECT COALESCE(SUM(amount), 0)
          FROM cashier_receipts
          WHERE agency_id = ? AND payment_mode = 'CASH' AND created_at BETWEEN ? AND ?
        ) AS other_cash
      `,
      [agencyId, start, end, agencyId, start, end, agencyId, start, end, agencyId, start, end, agencyId, start, end, agencyId, start, end]
    );

    const r = cashInRes[0] || {};
    const totalCashIn =
      Number(r.driver_cash || 0) +
      Number(r.office_cash || 0) +
      Number(r.pr_cash || 0) +
      Number(r.nc_cash || 0) +
      Number(r.conn_cash || 0) +
      Number(r.other_cash || 0);

    // Cash Out for target date
    const [cashOutRes] = await connection.query(
      `
      SELECT
        (
          SELECT COALESCE(SUM(amount), 0)
          FROM expenses
          WHERE agency_id = ? AND status = 'APPROVED'
            AND (payment_mode = 'CASH' OR payment_mode IS NULL)
            AND created_at BETWEEN ? AND ?
        ) AS driver_exp,
        (
          SELECT COALESCE(SUM(amount), 0)
          FROM office_expenses
          WHERE agency_id = ?
            AND (payment_mode = 'CASH' OR payment_mode IS NULL)
            AND (status = 'APPROVED' OR status IS NULL)
            AND created_at BETWEEN ? AND ?
        ) AS office_exp,
        (
          SELECT COALESCE(SUM(deposit_liability), 0)
          FROM customer_connection_transfers
          WHERE agency_id = ? AND status = 'APPROVED'
            AND (payment_mode = 'CASH' OR payment_mode IS NULL)
            AND updated_at BETWEEN ? AND ?
        ) AS transfer_payout
      `,
      [agencyId, start, end, agencyId, start, end, agencyId, start, end]
    );

    const o = cashOutRes[0] || {};
    const totalCashOut =
      Number(o.driver_exp || 0) +
      Number(o.office_exp || 0) +
      Number(o.transfer_payout || 0);

    const systemClosingCash = Math.round((openingCash + totalCashIn - totalCashOut) * 100) / 100;

    // Check if there is already a closing entry for target date
    const [dayClosings] = await connection.query(
      `
      SELECT *
      FROM cashier_closings
      WHERE agency_id = ? AND DATE(created_at) = ?
      ORDER BY id DESC LIMIT 1
      `,
      [agencyId, targetDate]
    );

    const existingClosing = dayClosings[0] || null;

    // Date-wise closing history (past 30 closings)
    const [historyRows] = await connection.query(
      `
      SELECT
        id,
        DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '+05:30'), '%d/%m/%Y') AS closing_date,
        DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '+05:30'), '%h:%i %p') AS closing_time,
        total_cash AS physical_cash,
        petty_cash,
        COALESCE(system_cash, 0) AS system_cash,
        COALESCE(cash_difference, 0) AS cash_difference,
        difference_reason,
        reason_disposition,
        note,
        COALESCE(cashier_name, 'Cashier') AS cashier_name,
        denominations,
        created_at
      FROM cashier_closings
      WHERE agency_id = ?
      ORDER BY id DESC
      LIMIT 30
      `,
      [agencyId]
    );

    const standardDenominations = [
      { label: "₹500", value: 500, count: 0, subtotal: 0 },
      { label: "₹200", value: 200, count: 0, subtotal: 0 },
      { label: "₹100", value: 100, count: 0, subtotal: 0 },
      { label: "₹50", value: 50, count: 0, subtotal: 0 },
      { label: "₹20", value: 20, count: 0, subtotal: 0 },
      { label: "₹10", value: 10, count: 0, subtotal: 0 },
      { label: "₹5", value: 5, count: 0, subtotal: 0 },
      { label: "₹2", value: 2, count: 0, subtotal: 0 },
      { label: "₹1", value: 1, count: 0, subtotal: 0 },
    ];

    let prefillDenominations = standardDenominations;
    if (existingClosing && existingClosing.denominations) {
      try {
        const saved = Array.isArray(existingClosing.denominations)
          ? existingClosing.denominations
          : JSON.parse(existingClosing.denominations);
        if (Array.isArray(saved)) {
          prefillDenominations = standardDenominations.map((def) => {
            const found = saved.find((s) => s.value === def.value || s.label === def.label);
            return found
              ? { ...def, count: found.count || 0, subtotal: (found.count || 0) * def.value }
              : def;
          });
        }
      } catch (e) {
        console.warn("Parse saved denominations error:", e);
      }
    }

    return res.status(200).json({
      success: true,
      targetDate,
      systemClosingSummary: {
        openingCashBalance: Math.round(openingCash * 100) / 100,
        totalCashIn: Math.round(totalCashIn * 100) / 100,
        totalCashOut: Math.round(totalCashOut * 100) / 100,
        systemClosingCashBalance: systemClosingCash,
      },
      existingClosing: existingClosing
        ? {
            id: existingClosing.id,
            totalCash: Number(existingClosing.total_cash || 0),
            pettyCash: Number(existingClosing.petty_cash || 0),
            differenceReason: existingClosing.difference_reason,
            reasonDisposition: existingClosing.reason_disposition,
            note: existingClosing.note,
            cashierName: existingClosing.cashier_name,
            systemCash: Number(existingClosing.system_cash || 0),
            difference: Number(existingClosing.cash_difference || 0),
          }
        : null,
      standardDenominations: prefillDenominations,
      closingHistory: historyRows.map((h) => ({
        id: h.id,
        date: h.closing_date,
        time: h.closing_time,
        physicalCash: Number(h.physical_cash || 0),
        pettyCash: Number(h.petty_cash || 0),
        systemCash: Number(h.system_cash || 0),
        difference: Number(h.cash_difference || 0),
        remarks: h.difference_reason || h.note || "-",
        disposition: h.reason_disposition || "Hand over to Owner",
        cashierName: h.cashier_name,
        denominations: Array.isArray(h.denominations) ? h.denominations : (function() {
          try { return JSON.parse(h.denominations); } catch { return []; }
        })(),
      })),
    });
  } catch (error) {
    console.error("getCashierClosingCashReport error:", error);
    return res.status(500).json({ success: false, message: "Failed to generate closing cash report", error: error.message });
  } finally {
    connection.release();
  }
};

/**
 * Submit / Save Closing Cash Denomination Report
 */
export const submitCashierClosingCashReport = async (req, res) => {
  const connection = await db.getConnection();
  try {
    const agencyId = req.user?.agency_id || 1;
    await ensureClosingColumnsExtended(connection);

    const {
      closingDate,
      denominations,
      totalPhysicalCash,
      systemClosingCash,
      cashDifference,
      differenceReason,
      reasonDisposition,
      note,
      cashierName,
      pettyCash = 0,
    } = req.body;

    if (!denominations || totalPhysicalCash === undefined) {
      return res.status(400).json({ success: false, message: "Denominations and physical cash total are required" });
    }

    const physicalAmount = Number(totalPhysicalCash || 0);
    const systemAmount = Number(systemClosingCash || 0);
    const diff = Number(cashDifference ?? (physicalAmount - systemAmount));
    const pettyAmount = Number(pettyCash || 0);
    const cashier = cashierName || req.user?.name || "Cashier";

    await connection.beginTransaction();

    const [result] = await connection.execute(
      `
      INSERT INTO cashier_closings (
        agency_id,
        total_cash,
        petty_cash,
        difference_reason,
        reason_disposition,
        note,
        denominations,
        system_cash,
        cash_difference,
        cashier_name
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        agencyId,
        physicalAmount,
        pettyAmount,
        differenceReason || null,
        reasonDisposition || "Hand over to Owner",
        note || null,
        JSON.stringify(denominations),
        systemAmount,
        diff,
        cashier,
      ]
    );

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "Closing cash report submitted and audited successfully",
      closingId: result.insertId,
      data: {
        closingId: result.insertId,
        physicalAmount,
        systemAmount,
        cashDifference: diff,
        cashier,
        pettyCash: pettyAmount,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("submitCashierClosingCashReport error:", error);
    return res.status(500).json({ success: false, message: "Failed to submit closing cash report", error: error.message });
  } finally {
    connection.release();
  }
};
