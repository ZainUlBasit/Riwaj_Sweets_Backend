const Store = require("../Models/Store");
const DispatchLocation = require("../Models/DispatchLocation");
const { LOCATION_TYPE } = require("./inventoryService");

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const findByExactName = (name) =>
  DispatchLocation.findOne({
    name: new RegExp(`^${escapeRe(name)}$`, "i"),
    isDeleted: false,
  });

async function ensureGodown(name, description) {
  const nameRe = new RegExp(`^${escapeRe(name)}$`, "i");
  let store = await Store.findOne({ name: nameRe, isDeleted: false });
  if (!store) {
    store = await Store.create({
      name,
      description,
      isDeleted: false,
    });
  } else if (description && store.description !== description) {
    store.description = description;
    await store.save();
  }
  return store;
}

/**
 * Ensure a named location exists and is attached to `storeId`.
 * Soft-deleted same-name+type rows are restored.
 * Existing active rows are re-attached to the correct godown (pairing heal).
 *
 * @param {number} minCountForType — skip create if enough of this type exist
 *   under other names (user renamed defaults).
 */
async function ensureNamedLocation(
  storeId,
  { name, location_type, description },
  minCountForType = 1,
) {
  const nameRe = new RegExp(`^${escapeRe(name)}$`, "i");

  const softDeleted = await DispatchLocation.findOne({
    name: nameRe,
    location_type,
    isDeleted: true,
  });
  if (softDeleted) {
    softDeleted.isDeleted = false;
    softDeleted.description = softDeleted.description || description;
    softDeleted.store_id = storeId;
    await softDeleted.save();
    return softDeleted;
  }

  const existing = await findByExactName(name);
  if (existing) {
    if (Number(existing.location_type) !== location_type) return existing;
    let dirty = false;
    if (String(existing.store_id || "") !== String(storeId)) {
      existing.store_id = storeId;
      dirty = true;
    }
    if (description && !existing.description) {
      existing.description = description;
      dirty = true;
    }
    if (dirty) await existing.save();
    return existing;
  }

  const typeCount = await DispatchLocation.countDocuments({
    location_type,
    isDeleted: false,
  });
  if (typeCount >= minCountForType) {
    return null;
  }

  return DispatchLocation.create({
    name,
    description,
    store_id: storeId,
    location_type,
    isDeleted: false,
  });
}

/**
 * Masters defaults with manager pairs:
 *   Store 1 → RM Store 1 + Product Store 1
 *   Store 2 → RM Store 2 + Product Store 2
 * Shops + Production stay on Main (shared across managers).
 */
async function ensureDefaultLocations() {
  const main = await ensureGodown("Main", "Internal — shared Production / Shops");

  // Production stays auto/hidden for manufacturing flows (shared)
  let production = await DispatchLocation.findOne({
    store_id: main._id,
    location_type: LOCATION_TYPE.PRODUCTION_AREA,
    isDeleted: false,
  });
  if (!production) {
    const byName = await findByExactName("Production");
    if (
      byName &&
      Number(byName.location_type) === LOCATION_TYPE.PRODUCTION_AREA
    ) {
      if (String(byName.store_id || "") !== String(main._id)) {
        byName.store_id = main._id;
        await byName.save();
      }
    } else if (!byName) {
      await DispatchLocation.create({
        name: "Production",
        description: "Auto — production area (hidden from masters UI)",
        store_id: main._id,
        location_type: LOCATION_TYPE.PRODUCTION_AREA,
        isDeleted: false,
      });
    }
  }

  const store1 = await ensureGodown(
    "Store 1",
    "RM Manager 1 — RM Store 1 + Product Store 1",
  );
  const store2 = await ensureGodown(
    "Store 2",
    "RM Manager 2 — RM Store 2 + Product Store 2",
  );

  const paired = [
    {
      storeId: store1._id,
      name: "RM Store 1",
      location_type: LOCATION_TYPE.RAW_MATERIAL_STORE,
      description: "Raw material store (Manager 1)",
    },
    {
      storeId: store1._id,
      name: "Product Store 1",
      location_type: LOCATION_TYPE.FINISHED_GOODS_STORE,
      description: "Finished goods store (Manager 1)",
    },
    {
      storeId: store2._id,
      name: "RM Store 2",
      location_type: LOCATION_TYPE.RAW_MATERIAL_STORE,
      description: "Raw material store (Manager 2)",
    },
    {
      storeId: store2._id,
      name: "Product Store 2",
      location_type: LOCATION_TYPE.FINISHED_GOODS_STORE,
      description: "Finished goods store (Manager 2)",
    },
  ];

  const sharedShops = [
    {
      storeId: main._id,
      name: "Shop 1",
      location_type: LOCATION_TYPE.SHOP,
      description: "Retail shop",
    },
    {
      storeId: main._id,
      name: "Shop 2",
      location_type: LOCATION_TYPE.SHOP,
      description: "Retail shop",
    },
  ];

  const all = [...paired, ...sharedShops];
  const quotaByType = all.reduce((acc, d) => {
    acc[d.location_type] = (acc[d.location_type] || 0) + 1;
    return acc;
  }, {});

  for (const d of all) {
    await ensureNamedLocation(
      d.storeId,
      {
        name: d.name,
        location_type: d.location_type,
        description: d.description,
      },
      quotaByType[d.location_type],
    );
  }

  // Legacy singular "Product Store" — restore if soft-deleted; leave on Main.
  const legacyPs = await DispatchLocation.findOne({
    name: /^Product Store$/i,
    location_type: LOCATION_TYPE.FINISHED_GOODS_STORE,
  });
  if (legacyPs && legacyPs.isDeleted) {
    legacyPs.isDeleted = false;
    if (!legacyPs.store_id) legacyPs.store_id = main._id;
    await legacyPs.save();
  }
}

module.exports = { ensureDefaultLocations };
