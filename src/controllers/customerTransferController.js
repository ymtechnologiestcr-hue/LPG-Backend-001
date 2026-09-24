import db from "../config/db.js";
import { findCustomerForLookup } from "../utils/customerLookup.js";

const getExistingCustomerSnapshot = async (connection, existingCustomerId) => {
  const [latestConnectionRows] = await connection.query(
    `
    SELECT
      product_details,
      deposit_amount
    FROM customer_new_connections
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    `,
    [existingCustomerId]
  );

  if (latestConnectionRows.length) {
    const row = latestConnectionRows[0];
    return {
      productDetails: row.product_details || "14.2kg Domestic",
      depositLiability: Number(row.deposit_amount || 0),
    };
  }

  const [salesRows] = await connection.query(
    `
    SELECT
      p.name,
      SUM(si.quantity) AS quantity
    FROM sales s
    INNER JOIN sales_items si ON si.sale_id = s.id
    INNER JOIN products p ON p.id = si.product_id
    WHERE s.customer_id = ?
    GROUP BY p.id, p.name
    ORDER BY p.name ASC
    `,
    [existingCustomerId]
  );

  if (!salesRows.length) {
    return {
      productDetails: "No product history available",
      depositLiability: 0,
    };
  }

  const productDetails = salesRows
    .map((row) => `${row.name} x${Number(row.quantity || 0)}`)
    .join(", ");

  return {
    productDetails,
    depositLiability: 0,
  };
};

const parseAmount = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }
  return Number(amount.toFixed(2));
};

const ensureRegulatorReceivedColumn = async (connection) => {
  const [rows] = await connection.query(
    `
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'customer_connection_transfers'
      AND COLUMN_NAME = 'is_regulator_received'
    `
  );

  if (rows.length) {
    return;
  }

  try {
    await connection.query(
      "ALTER TABLE customer_connection_transfers ADD COLUMN is_regulator_received TINYINT(1) NOT NULL DEFAULT 0 AFTER reason"
    );
  } catch (error) {
    if (error?.code !== "ER_DUP_FIELDNAME") {
      throw error;
    }
  }
};

// A connection transfer now moves the connection to an external AGENCY (we do
// not create a new customer). The agency details are stored in a dedicated
// table that maps the existing customer -> the agency they were transferred to.
const ensureTransferAgencyTable = async (connection) => {
  await connection.query(
    `
    CREATE TABLE IF NOT EXISTS customer_transfer_agencies (
      id INT NOT NULL AUTO_INCREMENT,
      transfer_id INT NOT NULL,
      existing_customer_id INT NOT NULL,
      agency_name VARCHAR(255) NOT NULL,
      agency_phone VARCHAR(30) DEFAULT NULL,
      agency_address TEXT DEFAULT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_cta_transfer (transfer_id),
      KEY idx_cta_existing_customer (existing_customer_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `
  );

  // No new customer is created for agency transfers, so new_customer_id must
  // allow NULL. The existing FK stays valid because it ignores NULL values.
  const [rows] = await connection.query(
    `
    SELECT IS_NULLABLE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'customer_connection_transfers'
      AND COLUMN_NAME = 'new_customer_id'
    `
  );
  if (rows.length && String(rows[0].IS_NULLABLE).toUpperCase() === "NO") {
    await connection.query(
      "ALTER TABLE customer_connection_transfers MODIFY COLUMN new_customer_id INT NULL"
    );
  }
};

export const lookupTransferCustomer = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const consumerNumber = String(
      req.query.consumerNumber ||
      req.query.phone ||
      req.query.phoneNumber ||
      req.query.search ||
      ""
    ).trim();
    const existingName = String(
      req.query.existingName ||
      req.query.customerName ||
      req.query.name ||
      ""
    ).trim();

    if (!consumerNumber && !existingName) {
      return res.status(400).json({
        success: false,
        message: "consumerNumber, phone, or existingName is required",
      });
    }

    const agencyId = req.user?.agency_id || null;
    const customer = await findCustomerForLookup(connection, {
      identifier: consumerNumber,
      name: existingName,
      agencyId,
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Existing customer not found",
      });
    }

    const snapshot = await getExistingCustomerSnapshot(connection, Number(customer.id));

    return res.status(200).json({
      success: true,
      data: {
        id: Number(customer.id),
        existing_customer_id: Number(customer.id),
        name: customer.name,
        phone: customer.phone,
        existing_phone: customer.phone,
        consumerNumber: customer.consumer_number,
        consumer_number: customer.consumer_number,
        address: customer.address,
        productDetails: snapshot.productDetails,
        depositLiability: snapshot.depositLiability,
      },
    });
  } catch (error) {
    console.error("lookupTransferCustomer error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to lookup customer",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const createCustomerTransfer = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      existingCustomerId,
      // New: the connection is transferred to an external agency. `newAgency*`
      // are the current fields; the legacy `newCustomer*` names are still
      // accepted so older clients keep working.
      newAgencyName,
      newAgencyPhone,
      newAgencyAddress,
      newCustomerName,
      newCustomerPhone,
      newCustomerAddress,
      reason,
      depositLiability,
      isRegulatorReceived,
      emptyProductId,
      emptyCylinderQty,
    } = req.body || {};

    const agencyName = String(newAgencyName || newCustomerName || "").trim();
    const agencyPhone = String(newAgencyPhone || newCustomerPhone || "").trim();
    const agencyAddress = String(newAgencyAddress || newCustomerAddress || "").trim();

    const regulatorReceivedValue = Number(isRegulatorReceived) === 1 || isRegulatorReceived === true ? 1 : 0;

    // Optional empty-cylinder return received during the transfer. When provided,
    // a pending EMPTY_RETURN request is raised for the godown manager to approve.
    let parsedEmptyProductId = Number(emptyProductId) || null;
    let parsedEmptyQty = Number(emptyCylinderQty) || 0;
    if (!parsedEmptyProductId || parsedEmptyQty <= 0) {
      parsedEmptyProductId = null;
      parsedEmptyQty = 0;
    }

    if (!existingCustomerId) {
      return res.status(400).json({
        success: false,
        message: "existingCustomerId is required",
      });
    }

    if (!agencyName) {
      return res.status(400).json({
        success: false,
        message: "newAgencyName is required",
      });
    }

    if (!String(reason || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "reason is required",
      });
    }

    const parsedDepositLiability = parseAmount(depositLiability);

    if (parsedDepositLiability === null) {
      return res.status(400).json({
        success: false,
        message: "depositLiability must be a valid amount",
      });
    }

    const agencyId = req.user.agency_id;

    const [existingCustomerRows] = await connection.query(
      "SELECT id, name FROM users WHERE id = ? AND role = 'CUSTOMER' AND agency_id = ? LIMIT 1",
      [Number(existingCustomerId), agencyId]
    );

    if (!existingCustomerRows.length) {
      return res.status(404).json({
        success: false,
        message: "Existing customer not found",
      });
    }

    if (parsedEmptyProductId) {
      const [emptyProductRows] = await connection.query(
        "SELECT id FROM products WHERE id = ? LIMIT 1",
        [parsedEmptyProductId]
      );

      if (!emptyProductRows.length) {
        return res.status(404).json({
          success: false,
          message: "Selected empty cylinder product not found",
        });
      }
    }

    const snapshot = await getExistingCustomerSnapshot(connection, Number(existingCustomerId));

    await ensureRegulatorReceivedColumn(connection);
    await ensureTransferAgencyTable(connection);

    await connection.beginTransaction();

    // No new customer is created — the connection is transferred to an external
    // agency. new_customer_id stays NULL; the agency is recorded separately.
    const [transferResult] = await connection.query(
      `
      INSERT INTO customer_connection_transfers (
        existing_customer_id,
        new_customer_id,
        product_details_snapshot,
        deposit_liability,
        reason,
        is_regulator_received,
        status,
        agency_id
      ) VALUES (?, NULL, ?, ?, ?, ?, 'PENDING_MANAGER', ?)
      `,
      [
        Number(existingCustomerId),
        snapshot.productDetails,
        parsedDepositLiability,
        String(reason).trim(),
        regulatorReceivedValue,
        agencyId,
      ]
    );

    const transferId = Number(transferResult.insertId);

    // Store the agency the connection was transferred to, mapped to the
    // existing customer and this transfer request.
    await connection.query(
      `
      INSERT INTO customer_transfer_agencies (
        transfer_id,
        existing_customer_id,
        agency_name,
        agency_phone,
        agency_address,
        agency_id
      ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        transferId,
        Number(existingCustomerId),
        agencyName,
        agencyPhone || null,
        agencyAddress || null,
        agencyId,
      ]
    );

    // Raise a pending empty-cylinder return request to the godown manager,
    // mirroring the driver flow. No driver is involved, so driver_id is NULL and
    // reference_id points at this transfer; the manager approves it from the
    // Returns screen, which adds the empties into godown stock.
    if (parsedEmptyProductId && parsedEmptyQty > 0) {
      await connection.query(
        `
        INSERT INTO stock_transactions
          (product_id, stock_area_id, type, quantity, isApproved, reference_id, created_by, driver_id, stock_from, is_defective, agency_id)
        VALUES (?, NULL, 'EMPTY_RETURN', ?, 0, ?, NULL, NULL, 'default', 0, ?)
        `,
        [parsedEmptyProductId, parsedEmptyQty, transferId, agencyId]
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Transfer request sent to manager and cashier",
      data: {
        id: transferId,
        existingCustomerId: Number(existingCustomerId),
        agencyName,
        agencyPhone: agencyPhone || null,
        agencyAddress: agencyAddress || null,
        isRegulatorReceived: regulatorReceivedValue,
        status: "PENDING_MANAGER",
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createCustomerTransfer error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create transfer request",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getRecentCustomerTransfers = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureRegulatorReceivedColumn(connection);
    await ensureTransferAgencyTable(connection);

    // new_customer_id is NULL for agency transfers, so LEFT JOIN users and fall
    // back to the mapped agency name. Legacy rows (with a new customer) still
    // show that customer's name.
    const [rows] = await connection.query(
      `
      SELECT
        t.id,
        t.existing_customer_id,
        t.new_customer_id,
        old_user.name AS existing_customer_name,
        COALESCE(cta.agency_name, new_user.name) AS new_customer_name,
        cta.agency_name AS new_agency_name,
        cta.agency_phone AS new_agency_phone,
        cta.agency_address AS new_agency_address,
        t.product_details_snapshot,
        t.deposit_liability,
        t.reason,
        t.is_regulator_received,
        t.status,
        DATE_FORMAT(t.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
      FROM customer_connection_transfers t
      INNER JOIN users old_user ON old_user.id = t.existing_customer_id
      LEFT JOIN users new_user ON new_user.id = t.new_customer_id
      LEFT JOIN customer_transfer_agencies cta ON cta.transfer_id = t.id
      WHERE t.agency_id = ?
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT 8
      `,
      [req.user.agency_id]
    );

    return res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("getRecentCustomerTransfers error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch recent transfers",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
