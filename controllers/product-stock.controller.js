const ProductStock = require("../Models/ProductStock");
const Product = require("../Models/Products");
const RawMaterial = require("../Models/RawMaterial");
const { createError, successMessage } = require("../utils/ResponseMessage");
const {
  TX,
  DIR,
  getUserId,
  writeAudit,
  writeLedger,
  getRawMaterialAvailable,
  adjustRawMaterial,
  adjustProduct,
  withTransaction,
} = require("../Services/inventoryService");

async function applyRawMaterialUsage(rawMaterialsUsed, multiplier = 1, userId = null, referenceId = null, session = null) {
  if (!Array.isArray(rawMaterialsUsed)) return;
  for (const rm of rawMaterialsUsed) {
    if (!rm.raw_material_id || rm.quantity_used == null) continue;
    const qty = Number(rm.quantity_used) * multiplier;
    if (qty <= 0) continue;

    const prevAvail = await getRawMaterialAvailable(rm.raw_material_id, session);
    if (multiplier > 0 && qty > prevAvail) {
      const material = await RawMaterial.findById(rm.raw_material_id);
      const err = new Error(
        `Insufficient ${material?.name || "raw material"} stock. Available: ${prevAvail}, required: ${qty}.`,
      );
      err.status = 409;
      throw err;
    }

    const updated = await adjustRawMaterial(
      rm.raw_material_id,
      { outDelta: qty, availDelta: -qty },
      session,
    );

    if (multiplier > 0) {
      await writeLedger(
        {
          transactionType: TX.RAW_MATERIAL_CONSUMPTION,
          direction: DIR.OUT,
          rawMaterialId: rm.raw_material_id,
          quantity: qty,
          referenceType: "ProductStock",
          referenceId,
          userId,
          notes: "Raw material used in product stock entry",
          previousBalance: prevAvail,
          newBalance: Number(updated?.available_quantity ?? prevAvail - qty),
        },
        session,
      );
    } else {
      await writeLedger(
        {
          transactionType: TX.ADJUSTMENT,
          direction: DIR.IN,
          rawMaterialId: rm.raw_material_id,
          quantity: Math.abs(qty),
          referenceType: "ProductStock",
          referenceId,
          userId,
          notes: "Reversed raw material usage from product stock entry",
          previousBalance: prevAvail,
          newBalance: Number(updated?.available_quantity ?? prevAvail + Math.abs(qty)),
        },
        session,
      );
    }
  }
}

const list = async (req, res) => {
  try {
    const filter = { isDeleted: false };
    if (req.query.product_id) filter.product_id = req.query.product_id;

    const items = await ProductStock.find(filter)
      .populate("product_id")
      .populate("location_id")
      .populate("raw_materials_used.raw_material_id")
      .sort({ createdAt: -1 });
    const deletedItems = await ProductStock.find({ isDeleted: true })
      .populate("product_id")
      .populate("location_id")
      .populate("raw_materials_used.raw_material_id")
      .sort({ createdAt: -1 });
    return successMessage(
      res,
      { items, deletedItems },
      "Product stock entries fetched successfully.",
    );
  } catch (err) {
    console.error("ProductStock list error:", err);
    return createError(res, 500, err.message || "Failed to fetch product stock.");
  }
};

const getOne = async (req, res) => {
  try {
    const item = await ProductStock.findById(req.params.id)
      .populate("product_id")
      .populate("location_id")
      .populate("raw_materials_used.raw_material_id")
      .where({ isDeleted: false });
    if (!item) return createError(res, 404, "Product stock entry not found.");
    return successMessage(res, item, "Product stock fetched successfully.");
  } catch (err) {
    console.error("ProductStock getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch product stock.");
  }
};

const create = async (req, res) => {
  try {
    const { product_id, desc, quantity, price, total_price, raw_materials_used, location_id, inventory_type } =
      req.body;
    if (!product_id) {
      return createError(res, 400, "product_id is required.");
    }
    const qty = Number(quantity ?? 0);
    if (qty <= 0) {
      return createError(res, 400, "quantity must be greater than 0.");
    }
    const product = await Product.findById(product_id).where({ isDeleted: false });
    if (!product) return createError(res, 404, "Product not found.");

    const userId = getUserId(req);
    const rmUsed = Array.isArray(raw_materials_used) ? raw_materials_used : [];

    const item = await withTransaction(async (session) => {
      const opts = { session };

      const [created] = await ProductStock.create(
        [
          {
            product_id,
            desc: desc ?? "",
            quantity: qty,
            price: price ?? 0,
            total_price: total_price ?? qty * (price ?? 0),
            raw_materials_used: rmUsed,
            location_id: location_id || null,
            inventory_type: inventory_type ?? 1,
            isDeleted: false,
          },
        ],
        opts,
      );

      await applyRawMaterialUsage(rmUsed, 1, userId, created._id, session);

      const prevProdAvail = Number(product.available_quantity || 0);
      const updatedProduct = await adjustProduct(
        product_id,
        { inDelta: qty, availDelta: qty },
        session,
      );

      await writeLedger(
        {
          transactionType: TX.PRODUCT_STOCK_IN,
          direction: DIR.IN,
          productId: product_id,
          quantity: qty,
          locationId: location_id || null,
          referenceType: "ProductStock",
          referenceId: created._id,
          userId,
          notes: desc || "Manual product stock-in",
          previousBalance: prevProdAvail,
          newBalance: Number(updatedProduct?.available_quantity ?? prevProdAvail + qty),
        },
        session,
      );

      await writeAudit({
        entityType: "ProductStock",
        entityId: created._id,
        action: "create",
        newValue: created.toObject?.() ?? created,
        userId,
        session,
      });

      return created;
    });

    return successMessage(res, item, "Product stock entry created successfully.");
  } catch (err) {
    console.error("ProductStock create error:", err);
    return createError(res, err.status || 500, err.message || "Failed to create product stock.");
  }
};

const update = async (req, res) => {
  try {
    const { product_id, desc, quantity, price, total_price, raw_materials_used, location_id, inventory_type } =
      req.body;
    const oldItem = await ProductStock.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!oldItem) return createError(res, 404, "Product stock entry not found.");

    const userId = getUserId(req);
    const oldQty = Number(oldItem.quantity ?? 0);
    const newQty = quantity != null ? Number(quantity) : oldQty;
    if (newQty <= 0) {
      return createError(res, 400, "quantity must be greater than 0.");
    }
    const newProductId = product_id ?? oldItem.product_id;

    await applyRawMaterialUsage(oldItem.raw_materials_used || [], -1, userId, oldItem._id);

    await adjustProduct(oldItem.product_id, {
      inDelta: -oldQty,
      availDelta: -oldQty,
    });

    const updatePayload = {
      product_id: newProductId,
      desc: desc !== undefined ? desc : oldItem.desc,
      quantity: newQty,
      price: price !== undefined ? price : oldItem.price,
      total_price:
        total_price !== undefined
          ? total_price
          : newQty * (price ?? oldItem.price ?? 0),
      isDeleted: false,
    };
    if (Array.isArray(raw_materials_used)) {
      updatePayload.raw_materials_used = raw_materials_used;
    }
    if (location_id !== undefined) updatePayload.location_id = location_id || null;
    if (inventory_type !== undefined) updatePayload.inventory_type = inventory_type;

    const item = await ProductStock.findByIdAndUpdate(
      req.params.id,
      updatePayload,
      { new: true, runValidators: true },
    );

    const rmUsed = updatePayload.raw_materials_used ?? oldItem.raw_materials_used ?? [];
    await applyRawMaterialUsage(rmUsed, 1, userId, item._id);

    const updatedProduct = await adjustProduct(newProductId, {
      inDelta: newQty,
      availDelta: newQty,
    });

    await writeLedger({
      transactionType: TX.ADJUSTMENT,
      direction: DIR.IN,
      productId: newProductId,
      quantity: newQty,
      referenceType: "ProductStock",
      referenceId: item._id,
      userId,
      notes: "Product stock entry updated",
      previousBalance: Number(updatedProduct?.available_quantity ?? 0) - newQty,
      newBalance: Number(updatedProduct?.available_quantity ?? newQty),
    });

    await writeAudit({
      entityType: "ProductStock",
      entityId: item._id,
      action: "update",
      previousValue: oldItem.toObject?.() ?? oldItem,
      newValue: item.toObject?.() ?? item,
      userId,
    });

    return successMessage(res, item, "Product stock updated successfully.");
  } catch (err) {
    console.error("ProductStock update error:", err);
    return createError(res, err.status || 500, err.message || "Failed to update product stock.");
  }
};

const remove = async (req, res) => {
  try {
    const item = await ProductStock.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!item) return createError(res, 404, "Product stock entry not found.");

    const userId = getUserId(req);
    const qty = Number(item.quantity ?? 0);

    await applyRawMaterialUsage(item.raw_materials_used || [], -1, userId, item._id);

    const product = await Product.findById(item.product_id);
    const prevAvail = Number(product?.available_quantity || 0);
    const updatedProduct = await adjustProduct(item.product_id, {
      inDelta: -qty,
      availDelta: -qty,
    });

    const deleted = await ProductStock.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true },
    );

    await writeLedger({
      transactionType: TX.ADJUSTMENT,
      direction: DIR.OUT,
      productId: item.product_id,
      quantity: qty,
      referenceType: "ProductStock",
      referenceId: item._id,
      userId,
      notes: "Product stock entry deleted",
      previousBalance: prevAvail,
      newBalance: Number(updatedProduct?.available_quantity ?? prevAvail - qty),
    });

    await writeAudit({
      entityType: "ProductStock",
      entityId: item._id,
      action: "delete",
      previousValue: item.toObject?.() ?? item,
      userId,
    });

    return successMessage(res, deleted || item, "Product stock deleted successfully.");
  } catch (err) {
    console.error("ProductStock remove error:", err);
    return createError(res, err.status || 500, err.message || "Failed to delete product stock.");
  }
};

module.exports = { list, getOne, create, update, remove };
