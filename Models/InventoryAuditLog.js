const mongoose = require("mongoose");

const Schema = mongoose.Schema;

/**
 * InventoryAuditLog — entity change history for inventory-related records.
 */
const InventoryAuditLogSchema = new Schema(
  {
    entity_type: { type: String, required: true, index: true },
    entity_id: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    action: {
      type: String,
      enum: ["create", "update", "delete"],
      required: true,
    },
    previous_value: { type: Schema.Types.Mixed, default: null },
    new_value: { type: Schema.Types.Mixed, default: null },
    user_id: {
      type: Schema.Types.ObjectId,
      ref: "Users",
      default: null,
    },
    notes: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("InventoryAuditLog", InventoryAuditLogSchema);
