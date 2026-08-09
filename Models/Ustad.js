const mongoose = require("mongoose");
const {
  requiredString,
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

/**
 * Ustad — registered master craftsman / karegar.
 * Selected on Ustad Jobs and Production instead of free-text names.
 */
const UstadSchema = new Schema(
  {
    name: requiredString,
    phone: {
      type: String,
      trim: true,
      default: "",
    },
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    /** Optional godown scope for RM managers. */
    store_id: {
      type: Schema.Types.ObjectId,
      ref: "Store",
      default: null,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  { timestamps: true },
);

UstadSchema.index({ name: 1, isDeleted: 1 });

module.exports = mongoose.model("Ustad", UstadSchema);
