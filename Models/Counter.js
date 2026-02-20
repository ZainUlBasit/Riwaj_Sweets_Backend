const mongoose = require("mongoose");
const { requiredBooleanWithDefaultFalse } = require("../utils/Types");
const AutoIncrement = require("mongoose-sequence")(mongoose);

const Schema = mongoose.Schema;

const CounterSchema = new Schema(
  {
    counter_number: { type: Number, default: 1 },
    type: {
      type: Number,
      enum: [1, 2], // 1: Cash 2: Sale
      required: true,
    },
    location: String,
    description: String,
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  {
    timestamps: true,
  },
);

// 1 se start, har nayi counter par last + 1
CounterSchema.plugin(AutoIncrement, {
  id: "counter_number_seq",
  inc_field: "counter_number",
  start_seq: 1,
});

module.exports = mongoose.model("Counter", CounterSchema);
