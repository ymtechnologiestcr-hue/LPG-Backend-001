import db from "../config/db.js";

const toPositiveAmount = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }
  return Number(amount.toFixed(2));
};

const ensureNewConnectionProductTable = async (connection) => {
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

  // customer_new_connections gains these columns lazily (also added by the
  // cashier flow). Ensure they exist before inserting so the new-connection
  // path works on databases where the cashier migration hasn't run yet.
  const requiredColumns = {
    product_id: "ALTER TABLE customer_new_connections ADD COLUMN product_id INT DEFAULT NULL AFTER product_details",
    id_proof_url: "ALTER TABLE customer_new_connections ADD COLUMN id_proof_url VARCHAR(500) DEFAULT NULL AFTER id_proof_details",
  };

  const [columnRows] = await connection.query(
    `
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'customer_new_connections'
      AND COLUMN_NAME IN ('product_id', 'id_proof_url')
    `
  );

  const existingColumns = new Set(columnRows.map((row) => String(row.COLUMN_NAME)));
  for (const [columnName, ddl] of Object.entries(requiredColumns)) {
    if (existingColumns.has(columnName)) continue;

    try {
      await connection.query(ddl);
    } catch (error) {
      if (error?.code !== "ER_DUP_FIELDNAME") {
        throw error;
      }
    }
  }
};

const normalizeConnectionProducts = (body) => {
  const requestedProducts = Array.isArray(body?.products) ? body.products : [];
  const products = requestedProducts
    .map((item) => ({
      productId: Number(item.productId ?? item.product_id ?? item.id),
    }))
    .filter((item) => Number.isInteger(item.productId) && item.productId > 0);

  const fallbackProductId = Number(body?.productId);
  if (!products.length && Number.isInteger(fallbackProductId) && fallbackProductId > 0) {
    products.push({ productId: fallbackProductId });
  }

  const uniqueIds = new Set();
  return products.filter((item) => {
    if (uniqueIds.has(item.productId)) return false;
    uniqueIds.add(item.productId);
    return true;
  });
};

export const createCustomerConnection = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      customerName,
      mobileNumber,
      address,
      productDetails,
      productId,
      idProofDetails,
      idProofUrl,
      depositAmount,
      gstAmount,
      totalAmount,
    } = req.body || {};

    if (!String(customerName || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "customerName is required",
      });
    }

    if (!String(mobileNumber || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "mobileNumber is required",
      });
    }

    if (!String(address || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "address is required",
      });
    }

    const parsedDepositAmount = toPositiveAmount(depositAmount);
    const parsedGstAmount = toPositiveAmount(gstAmount);
    const parsedTotalAmount = toPositiveAmount(totalAmount);

    if (parsedDepositAmount === null || parsedGstAmount === null || parsedTotalAmount === null) {
      return res.status(400).json({
        success: false,
        message: "depositAmount, gstAmount and totalAmount must be valid amounts",
      });
    }

    const selectedProducts = normalizeConnectionProducts(req.body || {});
    let productRows = [];

    if (selectedProducts.length) {
      const productIds = selectedProducts.map((item) => item.productId);
      const [rows] = await connection.query(
        `
        SELECT id, name, type, price
        FROM products
        WHERE id IN (?)
        `,
        [productIds]
      );

      if (rows.length !== productIds.length) {
        return res.status(400).json({
          success: false,
          message: "One or more selected products are invalid",
        });
      }

      const rowMap = new Map(rows.map((row) => [Number(row.id), row]));
      productRows = productIds.map((id) => rowMap.get(Number(id))).filter(Boolean);
    }

    const agencyId = req.user.agency_id;

    let finalConsumerNumber = String(req.body?.consumerNumber || "").trim();
    if (!finalConsumerNumber) {
      finalConsumerNumber = `LPG-${Math.floor(100000 + Math.random() * 900000)}`;
    }
    const finalConsumerId = String(req.body?.consumerId || finalConsumerNumber).trim();

    const [existingUserRows] = await connection.query(
      "SELECT id, consumer_number FROM users WHERE phone = ? AND agency_id = ? AND role = 'CUSTOMER' LIMIT 1",
      [String(mobileNumber).trim(), agencyId]
    );

    await connection.beginTransaction();
    await ensureNewConnectionProductTable(connection);

    let userId = null;
    if (existingUserRows.length) {
      userId = Number(existingUserRows[0].id);
      await connection.query(
        `
        UPDATE users
        SET name = ?,
            consumer_number = COALESCE(consumer_number, ?),
            consumer_id = COALESCE(consumer_id, ?),
            role = 'CUSTOMER',
            status = 'ACTIVE'
        WHERE id = ? AND role = 'CUSTOMER'
        `,
        [String(customerName).trim(), finalConsumerNumber, finalConsumerId, userId]
      );
    } else {
      const [userResult] = await connection.query(
        `
        INSERT INTO users (name, phone, role, status, agency_id, consumer_number, consumer_id)
        VALUES (?, ?, 'CUSTOMER', 'ACTIVE', ?, ?, ?)
        `,
        [String(customerName).trim(), String(mobileNumber).trim(), agencyId, finalConsumerNumber, finalConsumerId]
      );
      userId = Number(userResult.insertId);
    }

    const [existingAddressRows] = await connection.query(
      "SELECT id FROM addresses WHERE user_id = ? AND is_default = 1 LIMIT 1",
      [userId]
    );
    if (existingAddressRows.length) {
      await connection.query(
        "UPDATE addresses SET address = ? WHERE id = ?",
        [String(address).trim(), existingAddressRows[0].id]
      );
    } else {
      await connection.query(
        "INSERT INTO addresses (user_id, address, is_default) VALUES (?, ?, 1)",
        [userId, String(address).trim()]
      );
    }

    const [connectionResult] = await connection.query(
      `
      INSERT INTO customer_new_connections (
        user_id,
        product_details,
        product_id,
        id_proof_details,
        id_proof_url,
        deposit_amount,
        gst_amount,
        total_amount,
        payment_status,
        agency_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_PAYMENT', ?)
      `,
      [
        userId,
        productRows.length
          ? productRows.map((item) => `${item.name} (${item.type})`).join(", ")
          : String(productDetails || "").trim() || null,
        productRows[0]?.id ? Number(productRows[0].id) : productId ? Number(productId) : null,
        String(idProofDetails || "").trim() || null,
        String(idProofUrl || "").trim() || null,
        parsedDepositAmount,
        parsedGstAmount,
        parsedTotalAmount,
        agencyId,
      ]
    );

    if (productRows.length) {
      await connection.query(
        `
        INSERT INTO customer_new_connection_products (
          connection_id,
          product_id,
          product_name_snapshot,
          product_type_snapshot,
          product_price_snapshot,
          status
        ) VALUES ?
        `,
        [
          productRows.map((item) => [
            Number(connectionResult.insertId),
            Number(item.id),
            item.name || null,
            item.type || null,
            Number(item.price || 0),
            "PENDING",
          ]),
        ]
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "New connection sent to cashier successfully",
      data: {
        id: Number(connectionResult.insertId),
        userId,
        consumerNumber: null,
        paymentStatus: "PENDING_PAYMENT",
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createCustomerConnection error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create new connection",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getRecentCustomerConnections = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureNewConnectionProductTable(connection);

    const [rows] = await connection.query(
      `
      SELECT
        cnc.id,
        cnc.user_id,
        u.name AS customer_name,
        u.phone AS phone,
        u.consumer_number AS consumer_number,
        cnc.product_details,
        cnc.product_id,
        COALESCE(p.name, '') AS product_name,
        cnc.deposit_amount,
        cnc.gst_amount,
        cnc.total_amount,
        cnc.payment_status,
        GROUP_CONCAT(
          DISTINCT COALESCE(ncp.product_name_snapshot, p2.name)
          ORDER BY COALESCE(ncp.product_name_snapshot, p2.name)
          SEPARATOR ', '
        ) AS selected_products,
        DATE_FORMAT(cnc.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
      FROM customer_new_connections cnc
      INNER JOIN users u ON u.id = cnc.user_id
      LEFT JOIN products p ON p.id = cnc.product_id
      LEFT JOIN customer_new_connection_products ncp ON ncp.connection_id = cnc.id
      LEFT JOIN products p2 ON p2.id = ncp.product_id
      WHERE cnc.agency_id = ?
      GROUP BY
        cnc.id,
        cnc.user_id,
        u.name,
        u.phone,
        cnc.product_details,
        cnc.product_id,
        p.name,
        cnc.deposit_amount,
        cnc.gst_amount,
        cnc.total_amount,
        cnc.payment_status,
        cnc.created_at
      ORDER BY cnc.created_at DESC, cnc.id DESC
      LIMIT 8
      `,
      [req.user.agency_id]
    );

    return res.status(200).json({
      success: true,
      data: rows.map((row) => ({
        ...row,
        product_details: row.selected_products || row.product_details,
      })),
    });
  } catch (error) {
    console.error("getRecentCustomerConnections error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch recent new connections",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const searchConnectionProducts = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const search = (req.query.search || "").trim();
    const params = [];
    let whereClause = "";

    if (search) {
      whereClause = "WHERE (p.name LIKE ? OR p.type LIKE ?)";
      const like = `%${search}%`;
      params.push(like, like);
    }

    const [rows] = await connection.query(
      `
      SELECT id, name, type, price
      FROM products p
      ${whereClause}
      ORDER BY p.name ASC
      LIMIT 20
      `,
      params
    );

    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("searchConnectionProducts error:", error);
    return res.status(500).json({ success: false, message: "Failed to search products", error: error.message });
  } finally {
    connection.release();
  }
};
