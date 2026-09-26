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
      enum: [1, 2, 3, 4, 5, 6], // 1 Admin … 5 Cake Order Manager, 6 RM Manager
    },
    /** Assigned store for RM Manager (role 6). */
    store_id: {
      type: mongoose.Types.ObjectId,
      ref: "Store",
      default: null,
      index: true,
    },
    /**
     * Module permissions for RM Manager.
     * Shape: [{ key, view, edit, delete }] (legacy string[] still accepted).
     */
    module_permissions: {
      type: [Schema.Types.Mixed],
      default: undefined,
    },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Users", UsersSchema);
