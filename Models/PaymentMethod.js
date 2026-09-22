const mongoose = require("mongoose");
const {
  requiredString,
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

/**
 * Supplier payment methods used by mobile Supplier Ledger / payment screens.
 * Admin can add/edit/soft-delete; apps load active rows dynamically.
 */
const PaymentMethodSchema = new Schema(
  {
    name: requiredString,
    /** Optional short code e.g. cash, bank_transfer */
    code: {
      type: String,
      trim: true,
      default: "",
    },
    sort_order: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  { timestamps: true }
);

PaymentMethodSchema.index(
  { name: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
  }
);

module.exports = mongoose.model("PaymentMethod", PaymentMethodSchema);
