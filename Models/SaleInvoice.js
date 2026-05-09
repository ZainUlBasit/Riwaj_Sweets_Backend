const mongoose = require("mongoose");
const AutoIncrement = require("mongoose-sequence")(mongoose);
const { requiredBooleanWithDefaultFalse } = require("../utils/Types");

const Schema = mongoose.Schema;

const SaleInvoiceItemSchema = new Schema(
  {
    product_id: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0 },
    unit_price: { type: Number, required: true, min: 0, default: 0 },
    total_price: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false },
);

const SaleInvoicePaymentSchema = new Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, default: "cash" },
    paid_at: { type: Date, default: Date.now },
    received_by_counter_id: {
      type: Schema.Types.ObjectId,
      ref: "Counter",
      default: null,
    },
    note: { type: String, default: "" },
  },
  { _id: false },
);

/**
 * SaleInvoice — immutable bill snapshot generated when an Order is delivered.
 *
 * It intentionally duplicates order totals/items/customer/counter details so
 * printed bills remain stable even if product prices or counter metadata change
 * later. `order_id` is unique to prevent duplicate invoices for one delivery.
 */
const SaleInvoiceSchema = new Schema(
  {
    invoice_number: { type: Number, default: 0, index: true },
    order_id: {
      type: Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      unique: true,
      index: true,
    },
    order_number: { type: Number, required: true, index: true },
    barcode: { type: String, required: true, index: true },

    items: { type: [SaleInvoiceItemSchema], default: [] },
    subtotal: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
    paid_amount: { type: Number, default: 0, min: 0 },
    balance_amount: { type: Number, default: 0, min: 0 },
    payment_status: {
      type: Number,
      enum: [1, 2, 3], // 1: unpaid, 2: partial, 3: paid
      default: 1,
      index: true,
    },
    payments: { type: [SaleInvoicePaymentSchema], default: [] },

    created_by_counter_id: {
      type: Schema.Types.ObjectId,
      ref: "Counter",
      default: null,
    },
    billed_by_counter_id: {
      type: Schema.Types.ObjectId,
      ref: "Counter",
      default: null,
    },
    created_by_counter_snapshot: {
      counter_number: { type: Number, default: null },
      type: { type: Number, default: null },
      location: { type: String, default: "" },
    },
    billed_by_counter_snapshot: {
      counter_number: { type: Number, default: null },
      type: { type: Number, default: null },
      location: { type: String, default: "" },
    },

    customer_info: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
    },
    notes: { type: String, default: "" },
    invoice_date: { type: Date, default: Date.now, index: true },
    delivered_at: { type: Date, default: null },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  { timestamps: true },
);

SaleInvoiceSchema.plugin(AutoIncrement, {
  id: "sale_invoice_number_seq",
  inc_field: "invoice_number",
  start_seq: 1,
});

module.exports = mongoose.model("SaleInvoice", SaleInvoiceSchema);
