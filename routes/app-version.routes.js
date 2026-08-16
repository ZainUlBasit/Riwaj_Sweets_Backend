const express = require("express");
const router = express.Router();
const controller = require("../controllers/app-version.controller");

/** Public — no auth (Electron checks before / outside login). */
router.get("/", controller.getAppVersion);

module.exports = router;
