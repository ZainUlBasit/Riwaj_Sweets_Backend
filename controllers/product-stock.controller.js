const ProductStock = require("../Models/ProductStock");
const Product = require("../Models/Products");
const RawMaterial = require("../Models/RawMaterial");
const Supplier = require("../Models/Supplier");
const DispatchLocation = require("../Models/DispatchLocation");
const InventoryLedger = require("../Models/InventoryLedger");
const { createError, successMessage } = require("../utils/ResponseMessage");
const {
  TX,
  DIR,
  INV_TYPE,
  LOCATION_TYPE,
  getUserId,
  writeAudit,
  writeLedger,
  getRawMaterialAvailable,
  adjustRawMaterial,
  adjustProduct,
  adjustLocationInventory,
  getLocationInventoryQty,
  withTransaction,
} = require("../Services/inventoryService");

const STOCK_SOURCE = { SELF_PRODUCTION: 1, SUPPLIER: 2 };

async function resolveProductStoreLocation(locationId, session = null) {
  if (!locationId) {
    const err = new Error("Product Store (location_id) is required.");
    err.status = 400;
    throw err;
  }
  const q = DispatchLocation.findById(locationId).where({ isDeleted: false });
  if (session) q.session(session);
  const loc = await q;
  if (!loc) {
    const err = new Error("Product Store location not found.");
    err.status = 404;
    throw err;
  }
  if (Number(loc.location_type) !== LOCATION_TYPE.FINISHED_GOODS_STORE) {
    const err = new Error("location_id must be a Product Store.");
    err.status = 400;
    throw err;
  }
  return loc;
}

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
      .populate("supplier_id")
      .populate("raw_materials_used.raw_material_id")
      .sort({ createdAt: -1 });
    const deletedItems = await ProductStock.find({ isDeleted: true })
      .populate("product_id")
      .populate("location_id")
      .populate("supplier_id")
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
    const {
      product_id,
      desc,
      quantity,
      price,
      total_price,
      raw_materials_used,
      location_id,
      source,
      supplier_id,
    } = req.body;
    if (!product_id) {
      return createError(res, 400, "product_id is required.");
    }
    const qty = Number(quantity ?? 0);
    if (qty <= 0) {
      return createError(res, 400, "quantity must be greater than 0.");
    }

    const sourceNum = Number(source ?? STOCK_SOURCE.SELF_PRODUCTION);
    if (
      sourceNum !== STOCK_SOURCE.SELF_PRODUCTION &&
      sourceNum !== STOCK_SOURCE.SUPPLIER
    ) {
      return createError(
        res,
        400,
        "source must be 1 (Self Production) or 2 (Supplier).",
      );
    }
    if (sourceNum === STOCK_SOURCE.SUPPLIER && !supplier_id) {
      return createError(
        res,
        400,
        "supplier_id is required when source is Supplier.",
      );
    }

    const product = await Product.findById(product_id).where({
      isDeleted: false,
    });
    if (!product) return createError(res, 404, "Product not found.");

    let supplier = null;
    if (sourceNum === STOCK_SOURCE.SUPPLIER) {
      supplier = await Supplier.findById(supplier_id).where({
        isDeleted: false,
      });
      if (!supplier) return createError(res, 404, "Supplier not found.");
    }

    const storeLoc = await resolveProductStoreLocation(location_id);
    const userId = getUserId(req);
    const rmUsed = Array.isArray(raw_materials_used) ? raw_materials_used : [];
    const unitPrice = Number(price ?? 0);
    const totalPrice =
      total_price != null ? Number(total_price) : qty * unitPrice;
    const sourceLabel =
      sourceNum === STOCK_SOURCE.SUPPLIER
        ? `Supplier: ${supplier.name}`
        : "Self Production";
    const notes =
      desc?.trim() ||
      `Product Store stock-in (${sourceLabel}) → ${storeLoc.name}`;

    const item = await withTransaction(async (session) => {
      const opts = { session };

      const [created] = await ProductStock.create(
        [
          {
            product_id,
            desc: desc ?? "",
            quantity: qty,
            price: unitPrice,
            total_price: totalPrice,
            raw_materials_used: rmUsed,
            location_id: storeLoc._id,
            inventory_type: INV_TYPE.STORE,
            source: sourceNum,
            supplier_id:
              sourceNum === STOCK_SOURCE.SUPPLIER ? supplier._id : null,
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

      const prevStoreQty = await getLocationInventoryQty(
        storeLoc._id,
        product_id,
        INV_TYPE.STORE,
        session,
      );
      await adjustLocationInventory(
        storeLoc._id,
        product_id,
        qty,
        INV_TYPE.STORE,
        session,
      );

      if (sourceNum === STOCK_SOURCE.SUPPLIER && totalPrice > 0) {
        await Supplier.findByIdAndUpdate(
          supplier._id,
          { $inc: { total_amount: totalPrice, payable: totalPrice } },
          opts,
        );
      }

      await writeLedger(
        {
          transactionType: TX.PRODUCT_STOCK_IN,
          direction: DIR.IN,
          productId: product_id,
          quantity: qty,
          locationId: storeLoc._id,
          storeId: storeLoc.store_id ?? null,
          referenceType: "ProductStock",
          referenceId: created._id,
          userId,
          notes,
          previousBalance: prevStoreQty,
          newBalance: prevStoreQty + qty,
        },
        session,
      );

      await writeAudit({
        entityType: "ProductStock",
        entityId: created._id,
        action: "create",
        newValue: created.toObject?.() ?? created,
        userId,
        notes: `Product totals: ${prevProdAvail} → ${Number(updatedProduct?.available_quantity ?? prevProdAvail + qty)}. ${notes}`,
        session,
      });

      return created;
    });

    const populated = await ProductStock.findById(item._id)
      .populate("product_id")
      .populate("location_id")
      .populate("supplier_id");

    return successMessage(
      res,
      populated || item,
      "Product stock added to Product Store.",
    );
  } catch (err) {
    console.error("ProductStock create error:", err);
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to create product stock.",
    );
  }
};

const update = async (req, res) => {
  try {
    const {
      product_id,
      desc,
      quantity,
      price,
      total_price,
      raw_materials_used,
      location_id,
      source,
      supplier_id,
    } = req.body;

    const oldItem = await ProductStock.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!oldItem) return createError(res, 404, "Product stock entry not found.");

    const newQty = quantity != null ? Number(quantity) : Number(oldItem.quantity ?? 0);
    if (newQty <= 0) {
      return createError(res, 400, "quantity must be greater than 0.");
    }

    const sourceNum = Number(
      source != null ? source : oldItem.source ?? STOCK_SOURCE.SELF_PRODUCTION,
    );
    if (
      sourceNum !== STOCK_SOURCE.SELF_PRODUCTION &&
      sourceNum !== STOCK_SOURCE.SUPPLIER
    ) {
      return createError(
        res,
        400,
        "source must be 1 (Self Production) or 2 (Supplier).",
      );
    }

    const finalSupplierId =
      sourceNum === STOCK_SOURCE.SUPPLIER
        ? supplier_id !== undefined
          ? supplier_id
          : oldItem.supplier_id
        : null;

    if (sourceNum === STOCK_SOURCE.SUPPLIER && !finalSupplierId) {
      return createError(
        res,
        400,
        "supplier_id is required when source is Supplier.",
      );
    }

    const newProductId = product_id ?? oldItem.product_id;
    const product = await Product.findById(newProductId).where({
      isDeleted: false,
    });
    if (!product) return createError(res, 404, "Product not found.");

    let supplier = null;
    if (sourceNum === STOCK_SOURCE.SUPPLIER) {
      supplier = await Supplier.findById(finalSupplierId).where({
        isDeleted: false,
      });
      if (!supplier) return createError(res, 404, "Supplier not found.");
    }

    const finalLocationId =
      location_id !== undefined ? location_id : oldItem.location_id;
    const storeLoc = await resolveProductStoreLocation(finalLocationId);

    const userId = getUserId(req);
    const oldQty = Number(oldItem.quantity ?? 0);
    const oldTotal = Number(oldItem.total_price ?? 0);
    const unitPrice =
      price !== undefined ? Number(price) : Number(oldItem.price ?? 0);
    const totalPrice =
      total_price !== undefined ? Number(total_price) : newQty * unitPrice;
    const sourceLabel =
      sourceNum === STOCK_SOURCE.SUPPLIER
        ? `Supplier: ${supplier.name}`
        : "Self Production";
    const notes =
      (desc !== undefined ? desc : oldItem.desc)?.trim() ||
      `Product Store stock update (${sourceLabel}) → ${storeLoc.name}`;

    const item = await withTransaction(async (session) => {
      const opts = { session };

      await applyRawMaterialUsage(
        oldItem.raw_materials_used || [],
        -1,
        userId,
        oldItem._id,
        session,
      );

      await adjustProduct(
        oldItem.product_id,
        { inDelta: -oldQty, availDelta: -oldQty },
        session,
      );

      // Reverse old Product Store balance
      if (oldItem.location_id && oldQty > 0) {
        const oldInvType = Number(oldItem.inventory_type) || INV_TYPE.STORE;
        await adjustLocationInventory(
          oldItem.location_id,
          oldItem.product_id,
          -oldQty,
          oldInvType,
          session,
        );
      }

      // Reverse old supplier payable if it was a supplier purchase
      if (
        Number(oldItem.source) === STOCK_SOURCE.SUPPLIER &&
        oldItem.supplier_id &&
        oldTotal > 0
      ) {
        await Supplier.findByIdAndUpdate(
          oldItem.supplier_id,
          { $inc: { total_amount: -oldTotal, payable: -oldTotal } },
          opts,
        );
      }

      const updatePayload = {
        product_id: newProductId,
        desc: desc !== undefined ? desc : oldItem.desc,
        quantity: newQty,
        price: unitPrice,
        total_price: totalPrice,
        location_id: storeLoc._id,
        inventory_type: INV_TYPE.STORE,
        source: sourceNum,
        supplier_id:
          sourceNum === STOCK_SOURCE.SUPPLIER ? supplier._id : null,
        isDeleted: false,
      };
      if (Array.isArray(raw_materials_used)) {
        updatePayload.raw_materials_used = raw_materials_used;
      }

      const updated = await ProductStock.findByIdAndUpdate(
        req.params.id,
        updatePayload,
        { new: true, runValidators: true, session },
      );

      const rmUsed =
        updatePayload.raw_materials_used ??
        oldItem.raw_materials_used ??
        [];
      await applyRawMaterialUsage(rmUsed, 1, userId, updated._id, session);

      const updatedProduct = await adjustProduct(
        newProductId,
        { inDelta: newQty, availDelta: newQty },
        session,
      );

      const prevStoreQty = await getLocationInventoryQty(
        storeLoc._id,
        newProductId,
        INV_TYPE.STORE,
        session,
      );
      await adjustLocationInventory(
        storeLoc._id,
        newProductId,
        newQty,
        INV_TYPE.STORE,
        session,
      );

      if (sourceNum === STOCK_SOURCE.SUPPLIER && totalPrice > 0) {
        await Supplier.findByIdAndUpdate(
          supplier._id,
          { $inc: { total_amount: totalPrice, payable: totalPrice } },
          opts,
        );
      }

      await writeLedger(
        {
          transactionType: TX.ADJUSTMENT,
          direction: DIR.IN,
          productId: newProductId,
          quantity: newQty,
          locationId: storeLoc._id,
          storeId: storeLoc.store_id ?? null,
          referenceType: "ProductStock",
          referenceId: updated._id,
          userId,
          notes,
          previousBalance: prevStoreQty,
          newBalance: prevStoreQty + newQty,
        },
        session,
      );

      await writeAudit({
        entityType: "ProductStock",
        entityId: updated._id,
        action: "update",
        previousValue: oldItem.toObject?.() ?? oldItem,
        newValue: updated.toObject?.() ?? updated,
        userId,
        notes: `Product totals after update: ${Number(updatedProduct?.available_quantity ?? 0)}. ${notes}`,
        session,
      });

      return updated;
    });

    const populated = await ProductStock.findById(item._id)
      .populate("product_id")
      .populate("location_id")
      .populate("supplier_id");

    return successMessage(
      res,
      populated || item,
      "Product stock updated successfully.",
    );
  } catch (err) {
    console.error("ProductStock update error:", err);
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to update product stock.",
    );
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
    const totalPrice = Number(item.total_price ?? 0);

    const deleted = await withTransaction(async (session) => {
      const opts = { session };

      await applyRawMaterialUsage(
        item.raw_materials_used || [],
        -1,
        userId,
        item._id,
        session,
      );

      const product = await Product.findById(item.product_id).session(session);
      const prevAvail = Number(product?.available_quantity || 0);
      const updatedProduct = await adjustProduct(
        item.product_id,
        { inDelta: -qty, availDelta: -qty },
        session,
      );

      if (item.location_id && qty > 0) {
        const invType = Number(item.inventory_type) || INV_TYPE.STORE;
        const prevLoc = await getLocationInventoryQty(
          item.location_id,
          item.product_id,
          invType,
          session,
        );
        await adjustLocationInventory(
          item.location_id,
          item.product_id,
          -qty,
          invType,
          session,
        );
        await writeLedger(
          {
            transactionType: TX.ADJUSTMENT,
            direction: DIR.OUT,
            productId: item.product_id,
            quantity: qty,
            locationId: item.location_id,
            referenceType: "ProductStock",
            referenceId: item._id,
            userId,
            notes: "Product stock entry deleted (location reverse)",
            previousBalance: prevLoc,
            newBalance: prevLoc - qty,
          },
          session,
        );
      }

      if (
        Number(item.source) === STOCK_SOURCE.SUPPLIER &&
        item.supplier_id &&
        totalPrice > 0
      ) {
        await Supplier.findByIdAndUpdate(
          item.supplier_id,
          { $inc: { total_amount: -totalPrice, payable: -totalPrice } },
          opts,
        );
      }

      const softDeleted = await ProductStock.findOneAndUpdate(
        { _id: req.params.id, isDeleted: false },
        { isDeleted: true },
        { new: true, session },
      );

      await writeLedger(
        {
          transactionType: TX.ADJUSTMENT,
          direction: DIR.OUT,
          productId: item.product_id,
          quantity: qty,
          locationId: item.location_id || null,
          referenceType: "ProductStock",
          referenceId: item._id,
          userId,
          notes: "Product stock entry deleted",
          previousBalance: prevAvail,
          newBalance: Number(
            updatedProduct?.available_quantity ?? prevAvail - qty,
          ),
        },
        session,
      );

      await writeAudit({
        entityType: "ProductStock",
        entityId: softDeleted._id,
        action: "delete",
        previousValue: item.toObject?.() ?? item,
        userId,
        session,
      });

      return softDeleted;
    });

    return successMessage(
      res,
      deleted,
      "Product stock deleted — Product Store + Product qty restored (supplier payable bhi agar tha).",
    );
  } catch (err) {
    console.error("ProductStock remove error:", err);
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to delete product stock.",
    );
  }
};

/**
 * GET /api/product-stock/logs
 * InventoryLedger rows for Product Store qty movements (direct stock-in, etc.).
 * Does not change stock — read-only audit trail.
 */
const listLogs = async (req, res) => {
  try {
    const { product_id, location_id, start_date, end_date } = req.query || {};
    const limit = Math.min(Number(req.query.limit) || 200, 500);

    const filter = {
      isDeleted: false,
      product_id: { $ne: null },
      transaction_type: {
        $in: [TX.PRODUCT_STOCK_IN, TX.STORE_RECEIPT, TX.ADJUSTMENT, TX.SHOP_TRANSFER],
      },
    };
    if (product_id) filter.product_id = product_id;
    if (location_id) filter.location_id = location_id;
    if (start_date || end_date) {
      filter.createdAt = {};
      if (start_date) filter.createdAt.$gte = new Date(start_date);
      if (end_date) filter.createdAt.$lte = new Date(end_date);
    }

    const items = await InventoryLedger.find(filter)
      .populate("product_id", "name unit id")
      .populate("location_id", "name location_type")
      .populate("user_id", "name email")
      .sort({ createdAt: -1 })
      .limit(limit);

    return successMessage(
      res,
      { items },
      "Product Store qty logs fetched.",
    );
  } catch (err) {
    console.error("ProductStock listLogs error:", err);
    return createError(res, 500, err.message || "Failed to fetch stock logs.");
  }
};

module.exports = { list, getOne, create, update, remove, listLogs };
