import db from "../config/db.js";
import { findCustomerForLookup } from "../utils/customerLookup.js";

export const lookupNameChangeCustomer = async (req, res) => {
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
      },
    });
  } catch (error) {
    console.error("lookupNameChangeCustomer error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to lookup customer",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const createNameChangeRequest = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { customerId, newName, serviceFee, documentUrl } = req.body || {};

    if (!customerId) {
      return res.status(400).json({
        success: false,
        message: "customerId is required",
      });
    }

    if (!String(newName || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "newName is required",
      });
    }

    const amount = Number(serviceFee);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({
        success: false,
        message: "serviceFee must be a valid amount",
      });
    }

    const agencyId = req.user.agency_id;

    const [customerRows] = await connection.query(
      "SELECT id, name FROM users WHERE id = ? AND role = 'CUSTOMER' AND agency_id = ? LIMIT 1",
      [Number(customerId), agencyId]
    );

    if (!customerRows.length) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    const [existingPendingRows] = await connection.query(
      "SELECT id FROM customer_name_change_requests WHERE customer_id = ? AND status = 'PENDING' LIMIT 1",
      [Number(customerId)]
    );

    if (existingPendingRows.length) {
      return res.status(409).json({
        success: false,
        message: "A pending name change request already exists for this customer",
      });
    }

    const [result] = await connection.query(
      `
      INSERT INTO customer_name_change_requests (
        customer_id,
        old_name_snapshot,
        new_name_requested,
        service_fee,
        document_url,
        status,
        agency_id
      ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
      `,
      [
        Number(customerId),
        customerRows[0].name,
        String(newName).trim(),
        Number(amount.toFixed(2)),
        String(documentUrl || "").trim() || null,
        agencyId,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Name change request created successfully",
      data: {
        id: Number(result.insertId),
        status: "PENDING",
      },
    });
  } catch (error) {
    console.error("createNameChangeRequest error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create name change request",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getRecentNameChangeRequests = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const [rows] = await connection.query(
      `
      SELECT
        r.id,
        r.customer_id,
        u.name AS existing_name,
        u.consumer_number AS consumer_number,
        r.old_name_snapshot,
        r.new_name_requested,
        r.service_fee,
        r.document_url,
        r.status,
        DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
      FROM customer_name_change_requests r
      INNER JOIN users u ON u.id = r.customer_id
      WHERE r.agency_id = ?
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 8
      `,
      [req.user.agency_id]
    );

    return res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("getRecentNameChangeRequests error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch name change requests",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const approveNameChangeRequest = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const requestId = Number(req.params.id);

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "Valid request id is required",
      });
    }

    await connection.beginTransaction();

    const [requestRows] = await connection.query(
      `
      SELECT id, customer_id, new_name_requested, status
      FROM customer_name_change_requests
      WHERE id = ? AND agency_id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [requestId, req.user.agency_id]
    );

    if (!requestRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Name change request not found",
      });
    }

    const requestRow = requestRows[0];

    if (requestRow.status !== "PENDING") {
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message: "Only pending requests can be approved",
      });
    }

    await connection.query(
      "UPDATE users SET name = ? WHERE id = ? AND role = 'CUSTOMER' AND agency_id = ?",
      [requestRow.new_name_requested, requestRow.customer_id, req.user.agency_id]
    );

    await connection.query(
      `
      UPDATE customer_name_change_requests
      SET status = 'APPROVED', approved_at = NOW()
      WHERE id = ? AND agency_id = ?
      `,
      [requestId, req.user.agency_id]
    );

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "Name change request approved",
    });
  } catch (error) {
    await connection.rollback();
    console.error("approveNameChangeRequest error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to approve name change request",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
