import db from "../config/db.js";

export const registerAgency = async (req, res) => {
  const connection = await db.getConnection();

  try {
    // 0. Handle empty body
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields.",
      });
    }

    // Support both snake_case and camelCase inputs, safely trim strings
    const agency_name = (req.body.agency_name || req.body.agencyName || "").toString().trim();
    const gst_number = (req.body.gst_number || req.body.gstNumber || "").toString().trim();
    const phone_number = (req.body.phone_number || req.body.phoneNumber || "").toString().trim();
    const email_id = (req.body.email_id || req.body.emailId || "").toString().trim();
    const address = (req.body.address || "").toString().trim();
    const state = (req.body.state || "").toString().trim();
    const district = (req.body.district || "").toString().trim();
    const pin_code = (req.body.pin_code || req.body.pinCode || "").toString().trim();
    const subscription_plan = (req.body.subscription_plan || req.body.subscriptionPlan || "").toString().trim();
    
    // Handle boolean or string boolean for terms
    let terms_accepted = req.body.terms_accepted ?? req.body.agreedToTerms;
    if (terms_accepted === "true") terms_accepted = true;
    if (terms_accepted === "false") terms_accepted = false;

    // 1. Validation for required fields & format
    const invalidStatePlaceholders = [
      "- select one -",
      "-- select --",
      "select one",
      "select state",
      "- select -",
    ];
    const isStateInvalid =
      !state || invalidStatePlaceholders.includes(state.toLowerCase());

    const errors = {};
    if (!agency_name) errors.agency_name = "Agency name is required.";
    if (!gst_number) errors.gst_number = "GST number is required.";
    if (!phone_number) errors.phone_number = "Phone number is required.";
    if (!email_id) errors.email_id = "Email address is required.";
    if (!address) errors.address = "Address is required.";
    if (isStateInvalid) errors.state = "Please provide a valid state.";
    if (!district) errors.district = "District is required.";
    if (!pin_code) errors.pin_code = "PIN code is required.";

    if (Object.keys(errors).length > 0) {
      const missingList = Object.keys(errors).join(", ");
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missingList}.`,
        errors,
      });
    }

    if (!terms_accepted) {
      return res.status(400).json({
        success: false,
        message: "You must accept the Terms & Conditions.",
        errors: { terms_accepted: "You must accept the Terms & Conditions." },
      });
    }

    await connection.beginTransaction();

    // 2. Check if agency email or phone already exists in users table
    const [existingUsers] = await connection.execute(
      "SELECT id FROM users WHERE email = ? OR phone = ?",
      [email_id, phone_number],
    );

    if (existingUsers.length > 0) {
      await connection.rollback();
      return res.status(409).json({
        success: false,
        message: "An account with this email or phone number already exists.",
      });
    }

    // 3. Insert Agency
    const [agencyResult] = await connection.execute(
      `
      INSERT INTO agencies (
        agency_name, gst_number, phone_number, email_id, address, 
        state, district, pin_code, subscription_plan, terms_accepted, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
      `,
      [
        agency_name,
        gst_number,
        phone_number,
        email_id,
        address,
        state,
        district,
        pin_code,
        subscription_plan || null,
        terms_accepted ? 1 : 0,
      ],
    );

    const agencyId = agencyResult.insertId;

    // 4. Create an OWNER user for this new agency
    // The owner can log in using OTP via the phone number or email provided.
    await connection.execute(
      `
      INSERT INTO users (name, company_name, email, phone, role, status, agency_id)
      VALUES (?, ?, ?, ?, 'OWNER', 'ACTIVE', ?)
      `,
      [
        agency_name, // Defaulting owner name to agency name initially
        agency_name,
        email_id,
        phone_number,
        agencyId,
      ],
    );

    await connection.commit();

    return res.status(201).json({
      success: true,
      message: "Agency registered successfully! You can now log in.",
      agency_id: agencyId,
    });
  } catch (error) {
    await connection.rollback();
    console.error("Error registering agency:", error);
    return res.status(500).json({
      success: false,
      message: "Server Error during agency registration.",
      error: error.message,
    });
  } finally {
    connection.release();
  }
};
