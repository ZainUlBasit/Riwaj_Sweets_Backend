const mongoose = require("mongoose");
const {
  requiredString,
  NumberWithDefault,
  requiredNumberWithDefault,
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
      type: mongoose.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    unit: {
      type: Number,
      enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      required: true,
    }, // 1:kg, 2:bag, 3:piece, 4:liter, 5:ounce, 6:pound, 7:gallon, 8:quart, 9:pint, 10:cup
    price: NumberWithDefault,
    in_quantity: requiredNumberWithDefault,
    out_quantity: requiredNumberWithDefault,
    available_quantity: requiredNumberWithDefault,
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("Product", ProductSchema);
