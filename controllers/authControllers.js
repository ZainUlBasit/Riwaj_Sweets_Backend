const Joi = require("joi");
const bcrypt = require("bcrypt");
const User = require("../Models/Users");
const Otp = require("../Models/Otp");
const userDto = require("../Services/userDto");
const JwtService = require("../Services/JwtServices");
const jwt = require("jsonwebtoken");
const RefreshModel = require("../Models/RefreshToken");
const { createError, successMessage } = require("../utils/ResponseMessage");
const RefreshToken = require("../Models/RefreshToken");
const nodemailer = require("nodemailer");
const privateKey = process.env.ACCESS_SECRET_KEY;

require("dotenv").config();

// Create nodemailer transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: process.env.SMTP_PORT || 587,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER, // Your email
    pass: process.env.SMTP_PASS, // Your email password or app password
  },
  // Add connection timeout and other options for reliability
  connectionTimeout: 60000,
  greetingTimeout: 30000,
  socketTimeout: 60000,
});

function authControllers() {
  return {
    login: async (req, res) => {
      // validate the req
      const loginSchema = Joi.object({
        email: Joi.string().email().required(),
        password: Joi.string().required(),
      });

      const { error } = loginSchema.validate(req.body);
      if (error) return createError(res, 422, error.message);

      // check useremail (only non-deleted users can login)
      const { email, password } = req.body;
      const user = await User.findOne({ email, isDeleted: false }).populate(
        "store_id",
        "name",
      );
      if (!user) return createError(res, 422, "No such email registered!");

      if (Number(user.role) === 6 && !user.store_id) {
        return createError(
          res,
          403,
          "RM Manager account has no store assigned. Contact admin.",
        );
      }

      // check user password using bcrypt
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch)
        return createError(res, 403, "email or password doesn't match!");
      const jwtBody = {
        _id: user._id,
        role: user.role, // 1: Admin … 6: RM Manager
      };
      if (user.store_id) {
        jwtBody.store_id = String(user.store_id._id ?? user.store_id);
      }
      const { accessToken, refreshToken } = JwtService.generateToken(jwtBody);

      var token = await jwt.sign({ ...jwtBody }, privateKey);

      res.cookie("userToken", token, {
        maxAge: 1000 * 60 * 60, // 1 hour
        httpOnly: false,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      });

      const result = await JwtService.storeRefreshToken(refreshToken, user._id);
      if (!result)
        return createError(
          res,
          500,
          "Internal server error.Cannot store refresh token"
        );

      // store access token and refresh token in cookies
      const cookieOptions = {
        maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
        httpOnly: false,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax",
      };

      res.cookie("refreshtoken", refreshToken, cookieOptions);

      res.cookie("accesstoken", accessToken, {
        ...cookieOptions,
        maxAge: 1000 * 60 * 60, // 1 hour
      });

      delete user.password;

      // Return user data (remove undefined populatedUser reference)
      return successMessage(
        res,
        {
          user: userDto(user),
          token: token,
          accesstoken: accessToken,
          refreshtoken: refreshToken,
        },
        "Successfully Logged In!"
      );
    },
    register: async (req, res) => {
      const { name, email, password, confirmPassword, role } = req.body;
      // validate req using joi (Users: role 1=Admin, 2=Cashier, 3=Saleman)
      const registerSchema = Joi.object({
        name: Joi.string().required(),
        email: Joi.string().email().required(),
        password: Joi.string()
          .pattern(new RegExp("^[a-zA-Z0-9]{5,15}$"))
          .required()
          .min(8)
          .max(15)
          .messages({
            "string.pattern.base":
              "Password must include alphabets and numbers",
            "string.min": "Password must be minimum 8 character required",
            "string.max": "Password must be upto 15 characters ",
          }),
        confirmPassword: Joi.ref("password"),
        role: Joi.number().valid(1, 2, 3, 4, 5).required(), // 1 Admin … 5 Cake Order Manager
      });
      const { error } = registerSchema.validate(req.body);
      if (error) return createError(res, 422, error.message);

      // check if email has not register yet
      const existingUser = await User.exists({ email });
      if (existingUser) return createError(res, 409, "Email already registered");
      if (password !== confirmPassword)
        return createError(res, 422, "Password not matching");

      try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const payload = {
          name,
          email,
          role,
          password: hashedPassword,
          isDeleted: false,
        };
        const newUser = new User(payload);
        const isSaved = await newUser.save();
        if (!isSaved)
          return createError(
            res,
            500,
            "Internal server error.Could not register user"
          );
        delete newUser.password;
        return successMessage(res, newUser, `${name} successfully registered!`);
      } catch (err) {
        return createError(res, 500, err.message || err);
      }
    },
    sendOtp: async (req, res) => {
      const { email } = req.body;
      if (!email) return createError(res, 422, "Email is required!");

      try {
        const user = await User.findOne({ email, isDeleted: false });
        if (!user)
          return createError(res, 404, "No user found with this email!");

        // Generate OTP (4 digits)
        const otp = Math.floor(1000 + Math.random() * 9000);

        // Create OTP record in database
        const otpRecord = new Otp({
          email: email.toLowerCase().trim(),
          otp: otp.toString(),
          type: "password_reset",
          expiresAt: new Date(Date.now() + 3600000), // OTP valid for 1 hour
          isUsed: false,
        });

        await otpRecord.save();

        // Email options
        const mailOptions = {
          from: process.env.SMTP_USER,
          to: email,
          subject: "Password Reset OTP - ITSD App",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #333;">Password Reset Request</h2>
              <p>Hello ${user.name},</p>
              <p>You have requested to reset your password. Please use the following OTP to proceed:</p>
              <div style="background-color: #f8f9fa; padding: 20px; text-align: center; margin: 20px 0;">
                <h1 style="color: #007bff; font-size: 32px; margin: 0; letter-spacing: 5px;">${otp}</h1>
              </div>
              <p><strong>Important:</strong></p>
              <ul>
                <li>This OTP is valid for 1 hour</li>
                <li>Do not share this OTP with anyone</li>
                <li>If you didn't request this, please ignore this email</li>
              </ul>
              <p>If you have any questions, please contact our support team.</p>
              <p>Best regards,<br>ITSD App Team</p>
            </div>
          `,
        };

        // Send email
        await transporter.sendMail(mailOptions);

        return successMessage(
          res,
          null,
          "OTP sent to your email successfully!"
        );
      } catch (err) {
        console.error("Email sending error:", err);
        return createError(res, 500, "Failed to send OTP. Please try again.");
      }
    },
    sendOtpPhp: async (req, res) => {
      const { email } = req.body;
      if (!email) return createError(res, 422, "Email is required!");

      try {
        const user = await User.findOne({ email, isDeleted: false });
        if (!user)
          return createError(res, 404, "No user found with this email!");

        // Generate OTP (6 digits)
        const otp = Math.floor(100000 + Math.random() * 900000);

        // Create OTP record in database
        const otpRecord = new Otp({
          email: email.toLowerCase().trim(),
          otp: otp.toString(),
          type: "password_reset",
          expiresAt: new Date(Date.now() + 3600000), // OTP valid for 1 hour
          isUsed: false,
        });

        await otpRecord.save();

        // Email options for PHP integration
        const mailOptions = {
          from: process.env.SMTP_USER,
          to: email,
          subject: "Password Reset OTP - ITSD App (PHP Integration)",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #333;">Password Reset Request (PHP Integration)</h2>
              <p>Hello ${user.name},</p>
              <p>You have requested to reset your password through our PHP integration. Please use the following OTP to proceed:</p>
              <div style="background-color: #f8f9fa; padding: 20px; text-align: center; margin: 20px 0;">
                <h1 style="color: #28a745; font-size: 32px; margin: 0; letter-spacing: 5px;">${otp}</h1>
              </div>
              <p><strong>Important:</strong></p>
              <ul>
                <li>This OTP is valid for 1 hour</li>
                <li>Do not share this OTP with anyone</li>
                <li>This request was made through PHP integration</li>
              </ul>
              <p>If you have any questions, please contact our support team.</p>
              <p>Best regards,<br>ITSD App Team (PHP Integration)</p>
            </div>
          `,
        };

        // Send email
        await transporter.sendMail(mailOptions);

        return successMessage(
          res,
          null,
          "OTP sent successfully via PHP integration!"
        );
      } catch (err) {
        console.error("Email sending error:", err);
        return createError(
          res,
          500,
          "Failed to send OTP via PHP integration. Please try again."
        );
      }
    },
    verifyOtp: async (req, res) => {
      const { email, otp } = req.body;
      if (!email || !otp)
        return createError(res, 422, "Email and OTP are required!");

      try {
        // Find valid OTP using the OTP model
        const otpRecord = await Otp.findValidOtp(
          email,
          otp.toString(),
          "password_reset"
        );

        if (!otpRecord) return createError(res, 400, "Invalid or expired OTP!");

        // Mark OTP as used after successful verification
        await Otp.invalidateOtp(email, otp.toString(), "password_reset");

        return successMessage(res, null, "OTP verified successfully!");
      } catch (err) {
        return createError(res, 500, err.message);
      }
    },
    resetPassword: async (req, res) => {
      const { email, password, confirmPassword } = req.body;
      if (!email || !password || !confirmPassword) {
        return createError(res, 422, "All fields are required!");
      }

      if (password !== confirmPassword) {
        return createError(res, 422, "Passwords do not match!");
      }

      try {
        const user = await User.findOne({ email, isDeleted: false });
        if (!user) return createError(res, 404, "User not found!");

        // Hash new password
        const hashedPassword = await bcrypt.hash(password, 10);
        user.password = hashedPassword;
        await user.save();

        return successMessage(res, null, "Password reset successfully!");
      } catch (err) {
        return createError(res, 500, err.message);
      }
    },
    managers: async (req, res) => {
      try {
        // Users: role 2 = Cashier; return non-admin staff (role 2 or 3) excluding deleted
        const managers = await User.find({ role: { $in: [2, 3] }, isDeleted: false });
        return successMessage(res, managers, null);
      } catch (err) {
        return createError(res, 400, err.message);
      }
    },
    deleteManager: async (req, res) => {
      const id = req.params.id;
      if (!id) return createError(res, 422, "Invalid Manager Id!");
      try {
        // Soft delete: set isDeleted = true (Users model)
        const manager = await User.findOneAndUpdate(
          { _id: id, isDeleted: false },
          { isDeleted: true },
          { new: true }
        );
        if (!manager) return createError(res, 404, "Manager not Found!");
        return successMessage(
          res,
          manager,
          `${manager.name} successfully deleted!`
        );
      } catch (err) {
        return createError(res, 400, err.message);
      }
    },
    updateManager: async (req, res) => {
      const { managerId, payload } = req.body;
      if (!managerId) return createError(res, 422, "Invalid Manager Id!");
      if (!payload) return createError(res, 422, "Invalid Payload!");

      if (payload.password) {
        payload.password = await bcrypt.hash(payload.password, 10);
      } else {
        delete payload.password; // avoid overwriting with undefined
      }
      // Only allow updating name, email, role, password (Users model has no imageUrl)
      const allowed = ["name", "email", "role", "password"];
      const updatePayload = {};
      allowed.forEach((k) => {
        if (payload[k] !== undefined) updatePayload[k] = payload[k];
      });

      try {
        const manager = await User.findOneAndUpdate(
          { _id: managerId, isDeleted: false },
          updatePayload,
          { new: true, runValidators: true }
        );
        if (!manager) return createError(res, 404, "Manager not Found!");
        delete manager.password;
        return successMessage(
          res,
          manager,
          `${manager.name} successfully updated!`
        );
      } catch (err) {
        return createError(res, 400, err.message);
      }
    },
    logout: async (req, res) => {
      try {
        const refreshtoken = req.headers["refreshtoken"]; // Custom header
        // Use correct Mongoose deleteMany method (case-sensitive)
        const token = await RefreshModel.deleteMany({
          token: refreshtoken,
        });
        if (!token) {
          return res.status(422).json({ message: "Token not found" });
        }
      } catch (err) {
        return createError(res, 500, err.message || err);
      }
      return successMessage(res, null, "Logout successfully");
    },
    autoLogin: async (req, res) => {
      const accesstoken = req.headers["accesstoken"]; // Custom header
      const refreshtoken = req.headers["refreshtoken"]; // Custom header
      const token_ = req.headers["token"]; // Custom header

      if (!refreshtoken) {
        return createError(
          res,
          401,
          "Refresh token not found. Please login again." + token_
        );
      }

      let userData;
      try {
        userData = await JwtService.verifyRefreshToken(refreshtoken);
      } catch (error) {
        return createError(res, 401, error.message);
      }

      console.log("userData: ", userData);

      try {
        const token = await JwtService.findRefreshToken(
          userData._id,
          refreshtoken
        );
        console.log(token);
        if (!token) {
          return createError(res, 401, "Invalid Token!");
        }
      } catch (error) {
        return createError(res, 401, error.message);
      }

      const userExist = await User.findOne({
        _id: userData._id,
        isDeleted: false,
      }).populate("store_id", "name");
      if (!userExist) {
        return createError(res, 404, "Invalid User!");
      }

      const jwtBody = {
        _id: userData._id,
        role: userExist.role,
      };
      if (userExist.store_id) {
        jwtBody.store_id = String(userExist.store_id._id ?? userExist.store_id);
      }
      const { accessToken, refreshToken } = JwtService.generateToken(jwtBody);
      try {
        const result = await JwtService.updateRefreshToken(
          userData._id,
          refreshToken
        );
      } catch (error) {
        return createError(res, 500, error.message);
      }

      const userdata = userDto(userExist);
      delete userExist.password;
      var token = await jwt.sign({ ...jwtBody }, privateKey);

      return successMessage(
        res,
        {
          user: userdata,
          token: token,
          accesstoken: accessToken,
          refreshtoken: refreshToken,
        },
        null
      );
    },

    employeeLogin: async (req, res) => {
      // The Employee model is not enabled in this environment.
      // The original handler `require("../Models/Employee")` would crash on
      // resolution at runtime. Quarantining behind a 501 keeps the route safe
      // until the Employee module is re-introduced.
      return createError(
        res,
        501,
        "Employee module not enabled in this environment."
      );
    },
  };
}

module.exports = authControllers;
