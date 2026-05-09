const mongoose = require("mongoose");
const {
  requiredString,
  requiredNumberWithDefault,
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

/**
 * RawMaterialDispatch — record of raw material sent to a location.
 *
 *   location_id            Stable DispatchLocation master reference.
 *   location               Snapshot / legacy destination name.
 *   raw_material_id        Which raw material was dispatched (required).
 *   raw_material_stock_id  Optional — exact source batch.
 *   quantity               How much was dispatched (in raw material's unit).
 *   dispatch_date          When the dispatch happened.
 *   notes                  Optional free-form notes.
 *
 * Inventory side-effects (decrement available_quantity, etc.) are NOT
 * applied automatically by this model — dispatch is treated as an
 * informational event so existing inventory math is not silently changed.
 * Apply movements explicitly through the production-purpose stock flow if
 * dispatched material should also be deducted from inventory.
 */
const RawMaterialDispatchSchema = new Schema(
  {
    location_id: {
      type: mongoose.Types.ObjectId,
      ref: "DispatchLocation",
      default: null,
      index: true,
    },
    location: requiredString,
    raw_material_id: {
      type: mongoose.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
      index: true,
    },
    raw_material_stock_id: {
      type: mongoose.Types.ObjectId,
      ref: "RawMaterialStock",
      default: null,
    },
    quantity: requiredNumberWithDefault,
    dispatch_date: {
      type: Date,
      required: true,
      index: true,
    },
    notes: {
      type: String,
      default: "",
    },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  { timestamps: true },
);

module.exports = mongoose.model(
  "RawMaterialDispatch",
  RawMaterialDispatchSchema,
);
