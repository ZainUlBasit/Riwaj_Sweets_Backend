const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/auth");
const controller = require("../controllers/dashboard.controller");

router.use(verifyToken);
router.get("/get-data", controller.getData);

module.exports = router;
