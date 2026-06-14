const RawMaterialStock = require("../Models/RawMaterialStock");
const RawMaterial = require("../Models/RawMaterial");
const Supplier = require("../Models/Supplier");
const DispatchLocation = require("../Models/DispatchLocation");
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
  withTransaction,
} = require("../Services/inventoryService");

const list = async (req, res) => {
  try {
    const filter = { isDeleted: false };
    if (req.query.raw_material_id) {
      filter.raw_material_id = req.query.raw_material_id;
    }
    if (req.query.purpose) {
      filter.purpose = Number(req.query.purpose);
    }

    const items = await RawMaterialStock.find(filter)
      .populate("raw_material_id")
      .sort({ createdAt: -1 });
    const deletedItems = await RawMaterialStock.find({ isDeleted: true })
      .populate("raw_material_id")
      .sort({ createdAt: -1 });
    return successMessage(
      res,
      { items, deletedItems },
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
      desc,
      quantity,
      price,
      total_price,
      rm_store_location_id,
    } = req.body;
    if (!raw_material_id) {
      return createError(res, 400, "raw_material_id is required.");
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

    if (rm_store_location_id) {
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
    }

    const userId = getUserId(req);

    const item = await withTransaction(async (session) => {
      const opts = { session };
      const prevAvail = Number(rawMaterial.available_quantity || 0);

      const [created] = await RawMaterialStock.create(
        [
          {
            raw_material_id,
            desc: desc ?? "",
            quantity: qty,
            price: prc,
            total_price: totalPrice,
            purpose: 1,
            isDeleted: false,
          },
        ],
        opts,
      );

      const updated = await adjustRawMaterial(
        raw_material_id,
        { inDelta: qty, availDelta: qty },
        session,
      );

      await Supplier.findByIdAndUpdate(
        rawMaterial.supplier_id,
        { $inc: { total_amount: totalPrice, payable: totalPrice } },
        opts,
      );

      if (rm_store_location_id) {
        await creditRmStoreOnPurchase({
          rmStoreLocationId: rm_store_location_id,
          rawMaterialId: raw_material_id,
          quantity: qty,
          referenceType: "RawMaterialStock",
          referenceId: created._id,
          userId,
          notes: desc || "Raw material purchase",
          session,
        });
      }

      await writeLedger(
        {
          transactionType: TX.RAW_MATERIAL_STOCK_IN,
          direction: DIR.IN,
          rawMaterialId: raw_material_id,
          quantity: qty,
          referenceType: "RawMaterialStock",
          referenceId: created._id,
          userId,
          notes: desc || "Raw material purchase",
          previousBalance: prevAvail,
          newBalance: Number(updated?.available_quantity ?? prevAvail + qty),
        },
        session,
      );

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
      500,
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

    const { raw_material_id, desc, quantity, price, total_price } = req.body;
    const userId = getUserId(req);

    const oldTotalPrice = oldItem.total_price || 0;
    const oldRawMaterial = await RawMaterial.findById(
      oldItem.raw_material_id,
    ).where({ isDeleted: false });
    if (oldRawMaterial) {
      await Supplier.findByIdAndUpdate(oldRawMaterial.supplier_id, {
        $inc: { total_amount: -oldTotalPrice, payable: -oldTotalPrice },
      });
      await adjustRawMaterial(oldItem.raw_material_id, {
        inDelta: -oldItem.quantity,
        availDelta: -oldItem.quantity,
      });
    }

    const qty = Number(quantity ?? oldItem.quantity ?? 0);
    if (!qty || qty <= 0) {
      return createError(res, 400, "quantity must be greater than 0.");
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

    const prevAvail = await getRawMaterialAvailable(newRawMaterialId);

    const item = await RawMaterialStock.findByIdAndUpdate(
      req.params.id,
      {
        raw_material_id: newRawMaterialId,
        desc: desc !== undefined ? desc : oldItem.desc,
        quantity: qty,
        price: prc,
        total_price: newTotalPrice,
        isDeleted: false,
      },
      { new: true, runValidators: true },
    );

    await Supplier.findByIdAndUpdate(newRawMaterial.supplier_id, {
      $inc: { total_amount: newTotalPrice, payable: newTotalPrice },
    });

    const updated = await adjustRawMaterial(newRawMaterialId, {
      inDelta: qty,
      availDelta: qty,
    });

    await writeLedger({
      transactionType: TX.ADJUSTMENT,
      direction: DIR.IN,
      rawMaterialId: newRawMaterialId,
      quantity: qty,
      referenceType: "RawMaterialStock",
      referenceId: item._id,
      userId,
      notes: "Purchase stock entry updated",
      previousBalance: prevAvail,
      newBalance: Number(updated?.available_quantity ?? prevAvail + qty),
    });

    await writeAudit({
      entityType: "RawMaterialStock",
      entityId: item._id,
      action: "update",
      previousValue: oldItem.toObject?.() ?? oldItem,
      newValue: item.toObject?.() ?? item,
      userId,
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
      500,
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
    const rawMaterial = await RawMaterial.findById(item.raw_material_id).where({
      isDeleted: false,
    });

    if (rawMaterial) {
      await Supplier.findByIdAndUpdate(rawMaterial.supplier_id, {
        $inc: { total_amount: -totalPrice, payable: -totalPrice },
      });
      const prevAvail = Number(rawMaterial.available_quantity || 0);
      const updated = await adjustRawMaterial(item.raw_material_id, {
        inDelta: -item.quantity,
        availDelta: -item.quantity,
      });
      await writeLedger({
        transactionType: TX.ADJUSTMENT,
        direction: DIR.OUT,
        rawMaterialId: item.raw_material_id,
        quantity: item.quantity,
        referenceType: "RawMaterialStock",
        referenceId: item._id,
        userId,
        notes: "Purchase stock entry deleted",
        previousBalance: prevAvail,
        newBalance: Number(updated?.available_quantity ?? prevAvail - item.quantity),
      });
    }

    const deleted = await RawMaterialStock.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true },
    );

    await writeAudit({
      entityType: "RawMaterialStock",
      entityId: item._id,
      action: "delete",
      previousValue: item.toObject?.() ?? item,
      userId,
    });

    return successMessage(
      res,
      deleted || item,
      "Raw material stock deleted successfully.",
    );
  } catch (err) {
    console.error("RawMaterialStock remove error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to delete raw material stock.",
    );
  }
};

const createProduction = async (req, res) => {
  try {
    const { raw_material_id, desc, quantity, price, total_price } = req.body;
    if (!raw_material_id) {
      return createError(res, 400, "raw_material_id is required.");
    }
    const qty = Number(quantity ?? 0);
    if (!qty || qty <= 0) {
      return createError(res, 400, "quantity must be greater than 0.");
    }
    const prc = Number(price ?? 0);
    const totalPrice = total_price != null ? Number(total_price) : qty * prc;
    const userId = getUserId(req);

    const rawMaterial = await RawMaterial.findById(raw_material_id).where({
      isDeleted: false,
    });
    if (!rawMaterial) {
      return createError(res, 404, "Raw material not found.");
    }
    const available = Number(rawMaterial.available_quantity || 0);
    if (qty > available) {
      return createError(
        res,
        409,
        `Insufficient stock. Available: ${available}, requested: ${qty}.`,
      );
    }

    const item = await RawMaterialStock.create({
      raw_material_id,
      desc: desc ?? "",
      quantity: qty,
      price: prc,
      total_price: totalPrice,
      purpose: 2,
      isDeleted: false,
    });

    const updated = await adjustRawMaterial(raw_material_id, {
      outDelta: qty,
      availDelta: -qty,
    });

    await writeLedger({
      transactionType: TX.RAW_MATERIAL_ALLOCATION,
      direction: DIR.OUT,
      rawMaterialId: raw_material_id,
      quantity: qty,
      referenceType: "RawMaterialStock",
      referenceId: item._id,
      userId,
      notes: desc || "Manual production allocation",
      previousBalance: available,
      newBalance: Number(updated?.available_quantity ?? available - qty),
    });

    await writeAudit({
      entityType: "RawMaterialStock",
      entityId: item._id,
      action: "create",
      newValue: item.toObject?.() ?? item,
      userId,
      notes: "Production allocation",
    });

    return successMessage(
      res,
      item,
      "Production stock allocation created successfully.",
    );
  } catch (err) {
    console.error("RawMaterialStock createProduction error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to create production allocation.",
    );
  }
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
      newBalance: Number(updated?.available_quantity ?? prevAvail + item.quantity),
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
