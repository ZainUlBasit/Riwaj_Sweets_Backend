const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/auth");
const { verifyCounterToken } = require("../Middleware/counterAuth");
const controller = require("../controllers/counter.controller");

// Public — counter staff login (no admin token required)
router.post("/login", controller.login);

// Counter-token gated — currently authenticated counter's profile +
// resolved product list (assigned subset, or all if none assigned).
router.get("/me", verifyCounterToken, controller.me);
router.get("/products", verifyCounterToken, controller.myProducts);

// Admin-token gated CRUD
router.use(verifyToken);
router.get("/", controller.list);
router.get("/:id", controller.getOne);
router.post("/", controller.create);
router.patch("/:id", controller.update);
router.delete("/:id", controller.remove);

module.exports = router;
