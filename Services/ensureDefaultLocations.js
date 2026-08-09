const Store = require("../Models/Store");
const DispatchLocation = require("../Models/DispatchLocation");
const { LOCATION_TYPE } = require("./inventoryService");

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const findByExactName = (name) =>
  DispatchLocation.findOne({
    name: new RegExp(`^${escapeRe(name)}$`, "i"),
    isDeleted: false,
  });

const findStoreByName = (name) =>
  Store.findOne({
    name: new RegExp(`^${escapeRe(name)}$`, "i"),
    isDeleted: false,
  });

/**
 * Simple Store master: Store 1 / Store 2 (production maal warehouses).
 * Migrates legacy "Main" → Store 1 when needed.
 */
async function ensureSimpleStores() {
  // Rename legacy Main → Store 1 if Store 1 does not exist yet.
  const main = await Store.findOne({ name: /^Main$/i, isDeleted: false });
  let store1 = await findStoreByName("Store 1");

  if (main && !store1) {
    main.name = "Store 1";
    main.description = main.description || "Production maal store";
    await main.save();
    store1 = main;
  } else if (main && store1 && String(main._id) !== String(store1._id)) {
    // Move locations off legacy Main, then soft-delete Main.
    await DispatchLocation.updateMany(
      { store_id: main._id, isDeleted: false },
      { $set: { store_id: store1._id } },
    );
    main.isDeleted = true;
    await main.save();
  }

  if (!store1) {
    store1 = await Store.create({
      name: "Store 1",
      description: "Production maal store",
      isDeleted: false,
    });
  }

  let store2 = await findStoreByName("Store 2");
  if (!store2) {
    const soft = await Store.findOne({
      name: /^Store 2$/i,
      isDeleted: true,
    });
    if (soft) {
      soft.isDeleted = false;
      soft.description = soft.description || "Production maal store";
      await soft.save();
      store2 = soft;
    } else {
      store2 = await Store.create({
        name: "Store 2",
        description: "Production maal store",
        isDeleted: false,
      });
    }
  }

  return { store1, store2 };
}

/**
 * Ensure a named default location exists (active). Soft-deleted matches
 * with the same type are restored instead of creating a duplicate.
 */
async function ensureNamedLocation(parentStoreId, { name, location_type, description }) {
  const nameRe = new RegExp(`^${escapeRe(name)}$`, "i");

  const softDeleted = await DispatchLocation.findOne({
    name: nameRe,
    location_type,
    isDeleted: true,
  });
  if (softDeleted) {
    softDeleted.isDeleted = false;
    softDeleted.description = softDeleted.description || description;
    if (!softDeleted.store_id) softDeleted.store_id = parentStoreId;
    await softDeleted.save();
    return softDeleted;
  }

  const existing = await findByExactName(name);
  if (existing) {
    if (Number(existing.location_type) !== location_type) return existing;
    if (!existing.store_id) {
      existing.store_id = parentStoreId;
      await existing.save();
    }
    return existing;
  }

  return DispatchLocation.create({
    name,
    description,
    store_id: parentStoreId,
    location_type,
    isDeleted: false,
  });
}

/**
 * Soft-delete auto-generated clutter that used to flood /stores:
 * e.g. "Main — Product Store", "Factory — Production".
 * Keeps a single hidden Production for inventory under Store 1.
 */
async function cleanupClutterLocations(store1Id) {
  await DispatchLocation.updateMany(
    {
      isDeleted: false,
      $or: [
        { name: /—\s*Product Store$/i },
        { name: /—\s*Production$/i },
        { description: /hidden from masters UI/i },
        { description: /^Auto — finished goods/i },
        { description: /^Finished goods product store$/i },
        { description: /^Finished goods main store$/i },
        {
          location_type: LOCATION_TYPE.PRODUCTION_AREA,
          name: { $not: /^Production$/i },
        },
      ],
    },
    { $set: { isDeleted: true } },
  );

  // One hidden Production for manufacturing flows (not shown on /stores UI).
  const production = await DispatchLocation.findOne({
    name: /^Production$/i,
    location_type: LOCATION_TYPE.PRODUCTION_AREA,
    isDeleted: false,
  });
  if (!production) {
    const softProd = await DispatchLocation.findOne({
      name: /^Production$/i,
      location_type: LOCATION_TYPE.PRODUCTION_AREA,
      isDeleted: true,
    });
    if (softProd) {
      softProd.isDeleted = false;
      softProd.store_id = softProd.store_id || store1Id;
      softProd.description = "Internal production (hidden)";
      await softProd.save();
    } else {
      await DispatchLocation.create({
        name: "Production",
        description: "Internal production (hidden)",
        store_id: store1Id,
        location_type: LOCATION_TYPE.PRODUCTION_AREA,
        isDeleted: false,
      });
    }
  } else if (!production.store_id) {
    production.store_id = store1Id;
    production.description = "Internal production (hidden)";
    await production.save();
  }
}

/**
 * Simple masters defaults for /stores:
 *   Store 1 / Store 2
 *   RM Store 1 / RM Store 2
 *   Product Store 1 / Product Store 2
 *   Shop 1 / Shop 2
 *
 * Production + legacy "Main" stay out of the masters UI.
 */
async function ensureDefaultLocations() {
  const { store1 } = await ensureSimpleStores();
  await cleanupClutterLocations(store1._id);

  const defaults = [
    {
      name: "RM Store 1",
      location_type: LOCATION_TYPE.RAW_MATERIAL_STORE,
      description: "Raw material",
    },
    {
      name: "RM Store 2",
      location_type: LOCATION_TYPE.RAW_MATERIAL_STORE,
      description: "Raw material",
    },
    {
      name: "Product Store 1",
      location_type: LOCATION_TYPE.FINISHED_GOODS_STORE,
      description: "Finished goods",
    },
    {
      name: "Product Store 2",
      location_type: LOCATION_TYPE.FINISHED_GOODS_STORE,
      description: "Finished goods",
    },
    {
      name: "Shop 1",
      location_type: LOCATION_TYPE.SHOP,
      description: "Retail shop",
    },
    {
      name: "Shop 2",
      location_type: LOCATION_TYPE.SHOP,
      description: "Retail shop",
    },
  ];

  for (const d of defaults) {
    await ensureNamedLocation(store1._id, d);
  }
}

module.exports = { ensureDefaultLocations };
