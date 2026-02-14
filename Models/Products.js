const mongoose = require("mongoose");
const {
  requiredString,
  NumberWithDefault,
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

// BOM entry: raw material + quantity required per unit of finished product
const BomEntrySchema = new Schema(
  {
    rawMaterialId: {
      type: Schema.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
    },
    quantity_required_per_unit: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
  },
  { _id: false },
);

const ProductSchema = new Schema(
  {
    name: requiredString,
    category_id: {
      type: Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    price: NumberWithDefault,
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("Product", ProductSchema);
