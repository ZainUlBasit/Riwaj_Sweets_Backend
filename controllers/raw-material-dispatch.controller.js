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
  validateRmTransferLocations,
  withTransaction,
} = require("../Services/inventoryService");
const { assertRmManagerStoreAccess, applyStoreLocationFilter } = require("../utils/storeScope");

const populateRefs = (q) =>
  q
    .populate("raw_material_id")
    .populate("raw_material_stock_id")
    .populate("generated_stock_id")
    .populate("from_location_id")
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

    const scopedFilter = await applyStoreLocationFilter(
      req,
      baseFilter,
      "location_id",
    );

    const items = await populateRefs(
      RawMaterialDispatch.find({ ...scopedFilter, isDeleted: false }).sort({
        dispatch_date: -1,
        createdAt: -1,
      }),
    );
    const deletedItems = await populateRefs(
      RawMaterialDispatch.find({ ...scopedFilter, isDeleted: true }).sort({
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
      from_location_id,
      raw_material_id,
      raw_material_stock_id,
      quantity,
      dispatch_date,
      notes,
    } = req.body || {};

    if (!from_location_id) {
      return createError(
        res,
        400,
        "from_location_id (RM Store) is required.",
      );
    }
    if (!location_id && (!location || !String(location).trim())) {
      return createError(
        res,
        400,
        "location_id (Production Area or Shop) is required.",
      );
    }
    if (!raw_material_id) {
      return createError(res, 400, "raw_material_id is required.");
    }
    if (!raw_material_stock_id) {
      return createError(
        res,
        400,
        "raw_material_stock_id (purchase batch) is required.",
      );
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
      if (Number(stock.purpose) !== 1) {
        return createError(
          res,
          400,
          "Dispatch must reference a purchase stock batch.",
        );
      }
      const remaining =
        stock.remaining_quantity != null
          ? Number(stock.remaining_quantity)
          : Number(stock.quantity || 0) - Number(stock.out_quantity || 0);
      if (qty > remaining) {
        return createError(
          res,
          409,
          `Insufficient batch stock. Remaining: ${remaining}, requested: ${qty}.`,
        );
      }
    }

    const fromLocation = await DispatchLocation.findById(from_location_id).where({
      isDeleted: false,
    });
    if (!fromLocation) {
      return createError(res, 404, "RM Store not found.");
    }

    const toLocation = location_id
      ? await DispatchLocation.findById(location_id).where({ isDeleted: false })
      : await getOrCreateLocation(location);
    if (!toLocation) {
      return createError(res, 404, "Destination location not found.");
    }

    try {
      await validateRmTransferLocations(fromLocation._id, toLocation._id);
    } catch (err) {
      return createError(res, err.status || 400, err.message);
    }

    try {
      await assertRmManagerStoreAccess(req, [
        fromLocation._id,
        toLocation._id,
      ]);
    } catch (err) {
      return createError(res, err.status || 403, err.message);
    }

    const userId = getUserId(req);
    const dispatchNotes =
      notes?.trim() ||
      `RM Store → ${toLocation.name}${raw_material_stock_id ? " (batch ref)" : ""}`;

    const item = await withTransaction(async (session) => {
      const opts = { session };
      const [created] = await RawMaterialDispatch.create(
        [
          {
            from_location_id: fromLocation._id,
            location_id: toLocation._id,
            location: toLocation.name,
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

      await applyRawMaterialDispatchImpact({
        rawMaterialId: raw_material_id,
        quantity: qty,
        fromLocationId: fromLocation._id,
        toLocationId: toLocation._id,
        storeId: fromLocation.store_id ?? toLocation.store_id ?? null,
        rawMaterialStockId: raw_material_stock_id || null,
        referenceId: created._id,
        userId,
        notes: dispatchNotes,
        session,
      });

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
      from_location_id,
      raw_material_id,
      raw_material_stock_id,
      quantity,
      dispatch_date,
      notes,
    } = req.body || {};

    const updatePayload = { isDeleted: false };

    if (from_location_id !== undefined) {
      if (!from_location_id) {
        return createError(res, 400, "from_location_id (RM Store) cannot be empty.");
      }
      const fromLoc = await DispatchLocation.findById(from_location_id).where({
        isDeleted: false,
      });
      if (!fromLoc) return createError(res, 404, "RM Store not found.");
      updatePayload.from_location_id = fromLoc._id;
    }

    if (location_id !== undefined || location !== undefined) {
      if (!location_id && !String(location ?? "").trim()) {
        return createError(res, 400, "Destination location cannot be empty.");
      }
      const dispatchLocation = location_id
        ? await DispatchLocation.findById(location_id).where({
            isDeleted: false,
          })
        : await getOrCreateLocation(location);
      if (!dispatchLocation) {
        return createError(res, 404, "Destination location not found.");
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

    const finalFromId =
      updatePayload.from_location_id ?? existing.from_location_id ?? null;
    const finalToId =
      updatePayload.location_id ?? existing.location_id ?? null;

    if (finalFromId && finalToId) {
      try {
        await validateRmTransferLocations(finalFromId, finalToId);
      } catch (err) {
        return createError(res, err.status || 400, err.message);
      }
    }

    const item = await withTransaction(async (session) => {
      const opts = { session };

      if (existing.from_location_id && existing.location_id) {
        await reverseRawMaterialDispatchImpact(
          {
            rawMaterialId: existing.raw_material_id,
            quantity: existing.quantity,
            fromLocationId: existing.from_location_id,
            toLocationId: existing.location_id,
            generatedStockId: existing.generated_stock_id,
            rawMaterialStockId: existing.raw_material_stock_id,
            referenceId: existing._id,
          },
          userId,
          session,
        );
      } else if (existing.generated_stock_id) {
        await reverseRawMaterialDispatchImpact(
          {
            rawMaterialId: existing.raw_material_id,
            quantity: existing.quantity,
            generatedStockId: existing.generated_stock_id,
            rawMaterialStockId: existing.raw_material_stock_id,
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
      const finalFromLocation = updatePayload.from_location_id
        ? await DispatchLocation.findById(updatePayload.from_location_id).session(session)
        : existing.from_location_id
          ? await DispatchLocation.findById(existing.from_location_id).session(session)
          : null;

      const finalMaterialId = updatePayload.raw_material_id ?? existing.raw_material_id;
      const finalQty = updatePayload.quantity ?? existing.quantity;
      const finalStockId =
        updatePayload.raw_material_stock_id !== undefined
          ? updatePayload.raw_material_stock_id
          : existing.raw_material_stock_id;
      const dispatchNotes =
        updatePayload.notes ??
        existing.notes ??
        `Dispatch to ${finalLocation?.name ?? existing.location}`;

      if (finalFromLocation?._id && finalLocation?._id) {
        await applyRawMaterialDispatchImpact({
          rawMaterialId: finalMaterialId,
          quantity: finalQty,
          fromLocationId: finalFromLocation._id,
          toLocationId: finalLocation._id,
          storeId:
            finalFromLocation.store_id ?? finalLocation.store_id ?? null,
          rawMaterialStockId: finalStockId || null,
          referenceId: updated._id,
          userId,
          notes: dispatchNotes,
          session,
        });
      } else if (finalLocation?._id) {
        const { generatedStockId } = await applyRawMaterialDispatchImpact({
          rawMaterialId: finalMaterialId,
          quantity: finalQty,
          locationId: finalLocation._id,
          storeId: finalLocation.store_id ?? null,
          rawMaterialStockId: finalStockId || null,
          referenceId: updated._id,
          userId,
          notes: dispatchNotes,
          session,
        });
        updated.generated_stock_id = generatedStockId;
        await updated.save(opts);
      }

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
      if (existing.from_location_id && existing.location_id) {
        await reverseRawMaterialDispatchImpact(
          {
            rawMaterialId: existing.raw_material_id,
            quantity: existing.quantity,
            fromLocationId: existing.from_location_id,
            toLocationId: existing.location_id,
            generatedStockId: existing.generated_stock_id,
            rawMaterialStockId: existing.raw_material_stock_id,
            referenceId: existing._id,
          },
          userId,
          session,
        );
      } else if (existing.generated_stock_id) {
        await reverseRawMaterialDispatchImpact(
          {
            rawMaterialId: existing.raw_material_id,
            quantity: existing.quantity,
            generatedStockId: existing.generated_stock_id,
            rawMaterialStockId: existing.raw_material_stock_id,
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
