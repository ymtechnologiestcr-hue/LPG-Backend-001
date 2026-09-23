import db from "../config/db.js";

const DEFAULT_STOCK_AREA_ID = 1;

// Adds `qty` to the running system_quantity tally for a product, on the
// canonical stock row (default area preferred, otherwise the lowest-id row).
// Creates a stock row if none exists. Floored at 0.
const addSystemQuantity = async (connection, productId, qty, agencyId = 1) => {
  const amount = Number(qty || 0);

  if (!Number(productId) || amount <= 0) {
    return;
  }

  const [rows] = await connection.query(
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
    await connection.query(
      `
      UPDATE stock
      SET system_quantity = GREATEST(COALESCE(system_quantity, 0) + ?, 0),
          updated_at = NOW()
      WHERE id = ?
      `,
      [amount, rows[0].id]
    );
  } else {
    await connection.query(
      `
      INSERT INTO stock (product_id, stock_area_id, quantity, system_quantity, agency_id)
      VALUES (?, ?, 0, GREATEST(?, 0), ?)
      `,
      [Number(productId), DEFAULT_STOCK_AREA_ID, amount, agencyId]
    );
  }
};

export const getIocOtpSummary = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const agencyId = req.user?.agency_id || 1;

    const [rows] = await connection.query(`
      SELECT
        COUNT(CASE WHEN DATE(CONVERT_TZ(dso.created_at, '+00:00', '+05:30')) = DATE(CONVERT_TZ(NOW(), '+00:00', '+05:30')) THEN 1 END) AS today_received,
        COUNT(CASE WHEN DATE(CONVERT_TZ(dso.created_at, '+00:00', '+05:30')) = DATE(CONVERT_TZ(NOW(), '+00:00', '+05:30')) AND dso.status = 'PENDING' THEN 1 END) AS today_pending,
        COUNT(CASE WHEN DATE(CONVERT_TZ(dso.created_at, '+00:00', '+05:30')) = DATE(CONVERT_TZ(NOW(), '+00:00', '+05:30')) AND dso.status = 'SENT' THEN 1 END) AS today_sent,
        COUNT(CASE WHEN dso.status = 'PENDING' THEN 1 END) AS all_pending
      FROM driver_sale_otps dso
      INNER JOIN sales s ON s.id = dso.sale_id
      LEFT JOIN drivers d ON d.id = s.driver_id
      LEFT JOIN users du ON du.id = d.user_id
      WHERE (s.agency_id = ? OR dso.agency_id = ? OR du.agency_id = ?)
    `, [agencyId, agencyId, agencyId]);

    const summary = rows[0] || {};

    return res.status(200).json({
      success: true,
      data: {
        todayReceived: Number(summary.today_received || 0),
        todayPending: Number(summary.today_pending || 0),
        todaySent: Number(summary.today_sent || 0),
        allPending: Number(summary.all_pending || 0),
      },
    });
  } catch (error) {
    console.error("getIocOtpSummary error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch OTP summary",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const listIocOtps = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const agencyId = req.user?.agency_id || 1;
    const status = String(req.query.status || "").trim().toUpperCase();
    const date = String(req.query.date || "").trim();
    const driverId = Number(req.query.driverId) || null;

    const filters = ["(s.agency_id = ? OR dso.agency_id = ? OR du.agency_id = ?)"];
    const params = [agencyId, agencyId, agencyId];

    if (status && status !== "ALL") {
      filters.push("dso.status = ?");
      params.push(status);
    }

    if (date) {
      filters.push("DATE(CONVERT_TZ(dso.created_at, '+00:00', '+05:30')) = ?");
      params.push(date);
    }

    if (driverId) {
      filters.push("s.driver_id = ?");
      params.push(driverId);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const [rows] = await connection.query(
      `
      SELECT
        dso.id,
        dso.sale_id,
        dso.otp,
        dso.status,
        DATE_FORMAT(CONVERT_TZ(dso.created_at, '+00:00', '+05:30'), '%d/%m/%Y, %H:%i:%s') AS created_at_formatted,
        cu.name AS customer_name,
        cu.phone AS customer_phone,
        cu.consumer_number AS consumer_number,
        s.driver_id,
        du.name AS driver_name,
        (
          SELECT COALESCE(
            CASE
              WHEN COUNT(DISTINCT pr.type) > 1 THEN 'Mixed'
              ELSE MAX(CASE WHEN pr.type = 'COMMERCIAL' THEN 'Commercial' ELSE 'Domestic' END)
            END,
            'Domestic'
          )
          FROM sales_items si
          INNER JOIN products pr ON pr.id = si.product_id
          WHERE si.sale_id = dso.sale_id
        ) AS category
      FROM driver_sale_otps dso
      INNER JOIN sales s ON s.id = dso.sale_id
      LEFT JOIN users cu ON cu.id = s.customer_id
      LEFT JOIN drivers d ON d.id = s.driver_id
      LEFT JOIN users du ON du.id = d.user_id
      ${whereClause}
      ORDER BY dso.created_at DESC
      LIMIT 100
      `,
      params
    );

    const processedRows = rows.map((row) => ({
      ...row,
      otp: row.otp === "" ? "OTP Skipped" : row.otp,
    }));

    return res.status(200).json({
      success: true,
      data: processedRows,
    });
  } catch (error) {
    console.error("listIocOtps error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch IOC OTPs",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const markIocOtpSent = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const agencyId = req.user?.agency_id || 1;
    const otpId = Number(req.params.id);

    if (!otpId) {
      return res.status(400).json({
        success: false,
        message: "Valid OTP id is required",
      });
    }

    await connection.beginTransaction();

    // The PENDING guard makes this transition (and the stock update below)
    // fire exactly once per OTP, so system_quantity is never double-counted.
    const [result] = await connection.query(
      `UPDATE driver_sale_otps dso 
       INNER JOIN sales s ON s.id = dso.sale_id 
       LEFT JOIN drivers d ON d.id = s.driver_id
       LEFT JOIN users du ON du.id = d.user_id
       SET dso.status = 'SENT', dso.agency_id = ?
       WHERE dso.id = ? AND dso.status = 'PENDING' AND (s.agency_id = ? OR dso.agency_id = ? OR du.agency_id = ?)`,
      [agencyId, otpId, agencyId, agencyId, agencyId]
    );

    if (!result.affectedRows) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Pending OTP not found",
      });
    }

    const [otpRows] = await connection.query(
      "SELECT sale_id FROM driver_sale_otps WHERE id = ? LIMIT 1",
      [otpId]
    );

    const saleId = Number(otpRows[0]?.sale_id) || null;

    if (saleId) {
      // Ensure sales row also has the correct agency_id if it was defaulted to 1
      await connection.query(
        "UPDATE sales SET agency_id = ? WHERE id = ? AND agency_id != ?",
        [agencyId, saleId, agencyId]
      );

      // A sale can have multiple products; accumulate system stock per product
      // by the quantity sold in this sale.
      const [items] = await connection.query(
        `
        SELECT product_id, SUM(quantity) AS quantity
        FROM sales_items
        WHERE sale_id = ?
        GROUP BY product_id
        `,
        [saleId]
      );

      for (const item of items) {
        await addSystemQuantity(connection, item.product_id, item.quantity, agencyId);
      }
    }

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "OTP marked as sent to IOC",
    });
  } catch (error) {
    await connection.rollback();
    console.error("markIocOtpSent error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update OTP status",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const addIocOtp = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const agencyId = req.user?.agency_id || 1;
    const saleId = Number(req.body?.saleId);
    const otp = String(req.body?.otp || "").trim();

    if (!saleId) {
      return res.status(400).json({ success: false, message: "saleId is required" });
    }

    if (!otp) {
      return res.status(400).json({ success: false, message: "otp is required" });
    }

    const [saleRows] = await connection.query(
      `SELECT s.id FROM sales s
       LEFT JOIN drivers d ON d.id = s.driver_id
       LEFT JOIN users du ON du.id = d.user_id
       WHERE s.id = ? AND (s.agency_id = ? OR du.agency_id = ?) LIMIT 1`,
      [saleId, agencyId, agencyId]
    );

    if (!saleRows.length) {
      return res.status(404).json({ success: false, message: "Sale not found" });
    }

    const [result] = await connection.query(
      "INSERT INTO driver_sale_otps (sale_id, otp, status, agency_id) VALUES (?, ?, 'PENDING', ?)",
      [saleId, otp, agencyId]
    );

    return res.status(201).json({
      success: true,
      message: "OTP added successfully",
      data: { id: Number(result.insertId) },
    });
  } catch (error) {
    console.error("addIocOtp error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to add OTP",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

