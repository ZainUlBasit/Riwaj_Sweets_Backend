const mongoose = require("mongoose");

const Schema = mongoose.Schema;

const RefreshTokenSchema = new Schema(
  {
    token: { type: String, required: true },
    user_id: { type: Schema.Types.ObjectId, required: true, ref: "Users" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("RefreshToken", RefreshTokenSchema);
