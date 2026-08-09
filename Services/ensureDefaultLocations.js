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
 * Simple masters defaults:
 * - RM Store 1 / RM Store 2
 * - Shop 1 / Shop 2
 * - Hidden Main godown + Production (for inventory)
 *
 * Product Stores are user-managed only — legacy auto "Product Store" is removed.
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

  // Remove legacy auto-seeded Product Store (user manages Product Stores via UI).
  // Exact name "Product Store" was the default seed — soft-delete it for good.
  await DispatchLocation.updateMany(
    {
      isDeleted: false,
      location_type: LOCATION_TYPE.FINISHED_GOODS_STORE,
      $or: [
        { name: /^Product Store$/i },
        { description: /hidden from masters UI/i },
        { description: /^Auto — finished goods/i },
        { description: /^Finished goods product store$/i },
      ],
    },
    { $set: { isDeleted: true } },
  );

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
    const existing = await findByExactName(d.name);
    if (existing) {
      if (Number(existing.location_type) !== d.location_type) continue;
      if (!existing.store_id) {
        existing.store_id = main._id;
        await existing.save();
      }
      continue;
    }
    await DispatchLocation.create({
      name: d.name,
      description: d.description,
      store_id: main._id,
      location_type: d.location_type,
      isDeleted: false,
    });
  }
}

module.exports = { ensureDefaultLocations };
