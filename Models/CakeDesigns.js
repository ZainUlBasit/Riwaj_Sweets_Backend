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
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("CakeDesign", CakeDesignSchema);
