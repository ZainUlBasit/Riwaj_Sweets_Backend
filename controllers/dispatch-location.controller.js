const DispatchLocation = require("../Models/DispatchLocation");
const { createError, successMessage } = require("../utils/ResponseMessage");

const normalizeName = (name) => String(name ?? "").trim();

const findByName = (name) =>
  DispatchLocation.findOne({
    name: new RegExp(`^${escapeRegex(normalizeName(name))}$`, "i"),
    isDeleted: false,
  });

const list = async (_req, res) => {
  try {
    await syncLegacyDispatchLocations();

    const items = await DispatchLocation.find({ isDeleted: false }).sort({
      name: 1,
    });
    const deletedItems = await DispatchLocation.find({ isDeleted: true }).sort({
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

    const item = await DispatchLocation.create({
      name: normalized,
      description: description ?? "",
      store_id: store_id || null,
      location_type: location_type != null ? Number(location_type) : 2,
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
