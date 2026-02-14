const mongoose = require("mongoose");
const {
  requiredString,
  requiredNumberWithDefault,
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

const RawMaterialStockSchema = new Schema(
  {
    raw_material_id: {
      type: Schema.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
    },
    desc: {
      type: String,
      default: "",
    },
    quantity: requiredNumberWithDefault,
    price: requiredNumberWithDefault,
    total_price: requiredNumberWithDefault,
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("RawMaterialStock", RawMaterialStockSchema);
