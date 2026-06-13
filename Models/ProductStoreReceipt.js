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

module.exports = mongoose.model("ProductStoreReceipt", ProductStoreReceiptSchema);
