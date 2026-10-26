import db from "../config/db.js";

export const getUserSettings = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = Number(req.params.id);

    const [rows] = await connection.query(
      `
      SELECT
        u.id,
        u.name,
        COALESCE(a.agency_name, u.company_name) AS agency_name,
        u.company_name,
        u.email,
        u.phone,
        u.role,
        u.status,
        u.created_at
      FROM users u
      LEFT JOIN agencies a ON u.agency_id = a.id
      WHERE u.id = ? AND u.agency_id = ?
      LIMIT 1
      `,
      [userId, req.user.agency_id]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: rows[0],
    });
  } catch (error) {
    console.error("getUserSettings error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch user settings",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};

export const updateUserSettings = async (req, res) => {
  const connection = await db.getConnection();

  try {
    const userId = Number(req.params.id);
    const { name, company_name, email, phone } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "Valid user id is required",
      });
    }

    if (!name || !company_name || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: "name, company_name, email and phone are required",
      });
    }

    const [existingUsers] = await connection.query(
      `SELECT id FROM users WHERE id = ? AND agency_id = ? LIMIT 1`,
      [userId, req.user.agency_id]
    );

    if (!existingUsers.length) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const [duplicateEmail] = await connection.query(
      `SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1`,
      [email, userId]
    );

    if (duplicateEmail.length) {
      return res.status(400).json({
        success: false,
        message: "Email is already in use by another user",
      });
    }

    const [duplicatePhone] = await connection.query(
      `SELECT id FROM users WHERE phone = ? AND id != ? LIMIT 1`,
      [phone, userId]
    );

    if (duplicatePhone.length) {
      return res.status(400).json({
        success: false,
        message: "Phone is already in use by another user",
      });
    }

    await connection.query(
      `
      UPDATE users
      SET
        name = ?,
        company_name = ?,
        email = ?,
        phone = ?
      WHERE id = ? AND agency_id = ?
      `,
      [name, company_name, email, phone, userId, req.user.agency_id]
    );

    const [updatedUserRows] = await connection.query(
      `
      SELECT
        id,
        name,
        company_name,
        email,
        phone,
        role,
        status,
        created_at
      FROM users
      WHERE id = ? AND agency_id = ?
      LIMIT 1
      `,
      [userId, req.user.agency_id]
    );

    return res.status(200).json({
      success: true,
      message: "User settings updated successfully",
      data: updatedUserRows[0],
    });
  } catch (error) {
    console.error("updateUserSettings error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update user settings",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};