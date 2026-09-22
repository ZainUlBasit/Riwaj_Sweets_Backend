const mongoose = require("mongoose");
const { requiredBooleanWithDefaultFalse } = require("../utils/Types");

const Schema = mongoose.Schema;

/**
 * Purchase return TO a supplier — reduces payable (debit side).
 * Does not change SupplierPayment; stock reverse is out of scope here.
 */
const SupplierReturnSchema = new Schema(
  {
    supplier_id: {
      type: mongoose.Types.ObjectId,
      ref: "Supplier",
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    return_date: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    reference: {
      type: String,
      default: "",
      trim: true,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  { timestamps: true }
);

module.exports = mongoose.model("SupplierReturn", SupplierReturnSchema);
