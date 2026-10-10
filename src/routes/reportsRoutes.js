import express from "express";
import {
  getSalesReport,
  getCustomerMovementReport,
  getComplaintsReport,
  getOtpVerificationReport,
} from "../controllers/reportsController.js";

const router = express.Router();

router.get("/sales", getSalesReport);
router.get("/customer-movement", getCustomerMovementReport);
router.get("/complaints", getComplaintsReport);
router.get("/otp-verification", getOtpVerificationReport);

export default router;
