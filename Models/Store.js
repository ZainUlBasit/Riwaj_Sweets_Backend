const mongoose = require("mongoose");
const {
  requiredString,
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

/**
 * Store — top-level site (e.g. "Store A").
 * Each store owns one raw-material storage area and multiple production areas
 * via linked DispatchLocation records.
 */
const StoreSchema = new Schema(
  {
    name: { ...requiredString, trim: true },
    description: { type: String, default: "", trim: true },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  { timestamps: true },
);

StoreSchema.index(
  { name: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
    collation: { locale: "en", strength: 2 },
  },
);

module.exports = mongoose.model("Store", StoreSchema);
