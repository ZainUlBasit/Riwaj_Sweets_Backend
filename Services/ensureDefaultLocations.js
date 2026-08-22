const Store = require("../Models/Store");
const DispatchLocation = require("../Models/DispatchLocation");
const { LOCATION_TYPE } = require("./inventoryService");

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const findByExactName = (name) =>
  DispatchLocation.findOne({
    name: new RegExp(`^${escapeRe(name)}$`, "i"),
    isDeleted: false,
  });

/**
 * Ensure a named default location exists (active). Soft-deleted matches
 * with the same type are restored instead of creating a duplicate.
 *
 * @param {number} minCountForType — if this many (or more) locations of
 *   `location_type` already exist, skip creating a missing default name
 *   (user may have renamed "Shop 1" without wanting a new "Shop 1").
 */
async function ensureNamedLocation(
  mainId,
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
    if (!softDeleted.store_id) softDeleted.store_id = mainId;
    await softDeleted.save();
    return softDeleted;
  }

  const existing = await findByExactName(name);
  if (existing) {
    if (Number(existing.location_type) !== location_type) return existing;
    if (!existing.store_id) {
      existing.store_id = mainId;
      await existing.save();
    }
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
    store_id: mainId,
    location_type,
    isDeleted: false,
  });
}

/**
 * Simple masters defaults (shown on /stores):
 * - RM Store 1 / RM Store 2
 * - Product Store 1 / Product Store 2
 * - Shop 1 / Shop 2
 * - Hidden Main godown + Production (for inventory)
 *
 * Do NOT auto soft-delete Product Stores — that hid them from RM Managers
 * on every /dispatch-location list call.
 */
async function ensureDefaultLocations() {
  let main = await Store.findOne({
    name: /^Main$/i,
    isDeleted: false,
  });
  if (!main) {
    main = await Store.create({
      name: "Main",
      description: "Internal — auto Production",
      isDeleted: false,
    });
  }

  // Production stays auto/hidden for manufacturing flows
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
      if (!byName.store_id) {
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

  const defaults = [
    {
      name: "RM Store 1",
      location_type: LOCATION_TYPE.RAW_MATERIAL_STORE,
      description: "Raw material store",
    },
    {
      name: "RM Store 2",
      location_type: LOCATION_TYPE.RAW_MATERIAL_STORE,
      description: "Raw material store",
    },
    {
      name: "Product Store 1",
      location_type: LOCATION_TYPE.FINISHED_GOODS_STORE,
      description: "Finished goods store",
    },
    {
      name: "Product Store 2",
      location_type: LOCATION_TYPE.FINISHED_GOODS_STORE,
      description: "Finished goods store",
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

  const quotaByType = defaults.reduce((acc, d) => {
    acc[d.location_type] = (acc[d.location_type] || 0) + 1;
    return acc;
  }, {});

  for (const d of defaults) {
    await ensureNamedLocation(main._id, d, quotaByType[d.location_type]);
  }

  // Legacy singular "Product Store" (older seed) — restore if soft-deleted so
  // existing inventory links keep working, then keep it visible on /stores.
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
