const mongoose = require("mongoose");
const { requiredBooleanWithDefaultFalse } = require("../utils/Types");

const Schema = mongoose.Schema;

/**
 * UstadJob — issue voucher: RM given to one ustad for production.
 *
 * Tracks "I gave Ustad Ahmed RM worth 2000" and later
 * "he returned these finished items" via CakeProduction.ustad_job_id.
 */
const JOB_STATUS = {
  OPEN: 1,
  CLOSED: 2,
};

const UstadJobLineSchema = new Schema(
  {
    raw_material_id: {
      type: Schema.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
    },
    raw_material_stock_id: {
      type: Schema.Types.ObjectId,
      ref: "RawMaterialStock",
      required: true,
    },
    quantity: { type: Number, required: true, min: 0.001 },
    /** Snapshot from purchase batch at issue time. */
    unit_price: { type: Number, required: true, min: 0, default: 0 },
    line_value: { type: Number, required: true, min: 0, default: 0 },
    dispatch_id: {
      type: Schema.Types.ObjectId,
      ref: "RawMaterialDispatch",
      default: null,
    },
    /** When this RM was given (extra top-ups can be later than job.issue_date). */
    issued_at: { type: Date, default: null, index: true },
    /** Extra RM given after the original job (weekly hisaab). */
    is_extra: { type: Boolean, default: false },
  },
  { _id: true },
);

const UstadJobSchema = new Schema(
  {
    job_code: {
      type: String,
      trim: true,
      uppercase: true,
      required: true,
      unique: true,
      index: true,
    },
    ustad_name: {
      type: String,
      trim: true,
      required: true,
      index: true,
    },
    /** Registered Ustad master reference. */
    ustad_id: {
      type: Schema.Types.ObjectId,
      ref: "Ustad",
      default: null,
      index: true,
    },
    from_location_id: {
      type: Schema.Types.ObjectId,
      ref: "DispatchLocation",
      required: true,
      index: true,
    },
    location_id: {
      type: Schema.Types.ObjectId,
      ref: "DispatchLocation",
      required: true,
      index: true,
    },
    issue_date: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: Number,
      enum: Object.values(JOB_STATUS),
      default: JOB_STATUS.OPEN,
      index: true,
    },
    notes: { type: String, default: "" },
    /** Products the ustad is expected to make (drives recipe → RM). */
    planned_products: [
      {
        product_id: {
          type: Schema.Types.ObjectId,
          ref: "Product",
          required: true,
        },
        quantity: { type: Number, required: true, min: 0.001 },
      },
    ],
    lines: { type: [UstadJobLineSchema], default: [] },
    /** Denormalized sum of line_value at create. */
    rm_value_issued: { type: Number, default: 0, min: 0 },
    created_by: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      default: null,
    },
    closed_at: { type: Date, default: null },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  { timestamps: true },
);

UstadJobSchema.index({ ustad_name: 1, status: 1, isDeleted: 1 });
UstadJobSchema.index({ location_id: 1, status: 1, isDeleted: 1 });

module.exports = mongoose.model("UstadJob", UstadJobSchema);
module.exports.JOB_STATUS = JOB_STATUS;
