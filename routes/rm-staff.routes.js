const express = require("express");
const router = express.Router();
const { verifyToken, VerifyAdmin } = require("../Middleware/auth");
const controller = require("../controllers/rm-staff.controller");

router.use(verifyToken, VerifyAdmin);
router.get("/", controller.list);
router.get("/:id", controller.getOne);
router.post("/", controller.create);
router.put("/:id/permissions", controller.updatePermissions);
router.patch("/:id/permissions", controller.updatePermissions);
router.patch("/:id", controller.update);
router.delete("/:id", controller.remove);

module.exports = router;
