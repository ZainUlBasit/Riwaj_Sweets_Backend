const RawMaterialDispatch = require("../Models/RawMaterialDispatch");
const RawMaterial = require("../Models/RawMaterial");
const RawMaterialStock = require("../Models/RawMaterialStock");
const DispatchLocation = require("../Models/DispatchLocation");
const {
  getOrCreateLocation,
} = require("./dispatch-location.controller");
const { createError, successMessage } = require("../utils/ResponseMessage");
const {
  getUserId,
  writeAudit,
  applyRawMaterialDispatchImpact,
  reverseRawMaterialDispatchImpact,
  withTransaction,
} = require("../Services/inventoryService");

const populateRefs = (q) =>
  q
    .populate("raw_material_id")
    .populate("raw_material_stock_id")
    .populate("generated_stock_id")
    .populate("location_id");

/**
 * GET /api/raw-material-dispatch
 */
const list = async (req, res) => {
  try {
    const { start_date, end_date, location, location_id, raw_material_id } =
      req.query || {};

    const range = {};
    if (start_date) range.$gte = new Date(start_date);
    if (end_date) range.$lte = new Date(end_date);

    const baseFilter = {};
    if (Object.keys(range).length > 0) baseFilter.dispatch_date = range;
    if (location_id) {
      baseFilter.location_id = location_id;
    } else if (location) {
      const loc = await DispatchLocation.findOne({
        name: new RegExp(`^${escapeRegex(location)}$`, "i"),
        isDeleted: false,
      });
      if (loc) baseFilter.location_id = loc._id;
      else baseFilter.location = new RegExp(`^${escapeRegex(location)}$`, "i");
    }
    if (raw_material_id) baseFilter.raw_material_id = raw_material_id;

    const items = await populateRefs(
      RawMaterialDispatch.find({ ...baseFilter, isDeleted: false }).sort({
        dispatch_date: -1,
        createdAt: -1,
      }),
    );
    const deletedItems = await populateRefs(
      RawMaterialDispatch.find({ ...baseFilter, isDeleted: true }).sort({
        dispatch_date: -1,
        createdAt: -1,
      }),
    );

    return successMessage(
      res,
      { items, deletedItems },
      "Raw material dispatches fetched successfully.",
    );
  } catch (err) {
    console.error("RawMaterialDispatch list error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to fetch raw material dispatches.",
    );
  }
};

const getOne = async (req, res) => {
  try {
    const item = await populateRefs(
      RawMaterialDispatch.findById(req.params.id).where({ isDeleted: false }),
    );
    if (!item) return createError(res, 404, "Dispatch not found.");
    return successMessage(res, item, "Dispatch fetched successfully.");
  } catch (err) {
    console.error("RawMaterialDispatch getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch dispatch.");
  }
};

/**
 * POST /api/raw-material-dispatch
 */
const create = async (req, res) => {
  try {
    const {
      location,
      location_id,
      raw_material_id,
      raw_material_stock_id,
      quantity,
      dispatch_date,
      notes,
    } = req.body || {};

    if (!location_id && (!location || !String(location).trim())) {
      return createError(res, 400, "location is required.");
    }
    if (!raw_material_id) {
      return createError(res, 400, "raw_material_id is required.");
    }
    if (!dispatch_date) {
      return createError(res, 400, "dispatch_date is required.");
    }
    const qty = Number(quantity ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) {
      return createError(res, 400, "quantity must be greater than 0.");
    }

    const rawMaterial = await RawMaterial.findById(raw_material_id).where({
      isDeleted: false,
    });
    if (!rawMaterial) {
      return createError(res, 404, "Raw material not found.");
    }

    if (raw_material_stock_id) {
      const stock = await RawMaterialStock.findById(raw_material_stock_id).where(
        { isDeleted: false },
      );
      if (!stock) {
        return createError(res, 404, "Raw material stock batch not found.");
      }
    }

    const dispatchLocation = location_id
      ? await DispatchLocation.findById(location_id).where({ isDeleted: false })
      : await getOrCreateLocation(location);
    if (!dispatchLocation) {
      return createError(res, 404, "Dispatch location not found.");
    }

    const userId = getUserId(req);
    const dispatchNotes =
      notes?.trim() ||
      `Dispatch to ${dispatchLocation.name}${raw_material_stock_id ? " (batch ref)" : ""}`;

    const item = await withTransaction(async (session) => {
      const opts = { session };
      const [created] = await RawMaterialDispatch.create(
        [
          {
            location_id: dispatchLocation._id,
            location: dispatchLocation.name,
            raw_material_id,
            raw_material_stock_id: raw_material_stock_id || null,
            quantity: qty,
            dispatch_date: new Date(dispatch_date),
            notes: notes ?? "",
            isDeleted: false,
          },
        ],
        opts,
      );

      const { generatedStockId } = await applyRawMaterialDispatchImpact({
        rawMaterialId: raw_material_id,
        quantity: qty,
        locationId: dispatchLocation._id,
        storeId: dispatchLocation.store_id ?? null,
        referenceId: created._id,
        userId,
        notes: dispatchNotes,
        session,
      });

      created.generated_stock_id = generatedStockId;
      await created.save(opts);

      await writeAudit({
        entityType: "RawMaterialDispatch",
        entityId: created._id,
        action: "create",
        newValue: created.toObject?.() ?? created,
        userId,
        session,
      });

      return created;
    });

    const populated = await populateRefs(RawMaterialDispatch.findById(item._id));

    return successMessage(
      res,
      populated || item,
      "Dispatch recorded and inventory updated.",
    );
  } catch (err) {
    console.error("RawMaterialDispatch create error:", err);
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to create dispatch.",
    );
  }
};

const update = async (req, res) => {
  try {
    const existing = await RawMaterialDispatch.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!existing) return createError(res, 404, "Dispatch not found.");

    const {
      location,
      location_id,
      raw_material_id,
      raw_material_stock_id,
      quantity,
      dispatch_date,
      notes,
    } = req.body || {};

    const updatePayload = { isDeleted: false };

    if (location_id !== undefined || location !== undefined) {
      if (!location_id && !String(location ?? "").trim()) {
        return createError(res, 400, "location cannot be empty.");
      }
      const dispatchLocation = location_id
        ? await DispatchLocation.findById(location_id).where({
            isDeleted: false,
          })
        : await getOrCreateLocation(location);
      if (!dispatchLocation) {
        return createError(res, 404, "Dispatch location not found.");
      }
      updatePayload.location_id = dispatchLocation._id;
      updatePayload.location = dispatchLocation.name;
    }
    if (raw_material_id !== undefined) {
      const rm = await RawMaterial.findById(raw_material_id).where({
        isDeleted: false,
      });
      if (!rm) return createError(res, 404, "Raw material not found.");
      updatePayload.raw_material_id = raw_material_id;
    }
    if (raw_material_stock_id !== undefined) {
      if (raw_material_stock_id) {
        const stock = await RawMaterialStock.findById(
          raw_material_stock_id,
        ).where({ isDeleted: false });
        if (!stock) {
          return createError(res, 404, "Raw material stock batch not found.");
        }
      }
      updatePayload.raw_material_stock_id = raw_material_stock_id || null;
    }
    if (quantity !== undefined) {
      const qty = Number(quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        return createError(res, 400, "quantity must be greater than 0.");
      }
      updatePayload.quantity = qty;
    }
    if (dispatch_date !== undefined) {
      updatePayload.dispatch_date = new Date(dispatch_date);
    }
    if (notes !== undefined) updatePayload.notes = notes;

    const userId = getUserId(req);

    const item = await withTransaction(async (session) => {
      const opts = { session };

      if (existing.generated_stock_id) {
        await reverseRawMaterialDispatchImpact(
          {
            rawMaterialId: existing.raw_material_id,
            quantity: existing.quantity,
            generatedStockId: existing.generated_stock_id,
            referenceId: existing._id,
          },
          userId,
          session,
        );
      }

      const updated = await RawMaterialDispatch.findByIdAndUpdate(
        req.params.id,
        { ...updatePayload, generated_stock_id: null },
        { new: true, runValidators: true, session },
      );

      const finalLocation = updatePayload.location_id
        ? await DispatchLocation.findById(updatePayload.location_id).session(session)
        : await DispatchLocation.findById(existing.location_id).session(session);

      const finalMaterialId = updatePayload.raw_material_id ?? existing.raw_material_id;
      const finalQty = updatePayload.quantity ?? existing.quantity;
      const dispatchNotes =
        updatePayload.notes ??
        existing.notes ??
        `Dispatch to ${finalLocation?.name ?? existing.location}`;

      const { generatedStockId } = await applyRawMaterialDispatchImpact({
        rawMaterialId: finalMaterialId,
        quantity: finalQty,
        locationId: finalLocation?._id ?? existing.location_id,
        storeId: finalLocation?.store_id ?? null,
        referenceId: updated._id,
        userId,
        notes: dispatchNotes,
        session,
      });

      updated.generated_stock_id = generatedStockId;
      await updated.save(opts);

      await writeAudit({
        entityType: "RawMaterialDispatch",
        entityId: updated._id,
        action: "update",
        previousValue: existing.toObject?.() ?? existing,
        newValue: updated.toObject?.() ?? updated,
        userId,
        session,
      });

      return updated;
    });

    const populated = await populateRefs(RawMaterialDispatch.findById(item._id));
    return successMessage(res, populated || item, "Dispatch updated successfully.");
  } catch (err) {
    console.error("RawMaterialDispatch update error:", err);
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to update dispatch.",
    );
  }
};

const remove = async (req, res) => {
  try {
    const existing = await RawMaterialDispatch.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!existing) return createError(res, 404, "Dispatch not found.");

    const userId = getUserId(req);

    const item = await withTransaction(async (session) => {
      if (existing.generated_stock_id) {
        await reverseRawMaterialDispatchImpact(
          {
            rawMaterialId: existing.raw_material_id,
            quantity: existing.quantity,
            generatedStockId: existing.generated_stock_id,
            referenceId: existing._id,
          },
          userId,
          session,
        );
      }

      const deleted = await RawMaterialDispatch.findOneAndUpdate(
        { _id: req.params.id, isDeleted: false },
        { isDeleted: true, generated_stock_id: null },
        { new: true, session },
      );

      await writeAudit({
        entityType: "RawMaterialDispatch",
        entityId: deleted._id,
        action: "delete",
        previousValue: existing.toObject?.() ?? existing,
        userId,
        session,
      });

      return deleted;
    });

    return successMessage(res, item, "Dispatch deleted successfully.");
  } catch (err) {
    console.error("RawMaterialDispatch remove error:", err);
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to delete dispatch.",
    );
  }
};

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { list, getOne, create, update, remove };
