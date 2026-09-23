import { getFirebaseAdmin } from "../config/firebaseAdmin.js";
import bcrypt from "bcryptjs";
import db from "../config/db.js";
import { generateToken } from "../utils/generateToken.js";

const ALLOWED_ROLES = [
  "OWNER",
  "DRIVER",
  "GODOWN_MANAGER",
  "PURCHASE_MANAGER",
  "CASHIER",
  "SUPPORT",
  "CUSTOMER",
];


const OTP_TTL_MS = 5 * 60 * 1000;

const normalizeIdentifier = (value = "") => String(value).trim();
const normalizePhoneDigits = (value = "") => String(value).replace(/\D/g, "");

const maskPhone = (phone = "") => {
  const value = String(phone || "").trim();
  if (!value) return "";
  if (value.length <= 4) return value;
  return `${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
};

const maskEmail = (email = "") => {
  const value = String(email || "").trim();
  const [name, domain] = value.split("@");
  if (!name || !domain) return value;
  const visible = name.slice(0, 2);
  const hidden = "*".repeat(Math.max(1, name.length - 2));
  return `${visible}${hidden}@${domain}`;
};

const normalizeUser = (user, driverId = null) => ({
  id: Number(user.id),
  driver_id: driverId ? Number(driverId) : (user.driver_id ? Number(user.driver_id) : null),
  name: user.name || "",
  email: user.email || "",
  phone: user.phone || "",
  role: user.role,
  status: user.status,
  agency_id: user.agency_id ? Number(user.agency_id) : null,
});

const saveOtpLog = async ({ userId, identifier, otp, stage }) => {
  await db.execute(
    `
      INSERT INTO auth_otp_logs (user_id, identifier, otp, stage)
      VALUES (?, ?, ?, ?)
    `,
    [userId || null, String(identifier || ""), String(otp || ""), String(stage || "VERIFY")]
  );
};

const getUserByIdentifier = async (identifier) => {
  const value = normalizeIdentifier(identifier);
  const digits = normalizePhoneDigits(value);
  
  if (!value) return null;

  let query = `
    SELECT id, name, email, phone, password, role, status, agency_id
    FROM users
    WHERE LOWER(email) = LOWER(?)
  `;
  let params = [value];

  if (digits) {
    const lastTenDigits = digits.length >= 10 ? digits.slice(-10) : digits;
    query += `
      OR phone = ?
      OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), '.', '') = ?
      OR RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''), '.', ''), 10) = ?
    `;
    params.push(value, digits, lastTenDigits);
  }

  query += ` LIMIT 1`;

  const [rows] = await db.execute(query, params);

  return rows[0] || null;
};

const validateRoleAndStatus = (user) => {
  if (!user) {
    return { ok: false, status: 404, message: "User not found" };
  }

  if (!ALLOWED_ROLES.includes(user.role)) {
    return { ok: false, status: 403, message: "Role is not allowed in this app" };
  }

  if (user.status !== "ACTIVE") {
    return { ok: false, status: 403, message: "User is inactive" };
  }

  return { ok: true };
};

const respondWithLogin = async (res, user) => {
  let driverId = null;
  if (user.role === "DRIVER" || user.role === "DELIVERY_AGENT") {
    try {
      const [dRows] = await db.execute(
        "SELECT id FROM drivers WHERE user_id = ? LIMIT 1",
        [user.id]
      );
      if (dRows.length) {
        driverId = Number(dRows[0].id);
      } else {
        const [ins] = await db.execute(
          "INSERT INTO drivers (user_id, agency_id, is_available, rating, created_at) VALUES (?, ?, 1, 0.0, NOW())",
          [user.id, user.agency_id || null]
        );
        if (ins.insertId) {
          driverId = Number(ins.insertId);
        }
      }
    } catch (err) {
      console.warn("Could not find or create driver record for user:", user.id, err);
    }
  }

  const normalized = normalizeUser(user, driverId);
  return res.status(200).json({
    success: true,
    token: generateToken(normalized),
    user: normalized,
  });
};

export const googleLogin = async (req, res) => {
  const decoded = await getFirebaseAdmin().auth().verifyIdToken(req.body.token);

  let [rows] = await db.execute(
    "SELECT * FROM users WHERE email=?",
    [decoded.email]
  );

  let user = rows[0];

  if (!user) {
    const [r] = await db.execute(
      "INSERT INTO users (email) VALUES (?)",
      [decoded.email]
    );
    user = { id: r.insertId, email: decoded.email };
  }

  res.json({ token: generateToken(user), user });
};

export const phoneLogin = async (req, res) => {
  const decoded = await getFirebaseAdmin().auth().verifyIdToken(req.body.token);

  let [rows] = await db.execute(
    "SELECT * FROM users WHERE phone=?",
    [decoded.phone_number]
  );

  let user = rows[0];

  if (!user) {
    const [r] = await db.execute(
      "INSERT INTO users (phone) VALUES (?)",
      [decoded.phone_number]
    );
    user = { id: r.insertId, phone: decoded.phone_number };
  }

  res.json({ token: generateToken(user), user });
};

export const identifyAuthMethod = async (req, res) => {
  try {
    const { identifier } = req.body || {};

    if (!normalizeIdentifier(identifier)) {
      return res.status(400).json({
        success: false,
        message: "identifier is required",
      });
    }

    const user = await getUserByIdentifier(identifier);
    const validation = validateRoleAndStatus(user);

    if (!validation.ok) {
      return res.status(validation.status).json({
        success: false,
        message: validation.message,
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        identifier,
        availableMethods: {
          password: Boolean(user.password),
          otp: Boolean(user.phone || user.email),
        },
        role: user.role,
        masked: user.phone ? maskPhone(user.phone) : maskEmail(user.email),
      },
    });
  } catch (error) {
    console.error("identifyAuthMethod error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to identify auth method",
      error: error.message,
    });
  }
};

export const loginWithPassword = async (req, res) => {
  try {
    const { identifier, password } = req.body || {};

    if (!normalizeIdentifier(identifier) || !String(password || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "identifier and password are required",
      });
    }

    const user = await getUserByIdentifier(identifier);
    const validation = validateRoleAndStatus(user);

    if (!validation.ok) {
      return res.status(validation.status).json({
        success: false,
        message: validation.message,
      });
    }

    if (!user.password) {
      return res.status(400).json({
        success: false,
        message: "Password login is not available for this user",
      });
    }

    const isValid = await bcrypt.compare(String(password), String(user.password));

    if (!isValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid password",
      });
    }

    return await respondWithLogin(res, user);
  } catch (error) {
    console.error("loginWithPassword error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to login with password",
      error: error.message,
    });
  }
};

export const requestOtpLogin = async (req, res) => {
  try {
    const { identifier } = req.body || {};

    if (!normalizeIdentifier(identifier)) {
      return res.status(400).json({
        success: false,
        message: "identifier is required",
      });
    }

    const user = await getUserByIdentifier(identifier);
    const validation = validateRoleAndStatus(user);

    if (!validation.ok) {
      return res.status(validation.status).json({
        success: false,
        message: validation.message,
      });
    }

    const otp = `${Math.floor(100000 + Math.random() * 900000)}`;

    await saveOtpLog({
      userId: Number(user.id),
      identifier,
      otp,
      stage: "REQUEST",
    });

    // Development-friendly OTP visibility in server logs.
    console.log(`[AUTH OTP] user=${user.id} role=${user.role} otp=${otp}`);

    return res.status(200).json({
      success: true,
      message: "OTP sent successfully",
      data: {
        expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
        masked: user.phone ? maskPhone(user.phone) : maskEmail(user.email),
      },
    });
  } catch (error) {
    console.error("requestOtpLogin error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to request OTP",
      error: error.message,
    });
  }
};

export const verifyOtpLogin = async (req, res) => {
  try {
    const { identifier, otp } = req.body || {};

    if (!normalizeIdentifier(identifier) || !String(otp || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "identifier and otp are required",
      });
    }

    const user = await getUserByIdentifier(identifier);
    const validation = validateRoleAndStatus(user);

    if (!validation.ok) {
      return res.status(validation.status).json({
        success: false,
        message: validation.message,
      });
    }

    await saveOtpLog({
      userId: Number(user.id),
      identifier,
      otp,
      stage: "VERIFY",
    });

    return await respondWithLogin(res, user);
  } catch (error) {
    console.error("verifyOtpLogin error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to verify OTP",
      error: error.message,
    });
  }
};
