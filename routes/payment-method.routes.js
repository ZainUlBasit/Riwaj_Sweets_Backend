const express = require("express");
const router = express.Router();
const { verifyToken, VerifyAdmin } = require("../Middleware/auth");
const controller = require("../controllers/payment-method.controller");

/**
 * Public — Supplier Ledger mobile / POS can load methods without auth.
 * GET /api/payment-method
 */
router.get("/", controller.listActive);

/** Admin portal — manage catalog */
router.get("/all", verifyToken, VerifyAdmin, controller.listAll);
router.get("/:id", verifyToken, VerifyAdmin, controller.getOne);
router.post("/", verifyToken, VerifyAdmin, controller.create);
router.patch("/:id", verifyToken, VerifyAdmin, controller.update);
router.delete("/:id", verifyToken, VerifyAdmin, controller.remove);

module.exports = router;
