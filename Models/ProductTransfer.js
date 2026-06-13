const mongoose = require("mongoose");
const { requiredBooleanWithDefaultFalse } = require("../utils/Types");

const Schema = mongoose.Schema;

/**
 * ProductTransfer — move finished goods from production inventory to shop.
 */
const ProductTransferSchema = new Schema(
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
    transfer_date: { type: Date, required: true, index: true },
    notes: { type: String, default: "" },
    created_by: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      default: null,
    },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  { timestamps: true },
);

module.exports = mongoose.model("ProductTransfer", ProductTransferSchema);
