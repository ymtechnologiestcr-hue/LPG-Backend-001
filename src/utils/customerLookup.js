/**
 * Utility for flexible customer lookup and customer searching.
 * Supports finding customers by consumer number, phone number, consumer ID, or name.
 */

export const findCustomerForLookup = async (
  connection,
  { identifier = "", name = "", agencyId = null } = {}
) => {
  const term = String(identifier || "").trim();
  const customerName = String(name || "").trim();

  if (!term && !customerName) {
    return null;
  }

  const conditions = ["u.role = 'CUSTOMER'"];
  const params = [];

  if (agencyId) {
    conditions.push("u.agency_id = ?");
    params.push(agencyId);
  }

  if (term) {
    const cleanDigits = term.replace(/\D/g, "");
    const last10Digits = cleanDigits.length >= 10 ? cleanDigits.slice(-10) : "";
    const digitNum =
      cleanDigits.length > 0 && cleanDigits.length <= 10
        ? Number.parseInt(cleanDigits, 10)
        : null;

    const termConditions = [
      "u.consumer_number = ?",
      "u.phone = ?",
      "u.consumer_id = ?",
      "u.consumer_number LIKE CONCAT(?, '%')",
      "u.phone LIKE CONCAT(?, '%')",
      "u.consumer_number LIKE CONCAT('%', ?, '%')",
      "u.phone LIKE CONCAT('%', ?, '%')",
      "u.consumer_id LIKE CONCAT('%', ?, '%')",
    ];
    params.push(term, term, term, term, term, term, term, term);

    if (last10Digits && last10Digits !== term) {
      termConditions.push(
        "u.phone = ?",
        "u.consumer_number = ?",
        "u.phone LIKE CONCAT('%', ?, '%')",
        "u.consumer_number LIKE CONCAT('%', ?, '%')"
      );
      params.push(last10Digits, last10Digits, last10Digits, last10Digits);
    }

    if (digitNum) {
      termConditions.push("u.id = ?");
      params.push(digitNum);
    }

    conditions.push(`(${termConditions.join(" OR ")})`);
  }

  if (customerName) {
    conditions.push("u.name LIKE ?");
    params.push(`%${customerName}%`);
  }

  let orderClause = "ORDER BY u.id DESC";
  if (term) {
    const cleanDigits = term.replace(/\D/g, "");
    const last10Digits = cleanDigits.length >= 10 ? cleanDigits.slice(-10) : "";

    orderClause = `ORDER BY
      CASE
        WHEN u.consumer_number = ? THEN 1
        WHEN u.phone = ? THEN 2
        ${last10Digits ? "WHEN u.phone = ? THEN 3 WHEN u.consumer_number = ? THEN 4" : ""}
        WHEN u.consumer_id = ? THEN 5
        WHEN u.consumer_number LIKE CONCAT(?, '%') THEN 6
        WHEN u.phone LIKE CONCAT(?, '%') THEN 7
        WHEN u.consumer_number LIKE CONCAT('%', ?, '%') THEN 8
        WHEN u.phone LIKE CONCAT('%', ?, '%') THEN 9
        WHEN u.consumer_id LIKE CONCAT('%', ?, '%') THEN 10
        ELSE 11
      END ASC,
      u.id DESC`;

    const orderParams = [term, term];
    if (last10Digits) {
      orderParams.push(last10Digits, last10Digits);
    }
    orderParams.push(term, term, term, term, term, term);
    params.push(...orderParams);
  }

  const [rows] = await connection.query(
    `
    SELECT
      u.id,
      u.name,
      u.phone,
      u.consumer_number AS consumer_number,
      u.consumer_id AS consumer_id,
      COALESCE(a.address, '') AS address
    FROM users u
    LEFT JOIN addresses a ON a.user_id = u.id AND a.is_default = 1
    WHERE ${conditions.join(" AND ")}
    ${orderClause}
    LIMIT 1
    `,
    params
  );

  return rows[0] || null;
};

export const searchCustomersList = async (
  connection,
  { search = "", agencyId = null, limit = 4 } = {}
) => {
  const term = String(search || "").trim();
  const safeLimit = Math.max(parseInt(limit, 10) || 4, 1);

  const conditions = ["u.role = 'CUSTOMER'"];
  const params = [];

  if (agencyId) {
    conditions.push("u.agency_id = ?");
    params.push(agencyId);
  }

  if (term) {
    const cleanDigits = term.replace(/\D/g, "");
    const last10Digits = cleanDigits.length >= 10 ? cleanDigits.slice(-10) : "";
    const digitNum =
      cleanDigits.length > 0 && cleanDigits.length <= 10
        ? Number.parseInt(cleanDigits, 10)
        : null;

    const searchConditions = [
      "u.name LIKE ?",
      "u.phone LIKE ?",
      "u.consumer_number LIKE ?",
      "u.consumer_id LIKE ?",
      "u.email LIKE ?",
    ];
    params.push(
      `%${term}%`,
      `%${term}%`,
      `%${term}%`,
      `%${term}%`,
      `%${term}%`
    );

    if (last10Digits && last10Digits !== term) {
      searchConditions.push(
        "u.phone LIKE CONCAT('%', ?, '%')",
        "u.consumer_number LIKE CONCAT('%', ?, '%')"
      );
      params.push(last10Digits, last10Digits);
    }

    if (digitNum) {
      searchConditions.push("u.id = ?");
      params.push(digitNum);
    }

    conditions.push(`(${searchConditions.join(" OR ")})`);
  }

  let orderClause = "ORDER BY u.name ASC";
  if (term) {
    orderClause = `ORDER BY
      CASE
        WHEN u.consumer_number = ? THEN 1
        WHEN u.phone = ? THEN 2
        WHEN u.consumer_number LIKE CONCAT(?, '%') THEN 3
        WHEN u.phone LIKE CONCAT(?, '%') THEN 4
        WHEN u.name LIKE CONCAT(?, '%') THEN 5
        ELSE 6
      END ASC,
      u.name ASC`;
    params.push(term, term, term, term, term);
  }

  params.push(safeLimit);

  const [rows] = await connection.query(
    `
    SELECT
      u.id,
      u.name,
      u.phone,
      u.email,
      u.company_name,
      u.consumer_number AS consumer_number,
      COALESCE(a.address, '') AS address
    FROM users u
    LEFT JOIN addresses a ON a.user_id = u.id AND a.is_default = 1
    WHERE ${conditions.join(" AND ")}
    ${orderClause}
    LIMIT ?
    `,
    params
  );

  return rows;
};
