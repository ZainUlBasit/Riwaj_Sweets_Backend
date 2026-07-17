const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/auth");
const controller = require("../controllers/inventory-report.controller");

router.use(verifyToken);
router.get("/current-stock", controller.currentStock);
router.get("/material-ledger", controller.materialLedger);
router.get("/consumption", controller.consumptionReport);
router.get("/production", controller.productionReport);
router.get("/transfers", controller.transferReport);
router.get("/store-receipts", controller.storeReceiptReport);
router.get("/finished-goods-stock", controller.finishedGoodsStock);
router.get("/shop-stock", controller.shopStock);
router.get("/rm-dispatch", controller.rmDispatchReport);
router.get("/location-rm-stock", controller.locationRmStock);
router.get("/daily-ops", controller.dailyOpsReport);
router.get("/production-area", controller.productionAreaReport);
router.post("/rm-wastage", controller.recordWastage);

module.exports = router;
