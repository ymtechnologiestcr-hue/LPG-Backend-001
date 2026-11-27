import db from "../config/db.js";

/**
 * Builds an agency-scoped SQL predicate for `products` rows.
 * Matches products explicitly created for the agency OR legacy shared products
 * (agency_id IS NULL) that this agency actually holds stock or transactions for.
 */
export const getAgencyProductSqlFilter = (alias = "p") => `
  (
    ${alias}.agency_id = ?
    OR (
      ${alias}.agency_id IS NULL
      AND (
        EXISTS (
          SELECT 1
          FROM stock s_ag
          WHERE s_ag.product_id = ${alias}.id
            AND s_ag.agency_id = ?
        )
        OR EXISTS (
          SELECT 1
          FROM stock_transactions st_ag
          WHERE st_ag.product_id = ${alias}.id
            AND st_ag.agency_id = ?
        )
        OR EXISTS (
          SELECT 1
          FROM sales_items si_ag
          INNER JOIN sales sl_ag ON sl_ag.id = si_ag.sale_id
          WHERE si_ag.product_id = ${alias}.id
            AND sl_ag.agency_id = ?
        )
        OR EXISTS (
          SELECT 1
          FROM purchase_load_items pli_ag
          INNER JOIN purchase_loads pl_ag ON pl_ag.id = pli_ag.load_id
          WHERE pli_ag.product_id = ${alias}.id
            AND pl_ag.agency_id = ?
        )
        OR EXISTS (
          SELECT 1
          FROM daily_stock_snapshots dss_ag
          WHERE dss_ag.product_id = ${alias}.id
            AND dss_ag.agency_id = ?
            AND (
              dss_ag.opening_stock > 0
              OR dss_ag.purchase_qty > 0
              OR dss_ag.sales_qty > 0
              OR dss_ag.closing_stock > 0
              OR dss_ag.empty_opening > 0
              OR dss_ag.empty_closing > 0
            )
        )
      )
    )
  )
`;

export const getAgencyProductFilterParams = (agencyId) => {
  const safeAgencyId = Number(agencyId || 1);
  return [
    safeAgencyId,
    safeAgencyId,
    safeAgencyId,
    safeAgencyId,
    safeAgencyId,
    safeAgencyId,
  ];
};

/**
 * Resolves a valid `stock_areas.id` belonging to `agencyId`, creating a default
 * stock area for that agency if none exists yet so foreign keys never fail.
 */
export const resolveOrCreateAgencyStockAreaId = async (
  connection,
  agencyId,
  preferredStockAreaId = null
) => {
  const conn = connection || db;
  const safeAgencyId = Number(agencyId || 1);

  if (preferredStockAreaId && Number(preferredStockAreaId) > 0) {
    const [preferred] = await conn.query(
      `SELECT id FROM stock_areas WHERE id = ? AND agency_id = ? LIMIT 1`,
      [Number(preferredStockAreaId), safeAgencyId]
    );
    if (preferred.length) {
      return Number(preferred[0].id);
    }
  }

  const [existing] = await conn.query(
    `SELECT id FROM stock_areas WHERE agency_id = ? ORDER BY id ASC LIMIT 1`,
    [safeAgencyId]
  );
  if (existing.length) {
    return Number(existing[0].id);
  }

  const baseName = `Main Godown - ${safeAgencyId}`;
  try {
    const [ins] = await conn.query(
      `INSERT INTO stock_areas (agency_id, name, address) VALUES (?, ?, 'Default Address')`,
      [safeAgencyId, baseName]
    );
    return Number(ins.insertId);
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") {
      const [retryRows] = await conn.query(
        `SELECT id FROM stock_areas WHERE agency_id = ? ORDER BY id ASC LIMIT 1`,
        [safeAgencyId]
      );
      if (retryRows.length) {
        return Number(retryRows[0].id);
      }
      const fallbackName = `Main Godown - ${safeAgencyId}-${Date.now()}`;
      const [ins2] = await conn.query(
        `INSERT INTO stock_areas (agency_id, name, address) VALUES (?, ?, 'Default Address')`,
        [safeAgencyId, fallbackName]
      );
      return Number(ins2.insertId);
    }
    throw err;
  }
};

/**
 * Resolves or creates a category owned by `agencyId`.
 */
export const resolveOrCreateAgencyCategoryId = async (
  connection,
  agencyId,
  categoryName
) => {
  const cleanName = String(categoryName || "").trim();
  const safeAgencyId = Number(agencyId || 1);
  if (!cleanName) return null;

  const [[existing]] = await connection.query(
    `SELECT id FROM categories WHERE agency_id = ? AND LOWER(name) = LOWER(?) LIMIT 1`,
    [safeAgencyId, cleanName]
  );
  if (existing) {
    return Number(existing.id);
  }

  try {
    const [ins] = await connection.query(
      `INSERT INTO categories (agency_id, name) VALUES (?, ?)`,
      [safeAgencyId, cleanName]
    );
    return Number(ins.insertId);
  } catch (err) {
    if (err?.code === "ER_DUP_ENTRY") {
      const [[retry]] = await connection.query(
        `SELECT id FROM categories WHERE agency_id = ? AND LOWER(name) = LOWER(?) LIMIT 1`,
        [safeAgencyId, cleanName]
      );
      if (retry) return Number(retry.id);
    }
    throw err;
  }
};

/**
 * Checks whether the given product is owned by or legitimately used by `agencyId`.
 */
export const verifyAgencyProductAccess = async (
  connection,
  agencyId,
  productId
) => {
  const safeAgencyId = Number(agencyId || 1);
  const [[row]] = await connection.query(
    `
    SELECT p.*, c.name AS current_category_name
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.id = ?
      AND ${getAgencyProductSqlFilter("p")}
    LIMIT 1
    `,
    [Number(productId), ...getAgencyProductFilterParams(safeAgencyId)]
  );
  return row || null;
};

/**
 * Checks whether any agency other than `agencyId` references `productId`.
 */
export const isProductSharedWithOtherAgencies = async (
  connection,
  agencyId,
  productId
) => {
  const safeAgencyId = Number(agencyId || 1);
  const prodId = Number(productId);

  const [[check]] = await connection.query(
    `
    SELECT (
      EXISTS (SELECT 1 FROM stock WHERE product_id = ? AND agency_id <> ?)
      OR EXISTS (SELECT 1 FROM stock_transactions WHERE product_id = ? AND agency_id <> ?)
      OR EXISTS (
        SELECT 1 FROM sales_items si
        INNER JOIN sales s ON s.id = si.sale_id
        WHERE si.product_id = ? AND s.agency_id <> ?
      )
      OR EXISTS (
        SELECT 1 FROM purchase_load_items pli
        INNER JOIN purchase_loads pl ON pl.id = pli.load_id
        WHERE pli.product_id = ? AND pl.agency_id <> ?
      )
      OR EXISTS (
        SELECT 1 FROM customer_new_connections
        WHERE product_id = ? AND agency_id <> ?
      )
    ) AS is_shared
    `,
    [
      prodId,
      safeAgencyId,
      prodId,
      safeAgencyId,
      prodId,
      safeAgencyId,
      prodId,
      safeAgencyId,
      prodId,
      safeAgencyId,
    ]
  );

  return Boolean(Number(check?.is_shared || 0));
};

/**
 * Ensures any mutation (edit, stock price update) operates on a `products` row
 * exclusively owned by `agencyId`. If the target product is a legacy shared row
 * (`agency_id IS NULL`) also referenced by other agencies, clones an isolated copy
 * for `agencyId` and remaps `agencyId`'s references cleanly inside the active transaction.
 */
export const ensureAgencyOwnedProductId = async (
  connection,
  agencyId,
  productId,
  preferredCategoryName = null
) => {
  const safeAgencyId = Number(agencyId || 1);
  const existing = await verifyAgencyProductAccess(
    connection,
    safeAgencyId,
    productId
  );
  if (!existing) {
    return null;
  }

  if (Number(existing.agency_id) === safeAgencyId) {
    return existing;
  }

  const sharedWithOthers = await isProductSharedWithOtherAgencies(
    connection,
    safeAgencyId,
    productId
  );

  const catName =
    String(preferredCategoryName || existing.current_category_name || "").trim();
  const targetCategoryId = catName
    ? await resolveOrCreateAgencyCategoryId(connection, safeAgencyId, catName)
    : existing.category_id;

  if (!sharedWithOthers) {
    await connection.query(
      `UPDATE products SET agency_id = ?, category_id = COALESCE(?, category_id) WHERE id = ?`,
      [safeAgencyId, targetCategoryId, Number(existing.id)]
    );
    return {
      ...existing,
      agency_id: safeAgencyId,
      category_id: targetCategoryId || existing.category_id,
    };
  }

  // Clone isolated product row for this agency
  const [cloned] = await connection.query(
    `INSERT INTO products (agency_id, name, type, category_id, price) VALUES (?, ?, ?, ?, ?)`,
    [
      safeAgencyId,
      existing.name,
      existing.type,
      targetCategoryId,
      existing.price,
    ]
  );
  const newProductId = Number(cloned.insertId);
  const oldProductId = Number(existing.id);

  // Remap this agency's own rows to the cloned product
  await connection.query(
    `UPDATE stock SET product_id = ? WHERE agency_id = ? AND product_id = ?`,
    [newProductId, safeAgencyId, oldProductId]
  );
  await connection.query(
    `UPDATE stock_transactions SET product_id = ? WHERE agency_id = ? AND product_id = ?`,
    [newProductId, safeAgencyId, oldProductId]
  );
  await connection.query(
    `UPDATE daily_stock_snapshots SET product_id = ? WHERE agency_id = ? AND product_id = ?`,
    [newProductId, safeAgencyId, oldProductId]
  );
  await connection.query(
    `
    UPDATE sales_items si
    INNER JOIN sales s ON s.id = si.sale_id
    SET si.product_id = ?
    WHERE s.agency_id = ? AND si.product_id = ?
    `,
    [newProductId, safeAgencyId, oldProductId]
  );
  await connection.query(
    `
    UPDATE purchase_load_items pli
    INNER JOIN purchase_loads pl ON pl.id = pli.load_id
    SET pli.product_id = ?
    WHERE pl.agency_id = ? AND pli.product_id = ?
    `,
    [newProductId, safeAgencyId, oldProductId]
  );
  await connection.query(
    `UPDATE customer_new_connections SET product_id = ? WHERE agency_id = ? AND product_id = ?`,
    [newProductId, safeAgencyId, oldProductId]
  );
  await connection.query(
    `
    UPDATE customer_new_connection_products cncp
    INNER JOIN customer_new_connections cnc ON cnc.id = cncp.connection_id
    SET cncp.product_id = ?
    WHERE cnc.agency_id = ? AND cncp.product_id = ?
    `,
    [newProductId, safeAgencyId, oldProductId]
  );
  await connection.query(
    `
    UPDATE driver_returns dr
    INNER JOIN drivers d ON d.id = dr.driver_id
    INNER JOIN users du ON du.id = d.user_id
    SET dr.product_id = ?
    WHERE COALESCE(d.agency_id, du.agency_id) = ? AND dr.product_id = ?
    `,
    [newProductId, safeAgencyId, oldProductId]
  );
  await connection.query(
    `
    UPDATE empty_cylinder_load_items ecli
    INNER JOIN empty_cylinder_loads ecl ON ecl.id = ecli.load_id
    SET ecli.product_id = ?
    WHERE ecl.agency_id = ? AND ecli.product_id = ?
    `,
    [newProductId, safeAgencyId, oldProductId]
  );

  return {
    ...existing,
    id: newProductId,
    agency_id: safeAgencyId,
    category_id: targetCategoryId,
  };
};

/**
 * Upserts a `stock` row cleanly for `(agencyId, productId, stockAreaId)`, promoting any
 * legacy `stock_area_id IS NULL` (or invalid-area) row rather than creating duplicate rows.
 */
export const upsertAgencyStockRow = async (
  connection,
  {
    agencyId,
    productId,
    stockAreaId,
    quantity,
    systemQuantity,
    emptyQuantity,
    systemEmptyQuantity,
  }
) => {
  const safeAgencyId = Number(agencyId || 1);
  const safeProductId = Number(productId);
  const safeAreaId = Number(stockAreaId);

  const [[exactRow]] = await connection.query(
    `SELECT id FROM stock WHERE product_id = ? AND stock_area_id = ? AND agency_id = ? LIMIT 1 FOR UPDATE`,
    [safeProductId, safeAreaId, safeAgencyId]
  );

  if (exactRow) {
    await connection.query(
      `
      UPDATE stock
      SET quantity = ?,
          system_quantity = ?,
          empty_quantity = ?,
          system_empty_quantity = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `,
      [quantity, systemQuantity, emptyQuantity, systemEmptyQuantity, exactRow.id]
    );
    return;
  }

  // Promote unassigned / foreign-area legacy row if present so stock totals stay accurate
  const [[orphanRow]] = await connection.query(
    `
    SELECT s.id
    FROM stock s
    LEFT JOIN stock_areas sa ON sa.id = s.stock_area_id AND sa.agency_id = s.agency_id
    WHERE s.product_id = ?
      AND s.agency_id = ?
      AND (s.stock_area_id IS NULL OR sa.id IS NULL)
    ORDER BY s.id ASC
    LIMIT 1
    FOR UPDATE
    `,
    [safeProductId, safeAgencyId]
  );

  if (orphanRow) {
    await connection.query(
      `
      UPDATE stock
      SET stock_area_id = ?,
          quantity = ?,
          system_quantity = ?,
          empty_quantity = ?,
          system_empty_quantity = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `,
      [
        safeAreaId,
        quantity,
        systemQuantity,
        emptyQuantity,
        systemEmptyQuantity,
        orphanRow.id,
      ]
    );
    return;
  }

  await connection.query(
    `
    INSERT INTO stock (
      product_id, stock_area_id, quantity, system_quantity,
      quantity_return, empty_quantity, system_empty_quantity,
      defective_quantity, agency_id
    )
    VALUES (?, ?, ?, ?, 0, ?, ?, 0, ?)
    `,
    [
      safeProductId,
      safeAreaId,
      quantity,
      systemQuantity,
      emptyQuantity,
      systemEmptyQuantity,
      safeAgencyId,
    ]
  );
};
