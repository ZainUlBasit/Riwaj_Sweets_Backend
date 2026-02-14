const mongoose = require("mongoose");
const { requiredString, NumberWithDefault } = require("../utils/Types");

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
    paid: NumberWithDefault,
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Supplier", SupplierSchema);
