const mongoose = require("mongoose");
const crypto = require("crypto");
const RawMaterial = require("../Models/RawMaterial");
const RawMaterialStock = require("../Models/RawMaterialStock");
const Product = require("../Models/Products");
const InventoryLedger = require("../Models/InventoryLedger");
const InventoryAuditLog = require("../Models/InventoryAuditLog");
const LocationInventory = require("../Models/LocationInventory");
const LocationRawMaterialInventory = require("../Models/LocationRawMaterialInventory");
const DispatchLocation = require("../Models/DispatchLocation");
const ProductStoreReceipt = require("../Models/ProductStoreReceipt");

const generateStoreReceiptCode = () => {
  const rand = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `PSR-${rand}`;
};

/** Ledger transaction types — must match InventoryLedger schema enum. */
const TX = {
  RAW_MATERIAL_STOCK_IN: 1,
  RAW_MATERIAL_CONSUMPTION: 2,
  PRODUCTION_ENTRY: 3,
  SHOP_TRANSFER: 4,
  RAW_MATERIAL_ALLOCATION: 5,
  PRODUCT_STOCK_IN: 6,
  PRODUCT_SALE: 7,
  ADJUSTMENT: 8,
  STORE_RECEIPT: 9,
  RAW_MATERIAL_DISPATCH: 10,
  RAW_MATERIAL_WASTAGE: 11,
};

const DIR = { IN: 1, OUT: 2 };

const LOCATION_TYPE = {
  RAW_MATERIAL_STORE: 1,
  PRODUCTION_AREA: 2,
  SHOP: 3,
  FINISHED_GOODS_STORE: 4,
};

const INV_TYPE = { PRODUCTION: 1, SHOP: 2, STORE: 3 };

function getInventoryTypeForLocation(locationType) {
  const t = Number(locationType || LOCATION_TYPE.PRODUCTION_AREA);
  if (t === LOCATION_TYPE.SHOP) return INV_TYPE.SHOP;
  if (t === LOCATION_TYPE.FINISHED_GOODS_STORE) return INV_TYPE.STORE;
  return INV_TYPE.PRODUCTION;
}

async function findFinishedGoodsStore(storeId, session = null) {
  if (!storeId) return null;
  const q = DispatchLocation.findOne({
    store_id: storeId,
    location_type: LOCATION_TYPE.FINISHED_GOODS_STORE,
    isDeleted: false,
  });
  if (session) q.session(session);
  return q;
}

async function findProductionArea(storeId, session = null) {
  if (!storeId) return null;
  const q = DispatchLocation.findOne({
    store_id: storeId,
    location_type: LOCATION_TYPE.PRODUCTION_AREA,
    isDeleted: false,
  }).sort({ createdAt: 1 });
  if (session) q.session(session);
  return q;
}

async function findRmStoreForGodown(storeId, session = null) {
  if (!storeId) return null;
  const q = DispatchLocation.findOne({
    store_id: storeId,
    location_type: LOCATION_TYPE.RAW_MATERIAL_STORE,
    isDeleted: false,
  });
  if (session) q.session(session);
  return q;
}

async function getLocationRawMaterialQty(
  locationId,
  rawMaterialId,
  session = null,
) {
  const q = LocationRawMaterialInventory.findOne({
    location_id: locationId,
    raw_material_id: rawMaterialId,
    isDeleted: false,
  });
  if (session) q.session(session);
  const row = await q;
  return row ? Number(row.quantity || 0) : 0;
}

async function adjustLocationRawMaterialInventory(
  locationId,
  rawMaterialId,
  delta,
  session = null,
) {
  const opts = session ? { session } : {};
  const filter = {
    location_id: locationId,
    raw_material_id: rawMaterialId,
    isDeleted: false,
  };
  let row = await LocationRawMaterialInventory.findOne(filter);
  if (session) row = await LocationRawMaterialInventory.findOne(filter).session(session);

  if (!row) {
    if (delta < 0) {
      const err = new Error("Insufficient raw material at this location.");
      err.status = 409;
      throw err;
    }
    const [created] = await LocationRawMaterialInventory.create(
      [
        {
          location_id: locationId,
          raw_material_id: rawMaterialId,
          quantity: delta,
          isDeleted: false,
        },
      ],
      opts,
    );
    return created;
  }

  const nextQty = Number(row.quantity || 0) + delta;
  if (nextQty < 0) {
    const err = new Error(
      `Insufficient raw material at location. Available: ${row.quantity}, requested: ${Math.abs(delta)}.`,
    );
    err.status = 409;
    throw err;
  }

  row.quantity = nextQty;
  if (session) await row.save({ session });
  else await row.save();
  return row;
}

async function validateRmTransferLocations(fromLocationId, toLocationId, session = null) {
  const fromQ = DispatchLocation.findById(fromLocationId).where({ isDeleted: false });
  const toQ = DispatchLocation.findById(toLocationId).where({ isDeleted: false });
  if (session) {
    fromQ.session(session);
    toQ.session(session);
  }
  const [fromLoc, toLoc] = await Promise.all([fromQ, toQ]);
  if (!fromLoc) {
    const err = new Error("RM Store (source) not found.");
    err.status = 404;
    throw err;
  }
  if (!toLoc) {
    const err = new Error("Destination location not found.");
    err.status = 404;
    throw err;
  }
  if (Number(fromLoc.location_type) !== LOCATION_TYPE.RAW_MATERIAL_STORE) {
    const err = new Error("Source must be a Raw Material Store.");
    err.status = 400;
    throw err;
  }
  const allowedDestinationTypes = [
    LOCATION_TYPE.PRODUCTION_AREA,
    LOCATION_TYPE.SHOP,
  ];
  if (!allowedDestinationTypes.includes(Number(toLoc.location_type))) {
    const err = new Error("Destination must be a Production Area or Shop.");
    err.status = 400;
    throw err;
  }
  // Single central RM Store can dispatch to production areas or shops.
  return { fromLoc, toLoc };
}

async function validateRmStoreLocation(locationId, session = null) {
  const q = DispatchLocation.findById(locationId).where({ isDeleted: false });
  if (session) q.session(session);
  const loc = await q;
  if (!loc) {
    const err = new Error("RM Store location not found.");
    err.status = 404;
    throw err;
  }
  if (Number(loc.location_type) !== LOCATION_TYPE.RAW_MATERIAL_STORE) {
    const err = new Error("Selected location must be a Raw Material Store.");
    err.status = 400;
    throw err;
  }
  return loc;
}

/**
 * Credit RM Store when a purchase is recorded.
 */
async function creditRmStoreOnPurchase({
  rmStoreLocationId,
  rawMaterialId,
  quantity,
  referenceType,
  referenceId,
  userId = null,
  notes = "",
  session = null,
}) {
  const qty = Number(quantity);
  if (!rmStoreLocationId || !qty || qty <= 0) return null;

  const loc = await validateRmStoreLocation(rmStoreLocationId, session);
  const prevQty = await getLocationRawMaterialQty(
    rmStoreLocationId,
    rawMaterialId,
    session,
  );
  await adjustLocationRawMaterialInventory(
    rmStoreLocationId,
    rawMaterialId,
    qty,
    session,
  );

  await writeLedger(
    {
      transactionType: TX.RAW_MATERIAL_STOCK_IN,
      direction: DIR.IN,
      rawMaterialId,
      quantity: qty,
      locationId: rmStoreLocationId,
      storeId: loc.store_id ?? null,
      referenceType,
      referenceId,
      userId,
      notes: notes || "Purchase credited to RM Store",
      previousBalance: prevQty,
      newBalance: prevQty + qty,
    },
    session,
  );

  return loc;
}

/**
 * Reverse a purchase credit at RM Store (edit/delete purchase).
 */
async function debitRmStoreOnPurchaseReverse({
  rmStoreLocationId,
  rawMaterialId,
  quantity,
  referenceType,
  referenceId,
  userId = null,
  notes = "",
  session = null,
}) {
  const qty = Number(quantity);
  if (!rmStoreLocationId || !qty || qty <= 0) return null;

  const loc = await validateRmStoreLocation(rmStoreLocationId, session);
  const prevQty = await getLocationRawMaterialQty(
    rmStoreLocationId,
    rawMaterialId,
    session,
  );
  if (qty > prevQty) {
    const err = new Error(
      `Cannot reverse purchase: RM Store only has ${prevQty} remaining (need ${qty}). Transfer or consumption may have already used this stock.`,
    );
    err.status = 409;
    throw err;
  }

  await adjustLocationRawMaterialInventory(
    rmStoreLocationId,
    rawMaterialId,
    -qty,
    session,
  );

  await writeLedger(
    {
      transactionType: TX.ADJUSTMENT,
      direction: DIR.OUT,
      rawMaterialId,
      quantity: qty,
      locationId: rmStoreLocationId,
      storeId: loc.store_id ?? null,
      referenceType,
      referenceId,
      userId,
      notes: notes || "Purchase reversed at RM Store",
      previousBalance: prevQty,
      newBalance: prevQty - qty,
    },
    session,
  );

  return loc;
}

/**
 * Manually consume raw materials at a production area (no BOM).
 */
async function applyManualProductionConsumption({
  rawMaterialsConsumed,
  productionLocationId,
  referenceType,
  referenceId,
  userId = null,
  notesPrefix = "Production consumption",
  session = null,
}) {
  if (!Array.isArray(rawMaterialsConsumed) || !rawMaterialsConsumed.length) {
    return [];
  }

  const prodQ = DispatchLocation.findById(productionLocationId).where({
    isDeleted: false,
  });
  if (session) prodQ.session(session);
  const prodLoc = await prodQ;
  if (!prodLoc) {
    const err = new Error("Production area not found.");
    err.status = 404;
    throw err;
  }
  if (Number(prodLoc.location_type) !== LOCATION_TYPE.PRODUCTION_AREA) {
    const err = new Error("Consumption must be logged at a production area.");
    err.status = 400;
    throw err;
  }

  const consumptions = [];

  for (const row of rawMaterialsConsumed) {
    const rmId =
      row.raw_material_id?._id ?? row.raw_material_id ?? row.rawMaterialId;
    const qty = Number(row.quantity ?? 0);
    if (!rmId || !qty || qty <= 0) continue;

    const prevQty = await getLocationRawMaterialQty(
      productionLocationId,
      rmId,
      session,
    );
    if (qty > prevQty) {
      const rmQ = RawMaterial.findById(rmId).where({ isDeleted: false });
      if (session) rmQ.session(session);
      const rm = await rmQ;
      const err = new Error(
        `Insufficient raw material at production area${rm?.name ? ` (${rm.name})` : ""}. Available: ${prevQty}, requested: ${qty}.`,
      );
      err.status = 409;
      throw err;
    }

    await adjustLocationRawMaterialInventory(
      productionLocationId,
      rmId,
      -qty,
      session,
    );

    // Keep global RM totals in sync (purchase credits global; consumption must debit it).
    await adjustRawMaterial(
      rmId,
      { outDelta: qty, availDelta: -qty },
      session,
    );

    await writeLedger(
      {
        transactionType: TX.RAW_MATERIAL_CONSUMPTION,
        direction: DIR.OUT,
        rawMaterialId: rmId,
        quantity: qty,
        locationId: productionLocationId,
        storeId: prodLoc.store_id ?? null,
        referenceType,
        referenceId,
        userId,
        notes: notesPrefix,
        previousBalance: prevQty,
        newBalance: prevQty - qty,
      },
      session,
    );

    consumptions.push({ raw_material_id: rmId, quantity: qty, stock_entry_id: null });
  }

  return consumptions;
}

async function reverseManualProductionConsumption(
  consumptions,
  productionLocationId,
  userId = null,
  session = null,
) {
  if (!Array.isArray(consumptions) || !consumptions.length || !productionLocationId) {
    return;
  }

  const prodQ = DispatchLocation.findById(productionLocationId).where({
    isDeleted: false,
  });
  if (session) prodQ.session(session);
  const prodLoc = await prodQ;

  for (const row of consumptions) {
    const rmId = row.raw_material_id?._id ?? row.raw_material_id;
    const qty = Number(row.quantity || 0);
    if (!rmId || qty <= 0) continue;

    const prevQty = await getLocationRawMaterialQty(
      productionLocationId,
      rmId,
      session,
    );
    await adjustLocationRawMaterialInventory(
      productionLocationId,
      rmId,
      qty,
      session,
    );

    await adjustRawMaterial(
      rmId,
      { outDelta: -qty, availDelta: qty },
      session,
    );

    await writeLedger(
      {
        transactionType: TX.ADJUSTMENT,
        direction: DIR.IN,
        rawMaterialId: rmId,
        quantity: qty,
        locationId: productionLocationId,
        storeId: prodLoc?.store_id ?? null,
        referenceType: "CakeProduction",
        referenceId: null,
        userId,
        notes: "Production consumption reversed",
        previousBalance: prevQty,
        newBalance: prevQty + qty,
      },
      session,
    );
  }
}

/**
 * Record RM wastage / spoilage at a location (RM store or production area).
 * Deducts from LocationRawMaterialInventory and writes a wastage ledger entry.
 */
async function recordRmWastage({
  locationId,
  rawMaterialId,
  quantity,
  notes = "",
  userId = null,
  session = null,
}) {
  const qty = Number(quantity || 0);
  if (!locationId || !rawMaterialId || !Number.isFinite(qty) || qty <= 0) {
    const err = new Error("location_id, raw_material_id and quantity > 0 are required.");
    err.status = 400;
    throw err;
  }

  const locQ = DispatchLocation.findById(locationId).where({ isDeleted: false });
  if (session) locQ.session(session);
  const loc = await locQ;
  if (!loc) {
    const err = new Error("Location not found.");
    err.status = 404;
    throw err;
  }
  const locType = Number(loc.location_type);
  if (
    locType !== LOCATION_TYPE.RAW_MATERIAL_STORE &&
    locType !== LOCATION_TYPE.PRODUCTION_AREA
  ) {
    const err = new Error(
      "Wastage can only be recorded at an RM Store or Production Area.",
    );
    err.status = 400;
    throw err;
  }

  const rmQ = RawMaterial.findById(rawMaterialId).where({ isDeleted: false });
  if (session) rmQ.session(session);
  const rm = await rmQ;
  if (!rm) {
    const err = new Error("Raw material not found.");
    err.status = 404;
    throw err;
  }

  const prevQty = await getLocationRawMaterialQty(locationId, rawMaterialId, session);
  if (qty > prevQty) {
    const err = new Error(
      `Insufficient stock for wastage of "${rm.name}". Available: ${prevQty}, requested: ${qty}.`,
    );
    err.status = 409;
    throw err;
  }

  await adjustLocationRawMaterialInventory(locationId, rawMaterialId, -qty, session);

  await adjustRawMaterial(
    rawMaterialId,
    { outDelta: qty, availDelta: -qty },
    session,
  );

  await writeLedger(
    {
      transactionType: TX.RAW_MATERIAL_WASTAGE,
      direction: DIR.OUT,
      rawMaterialId,
      quantity: qty,
      locationId,
      storeId: loc.store_id ?? null,
      referenceType: "RmWastage",
      referenceId: null,
      userId,
      notes: notes?.trim() || `Wastage: ${rm.name}`,
      previousBalance: prevQty,
      newBalance: prevQty - qty,
    },
    session,
  );

  return {
    location_id: loc._id,
    location_name: loc.name,
    raw_material_id: rm._id,
    raw_material_name: rm.name,
    quantity: qty,
    previous_quantity: prevQty,
    remaining_quantity: prevQty - qty,
    notes: notes?.trim() || "",
  };
}

function getUserId(req) {
  return req?.user?._id ?? null;
}

async function writeAudit({
  entityType,
  entityId,
  action,
  previousValue = null,
  newValue = null,
  userId = null,
  notes = "",
  session = null,
}) {
  const opts = session ? { session } : {};
  return InventoryAuditLog.create(
    [
      {
        entity_type: entityType,
        entity_id: entityId,
        action,
        previous_value: previousValue,
        new_value: newValue,
        user_id: userId,
        notes,
      },
    ],
    opts,
  );
}

async function writeLedger(
  {
    transactionType,
    direction,
    rawMaterialId = null,
    productId = null,
    quantity,
    storeId = null,
    locationId = null,
    referenceType = null,
    referenceId = null,
    userId = null,
    notes = "",
    previousBalance = null,
    newBalance = null,
  },
  session = null,
) {
  const opts = session ? { session } : {};
  const [entry] = await InventoryLedger.create(
    [
      {
        transaction_type: transactionType,
        direction,
        raw_material_id: rawMaterialId,
        product_id: productId,
        quantity,
        store_id: storeId,
        location_id: locationId,
        reference_type: referenceType,
        reference_id: referenceId,
        user_id: userId,
        notes,
        previous_balance: previousBalance,
        new_balance: newBalance,
        isDeleted: false,
      },
    ],
    opts,
  );
  return entry;
}

async function getRawMaterialAvailable(rawMaterialId, session = null) {
  const q = RawMaterial.findById(rawMaterialId).where({ isDeleted: false });
  if (session) q.session(session);
  const rm = await q;
  return rm ? Number(rm.available_quantity || 0) : 0;
}

async function adjustRawMaterial(
  rawMaterialId,
  { inDelta = 0, outDelta = 0, availDelta = 0 },
  session = null,
) {
  const opts = session ? { session } : {};
  const updated = await RawMaterial.findByIdAndUpdate(
    rawMaterialId,
    {
      $inc: {
        in_quantity: inDelta,
        out_quantity: outDelta,
        available_quantity: availDelta,
      },
    },
    { new: true, ...opts },
  );
  return updated;
}

async function adjustProduct(
  productId,
  { inDelta = 0, outDelta = 0, availDelta = 0 },
  session = null,
) {
  const opts = session ? { session } : {};
  return Product.findByIdAndUpdate(
    productId,
    {
      $inc: {
        in_quantity: inDelta,
        out_quantity: outDelta,
        available_quantity: availDelta,
      },
    },
    { new: true, ...opts },
  );
}

async function getLocationInventoryQty(
  locationId,
  productId,
  inventoryType = INV_TYPE.PRODUCTION,
  session = null,
) {
  const q = LocationInventory.findOne({
    location_id: locationId,
    product_id: productId,
    inventory_type: inventoryType,
    isDeleted: false,
  })
    .select("quantity")
    .lean();
  if (session) q.session(session);
  const row = await q;
  return row ? Number(row.quantity || 0) : 0;
}

async function adjustLocationInventory(
  locationId,
  productId,
  delta,
  inventoryType = INV_TYPE.PRODUCTION,
  session = null,
) {
  const opts = session ? { session } : {};
  const filter = {
    location_id: locationId,
    product_id: productId,
    inventory_type: inventoryType,
    isDeleted: false,
  };
  let row = await LocationInventory.findOne(filter);
  if (session) row = await LocationInventory.findOne(filter).session(session);

  if (!row) {
    if (delta < 0) {
      const err = new Error("Insufficient production inventory at this location.");
      err.status = 409;
      throw err;
    }
    const [created] = await LocationInventory.create(
      [
        {
          location_id: locationId,
          product_id: productId,
          inventory_type: inventoryType,
          quantity: delta,
          isDeleted: false,
        },
      ],
      opts,
    );
    return created;
  }

  const nextQty = Number(row.quantity || 0) + delta;
  if (nextQty < 0) {
    const err = new Error(
      `Insufficient inventory. Available: ${row.quantity}, requested: ${Math.abs(delta)}.`,
    );
    err.status = 409;
    throw err;
  }

  row.quantity = nextQty;
  if (session) await row.save({ session });
  else await row.save();
  return row;
}

/**
 * Validate BOM availability without mutating state.
 * Returns array of { raw_material_id, name, quantity_required, available }.
 */
async function validateBomAvailability(product, unitsProduced, session = null) {
  const bom = Array.isArray(product?.bom) ? product.bom : [];
  if (!bom.length) return { ok: false, missing: true, items: [] };

  const shortages = [];
  const items = [];

  for (const entry of bom) {
    const rmId = entry.rawMaterialId || entry.raw_material_id;
    const perUnit = Number(
      entry.quantity_required_per_unit ?? entry.quantity_used ?? 0,
    );
    if (!rmId || perUnit <= 0) continue;

    const required = perUnit * unitsProduced;
    const q = RawMaterial.findById(rmId).where({ isDeleted: false });
    if (session) q.session(session);
    const rm = await q;
    if (!rm) {
      shortages.push({ raw_material_id: rmId, name: "Unknown", required, available: 0 });
      continue;
    }
    const available = Number(rm.available_quantity || 0);
    items.push({
      raw_material_id: rm._id,
      name: rm.name,
      quantity_required: required,
      available,
    });
    if (required > available) {
      shortages.push({
        raw_material_id: rm._id,
        name: rm.name,
        required,
        available,
      });
    }
  }

  return {
    ok: shortages.length === 0 && items.length > 0,
    missing: items.length === 0,
    items,
    shortages,
  };
}

/**
 * Consume raw materials per product BOM. Creates purpose=2 stock rows + ledger.
 * Returns { consumptions: [{ raw_material_id, quantity, stock_entry_id }], rawMaterialsUsed: [] }
 */
async function consumeBomForProduction({
  product,
  unitsProduced,
  referenceType,
  referenceId,
  locationId = null,
  storeId = null,
  userId = null,
  notesPrefix = "Production consumption",
  session = null,
}) {
  const bom = Array.isArray(product?.bom) ? product.bom : [];
  const validation = await validateBomAvailability(product, unitsProduced, session);
  if (validation.missing) {
    const err = new Error(
      "Product has no BOM (bill of materials). Add raw material recipe before production.",
    );
    err.status = 422;
    throw err;
  }
  if (!validation.ok) {
    const detail = validation.shortages
      .map(
        (s) =>
          `${s.name}: need ${s.required}, available ${s.available}`,
      )
      .join("; ");
    const err = new Error(`Insufficient raw material stock. ${detail}`);
    err.status = 409;
    err.shortages = validation.shortages;
    throw err;
  }

  const consumptions = [];
  const rawMaterialsUsed = [];
  const opts = session ? { session } : {};

  for (const entry of bom) {
    const rmId = entry.rawMaterialId || entry.raw_material_id;
    const perUnit = Number(
      entry.quantity_required_per_unit ?? entry.quantity_used ?? 0,
    );
    if (!rmId || perUnit <= 0) continue;

    const qty = perUnit * unitsProduced;
    const prevAvail = await getRawMaterialAvailable(rmId, session);

    const stockEntry = await RawMaterialStock.create(
      [
        {
          raw_material_id: rmId,
          desc: `${notesPrefix} — ${product.name}`,
          quantity: qty,
          price: 0,
          total_price: 0,
          purpose: 2,
          isDeleted: false,
        },
      ],
      opts,
    );

    const updated = await adjustRawMaterial(
      rmId,
      { outDelta: qty, availDelta: -qty },
      session,
    );

    await writeLedger(
      {
        transactionType: TX.RAW_MATERIAL_CONSUMPTION,
        direction: DIR.OUT,
        rawMaterialId: rmId,
        quantity: qty,
        storeId,
        locationId,
        referenceType,
        referenceId,
        userId,
        notes: `${notesPrefix}: ${product.name}`,
        previousBalance: prevAvail,
        newBalance: Number(updated?.available_quantity ?? prevAvail - qty),
      },
      session,
    );

    consumptions.push({
      raw_material_id: rmId,
      quantity: qty,
      stock_entry_id: stockEntry[0]._id,
    });
    rawMaterialsUsed.push({ raw_material_id: rmId, quantity_used: qty });
  }

  return { consumptions, rawMaterialsUsed };
}

/**
 * Reverse BOM consumption entries created for a production run.
 */
async function reverseBomConsumption(consumptions, userId = null, session = null) {
  if (!Array.isArray(consumptions) || !consumptions.length) return;
  const opts = session ? { session } : {};

  for (const row of consumptions) {
    const stockId = row.stock_entry_id;
    const rmId = row.raw_material_id;
    const qty = Number(row.quantity || 0);
    if (!stockId || !rmId || qty <= 0) continue;

    const stockQ = RawMaterialStock.findById(stockId).where({ isDeleted: false });
    if (session) stockQ.session(session);
    const stock = await stockQ;
    if (!stock) continue;

    const prevAvail = await getRawMaterialAvailable(rmId, session);
    await adjustRawMaterial(rmId, { outDelta: -qty, availDelta: qty }, session);
    await RawMaterialStock.findByIdAndUpdate(
      stockId,
      { isDeleted: true },
      opts,
    );

    await writeLedger(
      {
        transactionType: TX.ADJUSTMENT,
        direction: DIR.IN,
        rawMaterialId: rmId,
        quantity: qty,
        referenceType: "RawMaterialStock",
        referenceId: stockId,
        userId,
        notes: "Reversed production consumption",
        previousBalance: prevAvail,
        newBalance: prevAvail + qty,
      },
      session,
    );
  }
}

/** Remaining qty on a purchase batch (legacy-safe). */
function getPurchaseBatchRemaining(stock) {
  if (!stock) return 0;
  if (stock.remaining_quantity != null && stock.remaining_quantity !== undefined) {
    return Number(stock.remaining_quantity);
  }
  return Number(stock.quantity || 0) - Number(stock.out_quantity || 0);
}

/** Debit a purchase batch when dispatching to Production / Shop. */
async function debitPurchaseBatch(stockId, quantity, session = null) {
  if (!stockId) return;
  const qty = Number(quantity);
  if (!qty || qty <= 0) return;

  const opts = session ? { session } : {};
  const q = RawMaterialStock.findById(stockId).where({ isDeleted: false });
  if (session) q.session(session);
  const stock = await q;
  if (!stock) {
    const err = new Error("Raw material stock batch not found.");
    err.status = 404;
    throw err;
  }
  if (Number(stock.purpose) !== 1) {
    const err = new Error("Dispatch must reference a purchase stock batch.");
    err.status = 400;
    throw err;
  }

  const remaining = getPurchaseBatchRemaining(stock);
  if (qty > remaining) {
    const err = new Error(
      `Insufficient batch stock. Remaining: ${remaining}, requested: ${qty}.`,
    );
    err.status = 409;
    throw err;
  }

  const outQty = Number(stock.out_quantity || 0);
  await RawMaterialStock.findByIdAndUpdate(
    stockId,
    {
      out_quantity: outQty + qty,
      remaining_quantity: remaining - qty,
    },
    opts,
  );
}

/** Credit a purchase batch when reversing a dispatch. */
async function creditPurchaseBatch(stockId, quantity, session = null) {
  if (!stockId) return;
  const qty = Number(quantity);
  if (!qty || qty <= 0) return;

  const opts = session ? { session } : {};
  const q = RawMaterialStock.findById(stockId);
  if (session) q.session(session);
  const stock = await q;
  if (!stock || stock.isDeleted) return;
  if (Number(stock.purpose) !== 1) return;

  const outQty = Number(stock.out_quantity || 0);
  const remaining = getPurchaseBatchRemaining(stock);
  const nextOut = Math.max(0, outQty - qty);
  const nextRemaining = remaining + qty;
  const inQty = Number(stock.quantity || 0);

  await RawMaterialStock.findByIdAndUpdate(
    stockId,
    {
      out_quantity: nextOut,
      remaining_quantity: Math.min(inQty, nextRemaining),
    },
    opts,
  );
}

/**
 * Apply inventory impact when raw material is dispatched RM Store → Production Area.
 * Legacy rows without fromLocationId still deduct global stock (generated_stock_id).
 */
async function applyRawMaterialDispatchImpact({
  rawMaterialId,
  quantity,
  fromLocationId = null,
  toLocationId = null,
  locationId = null,
  storeId = null,
  rawMaterialStockId = null,
  referenceId,
  userId = null,
  notes = "",
  session = null,
}) {
  const opts = session ? { session } : {};
  const qty = Number(quantity);
  if (!qty || qty <= 0) {
    const err = new Error("quantity must be greater than 0.");
    err.status = 400;
    throw err;
  }

  const destId = toLocationId || locationId;
  if (fromLocationId && destId) {
    const { fromLoc, toLoc } = await validateRmTransferLocations(
      fromLocationId,
      destId,
      session,
    );

    const fromPrev = await getLocationRawMaterialQty(
      fromLocationId,
      rawMaterialId,
      session,
    );
    if (qty > fromPrev) {
      const err = new Error(
        `Insufficient stock at RM Store. Available: ${fromPrev}, requested: ${qty}.`,
      );
      err.status = 409;
      throw err;
    }

    // Batch-level tracking: reduce remaining on the selected purchase batch.
    if (rawMaterialStockId) {
      await debitPurchaseBatch(rawMaterialStockId, qty, session);
    }

    await adjustLocationRawMaterialInventory(
      fromLocationId,
      rawMaterialId,
      -qty,
      session,
    );
    await adjustLocationRawMaterialInventory(
      destId,
      rawMaterialId,
      qty,
      session,
    );

    const toPrev = await getLocationRawMaterialQty(destId, rawMaterialId, session);

    await writeLedger(
      {
        transactionType: TX.RAW_MATERIAL_DISPATCH,
        direction: DIR.OUT,
        rawMaterialId,
        quantity: qty,
        locationId: fromLocationId,
        storeId: fromLoc.store_id ?? storeId ?? null,
        referenceType: "RawMaterialDispatch",
        referenceId,
        userId,
        notes: notes || `Dispatch to ${toLoc.name}`,
        previousBalance: fromPrev,
        newBalance: fromPrev - qty,
      },
      session,
    );

    await writeLedger(
      {
        transactionType: TX.RAW_MATERIAL_DISPATCH,
        direction: DIR.IN,
        rawMaterialId,
        quantity: qty,
        locationId: destId,
        storeId: toLoc.store_id ?? storeId ?? null,
        referenceType: "RawMaterialDispatch",
        referenceId,
        userId,
        notes: notes || `Received from ${fromLoc.name}`,
        previousBalance: toPrev - qty,
        newBalance: toPrev,
      },
      session,
    );

    return { generatedStockId: null };
  }

  const prevAvail = await getRawMaterialAvailable(rawMaterialId, session);
  if (qty > prevAvail) {
    const err = new Error(
      `Insufficient stock. Available: ${prevAvail}, requested: ${qty}.`,
    );
    err.status = 409;
    throw err;
  }

  if (rawMaterialStockId) {
    await debitPurchaseBatch(rawMaterialStockId, qty, session);
  }

  const [stockEntry] = await RawMaterialStock.create(
    [
      {
        raw_material_id: rawMaterialId,
        desc: notes || "Raw material dispatch",
        quantity: qty,
        out_quantity: qty,
        remaining_quantity: 0,
        price: 0,
        total_price: 0,
        purpose: 2,
        isDeleted: false,
      },
    ],
    opts,
  );

  const updated = await adjustRawMaterial(
    rawMaterialId,
    { outDelta: qty, availDelta: -qty },
    session,
  );

  await writeLedger(
    {
      transactionType: TX.RAW_MATERIAL_DISPATCH,
      direction: DIR.OUT,
      rawMaterialId,
      quantity: qty,
      locationId: destId,
      storeId,
      referenceType: "RawMaterialDispatch",
      referenceId,
      userId,
      notes,
      previousBalance: prevAvail,
      newBalance: Number(updated?.available_quantity ?? prevAvail - qty),
    },
    session,
  );

  return { generatedStockId: stockEntry._id };
}

/** Reverse inventory side-effects for a dispatch record. */
async function reverseRawMaterialDispatchImpact(
  {
    rawMaterialId,
    quantity,
    fromLocationId = null,
    toLocationId = null,
    locationId = null,
    generatedStockId = null,
    rawMaterialStockId = null,
    referenceId = null,
  },
  userId = null,
  session = null,
) {
  const opts = session ? { session } : {};
  const qty = Number(quantity || 0);
  if (!qty || qty <= 0) return;

  const destId = toLocationId || locationId;

  if (fromLocationId && destId) {
    if (rawMaterialStockId) {
      await creditPurchaseBatch(rawMaterialStockId, qty, session);
    }

    const fromPrev = await getLocationRawMaterialQty(
      fromLocationId,
      rawMaterialId,
      session,
    );
    await adjustLocationRawMaterialInventory(
      fromLocationId,
      rawMaterialId,
      qty,
      session,
    );
    await adjustLocationRawMaterialInventory(
      destId,
      rawMaterialId,
      -qty,
      session,
    );

    const fromLocQ = DispatchLocation.findById(fromLocationId);
    const toLocQ = DispatchLocation.findById(destId);
    if (session) {
      fromLocQ.session(session);
      toLocQ.session(session);
    }
    const [fromLoc, toLoc] = await Promise.all([fromLocQ, toLocQ]);

    await writeLedger(
      {
        transactionType: TX.ADJUSTMENT,
        direction: DIR.IN,
        rawMaterialId,
        quantity: qty,
        locationId: fromLocationId,
        storeId: fromLoc?.store_id ?? null,
        referenceType: "RawMaterialDispatch",
        referenceId,
        userId,
        notes: "Raw material dispatch reversed",
        previousBalance: fromPrev,
        newBalance: fromPrev + qty,
      },
      session,
    );

    const toPrev = await getLocationRawMaterialQty(destId, rawMaterialId, session);
    await writeLedger(
      {
        transactionType: TX.ADJUSTMENT,
        direction: DIR.OUT,
        rawMaterialId,
        quantity: qty,
        locationId: destId,
        storeId: toLoc?.store_id ?? null,
        referenceType: "RawMaterialDispatch",
        referenceId,
        userId,
        notes: "Raw material dispatch reversed",
        previousBalance: toPrev + qty,
        newBalance: toPrev,
      },
      session,
    );
    return;
  }

  if (!generatedStockId) {
    if (rawMaterialStockId) {
      await creditPurchaseBatch(rawMaterialStockId, qty, session);
    }
    return;
  }

  if (rawMaterialStockId) {
    await creditPurchaseBatch(rawMaterialStockId, qty, session);
  }

  const stockQ = RawMaterialStock.findById(generatedStockId);
  if (session) stockQ.session(session);
  const stock = await stockQ;
  if (stock && !stock.isDeleted) {
    await RawMaterialStock.findByIdAndUpdate(
      generatedStockId,
      { isDeleted: true },
      opts,
    );
  }

  const prevAvail = await getRawMaterialAvailable(rawMaterialId, session);
  const updated = await adjustRawMaterial(
    rawMaterialId,
    { outDelta: -qty, availDelta: qty },
    session,
  );

  await writeLedger(
    {
      transactionType: TX.ADJUSTMENT,
      direction: DIR.IN,
      rawMaterialId,
      quantity: qty,
      referenceType: "RawMaterialDispatch",
      referenceId,
      userId,
      notes: "Raw material dispatch reversed",
      previousBalance: prevAvail,
      newBalance: Number(updated?.available_quantity ?? prevAvail + qty),
    },
    session,
  );
}

async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const result = await fn(session);
    await session.commitTransaction();
    return result;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

/**
 * Move finished goods from production area → main store.
 */
async function executeStoreReceipt({
  fromLocationId,
  toLocationId,
  productId,
  quantity,
  receiptDate,
  userId = null,
  referenceType = "ProductStoreReceipt",
  referenceId = null,
  notes = "",
  cakeProductionId = null,
  ustadName = "",
  ustadId = null,
  session = null,
}) {
  const opts = session ? { session } : {};
  const qty = Number(quantity);
  if (!qty || qty <= 0) {
    const err = new Error("quantity must be greater than 0.");
    err.status = 400;
    throw err;
  }

  const fromInv = INV_TYPE.PRODUCTION;
  const toInv = INV_TYPE.STORE;

  const availableAtFrom = await getLocationInventoryQty(
    fromLocationId,
    productId,
    fromInv,
    session,
  );
  if (qty > availableAtFrom) {
    const err = new Error(
      `Insufficient production inventory. Available: ${availableAtFrom}, requested: ${qty}.`,
    );
    err.status = 409;
    throw err;
  }

  await adjustLocationInventory(fromLocationId, productId, -qty, fromInv, session);
  await adjustLocationInventory(toLocationId, productId, qty, toInv, session);

  const receipt_code = generateStoreReceiptCode();
  const ustad_name = String(ustadName || "").trim();

  const [item] = await ProductStoreReceipt.create(
    [
      {
        from_location_id: fromLocationId,
        to_location_id: toLocationId,
        product_id: productId,
        quantity: qty,
        receipt_date: new Date(receiptDate),
        notes: notes ?? "",
        receipt_code,
        ustad_name,
        ustad_id: ustadId || null,
        cake_production_id: cakeProductionId,
        created_by: userId,
        isDeleted: false,
      },
    ],
    opts,
  );

  const [fromLoc, toLoc] = await Promise.all([
    DispatchLocation.findById(fromLocationId),
    DispatchLocation.findById(toLocationId),
  ]);

  await writeLedger(
    {
      transactionType: TX.STORE_RECEIPT,
      direction: DIR.OUT,
      productId,
      quantity: qty,
      locationId: fromLocationId,
      storeId: fromLoc?.store_id ?? null,
      referenceType,
      referenceId: referenceId ?? item._id,
      userId,
      notes:
        notes ||
        `Store receipt out → ${toLoc?.name ?? "main store"}${
          ustad_name ? ` · Ustad: ${ustad_name}` : ""
        } [${receipt_code}]`,
      previousBalance: availableAtFrom,
      newBalance: availableAtFrom - qty,
    },
    session,
  );

  const toPrev = await getLocationInventoryQty(toLocationId, productId, toInv, session);
  await writeLedger(
    {
      transactionType: TX.STORE_RECEIPT,
      direction: DIR.IN,
      productId,
      quantity: qty,
      locationId: toLocationId,
      storeId: toLoc?.store_id ?? null,
      referenceType,
      referenceId: referenceId ?? item._id,
      userId,
      notes:
        notes ||
        `Store receipt in ← ${fromLoc?.name ?? "production"}${
          ustad_name ? ` · Ustad: ${ustad_name}` : ""
        } [${receipt_code}]`,
      previousBalance: toPrev - qty,
      newBalance: toPrev,
    },
    session,
  );

  return item;
}

/**
 * Reverse a store receipt.
 * @param {boolean} restoreToProduction — when false, only deduct from main store (production delete).
 */
async function reverseStoreReceipt(
  receiptId,
  userId = null,
  session = null,
  { restoreToProduction = true } = {},
) {
  const opts = session ? { session } : {};
  const q = ProductStoreReceipt.findById(receiptId).where({ isDeleted: false });
  if (session) q.session(session);
  const receipt = await q;
  if (!receipt) return null;

  const qty = Number(receipt.quantity || 0);
  if (qty > 0) {
    if (restoreToProduction) {
      await adjustLocationInventory(
        receipt.from_location_id,
        receipt.product_id,
        qty,
        INV_TYPE.PRODUCTION,
        session,
      );
    }
    await adjustLocationInventory(
      receipt.to_location_id,
      receipt.product_id,
      -qty,
      INV_TYPE.STORE,
      session,
    );
  }

  receipt.isDeleted = true;
  if (session) await receipt.save({ session });
  else await receipt.save();

  await writeAudit({
    entityType: "ProductStoreReceipt",
    entityId: receipt._id,
    action: "delete",
    previousValue: receipt.toObject?.() ?? receipt,
    userId,
    notes: restoreToProduction ? "Receipt reversed" : "Receipt reversed (production delete)",
    session,
  });

  return receipt;
}

/** @deprecated use withTransaction */
const withOptionalSession = withTransaction;

module.exports = {
  TX,
  DIR,
  LOCATION_TYPE,
  INV_TYPE,
  getUserId,
  writeAudit,
  writeLedger,
  getRawMaterialAvailable,
  adjustRawMaterial,
  adjustProduct,
  getLocationInventoryQty,
  adjustLocationInventory,
  getInventoryTypeForLocation,
  findFinishedGoodsStore,
  findProductionArea,
  findRmStoreForGodown,
  getLocationRawMaterialQty,
  adjustLocationRawMaterialInventory,
  validateRmTransferLocations,
  validateRmStoreLocation,
  creditRmStoreOnPurchase,
  debitRmStoreOnPurchaseReverse,
  applyManualProductionConsumption,
  reverseManualProductionConsumption,
  recordRmWastage,
  executeStoreReceipt,
  generateStoreReceiptCode,
  reverseStoreReceipt,
  applyRawMaterialDispatchImpact,
  reverseRawMaterialDispatchImpact,
  debitPurchaseBatch,
  creditPurchaseBatch,
  getPurchaseBatchRemaining,
  validateBomAvailability,
  consumeBomForProduction,
  reverseBomConsumption,
  withTransaction,
  withOptionalSession,
};
