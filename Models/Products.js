const mongoose = require("mongoose");
const AutoIncrement = require("mongoose-sequence")(mongoose);
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
    // Auto-increment human-friendly id assigned by mongoose-sequence below.
    // Must NOT be `required: true` because the plugin's pre('save') hook
    // runs after schema validation in newer Mongoose, so a required check
    // would fail before the plugin can populate it.
    id: { type: Number, default: 0 },
    name: requiredString,
    // Cloudinary `secure_url` of the product image. Optional — products can
    // exist without artwork (e.g. legacy items or quick raw entries).
    image: { type: String, default: null },
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
    counter_id: {
      type: mongoose.Types.ObjectId,
      ref: "Counter",
      required: false,
    },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  {
    timestamps: true,
  },
);

ProductSchema.plugin(AutoIncrement, {
  id: "product_id_seq",
  inc_field: "id",
  start_seq: 1,
});

module.exports = mongoose.model("Product", ProductSchema);
