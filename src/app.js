import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import path from "path";
import { verifyToken } from "./middleware/authMiddleware.js";
import routes from "./routes/authRoutes.js";
import agencyRoutes from "./routes/agencyRoutes.js";
import uploadRoutes from "./routes/uploadRoutes.js";
import salesRoutes from "./routes/salesRoutes.js";
import driverRoutes from "./routes/driverRoutes.js";
import stockRoutes from "./routes/stockRoutes.js";
import settlementRoutes from "./routes/settlementRoutes.js";
import customerIssueRoutes from "./routes/customerIssueRoutes.js";
import getUserSettingRoutes from "./routes/userRoutes.js";
import getExpenseRoutes from "./routes/expenseRoutes.js";
import godownRoutes from "./routes/godownRoutes.js";
import cashierRoutes from "./routes/cashierRoutes.js";
import purchaseRoutes from "./routes/purchaseRoutes.js";
import ownerRoutes from "./routes/ownerRoutes.js";
import customerComplaintRoutes from "./routes/customerComplaintRoutes.js";
import prPenaltyRoutes from "./routes/prPenaltyRoutes.js";
import dashboardOverviewRoutes from "./routes/dashboardOverviewRoutes.js";
import customerDashboardRoutes from "./routes/customerDashboardRoutes.js";
import customerConnectionRoutes from "./routes/customerConnectionRoutes.js";
import customerTransferRoutes from "./routes/customerTransferRoutes.js";
import nameChangeRoutes from "./routes/nameChangeRoutes.js";
import iocOtpRoutes from "./routes/iocOtpRoutes.js";
import emptyCylinderLoadRoutes from "./routes/emptyCylinderLoadRoutes.js";
import razorpayRoutes from "./routes/razorpayRoutes.js";
import manualPaymentRoutes from "./routes/manualPaymentRoutes.js";
import reportsRoutes from "./routes/reportsRoutes.js";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app.use(express.json());

// Backwards-compat + resilience for client base-URL quirks.
// 1. Collapse accidental duplicate slashes in the path (e.g. a client whose
//    base URL ended in `/` producing `//auth/identify` or `/api//cashier/...`).
//    Only the path is touched — the query string is left intact.
// 2. All APIs live under `/api`. If a client calls a route without the `/api`
//    prefix (e.g. `/auth/identify`), rewrite it to the canonical `/api/...`
//    path. Leaves `/api/*`, `/uploads/*` and `/` untouched.
app.use((req, res, next) => {
  const queryIndex = req.url.indexOf("?");
  const query = queryIndex === -1 ? "" : req.url.slice(queryIndex);
  let path = (
    queryIndex === -1 ? req.url : req.url.slice(0, queryIndex)
  ).replace(/\/{2,}/g, "/");

  if (
    path !== "/" &&
    !path.startsWith("/api/") &&
    !path.startsWith("/uploads/")
  ) {
    path = "/api" + (path.startsWith("/") ? path : `/${path}`);
  }

  req.url = path + query;
  next();
});

// Serve uploaded files as static assets
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// Auth routes (unprotected)
app.use("/api/auth", routes);
app.use("/api/agencies", agencyRoutes);

// Apply auth middleware to all other API routes
app.use("/api", verifyToken);

// Protected routes
app.use("/api/sales", salesRoutes);
app.use("/api/drivers", driverRoutes);
app.use("/api/stocks", stockRoutes);
app.use("/api/settlements", settlementRoutes);
app.use("/api/issues", customerIssueRoutes);
app.use("/api/users", getUserSettingRoutes);
app.use("/api/expenses", getExpenseRoutes);
app.use("/api/godown", godownRoutes);
app.use("/api/cashier", cashierRoutes);
app.use("/api/purchase", purchaseRoutes);
app.use("/api/owner", ownerRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/customer-complaints", customerComplaintRoutes);
app.use("/api/pr-penalties", prPenaltyRoutes);
app.use("/api/dashboard", dashboardOverviewRoutes);
app.use("/api/customer-dashboard", customerDashboardRoutes);
app.use("/api/customer-connections", customerConnectionRoutes);
app.use("/api/customer-transfers", customerTransferRoutes);
app.use("/api/name-changes", nameChangeRoutes);
app.use("/api/ioc-otps", iocOtpRoutes);
app.use("/api/empty-cylinder-loads", emptyCylinderLoadRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api", razorpayRoutes);
app.use("/api", manualPaymentRoutes);

export default app;
