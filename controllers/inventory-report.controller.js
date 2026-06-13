const ProductTransfer = require("../Models/ProductTransfer");
const ProductStoreReceipt = require("../Models/ProductStoreReceipt");
const LocationInventory = require("../Models/LocationInventory");
const RawMaterial = require("../Models/RawMaterial");
const InventoryLedger = require("../Models/InventoryLedger");
const CakeProduction = require("../Models/CakeProduction");
const RawMaterialDispatch = require("../Models/RawMaterialDispatch");
const { createError, successMessage } = require("../utils/ResponseMessage");
const { TX, INV_TYPE, LOCATION_TYPE } = require("../Services/inventoryService");

/**
 * GET /api/inventory-reports/current-stock
 * Raw material current stock with low-stock flag.
 */
const currentStock = async (req, res) => {
  try {
    const lowThreshold = Number(req.query.low_threshold ?? 10);
    const items = await RawMaterial.find({ isDeleted: false })
      .populate("supplier_id")
      .sort({ name: 1 });

    const rows = items.map((rm) => ({
      _id: rm._id,
      name: rm.name,
      unit: rm.unit,
      supplier: rm.supplier_id,
      in_quantity: rm.in_quantity,
      out_quantity: rm.out_quantity,
      available_quantity: rm.available_quantity,
      is_low_stock: Number(rm.available_quantity || 0) <= lowThreshold,
    }));

    return successMessage(
      res,
      { items: rows, low_threshold: lowThreshold },
      "Current raw material stock fetched.",
    );
  } catch (err) {
    console.error("InventoryReport currentStock error:", err);
    return createError(res, 500, err.message || "Failed to fetch current stock.");
  }
};

/**
 * GET /api/inventory-reports/material-ledger?raw_material_id=&start_date=&end_date=
 */
const materialLedger = async (req, res) => {
  try {
    const { raw_material_id, start_date, end_date } = req.query || {};
    const filter = { isDeleted: false };
    if (raw_material_id) filter.raw_material_id = raw_material_id;
    if (start_date || end_date) {
      filter.createdAt = {};
      if (start_date) filter.createdAt.$gte = new Date(start_date);
      if (end_date) filter.createdAt.$lte = new Date(end_date);
    }

    const entries = await InventoryLedger.find(filter)
      .populate("raw_material_id", "name unit")
      .populate("location_id", "name location_type")
      .populate("user_id", "name email")
      .sort({ createdAt: -1 });

    return successMessage(res, { items: entries }, "Material ledger fetched.");
  } catch (err) {
    console.error("InventoryReport materialLedger error:", err);
    return createError(res, 500, err.message || "Failed to fetch material ledger.");
  }
};

/**
 * GET /api/inventory-reports/consumption?start_date=&end_date=
 */
const consumptionReport = async (req, res) => {
  try {
    const { start_date, end_date } = req.query || {};
    const match = {
      isDeleted: false,
      transaction_type: { $in: [TX.RAW_MATERIAL_CONSUMPTION, TX.RAW_MATERIAL_ALLOCATION] },
    };
    if (start_date || end_date) {
      match.createdAt = {};
      if (start_date) match.createdAt.$gte = new Date(start_date);
      if (end_date) match.createdAt.$lte = new Date(end_date);
    }

    const rows = await InventoryLedger.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$raw_material_id",
          total_consumed: { $sum: "$quantity" },
        },
      },
      {
        $lookup: {
          from: "rawmaterials",
          localField: "_id",
          foreignField: "_id",
          as: "material",
        },
      },
      { $unwind: { path: "$material", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          raw_material_id: "$_id",
          name: { $ifNull: ["$material.name", "Unknown"] },
          unit: "$material.unit",
          total_consumed: 1,
        },
      },
      { $sort: { name: 1 } },
    ]);

    return successMessage(res, { items: rows }, "Consumption report fetched.");
  } catch (err) {
    console.error("InventoryReport consumptionReport error:", err);
    return createError(res, 500, err.message || "Failed to fetch consumption report.");
  }
};

/**
 * GET /api/inventory-reports/production?start_date=&end_date=
 */
const productionReport = async (req, res) => {
  try {
    const { start_date, end_date } = req.query || {};
    const match = { isDeleted: false };
    if (start_date || end_date) {
      match.production_date = {};
      if (start_date) match.production_date.$gte = new Date(start_date);
      if (end_date) match.production_date.$lte = new Date(end_date);
    }

    const byLocation = await CakeProduction.aggregate([
      { $match: match },
      {
        $group: {
          _id: { location_id: "$location_id", location: "$location", product_id: "$product_id" },
          totalQuantity: { $sum: "$cakes_produced" },
        },
      },
      {
        $lookup: {
          from: "products",
          localField: "_id.product_id",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          location: { $ifNull: ["$_id.location", "Unassigned"] },
          location_id: "$_id.location_id",
          productName: { $ifNull: ["$product.name", "Unknown"] },
          totalQuantity: 1,
        },
      },
      { $sort: { location: 1, productName: 1 } },
    ]);

    const totals = await CakeProduction.aggregate([
      { $match: match },
      { $group: { _id: "$product_id", totalQuantity: { $sum: "$cakes_produced" } } },
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          productName: { $ifNull: ["$product.name", "Unknown"] },
          totalQuantity: 1,
        },
      },
    ]);

    return successMessage(
      res,
      { byLocation, byProduct: totals },
      "Production report fetched.",
    );
  } catch (err) {
    console.error("InventoryReport productionReport error:", err);
    return createError(res, 500, err.message || "Failed to fetch production report.");
  }
};

/**
 * GET /api/inventory-reports/transfers?start_date=&end_date=
 */
const transferReport = async (req, res) => {
  try {
    const { start_date, end_date } = req.query || {};
    const match = { isDeleted: false };
    if (start_date || end_date) {
      match.transfer_date = {};
      if (start_date) match.transfer_date.$gte = new Date(start_date);
      if (end_date) match.transfer_date.$lte = new Date(end_date);
    }

    const byShop = await ProductTransfer.aggregate([
      { $match: match },
      {
        $group: {
          _id: { to_location_id: "$to_location_id", product_id: "$product_id" },
          totalQuantity: { $sum: "$quantity" },
        },
      },
      {
        $lookup: {
          from: "dispatchlocations",
          localField: "_id.to_location_id",
          foreignField: "_id",
          as: "shop",
        },
      },
      {
        $lookup: {
          from: "products",
          localField: "_id.product_id",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: { path: "$shop", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          shopName: { $ifNull: ["$shop.name", "Unknown"] },
          productName: { $ifNull: ["$product.name", "Unknown"] },
          totalQuantity: 1,
        },
      },
      { $sort: { shopName: 1, productName: 1 } },
    ]);

    const byProduct = await ProductTransfer.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$product_id",
          totalQuantity: { $sum: "$quantity" },
        },
      },
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          productName: { $ifNull: ["$product.name", "Unknown"] },
          totalQuantity: 1,
        },
      },
    ]);

    return successMessage(
      res,
      { byShop, byProduct },
      "Transfer report fetched.",
    );
  } catch (err) {
    console.error("InventoryReport transferReport error:", err);
    return createError(res, 500, err.message || "Failed to fetch transfer report.");
  }
};

/**
 * GET /api/inventory-reports/store-receipts?start_date=&end_date=
 */
const storeReceiptReport = async (req, res) => {
  try {
    const { start_date, end_date } = req.query || {};
    const match = { isDeleted: false };
    if (start_date || end_date) {
      match.receipt_date = {};
      if (start_date) match.receipt_date.$gte = new Date(start_date);
      if (end_date) match.receipt_date.$lte = new Date(end_date);
    }

    const byStore = await ProductStoreReceipt.aggregate([
      { $match: match },
      {
        $group: {
          _id: { to_location_id: "$to_location_id", product_id: "$product_id" },
          totalQuantity: { $sum: "$quantity" },
        },
      },
      {
        $lookup: {
          from: "dispatchlocations",
          localField: "_id.to_location_id",
          foreignField: "_id",
          as: "store",
        },
      },
      {
        $lookup: {
          from: "products",
          localField: "_id.product_id",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: { path: "$store", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          storeName: { $ifNull: ["$store.name", "Unknown"] },
          productName: { $ifNull: ["$product.name", "Unknown"] },
          totalQuantity: 1,
        },
      },
      { $sort: { storeName: 1, productName: 1 } },
    ]);

    const byProduct = await ProductStoreReceipt.aggregate([
      { $match: match },
      { $group: { _id: "$product_id", totalQuantity: { $sum: "$quantity" } } },
      {
        $lookup: {
          from: "products",
          localField: "_id",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          productName: { $ifNull: ["$product.name", "Unknown"] },
          totalQuantity: 1,
        },
      },
    ]);

    return successMessage(
      res,
      { byStore, byProduct },
      "Store receipt report fetched.",
    );
  } catch (err) {
    console.error("InventoryReport storeReceiptReport error:", err);
    return createError(res, 500, err.message || "Failed to fetch store receipt report.");
  }
};

/**
 * GET /api/inventory-reports/finished-goods-stock
 * Current finished goods at main stores (location_type = 4).
 */
const finishedGoodsStock = async (req, res) => {
  try {
    const rows = await LocationInventory.aggregate([
      { $match: { isDeleted: false, inventory_type: INV_TYPE.STORE } },
      {
        $lookup: {
          from: "dispatchlocations",
          localField: "location_id",
          foreignField: "_id",
          as: "location",
        },
      },
      {
        $lookup: {
          from: "products",
          localField: "product_id",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: { path: "$location", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      {
        $match: {
          "location.location_type": LOCATION_TYPE.FINISHED_GOODS_STORE,
          "location.isDeleted": false,
        },
      },
      {
        $project: {
          _id: 0,
          locationName: { $ifNull: ["$location.name", "Unknown"] },
          productName: { $ifNull: ["$product.name", "Unknown"] },
          quantity: 1,
        },
      },
      { $sort: { locationName: 1, productName: 1 } },
    ]);

    return successMessage(res, { items: rows }, "Finished goods stock fetched.");
  } catch (err) {
    console.error("InventoryReport finishedGoodsStock error:", err);
    return createError(res, 500, err.message || "Failed to fetch finished goods stock.");
  }
};

/**
 * GET /api/inventory-reports/rm-dispatch?start_date=&end_date=
 * Raw material dispatched from store to production locations.
 */
const rmDispatchReport = async (req, res) => {
  try {
    const { start_date, end_date } = req.query || {};
    const match = { isDeleted: false };
    if (start_date || end_date) {
      match.dispatch_date = {};
      if (start_date) match.dispatch_date.$gte = new Date(start_date);
      if (end_date) match.dispatch_date.$lte = new Date(end_date);
    }

    const byLocation = await RawMaterialDispatch.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            location_id: "$location_id",
            location: "$location",
            raw_material_id: "$raw_material_id",
          },
          totalQuantity: { $sum: "$quantity" },
        },
      },
      {
        $lookup: {
          from: "dispatchlocations",
          localField: "_id.location_id",
          foreignField: "_id",
          as: "loc",
        },
      },
      {
        $lookup: {
          from: "rawmaterials",
          localField: "_id.raw_material_id",
          foreignField: "_id",
          as: "material",
        },
      },
      { $unwind: { path: "$loc", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$material", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          location: {
            $ifNull: ["$loc.name", { $ifNull: ["$_id.location", "Unknown"] }],
          },
          materialName: { $ifNull: ["$material.name", "Unknown"] },
          unit: "$material.unit",
          totalQuantity: 1,
        },
      },
      { $sort: { location: 1, materialName: 1 } },
    ]);

    const byMaterial = await RawMaterialDispatch.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$raw_material_id",
          totalQuantity: { $sum: "$quantity" },
        },
      },
      {
        $lookup: {
          from: "rawmaterials",
          localField: "_id",
          foreignField: "_id",
          as: "material",
        },
      },
      { $unwind: { path: "$material", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          materialName: { $ifNull: ["$material.name", "Unknown"] },
          unit: "$material.unit",
          totalQuantity: 1,
        },
      },
      { $sort: { materialName: 1 } },
    ]);

    const detailItems = await RawMaterialDispatch.find(match)
      .populate("raw_material_id", "name unit")
      .populate("location_id", "name location_type")
      .sort({ dispatch_date: -1, createdAt: -1 })
      .limit(500)
      .lean();

    const items = detailItems.map((row) => ({
      _id: row._id,
      dispatch_date: row.dispatch_date,
      location:
        row.location_id?.name ?? row.location ?? "Unknown",
      materialName: row.raw_material_id?.name ?? "Unknown",
      unit: row.raw_material_id?.unit,
      quantity: row.quantity,
      notes: row.notes || "",
      hasInventoryLink: Boolean(row.generated_stock_id),
    }));

    return successMessage(
      res,
      { byLocation, byMaterial, items },
      "RM dispatch report fetched.",
    );
  } catch (err) {
    console.error("InventoryReport rmDispatchReport error:", err);
    return createError(res, 500, err.message || "Failed to fetch RM dispatch report.");
  }
};

module.exports = {
  currentStock,
  materialLedger,
  consumptionReport,
  productionReport,
  transferReport,
  storeReceiptReport,
  finishedGoodsStock,
  rmDispatchReport,
};
