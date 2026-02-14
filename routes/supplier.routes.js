const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/auth");
const supplierController = require("../controllers/supplier.controller");

router.use(verifyToken);

router.get("/", supplierController.list);
router.get("/:id", supplierController.getOne);
router.post("/", supplierController.create);
router.patch("/:id", supplierController.update);
router.delete("/:id", supplierController.remove);

module.exports = router;
