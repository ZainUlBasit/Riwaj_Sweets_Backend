const mongoose = require("mongoose");
const { requiredBooleanWithDefaultFalse } = require("../utils/Types");

const Schema = mongoose.Schema;

/**
 * InventoryLedger — append-only movement log (reconstructable inventory).
 *
 * transaction_type:
 *   1  RAW_MATERIAL_STOCK_IN      purchase / stock-in
 *   2  RAW_MATERIAL_CONSUMPTION   production BOM usage
 *   3  PRODUCTION_ENTRY           finished goods produced
 *   4  SHOP_TRANSFER              production → shop
 *   5  RAW_MATERIAL_ALLOCATION    manual production allocation (legacy)
 *   6  PRODUCT_STOCK_IN           manual finished-goods stock-in
 *   7  PRODUCT_SALE               order delivery
 *   8  ADJUSTMENT                 manual correction
 *   9  STORE_RECEIPT              production area → main store
 *  10  RAW_MATERIAL_DISPATCH      RM store → production location
 *
 * direction: 1 = in, 2 = out
 */
const InventoryLedgerSchema = new Schema(
  {
    transaction_type: {
      type: Number,
      enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      required: true,
      index: true,
    },
    direction: { type: Number, enum: [1, 2], required: true },
    raw_material_id: {
      type: Schema.Types.ObjectId,
      ref: "RawMaterial",
      default: null,
      index: true,
    },
    product_id: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      default: null,
      index: true,
    },
    quantity: { type: Number, required: true, min: 0 },
    store_id: {
      type: Schema.Types.ObjectId,
      ref: "Store",
      default: null,
      index: true,
    },
    location_id: {
      type: Schema.Types.ObjectId,
      ref: "DispatchLocation",
      default: null,
      index: true,
    },
    reference_type: { type: String, default: null },
    reference_id: {
      type: Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    user_id: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      default: null,
    },
    notes: { type: String, default: "" },
    previous_balance: { type: Number, default: null },
    new_balance: { type: Number, default: null },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  { timestamps: true },
);

InventoryLedgerSchema.index({ createdAt: -1 });
InventoryLedgerSchema.index({ raw_material_id: 1, createdAt: -1 });
InventoryLedgerSchema.index({ product_id: 1, createdAt: -1 });

module.exports = mongoose.model("InventoryLedger", InventoryLedgerSchema);
