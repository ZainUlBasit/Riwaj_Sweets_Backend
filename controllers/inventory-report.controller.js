const ProductTransfer = require("../Models/ProductTransfer");
const ProductStoreReceipt = require("../Models/ProductStoreReceipt");
const LocationInventory = require("../Models/LocationInventory");
const RawMaterial = require("../Models/RawMaterial");
const RawMaterialStock = require("../Models/RawMaterialStock");
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

    const detailRows = await CakeProduction.find(match)
      .populate("product_id", "name unit")
      .populate("location_id", "name location_type store_id")
      .populate({
        path: "store_receipt_id",
        populate: { path: "to_location_id", select: "name" },
      })
      .sort({ production_date: -1, createdAt: -1 })
      .limit(500)
      .lean();

    const items = detailRows.map((row) => ({
      _id: row._id,
      production_date: row.production_date,
      productionArea:
        row.location_id?.name ?? row.location ?? "Unassigned",
      productName: row.product_id?.name ?? "Unknown",
      quantity: row.cakes_produced,
      storedAt:
        row.store_receipt_id?.to_location_id?.name ??
        (row.location_id ? `${row.location_id.name} (area)` : "—"),
      notes: row.notes || "",
    }));

    return successMessage(
      res,
      { byLocation, byProduct: totals, items },
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
          quantity: { $gt: 0 },
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

/**
 * GET /api/inventory-reports/shop-stock
 * Current finished goods at shop locations (location_type = 3).
 */
const shopStock = async (req, res) => {
  try {
    const rows = await LocationInventory.aggregate([
      { $match: { isDeleted: false, inventory_type: INV_TYPE.SHOP } },
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
          "location.location_type": LOCATION_TYPE.SHOP,
          "location.isDeleted": false,
          quantity: { $gt: 0 },
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

    return successMessage(res, { items: rows }, "Shop stock fetched.");
  } catch (err) {
    console.error("InventoryReport shopStock error:", err);
    return createError(res, 500, err.message || "Failed to fetch shop stock.");
  }
};

/**
 * GET /api/inventory-reports/location-rm-stock
 * Remaining raw material balances at RM stores / production areas.
 * Query: location_id? (optional — all locations if omitted)
 */
const locationRmStock = async (req, res) => {
  try {
    const LocationRawMaterialInventory = require("../Models/LocationRawMaterialInventory");
    const DispatchLocation = require("../Models/DispatchLocation");
    const {
      assertRmManagerStoreAccess,
      getAssignedStoreId,
    } = require("../utils/storeScope");

    const filter = { isDeleted: false };
    if (req.query.location_id) {
      filter.location_id = req.query.location_id;
      try {
        await assertRmManagerStoreAccess(req, [req.query.location_id]);
      } catch (err) {
        return createError(res, err.status || 403, err.message);
      }
    } else {
      const locFilter = {
        isDeleted: false,
        location_type: {
          $in: [LOCATION_TYPE.RAW_MATERIAL_STORE, LOCATION_TYPE.PRODUCTION_AREA],
        },
      };
      const storeId = getAssignedStoreId(req);
      let locations;
      if (storeId) {
        // Own godown production areas + system-wide RM Store
        locations = await DispatchLocation.find({
          isDeleted: false,
          $or: [
            { location_type: LOCATION_TYPE.RAW_MATERIAL_STORE },
            {
              store_id: storeId,
              location_type: LOCATION_TYPE.PRODUCTION_AREA,
            },
          ],
        }).select("_id");
      } else {
        locations = await DispatchLocation.find(locFilter).select("_id");
      }
      filter.location_id = { $in: locations.map((l) => l._id) };
    }

    const rows = await LocationRawMaterialInventory.find(filter)
      .populate("raw_material_id")
      .populate("location_id")
      .sort({ updatedAt: -1 });

    const items = rows.map((row) => ({
      _id: row._id,
      location_id: row.location_id,
      location_name: row.location_id?.name || "",
      location_type: row.location_id?.location_type,
      raw_material_id: row.raw_material_id,
      raw_material_name: row.raw_material_id?.name || "",
      unit: row.raw_material_id?.unit,
      quantity: Number(row.quantity || 0),
      updatedAt: row.updatedAt,
    }));

    return successMessage(
      res,
      { items },
      "Location raw material stock fetched.",
    );
  } catch (err) {
    console.error("InventoryReport locationRmStock error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to fetch location RM stock.",
    );
  }
};

/**
 * POST /api/inventory-reports/rm-wastage
 * RM Manager records wastage/spoilage at a location.
 * Body: { location_id, raw_material_id, quantity, notes? }
 */
const recordWastage = async (req, res) => {
  try {
    const { location_id, raw_material_id, quantity, notes } = req.body || {};
    const {
      recordRmWastage,
      getUserId,
      withTransaction,
    } = require("../Services/inventoryService");
    const { assertRmManagerStoreAccess } = require("../utils/storeScope");

    if (!location_id || !raw_material_id) {
      return createError(res, 400, "location_id and raw_material_id are required.");
    }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return createError(res, 400, "quantity must be greater than 0.");
    }

    try {
      await assertRmManagerStoreAccess(req, [location_id]);
    } catch (err) {
      return createError(res, err.status || 403, err.message);
    }

    const result = await withTransaction(async (session) =>
      recordRmWastage({
        locationId: location_id,
        rawMaterialId: raw_material_id,
        quantity: qty,
        notes,
        userId: getUserId(req),
        session,
      }),
    );

    return successMessage(res, result, "RM wastage recorded successfully.");
  } catch (err) {
    console.error("InventoryReport recordWastage error:", err);
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to record wastage.",
    );
  }
};

/**
 * GET /api/inventory-reports/daily-ops?start_date=&end_date=
 * Unified day-wise: RM purchased, dispatched to production, produced FG, wastage, shop transfers.
 */
const dailyOpsReport = async (req, res) => {
  try {
    const { start_date, end_date } = req.query || {};
    if (!start_date || !end_date) {
      return createError(res, 400, "start_date and end_date are required.");
    }

    const start = new Date(start_date);
    const end = new Date(end_date);
    end.setHours(23, 59, 59, 999);

    const dayKey = (d) => {
      const x = new Date(d);
      return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
    };

    const map = new Map();
    const ensure = (key) => {
      if (!map.has(key)) {
        map.set(key, {
          date: key,
          rm_purchased: 0,
          rm_dispatched: 0,
          rm_consumed: 0,
          rm_wastage: 0,
          products_produced: 0,
          shop_transfers: 0,
          purchase_lines: [],
          dispatch_lines: [],
          production_lines: [],
          transfer_lines: [],
          wastage_lines: [],
        });
      }
      return map.get(key);
    };

    const [purchases, dispatches, productions, transfers, wastageLedger] =
      await Promise.all([
        RawMaterialStock.find({
          isDeleted: false,
          purpose: 1,
          createdAt: { $gte: start, $lte: end },
        })
          .populate("raw_material_id", "name unit")
          .populate("rm_store_location_id", "name")
          .lean(),
        RawMaterialDispatch.find({
          isDeleted: false,
          dispatch_date: { $gte: start, $lte: end },
        })
          .populate("raw_material_id", "name unit")
          .populate("from_location_id", "name")
          .populate("location_id", "name")
          .lean(),
        CakeProduction.find({
          isDeleted: false,
          production_date: { $gte: start, $lte: end },
        })
          .populate("product_id", "name")
          .populate("location_id", "name")
          .lean(),
        ProductTransfer.find({
          isDeleted: false,
          transfer_date: { $gte: start, $lte: end },
        })
          .populate("product_id", "name")
          .populate("from_location_id", "name")
          .populate("to_location_id", "name")
          .lean(),
        InventoryLedger.find({
          isDeleted: false,
          transaction_type: TX.RAW_MATERIAL_WASTAGE,
          createdAt: { $gte: start, $lte: end },
        })
          .populate("raw_material_id", "name unit")
          .populate("location_id", "name")
          .lean(),
      ]);

    for (const row of purchases) {
      const key = dayKey(row.createdAt);
      const day = ensure(key);
      const qty = Number(row.quantity || 0);
      day.rm_purchased += qty;
      day.purchase_lines.push({
        material: row.raw_material_id?.name ?? "—",
        quantity: qty,
        rm_store: row.rm_store_location_id?.name ?? "—",
      });
    }

    for (const row of dispatches) {
      const key = dayKey(row.dispatch_date);
      const day = ensure(key);
      const qty = Number(row.quantity || 0);
      day.rm_dispatched += qty;
      day.dispatch_lines.push({
        material: row.raw_material_id?.name ?? "—",
        quantity: qty,
        from: row.from_location_id?.name ?? "—",
        to: row.location_id?.name ?? row.location ?? "—",
      });
    }

    for (const row of productions) {
      const key = dayKey(row.production_date);
      const day = ensure(key);
      const qty = Number(row.cakes_produced || 0);
      day.products_produced += qty;
      const consumed = (row.raw_materials_consumed || []).reduce(
        (s, c) => s + Number(c.quantity || 0),
        0,
      );
      day.rm_consumed += consumed;
      day.production_lines.push({
        product: row.product_id?.name ?? "—",
        quantity: qty,
        area: row.location_id?.name ?? row.location ?? "—",
        rm_consumed: consumed,
      });
    }

    for (const row of transfers) {
      const key = dayKey(row.transfer_date);
      const day = ensure(key);
      const qty = Number(row.quantity || 0);
      day.shop_transfers += qty;
      day.transfer_lines.push({
        product: row.product_id?.name ?? "—",
        quantity: qty,
        from: row.from_location_id?.name ?? "—",
        to: row.to_location_id?.name ?? "—",
      });
    }

    for (const row of wastageLedger) {
      const key = dayKey(row.createdAt);
      const day = ensure(key);
      const qty = Number(row.quantity || 0);
      day.rm_wastage += qty;
      day.wastage_lines.push({
        material: row.raw_material_id?.name ?? "—",
        quantity: qty,
        location: row.location_id?.name ?? "—",
        notes: row.notes || "",
      });
    }

    const days = Array.from(map.values()).sort((a, b) =>
      a.date < b.date ? 1 : -1,
    );

    const summary = days.reduce(
      (acc, d) => {
        acc.rm_purchased += d.rm_purchased;
        acc.rm_dispatched += d.rm_dispatched;
        acc.rm_consumed += d.rm_consumed;
        acc.rm_wastage += d.rm_wastage;
        acc.products_produced += d.products_produced;
        acc.shop_transfers += d.shop_transfers;
        return acc;
      },
      {
        rm_purchased: 0,
        rm_dispatched: 0,
        rm_consumed: 0,
        rm_wastage: 0,
        products_produced: 0,
        shop_transfers: 0,
      },
    );

    return successMessage(
      res,
      { summary, days, start_date, end_date },
      "Daily operations report fetched.",
    );
  } catch (err) {
    console.error("InventoryReport dailyOpsReport error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to fetch daily operations report.",
    );
  }
};

/**
 * GET /api/inventory-reports/production-area?start_date=&end_date=&location_id=
 * Per production area: RM received (dispatch) + products produced + RM consumed + RM wastage.
 */
const productionAreaReport = async (req, res) => {
  try {
    const { start_date, end_date, location_id } = req.query || {};
    if (!start_date || !end_date) {
      return createError(res, 400, "start_date and end_date are required.");
    }

    const start = new Date(start_date);
    const end = new Date(end_date);
    end.setHours(23, 59, 59, 999);

    const DispatchLocation = require("../Models/DispatchLocation");
    const LocationRawMaterialInventory = require("../Models/LocationRawMaterialInventory");

    const areaFilter = {
      location_type: LOCATION_TYPE.PRODUCTION_AREA,
      isDeleted: false,
    };
    if (location_id) areaFilter._id = location_id;

    const areas = await DispatchLocation.find(areaFilter)
      .select("name store_id location_type")
      .sort({ name: 1 })
      .lean();

    if (!areas.length) {
      return successMessage(
        res,
        { areas: [], start_date, end_date },
        "No production areas found.",
      );
    }

    const areaIds = areas.map((a) => a._id);

    const [dispatches, productions, rmStock, wastageRows] = await Promise.all([
      RawMaterialDispatch.find({
        isDeleted: false,
        location_id: { $in: areaIds },
        dispatch_date: { $gte: start, $lte: end },
      })
        .populate("raw_material_id", "name unit")
        .populate("from_location_id", "name")
        .lean(),
      CakeProduction.find({
        isDeleted: false,
        location_id: { $in: areaIds },
        production_date: { $gte: start, $lte: end },
      })
        .populate("product_id", "name")
        .populate({
          path: "raw_materials_consumed.raw_material_id",
          select: "name unit",
        })
        .lean(),
      LocationRawMaterialInventory.find({
        location_id: { $in: areaIds },
        isDeleted: false,
        quantity: { $gt: 0 },
      })
        .populate("raw_material_id", "name unit")
        .lean(),
      InventoryLedger.find({
        isDeleted: false,
        transaction_type: TX.RAW_MATERIAL_WASTAGE,
        location_id: { $in: areaIds },
        createdAt: { $gte: start, $lte: end },
      })
        .populate("raw_material_id", "name unit")
        .lean(),
    ]);

    const byArea = areas.map((area) => {
      const id = String(area._id);
      const areaDispatches = dispatches.filter(
        (d) => String(d.location_id) === id,
      );
      const areaProductions = productions.filter(
        (p) => String(p.location_id) === id,
      );
      const areaStock = rmStock.filter((s) => String(s.location_id) === id);
      const areaWastage = wastageRows.filter(
        (w) => String(w.location_id) === id,
      );

      const rmReceivedByMaterial = new Map();
      for (const d of areaDispatches) {
        const rmId = String(d.raw_material_id?._id ?? d.raw_material_id);
        const name = d.raw_material_id?.name ?? "—";
        const unit = d.raw_material_id?.unit ?? null;
        const qty = Number(d.quantity || 0);
        const prev = rmReceivedByMaterial.get(rmId) || {
          raw_material_id: rmId,
          name,
          unit,
          quantity: 0,
        };
        prev.quantity += qty;
        rmReceivedByMaterial.set(rmId, prev);
      }

      const rmConsumedByMaterial = new Map();
      let totalProduced = 0;
      const production_lines = areaProductions.map((p) => {
        const qty = Number(p.cakes_produced || 0);
        totalProduced += qty;
        let consumed = 0;
        for (const row of p.raw_materials_consumed || []) {
          const rmId = String(
            row.raw_material_id?._id ?? row.raw_material_id ?? "",
          );
          const cQty = Number(row.quantity || 0);
          consumed += cQty;
          if (!rmId) continue;
          const name = row.raw_material_id?.name ?? "—";
          const unit = row.raw_material_id?.unit ?? null;
          const prev = rmConsumedByMaterial.get(rmId) || {
            raw_material_id: rmId,
            name,
            unit,
            quantity: 0,
          };
          prev.quantity += cQty;
          rmConsumedByMaterial.set(rmId, prev);
        }
        return {
          _id: p._id,
          production_date: p.production_date,
          product: p.product_id?.name ?? "—",
          quantity: qty,
          rm_consumed: Math.round(consumed * 1000) / 1000,
          notes: p.notes || "",
        };
      });

      const rmWastageByMaterial = new Map();
      const wastage_lines = areaWastage.map((w) => {
        const rmId = String(w.raw_material_id?._id ?? w.raw_material_id ?? "");
        const name = w.raw_material_id?.name ?? "—";
        const unit = w.raw_material_id?.unit ?? null;
        const qty = Number(w.quantity || 0);
        if (rmId) {
          const prev = rmWastageByMaterial.get(rmId) || {
            raw_material_id: rmId,
            name,
            unit,
            quantity: 0,
          };
          prev.quantity += qty;
          rmWastageByMaterial.set(rmId, prev);
        }
        return {
          _id: w._id,
          wastage_date: w.createdAt,
          material: name,
          unit,
          quantity: qty,
          notes: w.notes || "",
        };
      });

      const dispatch_lines = areaDispatches.map((d) => ({
        _id: d._id,
        dispatch_date: d.dispatch_date,
        material: d.raw_material_id?.name ?? "—",
        unit: d.raw_material_id?.unit ?? null,
        quantity: Number(d.quantity || 0),
        from: d.from_location_id?.name ?? "—",
        notes: d.notes || "",
      }));

      const remaining_rm = areaStock.map((s) => ({
        raw_material_id: s.raw_material_id?._id ?? s.raw_material_id,
        name: s.raw_material_id?.name ?? "—",
        unit: s.raw_material_id?.unit ?? null,
        quantity: Number(s.quantity || 0),
      }));

      const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

      return {
        location_id: area._id,
        location_name: area.name,
        summary: {
          rm_received: round3(
            [...rmReceivedByMaterial.values()].reduce(
              (s, r) => s + r.quantity,
              0,
            ),
          ),
          rm_consumed: round3(
            [...rmConsumedByMaterial.values()].reduce(
              (s, r) => s + r.quantity,
              0,
            ),
          ),
          rm_wastage: round3(
            [...rmWastageByMaterial.values()].reduce(
              (s, r) => s + r.quantity,
              0,
            ),
          ),
          products_produced: round3(totalProduced),
          dispatch_count: areaDispatches.length,
          production_count: areaProductions.length,
          wastage_count: areaWastage.length,
        },
        rm_received: [...rmReceivedByMaterial.values()].map((r) => ({
          ...r,
          quantity: round3(r.quantity),
        })),
        rm_consumed: [...rmConsumedByMaterial.values()].map((r) => ({
          ...r,
          quantity: round3(r.quantity),
        })),
        rm_wastage: [...rmWastageByMaterial.values()].map((r) => ({
          ...r,
          quantity: round3(r.quantity),
        })),
        remaining_rm,
        dispatch_lines,
        production_lines,
        wastage_lines,
      };
    });

    // Drop areas with zero activity in range unless specifically filtered
    const filtered = location_id
      ? byArea
      : byArea.filter(
          (a) =>
            a.summary.dispatch_count > 0 ||
            a.summary.production_count > 0 ||
            a.summary.wastage_count > 0,
        );

    const totals = filtered.reduce(
      (acc, a) => {
        acc.rm_received += a.summary.rm_received;
        acc.rm_consumed += a.summary.rm_consumed;
        acc.rm_wastage += a.summary.rm_wastage;
        acc.products_produced += a.summary.products_produced;
        return acc;
      },
      { rm_received: 0, rm_consumed: 0, rm_wastage: 0, products_produced: 0 },
    );

    return successMessage(
      res,
      {
        start_date,
        end_date,
        totals,
        areas: filtered,
      },
      "Production area report fetched.",
    );
  } catch (err) {
    console.error("InventoryReport productionAreaReport error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to fetch production area report.",
    );
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
  shopStock,
  rmDispatchReport,
  locationRmStock,
  recordWastage,
  dailyOpsReport,
  productionAreaReport,
};
