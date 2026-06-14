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
 *   from_location_id       RM Store (type 1) — source of the transfer.
 *   location_id            Production area (type 2) — destination.
 *   location               Snapshot / legacy destination name.
 *   raw_material_id        Which raw material was dispatched (required).
 *   raw_material_stock_id  Optional — exact source batch.
 *   quantity               How much was dispatched (in raw material's unit).
 *   dispatch_date          When the dispatch happened.
 *   notes                  Optional free-form notes.
 *
 * On create/update/delete the controller applies inventory side-effects
 * (deduct RM available, purpose=2 stock row, ledger type 10) and stores
 * `generated_stock_id` for reversal. Legacy rows without that field are
 * still visible in reports but delete does not restore stock.
 */
const RawMaterialDispatchSchema = new Schema(
  {
    from_location_id: {
      type: mongoose.Types.ObjectId,
      ref: "DispatchLocation",
      default: null,
      index: true,
    },
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
    /** Auto-created purpose=2 stock row when dispatch hits inventory. */
    generated_stock_id: {
      type: mongoose.Types.ObjectId,
      ref: "RawMaterialStock",
      default: null,
      index: true,
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
