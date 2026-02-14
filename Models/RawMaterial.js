const mongoose = require("mongoose");
const {
  requiredString,
  requiredNumberWithDefault,
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

const RawMaterialSchema = new Schema(
  {
    name: requiredString,
    supplier_id: {
      type: mongoose.Types.ObjectId,
      ref: "Supplier",
      required: true,
    },
    unit: {
      type: Number,
      enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      required: true,
    }, // 1:kg, 2:bag, 3:piece, 4:liter, 5:ounce, 6:pound, 7:gallon, 8:quart, 9:pint, 10:cup
    in_quantity: requiredNumberWithDefault,
    out_quantity: requiredNumberWithDefault,
    available_quantity: requiredNumberWithDefault,
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("RawMaterial", RawMaterialSchema);
