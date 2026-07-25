const mongoose = require("mongoose");
const {
  requiredNumberWithDefault,
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

// Is product stock entry par kon kon sa raw material kitna use hua
const RawMaterialUsedSchema = new Schema(
  {
    raw_material_id: {
      type: mongoose.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
    },
    quantity_used: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
  },
  { _id: false }
);

const ProductStockSchema = new Schema(
  {
    product_id: {
      type: mongoose.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    desc: {
      type: String,
      default: "",
    },
    quantity: requiredNumberWithDefault,
    price: requiredNumberWithDefault,
    total_price: requiredNumberWithDefault,
    // Is stock entry mein kaun kaun se raw materials kitni quantity use hue
    raw_materials_used: [RawMaterialUsedSchema],
    /** Production area where this stock is held (null = global/unassigned). */
    location_id: {
      type: mongoose.Types.ObjectId,
      ref: "DispatchLocation",
      default: null,
      index: true,
    },
    /** 1 = production, 2 = shop, 3 = product store */
    inventory_type: {
      type: Number,
      enum: [1, 2, 3],
      default: 1,
    },
    /**
     * How finished goods entered Product Store:
     * 1 = self_production, 2 = supplier (direct purchase)
     */
    source: {
      type: Number,
      enum: [1, 2],
      default: 1,
      index: true,
    },
    supplier_id: {
      type: mongoose.Types.ObjectId,
      ref: "Supplier",
      default: null,
      index: true,
    },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("ProductStock", ProductStockSchema);
