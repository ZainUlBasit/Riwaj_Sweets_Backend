const mongoose = require("mongoose");

const Schema = mongoose.Schema;

const CakeOrderSchema = new Schema(
  {
    cake_design_id: {
      type: Schema.Types.ObjectId,
      ref: "CakeDesign",
      required: true,
    },
    pound: { type: Number, required: true },
    customization_rupees: { type: Number, default: 0 },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CakeOrder", CakeOrderSchema);
