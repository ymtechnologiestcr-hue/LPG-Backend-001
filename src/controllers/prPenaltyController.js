import db from "../config/db.js";
import { findCustomerForLookup } from "../utils/customerLookup.js";

export const lookupPenaltyCustomer = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const consumerNumber = String(
      req.query.consumerNumber ||
      req.query.phone ||
      req.query.phoneNumber ||
      req.query.search ||
      ""
    ).trim();
    const customerName = String(
      req.query.customerName ||
      req.query.existingName ||
      req.query.name ||
      ""
    ).trim();

    if (!consumerNumber && !customerName) {
      return res.status(400).json({
        success: false,
        message: "consumerNumber, phone, or customerName is required",
      });
    }

    const agencyId = req.user?.agency_id || null;
    const customer = await findCustomerForLookup(connection, {
      identifier: consumerNumber,
      name: customerName,
      agencyId,
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        id: Number(customer.id),
        customerId: Number(customer.id),
        name: customer.name,
        phone: customer.phone,
        consumerNumber: customer.consumer_number,
        consumer_number: customer.consumer_number,
        address: customer.address || "",
      },
    });
  } catch (error) {
    console.error("lookupPenaltyCustomer error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to lookup customer",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const createCustomerPenalty = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { customerId, penaltyReason, penaltyAmount } = req.body || {};

    if (!customerId) {
      return res.status(400).json({
        success: false,
        message: "customerId is required",
      });
    }

    if (!String(penaltyReason || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "penaltyReason is required",
      });
    }

    const amount = Number(penaltyAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "penaltyAmount must be greater than 0",
      });
    }

    const agencyId = req.user.agency_id;

    const [customerRows] = await connection.query(
      `
      SELECT
        id,
        name,
        consumer_number AS consumer_number
      FROM users
      WHERE id = ? AND role = 'CUSTOMER' AND agency_id = ?
      LIMIT 1
      `,
      [Number(customerId), agencyId]
    );

    if (!customerRows.length) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    const customer = customerRows[0];

    const [result] = await connection.query(
      `
      INSERT INTO customer_pr_penalties (
        customer_id,
        consumer_number_snapshot,
        customer_name_snapshot,
        penalty_reason,
        penalty_amount,
        payment_status,
        agency_id
      ) VALUES (?, ?, ?, ?, ?, 'UNPAID', ?)
      `,
      [
        Number(customer.id),
        customer.consumer_number,
        customer.name,
        String(penaltyReason).trim(),
        Number(amount.toFixed(2)),
        agencyId,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Penalty recorded successfully",
      data: {
        id: Number(result.insertId),
        paymentStatus: "UNPAID",
      },
    });
  } catch (error) {
    console.error("createCustomerPenalty error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to record penalty",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getRecentCustomerPenalties = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const [rows] = await connection.query(
      `
      SELECT
        p.id,
        p.customer_id,
        p.consumer_number_snapshot AS consumer_number,
        p.customer_name_snapshot AS customer_name,
        p.penalty_reason,
        p.penalty_amount,
        p.payment_status,
        DATE_FORMAT(p.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
      FROM customer_pr_penalties p
      WHERE p.agency_id = ?
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 8
      `,
      [req.user.agency_id]
    );

    return res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("getRecentCustomerPenalties error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch penalties",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const markPenaltyAsPaid = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const penaltyId = Number(req.params.id);

    if (!penaltyId) {
      return res.status(400).json({
        success: false,
        message: "Valid penalty id is required",
      });
    }

    const [result] = await connection.query(
      `
      UPDATE customer_pr_penalties
      SET payment_status = 'PAID', paid_at = NOW()
      WHERE id = ? AND payment_status = 'UNPAID' AND agency_id = ?
      `,
      [penaltyId, req.user.agency_id]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        success: false,
        message: "Unpaid penalty not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Penalty marked as paid",
    });
  } catch (error) {
    console.error("markPenaltyAsPaid error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update penalty",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
