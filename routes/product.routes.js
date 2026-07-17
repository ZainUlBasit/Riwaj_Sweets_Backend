const express = require("express");
const router = express.Router();
const multer = require("multer");
const { verifyToken } = require("../Middleware/auth");
const controller = require("../controllers/product.controller");

// Multer in-memory storage so the file buffer can be streamed straight to
// Cloudinary without ever touching local disk. Same approach as
// cake-design.routes — keeps the deploy environment (Vercel/serverless)
// happy as it has no writeable FS.
const upload = multer({ storage: multer.memoryStorage() });

router.use(verifyToken);
router.get("/", controller.list);
router.get("/location-stock", controller.locationStock);
router.post("/import", controller.importBulk);
router.get("/:id", controller.getOne);
router.post("/", upload.single("image"), controller.create);
router.patch("/:id", upload.single("image"), controller.update);
router.delete("/:id", controller.remove);

module.exports = router;
