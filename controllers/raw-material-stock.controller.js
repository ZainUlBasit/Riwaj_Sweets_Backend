const RawMaterialStock = require("../Models/RawMaterialStock");
const RawMaterial = require("../Models/RawMaterial");
const Supplier = require("../Models/Supplier");
const DispatchLocation = require("../Models/DispatchLocation");
const InventoryLedger = require("../Models/InventoryLedger");
const { createError, successMessage } = require("../utils/ResponseMessage");
const {
  TX,
  DIR,
  getUserId,
  writeAudit,
  writeLedger,
  getRawMaterialAvailable,
  adjustRawMaterial,
  creditRmStoreOnPurchase,
  debitRmStoreOnPurchaseReverse,
  withTransaction,
} = require("../Services/inventoryService");
const { applyInventoryStoreFilter, assertRmManagerStoreAccess } = require("../utils/storeScope");

/** Resolve RM Store for a purchase — stored field, or legacy ledger lookup. */
async function resolvePurchaseRmStoreId(stockDoc, session = null) {
  if (stockDoc?.rm_store_location_id) {
    return stockDoc.rm_store_location_id;
  }
  const q = InventoryLedger.findOne({
    reference_type: "RawMaterialStock",
    reference_id: stockDoc._id,
    transaction_type: TX.RAW_MATERIAL_STOCK_IN,
    direction: DIR.IN,
    isDeleted: false,
    location_id: { $ne: null },
  }).sort({ createdAt: 1 });
  if (session) q.session(session);
  const entry = await q;
  return entry?.location_id ?? null;
}

/** Resolve purchase supplier — stock field, or legacy RM master supplier. */
function resolvePurchaseSupplierId(stockDoc, rawMaterialDoc = null) {
  if (stockDoc?.supplier_id) return stockDoc.supplier_id;
  if (rawMaterialDoc?.supplier_id) return rawMaterialDoc.supplier_id;
  return null;
}

const list = async (req, res) => {
  try {
    const filter = {};
    if (req.query.raw_material_id) {
      filter.raw_material_id = req.query.raw_material_id;
    }
    if (req.query.purpose) {
      filter.purpose = Number(req.query.purpose);
    }

    const scopedFilter = await applyInventoryStoreFilter(
      req,
      filter,
      "rm_store_location_id",
    );

    const locationPopulate = {
      path: "rm_store_location_id",
      select: "name location_type store_id",
      populate: { path: "store_id", select: "name" },
    };

    const items = await RawMaterialStock.find({
      ...scopedFilter,
      isDeleted: false,
    })
      .populate("raw_material_id")
      .populate("supplier_id")
      .populate(locationPopulate)
      .sort({ createdAt: -1 });
    const deletedItems = await RawMaterialStock.find({
      ...scopedFilter,
      isDeleted: true,
    })
      .populate("raw_material_id")
      .populate("supplier_id")
      .populate(locationPopulate)
      .sort({ createdAt: -1 });

    // Legacy purchases may lack rm_store_location_id — resolve from ledger in bulk.
    // Also backfill batch remaining for older rows that predate out/remaining fields.
    const enrichStore = async (docs) => {
      const objects = docs.map((doc) => doc.toObject?.() ?? doc);
      for (const obj of objects) {
        if (Number(obj.purpose) === 1) {
          const inQty = Number(obj.quantity || 0);
          const outQty = Number(obj.out_quantity || 0);
          const remQty = Number(obj.remaining_quantity || 0);
          if (Math.abs(remQty + outQty - inQty) > 0.0001) {
            obj.out_quantity = outQty;
            obj.remaining_quantity = Math.max(0, inQty - outQty);
          }
        }
      }
      const missing = objects.filter(
        (o) => !o.rm_store_location_id && Number(o.purpose) === 1,
      );
      if (!missing.length) return objects;

      const ids = missing.map((o) => o._id);
      const ledgerRows = await InventoryLedger.find({
        reference_type: "RawMaterialStock",
        reference_id: { $in: ids },
        transaction_type: TX.RAW_MATERIAL_STOCK_IN,
        direction: DIR.IN,
        isDeleted: false,
        location_id: { $ne: null },
      })
        .select("reference_id location_id")
        .sort({ createdAt: 1 })
        .lean();

      const locByRef = new Map();
      for (const row of ledgerRows) {
        const key = String(row.reference_id);
        if (!locByRef.has(key)) locByRef.set(key, row.location_id);
      }

      const locIds = [...new Set([...locByRef.values()].map(String))];
      const locations = await DispatchLocation.find({ _id: { $in: locIds } })
        .select("name location_type store_id")
        .populate("store_id", "name")
        .lean();
      const locMap = new Map(locations.map((l) => [String(l._id), l]));

      for (const obj of objects) {
        if (obj.rm_store_location_id || Number(obj.purpose) !== 1) continue;
        const locId = locByRef.get(String(obj._id));
        if (locId) obj.rm_store_location_id = locMap.get(String(locId)) ?? null;
      }
      return objects;
    };

    return successMessage(
      res,
      {
        items: await enrichStore(items),
        deletedItems: await enrichStore(deletedItems),
      },
      "Raw material stock entries fetched successfully.",
    );
  } catch (err) {
    console.error("RawMaterialStock list error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to fetch raw material stock.",
    );
  }
};

const getOne = async (req, res) => {
  try {
    const item = await RawMaterialStock.findById(req.params.id)
      .populate("raw_material_id")
      .populate("supplier_id")
      .populate("rm_store_location_id", "name location_type")
      .where({ isDeleted: false });
    if (!item)
      return createError(res, 404, "Raw material stock entry not found.");
    return successMessage(
      res,
      item,
      "Raw material stock fetched successfully.",
    );
  } catch (err) {
    console.error("RawMaterialStock getOne error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to fetch raw material stock.",
    );
  }
};


/** Create one purchase stock entry (same rules as POST /). */
async function createPurchaseStock(body, userId) {
  const {
    raw_material_id,
    supplier_id,
    desc,
    quantity,
    price,
    total_price,
    rm_store_location_id,
  } = body || {};

  if (!raw_material_id) {
    const err = new Error("raw_material_id is required.");
    err.status = 400;
    throw err;
  }
  if (!supplier_id) {
    const err = new Error("supplier_id is required.");
    err.status = 400;
    throw err;
  }
  const batchDesc = String(desc ?? "").trim();
  if (!batchDesc) {
    const err = new Error("Description (Batch) is required.");
    err.status = 400;
    throw err;
  }
  if (!rm_store_location_id) {
    const err = new Error(
      "rm_store_location_id is required. Purchase must go into an RM Store.",
    );
    err.status = 400;
    throw err;
  }
  const qty = Number(quantity ?? 0);
  if (!qty || qty <= 0) {
    const err = new Error("quantity must be greater than 0.");
    err.status = 400;
    throw err;
  }
  const prc = Number(price ?? 0);
  const totalPrice = total_price != null ? Number(total_price) : qty * prc;

  const rawMaterial = await RawMaterial.findById(raw_material_id).where({
    isDeleted: false,
  });
  if (!rawMaterial) {
    const err = new Error("Raw material not found.");
    err.status = 404;
    throw err;
  }

  const supplier = await Supplier.findById(supplier_id).where({
    isDeleted: false,
  });
  if (!supplier) {
    const err = new Error("Supplier not found.");
    err.status = 404;
    throw err;
  }

  const loc = await DispatchLocation.findById(rm_store_location_id).where({
    isDeleted: false,
  });
  if (!loc) {
    const err = new Error("RM Store location not found.");
    err.status = 404;
    throw err;
  }
  if (Number(loc.location_type) !== 1) {
    const err = new Error("rm_store_location_id must be a Raw Material Store.");
    err.status = 400;
    throw err;
  }

  return withTransaction(async (session) => {
    const opts = { session };

    const [created] = await RawMaterialStock.create(
      [
        {
          raw_material_id,
          supplier_id,
          desc: batchDesc,
          quantity: qty,
          out_quantity: 0,
          remaining_quantity: qty,
          price: prc,
          total_price: totalPrice,
          purpose: 1,
          rm_store_location_id,
          isDeleted: false,
        },
      ],
      opts,
    );

    await RawMaterial.findByIdAndUpdate(
      raw_material_id,
      { price: prc },
      opts,
    );

    await adjustRawMaterial(
      raw_material_id,
      { inDelta: qty, availDelta: qty },
      session,
    );

    await Supplier.findByIdAndUpdate(
      supplier_id,
      { $inc: { total_amount: totalPrice, payable: totalPrice } },
      opts,
    );

    await creditRmStoreOnPurchase({
      rmStoreLocationId: rm_store_location_id,
      rawMaterialId: raw_material_id,
      quantity: qty,
      referenceType: "RawMaterialStock",
      referenceId: created._id,
      userId,
      notes: batchDesc || "Raw material purchase",
      session,
    });

    await writeAudit({
      entityType: "RawMaterialStock",
      entityId: created._id,
      action: "create",
      newValue: created.toObject?.() ?? created,
      userId,
      session,
    });

    return created;
  });
}

const create = async (req, res) => {
  try {
    const userId = getUserId(req);
    const item = await createPurchaseStock(req.body, userId);
    return successMessage(
      res,
      item,
      "Raw material stock entry created successfully.",
    );
  } catch (err) {
    console.error("RawMaterialStock create error:", err);
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to create raw material stock.",
    );
  }
};

/**
 * POST /api/raw-material-stock/bulk
 * Bulk purchase stock-in. Optional give_to_ustad adds RM to that ustad's
 * OPEN job only (no new job create).
 */
const createBulk = async (req, res) => {
  try {
    const {
      items,
      supplier_id: headerSupplierId,
      rm_store_location_id: headerRmStoreId,
    } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return createError(res, 400, "items array is required.");
    }
    if (items.length > 200) {
      return createError(res, 400, "Max 200 items per bulk request.");
    }

    const userId = getUserId(req);
    const {
      findOpenJobForUstad,
      issueExtraRmOnOpenJob,
    } = require("./ustad-job.controller");

    const created = [];
    const issued = [];
    const errors = [];
    const pendingByJob = new Map();

    for (let i = 0; i < items.length; i++) {
      const row = items[i] || {};
      const label = `Item ${i + 1}`;
      const payload = {
        raw_material_id: row.raw_material_id,
        supplier_id: row.supplier_id || headerSupplierId,
        desc: row.desc,
        quantity: row.quantity,
        price: row.price,
        total_price: row.total_price,
        rm_store_location_id: row.rm_store_location_id || headerRmStoreId,
      };

      try {
        await assertRmManagerStoreAccess(req, [payload.rm_store_location_id]);
        const stock = await createPurchaseStock(payload, userId);
        created.push(stock);

        const giveToUstad =
          row.give_to_ustad === true ||
          row.giveToUstad === true;
        if (giveToUstad) {
          const ustadId = row.ustad_id;
          if (!ustadId) {
            errors.push(`${label}: ustad_id required when give_to_ustad.`);
            continue;
          }
          const openJob = await findOpenJobForUstad(ustadId);
          if (!openJob) {
            errors.push(
              `${label}: Ustad ka active (open) job nahi mila — pehle job kholo.`,
            );
            continue;
          }
          const issueDate = row.issue_date || row.issueDate || null;
          const key = `${openJob._id}|${issueDate || ""}`;
          const group = pendingByJob.get(key) || {
            job: openJob,
            issue_date: issueDate,
            lines: [],
          };
          group.lines.push({
            raw_material_id: payload.raw_material_id,
            raw_material_stock_id: stock._id,
            quantity: Number(payload.quantity),
          });
          pendingByJob.set(key, group);
        }
      } catch (err) {
        errors.push(`${label}: ${err.message || "Failed"}`);
      }
    }

    for (const group of pendingByJob.values()) {
      try {
        const { extraValue } = await issueExtraRmOnOpenJob({
          job: group.job,
          lines: group.lines,
          issue_date: group.issue_date,
          userId,
          req,
        });
        issued.push({
          job_id: group.job._id,
          job_code: group.job.job_code,
          lines: group.lines.length,
          extra_value: extraValue,
        });
      } catch (err) {
        errors.push(
          `Ustad job ${group.job.job_code || group.job._id}: ${err.message}`,
        );
      }
    }

    return successMessage(
      res,
      {
        created,
        issued,
        errors,
        created_count: created.length,
        issued_jobs: issued.length,
      },
      errors.length
        ? `Bulk done with ${errors.length} warning(s).`
        : "Bulk RM stock created successfully.",
    );
  } catch (err) {
    console.error("RawMaterialStock createBulk error:", err);
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to bulk create raw material stock.",
    );
  }
};

const update = async (req, res) => {
  try {
    const oldItem = await RawMaterialStock.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!oldItem)
      return createError(res, 404, "Raw material stock entry not found.");

    if (Number(oldItem.purpose) === 2) {
      return createError(
        res,
        400,
        "Production consumption entries cannot be edited. Delete and re-create production instead.",
      );
    }

    const {
      raw_material_id,
      supplier_id,
      desc,
      quantity,
      price,
      total_price,
      rm_store_location_id,
    } = req.body;
    const userId = getUserId(req);

    const qty = Number(quantity ?? oldItem.quantity ?? 0);
    if (!qty || qty <= 0) {
      return createError(res, 400, "quantity must be greater than 0.");
    }
    const alreadyOut = Number(oldItem.out_quantity || 0);
    if (qty < alreadyOut) {
      return createError(
        res,
        400,
        `Cannot set quantity below already dispatched amount (${alreadyOut}).`,
      );
    }
    const remainingQty = qty - alreadyOut;
    const batchDesc =
      desc !== undefined ? String(desc ?? "").trim() : String(oldItem.desc ?? "").trim();
    if (!batchDesc) {
      return createError(res, 400, "Description (Batch) is required.");
    }
    const prc = Number(price ?? oldItem.price ?? 0);
    const newTotalPrice = total_price != null ? Number(total_price) : qty * prc;
    const newRawMaterialId = raw_material_id ?? oldItem.raw_material_id;

    const newRawMaterial = await RawMaterial.findById(newRawMaterialId).where({
      isDeleted: false,
    });
    if (!newRawMaterial) {
      return createError(res, 404, "Raw material not found.");
    }

    const oldRawMaterial = await RawMaterial.findById(
      oldItem.raw_material_id,
    ).where({ isDeleted: false });

    const oldSupplierId = resolvePurchaseSupplierId(oldItem, oldRawMaterial);
    let newSupplierId =
      supplier_id !== undefined
        ? supplier_id
        : resolvePurchaseSupplierId(oldItem, newRawMaterial);

    if (!newSupplierId) {
      return createError(res, 400, "supplier_id is required.");
    }

    const newSupplier = await Supplier.findById(newSupplierId).where({
      isDeleted: false,
    });
    if (!newSupplier) {
      return createError(res, 404, "Supplier not found.");
    }

    const oldRmStoreId = await resolvePurchaseRmStoreId(oldItem);
    let newRmStoreId =
      rm_store_location_id !== undefined
        ? rm_store_location_id
        : oldRmStoreId;

    if (!newRmStoreId) {
      return createError(
        res,
        400,
        "rm_store_location_id is required. Purchase must be linked to an RM Store.",
      );
    }

    const newLoc = await DispatchLocation.findById(newRmStoreId).where({
      isDeleted: false,
    });
    if (!newLoc) {
      return createError(res, 404, "RM Store location not found.");
    }
    if (Number(newLoc.location_type) !== 1) {
      return createError(
        res,
        400,
        "rm_store_location_id must be a Raw Material Store.",
      );
    }

    const item = await withTransaction(async (session) => {
      const opts = { session };
      const oldTotalPrice = oldItem.total_price || 0;

      if (oldSupplierId) {
        await Supplier.findByIdAndUpdate(
          oldSupplierId,
          { $inc: { total_amount: -oldTotalPrice, payable: -oldTotalPrice } },
          opts,
        );
      }

      if (oldRawMaterial) {
        // Only remaining (not yet dispatched) still sits in available / RM Store.
        const oldRemaining = Math.max(
          0,
          Number(oldItem.quantity || 0) - alreadyOut,
        );
        await adjustRawMaterial(
          oldItem.raw_material_id,
          {
            inDelta: -Number(oldItem.quantity || 0),
            availDelta: -oldRemaining,
          },
          session,
        );
      }

      if (oldRmStoreId) {
        const oldRemaining = Math.max(
          0,
          Number(oldItem.quantity || 0) - alreadyOut,
        );
        if (oldRemaining > 0) {
          await debitRmStoreOnPurchaseReverse({
            rmStoreLocationId: oldRmStoreId,
            rawMaterialId: oldItem.raw_material_id,
            quantity: oldRemaining,
            referenceType: "RawMaterialStock",
            referenceId: oldItem._id,
            userId,
            notes: "Purchase stock entry updated (reverse old remaining)",
            session,
          });
        }
      }

      const updated = await RawMaterialStock.findByIdAndUpdate(
        req.params.id,
        {
          raw_material_id: newRawMaterialId,
          supplier_id: newSupplierId,
          desc: batchDesc,
          quantity: qty,
          out_quantity: alreadyOut,
          remaining_quantity: remainingQty,
          price: prc,
          total_price: newTotalPrice,
          rm_store_location_id: newRmStoreId,
          isDeleted: false,
        },
        { new: true, runValidators: true, ...opts },
      );

      // Latest purchase price becomes the Raw Material unit price.
      await RawMaterial.findByIdAndUpdate(
        newRawMaterialId,
        { price: prc },
        opts,
      );

      await Supplier.findByIdAndUpdate(
        newSupplierId,
        { $inc: { total_amount: newTotalPrice, payable: newTotalPrice } },
        opts,
      );

      await adjustRawMaterial(
        newRawMaterialId,
        { inDelta: qty, availDelta: remainingQty },
        session,
      );

      if (remainingQty > 0) {
        await creditRmStoreOnPurchase({
          rmStoreLocationId: newRmStoreId,
          rawMaterialId: newRawMaterialId,
          quantity: remainingQty,
          referenceType: "RawMaterialStock",
          referenceId: updated._id,
          userId,
          notes: "Purchase stock entry updated",
          session,
        });
      }

      await writeAudit({
        entityType: "RawMaterialStock",
        entityId: updated._id,
        action: "update",
        previousValue: oldItem.toObject?.() ?? oldItem,
        newValue: updated.toObject?.() ?? updated,
        userId,
        session,
      });

      return updated;
    });

    return successMessage(
      res,
      item,
      "Raw material stock updated successfully.",
    );
  } catch (err) {
    console.error("RawMaterialStock update error:", err);
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to update raw material stock.",
    );
  }
};

const remove = async (req, res) => {
  try {
    const item = await RawMaterialStock.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!item)
      return createError(res, 404, "Raw material stock entry not found.");

    if (Number(item.purpose) === 2) {
      return createError(
        res,
        400,
        "Use DELETE /raw-material-stock/production/:id for production consumption entries.",
      );
    }

    const userId = getUserId(req);
    const totalPrice = item.total_price || 0;
    const alreadyOut = Number(item.out_quantity || 0);
    const remaining = Math.max(0, Number(item.quantity || 0) - alreadyOut);
    const rmStoreId = await resolvePurchaseRmStoreId(item);

    const deleted = await withTransaction(async (session) => {
      const opts = { session };
      const rawMaterial = await RawMaterial.findById(item.raw_material_id)
        .where({ isDeleted: false })
        .session(session);

      const supplierId = resolvePurchaseSupplierId(item, rawMaterial);

      if (supplierId) {
        await Supplier.findByIdAndUpdate(
          supplierId,
          { $inc: { total_amount: -totalPrice, payable: -totalPrice } },
          opts,
        );
      }

      if (rawMaterial) {
        const prevAvail = Number(rawMaterial.available_quantity || 0);
        // Reverse full purchase `in`, but only remaining still in available/RM Store.
        const updated = await adjustRawMaterial(
          item.raw_material_id,
          {
            inDelta: -Number(item.quantity || 0),
            availDelta: -remaining,
          },
          session,
        );
        await writeLedger(
          {
            transactionType: TX.ADJUSTMENT,
            direction: DIR.OUT,
            rawMaterialId: item.raw_material_id,
            quantity: Number(item.quantity || 0),
            locationId: rmStoreId,
            referenceType: "RawMaterialStock",
            referenceId: item._id,
            userId,
            notes:
              alreadyOut > 0
                ? `Purchase deleted (remaining ${remaining} restored reverse; ${alreadyOut} already dispatched)`
                : "Purchase stock entry deleted",
            previousBalance: prevAvail,
            newBalance: Number(
              updated?.available_quantity ?? prevAvail - remaining,
            ),
          },
          session,
        );
      }

      if (rmStoreId && remaining > 0) {
        await debitRmStoreOnPurchaseReverse({
          rmStoreLocationId: rmStoreId,
          rawMaterialId: item.raw_material_id,
          quantity: remaining,
          referenceType: "RawMaterialStock",
          referenceId: item._id,
          userId,
          notes: "Purchase stock entry deleted (remaining reverse)",
          session,
        });
      }

      const softDeleted = await RawMaterialStock.findOneAndUpdate(
        { _id: req.params.id, isDeleted: false },
        { isDeleted: true },
        { new: true, ...opts },
      );

      await writeAudit({
        entityType: "RawMaterialStock",
        entityId: item._id,
        action: "delete",
        previousValue: item.toObject?.() ?? item,
        userId,
        notes:
          alreadyOut > 0
            ? `Admin delete with partial dispatch out=${alreadyOut}`
            : undefined,
        session,
      });

      return softDeleted || item;
    });

    return successMessage(
      res,
      deleted,
      alreadyOut > 0
        ? "Raw material stock deleted — remaining qty + supplier payable restored (dispatched portion stays at destination)."
        : "Raw material stock deleted successfully.",
    );
  } catch (err) {
    console.error("RawMaterialStock remove error:", err);
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to delete raw material stock.",
    );
  }
};

/**
 * Legacy: direct global RM allocation bypassing RM Store → Production.
 * Prefer POST /raw-material-dispatch instead.
 */
const createProduction = async (req, res) => {
  return createError(
    res,
    400,
    "Legacy allocation is disabled. Use RM Store → Production (Raw Material Dispatch) so stock moves through locations.",
  );
};

const removeProduction = async (req, res) => {
  try {
    const item = await RawMaterialStock.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!item)
      return createError(res, 404, "Production stock entry not found.");
    if (Number(item.purpose) !== 2) {
      return createError(
        res,
        400,
        "This endpoint only deletes production-purpose entries.",
      );
    }

    const userId = getUserId(req);
    const prevAvail = await getRawMaterialAvailable(item.raw_material_id);
    const updated = await adjustRawMaterial(item.raw_material_id, {
      outDelta: -item.quantity,
      availDelta: item.quantity,
    });

    const deleted = await RawMaterialStock.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true },
    );

    await writeLedger({
      transactionType: TX.ADJUSTMENT,
      direction: DIR.IN,
      rawMaterialId: item.raw_material_id,
      quantity: item.quantity,
      referenceType: "RawMaterialStock",
      referenceId: item._id,
      userId,
      notes: "Production allocation reversed",
      previousBalance: prevAvail,
      newBalance: Number(
        updated?.available_quantity ?? prevAvail + item.quantity,
      ),
    });

    await writeAudit({
      entityType: "RawMaterialStock",
      entityId: item._id,
      action: "delete",
      previousValue: item.toObject?.() ?? item,
      userId,
      notes: "Production allocation reversed",
    });

    return successMessage(
      res,
      deleted || item,
      "Production stock allocation deleted successfully.",
    );
  } catch (err) {
    console.error("RawMaterialStock removeProduction error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to delete production allocation.",
    );
  }
};

module.exports = {
  list,
  getOne,
  create,
  createBulk,
  update,
  remove,
  createProduction,
  removeProduction,
};
