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
    /** 1 pending, 2 in design, 3 ready, 4 completed, 5 cancelled */
    status: { type: Number, default: 1, min: 1, max: 5 },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CakeOrder", CakeOrderSchema);
