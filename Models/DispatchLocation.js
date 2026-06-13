const mongoose = require("mongoose");
const {
  requiredString,
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

/**
 * DispatchLocation
 *
 * Master list of destinations where raw material can be dispatched
 * (branch, kitchen, outlet, warehouse, etc.). RawMaterialDispatch keeps a
 * reference to this model so reports group by stable master data instead of
 * typo-prone free text.
 */
const DispatchLocationSchema = new Schema(
  {
    name: {
      ...requiredString,
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    /** Parent store — optional for legacy rows. */
    store_id: {
      type: Schema.Types.ObjectId,
      ref: "Store",
      default: null,
      index: true,
    },
    /**
     * Location role within a store:
     *   1 = raw material store (central RM storage)
     *   2 = production area (default for legacy rows)
     *   3 = shop / outlet
     *   4 = main store (finished goods warehouse)
     */
    location_type: {
      type: Number,
      enum: [1, 2, 3, 4],
      default: 2,
      index: true,
    },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  { timestamps: true },
);

DispatchLocationSchema.index(
  { name: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
    collation: { locale: "en", strength: 2 },
  },
);

module.exports = mongoose.model("DispatchLocation", DispatchLocationSchema);
