const ProductStoreReceipt = require("../Models/ProductStoreReceipt");
const Product = require("../Models/Products");
const DispatchLocation = require("../Models/DispatchLocation");
const { createError, successMessage } = require("../utils/ResponseMessage");
const {
  LOCATION_TYPE,
  getUserId,
  writeAudit,
  executeStoreReceipt,
  reverseStoreReceipt,
  withTransaction,
} = require("../Services/inventoryService");

const populateRefs = (q) =>
  q
    .populate("product_id")
    .populate("from_location_id")
    .populate("to_location_id")
    .populate("created_by", "name email")
    .populate("cake_production_id");

const list = async (req, res) => {
  try {
    const filter = { isDeleted: false };
    if (req.query.start_date || req.query.end_date) {
      filter.receipt_date = {};
      if (req.query.start_date) filter.receipt_date.$gte = new Date(req.query.start_date);
      if (req.query.end_date) filter.receipt_date.$lte = new Date(req.query.end_date);
    }
    if (req.query.product_id) filter.product_id = req.query.product_id;
    if (req.query.to_location_id) filter.to_location_id = req.query.to_location_id;

    const items = await populateRefs(
      ProductStoreReceipt.find(filter).sort({ receipt_date: -1, createdAt: -1 }),
    );
    const deletedItems = await populateRefs(
      ProductStoreReceipt.find({ isDeleted: true }).sort({ receipt_date: -1 }),
    );

    return successMessage(
      res,
      { items, deletedItems },
      "Store receipts fetched successfully.",
    );
  } catch (err) {
    console.error("ProductStoreReceipt list error:", err);
    return createError(res, 500, err.message || "Failed to fetch store receipts.");
  }
};

const getOne = async (req, res) => {
  try {
    const item = await populateRefs(
      ProductStoreReceipt.findById(req.params.id).where({ isDeleted: false }),
    );
    if (!item) return createError(res, 404, "Store receipt not found.");
    return successMessage(res, item, "Store receipt fetched successfully.");
  } catch (err) {
    console.error("ProductStoreReceipt getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch store receipt.");
  }
};

const create = async (req, res) => {
  try {
    const {
      from_location_id,
      to_location_id,
      product_id,
      quantity,
      receipt_date,
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
    if (!receipt_date) {
      return createError(res, 400, "receipt_date is required.");
    }

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return createError(res, 400, "quantity must be greater than 0.");
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

    if (fromType !== LOCATION_TYPE.PRODUCTION_AREA) {
      return createError(
        res,
        400,
        "From location must be a production area.",
      );
    }
    if (toType !== LOCATION_TYPE.FINISHED_GOODS_STORE) {
      return createError(
        res,
        400,
        "To location must be a main store (finished goods). Add one under Stores & Locations.",
      );
    }

    const userId = getUserId(req);

    const item = await withTransaction(async (session) => {
      const receipt = await executeStoreReceipt({
        fromLocationId: from_location_id,
        toLocationId: to_location_id,
        productId: product_id,
        quantity: qty,
        receiptDate: receipt_date,
        userId,
        notes: notes ?? "",
        session,
      });

      await writeAudit({
        entityType: "ProductStoreReceipt",
        entityId: receipt._id,
        action: "create",
        newValue: receipt.toObject?.() ?? receipt,
        userId,
        session,
      });

      return receipt;
    });

    const populated = await populateRefs(ProductStoreReceipt.findById(item._id));
    return successMessage(
      res,
      populated || item,
      "Products received into main store successfully.",
    );
  } catch (err) {
    console.error("ProductStoreReceipt create error:", err);
    return createError(res, err.status || 500, err.message || "Failed to create store receipt.");
  }
};

const remove = async (req, res) => {
  try {
    const existing = await ProductStoreReceipt.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!existing) return createError(res, 404, "Store receipt not found.");

    if (existing.cake_production_id) {
      return createError(
        res,
        400,
        "Auto receipts from cake production cannot be reversed here. Edit or delete the production entry instead.",
      );
    }

    const userId = getUserId(req);

    const item = await withTransaction(async (session) => {
      return reverseStoreReceipt(existing._id, userId, session, {
        restoreToProduction: true,
      });
    });

    return successMessage(res, item, "Store receipt reversed successfully.");
  } catch (err) {
    console.error("ProductStoreReceipt remove error:", err);
    return createError(res, err.status || 500, err.message || "Failed to reverse store receipt.");
  }
};

module.exports = { list, getOne, create, remove };
