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

export const ensurePrProductsAndStock = async (connection, agencyId = 1) => {
  let [[cat]] = await connection.query(
    "SELECT id FROM categories WHERE name LIKE '%Regulator%' OR name LIKE '%PR%' LIMIT 1"
  );
  let categoryId = cat?.id;
  if (!categoryId) {
    const [catRes] = await connection.query("INSERT INTO categories (name) VALUES ('Pressure Regulator')");
    categoryId = catRes.insertId;
  }

  let [[normalPr]] = await connection.query(
    "SELECT id, name FROM products WHERE name IN ('Normal PR', 'PR Stock', 'Pressure Regulator') LIMIT 1"
  );
  if (!normalPr) {
    const [res] = await connection.query(
      "INSERT INTO products (name, type, price, category_id) VALUES ('Normal PR', 'DOMESTIC', 250.00, ?)",
      [categoryId]
    );
    normalPr = { id: res.insertId, name: 'Normal PR' };
  }

  let [[defectivePr]] = await connection.query(
    "SELECT id, name FROM products WHERE name IN ('Defective PR', 'Defective PR Stock') LIMIT 1"
  );
  if (!defectivePr) {
    const [res] = await connection.query(
      "INSERT INTO products (name, type, price, category_id) VALUES ('Defective PR', 'DOMESTIC', 0.00, ?)",
      [categoryId]
    );
    defectivePr = { id: res.insertId, name: 'Defective PR' };
  }

  let [[stockArea]] = await connection.query(
    "SELECT id FROM stock_areas WHERE agency_id = ? LIMIT 1",
    [agencyId]
  );
  if (!stockArea) {
    [[stockArea]] = await connection.query("SELECT id FROM stock_areas LIMIT 1");
  }
  const stockAreaId = stockArea?.id;

  const [[normalStock]] = await connection.query(
    "SELECT id, quantity FROM stock WHERE product_id = ? AND agency_id = ? LIMIT 1",
    [normalPr.id, agencyId]
  );
  if (!normalStock) {
    await connection.query(
      "INSERT INTO stock (product_id, stock_area_id, quantity, system_quantity, empty_quantity, system_empty_quantity, agency_id) VALUES (?, ?, 50, 50, 0, 0, ?)",
      [normalPr.id, stockAreaId, agencyId]
    );
  }

  const [[defectiveStock]] = await connection.query(
    "SELECT id, quantity FROM stock WHERE product_id = ? AND agency_id = ? LIMIT 1",
    [defectivePr.id, agencyId]
  );
  if (!defectiveStock) {
    await connection.query(
      "INSERT INTO stock (product_id, stock_area_id, quantity, system_quantity, empty_quantity, system_empty_quantity, agency_id) VALUES (?, ?, 0, 0, 0, 0, ?)",
      [defectivePr.id, stockAreaId, agencyId]
    );
  }

  return { normalPrId: Number(normalPr.id), defectivePrId: Number(defectivePr.id) };
};

export const getPrStockSummary = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const agencyId = req.user?.agency_id || 1;
    const { normalPrId, defectivePrId } = await ensurePrProductsAndStock(connection, agencyId);

    const [[normalStock]] = await connection.query(
      "SELECT COALESCE(SUM(quantity), 0) AS qty FROM stock WHERE product_id = ? AND agency_id = ?",
      [normalPrId, agencyId]
    );
    const [[defectiveStock]] = await connection.query(
      "SELECT COALESCE(SUM(quantity), 0) AS qty FROM stock WHERE product_id = ? AND agency_id = ?",
      [defectivePrId, agencyId]
    );

    return res.status(200).json({
      success: true,
      data: {
        normalPrStock: Number(normalStock?.qty || 0),
        defectivePrStock: Number(defectiveStock?.qty || 0),
        normalPrId,
        defectivePrId,
      },
    });
  } catch (error) {
    console.error("getPrStockSummary error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch PR stock summary",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const createCustomerPenalty = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { customerId, penaltyReason, penaltyAmount, transactionType = "PENALTY", quantity = 1 } = req.body || {};

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

    const amount = Number(penaltyAmount || 0);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({
        success: false,
        message: "penaltyAmount must be a valid non-negative number",
      });
    }

    const agencyId = req.user.agency_id;
    const moveQty = Math.max(parseInt(quantity, 10) || 1, 1);

    const [customerRows] = await connection.query(
      `
      SELECT
        id,
        name,
        consumer_number AS consumer_number
      FROM users
      WHERE id = ? AND role = 'CUSTOMER' LIMIT 1
      `,
      [Number(customerId)]
    );

    if (!customerRows.length) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    const customer = customerRows[0];

    await connection.beginTransaction();

    const { normalPrId, defectivePrId } = await ensurePrProductsAndStock(connection, agencyId);

    // Record the penalty/replacement in customer_pr_penalties
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

    // Implement PR stock movements:
    if (transactionType === "REPLACEMENT") {
      // Customer brings defective PR: Defective PR stock increases, Normal PR decreases
      await connection.query(
        "UPDATE stock SET quantity = quantity + ?, updated_at = NOW() WHERE product_id = ? AND agency_id = ?",
        [moveQty, defectivePrId, agencyId]
      );
      await connection.query(
        "UPDATE stock SET quantity = GREATEST(quantity - ?, 0), updated_at = NOW() WHERE product_id = ? AND agency_id = ?",
        [moveQty, normalPrId, agencyId]
      );

      // Record in stock_transactions
      await connection.query(
        `INSERT INTO stock_transactions (agency_id, product_id, stock_area_id, quantity, type, stock_from, isApproved, is_defective, created_by)
         VALUES (?, ?, 1, ?, 'CUSTOMER_RETURN', 'customer', 1, 1, ?)`,
        [agencyId, defectivePrId, moveQty, req.user.id]
      );
      await connection.query(
        `INSERT INTO stock_transactions (agency_id, product_id, stock_area_id, quantity, type, stock_from, isApproved, is_defective, created_by)
         VALUES (?, ?, 1, ?, 'PURCHASE_RETURN', 'godown', 1, 0, ?)`,
        [agencyId, normalPrId, moveQty, req.user.id]
      );
    } else {
      // Normal Penalty / Lost PR: Normal PR stock decreases because a new one is issued
      await connection.query(
        "UPDATE stock SET quantity = GREATEST(quantity - ?, 0), updated_at = NOW() WHERE product_id = ? AND agency_id = ?",
        [moveQty, normalPrId, agencyId]
      );
      await connection.query(
        `INSERT INTO stock_transactions (agency_id, product_id, stock_area_id, quantity, type, stock_from, isApproved, is_defective, created_by)
         VALUES (?, ?, 1, ?, 'PURCHASE_RETURN', 'godown', 1, 0, ?)`,
        [agencyId, normalPrId, moveQty, req.user.id]
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: transactionType === "REPLACEMENT" ? "PR replacement recorded and stock updated" : "Penalty recorded and PR stock updated",
      data: {
        id: Number(result.insertId),
        paymentStatus: "UNPAID",
      },
    });
  } catch (error) {
    await connection.rollback();
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
