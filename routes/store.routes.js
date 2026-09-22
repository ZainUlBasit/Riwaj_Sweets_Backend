const express = require("express");
const router = express.Router();
const { verifyToken, VerifyAdmin } = require("../Middleware/auth");
const controller = require("../controllers/store.controller");

router.use(verifyToken);
router.get("/", controller.list);
router.get("/:id", controller.getOne);
router.post("/", VerifyAdmin, controller.create);
router.patch("/:id", VerifyAdmin, controller.update);
router.delete("/:id", VerifyAdmin, controller.remove);

module.exports = router;
