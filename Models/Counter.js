const mongoose = require("mongoose");
const { requiredBooleanWithDefaultFalse } = require("../utils/Types");
const AutoIncrement = require("mongoose-sequence")(mongoose);

const Schema = mongoose.Schema;

/**
 * Counter — physical POS terminal (Sale or Cash).
 *
 *   counter_number      Auto-increment human-friendly id.
 *   type                1: Cash (web, scans barcodes, prints bills)
 *                       2: Sale (Expo mobile, creates orders + barcode)
 *   email/password_hash Counter login credentials. Counter token is signed
 *                       with kind="counter" so admin/user routes are not
 *                       reachable via this token.
 *   isActive            Login disabled when false (independent of soft-delete).
 *   assigned_products   Sale counters can only create orders for these
 *                       products. Empty / unset means "all products".
 *   location            Physical / logical location label.
 */
const CounterSchema = new Schema(
  {
    counter_number: { type: Number, default: 1 },
    type: {
      type: Number,
      enum: [1, 2], // 1: Cash 2: Sale
      required: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },
    password_hash: {
      type: String,
      default: null,
      select: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    assigned_products: [
      {
        type: Schema.Types.ObjectId,
        ref: "Product",
      },
    ],
    location: String,
    description: String,
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  {
    timestamps: true,
  },
);

// Unique email amongst active counters only (lets soft-deleted counters
// keep their stale email without blocking re-use).
CounterSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: {
      email: { $type: "string" },
      isDeleted: false,
    },
  },
);

// 1 se start, har nayi counter par last + 1
CounterSchema.plugin(AutoIncrement, {
  id: "counter_number_seq",
  inc_field: "counter_number",
  start_seq: 1,
});

// IMPORTANT: pin the collection name to `sale_counters`.
//
// Why: `mongoose-sequence` maintains its own internal collection named
// `counters` (with a unique compound index on `{ id, reference_value }`) to
// track auto-increment sequences. Mongoose by default pluralizes our model
// name "Counter" to the same `counters` collection, so domain Counter
// documents (which carry neither `id` nor `reference_value`) all hashed to
// `{ id: null, reference_value: null }` and tripped the unique index after
// the first insert. Pinning a distinct collection name removes the
// collision while keeping `ref: "Counter"` intact across the codebase
// (refs are resolved by model name, not by collection name).
module.exports = mongoose.model("Counter", CounterSchema, "sale_counters");
