const mongoose = require("mongoose");
const RawMaterial = require("../Models/RawMaterial");
const RawMaterialStock = require("../Models/RawMaterialStock");
const Product = require("../Models/Products");
const InventoryLedger = require("../Models/InventoryLedger");
const InventoryAuditLog = require("../Models/InventoryAuditLog");
const LocationInventory = require("../Models/LocationInventory");

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
};

const DIR = { IN: 1, OUT: 2 };

const LOCATION_TYPE = {
  RAW_MATERIAL_STORE: 1,
  PRODUCTION_AREA: 2,
  SHOP: 3,
};

const INV_TYPE = { PRODUCTION: 1, SHOP: 2 };

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
  });
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
  validateBomAvailability,
  consumeBomForProduction,
  reverseBomConsumption,
  withTransaction,
  withOptionalSession,
};
