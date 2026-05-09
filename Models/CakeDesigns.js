const mongoose = require("mongoose");
const {
  requiredString,
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

const CakeDesignSchema = new Schema(
  {
    title: requiredString,
    image: requiredString,
    description: requiredString,
    // Per-pound base price for this design. Default 0 + min 0 keeps every
    // pre-existing document semantically valid without a migration.
    price_per_pound: {
      type: Number,
      default: 0,
      min: 0,
    },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("CakeDesign", CakeDesignSchema);
