import db from "../config/db.js";

const getDateRange = (req) => {
  const { timeframe, startDate, endDate } = req.query;
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  if (timeframe === "day") {
    return { start: `${todayStr} 00:00:00`, end: `${todayStr} 23:59:59`, label: "Today" };
  } else if (timeframe === "week") {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    return { start: `${d.toISOString().slice(0, 10)} 00:00:00`, end: `${todayStr} 23:59:59`, label: "This Week" };
  } else if (timeframe === "month") {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start: `${d.toISOString().slice(0, 10)} 00:00:00`, end: `${todayStr} 23:59:59`, label: "This Month" };
  } else if (startDate && endDate) {
    return { start: `${startDate} 00:00:00`, end: `${endDate} 23:59:59`, label: `${startDate} to ${endDate}` };
  }
  return { start: `${todayStr} 00:00:00`, end: `${todayStr} 23:59:59`, label: "Today" };
};

export const getSalesReport = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const agencyId = req.user?.agency_id || 1;
    const { start, end, label } = getDateRange(req);

    // Summary metrics
    const [summaryRows] = await connection.query(
      `
      SELECT
        COALESCE(SUM(si.quantity), 0) AS total_cylinders,
        COALESCE(SUM(s.total_amount), 0) AS total_amount,
        COALESCE(SUM(CASE WHEN s.payment_method = 'ONLINE' OR pm.type = 'COMPANY' THEN s.total_amount ELSE 0 END), 0) AS direct_amount,
        COALESCE(SUM(CASE WHEN s.payment_method = 'CASH' OR pm.type = 'DRIVER' THEN s.total_amount ELSE 0 END), 0) AS indirect_amount
      FROM sales s
      LEFT JOIN sales_items si ON si.sale_id = s.id
      LEFT JOIN payments pm ON pm.sale_id = s.id
      WHERE s.agency_id = ?
        AND s.created_at BETWEEN ? AND ?
        AND s.status = 'DELIVERED'
      `,
      [agencyId, start, end]
    );

    // Product item breakdown
    const [productBreakdown] = await connection.query(
      `
      SELECT
        p.name AS product_name,
        p.type AS product_type,
        COALESCE(SUM(si.quantity), 0) AS quantity,
        COALESCE(SUM(si.quantity * si.price), 0) AS total_revenue
      FROM sales_items si
      INNER JOIN sales s ON s.id = si.sale_id
      INNER JOIN products p ON p.id = si.product_id
      WHERE s.agency_id = ?
        AND s.created_at BETWEEN ? AND ?
        AND s.status = 'DELIVERED'
      GROUP BY p.id, p.name, p.type
      ORDER BY quantity DESC
      `,
      [agencyId, start, end]
    );

    // Detailed transactions
    const [salesList] = await connection.query(
      `
      SELECT
        s.id,
        DATE_FORMAT(CONVERT_TZ(s.created_at, '+00:00', '+05:30'), '%d/%m/%Y, %H:%i') AS date_formatted,
        u.name AS customer_name,
        u.consumer_number,
        du.name AS driver_name,
        s.payment_method,
        CASE
          WHEN s.payment_method = 'ONLINE' THEN 'Direct'
          WHEN EXISTS (SELECT 1 FROM payments pm WHERE pm.sale_id = s.id AND pm.type = 'COMPANY') THEN 'Direct'
          ELSE 'Indirect'
        END AS settlement,
        s.total_amount,
        (
          SELECT COALESCE(GROUP_CONCAT(CONCAT(p.name, ' (x', si.quantity, ')') SEPARATOR ', '), '14.2 KG Domestic')
          FROM sales_items si
          INNER JOIN products p ON p.id = si.product_id
          WHERE si.sale_id = s.id
        ) AS items,
        (SELECT COALESCE(SUM(quantity), 1) FROM sales_items WHERE sale_id = s.id) AS total_qty,
        s.status
      FROM sales s
      LEFT JOIN users u ON u.id = s.customer_id
      LEFT JOIN drivers d ON d.id = s.driver_id
      LEFT JOIN users du ON du.id = d.user_id
      WHERE s.agency_id = ?
        AND s.created_at BETWEEN ? AND ?
      ORDER BY s.created_at DESC
      LIMIT 100
      `,
      [agencyId, start, end]
    );

    return res.status(200).json({
      success: true,
      data: {
        filter: label,
        summary: summaryRows[0] || {},
        productBreakdown,
        salesList,
      },
    });
  } catch (error) {
    console.error("getSalesReport error:", error);
    return res.status(500).json({ success: false, message: "Failed to generate sales report" });
  } finally {
    connection.release();
  }
};

export const getCustomerMovementReport = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const agencyId = req.user?.agency_id || 1;
    const { start, end, label } = getDateRange(req);

    // New Connections in period
    const [newConnections] = await connection.query(
      `
      SELECT
        cnc.id,
        DATE_FORMAT(CONVERT_TZ(cnc.created_at, '+00:00', '+05:30'), '%d/%m/%Y, %H:%i') AS date_formatted,
        u.name AS customer_name,
        u.phone,
        u.consumer_number,
        cnc.product_details,
        cnc.total_amount,
        cnc.payment_status
      FROM customer_new_connections cnc
      INNER JOIN users u ON u.id = cnc.user_id
      WHERE cnc.agency_id = ?
        AND cnc.created_at BETWEEN ? AND ?
      ORDER BY cnc.created_at DESC
      LIMIT 100
      `,
      [agencyId, start, end]
    );

    // Customer Transfers in period
    const [transfers] = await connection.query(
      `
      SELECT
        t.id,
        DATE_FORMAT(CONVERT_TZ(t.created_at, '+00:00', '+05:30'), '%d/%m/%Y, %H:%i') AS date_formatted,
        old_u.name AS old_customer_name,
        old_u.consumer_number,
        COALESCE(cta.agency_name, t.reason) AS new_agency_name,
        t.deposit_liability,
        t.reason,
        t.status
      FROM customer_connection_transfers t
      INNER JOIN users old_u ON old_u.id = t.existing_customer_id
      LEFT JOIN customer_transfer_agencies cta ON cta.transfer_id = t.id
      WHERE t.agency_id = ?
        AND t.created_at BETWEEN ? AND ?
      ORDER BY t.created_at DESC
      LIMIT 100
      `,
      [agencyId, start, end]
    );

    // Name Changes in period
    const [nameChanges] = await connection.query(
      `
      SELECT
        nc.id,
        DATE_FORMAT(CONVERT_TZ(nc.created_at, '+00:00', '+05:30'), '%d/%m/%Y, %H:%i') AS date_formatted,
        u.consumer_number,
        nc.old_name_snapshot,
        nc.new_name_requested,
        nc.service_fee,
        nc.status
      FROM customer_name_change_requests nc
      INNER JOIN users u ON u.id = nc.customer_id
      WHERE nc.agency_id = ?
        AND nc.created_at BETWEEN ? AND ?
      ORDER BY nc.created_at DESC
      LIMIT 100
      `,
      [agencyId, start, end]
    );

    return res.status(200).json({
      success: true,
      data: {
        filter: label,
        summary: {
          newConnectionsCount: newConnections.length,
          transfersCount: transfers.length,
          nameChangesCount: nameChanges.length,
          totalMovementCount: newConnections.length + transfers.length + nameChanges.length,
        },
        newConnections,
        transfers,
        nameChanges,
      },
    });
  } catch (error) {
    console.error("getCustomerMovementReport error:", error);
    return res.status(500).json({ success: false, message: "Failed to generate customer movement report" });
  } finally {
    connection.release();
  }
};

export const getComplaintsReport = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const agencyId = req.user?.agency_id || 1;
    const { start, end, label } = getDateRange(req);

    // Category breakdown
    const [categories] = await connection.query(
      `
      SELECT
        c.category,
        COUNT(*) AS count
      FROM customer_complaints c
      WHERE c.agency_id = ?
        AND c.created_at BETWEEN ? AND ?
      GROUP BY c.category
      ORDER BY count DESC
      `,
      [agencyId, start, end]
    );

    // Status metrics
    const [statusMetrics] = await connection.query(
      `
      SELECT
        COUNT(*) AS total,
        COUNT(CASE WHEN status = 'RESOLVED' THEN 1 END) AS resolved,
        COUNT(CASE WHEN status = 'PENDING' THEN 1 END) AS pending,
        COUNT(CASE WHEN status = 'IN_PROGRESS' THEN 1 END) AS in_progress,
        COUNT(CASE WHEN category = 'Leakage' OR priority = 'HIGH' THEN 1 END) AS urgent
      FROM customer_complaints
      WHERE agency_id = ?
        AND created_at BETWEEN ? AND ?
      `,
      [agencyId, start, end]
    );

    // Detailed complaints list
    const [complaintsList] = await connection.query(
      `
      SELECT
        c.id,
        c.complaint_number,
        DATE_FORMAT(CONVERT_TZ(c.created_at, '+00:00', '+05:30'), '%d/%m/%Y, %H:%i') AS date_formatted,
        u.name AS customer_name,
        u.phone AS customer_phone,
        u.consumer_number,
        c.category,
        c.description,
        c.priority,
        c.status,
        du.name AS assigned_driver
      FROM customer_complaints c
      LEFT JOIN users u ON u.id = c.customer_id
      LEFT JOIN drivers d ON d.id = c.assigned_driver_id
      LEFT JOIN users du ON du.id = d.user_id
      WHERE c.agency_id = ?
        AND c.created_at BETWEEN ? AND ?
      ORDER BY c.created_at DESC
      LIMIT 100
      `,
      [agencyId, start, end]
    );

    return res.status(200).json({
      success: true,
      data: {
        filter: label,
        summary: statusMetrics[0] || {},
        categories,
        complaintsList,
      },
    });
  } catch (error) {
    console.error("getComplaintsReport error:", error);
    return res.status(500).json({ success: false, message: "Failed to generate complaints report" });
  } finally {
    connection.release();
  }
};

export const getOtpVerificationReport = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const agencyId = req.user?.agency_id || 1;
    const { start, end, label } = getDateRange(req);

    const [summaryRows] = await connection.query(
      `
      SELECT
        COUNT(*) AS total_otps,
        COUNT(CASE WHEN dso.status = 'SENT' THEN 1 END) AS sent_otps,
        COUNT(CASE WHEN dso.status = 'PENDING' THEN 1 END) AS pending_otps,
        COUNT(CASE WHEN dso.otp = '' OR dso.otp IS NULL THEN 1 END) AS skipped_otps
      FROM driver_sale_otps dso
      INNER JOIN sales s ON s.id = dso.sale_id
      WHERE (s.agency_id = ? OR dso.agency_id = ?)
        AND dso.created_at BETWEEN ? AND ?
      `,
      [agencyId, agencyId, start, end]
    );

    const [otpsList] = await connection.query(
      `
      SELECT
        dso.id,
        DATE_FORMAT(CONVERT_TZ(dso.created_at, '+00:00', '+05:30'), '%d/%m/%Y, %H:%i:%s') AS date_formatted,
        cu.name AS customer_name,
        cu.consumer_number,
        du.name AS driver_name,
        (
          SELECT COALESCE(GROUP_CONCAT(DISTINCT pr.name SEPARATOR ', '), '14.2 KG Domestic')
          FROM sales_items si
          INNER JOIN products pr ON pr.id = si.product_id
          WHERE si.sale_id = dso.sale_id
        ) AS item_name,
        (
          SELECT COALESCE(SUM(si.quantity), 1)
          FROM sales_items si
          WHERE si.sale_id = dso.sale_id
        ) AS quantity,
        CASE
          WHEN s.payment_method = 'ONLINE' THEN 'Direct'
          WHEN EXISTS (SELECT 1 FROM payments pm WHERE pm.sale_id = s.id AND pm.type = 'COMPANY') THEN 'Direct'
          WHEN s.payment_method = 'UPI' AND NOT EXISTS (SELECT 1 FROM payments pm WHERE pm.sale_id = s.id AND pm.type = 'DRIVER') THEN 'Direct'
          ELSE 'Indirect'
        END AS settlement,
        CASE WHEN dso.otp = '' OR dso.otp IS NULL THEN 'OTP Skipped' ELSE dso.otp END AS otp,
        dso.status
      FROM driver_sale_otps dso
      INNER JOIN sales s ON s.id = dso.sale_id
      LEFT JOIN users cu ON cu.id = s.customer_id
      LEFT JOIN drivers d ON d.id = s.driver_id
      LEFT JOIN users du ON du.id = d.user_id
      WHERE (s.agency_id = ? OR dso.agency_id = ?)
        AND dso.created_at BETWEEN ? AND ?
      ORDER BY dso.created_at DESC
      LIMIT 100
      `,
      [agencyId, agencyId, start, end]
    );

    const total = Number(summaryRows[0]?.total_otps || 0);
    const sent = Number(summaryRows[0]?.sent_otps || 0);
    const verificationRate = total > 0 ? ((sent / total) * 100).toFixed(1) : "0.0";

    return res.status(200).json({
      success: true,
      data: {
        filter: label,
        summary: {
          ...summaryRows[0],
          verificationRate: `${verificationRate}%`,
        },
        otpsList,
      },
    });
  } catch (error) {
    console.error("getOtpVerificationReport error:", error);
    return res.status(500).json({ success: false, message: "Failed to generate OTP verification report" });
  } finally {
    connection.release();
  }
};
