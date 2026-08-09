const mongoose = require("mongoose");
const { requiredBooleanWithDefaultFalse } = require("../utils/Types");

const Schema = mongoose.Schema;

/**
 * ProductStoreReceipt — move finished goods from production area to main store.
 */
const ProductStoreReceiptSchema = new Schema(
  {
    from_location_id: {
      type: Schema.Types.ObjectId,
      ref: "DispatchLocation",
      required: true,
      index: true,
    },
    to_location_id: {
      type: Schema.Types.ObjectId,
      ref: "DispatchLocation",
      required: true,
      index: true,
    },
    product_id: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    quantity: { type: Number, required: true, min: 0.001 },
    receipt_date: { type: Date, required: true, index: true },
    notes: { type: String, default: "" },
    /** Printable batch barcode for Product Store label (PSR-…). */
    receipt_code: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
      index: true,
    },
    /** Ustad / karegar who prepared this batch. */
    ustad_name: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    /** Registered Ustad master reference. */
    ustad_id: {
      type: Schema.Types.ObjectId,
      ref: "Ustad",
      default: null,
      index: true,
    },
    /** Optional link when auto-created from cake production. */
    cake_production_id: {
      type: Schema.Types.ObjectId,
      ref: "CakeProduction",
      default: null,
      index: true,
    },
    created_by: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      default: null,
    },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  { timestamps: true },
);

ProductStoreReceiptSchema.index({ receipt_code: 1, isDeleted: 1 });

module.exports = mongoose.model("ProductStoreReceipt", ProductStoreReceiptSchema);
