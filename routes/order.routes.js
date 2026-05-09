const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/auth");
const {
  verifyCounterToken,
  requireCounterType,
} = require("../Middleware/counterAuth");
const controller = require("../controllers/order.controller");

/**
 * Order routes — dual-auth surface.
 *
 *   - Counter-token clients hit `/counter/*` (sale & cash counters).
 *   - Admin/User-token clients hit the unprefixed routes for back-office
 *     order management.
 *
 * Counter sub-router is mounted FIRST so the counter token is checked
 * before the user-token guard.
 */
const counterRouter = express.Router();
counterRouter.use(verifyCounterToken);

// Sale counter (type=2)
counterRouter.post(
  "/",
  requireCounterType(2),
  controller.create,
);
counterRouter.get(
  "/mine",
  requireCounterType(2),
  controller.list,
);

// Cash counter (type=1)
counterRouter.get(
  "/by-barcode/:code",
  requireCounterType(1),
  controller.getByBarcode,
);
counterRouter.post(
  "/scan",
  requireCounterType(1),
  controller.scanBarcode,
);
counterRouter.post(
  "/batch-receive",
  requireCounterType(1),
  controller.batchReceive,
);
counterRouter.post(
  "/:id/bill",
  requireCounterType(1),
  controller.bill,
);
counterRouter.post(
  "/:id/payment",
  requireCounterType(1),
  controller.addPayment,
);
counterRouter.post(
  "/:id/deliver",
  requireCounterType(1),
  controller.deliver,
);

router.use("/counter", counterRouter);

// Admin / back-office surface
router.use(verifyToken);
router.get("/", controller.list);
router.get("/by-barcode/:code", controller.getByBarcode);
router.post("/scan", controller.scanBarcode);
router.get("/:id", controller.getOne);
router.post("/", controller.create);
router.post("/batch-receive", controller.batchReceive);
router.post("/:id/bill", controller.bill);
router.post("/:id/payment", controller.addPayment);
router.post("/:id/deliver", controller.deliver);
router.post("/:id/cancel", controller.cancel);
router.delete("/:id", controller.remove);

module.exports = router;
