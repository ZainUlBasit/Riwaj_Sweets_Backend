const mongoose = require("mongoose");
const {
  requiredNumberWithDefault,
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

// Is product stock entry par kon kon sa raw material kitna use hua
const RawMaterialUsedSchema = new Schema(
  {
    raw_material_id: {
      type: mongoose.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
    },
    quantity_used: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
  },
  { _id: false }
);

const ProductStockSchema = new Schema(
  {
    product_id: {
      type: mongoose.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    desc: {
      type: String,
      default: "",
    },
    quantity: requiredNumberWithDefault,
    price: requiredNumberWithDefault,
    total_price: requiredNumberWithDefault,
    // Is stock entry mein kaun kaun se raw materials kitni quantity use hue
    raw_materials_used: [RawMaterialUsedSchema],
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("ProductStock", ProductStockSchema);
