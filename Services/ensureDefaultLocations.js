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
 */
async function ensureNamedLocation(mainId, { name, location_type, description }) {
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

  return DispatchLocation.create({
    name,
    description,
    store_id: mainId,
    location_type,
    isDeleted: false,
  });
}

/**
 * Legacy "Shop 1/2" → "Store 1/2" (same location_type = 3).
 * Keeps inventory links; only renames the master label.
 */
async function renameLegacyShopsToStores() {
  for (const n of [1, 2]) {
    const shop = await DispatchLocation.findOne({
      name: new RegExp(`^Shop\\s*${n}$`, "i"),
      location_type: LOCATION_TYPE.SHOP,
      isDeleted: false,
    });
    if (!shop) continue;

    const storeName = `Store ${n}`;
    const conflict = await findByExactName(storeName);
    if (conflict && String(conflict._id) !== String(shop._id)) {
      // Store N already exists — hide the old Shop N name from masters.
      shop.isDeleted = true;
      await shop.save();
      continue;
    }

    shop.name = storeName;
    shop.description = shop.description || "Sale / outlet store";
    await shop.save();
  }
}

/**
 * Simple masters only (shown on /stores):
 *   RM Store 1 / RM Store 2
 *   Product Store 1 / Product Store 2
 *   Store 1 / Store 2
 *
 * Production + internal Main godown stay auto/hidden for inventory ops.
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

  // Production stays auto/hidden — not on /stores masters UI
  const production = await DispatchLocation.findOne({
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

  await renameLegacyShopsToStores();

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
      name: "Store 1",
      location_type: LOCATION_TYPE.SHOP,
      description: "Sale / outlet store",
    },
    {
      name: "Store 2",
      location_type: LOCATION_TYPE.SHOP,
      description: "Sale / outlet store",
    },
  ];

  for (const d of defaults) {
    await ensureNamedLocation(main._id, d);
  }
}

module.exports = { ensureDefaultLocations };
