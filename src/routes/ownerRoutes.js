import express from "express";
import {
	getOwnerDashboard,
	getOwnerDashboardInsights,
	getOwnerExpensesDashboard,
	getOwnerJobAssignmentUsers,
	getOwnerSalesDashboard,
	getOwnerDriversDashboard,
	getOwnerStocksDashboard,
	getOwnerStockAreas,
	getOwnerStockCategories,
	getOwnerStockItems,
	getOwnerStockItemDetails,
	postOwnerStockCategoryWithItem,
	postOwnerStockItem,
	postOwnerStockEntry,
	getOwnerStockPriceList,
	postOwnerStockPriceUpdates,
	putOwnerStockProduct,
	deleteOwnerStockProductEndpoint,
	approveOwnerOfficeExpense,
	createOwnerJobAssignmentUser,
	updateOwnerJobAssignmentUserStatus,
	updateOwnerJobAssignmentUser,
	deleteOwnerJobAssignmentUser,
} from "../controllers/ownerController.js";
import {
	getOwnerSalesDetailedReport,
	getOwnerDriverManagement,
	updateDriverVehicleDocuments,
	getOwnerDriverCashSettlements,
	getOwnerCreditSales,
	recordCreditSalePayment,
	getCreditSalePaymentHistory,
	getOwnerStockInventoryReport,
	getOwnerDriverPerformanceReport,
	getOwnerMonthlyPnlStatement,
	getOwnerComplaintsLogReport,
	getOwnerCashFlowReport,
} from "../controllers/ownerReportsController.js";

const router = express.Router();

router.get("/dashboard", getOwnerDashboard);
router.get("/dashboard/insights", getOwnerDashboardInsights);
router.get("/expenses/dashboard", getOwnerExpensesDashboard);
router.put("/expenses/:expenseId/approve", approveOwnerOfficeExpense);
router.get("/job-assignment/users", getOwnerJobAssignmentUsers);
router.post("/job-assignment/users", createOwnerJobAssignmentUser);
router.patch("/job-assignment/users/:id/status", updateOwnerJobAssignmentUserStatus);
router.patch("/job-assignment/users/:id", updateOwnerJobAssignmentUser);
router.delete("/job-assignment/users/:id", deleteOwnerJobAssignmentUser);
router.get("/sales/dashboard", getOwnerSalesDashboard);
router.get("/drivers/dashboard", getOwnerDriversDashboard);
router.get("/stocks/dashboard", getOwnerStocksDashboard);
router.get("/stocks/areas", getOwnerStockAreas);
router.get("/stocks/categories", getOwnerStockCategories);
router.get("/stocks/items", getOwnerStockItems);
router.get("/stocks/item-details", getOwnerStockItemDetails);
router.post("/stocks/categories-with-item", postOwnerStockCategoryWithItem);
router.post("/stocks/items", postOwnerStockItem);
router.post("/stocks/entries", postOwnerStockEntry);
router.get("/stocks/prices", getOwnerStockPriceList);
router.post("/stocks/prices/update", postOwnerStockPriceUpdates);
router.put("/stocks/products/:productId", putOwnerStockProduct);
router.delete("/stocks/products/:productId", deleteOwnerStockProductEndpoint);

// New Owner Dashboard Additional Requirements:
// 1. Sales Tab Detailed Reports
router.get("/sales/report", getOwnerSalesDetailedReport);

// 2. Driver Management Screen Redesign & Vehicle History
router.get("/drivers/management", getOwnerDriverManagement);
router.put("/drivers/:driverId/vehicle-documents", updateDriverVehicleDocuments);

// 3. Cash Settlement & Separate Credit Sales
router.get("/settlements/driver-settlements", getOwnerDriverCashSettlements);
router.get("/settlements/credit-sales", getOwnerCreditSales);
router.post("/settlements/credit-sales/:saleId/pay", recordCreditSalePayment);
router.get("/settlements/credit-sales/:saleId/history", getCreditSalePaymentHistory);

// 4. Dedicated Owner Reports Module
router.get("/reports/daily-sales", getOwnerSalesDetailedReport);
router.get("/reports/stock-inventory", getOwnerStockInventoryReport);
router.get("/reports/driver-performance", getOwnerDriverPerformanceReport);
router.get("/reports/pnl-statement", getOwnerMonthlyPnlStatement);
router.get("/reports/complaints-log", getOwnerComplaintsLogReport);
router.get("/reports/cash-flow", getOwnerCashFlowReport);

export default router;
