const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/auth");
const controller = require("../controllers/raw-material-stock.controller");

router.use(verifyToken);

// Production-purpose endpoints (additive). Declared before the generic
// `/:id` routes so Express does not interpret "production" as an :id.
router.post("/production", controller.createProduction);
router.delete("/production/:id", controller.removeProduction);
router.post("/bulk", controller.createBulk);

router.get("/", controller.list);
router.get("/:id", controller.getOne);
router.post("/", controller.create);
router.patch("/:id", controller.update);
router.delete("/:id", controller.remove);

module.exports = router;
