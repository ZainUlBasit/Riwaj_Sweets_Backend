const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/auth");
const controller = require("../controllers/daily-report.controller");

router.use(verifyToken);
router.get("/", controller.summary);
router.get("/:date", controller.detail);
router.get("/:date/:section", controller.detail);

module.exports = router;
