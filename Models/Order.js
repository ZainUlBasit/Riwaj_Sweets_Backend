const mongoose = require("mongoose");
const AutoIncrement = require("mongoose-sequence")(mongoose);
const {
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

/**
 * Order item — snapshot of a product line at order time.
 *
 * `unit_price` is captured at order time so price changes don't retro-
 * actively rewrite invoices.
 */
const OrderItemSchema = new Schema(
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

/**
 * Payment entry — append-only ledger so partial payments are auditable.
 */
const PaymentEntrySchema = new Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, default: "cash" }, // cash | card | bank | other
    paid_at: { type: Date, default: Date.now },
    received_by_counter_id: {
      type: Schema.Types.ObjectId,
      ref: "Counter",
      default: null,
    },
    note: { type: String, default: "" },
  },
  { _id: true, timestamps: false },
);

/**
 * Order
 *
 * Lifecycle: pending (1) -> billed (2) -> delivered (3). Cancelled (4) is
 * a terminal state reachable only from `pending`. The barcode is generated
 * at create time so the sale-counter (mobile) flow can hand a printed
 * barcode to the cash counter to scan & bill.
 *
 * Stock side-effects:
 *   - On `deliver`, Product.available_quantity / Product.out_quantity are
 *     adjusted and the linked stock impact is captured. Items reference
 *     the canonical Product, so listing reads pull the live name.
 *
 * Payment status is derived from the sum of `payments[]` vs `total`.
 */
const OrderSchema = new Schema(
  {
    order_number: { type: Number, default: 0, index: true },
    barcode: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    barcode_lookup: {
      type: String,
      default: "",
      index: true,
    },
    items: { type: [OrderItemSchema], default: [] },

    subtotal: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },

    status: {
      type: Number,
      enum: [1, 2, 3, 4], // 1: pending, 2: billed, 3: delivered, 4: cancelled
      default: 1,
      index: true,
    },
    payment_status: {
      type: Number,
      enum: [1, 2, 3], // 1: unpaid, 2: partial, 3: paid
      default: 1,
      index: true,
    },
    payment_flag: {
      type: String,
      enum: ["unpaid", "partial", "paid"],
      default: "unpaid",
      index: true,
    },
    paid_amount: { type: Number, default: 0, min: 0 },
    payments: { type: [PaymentEntrySchema], default: [] },
    sale_invoice_id: {
      type: Schema.Types.ObjectId,
      ref: "SaleInvoice",
      default: null,
    },

    created_by_counter_id: {
      type: Schema.Types.ObjectId,
      ref: "Counter",
      default: null,
      index: true,
    },
    billed_by_counter_id: {
      type: Schema.Types.ObjectId,
      ref: "Counter",
      default: null,
    },

    customer_info: {
      name: { type: String, default: "" },
      phone: { type: String, default: "" },
    },

    notes: { type: String, default: "" },

    billed_at: { type: Date, default: null },
    delivered_at: { type: Date, default: null },
    cancelled_at: { type: Date, default: null },

    isDeleted: requiredBooleanWithDefaultFalse,
  },
  { timestamps: true },
);

OrderSchema.plugin(AutoIncrement, {
  id: "order_number_seq",
  inc_field: "order_number",
  start_seq: 1,
});

module.exports = mongoose.model("Order", OrderSchema);
