import express from "express";
import {
  getCashierDashboard,
  getCashierDriverCollections,
  verifyDriverCollections,
  getLastClosingBalance,
  getClosingSummary,
  startCashierDay,
  closeCashierDay,
  recordOfficeSale,
  recordOfficeExpense,
  getTodayOfficeSales,
  getTodayOfficeExpenses,
  getCashOutExpenseRequests,
  reviewCashOutExpenseRequest,
  recordCashierReceipt,
  createCashierReceipt,
  getRecentCashierReceipts,
  getTodaysCashFlow,
  getOtherPayments,
  getOtherPaymentsSummary,
  recordOtherPayment,
  findCustomerForCashierApp,
  getCashierPenaltyRequests,
  collectCashierPenaltyRequest,
  getCashierNameChangeRequests,
  collectCashierNameChangeRequest,
  getCashierTransferVoucherRequests,
  collectCashierTransferVoucherRequest,
  getCashierNewConnectionRequests,
  collectCashierNewConnectionRequest,
  getCashFlowEntriesByDate,
} from "../controllers/cashierController.js";
import {
  getCashierDailySalesReport,
  getCashierTotalCollectionReport,
  getCashierExpensesReport,
  getCashierConsolidatedCashReport,
  getCashierClosingCashReport,
  submitCashierClosingCashReport,
} from "../controllers/cashierReportsController.js";

const router = express.Router();

// Cashier Reports endpoints
router.get("/reports/daily-sales", getCashierDailySalesReport);
router.get("/reports/total-collection", getCashierTotalCollectionReport);
router.get("/reports/expenses", getCashierExpensesReport);
router.get("/reports/consolidated-cash", getCashierConsolidatedCashReport);
router.get("/reports/closing-cash", getCashierClosingCashReport);
router.post("/reports/closing-cash", submitCashierClosingCashReport);

router.get("/dashboard", getCashierDashboard);
router.get("/driver-collections", getCashierDriverCollections);
router.post("/driver-collections/:driverId/verify", verifyDriverCollections);
router.get("/opening/last-closing", getLastClosingBalance);
router.get("/closing/summary", getClosingSummary);
router.post("/opening", startCashierDay);
router.post("/closing", closeCashierDay);
router.post("/office-sale", recordOfficeSale);
router.post("/office-expense", recordOfficeExpense);
router.get("/expense-requests", getCashOutExpenseRequests);
router.put("/expense-requests/:expenseId", reviewCashOutExpenseRequest);
router.post("/other-payments", recordOtherPayment);
router.get("/other-payments", getOtherPayments);
router.get("/other-payments/summary", getOtherPaymentsSummary);
router.get("/office-sales/today", getTodayOfficeSales);
router.get("/office-expenses/today", getTodayOfficeExpenses);
router.post("/receipt", recordCashierReceipt);
// Cash In -> Other Receipts (advance / due collection / other)
router.post("/receipts", createCashierReceipt);
router.get("/receipts/recent", getRecentCashierReceipts);
router.get("/cash-flow/today", getTodaysCashFlow);
router.get("/cash-flow/entries", getCashFlowEntriesByDate);
router.get("/customers/find", findCustomerForCashierApp);
router.get("/cashier-requests/pr-penalties", getCashierPenaltyRequests);
router.patch("/cashier-requests/pr-penalties/:requestId/collect", collectCashierPenaltyRequest);
router.get("/cashier-requests/name-changes", getCashierNameChangeRequests);
router.patch("/cashier-requests/name-changes/:requestId/collect", collectCashierNameChangeRequest);
router.get("/cashier-requests/transfer-vouchers", getCashierTransferVoucherRequests);
router.patch("/cashier-requests/transfer-vouchers/:requestId/collect", collectCashierTransferVoucherRequest);
router.get("/cashier-requests/new-connections", getCashierNewConnectionRequests);
router.patch("/cashier-requests/new-connections/:requestId/collect", collectCashierNewConnectionRequest);

export default router;
