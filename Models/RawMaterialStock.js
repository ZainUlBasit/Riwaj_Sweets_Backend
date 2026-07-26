const mongoose = require("mongoose");
const {
  requiredNumberWithDefault,
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

const RawMaterialStockSchema = new Schema(
  {
    raw_material_id: {
      type: mongoose.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
    },
    // Supplier for this purchase batch (set when adding stock).
    supplier_id: {
      type: mongoose.Types.ObjectId,
      ref: "Supplier",
      default: null,
      index: true,
    },
    // Batch label / description — required so each purchase batch is identifiable.
    desc: {
      type: String,
      required: true,
      trim: true,
    },
    /** Original purchase qty that came into this batch (kitna aya). */
    quantity: requiredNumberWithDefault,
    /** Qty dispatched from this batch to Production / Shop (kitna gaya). */
    out_quantity: requiredNumberWithDefault,
    /** Qty still left in this batch (kitna rehta). */
    remaining_quantity: requiredNumberWithDefault,
    price: requiredNumberWithDefault,
    total_price: requiredNumberWithDefault,
    // purpose tags an inventory movement.
    //   1 = purchase   (default; inflow from a supplier — existing behavior)
    //   2 = production (outflow allocated for cake production — legacy)
    // Default = 1 keeps every existing document semantically correct
    // without a migration.
    purpose: {
      type: Number,
      enum: [1, 2],
      default: 1,
      required: true,
      index: true,
    },
    /** RM Store location credited on purchase (type 1). Used for reverse on edit/delete. */
    rm_store_location_id: {
      type: mongoose.Types.ObjectId,
      ref: "DispatchLocation",
      default: null,
      index: true,
    },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("RawMaterialStock", RawMaterialStockSchema);
