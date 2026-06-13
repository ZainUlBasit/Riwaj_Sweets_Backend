const ProductTransfer = require("../Models/ProductTransfer");
const Product = require("../Models/Products");
const DispatchLocation = require("../Models/DispatchLocation");
const { createError, successMessage } = require("../utils/ResponseMessage");
const {
  TX,
  DIR,
  INV_TYPE,
  LOCATION_TYPE,
  getUserId,
  writeAudit,
  writeLedger,
  adjustLocationInventory,
  getLocationInventoryQty,
  withTransaction,
} = require("../Services/inventoryService");

const populateRefs = (q) =>
  q
    .populate("product_id")
    .populate("from_location_id")
    .populate("to_location_id")
    .populate("created_by", "name email");

const list = async (req, res) => {
  try {
    const filter = { isDeleted: false };
    if (req.query.start_date || req.query.end_date) {
      filter.transfer_date = {};
      if (req.query.start_date) filter.transfer_date.$gte = new Date(req.query.start_date);
      if (req.query.end_date) filter.transfer_date.$lte = new Date(req.query.end_date);
    }
    if (req.query.product_id) filter.product_id = req.query.product_id;
    if (req.query.to_location_id) filter.to_location_id = req.query.to_location_id;

    const items = await populateRefs(
      ProductTransfer.find(filter).sort({ transfer_date: -1, createdAt: -1 }),
    );
    const deletedItems = await populateRefs(
      ProductTransfer.find({ isDeleted: true }).sort({ transfer_date: -1 }),
    );

    return successMessage(
      res,
      { items, deletedItems },
      "Product transfers fetched successfully.",
    );
  } catch (err) {
    console.error("ProductTransfer list error:", err);
    return createError(res, 500, err.message || "Failed to fetch transfers.");
  }
};

const getOne = async (req, res) => {
  try {
    const item = await populateRefs(
      ProductTransfer.findById(req.params.id).where({ isDeleted: false }),
    );
    if (!item) return createError(res, 404, "Transfer not found.");
    return successMessage(res, item, "Transfer fetched successfully.");
  } catch (err) {
    console.error("ProductTransfer getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch transfer.");
  }
};

const create = async (req, res) => {
  try {
    const {
      from_location_id,
      to_location_id,
      product_id,
      quantity,
      transfer_date,
      notes,
    } = req.body || {};

    if (!from_location_id || !to_location_id || !product_id) {
      return createError(
        res,
        400,
        "from_location_id, to_location_id and product_id are required.",
      );
    }
    if (String(from_location_id) === String(to_location_id)) {
      return createError(res, 400, "From and to locations must be different.");
    }

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return createError(res, 400, "quantity must be greater than 0.");
    }
    if (!transfer_date) {
      return createError(res, 400, "transfer_date is required.");
    }

    const [fromLoc, toLoc, product] = await Promise.all([
      DispatchLocation.findById(from_location_id).where({ isDeleted: false }),
      DispatchLocation.findById(to_location_id).where({ isDeleted: false }),
      Product.findById(product_id).where({ isDeleted: false }),
    ]);

    if (!fromLoc) return createError(res, 404, "From location not found.");
    if (!toLoc) return createError(res, 404, "To location not found.");
    if (!product) return createError(res, 404, "Product not found.");

    const fromType = Number(fromLoc.location_type || LOCATION_TYPE.PRODUCTION_AREA);
    const toType = Number(toLoc.location_type || LOCATION_TYPE.PRODUCTION_AREA);

    const fromInvType =
      fromType === LOCATION_TYPE.SHOP ? INV_TYPE.SHOP : INV_TYPE.PRODUCTION;
    const toInvType =
      toType === LOCATION_TYPE.SHOP ? INV_TYPE.SHOP : INV_TYPE.PRODUCTION;

    const availableAtFrom = await getLocationInventoryQty(
      from_location_id,
      product_id,
      fromInvType,
    );
    if (qty > availableAtFrom) {
      return createError(
        res,
        409,
        `Insufficient production inventory at ${fromLoc.name}. Available: ${availableAtFrom}, requested: ${qty}.`,
      );
    }

    const userId = getUserId(req);

    const populated = await withTransaction(async (session) => {
      const opts = { session };

      await adjustLocationInventory(
        from_location_id,
        product_id,
        -qty,
        fromInvType,
        session,
      );
      await adjustLocationInventory(
        to_location_id,
        product_id,
        qty,
        toInvType,
        session,
      );

      const [item] = await ProductTransfer.create(
        [
          {
            from_location_id,
            to_location_id,
            product_id,
            quantity: qty,
            transfer_date: new Date(transfer_date),
            notes: notes ?? "",
            created_by: userId,
            isDeleted: false,
          },
        ],
        opts,
      );

      await writeLedger(
        {
          transactionType: TX.SHOP_TRANSFER,
          direction: DIR.OUT,
          productId: product_id,
          quantity: qty,
          locationId: from_location_id,
          storeId: fromLoc.store_id,
          referenceType: "ProductTransfer",
          referenceId: item._id,
          userId,
          notes: `Transfer out → ${toLoc.name}`,
          previousBalance: availableAtFrom,
          newBalance: availableAtFrom - qty,
        },
        session,
      );

      const toPrev = await getLocationInventoryQty(
        to_location_id,
        product_id,
        toInvType,
        session,
      );
      await writeLedger(
        {
          transactionType: TX.SHOP_TRANSFER,
          direction: DIR.IN,
          productId: product_id,
          quantity: qty,
          locationId: to_location_id,
          storeId: toLoc.store_id,
          referenceType: "ProductTransfer",
          referenceId: item._id,
          userId,
          notes: `Transfer in ← ${fromLoc.name}`,
          previousBalance: toPrev - qty,
          newBalance: toPrev,
        },
        session,
      );

      await writeAudit({
        entityType: "ProductTransfer",
        entityId: item._id,
        action: "create",
        newValue: item.toObject?.() ?? item,
        userId,
        session,
      });

      return item;
    });

    const populatedResult = await populateRefs(ProductTransfer.findById(populated._id));
    return successMessage(
      res,
      populatedResult || populated,
      "Product transfer recorded successfully.",
    );
  } catch (err) {
    console.error("ProductTransfer create error:", err);
    return createError(res, err.status || 500, err.message || "Failed to create transfer.");
  }
};

const remove = async (req, res) => {
  try {
    const existing = await ProductTransfer.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!existing) return createError(res, 404, "Transfer not found.");

    const userId = getUserId(req);
    const [fromLoc, toLoc] = await Promise.all([
      DispatchLocation.findById(existing.from_location_id),
      DispatchLocation.findById(existing.to_location_id),
    ]);

    const fromType = Number(fromLoc?.location_type || LOCATION_TYPE.PRODUCTION_AREA);
    const toType = Number(toLoc?.location_type || LOCATION_TYPE.PRODUCTION_AREA);
    const fromInvType =
      fromType === LOCATION_TYPE.SHOP ? INV_TYPE.SHOP : INV_TYPE.PRODUCTION;
    const toInvType =
      toType === LOCATION_TYPE.SHOP ? INV_TYPE.SHOP : INV_TYPE.PRODUCTION;

    const item = await withTransaction(async (session) => {
      const qty = Number(existing.quantity || 0);
      await adjustLocationInventory(
        existing.to_location_id,
        existing.product_id,
        -qty,
        toInvType,
        session,
      );
      await adjustLocationInventory(
        existing.from_location_id,
        existing.product_id,
        qty,
        fromInvType,
        session,
      );

      const deleted = await ProductTransfer.findOneAndUpdate(
        { _id: req.params.id, isDeleted: false },
        { isDeleted: true },
        { new: true, session },
      );

      await writeAudit({
        entityType: "ProductTransfer",
        entityId: deleted._id,
        action: "delete",
        previousValue: existing.toObject?.() ?? existing,
        userId,
        session,
      });

      return deleted;
    });

    return successMessage(res, item, "Transfer reversed successfully.");
  } catch (err) {
    console.error("ProductTransfer remove error:", err);
    return createError(res, err.status || 500, err.message || "Failed to reverse transfer.");
  }
};

module.exports = { list, getOne, create, remove };
