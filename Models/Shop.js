const mongoose = require("mongoose");
const AutoIncrement = require("mongoose-sequence")(mongoose);
const { requiredBooleanWithDefaultFalse } = require("../utils/Types");

const Schema = mongoose.Schema;

/**
 * Shop — outlet account with its own login and cash counter.
 * Linked to a DispatchLocation with location_type = 3 (Shop).
 */
const ShopSchema = new Schema(
  {
    shop_number: { type: Number, default: 1 },
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true, default: "" },
    location_id: {
      type: Schema.Types.ObjectId,
      ref: "DispatchLocation",
      required: true,
      index: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
    },
    password_hash: {
      type: String,
      required: true,
      select: false,
    },
    phone: { type: String, default: "", trim: true },
    address: { type: String, default: "", trim: true },
    isActive: { type: Boolean, default: true },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  { timestamps: true },
);

ShopSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
  },
);

ShopSchema.index(
  { location_id: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
  },
);

ShopSchema.plugin(AutoIncrement, {
  id: "shop_number_seq",
  inc_field: "shop_number",
  start_seq: 1,
});

module.exports = mongoose.model("Shop", ShopSchema, "shops");
