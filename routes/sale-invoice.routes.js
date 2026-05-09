const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/auth");
const {
  verifyCounterToken,
  requireCounterType,
} = require("../Middleware/counterAuth");
const controller = require("../controllers/sale-invoice.controller");

const counterRouter = express.Router();
counterRouter.use(verifyCounterToken);
counterRouter.get("/by-order/:orderId", requireCounterType(1), controller.getByOrder);
counterRouter.get("/by-barcode/:code", requireCounterType(1), controller.getByBarcode);
router.use("/counter", counterRouter);

router.use(verifyToken);
router.get("/", controller.list);
router.get("/by-order/:orderId", controller.getByOrder);
router.get("/by-barcode/:code", controller.getByBarcode);
router.get("/:id", controller.getOne);
router.delete("/:id", controller.remove);

module.exports = router;
