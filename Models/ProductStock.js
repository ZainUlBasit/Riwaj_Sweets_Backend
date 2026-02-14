const mongoose = require("mongoose");
const {
  requiredNumberWithDefault,
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

const ProductStockSchema = new Schema(
  {
    product_id: {
      type: Schema.Types.ObjectId,
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
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("ProductStock", ProductStockSchema);
