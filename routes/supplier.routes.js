const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/auth");
const supplierController = require("../controllers/supplier.controller");
const supplierPaymentController = require("../controllers/supplier-payment.controller");

/**
 * Public — Supplier Ledger mobile (list / create / pay / return / ledger / soft-delete).
 * Admin payment-list / payment-delete stay auth-protected.
 */
router.get("/", supplierController.list);
router.post("/", supplierController.create);
router.post("/:id/payments", supplierPaymentController.createPayment);
router.post("/:id/returns", supplierPaymentController.createReturn);
router.get("/:id/ledger", supplierPaymentController.ledger);
router.delete("/:id", supplierController.remove);

router.use(verifyToken);

router.get("/:id/payments", supplierPaymentController.listPayments);
router.delete(
  "/payments/:paymentId",
  supplierPaymentController.removePayment,
);

router.get("/:id", supplierController.getOne);
router.patch("/:id", supplierController.update);

module.exports = router;
