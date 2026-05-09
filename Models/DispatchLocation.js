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
