const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/auth");
const controller = require("../controllers/product-store-receipt.controller");

router.use(verifyToken);
router.get("/", controller.list);
router.get("/:id", controller.getOne);
router.post("/", controller.create);
router.delete("/:id", controller.remove);

module.exports = router;
