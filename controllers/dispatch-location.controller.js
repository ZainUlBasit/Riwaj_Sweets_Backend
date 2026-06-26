const DispatchLocation = require("../Models/DispatchLocation");
const { createError, successMessage } = require("../utils/ResponseMessage");
const { getAssignedStoreId } = require("../utils/storeScope");

const LOCATION_TYPE = {
  RAW_MATERIAL_STORE: 1,
  PRODUCTION_AREA: 2,
  SHOP: 3,
  FINISHED_GOODS_STORE: 4,
};

const SINGLETON_TYPES = [
  LOCATION_TYPE.RAW_MATERIAL_STORE,
  LOCATION_TYPE.FINISHED_GOODS_STORE,
];

const getSingletonLabel = (type) => {
  if (type === LOCATION_TYPE.RAW_MATERIAL_STORE) return "Raw Material Store";
  if (type === LOCATION_TYPE.FINISHED_GOODS_STORE) return "Product Store";
  return "location";
};

async function assertSingletonLocation(storeId, locationType, excludeId = null) {
  if (!storeId || !SINGLETON_TYPES.includes(Number(locationType))) return null;
  const filter = {
    store_id: storeId,
    location_type: Number(locationType),
    isDeleted: false,
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return DispatchLocation.findOne(filter);
}

const normalizeName = (name) => String(name ?? "").trim();

const findByName = (name) =>
  DispatchLocation.findOne({
    name: new RegExp(`^${escapeRegex(normalizeName(name))}$`, "i"),
    isDeleted: false,
  });

const list = async (req, res) => {
  try {
    await syncLegacyDispatchLocations();

    const filter = { isDeleted: false };
    const scopedStore =
      getAssignedStoreId(req) ||
      (req.query.store_id ? String(req.query.store_id) : null);
    if (scopedStore) filter.store_id = scopedStore;

    const items = await DispatchLocation.find(filter).sort({
      name: 1,
    });
    const deletedFilter = { isDeleted: true };
    if (scopedStore) deletedFilter.store_id = scopedStore;
    const deletedItems = await DispatchLocation.find(deletedFilter).sort({
      name: 1,
    });

    return successMessage(
      res,
      { items, deletedItems },
      "Dispatch locations fetched successfully.",
    );
  } catch (err) {
    console.error("DispatchLocation list error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to fetch dispatch locations.",
    );
  }
};

const getOne = async (req, res) => {
  try {
    const item = await DispatchLocation.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!item) return createError(res, 404, "Dispatch location not found.");
    return successMessage(
      res,
      item,
      "Dispatch location fetched successfully.",
    );
  } catch (err) {
    console.error("DispatchLocation getOne error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to fetch dispatch location.",
    );
  }
};

const create = async (req, res) => {
  try {
    const { name, description, store_id, location_type } = req.body || {};
    const normalized = normalizeName(name);
    if (!normalized) return createError(res, 400, "name is required.");

    const existing = await findByName(normalized);
    if (existing) {
      return successMessage(
        res,
        existing,
        "Dispatch location already exists.",
      );
    }

    const locType = location_type != null ? Number(location_type) : 2;
    if (store_id) {
      const duplicate = await assertSingletonLocation(store_id, locType);
      if (duplicate) {
        return createError(
          res,
          409,
          `This godown already has a ${getSingletonLabel(locType)}. Only one is allowed per godown.`,
        );
      }
    }

    const item = await DispatchLocation.create({
      name: normalized,
      description: description ?? "",
      store_id: store_id || null,
      location_type: locType,
      isDeleted: false,
    });

    return successMessage(
      res,
      item,
      "Dispatch location created successfully.",
    );
  } catch (err) {
    console.error("DispatchLocation create error:", err);
    return createError(
      res,
      err.code === 11000 ? 409 : 500,
      err.code === 11000
        ? "Dispatch location already exists."
        : err.message || "Failed to create dispatch location.",
    );
  }
};

const update = async (req, res) => {
  try {
    const { name, description, store_id, location_type } = req.body || {};
    const updatePayload = { isDeleted: false };

    if (name !== undefined) {
      const normalized = normalizeName(name);
      if (!normalized) return createError(res, 400, "name cannot be empty.");

      const duplicate = await findByName(normalized);
      if (duplicate && String(duplicate._id) !== String(req.params.id)) {
        return createError(res, 409, "Dispatch location already exists.");
      }
      updatePayload.name = normalized;
    }
    if (description !== undefined) updatePayload.description = description;
    if (store_id !== undefined) updatePayload.store_id = store_id || null;
    if (location_type !== undefined) updatePayload.location_type = Number(location_type);

    const current = await DispatchLocation.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!current) return createError(res, 404, "Dispatch location not found.");

    const effectiveStoreId =
      updatePayload.store_id !== undefined
        ? updatePayload.store_id
        : current.store_id;
    const effectiveType =
      updatePayload.location_type !== undefined
        ? updatePayload.location_type
        : current.location_type;

    if (effectiveStoreId) {
      const duplicate = await assertSingletonLocation(
        effectiveStoreId,
        effectiveType,
        req.params.id,
      );
      if (duplicate) {
        return createError(
          res,
          409,
          `This godown already has a ${getSingletonLabel(effectiveType)}. Only one is allowed per godown.`,
        );
      }
    }

    const item = await DispatchLocation.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      updatePayload,
      { new: true, runValidators: true },
    );
    if (!item) return createError(res, 404, "Dispatch location not found.");

    return successMessage(
      res,
      item,
      "Dispatch location updated successfully.",
    );
  } catch (err) {
    console.error("DispatchLocation update error:", err);
    return createError(
      res,
      err.code === 11000 ? 409 : 500,
      err.code === 11000
        ? "Dispatch location already exists."
        : err.message || "Failed to update dispatch location.",
    );
  }
};

const remove = async (req, res) => {
  try {
    const item = await DispatchLocation.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true },
    );
    if (!item) return createError(res, 404, "Dispatch location not found.");
    return successMessage(
      res,
      item,
      "Dispatch location deleted successfully.",
    );
  } catch (err) {
    console.error("DispatchLocation remove error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to delete dispatch location.",
    );
  }
};

async function getOrCreateLocation(name) {
  const normalized = normalizeName(name);
  if (!normalized) return null;

  const existing = await findByName(normalized);
  if (existing) return existing;

  try {
    return await DispatchLocation.create({
      name: normalized,
      isDeleted: false,
    });
  } catch (err) {
    if (err.code === 11000) return findByName(normalized);
    throw err;
  }
}

async function syncLegacyDispatchLocations() {
  const RawMaterialDispatch = require("../Models/RawMaterialDispatch");
  const legacyNames = await RawMaterialDispatch.distinct("location", {
    isDeleted: false,
    $or: [{ location_id: null }, { location_id: { $exists: false } }],
    location: { $nin: [null, ""] },
  });

  for (const name of legacyNames) {
    const location = await getOrCreateLocation(name);
    if (!location) continue;
    await RawMaterialDispatch.updateMany(
      {
        isDeleted: false,
        $or: [{ location_id: null }, { location_id: { $exists: false } }],
        location: new RegExp(`^${escapeRegex(name)}$`, "i"),
      },
      { location_id: location._id, location: location.name },
    );
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  list,
  getOne,
  create,
  update,
  remove,
  getOrCreateLocation,
};
