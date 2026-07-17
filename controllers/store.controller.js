const Store = require("../Models/Store");
const DispatchLocation = require("../Models/DispatchLocation");
const { createError, successMessage } = require("../utils/ResponseMessage");
const { LOCATION_TYPE, getUserId, writeAudit } = require("../Services/inventoryService");

const list = async (req, res) => {
  try {
    const items = await Store.find({ isDeleted: false }).sort({ name: 1 });
    const deletedItems = await Store.find({ isDeleted: true }).sort({ name: 1 });

    const withLocations = await Promise.all(
      items.map(async (store) => {
        const locations = await DispatchLocation.find({
          store_id: store._id,
          isDeleted: false,
        }).sort({ location_type: 1, name: 1 });
        return {
          ...store.toObject(),
          locations,
        };
      }),
    );

    return successMessage(
      res,
      { items: withLocations, deletedItems },
      "Stores fetched successfully.",
    );
  } catch (err) {
    console.error("Store list error:", err);
    return createError(res, 500, err.message || "Failed to fetch stores.");
  }
};

const getOne = async (req, res) => {
  try {
    const store = await Store.findById(req.params.id).where({ isDeleted: false });
    if (!store) return createError(res, 404, "Store not found.");
    const locations = await DispatchLocation.find({
      store_id: store._id,
      isDeleted: false,
    }).sort({ location_type: 1, name: 1 });
    return successMessage(
      res,
      { ...store.toObject(), locations },
      "Store fetched successfully.",
    );
  } catch (err) {
    console.error("Store getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch store.");
  }
};

const create = async (req, res) => {
  try {
    const { name, description, setup_defaults = true } = req.body || {};
    if (!name?.trim()) return createError(res, 400, "Store name is required.");

    const userId = getUserId(req);
    const storeName = name.trim();
    const store = await Store.create({
      name: storeName,
      description: description?.trim() || "",
      isDeleted: false,
    });

    let locations = [];
    if (setup_defaults !== false) {
      const defaults = [
        {
          name: `${storeName} — Production`,
          location_type: LOCATION_TYPE.PRODUCTION_AREA,
          description: "Production / manufacturing area",
        },
        {
          name: `${storeName} — Product Store`,
          location_type: LOCATION_TYPE.FINISHED_GOODS_STORE,
          description: "Finished goods main store",
        },
      ];

      // RM Store is a single central location for the whole system.
      // Only create one if none exists yet.
      const existingRm = await DispatchLocation.findOne({
        location_type: LOCATION_TYPE.RAW_MATERIAL_STORE,
        isDeleted: false,
      });
      if (!existingRm) {
        defaults.unshift({
          name: "Central RM Store",
          location_type: LOCATION_TYPE.RAW_MATERIAL_STORE,
          description: "Central raw material store (system-wide)",
        });
      }

      locations = await DispatchLocation.insertMany(
        defaults.map((d) => ({
          ...d,
          store_id: store._id,
          isDeleted: false,
        })),
      );
    }

    await writeAudit({
      entityType: "Store",
      entityId: store._id,
      action: "create",
      newValue: store.toObject?.() ?? store,
      userId,
    });

    return successMessage(
      res,
      { ...store.toObject(), locations },
      setup_defaults !== false
        ? "Godown created with RM Store, Production, and Product Store."
        : "Store created successfully.",
    );
  } catch (err) {
    console.error("Store create error:", err);
    if (err.code === 11000) {
      return createError(res, 409, "A store with this name already exists.");
    }
    return createError(res, 500, err.message || "Failed to create store.");
  }
};

const update = async (req, res) => {
  try {
    const { name, description } = req.body || {};
    const existing = await Store.findById(req.params.id).where({ isDeleted: false });
    if (!existing) return createError(res, 404, "Store not found.");

    const userId = getUserId(req);
    const store = await Store.findByIdAndUpdate(
      req.params.id,
      {
        name: name !== undefined ? name.trim() : existing.name,
        description: description !== undefined ? description : existing.description,
        isDeleted: false,
      },
      { new: true, runValidators: true },
    );

    await writeAudit({
      entityType: "Store",
      entityId: store._id,
      action: "update",
      previousValue: existing.toObject?.() ?? existing,
      newValue: store.toObject?.() ?? store,
      userId,
    });

    return successMessage(res, store, "Store updated successfully.");
  } catch (err) {
    console.error("Store update error:", err);
    return createError(res, 500, err.message || "Failed to update store.");
  }
};

const remove = async (req, res) => {
  try {
    const existing = await Store.findById(req.params.id).where({ isDeleted: false });
    if (!existing) return createError(res, 404, "Store not found.");

    const userId = getUserId(req);
    const store = await Store.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true },
    );

    await writeAudit({
      entityType: "Store",
      entityId: store._id,
      action: "delete",
      previousValue: existing.toObject?.() ?? existing,
      userId,
    });

    return successMessage(res, store, "Store deleted successfully.");
  } catch (err) {
    console.error("Store remove error:", err);
    return createError(res, 500, err.message || "Failed to delete store.");
  }
};

module.exports = { list, getOne, create, update, remove };
