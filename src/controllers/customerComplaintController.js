import db from "../config/db.js";
import { searchCustomersList } from "../utils/customerLookup.js";

const ALLOWED_ISSUE_TYPES = [
  "LEAKAGE",
  "LATE_DELIVERY",
  "BILLING",
  "REGULATOR",
  "OTHER",
];

const ALLOWED_COMPLAINT_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED"];

// Maps UI-facing values to valid DB enum values
const ISSUE_TYPE_ALIASES = {
  CYLINDER_NOT_RECEIVED: "LATE_DELIVERY",
  BOOKING_DELAY: "LATE_DELIVERY",
  METER_ISSUE: "REGULATOR",
};

const normalizeIssueType = (raw) => {
  const upper = String(raw || "").trim().toUpperCase().replace(/\s+/g, "_");
  return ISSUE_TYPE_ALIASES[upper] ?? upper;
};

let hasAssignedToColumnCache = false;

const ensureAssignedToColumn = async (connection) => {
  if (hasAssignedToColumnCache) return;

  const [columnRows] = await connection.query("SHOW COLUMNS FROM customer_complaints LIKE 'assigned_to'");
  if (!columnRows.length) {
    await connection.query("ALTER TABLE customer_complaints ADD COLUMN assigned_to INT NULL AFTER status");
  }

  hasAssignedToColumnCache = true;
};

export const getComplaintIssueTypes = async (_req, res) => {
  return res.status(200).json({
    success: true,
    data: ALLOWED_ISSUE_TYPES,
  });
};

export const getComplaintCustomers = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const search = String(
      req.query.search ||
      req.query.consumerNumber ||
      req.query.phone ||
      req.query.phoneNumber ||
      ""
    ).trim();
    const limit = Math.max(parseInt(req.query.limit, 10) || 4, 1);
    const agencyId = req.user?.agency_id || null;

    const rows = await searchCustomersList(connection, {
      search,
      agencyId,
      limit,
    });

    return res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("getComplaintCustomers error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch customers",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getCustomerComplaints = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureAssignedToColumn(connection);

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
    const offset = (page - 1) * limit;
    const search = (req.query.search || "").trim();

    const agencyId = req.user.agency_id;

    const filters = [`cc.agency_id = ?`];
    const params = [agencyId];

    if (search) {
      filters.push(
        "(u.name LIKE ? OR cc.issue_type LIKE ? OR cc.description LIKE ? OR CONCAT('CMP-', LPAD(cc.id, 4, '0')) LIKE ? OR u.consumer_number LIKE ? OR u.phone LIKE ?)"
      );
      const likeSearch = `%${search}%`;
      params.push(likeSearch, likeSearch, likeSearch, likeSearch, likeSearch, likeSearch);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const [countRows] = await connection.query(
      `
      SELECT COUNT(*) AS total
      FROM customer_complaints cc
      INNER JOIN users u ON u.id = cc.customer_id
      ${whereClause}
      `,
      [...params]
    );

    const total = Number(countRows[0]?.total || 0);

    const [rows] = await connection.query(
      `
      SELECT
        cc.id,
        CONCAT('CMP-', LPAD(cc.id, 4, '0')) AS complaint_code,
        u.consumer_number AS consumer_number,
        u.name AS customer_name,
        u.phone AS customer_phone,
        u.email AS customer_email,
        COALESCE(a.address, '') AS address,
        cc.issue_type,
        cc.description,
        cc.priority,
        cc.approval_status,
        cc.status,
        CASE
          WHEN cc.assigned_to IS NOT NULL AND cc.status = 'OPEN' THEN 'ASSIGNED_TO_DELIVERY_BOY'
          ELSE cc.status
        END AS workflow_status,
        cc.assigned_to,
        ad.id AS driver_id,
        COALESCE(au.name, '') AS assigned_to_name,
        DATE_FORMAT(cc.created_at, '%Y-%m-%d %H:%i:%s') AS created_at
      FROM customer_complaints cc
      INNER JOIN users u ON u.id = cc.customer_id
      LEFT JOIN addresses a ON a.user_id = u.id AND a.is_default = 1
      LEFT JOIN users au ON au.id = cc.assigned_to
      LEFT JOIN drivers ad ON ad.user_id = cc.assigned_to
      ${whereClause}
      ORDER BY cc.created_at DESC, cc.id DESC
      LIMIT ?
      OFFSET ?
      `,
      [...params, limit, offset]
    );

    return res.status(200).json({
      success: true,
      data: rows,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("getCustomerComplaints error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch complaints",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const createCustomerComplaint = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { customerId, issueType, description } = req.body;

    if (!customerId || !issueType || !description?.trim()) {
      return res.status(400).json({
        success: false,
        message: "customerId, issueType and description are required",
      });
    }

    const normalizedIssueType = normalizeIssueType(issueType);

    if (!ALLOWED_ISSUE_TYPES.includes(normalizedIssueType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid issueType",
      });
    }

    const agencyId = req.user.agency_id;

    const [customerRows] = await connection.query(
      "SELECT id FROM users WHERE id = ? AND role = 'CUSTOMER' AND agency_id = ? LIMIT 1",
      [customerId, agencyId]
    );

    if (!customerRows.length) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    const priority = normalizedIssueType === "LEAKAGE" ? "HIGH" : "MEDIUM";

    const [result] = await connection.query(
      `
      INSERT INTO customer_complaints (
        customer_id,
        issue_type,
        description,
        priority,
        approval_status,
        status,
        agency_id
      ) VALUES (?, ?, ?, ?, 'PENDING', 'OPEN', ?)
      `,
      [customerId, normalizedIssueType, description.trim(), priority, agencyId]
    );

    return res.status(201).json({
      success: true,
      message: "Complaint registered successfully",
      data: {
        id: result.insertId,
        complaintCode: `CMP-${String(result.insertId).padStart(4, "0")}`,
        approvalStatus: "PENDING",
      },
    });
  } catch (error) {
    console.error("createCustomerComplaint error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to create complaint",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const assignComplaintToDeliveryBoy = async (req, res) => {
  const connection = await db.getConnection();

  try {
    await ensureAssignedToColumn(connection);

    const complaintId = Number(req.params.id);
    if (!Number.isInteger(complaintId) || complaintId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid complaint id",
      });
    }

    const driverId = Number(req.body?.driverId);
    if (!Number.isInteger(driverId) || driverId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Please select a valid driver",
      });
    }

    const agencyId = req.user.agency_id;

    const [complaintRows] = await connection.query(
      "SELECT id FROM customer_complaints WHERE id = ? AND agency_id = ? LIMIT 1",
      [complaintId, agencyId]
    );

    if (!complaintRows.length) {
      return res.status(404).json({
        success: false,
        message: "Complaint not found",
      });
    }

    const [driverRows] = await connection.query(
      `
      SELECT d.id AS driver_id, d.user_id, u.name
      FROM drivers d
      INNER JOIN users u ON u.id = d.user_id
      WHERE d.id = ? AND d.agency_id = ? AND u.role = 'DRIVER' AND u.status = 'ACTIVE'
      LIMIT 1
      `,
      [driverId, agencyId]
    );

    if (!driverRows.length) {
      return res.status(400).json({
        success: false,
        message: "Selected driver is not active or does not exist",
      });
    }

    const assignedDriverId = Number(driverRows[0].user_id);
    const assignedDriverName = driverRows[0].name || "Delivery Boy";

    // Keep assignment in pre-resolution stage; completion is handled separately.
    await connection.query(
      "UPDATE customer_complaints SET assigned_to = ?, status = 'OPEN' WHERE id = ?",
      [assignedDriverId, complaintId]
    );

    return res.status(200).json({
      success: true,
      message: "Complaint assigned to delivery boy",
      data: {
        complaintId,
        assignedTo: assignedDriverId,
        assignedToName: assignedDriverName,
        status: "ASSIGNED_TO_DELIVERY_BOY",
      },
    });
  } catch (error) {
    console.error("assignComplaintToDeliveryBoy error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to assign complaint",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const updateComplaintStatus = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const complaintId = Number(req.params.id);
    const nextStatus = String(req.body?.status || "").trim().toUpperCase();

    if (!Number.isInteger(complaintId) || complaintId <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid complaint id",
      });
    }

    if (!ALLOWED_COMPLAINT_STATUSES.includes(nextStatus)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status",
      });
    }

    const agencyId = req.user.agency_id;

    const [result] = await connection.query(
      "UPDATE customer_complaints SET status = ? WHERE id = ? AND agency_id = ?",
      [nextStatus, complaintId, agencyId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        success: false,
        message: "Complaint not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Complaint status updated successfully",
      data: {
        complaintId,
        status: nextStatus,
      },
    });
  } catch (error) {
    console.error("updateComplaintStatus error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update complaint status",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
