const express = require("express");
const router = express.Router();
const { verifyToken } = require("../Middleware/auth");
const controller = require("../controllers/ustad-job.controller");

router.use(verifyToken);
router.get("/", controller.list);
router.get("/open", controller.listOpen);
router.get("/report", controller.report);
router.get("/:id", controller.getOne);
router.post("/", controller.create);
router.patch("/:id/close", controller.close);
router.patch("/:id/reopen", controller.reopen);
router.delete("/:id", controller.remove);

module.exports = router;
