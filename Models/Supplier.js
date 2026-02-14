const mongoose = require("mongoose");
const {
  requiredString,
  requiredNumberWithDefault,
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

const SupplierSchema = new Schema(
  {
    name: requiredString,
    contact: requiredString,
    address: {
      type: String,
      default: "",
    },
    desc: {
      type: String,
      default: "",
    },
    total_amount: requiredNumberWithDefault,
    paid: requiredNumberWithDefault,
    payable: requiredNumberWithDefault,
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Supplier", SupplierSchema);
