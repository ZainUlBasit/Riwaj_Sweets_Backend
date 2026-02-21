const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/auth");
const controller = require("../controllers/cake-order.controller");

router.use(verifyToken);
router.get("/", controller.list);
router.get("/:id", controller.getOne);
router.post("/", controller.create);
router.patch("/:id", controller.update);
router.delete("/:id", controller.remove);

module.exports = router;
