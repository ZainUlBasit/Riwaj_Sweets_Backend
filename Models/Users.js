const mongoose = require("mongoose");
const {
  requiredString,
  requiredNumberWithDefault,
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

const UsersSchema = new Schema(
  {
    name: requiredString,
    email: requiredString,
    password: requiredString,
    role: {
      type: Number,
      enum: [1, 2, 3, 4, 5], // 1 Admin, 2 Cashier, 3 Saleman, 4 Cake Designer, 5 Cake Order Manager
    },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Users", UsersSchema);
