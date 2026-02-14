const express = require("express");
const router = express.Router();
const authControllers = require("../controllers/authControllers");

const multer = require("multer");

// Configure Multer (no need for local storage)
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Regular user login
router.post("/login", authControllers().login);

// Employee login (mobile app)
router.post("/employee/login", authControllers().employeeLogin);

// User registration
router.post("/register", upload.array("image", 2), authControllers().register);

// Logout
router.post("/logout", authControllers().logout);

// Auto login (refresh token)
router.post("/auto-login", authControllers().autoLogin);

// Forget Password - Send OTP via email
router.post("/forgot-password", authControllers().sendOtp);

// OTP Verification
router.post("/verify-otp", authControllers().verifyOtp);

// Reset Password (after OTP verification)
router.post("/reset-password", authControllers().resetPassword);

// Manager management (admin only)
router.get("/managers", authControllers().managers);
router.delete("/manager/:id", authControllers().deleteManager);
router.patch("/manager", authControllers().updateManager);

module.exports = router;
