const mongoose = require("mongoose");
const { requiredBooleanWithDefaultFalse } = require("../utils/Types");

const Schema = mongoose.Schema;

/** 1 = in transit (pending shop receive), 2 = received at shop, 3 = cancelled */
const TRANSFER_STATUS = {
  PENDING: 1,
  RECEIVED: 2,
  CANCELLED: 3,
};

/**
 * ProductTransfer — Product Store → Shop.
 * Create: stock leaves Product Store (pending).
 * Shop scans `transfer_code` barcode → stock credits shop (received).
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
    /** Shared shipment barcode for the batch (e.g. PT-A1B2C3D4). */
    transfer_code: {
      type: String,
      required: true,
      index: true,
      trim: true,
      uppercase: true,
    },
    status: {
      type: Number,
      enum: Object.values(TRANSFER_STATUS),
      default: TRANSFER_STATUS.PENDING,
      index: true,
    },
    received_at: { type: Date, default: null },
    received_by_shop_id: {
      type: Schema.Types.ObjectId,
      ref: "Shop",
      default: null,
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

ProductTransferSchema.index({ transfer_code: 1, status: 1, to_location_id: 1 });

module.exports = mongoose.model("ProductTransfer", ProductTransferSchema);
module.exports.TRANSFER_STATUS = TRANSFER_STATUS;
