const DispatchLocation = require("../Models/DispatchLocation");
const Store = require("../Models/Store");

const RM_MANAGER_ROLE = 6;

/**
 * Shared across RM Managers for transfers / receive.
 * RM Store (1) + Product Store (4) are per assigned Store
 * (Store 1 → RM1+PS1, Store 2 → RM2+PS2).
 */
const SHARED_LOCATION_TYPES = [2, 3]; // Production, Shop
const INVENTORY_LOCATION_TYPES = [1, 4]; // RM Store, Product Store

const getAssignedStoreId = (req) => {
  if (!req.user) return null;
  if (Number(req.user.role) === RM_MANAGER_ROLE) {
    return req.user.store_id ? String(req.user.store_id) : null;
  }
  return null;
};

const isRmManager = (req) => Number(req.user?.role) === RM_MANAGER_ROLE;

async function assertLocationBelongsToStore(locationId, storeId) {
  if (!locationId || !storeId) return;
  const loc = await DispatchLocation.findById(locationId).where({
    isDeleted: false,
  });
  if (!loc) {
    const err = new Error("Location not found.");
    err.status = 404;
    throw err;
  }
  const type = Number(loc.location_type);
  // Shop / Production can be used across godowns.
  // RM Store + Product Store must belong to the manager's assigned store.
  if (SHARED_LOCATION_TYPES.includes(type)) return;

  if (!loc.store_id || String(loc.store_id) !== String(storeId)) {
    const err = new Error("This location is outside your assigned store.");
    err.status = 403;
    throw err;
  }
}

async function assertRmManagerStoreAccess(req, locationIds = []) {
  const storeId = getAssignedStoreId(req);
  if (!storeId) return;
  const ids = [...new Set(locationIds.filter(Boolean).map(String))];
  for (const id of ids) {
    await assertLocationBelongsToStore(id, storeId);
  }
}

async function getStoreLocationIds(storeId) {
  if (!storeId) return [];
  const own = await DispatchLocation.find({
    store_id: storeId,
    isDeleted: false,
  }).distinct("_id");
  // Shared masters only (Shop / Production — not RM or Product Store)
  const shared = await DispatchLocation.find({
    location_type: { $in: SHARED_LOCATION_TYPES },
    isDeleted: false,
  }).distinct("_id");
  const ids = new Set([...own, ...shared].map(String));
  return [...ids];
}

/**
 * Stock pages only: RM Store + Product Store for this manager's godown.
 * Heal Store N ↔ RM/Product Store N pairing, then resolve by store_id and name.
 */
async function getInventoryLocationIdsForStore(storeId) {
  if (!storeId) return [];
  try {
    const {
      ensureDefaultLocations,
    } = require("../Services/ensureDefaultLocations");
    await ensureDefaultLocations();
  } catch (_) {
    /* pairing heal best-effort */
  }

  const own = await DispatchLocation.find({
    store_id: storeId,
    location_type: { $in: INVENTORY_LOCATION_TYPES },
    isDeleted: false,
  }).distinct("_id");

  const ids = new Set(own.map(String));

  const store = await Store.findById(storeId).select("name").lean();
  const numMatch = String(store?.name || "").match(/(\d+)\s*$/);
  if (numMatch) {
    const n = numMatch[1];
    const named = await DispatchLocation.find({
      isDeleted: false,
      location_type: { $in: INVENTORY_LOCATION_TYPES },
      name: new RegExp(`^(RM\\s*Store|Product\\s*Store)\\s*${n}$`, "i"),
    }).distinct("_id");
    for (const id of named) ids.add(String(id));
  }

  return [...ids];
}

async function applyStoreLocationFilter(req, filter, field = "location_id") {
  const storeId = getAssignedStoreId(req);
  if (!storeId) return filter;
  const locIds = await getStoreLocationIds(storeId);
  return { ...filter, [field]: { $in: locIds } };
}

/** Product / RM stock lists — only that manager's RM + Product Store pair. */
async function applyInventoryStoreFilter(req, filter, field = "location_id") {
  if (!isRmManager(req)) return filter;
  const storeId = getAssignedStoreId(req);
  if (!storeId) {
    return { ...filter, [field]: { $in: [] } };
  }
  const locIds = await getInventoryLocationIdsForStore(storeId);
  return { ...filter, [field]: { $in: locIds } };
}

module.exports = {
  RM_MANAGER_ROLE,
  SHARED_LOCATION_TYPES,
  INVENTORY_LOCATION_TYPES,
  getAssignedStoreId,
  isRmManager,
  assertLocationBelongsToStore,
  assertRmManagerStoreAccess,
  getStoreLocationIds,
  getInventoryLocationIdsForStore,
  applyStoreLocationFilter,
  applyInventoryStoreFilter,
};
