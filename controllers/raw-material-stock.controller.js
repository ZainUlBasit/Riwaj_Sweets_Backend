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
    const filter = { isDeleted: false };
    if (req.query.raw_material_id) {
      filter.raw_material_id = req.query.raw_material_id;
    }
    if (req.query.purpose) {
      filter.purpose = Number(req.query.purpose);
    }

    const locationPopulate = {
      path: "rm_store_location_id",
      select: "name location_type store_id",
      populate: { path: "store_id", select: "name" },
    };

    const items = await RawMaterialStock.find(filter)
      .populate("raw_material_id")
      .populate("supplier_id")
      .populate(locationPopulate)
      .sort({ createdAt: -1 });
    const deletedItems = await RawMaterialStock.find({ isDeleted: true })
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

const create = async (req, res) => {
  try {
    const {
      raw_material_id,
      supplier_id,
      desc,
      quantity,
      price,
      total_price,
      rm_store_location_id,
    } = req.body;
    if (!raw_material_id) {
      return createError(res, 400, "raw_material_id is required.");
    }
    if (!supplier_id) {
      return createError(res, 400, "supplier_id is required.");
    }
    const batchDesc = String(desc ?? "").trim();
    if (!batchDesc) {
      return createError(res, 400, "Description (Batch) is required.");
    }
    if (!rm_store_location_id) {
      return createError(
        res,
        400,
        "rm_store_location_id is required. Purchase must go into an RM Store.",
      );
    }
    const qty = Number(quantity ?? 0);
    if (!qty || qty <= 0) {
      return createError(res, 400, "quantity must be greater than 0.");
    }
    const prc = Number(price ?? 0);
    const totalPrice = total_price != null ? Number(total_price) : qty * prc;

    const rawMaterial = await RawMaterial.findById(raw_material_id).where({
      isDeleted: false,
    });
    if (!rawMaterial) {
      return createError(res, 404, "Raw material not found.");
    }

    const supplier = await Supplier.findById(supplier_id).where({
      isDeleted: false,
    });
    if (!supplier) {
      return createError(res, 404, "Supplier not found.");
    }

    const loc = await DispatchLocation.findById(rm_store_location_id).where({
      isDeleted: false,
    });
    if (!loc) {
      return createError(res, 404, "RM Store location not found.");
    }
    if (Number(loc.location_type) !== 1) {
      return createError(
        res,
        400,
        "rm_store_location_id must be a Raw Material Store.",
      );
    }

    const userId = getUserId(req);

    const item = await withTransaction(async (session) => {
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

      // Latest purchase price becomes the Raw Material unit price.
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

      // Location credit + ledger (type 1) — single source, no duplicate ledger.
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
        await adjustRawMaterial(
          oldItem.raw_material_id,
          { inDelta: -oldItem.quantity, availDelta: -oldItem.quantity },
          session,
        );
      }

      if (oldRmStoreId) {
        await debitRmStoreOnPurchaseReverse({
          rmStoreLocationId: oldRmStoreId,
          rawMaterialId: oldItem.raw_material_id,
          quantity: oldItem.quantity,
          referenceType: "RawMaterialStock",
          referenceId: oldItem._id,
          userId,
          notes: "Purchase stock entry updated (reverse old)",
          session,
        });
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
        { inDelta: qty, availDelta: qty },
        session,
      );

      await creditRmStoreOnPurchase({
        rmStoreLocationId: newRmStoreId,
        rawMaterialId: newRawMaterialId,
        quantity: qty,
        referenceType: "RawMaterialStock",
        referenceId: updated._id,
        userId,
        notes: "Purchase stock entry updated",
        session,
      });

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

    if (Number(item.out_quantity || 0) > 0) {
      return createError(
        res,
        400,
        "Cannot delete a batch that has already been partially dispatched. Reverse those dispatches first.",
      );
    }

    const userId = getUserId(req);
    const totalPrice = item.total_price || 0;
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
        const updated = await adjustRawMaterial(
          item.raw_material_id,
          { inDelta: -item.quantity, availDelta: -item.quantity },
          session,
        );
        await writeLedger(
          {
            transactionType: TX.ADJUSTMENT,
            direction: DIR.OUT,
            rawMaterialId: item.raw_material_id,
            quantity: item.quantity,
            locationId: rmStoreId,
            referenceType: "RawMaterialStock",
            referenceId: item._id,
            userId,
            notes: "Purchase stock entry deleted",
            previousBalance: prevAvail,
            newBalance: Number(
              updated?.available_quantity ?? prevAvail - item.quantity,
            ),
          },
          session,
        );
      }

      if (rmStoreId) {
        await debitRmStoreOnPurchaseReverse({
          rmStoreLocationId: rmStoreId,
          rawMaterialId: item.raw_material_id,
          quantity: item.quantity,
          referenceType: "RawMaterialStock",
          referenceId: item._id,
          userId,
          notes: "Purchase stock entry deleted",
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
        session,
      });

      return softDeleted || item;
    });

    return successMessage(
      res,
      deleted,
      "Raw material stock deleted successfully.",
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
  update,
  remove,
  createProduction,
  removeProduction,
};
