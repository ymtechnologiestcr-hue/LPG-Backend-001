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

export default router;
