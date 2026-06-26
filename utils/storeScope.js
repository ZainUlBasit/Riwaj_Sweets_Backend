const DispatchLocation = require("../Models/DispatchLocation");

const RM_MANAGER_ROLE = 6;

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
  const loc = await DispatchLocation.findById(locationId).where({ isDeleted: false });
  if (!loc) {
    const err = new Error("Location not found.");
    err.status = 404;
    throw err;
  }
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
  return DispatchLocation.find({ store_id: storeId, isDeleted: false }).distinct(
    "_id",
  );
}

async function applyStoreLocationFilter(req, filter, field = "location_id") {
  const storeId = getAssignedStoreId(req);
  if (!storeId) return filter;
  const locIds = await getStoreLocationIds(storeId);
  return { ...filter, [field]: { $in: locIds } };
}

module.exports = {
  RM_MANAGER_ROLE,
  getAssignedStoreId,
  isRmManager,
  assertLocationBelongsToStore,
  assertRmManagerStoreAccess,
  getStoreLocationIds,
  applyStoreLocationFilter,
};
