import db from "../config/db.js";

export const getSalesDashboard = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = "",
      startDate,
      endDate,
    } = req.query;
    
    const agencyId = req.user.agency_id;

    const offset = (page - 1) * limit;

    // Date Filter
    let dateFilter = "";
    const dateFilterValues = [];

    if (startDate && endDate) {
      dateFilter = `AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?`;
      dateFilterValues.push(startDate, endDate);
    }
    
    // Default to agencyId in queries
    const agencyValues = [agencyId];

    // Search Filter
    let searchFilter = "";
    const searchFilterValues = [];
    if (search) {
      searchFilter = `AND u.name LIKE ?`;
      searchFilterValues.push(`%${search}%`);
    }

    // =========================
    // SUMMARY DATA
    // =========================
    const [summary] = await db.query(
      `SELECT 
        COALESCE(SUM(CASE WHEN p.method = 'CASH' AND p.type = 'DRIVER' AND (s.payment_method != 'ONLINE' OR s.payment_method IS NULL) AND p.status = 'SUCCESS' THEN p.amount ELSE 0 END), 0) AS cash,
        COALESCE(SUM(CASE WHEN p.method = 'UPI' AND p.type = 'DRIVER' AND (s.payment_method != 'ONLINE' OR s.payment_method IS NULL) AND p.status = 'SUCCESS' THEN p.amount ELSE 0 END), 0) AS gpay,
        COALESCE(SUM(CASE WHEN (p.type = 'COMPANY' OR p.method = 'CARD' OR s.payment_method = 'ONLINE') AND p.status = 'SUCCESS' THEN p.amount ELSE 0 END), 0) AS online
        FROM payments p
        JOIN sales s ON p.sale_id = s.id
        WHERE s.status = 'DELIVERED' AND s.agency_id = ?
      ${dateFilter}
      `,
      [...agencyValues, ...dateFilterValues]
    );

    // =========================
    // DRIVER TABLE DATA
    // =========================
    const [drivers] = await db.query(
      `
      SELECT 
        d.id,
        u.name AS driver_name,
        COUNT(DISTINCT s.id) AS deliveries,
        SUM(CASE WHEN p.method = 'CASH' AND p.type = 'DRIVER' AND (s.payment_method != 'ONLINE' OR s.payment_method IS NULL) AND p.status = 'SUCCESS' THEN p.amount ELSE 0 END) AS cash,
        SUM(CASE WHEN p.method = 'UPI' AND p.type = 'DRIVER' AND (s.payment_method != 'ONLINE' OR s.payment_method IS NULL) AND p.status = 'SUCCESS' THEN p.amount ELSE 0 END) AS gpay,
        SUM(CASE WHEN p.method IN ('CASH', 'UPI') AND p.type = 'DRIVER' AND (s.payment_method != 'ONLINE' OR s.payment_method IS NULL) AND p.status = 'SUCCESS' THEN p.amount ELSE 0 END) AS total
      FROM drivers d
      JOIN users u ON d.user_id = u.id
      LEFT JOIN sales s ON s.driver_id = d.id AND s.status = 'DELIVERED' AND s.agency_id = ?
      LEFT JOIN payments p ON p.sale_id = s.id
      WHERE u.agency_id = ? AND (d.agency_id = ? OR d.agency_id IS NULL)
      ${dateFilter}
      ${searchFilter}
      GROUP BY d.id
      ORDER BY total DESC
      LIMIT ? OFFSET ?
      `,
      [agencyId, agencyId, agencyId, ...dateFilterValues, ...searchFilterValues, Number(limit), Number(offset)]
    );

    // =========================
    // TOTAL COUNT
    // =========================
    const [countResult] = await db.query(
      `
      SELECT COUNT(DISTINCT d.id) AS total
      FROM drivers d
      JOIN users u ON d.user_id = u.id
      LEFT JOIN sales s ON s.driver_id = d.id AND s.status = 'DELIVERED' AND s.agency_id = ?
      WHERE u.agency_id = ? AND (d.agency_id = ? OR d.agency_id IS NULL)
      ${dateFilter}
      ${searchFilter}
      `,
      [agencyId, agencyId, agencyId, ...dateFilterValues, ...searchFilterValues]
    );

    // =========================
    // RECENT SALES DATA
    // =========================
    const [recentSalesRows] = await db.query(
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
        COALESCE(SUM(COALESCE(si.quantity, 0)), 0) AS total_qty,
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
      ${dateFilter}
      GROUP BY s.id, c.name, du.name, s.status, s.total_amount
      ORDER BY COALESCE(s.delivered_at, s.created_at) DESC, s.id DESC
      LIMIT 8
      `,
      [...agencyValues, ...dateFilterValues]
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

    return res.json({
      success: true,
      summary: summary[0],
      data: drivers,
      recentSales,
      pagination: {
        total: countResult[0].total,
        page: Number(page),
        limit: Number(limit),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};

export const createSale = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      customer_id,
      driver_id,
      payment_method,
      status = "PENDING",
      address_id,
      items = [],
      payments = []
    } = req.body;
    
    const agencyId = req.user.agency_id;

    if (!customer_id || !items.length) {
      return res.status(400).json({
        success: false,
        message: "Customer and items are required"
      });
    }

    await connection.beginTransaction();

    // =========================
    // CALCULATE TOTAL
    // =========================
    const total_amount = items.reduce(
      (sum, item) => sum + item.quantity * item.price,
      0
    );

    // =========================
    // INSERT SALE
    // =========================
    const [saleResult] = await connection.execute(
      `
      INSERT INTO sales 
      (customer_id, driver_id, total_amount, payment_method, status, address_id, agency_id, created_at, assigned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [
        customer_id,
        driver_id || null,
        total_amount,
        payment_method,
        status,
        address_id || null,
        agencyId
      ]
    );

    const saleId = saleResult.insertId;

    // =========================
    // INSERT ITEMS
    // =========================
    for (const item of items) {
      await connection.execute(
        `
        INSERT INTO sales_items 
        (sale_id, product_id, quantity, price, agency_id)
        VALUES (?, ?, ?, ?, ?)
        `,
        [saleId, item.product_id, item.quantity, item.price, agencyId]
      );
    }

    // =========================
    // INSERT PAYMENTS (MULTIPLE)
    // =========================
    let totalPaid = 0;

    for (const p of payments) {
      await connection.execute(
        `
        INSERT INTO payments
        (sale_id, amount, method, status, type, agency_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NOW())
        `,
        [
          saleId,
          p.amount,
          p.method,
          p.status,
          p.type,
          agencyId
        ]
      );

      if (p.status === "SUCCESS") {
        totalPaid += Number(p.amount);
      }
    }

    // =========================
    // VALIDATE PAYMENT (IMPORTANT)
    // =========================
    if (payments.length > 0 && totalPaid > total_amount) {
      throw new Error("Paid amount exceeds total amount");
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Sale created successfully",
      sale_id: saleId,
      total_amount,
      total_paid: totalPaid,
      due_amount: total_amount - totalPaid
    });

  } catch (error) {
    await connection.rollback();
    console.error("Create Sale Error:", error);

    res.status(500).json({
      success: false,
      message: error.message || "Server Error"
    });
  } finally {
    connection.release();
  }
};