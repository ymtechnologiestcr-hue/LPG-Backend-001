import db from "../config/db.js";
import { getDriverCarryForward } from "../utils/driverCarryForward.js";

const getBatchNo = (saleId) => `B-${saleId}`;
const toNumber = (value) => Number(value || 0);
const DEFAULT_STOCK_AREA_ID = 1;
const getProductSizeFromName = (name = "") => {
  const match = String(name).match(/\d+\.?\d*\s?kg/i);
  return match ? match[0].replace(/\s/g, " ") : "";
};

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const getTodayIsoDate = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

// Normalises a DB timestamp/date into a local YYYY-MM-DD string so it can be
// compared against getTodayIsoDate() without timezone drift.
const toIsoDateString = (value) => {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return value.slice(0, 10);
  }

  const parsed = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, "0");
  const d = String(parsed.getDate()).padStart(2, "0");

  return `${y}-${m}-${d}`;
};

const resolveDateRange = (query = {}) => {
  const rawStartDate = String(query?.startDate || "");
  const rawEndDate = String(query?.endDate || "");

  const startDate = DATE_ONLY_REGEX.test(rawStartDate) ? rawStartDate : null;
  const endDate = DATE_ONLY_REGEX.test(rawEndDate) ? rawEndDate : null;

  if (!startDate && !endDate) {
    const today = getTodayIsoDate();
    return { startDate: today, endDate: today };
  }

  const computedStartDate = startDate || endDate;
  const computedEndDate = endDate || startDate;

  if (computedStartDate <= computedEndDate) {
    return { startDate: computedStartDate, endDate: computedEndDate };
  }

  return { startDate: computedEndDate, endDate: computedStartDate };
};

const resolveDriverId = async (value, queryRunner = db) => {
  const numericValue = Number(value);

  if (!numericValue || Number.isNaN(numericValue)) {
    return null;
  }

  const [driverRows] = await queryRunner.execute(
    `
    SELECT id
    FROM drivers
    WHERE id = ?
    LIMIT 1
    `,
    [numericValue],
  );

  if (driverRows.length) {
    return Number(driverRows[0].id);
  }

  const [userMappedRows] = await queryRunner.execute(
    `
    SELECT id
    FROM drivers
    WHERE user_id = ?
    LIMIT 1
    `,
    [numericValue],
  );

  if (userMappedRows.length) {
    return Number(userMappedRows[0].id);
  }

  // Self-healing: if the user is a driver in users table but missing from drivers table, create the driver record
  try {
    const [userRows] = await queryRunner.execute(
      `
      SELECT id, role
      FROM users
      WHERE id = ?
        AND role IN ('DRIVER', 'DELIVERY_AGENT')
      LIMIT 1
      `,
      [numericValue],
    );

    if (userRows.length) {
      const [insertRes] = await queryRunner.execute(
        `
        INSERT INTO drivers (user_id, is_available, rating, created_at)
        VALUES (?, 1, 0.0, NOW())
        `,
        [userRows[0].id],
      );
      if (insertRes.insertId) {
        return Number(insertRes.insertId);
      }
    }
  } catch (err) {
    console.warn("Could not auto-create missing driver record:", err);
  }

  return null;
};

const reserveStockForBooking = async (connection, productId, requiredQty) => {
  let remaining = Number(requiredQty || 0);

  if (remaining <= 0) {
    return;
  }

  const [availableRows] = await connection.execute(
    `
    SELECT COALESCE(SUM(quantity), 0) AS available_qty
    FROM stock
    WHERE product_id = ?
    FOR UPDATE
    `,
    [Number(productId)],
  );

  const availableQty = Number(availableRows[0]?.available_qty || 0);

  if (availableQty < remaining) {
    throw new Error(
      `Insufficient stock for product ${productId}. Available ${availableQty}, required ${remaining}`,
    );
  }

  const [rows] = await connection.execute(
    `
    SELECT id, COALESCE(quantity, 0) AS quantity
    FROM stock
    WHERE product_id = ?
    ORDER BY (stock_area_id = ?) DESC, id ASC
    FOR UPDATE
    `,
    [Number(productId), DEFAULT_STOCK_AREA_ID],
  );

  for (const row of rows) {
    if (remaining <= 0) {
      break;
    }

    const currentQty = Number(row.quantity || 0);

    if (currentQty <= 0) {
      continue;
    }

    const deductQty = Math.min(currentQty, remaining);

    await connection.execute(
      `
      UPDATE stock
      SET quantity = GREATEST(COALESCE(quantity, 0) - ?, 0),
          updated_at = NOW()
      WHERE id = ?
      `,
      [deductQty, row.id],
    );

    remaining -= deductQty;
  }
};

const restoreStockForBooking = async (connection, productId, quantity) => {
  const qty = Number(quantity || 0);

  if (qty <= 0) {
    return;
  }

  const [rows] = await connection.execute(
    `
    SELECT id
    FROM stock
    WHERE product_id = ?
    ORDER BY (stock_area_id = ?) DESC, id ASC
    LIMIT 1
    FOR UPDATE
    `,
    [Number(productId), DEFAULT_STOCK_AREA_ID],
  );

  if (rows.length) {
    await connection.execute(
      `
      UPDATE stock
      SET quantity = COALESCE(quantity, 0) + ?,
          updated_at = NOW()
      WHERE id = ?
      `,
      [qty, rows[0].id],
    );
    return;
  }

  await connection.execute(
    `
    INSERT INTO stock
    (
      product_id,
      stock_area_id,
      quantity,
      empty_quantity,
      defective_quantity
    )
    VALUES (?, ?, ?, 0, 0)
    `,
    [Number(productId), DEFAULT_STOCK_AREA_ID, qty],
  );
};

const addEmptyStockToGodown = async (connection, productId, qty) => {
  const quantity = Number(qty || 0);

  if (!quantity || quantity <= 0) {
    return;
  }

  const [rows] = await connection.execute(
    `
    SELECT id
    FROM stock
    WHERE product_id = ?
    ORDER BY id ASC
    LIMIT 1
    FOR UPDATE
    `,
    [Number(productId)],
  );

  if (rows.length) {
    await connection.execute(
      `
      UPDATE stock
      SET empty_quantity = COALESCE(empty_quantity, 0) + ?,
          updated_at = NOW()
      WHERE id = ?
      `,
      [quantity, rows[0].id],
    );
    return;
  }

  await connection.execute(
    `
    INSERT INTO stock
    (
      product_id,
      stock_area_id,
      quantity,
      empty_quantity,
      defective_quantity
    )
    VALUES (?, NULL, 0, ?, 0)
    `,
    [Number(productId), quantity],
  );
};

export const getDriverDashboard = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = "", startDate, endDate } = req.query;

    const offset = (page - 1) * limit;

    // =========================
    // DATE FILTER
    // =========================
    let dateFilter = "";
    let dateValues = [];

    if (startDate && endDate) {
      dateFilter = `AND DATE(s.delivered_at) BETWEEN ? AND ?`;
      dateValues = [startDate, endDate];
    }

    // =========================
    // SEARCH FILTER
    // =========================
    let searchFilter = "";
    let searchValues = [];

    if (search) {
      searchFilter = `AND u.name LIKE ?`;
      searchValues = [`%${search}%`];
    }

    // =========================
    // SUMMARY CARDS
    // =========================
    const [summary] = await db.query(
      `
      SELECT 
        COUNT(DISTINCT d.id) AS totalDrivers,

        COUNT(DISTINCT CASE 
          WHEN u.status = 'ACTIVE' AND d.is_available = 1 THEN d.id 
        END) AS activeToday,

        COALESCE(SUM(CASE 
          WHEN s.status = 'DELIVERED' 
          ${startDate && endDate ? "AND DATE(s.delivered_at) BETWEEN ? AND ?" : ""}
          THEN si.quantity ELSE 0 
        END), 0) AS deliveredToday,

        COALESCE(SUM(CASE 
          WHEN s.status = 'ASSIGNED' 
          THEN si.quantity ELSE 0 
        END), 0) AS cylindersInHand

      FROM drivers d
      JOIN users u ON d.user_id = u.id
      LEFT JOIN sales s ON s.driver_id = d.id
      LEFT JOIN sales_items si ON si.sale_id = s.id
      WHERE d.agency_id = ?
      `,
      [...dateValues, req.user.agency_id]
    );

    // =========================
    // DRIVER TABLE DATA
    // =========================
    const [drivers] = await db.query(
      `
      SELECT 
        d.id,
        u.name,
        u.phone,
        d.rating,
        u.status,
        d.is_available,
        d.vehicle_number,

        COALESCE(SUM(CASE 
          WHEN s.status = 'DELIVERED'
          ${dateFilter}
          THEN si.quantity ELSE 0 
        END), 0) AS deliveriesToday,

        COALESCE(SUM(CASE 
          WHEN s.status = 'ASSIGNED' 
          THEN si.quantity ELSE 0 
        END), 0) AS inHand

      FROM drivers d
      JOIN users u ON d.user_id = u.id
      LEFT JOIN sales s ON s.driver_id = d.id
      LEFT JOIN sales_items si ON si.sale_id = s.id

      WHERE d.agency_id = ?
      ${searchFilter}

      GROUP BY d.id, u.name, u.phone, d.rating, u.status, d.is_available, d.vehicle_number
      ORDER BY deliveriesToday DESC

      LIMIT ? OFFSET ?
      `,
      [...dateValues, req.user.agency_id, ...searchValues, Number(limit), Number(offset)],
    );

    console.log({ drivers });
    // =========================
    // COUNT FOR PAGINATION
    // =========================
    const [countResult] = await db.query(
      `
      SELECT COUNT(*) AS total
      FROM drivers d
      JOIN users u ON d.user_id = u.id
      WHERE d.agency_id = ?
      ${searchFilter}
      `,
      [req.user.agency_id, ...searchValues],
    );

    return res.json({
      success: true,
      summary: {
        totalDrivers: summary[0].totalDrivers || 0,
        activeToday: summary[0].activeToday || 0,
        deliveredToday: summary[0].deliveredToday || 0,
        cylindersInHand: summary[0].cylindersInHand || 0,
      },
      data: drivers,
      pagination: {
        total: countResult[0].total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(countResult[0].total / limit),
      },
    });
  } catch (error) {
    console.error("Driver Dashboard Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
};

export const createDriver = async (req, res) => {
  try {
    const {
      user_id,
      vehicle_number,
      license_number,
      is_available = 1,
      rating = 0,
    } = req.body;

    // =========================
    // VALIDATION
    // =========================
    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: "user_id is required",
      });
    }

    // =========================
    // INSERT DRIVER
    // =========================
    const [result] = await db.execute(
      `
      INSERT INTO drivers 
      (user_id, vehicle_number, license_number, is_available, rating, created_at)
      VALUES (?, ?, ?, ?, ?, NOW())
      `,
      [
        user_id,
        vehicle_number || null,
        license_number || null,
        is_available,
        rating,
      ],
    );

    return res.status(201).json({
      success: true,
      message: "Driver created successfully",
      driver_id: result.insertId,
    });
  } catch (error) {
    console.error("Create Driver Error:", error);
    res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
};

export const findCustomerForDriverApp = async (req, res) => {
  try {
    const { query } = req.query;

    if (!query || !String(query).trim()) {
      return res.status(400).json({
        success: false,
        message: "query is required",
      });
    }

    const searchValue = String(query).trim();

    const [rows] = await db.execute(
      `
      SELECT
        u.id,
        u.name,
        u.phone,
        u.email,
        a.address
      FROM users u
      LEFT JOIN addresses a
        ON a.user_id = u.id
      WHERE u.role = 'CUSTOMER'
        AND (
          u.phone = ?
          OR u.consumer_number = ?
          OR u.consumer_number REGEXP CONCAT('^[^0-9]*', ?, '$')
        )
      ORDER BY a.is_default DESC, a.id DESC
      LIMIT 1
      `,
      [searchValue, searchValue, searchValue],
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Customer found successfully",
      data: {
        id: Number(rows[0].id),
        name: rows[0].name,
        phone: rows[0].phone,
        email: rows[0].email,
        address: rows[0].address || "",
      },
    });
  } catch (error) {
    console.error("findCustomerForDriverApp error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to find customer",
      error: error.message,
    });
  }
};

export const getDriverDeliveriesApp = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { flag } = req.query;
    const { startDate, endDate } = resolveDateRange(req.query);

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "driverId is required",
      });
    }

    const numericDriverId = await resolveDriverId(driverId);

    if (!numericDriverId) {
      return res.status(400).json({
        success: false,
        message: "Valid driverId is required",
      });
    }

    const [statsRows] = await db.execute(
      `
      SELECT
        COALESCE(SUM(batch_stats.allocated_qty), 0) AS allocated,
        COALESCE(SUM(batch_stats.return_qty), 0) AS returned,
        COALESCE(SUM(batch_stats.defective_qty), 0) AS defective
      FROM (
        SELECT
          asi.id,
          COALESCE(asi.quantity, 0) AS allocated_qty,
          COALESCE(return_data.return_qty, 0) AS return_qty,
          COALESCE(return_data.defective_qty, 0) AS defective_qty
        FROM sales_items asi
        INNER JOIN sales a ON a.id = asi.sale_id
        LEFT JOIN (
          SELECT
            st.allocation_sales_item_id,
            SUM(CASE WHEN st.is_defective = 0 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS return_qty,
            SUM(CASE WHEN st.is_defective = 1 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS defective_qty
          FROM stock_transactions st
          WHERE st.driver_id = ?
            AND st.stock_from = 'driver'
            AND st.type = 'PURCHASE_RETURN'
            AND st.isApproved IN (0, 1)
            AND st.allocation_sales_item_id IS NOT NULL
          GROUP BY st.allocation_sales_item_id
        ) return_data ON return_data.allocation_sales_item_id = asi.id
        WHERE a.driver_id = ?
          AND a.status = 'ASSIGNED'
          AND asi.allocation_sales_item_id IS NULL
          AND DATE(COALESCE(a.assigned_at, a.created_at)) BETWEEN ? AND ?
      ) batch_stats
      `,
      [numericDriverId, numericDriverId, startDate, endDate],
    );

    // Delivered: actual DELIVERED sales in the date range — same source as the delivered list page
    const [deliveredRows] = await db.execute(
      `
      SELECT COALESCE(SUM(si.delivered_qty), 0) AS delivered
      FROM sales s
      INNER JOIN sales_items si ON si.sale_id = s.id
      WHERE s.driver_id = ?
        AND s.status = 'DELIVERED'
        AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?
      `,
      [numericDriverId, startDate, endDate],
    );

    // Dashboard collection should match driver collection flow:
    // include ASSIGNED (not yet sent) + PENDING (sent, awaiting cashier approval).
    const [pendingCollectionRows] = await db.execute(
      `
      SELECT COALESCE(SUM(sh.amount), 0) AS pending_collection
      FROM settlement_history sh
      WHERE sh.driver_id = ?
        AND sh.status IN ('ASSIGNED', 'PENDING')
        AND DATE(sh.created_at) BETWEEN ? AND ?
      `,
      [numericDriverId, startDate, endDate],
    );

    let statusFilterQuery = "";

    if (flag === "allocated") {
      statusFilterQuery = `
        AND s.status IN ('PENDING', 'ASSIGNED')
        AND si.status IN ('PENDING', 'ASSIGNED')
      `;
    } else {
      statusFilterQuery = `
        AND s.status = 'DELIVERED'
        AND si.status = 'DELIVERED'
      `;
    }

    const [deliveryRows] = await db.execute(
      `
      SELECT
        s.id AS sale_id,
        u.name AS customer_name,
        u.consumer_number,
        a.address,
        COALESCE(
          GROUP_CONCAT(DISTINCT pr.name ORDER BY pr.name SEPARATOR ', '),
          'N/A'
        ) AS product_name,
        COALESCE(SUM(si.delivered_qty), 0) AS quantity,
        COALESCE(MAX(pr.type), 'N/A') AS cylinder_type,
        s.status AS raw_status,
        CASE
          WHEN s.status = 'DELIVERED' THEN 'Delivered'
          WHEN s.status = 'ASSIGNED' THEN 'Pending'
          WHEN s.status = 'PENDING' THEN 'Pending'
          ELSE s.status
        END AS display_status,
        COALESCE(s.total_amount, 0) AS total_amount,
        s.created_at,
        s.delivered_at,
        CASE
          WHEN s.payment_method = 'ONLINE' THEN 'ONLINE'
          ELSE COALESCE(
            MAX(CASE WHEN p.status = 'SUCCESS' THEN p.method ELSE NULL END),
            s.payment_method,
            'N/A'
          )
        END AS payment_mode
      FROM sales s
      LEFT JOIN users u ON u.id = s.customer_id
      LEFT JOIN addresses a ON a.id = s.address_id
      LEFT JOIN sales_items si ON si.sale_id = s.id
      LEFT JOIN products pr ON pr.id = si.product_id
      LEFT JOIN payments p ON p.sale_id = s.id
      WHERE s.driver_id = ?
        ${statusFilterQuery}
        AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?
      GROUP BY
        s.id,
        u.name,
        u.consumer_number,
        a.address,
        s.status,
        s.total_amount,
        s.created_at,
        s.delivered_at,
        s.payment_method
      ORDER BY COALESCE(s.delivered_at, s.created_at) DESC, s.id DESC
      `,
      [numericDriverId, startDate, endDate],
    );

    // Cylinders the driver was still holding when the range opened. They are
    // carried forward and counted as allocated for this range.
    const { total: carriedForward } = await getDriverCarryForward(db, {
      driverId: numericDriverId,
      asOfDate: startDate,
      openingBalance: true,
    });

    // Batch-linked deliveries and returns that happened inside the range, so
    // clearing carried-forward stock lowers the in-hand figure for this range.
    const [batchDeliveredRows] = await db.execute(
      `
      SELECT COALESCE(SUM(COALESCE(child.delivered_qty, child.quantity, 0)), 0) AS delivered
      FROM sales_items child
      INNER JOIN sales cs ON cs.id = child.sale_id
      WHERE cs.driver_id = ?
        AND cs.status = 'DELIVERED'
        AND child.allocation_sales_item_id IS NOT NULL
        AND DATE(COALESCE(cs.delivered_at, cs.created_at)) BETWEEN ? AND ?
      `,
      [numericDriverId, startDate, endDate],
    );

    const [batchReturnedRows] = await db.execute(
      `
      SELECT
        COALESCE(SUM(
          CASE WHEN st.is_defective = 0 THEN COALESCE(st.quantity, 0) ELSE 0 END
        ), 0) AS returned,
        COALESCE(SUM(
          CASE WHEN st.is_defective = 1 THEN COALESCE(st.quantity, 0) ELSE 0 END
        ), 0) AS defective
      FROM stock_transactions st
      WHERE st.driver_id = ?
        AND st.stock_from = 'driver'
        AND st.type = 'PURCHASE_RETURN'
        AND st.isApproved IN (0, 1)
        AND st.allocation_sales_item_id IS NOT NULL
        AND DATE(st.created_at) BETWEEN ? AND ?
      `,
      [numericDriverId, startDate, endDate],
    );

    const allocatedInRange = Number(statsRows[0]?.allocated || 0);
    const allocated = allocatedInRange + carriedForward;
    const returned = Number(statsRows[0]?.returned || 0);
    const defective = Number(statsRows[0]?.defective || 0);

    // delivered: from actual delivered sales in date range
    const delivered = Number(deliveredRows[0]?.delivered || 0);

    // inHand: opening balance + this range's allocations, minus everything
    // delivered or returned during the range.
    const ihAllocated = allocated;
    const ihDelivered = Number(batchDeliveredRows[0]?.delivered || 0);
    const ihReturned = Number(batchReturnedRows[0]?.returned || 0);
    const ihDefective = Number(batchReturnedRows[0]?.defective || 0);
    const inHand = Math.max(
      ihAllocated - ihDelivered - ihReturned - ihDefective,
      0,
    );
    const inHandOriginal = Math.max(ihAllocated, 0);

    // empties: collected from customers in date range
    const [emptiesCollectedRows] = await db.execute(
      `
      SELECT COALESCE(SUM(si.empty_cylinder_qty), 0) AS collected
      FROM sales s
      INNER JOIN sales_items si ON si.sale_id = s.id
      WHERE s.driver_id = ?
        AND s.status = 'DELIVERED'
        AND si.empty_cylinder_status IN ('DELIVERED', 'PARTIAL_DELIVERED')
        AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?
      `,
      [numericDriverId, startDate, endDate],
    );

    // Returned empties count only APPROVED explicit empty return requests, so the
    // driver's returned/in-hand numbers match what the godown has actually received.
    const [emptiesReturnedRows] = await db.execute(
      `
      SELECT COALESCE(SUM(st.quantity), 0) AS returned
      FROM stock_transactions st
      LEFT JOIN sales linked_sale
        ON linked_sale.id = st.reference_id
       AND linked_sale.driver_id = st.driver_id
      WHERE st.driver_id = ?
        AND st.stock_from = 'driver'
        AND st.type = 'EMPTY_RETURN'
        AND COALESCE(st.isApproved, 0) = 1
        AND linked_sale.id IS NULL
        AND DATE(st.created_at) BETWEEN ? AND ?
      `,
      [numericDriverId, startDate, endDate],
    );

    const emptiesOriginal = Number(emptiesCollectedRows[0]?.collected || 0);
    const emptiesReturned = Number(emptiesReturnedRows[0]?.returned || 0);
    const empties = Math.max(emptiesOriginal - emptiesReturned, 0);

    const pendingCollection = Number(
      pendingCollectionRows[0]?.pending_collection || 0,
    );

    // System stock for this driver: quantity of products sold on sales whose
    // IOC OTP has been marked SENT from the customer-issues dashboard, scoped to
    // the same date range as the other stats (by sale delivered/created date).
    const [systemStockRows] = await db.execute(
      `
      SELECT COALESCE(SUM(si.quantity), 0) AS system_stock
      FROM sales s
      INNER JOIN sales_items si ON si.sale_id = s.id
      WHERE s.driver_id = ?
        AND EXISTS (
          SELECT 1 FROM driver_sale_otps dso
          WHERE dso.sale_id = s.id AND dso.status = 'SENT'
        )
        AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?
      `,
      [numericDriverId, startDate, endDate],
    );

    const systemStock = Number(systemStockRows[0]?.system_stock || 0);

    const stats = {
      allocated,
      allocatedToday: allocatedInRange,
      carriedForward,
      delivered,
      pendingCollection,
      empties,
      emptiesOriginal,
      inHand,
      inHandOriginal,
      systemStock,
      newDelivery: 0,
    };

    const deliveries = deliveryRows.map((item) => ({
      saleId: Number(item.sale_id),
      customerName: item.customer_name || "Unknown Customer",
      consumerNumber: item.consumer_number || null,
      address: item.address || "No address available",
      product: item.product_name || "N/A",
      quantity: Number(item.quantity || 0),
      rawStatus: item.raw_status,
      status: item.display_status,
      totalAmount: Number(item.total_amount || 0),
      createdAt: item.created_at,
      deliveredAt: item.delivered_at,
      paymentMode: item.payment_mode || "N/A",
      showMarkDelivered: item.raw_status !== "DELIVERED",
      cylinderType: item.cylinder_type || "N/A",
    }));

    return res.status(200).json({
      success: true,
      message: "Driver deliveries fetched successfully",
      data: {
        flag: flag || null,
        stats,
        deliveries,
      },
    });
  } catch (error) {
    console.error("getDriverDeliveriesApp error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch driver deliveries",
      error: error.message,
    });
  }
};

export const markSaleAsDelivered = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { saleId } = req.params;
    const {
      saleIds,
      payment_method,
      empty_cylinder_qty = 0,
      empty_product_id,
      created_by,
    } = req.body || {};

    // =====================================================
    // BULK MODE
    // PUT /drivers/sales/deliver
    // =====================================================
    if (!saleId) {
      if (!Array.isArray(saleIds) || !saleIds.length) {
        return res.status(400).json({
          success: false,
          message: "saleId param or saleIds array is required",
        });
      }

      const numericSaleIds = saleIds
        .map((id) => Number(id))
        .filter((id) => !Number.isNaN(id));

      if (!numericSaleIds.length) {
        return res.status(400).json({
          success: false,
          message: "saleIds must contain valid numeric ids",
        });
      }

      const placeholders = numericSaleIds.map(() => "?").join(",");

      const [existingRows] = await connection.execute(
        `
        SELECT id, status
        FROM sales
        WHERE id IN (${placeholders})
        `,
        numericSaleIds,
      );

      if (!existingRows.length) {
        return res.status(404).json({
          success: false,
          message: "No matching sales found",
        });
      }

      const updatableIds = existingRows
        .filter(
          (item) => item.status === "PENDING" || item.status === "ASSIGNED",
        )
        .map((item) => item.id);

      if (!updatableIds.length) {
        return res.status(200).json({
          success: true,
          message: "No pending or assigned sales to update",
          data: {
            updatedCount: 0,
            mode: "bulk",
            saleIds: [],
          },
        });
      }

      const updatePlaceholders = updatableIds.map(() => "?").join(",");

      const [updateResult] = await connection.execute(
        `
        UPDATE sales
        SET status = 'DELIVERED',
            delivered_at = NOW()
        WHERE id IN (${updatePlaceholders})
        `,
        updatableIds,
      );

      return res.status(200).json({
        success: true,
        message: "Sales marked as delivered successfully",
        data: {
          updatedCount: updateResult.affectedRows || 0,
          mode: "bulk",
          saleIds: updatableIds,
        },
      });
    }

    // =====================================================
    // SINGLE MODE
    // PUT /drivers/sale/:saleId/deliver
    // =====================================================
    const numericSaleId = Number(saleId);

    if (Number.isNaN(numericSaleId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid saleId",
      });
    }

    const numericEmptyQty = Number(empty_cylinder_qty || 0);

    if (Number.isNaN(numericEmptyQty) || numericEmptyQty < 0) {
      return res.status(400).json({
        success: false,
        message: "empty_cylinder_qty must be a valid non-negative number",
      });
    }

    await connection.beginTransaction();

    const [saleRows] = await connection.execute(
      `
      SELECT id, status, total_amount, driver_id
      FROM sales
      WHERE id = ?
      FOR UPDATE
      `,
      [numericSaleId],
    );

    if (!saleRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Sale not found",
      });
    }

    // update sale status always
    await connection.execute(
      `
      UPDATE sales
      SET status = 'DELIVERED',
          delivered_at = NOW()
      WHERE id = ?
      `,
      [numericSaleId],
    );

    // update payment status only, as requested
    await connection.execute(
      `
      UPDATE payments
      SET status = 'SUCCESS'
      WHERE sale_id = ?
      `,
      [numericSaleId],
    );

    // Empty cylinders collected during delivery are tracked on sales_items.
    // A godown return request is created only from the explicit return flow.
    await connection.execute(
      `
      UPDATE sales_items
      SET empty_cylinder_qty = ?,
          empty_cylinder_status = CASE
            WHEN ? <= 0 THEN 'PENDING'
            WHEN ? >= quantity THEN 'DELIVERED'
            ELSE 'PARTIAL_DELIVERED'
          END,
          delivered_qty = quantity
      WHERE sale_id = ?
      `,
      [numericEmptyQty, numericEmptyQty, numericEmptyQty, numericSaleId],
    );

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "Sale marked as delivered successfully",
      data: {
        updatedCount: 1,
        mode: "single",
        saleId: numericSaleId,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("markSaleAsDelivered error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update delivery status",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

const getEmptyCylinderStatus = (orderedQty, emptyQty) => {
  const ordered = Number(orderedQty || 0);
  const empty = Number(emptyQty || 0);

  if (empty === 0) return "PENDING";

  if (empty === ordered) return "DELIVERED";

  if (empty > 0 && empty < ordered) return "PARTIAL_DELIVERED";

  return "PENDING";
};

export const createDriverSale = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      driver_id,
      customer_name,
      phone,
      address,

      cylinder_type,
      product_id,
      quantity = 1,

      payment_method = "CASH",
      amount = 0,

      empty_cylinder_collected = false,
      delivered_qty = 1,
      empty_cylinder_qty = 0,
      empty_cylinder_status,
      defective_qty = 0,

      allocation_sale_id = null,
      allocation_sales_item_id = null,
      batch_no = null,
      otp = null,
      customer_id = null,
    } = req.body;

    const numericDriverId = await resolveDriverId(driver_id, connection);
    const numericProductId = Number(product_id);
    const numericQuantity = Number(quantity || 1);
    const requestedAmount = Number(amount || 0);
    const numericDeliveredQty = Number(delivered_qty || numericQuantity);
    const numericEmptyCylinderQty = Number(empty_cylinder_qty || 0);
    const numericDefectiveQty = Number(defective_qty || 0);

    if (!numericDriverId) {
      return res.status(400).json({
        success: false,
        message: "valid driver_id is required",
      });
    }

    // Fetch the driver's user_id and agency_id so they can be used for attribution
    const [driverUserRows] = await connection.execute(
      `SELECT d.user_id, u.agency_id FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.id = ? LIMIT 1`,
      [numericDriverId],
    );
    const driverUserId = driverUserRows[0]?.user_id || null;
    const agencyId = req.user?.agency_id || driverUserRows[0]?.agency_id || 1;

    if (!allocation_sales_item_id) {
      return res.status(400).json({
        success: false,
        message: "Please select a cylinder batch",
      });
    }

    if (!customer_name || !address) {
      return res.status(400).json({
        success: false,
        message: "customer_name and address are required",
      });
    }

    if (!numericProductId) {
      return res.status(400).json({
        success: false,
        message: "product_id is required",
      });
    }

    if (!numericQuantity || numericQuantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "quantity must be greater than 0",
      });
    }

    const normalizedOtp = String(otp || "").trim();

    // Idempotency / Duplicate Check
    // If the exact same driver creates a sale for the exact same product and quantity
    // with the exact same allocation or OTP within the last 1 minute,
    // we consider it a duplicate retry from a frontend timeout and safely return success.
    let duplicateCheckRows = [];

    if (allocation_sales_item_id) {
      // Fast path: check by allocation_sales_item_id (no OTP table join needed)
      [duplicateCheckRows] = await connection.execute(
        `
        SELECT s.id
        FROM sales s
        JOIN sales_items si ON s.id = si.sale_id
        WHERE s.driver_id = ?
          AND si.product_id = ?
          AND si.quantity = ?
          AND si.allocation_sales_item_id = ?
          AND s.created_at >= NOW() - INTERVAL 1 MINUTE
        LIMIT 1
        `,
        [numericDriverId, numericProductId, numericQuantity, Number(allocation_sales_item_id)]
      );
    } else if (normalizedOtp) {
      // Fallback: check by OTP when no allocation
      [duplicateCheckRows] = await connection.execute(
        `
        SELECT s.id
        FROM sales s
        JOIN sales_items si ON s.id = si.sale_id
        JOIN driver_sale_otps dso ON dso.sale_id = s.id
        WHERE s.driver_id = ?
          AND si.product_id = ?
          AND si.quantity = ?
          AND si.allocation_sales_item_id IS NULL
          AND dso.otp = ?
          AND s.created_at >= NOW() - INTERVAL 1 MINUTE
        LIMIT 1
        `,
        [numericDriverId, numericProductId, numericQuantity, normalizedOtp]
      );
    }

    if (duplicateCheckRows.length) {
      connection.release();
      return res.status(200).json({
        success: true,
        message: "Sale created successfully (duplicate request handled)",
        data: { saleId: duplicateCheckRows[0].id }
      });
    }

    await connection.beginTransaction();

    const [productRows] = await connection.execute(
      `
      SELECT id, name, type, price
      FROM products
      WHERE id = ?
      LIMIT 1
      `,
      [numericProductId],
    );

    if (!productRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const selectedProduct = productRows[0];

    if (allocation_sales_item_id) {
      const [batchRows] = await connection.execute(
        `
        SELECT
          asi.id AS allocation_sales_item_id,
          asi.sale_id AS allocation_sale_id,
          COALESCE(asi.batch_no, CONCAT('B-', asi.sale_id)) AS batch_no,
          asi.product_id,
          COALESCE(asi.quantity, 0) AS total_allocated,

          COALESCE(delivered_data.delivered_qty, 0) AS delivered_qty,
          COALESCE(return_data.return_qty, 0) AS return_qty,
          COALESCE(return_data.defective_qty, 0) AS defective_qty

        FROM sales_items asi
        INNER JOIN sales a
          ON a.id = asi.sale_id

        LEFT JOIN (
          SELECT
            child.allocation_sales_item_id,
            SUM(COALESCE(child.delivered_qty, child.quantity, 0)) AS delivered_qty
          FROM sales_items child
          INNER JOIN sales cs
            ON cs.id = child.sale_id
          WHERE child.allocation_sales_item_id = ?
            AND cs.status = 'DELIVERED'
          GROUP BY child.allocation_sales_item_id
        ) delivered_data
          ON delivered_data.allocation_sales_item_id = asi.id

        LEFT JOIN (
          SELECT
            st.allocation_sales_item_id,
            SUM(CASE WHEN st.is_defective = 0 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS return_qty,
            SUM(CASE WHEN st.is_defective = 1 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS defective_qty
          FROM stock_transactions st
          WHERE st.allocation_sales_item_id = ?
            AND st.stock_from = 'driver'
            AND st.type = 'PURCHASE_RETURN'
            AND st.isApproved IN (0, 1)
          GROUP BY st.allocation_sales_item_id
        ) return_data
          ON return_data.allocation_sales_item_id = asi.id

        WHERE asi.id = ?
          AND a.driver_id = ?
          AND a.status = 'ASSIGNED'
          AND asi.allocation_sales_item_id IS NULL
        LIMIT 1
        FOR UPDATE
        `,
        [
          Number(allocation_sales_item_id),
          Number(allocation_sales_item_id),
          Number(allocation_sales_item_id),
          numericDriverId
        ],
      );

      if (!batchRows.length) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: "Selected batch not found",
        });
      }

      const batch = batchRows[0];

      if (Number(batch.product_id) !== numericProductId) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: "Selected batch product does not match selected product",
        });
      }

      const pending =
        toNumber(batch.total_allocated) -
        toNumber(batch.delivered_qty) -
        toNumber(batch.return_qty) -
        toNumber(batch.defective_qty);

      if (numericQuantity > pending) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Only ${pending} cylinder(s) available in selected batch`,
        });
      }
    }

    let customerId = customer_id ? Number(customer_id) : null;

    if (!customerId && allocation_sale_id) {
      const [origSaleRows] = await connection.execute(
        `SELECT customer_id FROM sales WHERE id = ? LIMIT 1`,
        [Number(allocation_sale_id)],
      );
      if (origSaleRows.length && origSaleRows[0].customer_id) {
        customerId = origSaleRows[0].customer_id;
      }
    }

    let existingCustomers = [];

    if (!customerId && phone && String(phone).trim() !== "") {
      [existingCustomers] = await connection.execute(
        `
        SELECT id
        FROM users
        WHERE phone = ?
        LIMIT 1
        `,
        [phone],
      );
    }

    if (!customerId) {
      if (existingCustomers.length) {
        customerId = existingCustomers[0].id;

        await connection.execute(
          `
          UPDATE users
          SET name = ?, role = 'CUSTOMER'
          WHERE id = ?
          `,
          [customer_name, customerId],
        );
      } else {
        const [customerResult] = await connection.execute(
          `
          INSERT INTO users
          (
            agency_id,
            name,
            phone,
            role,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, 'CUSTOMER', NOW(), NOW())
          `,
          [agencyId, customer_name, phone || null],
        );

        customerId = customerResult.insertId;
      }
    }

    let addressId = null;

    const [addressRows] = await connection.execute(
      `
      SELECT id
      FROM addresses
      WHERE user_id = ?
        AND address = ?
      LIMIT 1
      `,
      [customerId, address],
    );

    if (addressRows.length) {
      addressId = addressRows[0].id;
    } else {
      const [addressResult] = await connection.execute(
        `
        INSERT INTO addresses
        (
          user_id,
          address,
          created_at,
          updated_at
        )
        VALUES (?, ?, NOW(), NOW())
        `,
        [customerId, address],
      );

      addressId = addressResult.insertId;
    }

    const unitPrice = Number(selectedProduct.price || 0);
    const finalAmount =
      unitPrice > 0 ? unitPrice * numericQuantity : requestedAmount;

    const [saleResult] = await connection.execute(
      `
      INSERT INTO sales
      (
        agency_id,
        customer_id,
        driver_id,
        address_id,
        total_amount,
        payment_method,
        status,
        created_at,
        updated_at,
        delivered_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'DELIVERED', NOW(), NOW(), NOW())
      `,
      [agencyId, customerId, numericDriverId, addressId, finalAmount, payment_method],
    );

    const saleId = saleResult.insertId;

    // Diagnostic: makes it visible in server logs whether the client actually
    // sent the OTP for this sale (the IOC OTP row is only created when it did).
    console.log(
      `createDriverSale: saleId=${saleId} agencyId=${agencyId} otpReceived=${normalizedOtp ? "yes" : "no"} otpLength=${normalizedOtp.length}`,
    );

    await connection.execute(
      `
      INSERT INTO driver_sale_otps
      (
        agency_id,
        sale_id,
        otp,
        status
      )
      VALUES (?, ?, ?, 'PENDING')
      `,
      [agencyId, saleId, normalizedOtp],
    );

    const finalEmptyCylinderStatus =
      empty_cylinder_status ||
      (numericEmptyCylinderQty <= 0
        ? "PENDING"
        : numericEmptyCylinderQty >= numericQuantity
          ? "DELIVERED"
          : "PARTIAL_DELIVERED");

    const finalBatchNo =
      batch_no || (allocation_sale_id ? getBatchNo(allocation_sale_id) : null);

    await connection.execute(
      `
      INSERT INTO sales_items
      (
        agency_id,
        sale_id,
        product_id,
        quantity,
        price,
        status,
        delivered_qty,
        empty_cylinder_qty,
        empty_cylinder_status,
        defective_qty,
        batch_no,
        allocation_sale_id,
        allocation_sales_item_id
      )
      VALUES (?, ?, ?, ?, ?, 'DELIVERED', ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        agencyId,
        saleId,
        numericProductId,
        numericQuantity,
        unitPrice,
        numericDeliveredQty,
        numericEmptyCylinderQty,
        finalEmptyCylinderStatus,
        numericDefectiveQty,
        finalBatchNo,
        allocation_sale_id ? Number(allocation_sale_id) : null,
        allocation_sales_item_id ? Number(allocation_sales_item_id) : null,
      ],
    );

    // Empty return requests are created only from the explicit
    // "Return Empties to Godown" action.

    let paymentMethodForPayments = null;
    let paymentStatus = "PENDING";

    if (payment_method === "CASH") {
      paymentMethodForPayments = "CASH";
      paymentStatus = "SUCCESS";
    } else if (payment_method === "UPI") {
      paymentMethodForPayments = "UPI";
      paymentStatus = "SUCCESS";
    } else if (payment_method === "ONLINE") {
      paymentMethodForPayments = "CARD";
      paymentStatus = "SUCCESS";
    }

    const [paymentInsertResult] = await connection.execute(
      `
      INSERT INTO payments
      (
        agency_id,
        sale_id,
        amount,
        method,
        status,
        type
      )
      VALUES (?, ?, ?, ?, ?, 'DRIVER')
      `,
      [agencyId, saleId, finalAmount, paymentMethodForPayments, paymentStatus],
    );

    const paymentId = paymentInsertResult.insertId;

    if (payment_method === "CASH" || payment_method === "UPI") {
      await connection.execute(
        `
        INSERT INTO settlement_history
        (
          agency_id,
          driver_id,
          sale_id,
          payment_id,
          method,
          amount,
          status,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'ASSIGNED', NOW())
        `,
        [agencyId, numericDriverId, saleId, paymentId, payment_method, finalAmount],
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Sale created successfully",
      data: {
        saleId,
        customerId,
        addressId,
        paymentId,

        product: {
          id: Number(selectedProduct.id),
          name: selectedProduct.name,
          type: selectedProduct.type,
        },

        batch: {
          batchNo: finalBatchNo,
          allocationSaleId: allocation_sale_id
            ? Number(allocation_sale_id)
            : null,
          allocationSalesItemId: allocation_sales_item_id
            ? Number(allocation_sales_item_id)
            : null,
        },

        quantity: numericQuantity,
        deliveredQty: numericDeliveredQty,
        amount: finalAmount,
        paymentMethod: payment_method,
        emptyCylinderCollected: numericEmptyCylinderQty > 0,
        emptyCylinderQty: numericEmptyCylinderQty,
        emptyCylinderStatus: finalEmptyCylinderStatus,
        defectiveQty: numericDefectiveQty,
      },
    });
  } catch (error) {
    await connection.rollback();

    console.error("createDriverSale error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create sale",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

const RETURN_REASONS = ["DISCONNECTION", "TRANSFER", "SURRENDER", "OTHER"];
const RETURN_PAYMENT_METHODS = ["CASH", "UPI", "CARD"];

// Ensures the tables backing the driver-collected customer return flow exist.
// Follows the same CREATE TABLE IF NOT EXISTS convention used elsewhere in the
// codebase so no separate migration step is required.
const ensureDriverReturnTables = async (connection) => {
  await connection.execute(
    `
    CREATE TABLE IF NOT EXISTS driver_returns (
      id BIGINT NOT NULL AUTO_INCREMENT,
      driver_id INT NOT NULL,
      customer_id INT NULL,
      address_id INT NULL,
      category VARCHAR(20) NOT NULL,
      product_id INT NOT NULL,
      quantity INT NOT NULL,
      return_reason VARCHAR(30) NULL,
      payment_method VARCHAR(20) NULL,
      amount DECIMAL(10,2) NOT NULL DEFAULT 0,
      stock_transaction_id BIGINT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      created_by INT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_driver_returns_driver_id (driver_id),
      KEY idx_driver_returns_customer_id (customer_id),
      KEY idx_driver_returns_product_id (product_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `,
  );

  await connection.execute(
    `
    CREATE TABLE IF NOT EXISTS driver_return_otps (
      id BIGINT NOT NULL AUTO_INCREMENT,
      return_id BIGINT NOT NULL,
      otp VARCHAR(10) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_driver_return_otps_return_id (return_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `,
  );
};

// Driver-collected customer return: the driver picks up empty cylinders from a
// customer (commercial return with payment, or domestic return with a reason)
// without delivering a replacement. The collected empties are added to the
// driver's return stock as an unapproved EMPTY_RETURN transaction — the exact
// same mechanism the godown settlement approves into the empty stock. The
// stock_transaction row also serves as the audit/activity entry (the godown
// activity feed is derived from stock_transactions).
export const createDriverReturn = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      driver_id,
      customer_name,
      phone,
      address,

      category,
      product_id,
      quantity = 1,

      return_reason = null,
      payment_method = null,
      amount = 0,

      otp = null,
    } = req.body;

    const numericDriverId = await resolveDriverId(driver_id, connection);
    const numericProductId = Number(product_id);
    const numericQuantity = Number(quantity || 0);
    const normalizedCategory = String(category || "").toUpperCase();
    const normalizedReason = return_reason
      ? String(return_reason).toUpperCase()
      : null;
    const normalizedPaymentMethod = payment_method
      ? String(payment_method).toUpperCase()
      : null;
    const numericAmount = Number(amount || 0);
    const normalizedOtp = String(otp || "").trim();

    if (!numericDriverId) {
      return res.status(400).json({
        success: false,
        message: "valid driver_id is required",
      });
    }

    if (!customer_name || !address) {
      return res.status(400).json({
        success: false,
        message: "customer_name and address are required",
      });
    }

    if (!["COMMERCIAL", "DOMESTIC"].includes(normalizedCategory)) {
      return res.status(400).json({
        success: false,
        message: "category must be COMMERCIAL or DOMESTIC",
      });
    }

    if (!numericProductId || Number.isNaN(numericProductId)) {
      return res.status(400).json({
        success: false,
        message: "product_id is required",
      });
    }

    if (!numericQuantity || numericQuantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "quantity must be greater than 0",
      });
    }

    if (normalizedOtp.length !== 6) {
      return res.status(400).json({
        success: false,
        message: "A 6 digit customer OTP is required",
      });
    }

    if (normalizedCategory === "COMMERCIAL") {
      if (!RETURN_PAYMENT_METHODS.includes(normalizedPaymentMethod)) {
        return res.status(400).json({
          success: false,
          message:
            "payment_method must be CASH, UPI or CARD for a commercial return",
        });
      }
    } else {
      if (!RETURN_REASONS.includes(normalizedReason)) {
        return res.status(400).json({
          success: false,
          message:
            "return_reason must be DISCONNECTION, TRANSFER, SURRENDER or OTHER for a domestic return",
        });
      }
    }

    // Fetch the driver's user_id so it can be used as created_by (matches the
    // sale flow's stock_transactions attribution).
    const [driverUserRows] = await connection.execute(
      `SELECT user_id FROM drivers WHERE id = ? LIMIT 1`,
      [numericDriverId],
    );
    const driverUserId = driverUserRows[0]?.user_id || null;

    await connection.beginTransaction();

    await ensureDriverReturnTables(connection);

    const [productRows] = await connection.execute(
      `SELECT id, name, type, price FROM products WHERE id = ? LIMIT 1`,
      [numericProductId],
    );

    if (!productRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const selectedProduct = productRows[0];

    if (String(selectedProduct.type).toUpperCase() !== normalizedCategory) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Selected product does not match the chosen category",
      });
    }

    // Resolve or create the customer + address (same upsert pattern as sales).
    let customerId = null;

    let existingCustomers = [];

    if (phone && String(phone).trim() !== "") {
      [existingCustomers] = await connection.execute(
        `SELECT id FROM users WHERE phone = ? LIMIT 1`,
        [phone],
      );
    }

    if (existingCustomers.length) {
      customerId = existingCustomers[0].id;

      await connection.execute(
        `UPDATE users SET name = ?, role = 'CUSTOMER' WHERE id = ?`,
        [customer_name, customerId],
      );
    } else {
      const [customerResult] = await connection.execute(
        `
        INSERT INTO users (name, phone, role, created_at, updated_at)
        VALUES (?, ?, 'CUSTOMER', NOW(), NOW())
        `,
        [customer_name, phone || null],
      );

      customerId = customerResult.insertId;
    }

    let addressId = null;

    const [addressRows] = await connection.execute(
      `SELECT id FROM addresses WHERE user_id = ? AND address = ? LIMIT 1`,
      [customerId, address],
    );

    if (addressRows.length) {
      addressId = addressRows[0].id;
    } else {
      const [addressResult] = await connection.execute(
        `
        INSERT INTO addresses (user_id, address, created_at, updated_at)
        VALUES (?, ?, NOW(), NOW())
        `,
        [customerId, address],
      );

      addressId = addressResult.insertId;
    }

    const finalAmount =
      normalizedCategory === "COMMERCIAL" ? Math.max(numericAmount, 0) : 0;

    const [returnResult] = await connection.execute(
      `
      INSERT INTO driver_returns
      (
        driver_id,
        customer_id,
        address_id,
        category,
        product_id,
        quantity,
        return_reason,
        payment_method,
        amount,
        status,
        created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
      `,
      [
        numericDriverId,
        customerId,
        addressId,
        normalizedCategory,
        numericProductId,
        numericQuantity,
        normalizedCategory === "DOMESTIC" ? normalizedReason : null,
        normalizedCategory === "COMMERCIAL" ? normalizedPaymentMethod : null,
        finalAmount,
        driverUserId,
      ],
    );

    const returnId = returnResult.insertId;

    // Add the collected empties to the driver's return stock. reference_id is
    // left NULL so this row is never mis-linked to a sale — the godown "return
    // to godown" settlement picks up unapproved driver EMPTY_RETURN rows and
    // calls addEmptyStockToGodown for each.
    const [stockResult] = await connection.execute(
      `
      INSERT INTO stock_transactions
      (
        product_id,
        stock_area_id,
        type,
        quantity,
        isApproved,
        reference_id,
        created_by,
        driver_id,
        stock_from,
        is_defective
      )
      VALUES (?, NULL, 'EMPTY_RETURN', ?, 0, NULL, ?, ?, 'driver', 0)
      `,
      [numericProductId, numericQuantity, driverUserId, numericDriverId],
    );

    await connection.execute(
      `UPDATE driver_returns SET stock_transaction_id = ? WHERE id = ?`,
      [stockResult.insertId, returnId],
    );

    await connection.execute(
      `
      INSERT INTO driver_return_otps (return_id, otp, status)
      VALUES (?, ?, 'PENDING')
      `,
      [returnId, normalizedOtp],
    );

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Return recorded successfully",
      data: {
        returnId,
        customerId,
        addressId,
        category: normalizedCategory,
        product: {
          id: Number(selectedProduct.id),
          name: selectedProduct.name,
          type: selectedProduct.type,
        },
        quantity: numericQuantity,
        returnReason:
          normalizedCategory === "DOMESTIC" ? normalizedReason : null,
        paymentMethod:
          normalizedCategory === "COMMERCIAL" ? normalizedPaymentMethod : null,
        amount: finalAmount,
        stockTransactionId: Number(stockResult.insertId),
      },
    });
  } catch (error) {
    await connection.rollback();

    console.error("createDriverReturn error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to record return",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getDriverCollectionSummary = async (req, res) => {
  try {
    const driverId = await resolveDriverId(req.params.driverId);
    const { startDate, endDate } = resolveDateRange(req.query);

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "Driver id is required",
      });
    }

    const [rows] = await db.execute(
      `
      SELECT
        sh.id,
        sh.sale_id,
        sh.payment_id,
        sh.method,
        s.payment_method AS original_method,
        sh.amount,
        sh.status,
        sh.created_at,
        u.name AS customer_name
      FROM settlement_history sh
      INNER JOIN sales s ON s.id = sh.sale_id
      LEFT JOIN users u ON u.id = s.customer_id
      WHERE sh.driver_id = ?
        AND sh.status IN ('ASSIGNED', 'PENDING', 'SETTLED')
        AND DATE(sh.created_at) BETWEEN ? AND ?
      ORDER BY sh.created_at ASC
      `,
      [driverId, startDate, endDate],
    );

    const buildGroup = (method, status) => {
      const items = rows.filter(
        (item) => item.method === method && item.status === status,
      );

      const amount = items.reduce(
        (sum, item) => sum + Number(item.amount || 0),
        0,
      );

      let displayMessage = "";
      if (status === "ASSIGNED") {
        displayMessage =
          amount > 0 ? "Ready to Settle" : "No pending collection";
      } else if (status === "PENDING") {
        displayMessage =
          amount > 0
            ? "Pending for approval"
            : "No collections pending approval";
      } else if (status === "SETTLED") {
        displayMessage = amount > 0 ? "Settled" : "No settled collections";
      }

      return {
        amount,
        count: items.length,
        status: amount > 0 ? status : null,
        displayMessage,
        transactions: items.map((item) => ({
          id: Number(item.id),
          saleId: Number(item.sale_id),
          paymentId: Number(item.payment_id),
          amount: Number(item.amount || 0),
          customerName: item.customer_name || "Unknown Customer",
          createdAt: item.created_at,
          status: item.status,
          method: item.method,
        })),
      };
    };

    const cashAssigned = buildGroup("CASH", "ASSIGNED");
    const cashPending = buildGroup("CASH", "PENDING");
    const cashSettled = buildGroup("CASH", "SETTLED");
    const upiAssigned = buildGroup("UPI", "ASSIGNED");
    const upiPending = buildGroup("UPI", "PENDING");
    const upiSettled = buildGroup("UPI", "SETTLED");
    const onlineSettled = buildGroup("ONLINE", "SETTLED");
    const totalUpiPending = buildGroup("TOTAL_UPI", "PENDING");

    // cashCollected / upiCollected = total collected based on the ORIGINAL sale method (invariant)
    const cashCollected = rows
      .filter((r) => r.original_method === "CASH")
      .reduce((sum, r) => sum + Number(r.amount || 0), 0);

    const upiCollected = rows
      .filter((r) => ["UPI", "ONLINE"].includes(r.original_method))
      .reduce((sum, r) => sum + Number(r.amount || 0), 0);

    const totalSettled = cashSettled.amount + upiSettled.amount + onlineSettled.amount;

    const cashTotal = cashCollected;
    const upiTotal = upiCollected;

    const [deliveredRows] = await db.execute(
      `
      SELECT COALESCE(SUM(si.delivered_qty), 0) AS delivered
      FROM sales s
      INNER JOIN sales_items si ON si.sale_id = s.id
      WHERE s.driver_id = ?
        AND s.status = 'DELIVERED'
        AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?
      `,
      [driverId, startDate, endDate],
    );

    const totalDeliveries = Number(deliveredRows[0].delivered);

    return res.status(200).json({
      success: true,
      message: "Collection summary fetched successfully",
      data: {
        summary: {
          cashCollected,
          upiCollected,
          totalCollected: cashTotal + upiTotal,
          totalDeliveries,
          totalSettled,
        },
        settlements: {
          cashAssigned,
          cashPending,
          cashSettled,
          upiAssigned,
          upiPending,
          upiSettled,
          totalUpiPending,
        },
      },
    });
  } catch (error) {
    console.error("getDriverCollectionSummary error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch collection summary",
      error: error.message,
    });
  }
};

export const settleDriverCollectionsByMethod = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const driverId = await resolveDriverId(req.params.driverId);
    const { method, denominations, amount } = req.body || {};

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "Driver id is required",
      });
    }

    if (!["CASH", "UPI", "ONLINE", "TOTAL_UPI"].includes(method)) {
      return res.status(400).json({
        success: false,
        message: "method must be CASH, UPI, ONLINE or TOTAL_UPI",
      });
    }

    await connection.beginTransaction();

    // Fetch ALL assigned records for today regardless of original payment method.
    // The driver should be able to hand over cash collections via UPI and vice versa.
    // DATE(created_at) = CURDATE() prevents stale ASSIGNED records from previous days
    // from being accidentally settled.
    const [rows] = await connection.execute(
      `
      SELECT sh.id, sh.amount, sh.method AS original_method, s.payment_method AS sale_payment_method
      FROM settlement_history sh
      LEFT JOIN sales s ON s.id = sh.sale_id
      WHERE sh.driver_id = ?
        AND sh.status = 'ASSIGNED'
        AND DATE(sh.created_at) = CURDATE()
      ORDER BY (CASE WHEN (s.payment_method = ? OR (s.payment_method IS NULL AND sh.method = ?)) THEN 0 ELSE 1 END), sh.created_at ASC
      FOR UPDATE
      `,
      [driverId, method, method],
    );

    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "No assigned collection found to settle",
      });
    }

    const totalAmount = rows.reduce(
      (sum, row) => sum + Number(row.amount || 0),
      0,
    );

    const requestedAmount = amount !== undefined ? Number(amount) : totalAmount;

    if (requestedAmount > totalAmount) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: `Requested amount (₹${requestedAmount}) cannot exceed total assigned amount (₹${totalAmount})`,
      });
    }

    if (method === "CASH") {
      if (denominations && Object.keys(denominations).length > 0) {
        const enteredCashTotal =
          Number(denominations?.["500"] || 0) * 500 +
          Number(denominations?.["100"] || 0) * 100 +
          Number(denominations?.["50"] || 0) * 50 +
          Number(denominations?.["20"] || 0) * 20 +
          Number(denominations?.["10"] || 0) * 10 +
          Number(denominations?.coins || 0);

        if (enteredCashTotal !== requestedAmount) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: `Expected ₹${requestedAmount} but got ₹${enteredCashTotal}`,
          });
        }
      }
    }

    let remainingToSettle = requestedAmount;

    for (const row of rows) {
      if (remainingToSettle <= 0) break;
      const rowAmount = Number(row.amount);
      const isOriginalOnline =
        ["UPI", "ONLINE"].includes(row.sale_payment_method) ||
        ["UPI", "ONLINE"].includes(row.original_method);
      const newMethod = isOriginalOnline
        ? ["UPI", "ONLINE"].includes(row.sale_payment_method)
          ? row.sale_payment_method
          : row.original_method
        : method;

      if (rowAmount <= remainingToSettle) {
        await connection.execute(
          `UPDATE settlement_history SET status = 'PENDING', method = ? WHERE id = ?`,
          [newMethod, row.id],
        );
        remainingToSettle -= rowAmount;
      } else {
        await connection.execute(
          `UPDATE settlement_history SET amount = ? WHERE id = ?`,
          [rowAmount - remainingToSettle, row.id],
        );
        await connection.execute(
          `INSERT INTO settlement_history (driver_id, sale_id, payment_id, method, amount, status, created_at)
           SELECT driver_id, sale_id, payment_id, ?, ?, 'PENDING', created_at
           FROM settlement_history WHERE id = ?`,
          [newMethod, remainingToSettle, row.id],
        );
        remainingToSettle = 0;
      }
    }

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "Collection moved to pending cashier approval",
      data: {
        amount: requestedAmount,
        method,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("settleDriverCollectionsByMethod error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to settle collection",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getDriverInHandSummary = async (req, res) => {
  try {
    const driverId = await resolveDriverId(req.params.driverId);
    const { startDate, endDate } = resolveDateRange(req.query);

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "driverId is required",
      });
    }

    // Cylinders freshly allocated inside the selected range.
    const [allocationRows] = await db.execute(
      `
      SELECT COALESCE(SUM(asi.quantity), 0) AS allocated
      FROM sales_items asi
      INNER JOIN sales a
        ON a.id = asi.sale_id
      WHERE a.driver_id = ?
        AND a.status = 'ASSIGNED'
        AND asi.allocation_sales_item_id IS NULL
        AND DATE(COALESCE(a.assigned_at, a.created_at)) BETWEEN ? AND ?
      `,
      [driverId, startDate, endDate],
    );

    // Cylinders still in hand from before the range - carried forward and
    // added to the allocated figure instead of being lost from the summary.
    const { total: carriedForward } = await getDriverCarryForward(db, {
      driverId,
      asOfDate: startDate,
      openingBalance: true,
    });

    // Deliveries made inside the range out of ANY open batch, including the
    // carried-forward ones, so delivering yesterday's stock lowers today's
    // in-hand figure.
    const [deliveredRows] = await db.execute(
      `
      SELECT COALESCE(SUM(COALESCE(child.delivered_qty, child.quantity, 0)), 0) AS delivered
      FROM sales_items child
      INNER JOIN sales cs
        ON cs.id = child.sale_id
      WHERE cs.driver_id = ?
        AND cs.status = 'DELIVERED'
        AND child.allocation_sales_item_id IS NOT NULL
        AND DATE(COALESCE(cs.delivered_at, cs.created_at)) BETWEEN ? AND ?
      `,
      [driverId, startDate, endDate],
    );

    // Returns raised inside the range against any open batch. Pending requests
    // count as well, matching the batch-level pending figures in the app.
    const [returnedRows] = await db.execute(
      `
      SELECT
        COALESCE(SUM(
          CASE WHEN st.is_defective = 0 THEN COALESCE(st.quantity, 0) ELSE 0 END
        ), 0) AS returned,
        COALESCE(SUM(
          CASE WHEN st.is_defective = 1 THEN COALESCE(st.quantity, 0) ELSE 0 END
        ), 0) AS defective
      FROM stock_transactions st
      WHERE st.driver_id = ?
        AND st.stock_from = 'driver'
        AND st.type = 'PURCHASE_RETURN'
        AND st.isApproved IN (0, 1)
        AND st.allocation_sales_item_id IS NOT NULL
        AND DATE(st.created_at) BETWEEN ? AND ?
      `,
      [driverId, startDate, endDate],
    );

    const allocatedInRange = toNumber(allocationRows[0]?.allocated);
    const allocated = allocatedInRange + carriedForward;
    const delivered = toNumber(deliveredRows[0]?.delivered);
    const returned = toNumber(returnedRows[0]?.returned);
    const defective = toNumber(returnedRows[0]?.defective);

    const inHand = Math.max(allocated - delivered - returned - defective, 0);

    const [requestRows] = await db.execute(
      `
      SELECT
        st.id,
        st.product_id,
        st.stock_area_id,
        st.quantity,
        st.created_at,
        st.isApproved,
        st.is_defective,
        st.batch_no,
        st.allocation_sale_id,
        st.allocation_sales_item_id,
        p.name AS product_name,
        p.type AS product_type
      FROM stock_transactions st
      LEFT JOIN products p
        ON p.id = st.product_id
      WHERE st.driver_id = ?
        AND st.stock_from = 'driver'
        AND st.type = 'PURCHASE_RETURN'
        AND st.isApproved = 0
      ORDER BY st.created_at DESC, st.id DESC
      `,
      [driverId],
    );

    const returnRequests = [];
    const defectiveRequests = [];

    requestRows.forEach((item) => {
      const mapped = {
        id: Number(item.id),
        productId: Number(item.product_id),
        stockAreaId: item.stock_area_id ? Number(item.stock_area_id) : null,
        quantity: Number(item.quantity || 0),
        productName: item.product_name || "Cylinder",
        productType: item.product_type || "",
        createdAt: item.created_at,
        isApproved: Number(item.isApproved || 0),
        batchNo: item.batch_no || null,
        allocationSaleId: item.allocation_sale_id
          ? Number(item.allocation_sale_id)
          : null,
        allocationSalesItemId: item.allocation_sales_item_id
          ? Number(item.allocation_sales_item_id)
          : null,
      };

      if (Number(item.is_defective) === 1) {
        defectiveRequests.push(mapped);
      } else {
        returnRequests.push(mapped);
      }
    });

    return res.status(200).json({
      success: true,
      message: "In-hand summary fetched successfully",
      data: {
        summary: {
          allocated,
          allocatedToday: allocatedInRange,
          carriedForward,
          delivered,
          returned,
          defective,
          inHand,
        },
        returnRequests,
        defectiveRequests,
      },
    });
  } catch (error) {
    console.error("getDriverInHandSummary error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch in-hand summary",
      error: error.message,
    });
  }
};

export const returnInHandToGodown = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { driverId } = req.params;

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "driverId is required",
      });
    }

    const numericDriverId = Number(driverId);

    if (Number.isNaN(numericDriverId)) {
      return res.status(400).json({
        success: false,
        message: "driverId must be a valid number",
      });
    }

    await connection.beginTransaction();

    // =========================
    // GET PENDING RETURN REQUESTS
    // =========================
    const [pendingRows] = await connection.execute(
      `
      SELECT
        id,
        product_id,
        stock_area_id,
        quantity
      FROM stock_transactions
      WHERE created_by = ?
        AND type = 'PURCHASE_RETURN'
        AND isApproved = 0
      FOR UPDATE
      `,
      [numericDriverId],
    );

    if (!pendingRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "No pending return requests found",
      });
    }

    // =========================
    // UPDATE STOCK TABLE
    // =========================
    for (const row of pendingRows) {
      const productId = Number(row.product_id);
      const stockAreaId = Number(row.stock_area_id);
      const qty = Number(row.quantity || 0);

      const [stockRows] = await connection.execute(
        `
        SELECT id, quantity, quantity_return
        FROM stock
        WHERE product_id = ?
          AND stock_area_id = ?
        LIMIT 1
        FOR UPDATE
        `,
        [productId, stockAreaId],
      );

      if (stockRows.length) {
        await connection.execute(
          `
          UPDATE stock
          SET quantity = quantity + ?,
              quantity_return = quantity_return + ?
          WHERE product_id = ?
            AND stock_area_id = ?
          `,
          [qty, qty, productId, stockAreaId],
        );
      } else {
        await connection.execute(
          `
          INSERT INTO stock (
            product_id,
            stock_area_id,
            quantity,
            quantity_return
          )
          VALUES (?, ?, ?, ?)
          `,
          [productId, stockAreaId, qty, qty],
        );
      }
    }

    // =========================
    // APPROVE RETURN REQUESTS
    // =========================
    await connection.execute(
      `
      UPDATE stock_transactions
      SET isApproved = 1
      WHERE created_by = ?
        AND type = 'PURCHASE_RETURN'
        AND isApproved = 0
      `,
      [numericDriverId],
    );

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "In-hand cylinders returned to godown successfully",
      data: {
        updatedCount: pendingRows.length,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("returnInHandToGodown error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to return in-hand cylinders",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getDriverCollectionHistory = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { startDate, endDate } = resolveDateRange(req.query);

    const parsedPage = parseInt(req.query.page, 10);
    const parsedLimit = parseInt(req.query.limit, 10);

    const safePage =
      Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;

    const safeLimit =
      Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 2;

    const offset = (safePage - 1) * safeLimit;

    const numericDriverId = await resolveDriverId(driverId);

    if (!numericDriverId) {
      return res.status(400).json({
        success: false,
        message: "Valid driverId is required",
      });
    }

    const [dateRows] = await db.execute(
      `
      SELECT DATE(sh.created_at) AS collection_date
      FROM settlement_history sh
      WHERE sh.driver_id = ?
        AND sh.status = 'SETTLED'
        AND DATE(sh.created_at) BETWEEN ? AND ?
      GROUP BY DATE(sh.created_at)
      ORDER BY collection_date DESC
      LIMIT ${safeLimit} OFFSET ${offset}
      `,
      [numericDriverId, startDate, endDate],
    );

    const [countRows] = await db.execute(
      `
      SELECT COUNT(*) AS totalDates
      FROM (
        SELECT DATE(sh.created_at) AS collection_date
        FROM settlement_history sh
        WHERE sh.driver_id = ?
          AND sh.status = 'SETTLED'
          AND DATE(sh.created_at) BETWEEN ? AND ?
        GROUP BY DATE(sh.created_at)
      ) t
      `,
      [numericDriverId, startDate, endDate],
    );

    const totalDates = Number(countRows[0]?.totalDates || 0);
    const totalPages = Math.ceil(totalDates / safeLimit);

    const items = [];

    for (const dateRow of dateRows) {
      const collectionDate = dateRow.collection_date;

      const [summaryRows] = await db.execute(
        `
        SELECT
          COALESCE(SUM(CASE WHEN (s.payment_method = 'CASH' OR (s.payment_method IS NULL AND sh.method = 'CASH')) THEN sh.amount ELSE 0 END), 0) AS cash_amount,
          COALESCE(SUM(CASE WHEN (s.payment_method IN ('UPI', 'ONLINE') OR sh.method IN ('UPI', 'ONLINE')) THEN sh.amount ELSE 0 END), 0) AS upi_amount
        FROM settlement_history sh
        LEFT JOIN sales s ON s.id = sh.sale_id
        WHERE sh.driver_id = ?
          AND sh.status = 'SETTLED'
          AND DATE(sh.created_at) = ?
        `,
        [numericDriverId, collectionDate],
      );

      const [settlementRows] = await db.execute(
        `
        SELECT status
        FROM settlements
        WHERE driver_id = ?
          AND settlement_date = ?
        LIMIT 1
        `,
        [numericDriverId, collectionDate],
      );

      const cashierStatus = settlementRows[0]?.status || "PENDING";

      const [transactionRows] = await db.execute(
        `
        SELECT
          sh.id,
          sh.sale_id,
          sh.amount,
          CASE 
            WHEN s.payment_method IN ('UPI', 'ONLINE') THEN s.payment_method
            WHEN sh.method IN ('UPI', 'ONLINE', 'CARD') THEN sh.method
            ELSE 'CASH'
          END AS payment_mode,
          sh.status AS settlement_history_status,
          sh.created_at,
          u.name AS customer_name,
          COALESCE(SUM(CASE WHEN p.type = 'DOMESTIC' THEN si.quantity ELSE 0 END), 0) AS dom_qty,
          COALESCE(SUM(CASE WHEN p.type = 'COMMERCIAL' THEN si.quantity ELSE 0 END), 0) AS com_qty,
          COALESCE(SUM(CASE WHEN p.type != 'DOMESTIC' AND p.type != 'COMMERCIAL' THEN si.quantity ELSE 0 END), 0) AS items_qty
        FROM settlement_history sh
        LEFT JOIN sales s ON s.id = sh.sale_id
        LEFT JOIN users u ON u.id = s.customer_id
        LEFT JOIN sales_items si ON s.id = si.sale_id
        LEFT JOIN products p ON si.product_id = p.id
        WHERE sh.driver_id = ?
          AND sh.status IN ('SETTLED', 'PENDING')
          AND DATE(sh.created_at) = ?
        GROUP BY sh.id, sh.sale_id, sh.amount, sh.method, s.payment_method, sh.status, sh.created_at, u.name
        ORDER BY sh.created_at DESC, sh.id DESC
        `,
        [numericDriverId, collectionDate],
      );

      const cashAmount = Number(summaryRows[0]?.cash_amount || 0);
      const upiAmount = Number(summaryRows[0]?.upi_amount || 0);

      const displayStatus =
        cashierStatus === "SETTLED" ? "APPROVED" : "PENDING_APPROVAL";

      items.push({
        date: collectionDate,
        totalAmount: cashAmount + upiAmount,
        summary: {
          cash: {
            amount: cashAmount,
            status: cashAmount > 0 ? displayStatus : null,
            settledAt: null,
          },
          upi: {
            amount: upiAmount,
            status: upiAmount > 0 ? displayStatus : null,
            settledAt: null,
          },
        },
        transactions: transactionRows.map((row) => ({
          saleId: Number(row.sale_id),
          customerName: row.customer_name || "Unknown Customer",
          amount: Number(row.amount || 0),
          paymentMode: row.payment_mode || "N/A",
          domQty: Number(row.dom_qty || 0),
          comQty: Number(row.com_qty || 0),
          itemsQty: Number(row.items_qty || 0),
          deliveredAt: row.created_at,
          status: displayStatus,
        })),
      });
    }

    return res.status(200).json({
      success: true,
      message: "Collection history fetched successfully",
      data: {
        items,
        pagination: {
          page: safePage,
          limit: safeLimit,
          totalItems: totalDates,
          totalPages,
          hasNextPage: safePage < totalPages,
          hasPrevPage: safePage > 1,
        },
      },
    });
  } catch (error) {
    console.error("getDriverCollectionHistory error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch collection history",
      error: error.message,
    });
  }
};

export const getDriverEmptyCylindersToday = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { startDate, endDate } = resolveDateRange(req.query);

    const numericDriverId = await resolveDriverId(driverId);

    if (!numericDriverId) {
      return res.status(400).json({
        success: false,
        message: "Valid driverId is required",
      });
    }

    const [collectedRows] = await db.execute(
      `
      SELECT
        si.id,
        s.id AS sale_id,
        u.name AS customer_name,
        p.type AS product_type,
        COALESCE(si.empty_cylinder_qty, 0) AS quantity,
        COALESCE(s.delivered_at, s.created_at) AS created_at
      FROM sales s
      INNER JOIN sales_items si ON si.sale_id = s.id
      LEFT JOIN users u ON u.id = s.customer_id
      LEFT JOIN products p ON p.id = si.product_id
      WHERE s.driver_id = ?
        AND s.status = 'DELIVERED'
        AND si.empty_cylinder_status IN ('DELIVERED', 'PARTIAL_DELIVERED')
        AND COALESCE(si.empty_cylinder_qty, 0) > 0
        AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?
      ORDER BY COALESCE(s.delivered_at, s.created_at) ASC, si.id ASC
      `,
      [numericDriverId, startDate, endDate],
    );

    const [returnRows] = await db.execute(
      `
      SELECT
        st.id,
        st.product_id,
        st.quantity,
        st.created_at,
        st.isApproved,
        p.name AS product_name
      FROM stock_transactions st
      LEFT JOIN products p ON p.id = st.product_id
      LEFT JOIN sales linked_sale
        ON linked_sale.id = st.reference_id
       AND linked_sale.driver_id = st.driver_id
      WHERE st.driver_id = ?
        AND st.stock_from = 'driver'
        AND st.type IN ('EMPTY_RETURN')
        AND COALESCE(st.isApproved, 0) IN (0, 1)
        AND linked_sale.id IS NULL
        AND DATE(st.created_at) BETWEEN ? AND ?
      ORDER BY st.created_at DESC, st.id DESC
      `,
      [numericDriverId, startDate, endDate],
    );

    const collected = collectedRows.reduce(
      (sum, row) => sum + Number(row.quantity || 0),
      0,
    );

    // Count as "returned" only once the godown manager has approved the return
    // (matches what physically enters godown stock). Pending requests still
    // appear in returnRequests below as "awaiting approval".
    const returned = returnRows.reduce(
      (sum, row) =>
        Number(row.isApproved) === 1 ? sum + Number(row.quantity || 0) : sum,
      0,
    );

    return res.status(200).json({
      success: true,
      message: "Empty cylinder today data fetched successfully",
      data: {
        summary: {
          collected,
          returned,
          inHand: Math.max(collected - returned, 0),
        },
        collectedFrom: collectedRows.map((row) => ({
          id: Number(row.id),
          saleId: Number(row.sale_id),
          customerName: row.customer_name || "Unknown Customer",
          productType: row.product_type || "N/A",
          quantity: Number(row.quantity || 0),
          createdAt: row.created_at,
        })),
        returnRequests: returnRows.map((row) => ({
          id: Number(row.id),
          productId: Number(row.product_id),
          productName: row.product_name || "",
          quantity: Number(row.quantity || 0),
          createdAt: row.created_at,
          isApproved: Number(row.isApproved || 0),
        })),
      },
    });
  } catch (error) {
    console.error("getDriverEmptyCylindersToday error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch empty cylinders today data",
      error: error.message,
    });
  }
};

export const getDriverEmptyCylindersHistory = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { startDate, endDate } = resolveDateRange(req.query);

    const numericDriverId = await resolveDriverId(driverId);

    if (!numericDriverId) {
      return res.status(400).json({
        success: false,
        message: "Valid driverId is required",
      });
    }

    const [dateRows] = await db.execute(
      `
      SELECT history_date
      FROM (
        SELECT DATE(COALESCE(s.delivered_at, s.created_at)) AS history_date
        FROM sales s
        INNER JOIN sales_items si ON si.sale_id = s.id
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
          AND si.empty_cylinder_status IN ('DELIVERED', 'PARTIAL_DELIVERED')
          AND COALESCE(si.empty_cylinder_qty, 0) > 0
          AND DATE(COALESCE(s.delivered_at, s.created_at)) BETWEEN ? AND ?

        UNION

        SELECT DATE(st.created_at) AS history_date
        FROM stock_transactions st
        LEFT JOIN sales linked_sale
          ON linked_sale.id = st.reference_id
         AND linked_sale.driver_id = st.driver_id
        WHERE st.driver_id = ?
          AND st.stock_from = 'driver'
          AND st.is_defective = 0
          AND COALESCE(st.isApproved, 0) IN (0, 1)
          AND st.type IN ('EMPTY_RETURN')
          AND linked_sale.id IS NULL
          AND DATE(st.created_at) BETWEEN ? AND ?
      ) x
      GROUP BY history_date
      ORDER BY history_date DESC
      `,
      [
        numericDriverId,
        startDate,
        endDate,
        numericDriverId,
        startDate,
        endDate,
      ],
    );

    const items = [];

    for (const dateRow of dateRows) {
      const historyDate = dateRow.history_date;

      const [collections] = await db.execute(
        `
        SELECT
          si.id,
          s.id AS sale_id,
          u.name AS customer_name,
          p.type AS product_type,
          COALESCE(si.empty_cylinder_qty, 0) AS quantity,
          COALESCE(s.delivered_at, s.created_at) AS created_at
        FROM sales s
        INNER JOIN sales_items si ON si.sale_id = s.id
        LEFT JOIN users u ON u.id = s.customer_id
        LEFT JOIN products p ON p.id = si.product_id
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
          AND si.empty_cylinder_status IN ('DELIVERED', 'PARTIAL_DELIVERED')
          AND COALESCE(si.empty_cylinder_qty, 0) > 0
          AND DATE(COALESCE(s.delivered_at, s.created_at)) = ?
        ORDER BY COALESCE(s.delivered_at, s.created_at) ASC, si.id ASC
        `,
        [numericDriverId, historyDate],
      );

      const [returns] = await db.execute(
        `
        SELECT
          st.id,
          st.product_id,
          st.quantity,
          st.created_at,
          st.isApproved,
          p.name AS product_name
        FROM stock_transactions st
        LEFT JOIN products p ON p.id = st.product_id
        LEFT JOIN sales linked_sale
          ON linked_sale.id = st.reference_id
         AND linked_sale.driver_id = st.driver_id
        WHERE st.driver_id = ?
          AND st.stock_from = 'driver'
          AND st.is_defective = 0
          AND COALESCE(st.isApproved, 0) IN (0, 1)
          AND st.type IN ('EMPTY_RETURN')
          AND linked_sale.id IS NULL
          AND DATE(st.created_at) = ?
        ORDER BY st.created_at DESC, st.id DESC
        `,
        [numericDriverId, historyDate],
      );

      const collected = collections.reduce(
        (sum, row) => sum + Number(row.quantity || 0),
        0,
      );

      // Approved returns only (see getDriverEmptyCylindersToday for rationale).
      const returned = returns.reduce(
        (sum, row) =>
          Number(row.isApproved) === 1 ? sum + Number(row.quantity || 0) : sum,
        0,
      );

      items.push({
        date: historyDate,
        collected,
        returned,
        inHand: Math.max(collected - returned, 0),
        collections: collections.map((row) => ({
          id: Number(row.id),
          saleId: Number(row.sale_id),
          customerName: row.customer_name || "Unknown Customer",
          productType: row.product_type || "N/A",
          quantity: Number(row.quantity || 0),
          createdAt: row.created_at,
        })),
        returns: returns.map((row) => ({
          id: Number(row.id),
          productId: Number(row.product_id),
          productName: row.product_name || "",
          quantity: Number(row.quantity || 0),
          createdAt: row.created_at,
          isApproved: Number(row.isApproved || 0),
        })),
      });
    }

    return res.status(200).json({
      success: true,
      message: "Empty cylinder history fetched successfully",
      data: {
        items,
      },
    });
  } catch (error) {
    console.error("getDriverEmptyCylindersHistory error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch empty cylinders history",
      error: error.message,
    });
  }
};

export const createEmptyCylinderReturnRequest = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { driver_id, product_id, quantity } = req.body;

    const numericDriverId = await resolveDriverId(driver_id);
    const numericProductId = Number(product_id);
    const numericQuantity = Number(quantity);

    if (!numericDriverId) {
      return res.status(400).json({
        success: false,
        message: "valid driver_id is required",
      });
    }

    if (!numericProductId || Number.isNaN(numericProductId)) {
      return res.status(400).json({
        success: false,
        message: "product_id is required",
      });
    }

    if (
      !numericQuantity ||
      Number.isNaN(numericQuantity) ||
      numericQuantity <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "quantity must be greater than 0",
      });
    }

    await connection.beginTransaction();

    const [collectedRows] = await connection.execute(
      `
      SELECT
        COALESCE(SUM(si.empty_cylinder_qty), 0) AS collected_qty,
        COALESCE(SUM(CASE WHEN DATE(COALESCE(s.delivered_at, s.created_at)) = CURRENT_DATE() THEN si.empty_cylinder_qty ELSE 0 END), 0) AS today_collected_qty
      FROM sales s
      INNER JOIN sales_items si
        ON si.sale_id = s.id
      WHERE s.driver_id = ?
        AND s.status = 'DELIVERED'
        AND si.product_id = ?
        AND si.empty_cylinder_status IN ('DELIVERED', 'PARTIAL_DELIVERED')
        AND COALESCE(si.empty_cylinder_qty, 0) > 0
      `,
      [numericDriverId, numericProductId],
    );

    const [returnedRows] = await connection.execute(
      `
      SELECT
        COALESCE(SUM(st.quantity), 0) AS returned_qty,
        COALESCE(SUM(CASE WHEN DATE(st.created_at) = CURRENT_DATE() THEN st.quantity ELSE 0 END), 0) AS today_returned_qty
      FROM stock_transactions st
      LEFT JOIN sales linked_sale
        ON linked_sale.id = st.reference_id
       AND linked_sale.driver_id = st.driver_id
      WHERE st.driver_id = ?
        AND st.product_id = ?
        AND st.stock_from = 'driver'
        AND COALESCE(st.isApproved, 0) IN (0, 1)
        AND st.type = 'EMPTY_RETURN'
        AND linked_sale.id IS NULL
      `,
      [numericDriverId, numericProductId],
    );

    const collectedQty = Number(collectedRows[0]?.collected_qty || 0);
    const todayCollectedQty = Number(
      collectedRows[0]?.today_collected_qty || 0,
    );
    const returnedQty = Number(returnedRows[0]?.returned_qty || 0);
    const todayReturnedQty = Number(returnedRows[0]?.today_returned_qty || 0);

    const allTimeAvailable = Math.max(collectedQty - returnedQty, 0);
    const todayAvailable = Math.max(todayCollectedQty - todayReturnedQty, 0);
    const availableQty = Math.max(allTimeAvailable, todayAvailable);

    if (availableQty <= 0) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "No collected empty cylinders available for this product",
      });
    }

    if (numericQuantity > availableQty) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: `Only ${availableQty} empty cylinder(s) can be returned for this product`,
      });
    }

    await connection.execute(
      `
      INSERT INTO stock_transactions
      (
        product_id,
        stock_area_id,
        type,
        quantity,
        isApproved,
        reference_id,
        created_by,
        driver_id,
        stock_from,
        is_defective
      )
      VALUES (?, NULL, 'EMPTY_RETURN', ?, 0, ?, ?, ?, 'driver', 0)
      `,
      [
        numericProductId,
        numericQuantity,
        Date.now(),
        req.user?.id || null,
        numericDriverId,
      ],
    );

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Empty cylinder return request created successfully",
    });
  } catch (error) {
    await connection.rollback();

    console.error("createEmptyCylinderReturnRequest error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create empty cylinder return request",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getDriverReturnableEmptyProducts = async (req, res) => {
  try {
    const { driverId } = req.params;
    const search = String(req.query.search || "").trim();

    const numericDriverId = await resolveDriverId(driverId);

    if (!numericDriverId) {
      return res.status(400).json({
        success: false,
        message: "Valid driverId is required",
      });
    }

    const [rows] = await db.execute(
      `
      SELECT
        p.id,
        p.name,
        p.type,
        c.name AS category_name,

        COALESCE(collected_data.collected_qty, 0) AS collected_qty,
        COALESCE(returned_data.returned_qty, 0) AS returned_qty,
        COALESCE(returned_data.today_returned_qty, 0) AS today_returned_qty,
        COALESCE(today_collected_data.today_collected_qty, 0) AS today_collected_qty
      FROM products p
      LEFT JOIN categories c
        ON c.id = p.category_id

      LEFT JOIN (
        SELECT
          si.product_id,
          COALESCE(SUM(si.empty_cylinder_qty), 0) AS collected_qty
        FROM sales s
        INNER JOIN sales_items si
          ON si.sale_id = s.id
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
          AND si.empty_cylinder_status IN ('DELIVERED', 'PARTIAL_DELIVERED')
          AND COALESCE(si.empty_cylinder_qty, 0) > 0
        GROUP BY si.product_id
      ) collected_data
        ON collected_data.product_id = p.id

      LEFT JOIN (
        SELECT
          si.product_id,
          COALESCE(SUM(si.empty_cylinder_qty), 0) AS today_collected_qty
        FROM sales s
        INNER JOIN sales_items si
          ON si.sale_id = s.id
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
          AND si.empty_cylinder_status IN ('DELIVERED', 'PARTIAL_DELIVERED')
          AND COALESCE(si.empty_cylinder_qty, 0) > 0
          AND DATE(COALESCE(s.delivered_at, s.created_at)) = CURRENT_DATE()
        GROUP BY si.product_id
      ) today_collected_data
        ON today_collected_data.product_id = p.id

      LEFT JOIN (
        SELECT
          st.product_id,
          COALESCE(SUM(st.quantity), 0) AS returned_qty,
          COALESCE(SUM(CASE WHEN DATE(st.created_at) = CURRENT_DATE() THEN st.quantity ELSE 0 END), 0) AS today_returned_qty
        FROM stock_transactions st
        LEFT JOIN sales linked_sale
          ON linked_sale.id = st.reference_id
         AND linked_sale.driver_id = st.driver_id
        WHERE st.driver_id = ?
          AND st.stock_from = 'driver'
          AND COALESCE(st.isApproved, 0) IN (0, 1)
          AND st.type = 'EMPTY_RETURN'
          AND linked_sale.id IS NULL
        GROUP BY st.product_id
      ) returned_data
        ON returned_data.product_id = p.id

      WHERE (
        COALESCE(collected_data.collected_qty, 0) > 0
        OR COALESCE(returned_data.returned_qty, 0) > 0
      )
        AND (
          ? = ''
          OR p.name LIKE ?
        )

      ORDER BY p.name ASC
      `,
      [
        numericDriverId,
        numericDriverId,
        numericDriverId,
        search,
        `%${search}%`,
      ],
    );

    const data = rows.map((row) => {
      const collectedQty = Number(row.collected_qty || 0);
      const returnedQty = Number(row.returned_qty || 0);
      const todayCollectedQty = Number(row.today_collected_qty || 0);
      const todayReturnedQty = Number(row.today_returned_qty || 0);

      const allTimeAvailable = Math.max(collectedQty - returnedQty, 0);
      const todayAvailable = Math.max(todayCollectedQty - todayReturnedQty, 0);
      const availableQty = Math.max(allTimeAvailable, todayAvailable);

      return {
        id: Number(row.id),
        name: row.name,
        type: row.type,
        categoryName: row.category_name || "",
        collectedQty,
        returnedQty,
        availableQty,
      };
    });

    return res.status(200).json({
      success: true,
      message: "Returnable empty cylinder products fetched successfully",
      data,
    });
  } catch (error) {
    console.error("getDriverReturnableEmptyProducts error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch returnable empty cylinder products",
      error: error.message,
    });
  }
};

export const approveTodayEmptyCylinderReturns = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { driverId } = req.params;

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "driverId is required",
      });
    }

    const numericDriverId = Number(driverId);

    if (Number.isNaN(numericDriverId)) {
      return res.status(400).json({
        success: false,
        message: "driverId must be a valid number",
      });
    }

    await connection.beginTransaction();

    const [pendingRows] = await connection.execute(
      `
      SELECT
        st.id,
        st.product_id,
        st.quantity
      FROM stock_transactions st
      LEFT JOIN sales linked_sale
        ON linked_sale.id = st.reference_id
       AND linked_sale.driver_id = st.driver_id
      WHERE st.driver_id = ?
        AND st.stock_from = 'driver'
        AND st.type = 'EMPTY_RETURN'
        AND COALESCE(st.isApproved, 0) = 0
        AND linked_sale.id IS NULL
        AND DATE(st.created_at) = CURDATE()
      FOR UPDATE
      `,
      [numericDriverId],
    );

    if (!pendingRows.length) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: "No pending empty cylinder requests found for today",
      });
    }

    for (const row of pendingRows) {
      const transactionId = Number(row.id);
      const productId = Number(row.product_id);
      const qty = Number(row.quantity || 0);

      await connection.execute(
        `
        UPDATE stock_transactions
        SET isApproved = 1
        WHERE id = ?
          AND driver_id = ?
        `,
        [transactionId, numericDriverId],
      );

      if (productId && qty > 0) {
        await addEmptyStockToGodown(connection, productId, qty);
      }
    }

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "Today empty cylinders returned to godown successfully",
      data: {
        updatedCount: pendingRows.length,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("approveTodayEmptyCylinderReturns error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to approve today empty cylinder returns",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getDriverProfileHistory = async (req, res) => {
  try {
    const { driverId } = req.params;

    const parsedPage = parseInt(req.query.page, 10);
    const parsedLimit = parseInt(req.query.limit, 10);

    const safePage =
      Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;

    const safeLimit =
      Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 4;

    const offset = (safePage - 1) * safeLimit;

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "driverId is required",
      });
    }

    const numericDriverId = Number(driverId);

    if (Number.isNaN(numericDriverId)) {
      return res.status(400).json({
        success: false,
        message: "driverId must be a valid number",
      });
    }

    const [driverRows] = await db.execute(
      `
      SELECT
        d.id,
        d.user_id,
        d.vehicle_number,
        u.name,
        u.phone
      FROM users u
      LEFT JOIN drivers d
        ON d.user_id = u.id
      WHERE u.role = 'DRIVER'
        AND (
          d.id = ?
          OR d.user_id = ?
          OR u.id = ?
        )
      LIMIT 1
      `,
      [numericDriverId, numericDriverId, numericDriverId],
    );

    if (!driverRows.length) {
      return res.status(404).json({
        success: false,
        message: "Driver not found",
      });
    }

    const resolvedDriverId = driverRows[0].id ? Number(driverRows[0].id) : null;

    if (!resolvedDriverId) {
      return res.status(200).json({
        success: true,
        message: "Driver profile fetched successfully",
        data: {
          driver: {
            id: Number(numericDriverId),
            name: driverRows[0].name || "Driver",
            phone: driverRows[0].phone || "",
            vehicleNumber: "N/A",
          },
          performance: {
            today: 0,
            thisWeek: 0,
            total: 0,
          },
          items: [],
          pagination: {
            page: safePage,
            limit: safeLimit,
            totalItems: 0,
            totalPages: 1,
            hasNextPage: false,
            hasPrevPage: false,
          },
        },
      });
    }

    const [performanceRows] = await db.execute(
      `
      SELECT
        COALESCE(SUM(
          CASE
            WHEN DATE(s.created_at) = CURDATE()
            THEN COALESCE(si.delivered_qty, si.quantity, 0)
            ELSE 0
          END
        ), 0) AS today_count,

        COALESCE(SUM(
          CASE
            WHEN YEARWEEK(s.created_at, 1) = YEARWEEK(CURDATE(), 1)
            THEN COALESCE(si.delivered_qty, si.quantity, 0)
            ELSE 0
          END
        ), 0) AS this_week_count,

        COALESCE(SUM(
          COALESCE(si.delivered_qty, si.quantity, 0)
        ), 0) AS total_count
      FROM sales s
      INNER JOIN sales_items si
        ON si.sale_id = s.id
      WHERE s.driver_id = ?
        AND s.status = 'DELIVERED'
        AND si.status = 'DELIVERED'
      `,
      [resolvedDriverId],
    );

    const [dateRows] = await db.execute(
      `
      SELECT
        DATE(s.created_at) AS delivery_date
      FROM sales s
      WHERE s.driver_id = ?
        AND s.status = 'DELIVERED'
      GROUP BY DATE(s.created_at)
      ORDER BY delivery_date DESC
      LIMIT ${safeLimit} OFFSET ${offset}
      `,
      [resolvedDriverId],
    );

    const [countRows] = await db.execute(
      `
      SELECT COUNT(*) AS totalDates
      FROM (
        SELECT DATE(s.created_at) AS delivery_date
        FROM sales s
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
        GROUP BY DATE(s.created_at)
      ) t
      `,
      [resolvedDriverId],
    );

    const totalDates = Number(countRows[0]?.totalDates || 0);
    const totalPages = Math.max(Math.ceil(totalDates / safeLimit), 1);

    const items = [];

    for (const dateRow of dateRows) {
      const deliveryDate = dateRow.delivery_date;

      const [dailyRows] = await db.execute(
        `
        SELECT
          s.id AS sale_id,
          u.name AS customer_name,
          COALESCE(a.address, '') AS address,

          COALESCE(MAX(p.type), 'N/A') AS cylinder_type,

          COALESCE(
            SUM(COALESCE(si.delivered_qty, si.quantity, 0)),
            0
          ) AS quantity,

          COALESCE(s.total_amount, 0) AS total_amount,

          COALESCE(
            MAX(CASE WHEN pay.status = 'SUCCESS' THEN pay.method ELSE NULL END),
            s.payment_method,
            'N/A'
          ) AS payment_mode,

          s.created_at
        FROM sales s
        LEFT JOIN users u
          ON u.id = s.customer_id
        LEFT JOIN addresses a
          ON a.id = s.address_id
        LEFT JOIN sales_items si
          ON si.sale_id = s.id
        LEFT JOIN products p
          ON p.id = si.product_id
        LEFT JOIN payments pay
          ON pay.sale_id = s.id
        WHERE s.driver_id = ?
          AND s.status = 'DELIVERED'
          AND si.status = 'DELIVERED'
          AND DATE(s.created_at) = ?
        GROUP BY
          s.id,
          u.name,
          a.address,
          s.total_amount,
          s.payment_method,
          s.created_at
        ORDER BY s.created_at ASC, s.id ASC
        `,
        [resolvedDriverId, deliveryDate],
      );

      const totalAmount = dailyRows.reduce(
        (sum, row) => sum + Number(row.total_amount || 0),
        0,
      );

      const totalDeliveries = dailyRows.length;

      items.push({
        date: deliveryDate,
        totalAmount,
        totalDeliveries,
        deliveries: dailyRows.map((row) => ({
          saleId: Number(row.sale_id),
          customerName: row.customer_name || "Unknown Customer",
          address: row.address || "No address available",
          cylinderType: row.cylinder_type || "N/A",
          quantity: Number(row.quantity || 0),
          totalAmount: Number(row.total_amount || 0),
          paymentMode: row.payment_mode || "N/A",
          deliveredAt: row.created_at,
        })),
      });
    }

    return res.status(200).json({
      success: true,
      message: "Driver profile history fetched successfully",
      data: {
        driver: {
          id: Number(resolvedDriverId),
          name: driverRows[0].name || "Driver",
          phone: driverRows[0].phone || "",
          vehicleNumber: driverRows[0].vehicle_number || "N/A",
        },
        performance: {
          today: Number(performanceRows[0]?.today_count || 0),
          thisWeek: Number(performanceRows[0]?.this_week_count || 0),
          total: Number(performanceRows[0]?.total_count || 0),
        },
        items,
        pagination: {
          page: safePage,
          limit: safeLimit,
          totalItems: totalDates,
          totalPages,
          hasNextPage: safePage < totalPages,
          hasPrevPage: safePage > 1,
        },
      },
    });
  } catch (error) {
    console.error("getDriverProfileHistory error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch driver profile history",
      error: error.message,
    });
  }
};

export const searchProductsForDriverApp = async (req, res) => {
  try {
    const { type, search = "" } = req.query;

    const searchText = String(search).trim();

    const params = [`%${searchText}%`];
    let typeFilter = "";

    if (type && ["DOMESTIC", "COMMERCIAL"].includes(String(type))) {
      typeFilter = "AND p.type = ?";
      params.push(String(type));
    }

    const [rows] = await db.execute(
      `
      SELECT
        p.id,
        p.name,
        p.type,
        p.price,
        c.name AS category_name,
        COALESCE((SELECT SUM(s.quantity) FROM stock s WHERE s.product_id = p.id), 0) AS stock_quantity
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.name LIKE ?
        ${typeFilter}
      ORDER BY p.name ASC
      LIMIT 20
      `,
      params,
    );

    return res.status(200).json({
      success: true,
      message: "Products fetched successfully",
      data: rows.map((item) => ({
        id: Number(item.id),
        name: item.name,
        type: item.type,
        price: Number(item.price || 0),
        categoryName: item.category_name || "",
        stock: Number(item.stock_quantity || 0),
        inStock: Number(item.stock_quantity || 0) > 0,
      })),
    });
  } catch (error) {
    console.error("searchProductsForDriverApp error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch products",
      error: error.message,
    });
  }
};

export const getAllocatedCylinders = async (req, res) => {
  try {
    const driverId = await resolveDriverId(req.params.driverId);

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "Valid driverId is required",
      });
    }

    const [rows] = await db.execute(
      `
      SELECT
        asi.id AS allocation_sales_item_id,
        asi.sale_id AS allocation_sale_id,
        COALESCE(asi.batch_no, CONCAT('B-', asi.sale_id)) AS batch_no,
        COALESCE(a.assigned_at, a.created_at) AS allocated_at,

        p.id AS product_id,
        p.name AS product_name,
        p.type AS product_type,

        COALESCE(asi.quantity, 0) AS total_allocated,

        COALESCE(delivered_data.delivered_qty, 0) AS delivered_qty,
        COALESCE(return_data.return_qty, 0) AS return_qty,
        COALESCE(return_data.defective_qty, 0) AS defective_qty

      FROM sales_items asi
      INNER JOIN sales a
        ON a.id = asi.sale_id
      INNER JOIN products p
        ON p.id = asi.product_id

      LEFT JOIN (
        SELECT
          child.allocation_sales_item_id,
          SUM(COALESCE(child.delivered_qty, child.quantity, 0)) AS delivered_qty
        FROM sales_items child
        INNER JOIN sales cs
          ON cs.id = child.sale_id
        WHERE child.allocation_sales_item_id IS NOT NULL
          AND cs.status = 'DELIVERED'
        GROUP BY child.allocation_sales_item_id
      ) delivered_data
        ON delivered_data.allocation_sales_item_id = asi.id

      LEFT JOIN (
        SELECT
          st.allocation_sales_item_id,
          SUM(CASE WHEN st.is_defective = 0 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS return_qty,
          SUM(CASE WHEN st.is_defective = 1 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS defective_qty
        FROM stock_transactions st
        WHERE st.stock_from = 'driver'
          AND st.type = 'PURCHASE_RETURN'
          AND st.isApproved IN (0, 1)
          AND st.allocation_sales_item_id IS NOT NULL
        GROUP BY st.allocation_sales_item_id
      ) return_data
        ON return_data.allocation_sales_item_id = asi.id

      WHERE a.driver_id = ?
        AND a.status = 'ASSIGNED'
        AND asi.allocation_sales_item_id IS NULL

      ORDER BY COALESCE(a.assigned_at, a.created_at) DESC, asi.id DESC
      `,
      [driverId],
    );

    const today = getTodayIsoDate();

    const items = rows.map((row) => {
      const totalAllocated = toNumber(row.total_allocated);
      const delivered = toNumber(row.delivered_qty);
      const returned = toNumber(row.return_qty);
      const defective = toNumber(row.defective_qty);
      const pending = Math.max(
        totalAllocated - delivered - returned - defective,
        0,
      );

      // Batches handed over on an earlier day are still open: they were carried
      // forward instead of blocking today's allocation.
      const allocatedDate = toIsoDateString(row.allocated_at);
      const isCarryForward = Boolean(allocatedDate && allocatedDate < today);

      return {
        id: Number(row.allocation_sales_item_id),
        saleItemId: Number(row.allocation_sales_item_id),
        saleId: Number(row.allocation_sale_id),

        allocationSaleId: Number(row.allocation_sale_id),
        allocationSalesItemId: Number(row.allocation_sales_item_id),
        batchNo: row.batch_no,

        productId: Number(row.product_id),
        productName: row.product_name,
        productType: row.product_type,
        size: getProductSizeFromName(row.product_name),

        totalAllocated,
        delivered,
        returned,
        defective,
        pending,

        allocatedDate,
        isCarryForward,

        lastAllocatedAt: row.allocated_at,
        latestSaleId: Number(row.allocation_sale_id),
      };
    });

    const summary = items.reduce(
      (acc, item) => {
        acc.totalAllocated += item.totalAllocated;
        acc.delivered += item.delivered;
        acc.returned += item.returned;
        acc.defective += item.defective;
        acc.pending += item.pending;

        if (item.isCarryForward) {
          acc.carriedForward += item.pending;
        } else {
          acc.allocatedToday += item.totalAllocated;
        }

        return acc;
      },
      {
        totalAllocated: 0,
        delivered: 0,
        returned: 0,
        defective: 0,
        pending: 0,
        carriedForward: 0,
        allocatedToday: 0,
      },
    );

    return res.status(200).json({
      success: true,
      message: "Allocated cylinders fetched successfully",
      data: {
        summary,
        items,
      },
    });
  } catch (error) {
    console.error("getAllocatedCylinders error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch allocated cylinders",
      error: error.message,
    });
  }
};

export const getDriverDeliveryDetails = async (req, res) => {
  try {
    const { saleId } = req.params;

    if (!saleId) {
      return res.status(400).json({
        success: false,
        message: "saleId is required",
      });
    }

    const [rows] = await db.execute(
      `
      SELECT
        s.id AS sale_id,
        s.status AS sale_status,
        s.total_amount,
        s.payment_method,
        s.created_at,
        s.delivered_at,

        u.name AS customer_name,
        u.phone AS customer_phone,

        a.address,

        p.name AS product_name,
        p.type AS product_type,
        p.price AS product_price,

        si.quantity,
        si.delivered_qty,
        si.empty_cylinder_qty,
        si.empty_cylinder_status,
        si.defective_qty,
        si.price AS item_price,

        pay.method AS payment_method_used,
        pay.amount AS payment_amount,
        pay.status AS payment_status

      FROM sales s
      LEFT JOIN users u ON u.id = s.customer_id
      LEFT JOIN addresses a ON a.id = s.address_id
      LEFT JOIN sales_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      LEFT JOIN payments pay ON pay.sale_id = s.id

      WHERE s.id = ?
      LIMIT 1
      `,
      [saleId],
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Delivery not found",
      });
    }

    const row = rows[0];

    return res.status(200).json({
      success: true,
      message: "Delivery details fetched successfully",
      data: {
        saleId: row.sale_id,
        status: row.sale_status,
        deliveredAt: row.delivered_at,
        createdAt: row.created_at,

        customer: {
          name: row.customer_name || "N/A",
          phone: row.customer_phone || "N/A",
          address: row.address || "N/A",
        },

        sales: {
          cylinderType:
            row.product_type === "COMMERCIAL" ? "Commercial" : "Domestic",
          productName: row.product_name || "N/A",
          quantity: Number(row.quantity || 0),
          deliveredQty: Number(row.delivered_qty || 0),
          unitPrice: Number(row.item_price || row.product_price || 0),
          total: Number(row.total_amount || 0),
        },

        returnCylinder: {
          emptyCollected:
            Number(row.empty_cylinder_qty || 0) > 0 ? "Yes" : "No",
          emptyCount: Number(row.empty_cylinder_qty || 0),
          emptyStatus: row.empty_cylinder_status || "PENDING",
          defectiveQty: Number(row.defective_qty || 0),
        },

        payment: {
          method: row.payment_method_used || row.payment_method || "N/A",
          amount: Number(row.payment_amount || row.total_amount || 0),
          status: row.payment_status || "PENDING",
        },
      },
    });
  } catch (error) {
    console.error("getDriverDeliveryDetails error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch delivery details",
      error: error.message,
    });
  }
};

export const createInHandRequest = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const {
      driver_id,
      product_id,
      quantity,
      reason = "",
      is_defective = 0,

      allocation_sale_id = null,
      allocation_sales_item_id = null,
      batch_no = null,

      items = [],
    } = req.body;

    const numericDriverId = await resolveDriverId(driver_id);

    if (!numericDriverId) {
      return res.status(400).json({
        success: false,
        message: "valid driver_id is required",
      });
    }

    const normalizedItems =
      Array.isArray(items) && items.length
        ? items
        : [
            {
              product_id,
              quantity,
              allocation_sale_id,
              allocation_sales_item_id,
              batch_no,
            },
          ];

    const validItems = normalizedItems.filter(
      (item) => Number(item.product_id) && Number(item.quantity) > 0,
    );

    if (!validItems.length) {
      return res.status(400).json({
        success: false,
        message: "At least one valid item is required",
      });
    }

    await connection.beginTransaction();

    for (const item of validItems) {
      const numericProductId = Number(item.product_id);
      const numericQuantity = Number(item.quantity);
      const allocationSalesItemId = item.allocation_sales_item_id
        ? Number(item.allocation_sales_item_id)
        : null;
      const allocationSaleId = item.allocation_sale_id
        ? Number(item.allocation_sale_id)
        : null;

      if (allocationSalesItemId) {
        const [batchRows] = await connection.execute(
          `
          SELECT
            asi.id AS allocation_sales_item_id,
            asi.sale_id AS allocation_sale_id,
            COALESCE(asi.batch_no, CONCAT('B-', asi.sale_id)) AS batch_no,
            asi.product_id,
            COALESCE(asi.quantity, 0) AS total_allocated,

            COALESCE(delivered_data.delivered_qty, 0) AS delivered_qty,
            COALESCE(return_data.return_qty, 0) AS return_qty,
            COALESCE(return_data.defective_qty, 0) AS defective_qty

          FROM sales_items asi
          INNER JOIN sales a
            ON a.id = asi.sale_id

          LEFT JOIN (
            SELECT
              child.allocation_sales_item_id,
              SUM(COALESCE(child.delivered_qty, child.quantity, 0)) AS delivered_qty
            FROM sales_items child
            INNER JOIN sales cs
              ON cs.id = child.sale_id
            WHERE child.allocation_sales_item_id IS NOT NULL
              AND cs.status = 'DELIVERED'
            GROUP BY child.allocation_sales_item_id
          ) delivered_data
            ON delivered_data.allocation_sales_item_id = asi.id

          LEFT JOIN (
            SELECT
              st.allocation_sales_item_id,
              SUM(CASE WHEN st.is_defective = 0 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS return_qty,
              SUM(CASE WHEN st.is_defective = 1 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS defective_qty
            FROM stock_transactions st
            WHERE st.stock_from = 'driver'
              AND st.type = 'PURCHASE_RETURN'
              AND st.isApproved IN (0, 1)
              AND st.allocation_sales_item_id IS NOT NULL
            GROUP BY st.allocation_sales_item_id
          ) return_data
            ON return_data.allocation_sales_item_id = asi.id

          WHERE asi.id = ?
            AND a.driver_id = ?
            AND asi.product_id = ?
          LIMIT 1
          FOR UPDATE
          `,
          [allocationSalesItemId, numericDriverId, numericProductId],
        );

        if (!batchRows.length) {
          await connection.rollback();
          return res.status(404).json({
            success: false,
            message: "Selected batch item not found",
          });
        }

        const batch = batchRows[0];

        const available =
          toNumber(batch.total_allocated) -
          toNumber(batch.delivered_qty) -
          toNumber(batch.return_qty) -
          toNumber(batch.defective_qty);

        if (numericQuantity > available) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: `Only ${available} cylinder(s) available for request in this batch`,
          });
        }
      }

      await connection.execute(
        `
        INSERT INTO stock_transactions
        (
          product_id,
          stock_area_id,
          type,
          quantity,
          isApproved,
          reference_id,
          created_by,
          driver_id,
          stock_from,
          is_defective,
          batch_no,
          allocation_sale_id,
          allocation_sales_item_id
        )
        VALUES (?, NULL, 'PURCHASE_RETURN', ?, 0, ?, ?, ?, 'driver', ?, ?, ?, ?)
        `,
        [
          numericProductId,
          numericQuantity,
          allocationSaleId || Date.now(),
          req.user?.id || null,
          numericDriverId,
          Number(is_defective) === 1 ? 1 : 0,
          item.batch_no ||
            (allocationSaleId ? getBatchNo(allocationSaleId) : null),
          allocationSaleId,
          allocationSalesItemId,
        ],
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message:
        Number(is_defective) === 1
          ? "Defective request sent for approval"
          : "Return request sent for approval",
    });
  } catch (error) {
    await connection.rollback();

    console.error("createInHandRequest error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create in-hand request",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getAllocatedBatchDetail = async (req, res) => {
  try {
    const driverId = await resolveDriverId(req.params.driverId);
    const allocationSalesItemId = Number(req.params.allocationSalesItemId);

    if (!driverId || !allocationSalesItemId) {
      return res.status(400).json({
        success: false,
        message: "driverId and allocationSalesItemId are required",
      });
    }

    const [rows] = await db.execute(
      `
      SELECT
        asi.id AS allocation_sales_item_id,
        asi.sale_id AS allocation_sale_id,
        COALESCE(asi.batch_no, CONCAT('B-', asi.sale_id)) AS batch_no,
        COALESCE(a.assigned_at, a.created_at) AS allocated_at,

        p.id AS product_id,
        p.name AS product_name,
        p.type AS product_type,

        COALESCE(asi.quantity, 0) AS total_allocated,
        COALESCE(delivered_data.delivered_qty, 0) AS delivered_qty,
        COALESCE(return_data.return_qty, 0) AS return_qty,
        COALESCE(return_data.defective_qty, 0) AS defective_qty

      FROM sales_items asi
      INNER JOIN sales a
        ON a.id = asi.sale_id
      INNER JOIN products p
        ON p.id = asi.product_id

      LEFT JOIN (
        SELECT
          child.allocation_sales_item_id,
          SUM(COALESCE(child.delivered_qty, child.quantity, 0)) AS delivered_qty
        FROM sales_items child
        INNER JOIN sales cs
          ON cs.id = child.sale_id
        WHERE child.allocation_sales_item_id IS NOT NULL
          AND cs.status = 'DELIVERED'
        GROUP BY child.allocation_sales_item_id
      ) delivered_data
        ON delivered_data.allocation_sales_item_id = asi.id

      LEFT JOIN (
        SELECT
          st.allocation_sales_item_id,
          SUM(CASE WHEN st.is_defective = 0 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS return_qty,
          SUM(CASE WHEN st.is_defective = 1 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS defective_qty
        FROM stock_transactions st
        WHERE st.stock_from = 'driver'
          AND st.type = 'PURCHASE_RETURN'
          AND st.isApproved IN (0, 1)
          AND st.allocation_sales_item_id IS NOT NULL
        GROUP BY st.allocation_sales_item_id
      ) return_data
        ON return_data.allocation_sales_item_id = asi.id

      WHERE a.driver_id = ?
        AND asi.id = ?
        AND asi.allocation_sales_item_id IS NULL
      LIMIT 1
      `,
      [driverId, allocationSalesItemId],
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Batch not found",
      });
    }

    const row = rows[0];

    const totalAllocated = toNumber(row.total_allocated);
    const delivered = toNumber(row.delivered_qty);
    const returned = toNumber(row.return_qty);
    const defective = toNumber(row.defective_qty);
    const pending = Math.max(
      totalAllocated - delivered - returned - defective,
      0,
    );

    return res.status(200).json({
      success: true,
      message: "Batch detail fetched successfully",
      data: {
        allocationSaleId: Number(row.allocation_sale_id),
        allocationSalesItemId: Number(row.allocation_sales_item_id),
        batchNo: row.batch_no,

        productId: Number(row.product_id),
        productName: row.product_name,
        productType: row.product_type,
        size: getProductSizeFromName(row.product_name),

        totalAllocated,
        delivered,
        returned,
        defective,
        pending,

        allocatedAt: row.allocated_at,

        returnItems: [
          {
            productId: Number(row.product_id),
            productName: row.product_name,
            productType: row.product_type,
            size: getProductSizeFromName(row.product_name),
            maxQuantity: pending,
          },
        ],
      },
    });
  } catch (error) {
    console.error("getAllocatedBatchDetail error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch batch detail",
      error: error.message,
    });
  }
};

export const getAvailableBatchesForDriver = async (req, res) => {
  try {
    const driverId = await resolveDriverId(req.params.driverId);
    const { product_id } = req.query;

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "Valid driverId is required",
      });
    }

    const productFilter = product_id ? "AND asi.product_id = ?" : "";
    const params = product_id ? [driverId, Number(product_id)] : [driverId];

    const [rows] = await db.execute(
      `
      SELECT
        asi.id AS allocation_sales_item_id,
        asi.sale_id AS allocation_sale_id,
        COALESCE(asi.batch_no, CONCAT('B-', asi.sale_id)) AS batch_no,
        COALESCE(a.assigned_at, a.created_at) AS allocated_at,

        p.id AS product_id,
        p.name AS product_name,
        p.type AS product_type,
        p.price AS product_price,

        COALESCE(asi.quantity, 0) AS total_allocated,
        COALESCE(delivered_data.delivered_qty, 0) AS delivered_qty,
        COALESCE(return_data.return_qty, 0) AS return_qty,
        COALESCE(return_data.defective_qty, 0) AS defective_qty

      FROM sales_items asi
      INNER JOIN sales a
        ON a.id = asi.sale_id
      INNER JOIN products p
        ON p.id = asi.product_id

      LEFT JOIN (
        SELECT
          child.allocation_sales_item_id,
          SUM(COALESCE(child.delivered_qty, child.quantity, 0)) AS delivered_qty
        FROM sales_items child
        INNER JOIN sales cs
          ON cs.id = child.sale_id
        WHERE child.allocation_sales_item_id IS NOT NULL
          AND cs.status = 'DELIVERED'
        GROUP BY child.allocation_sales_item_id
      ) delivered_data
        ON delivered_data.allocation_sales_item_id = asi.id

      LEFT JOIN (
        SELECT
          st.allocation_sales_item_id,
          SUM(CASE WHEN st.is_defective = 0 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS return_qty,
          SUM(CASE WHEN st.is_defective = 1 THEN COALESCE(st.quantity, 0) ELSE 0 END) AS defective_qty
        FROM stock_transactions st
        WHERE st.stock_from = 'driver'
          AND st.type = 'PURCHASE_RETURN'
          AND st.isApproved IN (0, 1)
          AND st.allocation_sales_item_id IS NOT NULL
        GROUP BY st.allocation_sales_item_id
      ) return_data
        ON return_data.allocation_sales_item_id = asi.id

      WHERE a.driver_id = ?
        AND a.status = 'ASSIGNED'
        AND asi.allocation_sales_item_id IS NULL
        ${productFilter}

      ORDER BY COALESCE(a.assigned_at, a.created_at) DESC, asi.id DESC
      `,
      params,
    );

    const batches = rows
      .map((row) => {
        const totalAllocated = toNumber(row.total_allocated);
        const delivered = toNumber(row.delivered_qty);
        const returned = toNumber(row.return_qty);
        const defective = toNumber(row.defective_qty);
        const pending = Math.max(
          totalAllocated - delivered - returned - defective,
          0,
        );

        return {
          allocationSaleId: Number(row.allocation_sale_id),
          allocationSalesItemId: Number(row.allocation_sales_item_id),
          batchNo: row.batch_no,

          productId: Number(row.product_id),
          productName: row.product_name,
          productType: row.product_type,
          productPrice: Number(row.product_price || 0),
          size: getProductSizeFromName(row.product_name),

          totalAllocated,
          delivered,
          returned,
          defective,
          pending,

          allocatedAt: row.allocated_at,
        };
      })
      .filter((item) => item.pending > 0);

    return res.status(200).json({
      success: true,
      message: "Available batches fetched successfully",
      data: batches,
    });
  } catch (error) {
    console.error("getAvailableBatchesForDriver error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch available batches",
      error: error.message,
    });
  }
};

export const findBookingCustomer = async (req, res) => {
  try {
    const { phone } = req.query;

    if (!phone || !String(phone).trim()) {
      return res.status(400).json({
        success: false,
        message: "phone is required",
      });
    }

    const [rows] = await db.execute(
      `
      SELECT
        u.id,
        u.name,
        u.phone,
        a.id AS address_id,
        a.address
      FROM users u
      LEFT JOIN addresses a ON a.user_id = u.id
      WHERE u.role = 'CUSTOMER'
        AND u.phone = ?
      ORDER BY a.is_default DESC, a.id DESC
      LIMIT 1
      `,
      [String(phone).trim()],
    );

    if (!rows.length) {
      return res.status(200).json({
        success: true,
        message: "New customer",
        data: {
          exists: false,
          customer: null,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Customer found",
      data: {
        exists: true,
        customer: {
          id: Number(rows[0].id),
          name: rows[0].name,
          phone: rows[0].phone,
          addressId: rows[0].address_id ? Number(rows[0].address_id) : null,
          address: rows[0].address || "",
        },
      },
    });
  } catch (error) {
    console.error("findBookingCustomer error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to find customer",
      error: error.message,
    });
  }
};

export const createBookingCustomer = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { name, phone, address, geo_location_tag } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        message: "Customer name is required",
      });
    }

    if (!phone || !String(phone).trim()) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required",
      });
    }

    if (!address || !String(address).trim()) {
      return res.status(400).json({
        success: false,
        message: "Address is required",
      });
    }

    await connection.beginTransaction();

    const [existingRows] = await connection.execute(
      `
      SELECT id, name, phone
      FROM users
      WHERE phone = ?
        AND role = 'CUSTOMER'
      LIMIT 1
      `,
      [String(phone).trim()],
    );

    if (existingRows.length) {
      const [addressRows] = await connection.execute(
        `
        SELECT id, address
        FROM addresses
        WHERE user_id = ?
        ORDER BY is_default DESC, id DESC
        LIMIT 1
        `,
        [existingRows[0].id],
      );

      await connection.commit();

      return res.status(200).json({
        success: true,
        message: "Customer already exists",
        data: {
          customer: {
            id: Number(existingRows[0].id),
            name: existingRows[0].name,
            phone: existingRows[0].phone,
            addressId: addressRows[0]?.id ? Number(addressRows[0].id) : null,
            address: addressRows[0]?.address || "",
          },
        },
      });
    }

    const [userResult] = await connection.execute(
      `
      INSERT INTO users
      (
        name,
        phone,
        role,
        status,
        created_at
      )
      VALUES (?, ?, 'CUSTOMER', 'ACTIVE', NOW())
      `,
      [String(name).trim(), String(phone).trim()],
    );

    const customerId = userResult.insertId;

    const finalAddress = geo_location_tag
      ? `${String(address).trim()} | Geo: ${String(geo_location_tag).trim()}`
      : String(address).trim();

    const [addressResult] = await connection.execute(
      `
      INSERT INTO addresses
      (
        user_id,
        address,
        is_default,
        created_at
      )
      VALUES (?, ?, 1, NOW())
      `,
      [customerId, finalAddress],
    );

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Customer created successfully",
      data: {
        customer: {
          id: Number(customerId),
          name: String(name).trim(),
          phone: String(phone).trim(),
          addressId: Number(addressResult.insertId),
          address: finalAddress,
        },
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createBookingCustomer error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create customer",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const createDriverBooking = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const { driver_id, customer_id, address_id, items = [] } = req.body;

    const numericDriverId = await resolveDriverId(driver_id);
    const numericCustomerId = Number(customer_id);
    const numericAddressId = Number(address_id);

    if (!numericDriverId || !numericCustomerId || !numericAddressId) {
      return res.status(400).json({
        success: false,
        message: "valid driver_id, customer_id and address_id are required",
      });
    }

    const validItems = Array.isArray(items)
      ? items.filter(
          (item) => Number(item.product_id) && Number(item.quantity) > 0,
        )
      : [];

    if (!validItems.length) {
      return res.status(400).json({
        success: false,
        message: "At least one product quantity is required",
      });
    }

    await connection.beginTransaction();

    const productIds = validItems.map((item) => Number(item.product_id));
    const placeholders = productIds.map(() => "?").join(",");

    const [productRows] = await connection.execute(
      `
      SELECT id, name, type, price
      FROM products
      WHERE id IN (${placeholders})
        AND type = 'COMMERCIAL'
      `,
      productIds,
    );

    if (productRows.length !== productIds.length) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Only commercial products are allowed for booking",
      });
    }

    const productMap = new Map();
    productRows.forEach((item) => {
      productMap.set(Number(item.id), item);
    });

    let totalAmount = 0;

    validItems.forEach((item) => {
      const product = productMap.get(Number(item.product_id));
      totalAmount += Number(product.price || 0) * Number(item.quantity || 0);
    });

    const [driverUserRows] = await connection.execute(
      `SELECT d.user_id, u.agency_id FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.id = ? LIMIT 1`,
      [numericDriverId],
    );
    const agencyId = req.user?.agency_id || driverUserRows[0]?.agency_id || 1;

    const [saleResult] = await connection.execute(
      `
      INSERT INTO sales
      (
        agency_id,
        customer_id,
        driver_id,
        total_amount,
        payment_method,
        status,
        address_id,
        sale_type,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, NULL, 'PENDING', ?, 'BOOKING', NOW(), NOW())
      `,
      [agencyId, numericCustomerId, numericDriverId, totalAmount, numericAddressId],
    );

    const saleId = saleResult.insertId;

    for (const item of validItems) {
      const productId = Number(item.product_id);
      const quantity = Number(item.quantity || 0);
      const product = productMap.get(productId);
      const price = Number(product.price || 0) * quantity;

      const [salesItemResult] = await connection.execute(
        `
        INSERT INTO sales_items
        (
          agency_id,
          sale_id,
          product_id,
          quantity,
          price,
          status,
          delivered_qty,
          empty_cylinder_qty,
          empty_cylinder_status,
          defective_qty
        )
        VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, 'PENDING', 0)
        `,
        [agencyId, saleId, productId, quantity, price, quantity],
      );

      await connection.execute(
        `
        INSERT INTO stock_transactions
        (
          agency_id,
          product_id,
          stock_area_id,
          type,
          quantity,
          isApproved,
          reference_id,
          driver_id,
          created_by,
          stock_from,
          is_defective,
          allocation_sale_id,
          allocation_sales_item_id
        )
        VALUES (?, ?, NULL, 'BOOKING_ADD', ?, 0, ?, ?, ?, 'godown', 0, ?, ?)
        `,
        [
          agencyId,
          productId,
          quantity,
          saleId,
          numericDriverId,
          req.user?.id || null,
          saleId,
          salesItemResult.insertId,
        ],
      );
    }

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Booking created successfully",
      data: {
        saleId: Number(saleId),
        totalAmount,
      },
    });
  } catch (error) {
    await connection.rollback();
    console.error("createDriverBooking error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create booking",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const getDriverBookings = async (req, res) => {
  try {
    const driverId = await resolveDriverId(req.params.driverId);

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "Valid driverId is required",
      });
    }

    const [rows] = await db.execute(
      `
      SELECT
        s.id AS sale_id,
        s.status,
        s.total_amount,
        s.created_at,
        s.delivered_at,
        u.name AS customer_name,
        u.phone,
        a.address,
        COALESCE(SUM(si.quantity), 0) AS total_qty,
        COALESCE(MAX(p.type), 'COMMERCIAL') AS cylinder_type,
        GROUP_CONCAT(
          CONCAT(p.name, ' x ', si.quantity)
          ORDER BY p.name
          SEPARATOR ', '
        ) AS product_summary
      FROM sales s
      INNER JOIN users u ON u.id = s.customer_id
      LEFT JOIN addresses a ON a.id = s.address_id
      LEFT JOIN sales_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      WHERE s.driver_id = ?
        AND s.sale_type = 'BOOKING'
      GROUP BY
        s.id,
        s.status,
        s.total_amount,
        s.created_at,
        s.delivered_at,
        u.name,
        u.phone,
        a.address
      ORDER BY s.created_at DESC, s.id DESC
      `,
      [driverId],
    );

    const items = rows.map((item) => ({
      saleId: Number(item.sale_id),
      customerName: item.customer_name || "Unknown Customer",
      phone: item.phone || "",
      address: item.address || "",
      status: item.status,
      totalAmount: Number(item.total_amount || 0),
      totalQty: Number(item.total_qty || 0),
      cylinderType: item.cylinder_type || "COMMERCIAL",
      productSummary: item.product_summary || "",
      createdAt: item.created_at,
      deliveredAt: item.delivered_at,
    }));

    return res.status(200).json({
      success: true,
      message: "Bookings fetched successfully",
      data: {
        total: items.length,
        items,
      },
    });
  } catch (error) {
    console.error("getDriverBookings error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch bookings",
      error: error.message,
    });
  }
};

export const cancelDriverBooking = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const saleId = Number(req.params.saleId);
    const driverId = await resolveDriverId(req.body.driver_id);

    if (!saleId) {
      return res.status(400).json({
        success: false,
        message: "saleId is required",
      });
    }

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: "valid driver_id is required",
      });
    }

    await connection.beginTransaction();

    const [saleRows] = await connection.execute(
      `
      SELECT id, status
      FROM sales
      WHERE id = ?
        AND driver_id = ?
        AND sale_type = 'BOOKING'
      FOR UPDATE
      `,
      [saleId, driverId],
    );

    if (!saleRows.length) {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    if (saleRows[0].status !== "PENDING") {
      await connection.rollback();

      return res.status(400).json({
        success: false,
        message: "Only pending bookings can be cancelled",
      });
    }

    await connection.execute(
      `
      UPDATE sales
      SET status = 'CANCELLED',
          updated_at = NOW()
      WHERE id = ?
      `,
      [saleId],
    );

    await connection.execute(
      `
      UPDATE sales_items
      SET status = 'CANCELLED'
      WHERE sale_id = ?
      `,
      [saleId],
    );

    await connection.commit();

    return res.status(200).json({
      success: true,
      message: "Booking cancelled successfully",
    });
  } catch (error) {
    await connection.rollback();
    console.error("cancelDriverBooking error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to cancel booking",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
