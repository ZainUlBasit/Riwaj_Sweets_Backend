const mongoose = require("mongoose");

const Schema = mongoose.Schema;

const OtpSchema = new Schema(
  {
    email: { type: String, required: true, trim: true, lowercase: true },
    otp: { type: String, required: true },
    type: { type: String, required: true, default: "password_reset" },
    expiresAt: { type: Date, required: true },
    isUsed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/**
 * Find a valid (non-used, not expired) OTP for the given email, otp and type.
 */
OtpSchema.statics.findValidOtp = function (email, otp, type) {
  const normalizedEmail = (email || "").toLowerCase().trim();
  return this.findOne({
    email: normalizedEmail,
    otp: String(otp),
    type: type || "password_reset",
    isUsed: false,
    expiresAt: { $gt: new Date() },
  });
};

/**
 * Mark OTP as used (invalidate) for the given email, otp and type.
 */
OtpSchema.statics.invalidateOtp = function (email, otp, type) {
  const normalizedEmail = (email || "").toLowerCase().trim();
  return this.updateMany(
    {
      email: normalizedEmail,
      otp: String(otp),
      type: type || "password_reset",
    },
    { $set: { isUsed: true } }
  );
};

module.exports = mongoose.model("Otp", OtpSchema);
