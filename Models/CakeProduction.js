const mongoose = require("mongoose");
const {
  requiredNumberWithDefault,
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

/**
 * CakeProduction — daily cake production log.
 *
 *   production_date        Day on which the production happened.
 *   location_id            Canonical production location master reference.
 *   location               Location snapshot for stable historical reporting.
 *   cakes_produced         Number of cakes produced that day.
 *   product_id             Finished product whose stock will be increased
 *                          by `cakes_produced`. Required so we can keep
 *                          Product inventory and a corresponding
 *                          ProductStock entry in sync automatically.
 *   product_stock_id       Auto-created reference to the ProductStock
 *                          entry that was generated for this production
 *                          run. Used on edit/delete to reverse / adjust
 *                          inventory side-effects.
 *   raw_material_stock_id  Optional reference to a RawMaterialStock batch
 *                          (typically purpose = 2 / production) for users
 *                          who want to attribute a specific batch.
 *   notes                  Free-form notes / batch description.
 */
const CakeProductionSchema = new Schema(
  {
    production_date: {
      type: Date,
      required: true,
      index: true,
    },
    location_id: {
      type: Schema.Types.ObjectId,
      ref: "DispatchLocation",
      default: null,
      index: true,
    },
    location: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    cakes_produced: requiredNumberWithDefault,
    product_id: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    product_stock_id: {
      type: Schema.Types.ObjectId,
      ref: "ProductStock",
      default: null,
      index: true,
    },
    raw_material_stock_id: {
      type: Schema.Types.ObjectId,
      ref: "RawMaterialStock",
      required: false,
      default: null,
      index: true,
    },
    /** Auto store receipt when main store is configured for the parent store. */
    store_receipt_id: {
      type: Schema.Types.ObjectId,
      ref: "ProductStoreReceipt",
      default: null,
      index: true,
    },
    /** Auto-generated consumption rows (BOM) — used to reverse on edit/delete. */
    raw_materials_consumed: [
      {
        raw_material_id: {
          type: Schema.Types.ObjectId,
          ref: "RawMaterial",
          required: true,
        },
        quantity: { type: Number, required: true, min: 0 },
        stock_entry_id: {
          type: Schema.Types.ObjectId,
          ref: "RawMaterialStock",
          default: null,
        },
      },
    ],
    notes: {
      type: String,
      default: "",
    },
    /** Ustad / karegar who prepared this batch. */
    ustad_name: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    /** Registered Ustad master reference. */
    ustad_id: {
      type: Schema.Types.ObjectId,
      ref: "Ustad",
      default: null,
      index: true,
    },
    /** Optional link to RM issue voucher (Ustad Job). */
    ustad_job_id: {
      type: Schema.Types.ObjectId,
      ref: "UstadJob",
      default: null,
      index: true,
    },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  { timestamps: true },
);

module.exports = mongoose.model("CakeProduction", CakeProductionSchema);
