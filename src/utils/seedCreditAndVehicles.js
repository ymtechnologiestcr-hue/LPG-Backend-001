import db from "../config/db.js";

export const seedCreditAndVehicles = async () => {
  const connection = await db.getConnection();
  try {
    const agencyId = 1;

    // 1. Ensure Customer "Hotel Taj" exists
    let [customers] = await connection.query(
      `SELECT id FROM users WHERE name = 'Hotel Taj' AND agency_id = ? LIMIT 1`,
      [agencyId]
    );
    let customerId;
    if (customers.length === 0) {
      const [userRes] = await connection.query(
        `
        INSERT INTO users (agency_id, name, company_name, email, phone, role, status, consumer_number)
        VALUES (?, 'Hotel Taj', 'Taj Hotels & Resorts', 'accounts@hoteltaj.com', '9876543210', 'CUSTOMER', 'ACTIVE', 'CR-HT-1001')
        `,
        [agencyId]
      );
      customerId = userRes.insertId;
      console.log("Created Customer Hotel Taj with ID:", customerId);
    } else {
      customerId = customers[0].id;
    }

    // 2. Find product 19 kg Commercial cylinder
    const [products] = await connection.query(
      `SELECT id, name, price FROM products WHERE (name LIKE '%19%' OR type = 'COMMERCIAL') LIMIT 1`
    );
    const product = products[0] || { id: 7, price: 2687, name: "19 KG" };

    // 3. Find a driver
    const [drivers] = await connection.query(
      `SELECT d.id FROM drivers d JOIN users u ON u.id = d.user_id WHERE u.agency_id = ? LIMIT 1`,
      [agencyId]
    );
    const driverId = drivers[0]?.id || 18;

    // 4. Check if Hotel Taj already has credit sales
    const [existingCreditSales] = await connection.query(
      `SELECT id FROM sales WHERE customer_id = ? AND payment_method = 'CREDIT'`,
      [customerId]
    );

    if (existingCreditSales.length === 0) {
      const qty = 10;
      const rate = Number(product.price || 2687);
      const totalAmount = rate * qty;

      // Sale 1: 30-10-2026
      const [sale1Res] = await connection.query(
        `
        INSERT INTO sales (agency_id, customer_id, driver_id, total_amount, payment_method, status, amount_received, pending_amount, credit_status, created_at, delivered_at)
        VALUES (?, ?, ?, ?, 'CREDIT', 'DELIVERED', 0.00, ?, 'PENDING', '2026-10-30 11:30:00', '2026-10-30 12:00:00')
        `,
        [agencyId, customerId, driverId, totalAmount, totalAmount]
      );
      await connection.query(
        `
        INSERT INTO sales_items (agency_id, sale_id, product_id, quantity, price, status, delivered_qty, empty_cylinder_qty)
        VALUES (?, ?, ?, ?, ?, 'DELIVERED', ?, 10)
        `,
        [agencyId, sale1Res.insertId, product.id, qty, rate, qty]
      );

      // Sale 2: 31-10-2026
      const [sale2Res] = await connection.query(
        `
        INSERT INTO sales (agency_id, customer_id, driver_id, total_amount, payment_method, status, amount_received, pending_amount, credit_status, created_at, delivered_at)
        VALUES (?, ?, ?, ?, 'CREDIT', 'DELIVERED', 0.00, ?, 'PENDING', '2026-10-31 10:15:00', '2026-10-31 11:00:00')
        `,
        [agencyId, customerId, driverId, totalAmount, totalAmount]
      );
      await connection.query(
        `
        INSERT INTO sales_items (agency_id, sale_id, product_id, quantity, price, status, delivered_qty, empty_cylinder_qty)
        VALUES (?, ?, ?, ?, ?, 'DELIVERED', ?, 8)
        `,
        [agencyId, sale2Res.insertId, product.id, qty, rate, qty]
      );

      console.log("Seeded 2 credit sales for Hotel Taj (30-10-2026 and 31-10-2026)");
    }

    // 5. Update vehicle document dates on drivers for demo/testing
    const [allDrivers] = await connection.query(`SELECT id FROM drivers LIMIT 5`);
    const demoVehicles = [
      { num: "KL-08-AU-4512", puc: "2027-04-10", fit: "2027-09-15", exp: "2027-12-01" }, // Valid
      { num: "KL-08-BV-8821", puc: "2026-11-12", fit: "2027-02-20", exp: "2027-06-30" }, // Expiring Soon (<= 30 days)
      { num: "KL-08-CW-3390", puc: "2026-09-15", fit: "2027-01-10", exp: "2027-05-18" }, // Expired
      { num: "KL-08-DX-7711", puc: "2027-06-25", fit: "2027-10-05", exp: "2027-11-20" }, // Valid
      { num: "KL-08-EY-9904", puc: "2026-11-20", fit: "2027-03-12", exp: "2027-08-14" }, // Expiring Soon
    ];

    for (let i = 0; i < allDrivers.length; i++) {
      const dv = demoVehicles[i % demoVehicles.length];
      await connection.query(
        `
        UPDATE drivers
        SET
          vehicle_number = COALESCE(vehicle_number, ?),
          pollution_expiry = COALESCE(pollution_expiry, ?),
          fitness_expiry = COALESCE(fitness_expiry, ?),
          explosives_expiry = COALESCE(explosives_expiry, ?)
        WHERE id = ?
        `,
        [dv.num, dv.puc, dv.fit, dv.exp, allDrivers[i].id]
      );
    }
    console.log("Updated vehicle document test dates on drivers");

    console.log("Seeding complete.");
  } catch (err) {
    console.error("Seeding error:", err);
  } finally {
    connection.release();
  }
};

