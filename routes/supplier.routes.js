const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/auth");
const supplierController = require("../controllers/supplier.controller");
const supplierPaymentController = require("../controllers/supplier-payment.controller");

router.use(verifyToken);

router.get("/", supplierController.list);
router.post("/", supplierController.create);

// Payment + ledger (before bare :id so paths resolve correctly)
router.get("/:id/ledger", supplierPaymentController.ledger);
router.get("/:id/payments", supplierPaymentController.listPayments);
router.post("/:id/payments", supplierPaymentController.createPayment);
router.delete(
  "/payments/:paymentId",
  supplierPaymentController.removePayment,
);

router.get("/:id", supplierController.getOne);
router.patch("/:id", supplierController.update);
router.delete("/:id", supplierController.remove);

module.exports = router;
