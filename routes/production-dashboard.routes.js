const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/auth");
const controller = require("../controllers/production-dashboard.controller");

router.use(verifyToken);
router.get("/summary", controller.getSummary);

module.exports = router;
