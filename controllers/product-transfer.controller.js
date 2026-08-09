const crypto = require("crypto");
const ProductTransfer = require("../Models/ProductTransfer");
const { TRANSFER_STATUS } = require("../Models/ProductTransfer");
const Product = require("../Models/Products");
const DispatchLocation = require("../Models/DispatchLocation");
const { createError, successMessage } = require("../utils/ResponseMessage");
const {
  TX,
  DIR,
  LOCATION_TYPE,
  getUserId,
  writeAudit,
  writeLedger,
  adjustLocationInventory,
  getLocationInventoryQty,
  getInventoryTypeForLocation,
  withTransaction,
} = require("../Services/inventoryService");
const {
  assertRmManagerStoreAccess,
  applyStoreLocationFilter,
} = require("../utils/storeScope");

const populateRefs = (q) =>
  q
    .populate("product_id")
    .populate("from_location_id")
    .populate("to_location_id")
    .populate("created_by", "name email");

const generateTransferCode = () => {
  const rand = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `PT-${rand}`;
};

const list = async (req, res) => {
  try {
    const filter = { isDeleted: false };
    if (req.query.start_date || req.query.end_date) {
      filter.transfer_date = {};
      if (req.query.start_date)
        filter.transfer_date.$gte = new Date(req.query.start_date);
      if (req.query.end_date)
        filter.transfer_date.$lte = new Date(req.query.end_date);
    }
    if (req.query.product_id) filter.product_id = req.query.product_id;
    if (req.query.to_location_id) filter.to_location_id = req.query.to_location_id;
    if (req.query.status != null && req.query.status !== "") {
      filter.status = Number(req.query.status);
    }
    if (req.query.transfer_code) {
      filter.transfer_code = String(req.query.transfer_code).trim().toUpperCase();
    }

    const scopedFilter = await applyStoreLocationFilter(
      req,
      filter,
      "from_location_id",
    );

    const items = await populateRefs(
      ProductTransfer.find(scopedFilter).sort({
        transfer_date: -1,
        createdAt: -1,
      }),
    );
    const deletedItems = await populateRefs(
      ProductTransfer.find({ ...scopedFilter, isDeleted: true }).sort({
        transfer_date: -1,
      }),
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

/**
 * Create transfer batch:
 * - Debit Product Store only (stock in transit)
 * - Do NOT credit shop yet
 * - Return shared transfer_code barcode for shop receive
 */
const create = async (req, res) => {
  try {
    const body = req.body || {};
    const transfer_date = body.transfer_date;
    const notes = body.notes ?? "";
    const from_location_id = body.from_location_id;

    let lines = Array.isArray(body.lines) ? body.lines : null;
    if (!lines) {
      if (body.to_location_id && body.product_id) {
        lines = [
          {
            to_location_id: body.to_location_id,
            product_id: body.product_id,
            quantity: body.quantity,
          },
        ];
      } else {
        lines = [];
      }
    }

    if (!from_location_id) {
      return createError(res, 400, "from_location_id (Product Store) is required.");
    }
    if (!transfer_date) {
      return createError(res, 400, "transfer_date is required.");
    }
    if (!lines.length) {
      return createError(res, 400, "Add at least one shop transfer line.");
    }

    const fromLoc = await DispatchLocation.findById(from_location_id).where({
      isDeleted: false,
    });
    if (!fromLoc) return createError(res, 404, "From location not found.");

    const fromType = Number(
      fromLoc.location_type || LOCATION_TYPE.PRODUCTION_AREA,
    );
    if (fromType !== LOCATION_TYPE.FINISHED_GOODS_STORE) {
      return createError(
        res,
        400,
        "From location must be a Product Store (finished goods).",
      );
    }

    const normalized = [];
    for (let i = 0; i < lines.length; i++) {
      const row = lines[i] || {};
      const toId = row.to_location_id;
      const productId = row.product_id;
      const qty = Number(row.quantity);
      if (!toId || !productId) {
        return createError(
          res,
          400,
          `Line ${i + 1}: shop and product are required.`,
        );
      }
      if (String(from_location_id) === String(toId)) {
        return createError(res, 400, `Line ${i + 1}: from and to must differ.`);
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        return createError(
          res,
          400,
          `Line ${i + 1}: quantity must be greater than 0.`,
        );
      }
      normalized.push({
        to_location_id: toId,
        product_id: productId,
        quantity: qty,
      });
    }

    const neededByProduct = new Map();
    for (const row of normalized) {
      const key = String(row.product_id);
      neededByProduct.set(key, (neededByProduct.get(key) || 0) + row.quantity);
    }

    const shopIds = [
      ...new Set(normalized.map((r) => String(r.to_location_id))),
    ];
    const productIds = [...neededByProduct.keys()];

    const [shops, products] = await Promise.all([
      DispatchLocation.find({
        _id: { $in: shopIds },
        isDeleted: false,
      }),
      Product.find({ _id: { $in: productIds }, isDeleted: false }),
    ]);

    const shopMap = new Map(shops.map((s) => [String(s._id), s]));
    const productMap = new Map(products.map((p) => [String(p._id), p]));

    for (const id of shopIds) {
      const shop = shopMap.get(id);
      if (!shop) return createError(res, 404, `Shop not found (${id}).`);
      if (Number(shop.location_type) !== LOCATION_TYPE.SHOP) {
        return createError(res, 400, `"${shop.name}" is not a shop.`);
      }
    }
    for (const id of productIds) {
      if (!productMap.has(id)) {
        return createError(res, 404, `Product not found (${id}).`);
      }
    }

    await assertRmManagerStoreAccess(req, [from_location_id, ...shopIds]);

    const fromInvType = getInventoryTypeForLocation(fromType);

    for (const [productId, needQty] of neededByProduct.entries()) {
      const available = await getLocationInventoryQty(
        from_location_id,
        productId,
        fromInvType,
      );
      if (needQty > available) {
        const product = productMap.get(productId);
        return createError(
          res,
          409,
          `Insufficient stock of "${product?.name || productId}" at ${fromLoc.name}. Available: ${available}, requested: ${needQty}.`,
        );
      }
    }

    const userId = getUserId(req);
    const transfer_code = generateTransferCode();

    const createdIds = await withTransaction(async (session) => {
      const ids = [];
      const remaining = new Map();
      for (const [productId] of neededByProduct.entries()) {
        const available = await getLocationInventoryQty(
          from_location_id,
          productId,
          fromInvType,
          session,
        );
        remaining.set(productId, available);
      }

      for (const row of normalized) {
        const toLoc = shopMap.get(String(row.to_location_id));
        const productId = row.product_id;
        const qty = row.quantity;
        const prevFrom = remaining.get(String(productId)) ?? 0;

        // Only leave Product Store — shop credit happens on barcode receive
        await adjustLocationInventory(
          from_location_id,
          productId,
          -qty,
          fromInvType,
          session,
        );
        remaining.set(String(productId), prevFrom - qty);

        const [item] = await ProductTransfer.create(
          [
            {
              from_location_id,
              to_location_id: row.to_location_id,
              product_id: productId,
              quantity: qty,
              transfer_date: new Date(transfer_date),
              notes: notes ?? "",
              transfer_code,
              status: TRANSFER_STATUS.PENDING,
              created_by: userId,
              isDeleted: false,
            },
          ],
          { session },
        );

        await writeLedger(
          {
            transactionType: TX.SHOP_TRANSFER,
            direction: DIR.OUT,
            productId,
            quantity: qty,
            locationId: from_location_id,
            storeId: fromLoc.store_id,
            referenceType: "ProductTransfer",
            referenceId: item._id,
            userId,
            notes: `Transfer out (in transit) → ${toLoc.name} [${transfer_code}]`,
            previousBalance: prevFrom,
            newBalance: prevFrom - qty,
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

        ids.push(item._id);
      }
      return ids;
    });

    const populatedResult = await populateRefs(
      ProductTransfer.find({ _id: { $in: createdIds } }),
    );

    return successMessage(
      res,
      {
        items: populatedResult,
        count: createdIds.length,
        transfer_code,
        status: TRANSFER_STATUS.PENDING,
      },
      createdIds.length > 1
        ? `${createdIds.length} lines dispatched. Shop barcode: ${transfer_code}`
        : `Transfer dispatched. Shop barcode: ${transfer_code}`,
    );
  } catch (err) {
    console.error("ProductTransfer create error:", err);
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to create transfer.",
    );
  }
};

/**
 * Reverse a transfer.
 * - Pending: return qty to Product Store only
 * - Received: reverse shop + Product Store
 */
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

    const fromType = Number(
      fromLoc?.location_type || LOCATION_TYPE.PRODUCTION_AREA,
    );
    const toType = Number(toLoc?.location_type || LOCATION_TYPE.PRODUCTION_AREA);
    const fromInvType = getInventoryTypeForLocation(fromType);
    const toInvType = getInventoryTypeForLocation(toType);
    const status = Number(existing.status || TRANSFER_STATUS.RECEIVED);

    const item = await withTransaction(async (session) => {
      const qty = Number(existing.quantity || 0);

      if (status === TRANSFER_STATUS.RECEIVED) {
        await adjustLocationInventory(
          existing.to_location_id,
          existing.product_id,
          -qty,
          toInvType,
          session,
        );
      }

      await adjustLocationInventory(
        existing.from_location_id,
        existing.product_id,
        qty,
        fromInvType,
        session,
      );

      const deleted = await ProductTransfer.findOneAndUpdate(
        { _id: req.params.id, isDeleted: false },
        { isDeleted: true, status: TRANSFER_STATUS.CANCELLED },
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
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to reverse transfer.",
    );
  }
};

module.exports = {
  list,
  getOne,
  create,
  remove,
  TRANSFER_STATUS,
  generateTransferCode,
};
