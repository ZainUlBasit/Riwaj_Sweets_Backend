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
router.get("/rm-dispatch", controller.rmDispatchReport);

module.exports = router;
