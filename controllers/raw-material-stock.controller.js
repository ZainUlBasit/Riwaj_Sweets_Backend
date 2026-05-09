const RawMaterialStock = require("../Models/RawMaterialStock");
const RawMaterial = require("../Models/RawMaterial");
const Supplier = require("../Models/Supplier");
const { createError, successMessage } = require("../utils/ResponseMessage");

const list = async (req, res) => {
  try {
    const items = await RawMaterialStock.find({ isDeleted: false })
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
    const { raw_material_id, desc, quantity, price, total_price } = req.body;
    if (!raw_material_id) {
      return createError(res, 400, "raw_material_id is required.");
    }
    const qty = quantity ?? 0;
    const prc = price ?? 0;
    const totalPrice = total_price ?? qty * prc;

    const rawMaterial = await RawMaterial.findById(raw_material_id).where({
      isDeleted: false,
    });
    if (!rawMaterial) {
      return createError(res, 404, "Raw material not found.");
    }

    const item = await RawMaterialStock.create({
      raw_material_id,
      desc: desc ?? "",
      quantity: qty,
      price: prc,
      total_price: totalPrice,
      isDeleted: false,
    });

    // Raw Material bhi increase karo
    await RawMaterial.findByIdAndUpdate(raw_material_id, {
      $inc: { in_quantity: qty, available_quantity: qty },
    });

    // Us raw material ke supplier ka total_amount aur payable increase karo
    await Supplier.findByIdAndUpdate(rawMaterial.supplier_id, {
      $inc: { total_amount: totalPrice, payable: totalPrice },
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
    const { raw_material_id, desc, quantity, price, total_price } = req.body;

    // Purani entry fetch karo (old supplier ko decrement karne ke liye)
    const oldItem = await RawMaterialStock.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!oldItem)
      return createError(res, 404, "Raw material stock entry not found.");

    const oldTotalPrice = oldItem.total_price || 0;
    const oldRawMaterial = await RawMaterial.findById(
      oldItem.raw_material_id,
    ).where({
      isDeleted: false,
    });
    if (oldRawMaterial) {
      await Supplier.findByIdAndUpdate(oldRawMaterial.supplier_id, {
        $inc: { total_amount: -oldTotalPrice, payable: -oldTotalPrice },
      });
    }

    // Naya total_price (body se ya quantity * price)
    const qty = quantity ?? oldItem.quantity ?? 0;
    const prc = price ?? oldItem.price ?? 0;
    const newTotalPrice = total_price ?? qty * prc;

    const newRawMaterialId = raw_material_id ?? oldItem.raw_material_id;
    const newRawMaterial = await RawMaterial.findById(newRawMaterialId).where({
      isDeleted: false,
    });
    if (!newRawMaterial) {
      return createError(res, 404, "Raw material not found.");
    }

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

    // Naye supplier ka total_amount aur payable increase karo (jaise create mein)
    await Supplier.findByIdAndUpdate(newRawMaterial.supplier_id, {
      $inc: { total_amount: newTotalPrice, payable: newTotalPrice },
    });

    // Raw Material bhi increase karo
    await RawMaterial.findByIdAndUpdate(newRawMaterialId, {
      $inc: { in_quantity: qty, available_quantity: qty },
    });
    // Purani raw material bhi decrease karo
    await RawMaterial.findByIdAndUpdate(oldItem.raw_material_id, {
      $inc: {
        in_quantity: -oldItem.quantity,
        available_quantity: -oldItem.quantity,
      },
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

    const totalPrice = item.total_price || 0;
    const rawMaterial = await RawMaterial.findById(item.raw_material_id).where({
      isDeleted: false,
    });
    if (rawMaterial) {
      await Supplier.findByIdAndUpdate(rawMaterial.supplier_id, {
        $inc: { total_amount: -totalPrice, payable: -totalPrice },
      });
    }

    // Raw Material bhi decrease karo
    await RawMaterial.findByIdAndUpdate(item.raw_material_id, {
      $inc: { in_quantity: -item.quantity, available_quantity: -item.quantity },
    });

    // Soft-delete the stock entry. The active-doc filter above guarantees
    // the inventory reversal runs at most once per entry.
    const deleted = await RawMaterialStock.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true }
    );

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

/**
 * POST /api/raw-material-stock/production
 *
 * Allocates raw material to production. Creates a stock entry with
 * `purpose: 2` (production), decrements `available_quantity` and increments
 * `out_quantity` on the parent RawMaterial. Does NOT touch supplier ledgers
 * (production allocation is not a new purchase).
 *
 * The existing `POST /` flow remains the canonical purchase path and is
 * untouched, so this is purely additive.
 *
 * Body: { raw_material_id, quantity, desc?, price?, total_price? }
 */
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

    // Production allocation: out_quantity ↑, available_quantity ↓.
    // No supplier impact (this is not a purchase).
    await RawMaterial.findByIdAndUpdate(raw_material_id, {
      $inc: { out_quantity: qty, available_quantity: -qty },
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

/**
 * DELETE /api/raw-material-stock/production/:id
 *
 * Soft-deletes a production-purpose stock entry and reverses its inventory
 * impact (restores available_quantity, decrements out_quantity). Refuses to
 * touch entries with purpose=1 so the existing remove flow keeps owning
 * purchase reversals.
 */
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

    // Reverse the production allocation against RawMaterial.
    await RawMaterial.findByIdAndUpdate(item.raw_material_id, {
      $inc: { out_quantity: -item.quantity, available_quantity: item.quantity },
    });

    const deleted = await RawMaterialStock.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true },
    );

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
