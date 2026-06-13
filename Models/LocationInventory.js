const mongoose = require("mongoose");
const { requiredBooleanWithDefaultFalse } = require("../utils/Types");

const Schema = mongoose.Schema;

/**
 * LocationInventory — per-location product quantities.
 *
 * inventory_type:
 *   1 = production area inventory
 *   2 = shop inventory
 */
const LocationInventorySchema = new Schema(
  {
    location_id: {
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
    inventory_type: {
      type: Number,
      enum: [1, 2],
      required: true,
      default: 1,
    },
    quantity: { type: Number, required: true, default: 0, min: 0 },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  { timestamps: true },
);

LocationInventorySchema.index(
  { location_id: 1, product_id: 1, inventory_type: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
  },
);

module.exports = mongoose.model("LocationInventory", LocationInventorySchema);
