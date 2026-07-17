const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/auth");
const { verifyShopToken } = require("../Middleware/shopAuth");
const controller = require("../controllers/shop.controller");

router.post("/login", controller.login);

router.get("/me", verifyShopToken, controller.me);
router.get("/inventory", verifyShopToken, controller.inventory);
router.get("/sync/catalog", verifyShopToken, controller.syncCatalog);
router.get("/sales/today", verifyShopToken, controller.todaySales);
router.post("/scan-product-barcode", verifyShopToken, controller.scanProductBarcode);
router.post("/cash-sale", verifyShopToken, controller.cashBarcodeSale);
router.post("/pos/sale", verifyShopToken, controller.posSale);

router.use(verifyToken);
router.get("/", controller.list);
router.get("/:id", controller.getOne);
router.post("/", controller.create);
router.patch("/:id", controller.update);
router.delete("/:id", controller.remove);

module.exports = router;
