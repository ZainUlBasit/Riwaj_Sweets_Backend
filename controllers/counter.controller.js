const Counter = require("../Models/Counter");
const { createError, successMessage } = require("../utils/ResponseMessage");

const list = async (req, res) => {
  try {
    const items = await Counter.find({ isDeleted: false }).sort({
      counter_number: 1,
      createdAt: -1,
    });
    const deletedItems = await Counter.find({ isDeleted: true }).sort({
      counter_number: 1,
      createdAt: -1,
    });
    return successMessage(
      res,
      { items, deletedItems },
      "Counters fetched successfully."
    );
  } catch (err) {
    console.error("Counter list error:", err);
    return createError(res, 500, err.message || "Failed to fetch counters.");
  }
};

const getOne = async (req, res) => {
  try {
    const item = await Counter.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!item) return createError(res, 404, "Counter not found.");
    return successMessage(res, item, "Counter fetched successfully.");
  } catch (err) {
    console.error("Counter getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch counter.");
  }
};

const create = async (req, res) => {
  try {
    const { type, location, description } = req.body;
    if (type == null || type === undefined) {
      return createError(res, 400, "Type is required (1: Cash, 2: Sale).");
    }
    if (![1, 2].includes(Number(type))) {
      return createError(res, 400, "Type must be 1 (Cash) or 2 (Sale).");
    }
    const item = await Counter.create({
      type: Number(type),
      location: location ?? "",
      description: description ?? "",
      isDeleted: false,
    });
    return successMessage(res, item, "Counter created successfully.");
  } catch (err) {
    console.error("Counter create error:", err);
    return createError(res, 500, err.message || "Failed to create counter.");
  }
};

const update = async (req, res) => {
  try {
    const { type, location, description } = req.body;
    const updatePayload = { isDeleted: false };
    if (type !== undefined) {
      if (![1, 2].includes(Number(type))) {
        return createError(res, 400, "Type must be 1 (Cash) or 2 (Sale).");
      }
      updatePayload.type = Number(type);
    }
    if (location !== undefined) updatePayload.location = location;
    if (description !== undefined) updatePayload.description = description;

    const item = await Counter.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      updatePayload,
      { new: true, runValidators: true }
    );
    if (!item) return createError(res, 404, "Counter not found.");
    return successMessage(res, item, "Counter updated successfully.");
  } catch (err) {
    console.error("Counter update error:", err);
    return createError(res, 500, err.message || "Failed to update counter.");
  }
};

const remove = async (req, res) => {
  try {
    const item = await Counter.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true }
    );
    if (!item) return createError(res, 404, "Counter not found.");
    return successMessage(res, item, "Counter deleted successfully.");
  } catch (err) {
    console.error("Counter remove error:", err);
    return createError(res, 500, err.message || "Failed to delete counter.");
  }
};

module.exports = { list, getOne, create, update, remove };
