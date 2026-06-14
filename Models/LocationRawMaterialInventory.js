const mongoose = require("mongoose");
const { requiredBooleanWithDefaultFalse } = require("../utils/Types");

const Schema = mongoose.Schema;

/**
 * LocationRawMaterialInventory — per-location raw material quantities.
 * RM Store (type 1) and Production Areas (type 2) hold balances here.
 */
const LocationRawMaterialInventorySchema = new Schema(
  {
    location_id: {
      type: Schema.Types.ObjectId,
      ref: "DispatchLocation",
      required: true,
      index: true,
    },
    raw_material_id: {
      type: Schema.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
      index: true,
    },
    quantity: { type: Number, required: true, default: 0, min: 0 },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  { timestamps: true },
);

LocationRawMaterialInventorySchema.index(
  { location_id: 1, raw_material_id: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
  },
);

module.exports = mongoose.model(
  "LocationRawMaterialInventory",
  LocationRawMaterialInventorySchema,
);
