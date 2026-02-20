const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/auth");
const controller = require("../controllers/cake-design.controller");
const multer = require("multer");
// Configure multer for image uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

router.use(verifyToken);
router.get("/", controller.list);
router.get("/:id", controller.getOne);
router.post("/", upload.single("image"), controller.create);
router.patch("/:id", upload.single("image"), controller.update);
router.delete("/:id", controller.remove);

module.exports = router;
