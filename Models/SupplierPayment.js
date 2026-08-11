const mongoose = require("mongoose");
const { requiredBooleanWithDefaultFalse } = require("../utils/Types");

const Schema = mongoose.Schema;

/**
 * Cash/bank payment made TO a supplier against purchase payable.
 * Purchases still live on RawMaterialStock / ProductStock — this only
 * records money leaving the business.
 */
const SupplierPaymentSchema = new Schema(
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
    payment_date: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    /** 1 = Cash, 2 = Bank / transfer */
    payment_type: {
      type: Number,
      enum: [1, 2],
      default: 1,
      required: true,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  { timestamps: true },
);

module.exports = mongoose.model("SupplierPayment", SupplierPaymentSchema);
