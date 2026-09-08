const bcrypt = require("bcrypt");
const User = require("../Models/Users");
const Store = require("../Models/Store");
const { createError, successMessage } = require("../utils/ResponseMessage");
const { RM_MANAGER_ROLE } = require("../utils/storeScope");

const sanitize = (doc) => {
  if (!doc) return doc;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj.password;
  return obj;
};

const populateStore = (q) => q.populate("store_id", "name description");

const list = async (_req, res) => {
  try {
    const { ensureDefaultLocations } = require("../Services/ensureDefaultLocations");
    await ensureDefaultLocations();

    const items = await populateStore(
      User.find({ isDeleted: false, role: RM_MANAGER_ROLE })
        .sort({ createdAt: -1 })
        .select("-password"),
    );
    const deletedItems = await populateStore(
      User.find({ isDeleted: true, role: RM_MANAGER_ROLE })
        .sort({ createdAt: -1 })
        .select("-password"),
    );

    return successMessage(
      res,
      { items: items.map(sanitize), deletedItems: deletedItems.map(sanitize) },
      "RM managers fetched successfully.",
    );
  } catch (err) {
    console.error("RmStaff list error:", err);
    return createError(res, 500, err.message || "Failed to fetch RM managers.");
  }
};

const getOne = async (req, res) => {
  try {
    const item = await populateStore(
      User.findOne({
        _id: req.params.id,
        isDeleted: false,
        role: RM_MANAGER_ROLE,
      }).select("-password"),
    );
    if (!item) return createError(res, 404, "RM manager not found.");
    return successMessage(res, sanitize(item), "RM manager fetched successfully.");
  } catch (err) {
    console.error("RmStaff getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch RM manager.");
  }
};

const create = async (req, res) => {
  try {
    const { name, email, password, store_id } = req.body;
    if (!name?.trim() || !email?.trim() || !password) {
      return createError(res, 400, "Name, email and password are required.");
    }
    if (!store_id) {
      return createError(res, 400, "store_id is required for RM Manager.");
    }
    if (String(password).length < 8) {
      return createError(res, 400, "Password must be at least 8 characters.");
    }

    const store = await Store.findById(store_id).where({ isDeleted: false });
    if (!store) return createError(res, 404, "Store not found.");

    const normalizedEmail = String(email).trim().toLowerCase();
    const exists = await User.findOne({ email: normalizedEmail });
    if (exists) return createError(res, 409, "Email already registered.");

    const hashedPassword = await bcrypt.hash(String(password), 10);
    const item = await User.create({
      name: String(name).trim(),
      email: normalizedEmail,
      password: hashedPassword,
      role: RM_MANAGER_ROLE,
      store_id,
      isDeleted: false,
    });

    const populated = await populateStore(User.findById(item._id).select("-password"));
    return successMessage(
      res,
      sanitize(populated || item),
      "RM Manager created successfully.",
    );
  } catch (err) {
    console.error("RmStaff create error:", err);
    return createError(res, 500, err.message || "Failed to create RM manager.");
  }
};

const update = async (req, res) => {
  try {
    const { name, email, password, store_id } = req.body;
    const updatePayload = {};

    if (name !== undefined) updatePayload.name = String(name).trim();
    if (email !== undefined) {
      const normalizedEmail = String(email).trim().toLowerCase();
      const dup = await User.findOne({
        email: normalizedEmail,
        _id: { $ne: req.params.id },
      });
      if (dup) return createError(res, 409, "Email already in use.");
      updatePayload.email = normalizedEmail;
    }
    if (password !== undefined && password !== "") {
      if (String(password).length < 8) {
        return createError(res, 400, "Password must be at least 8 characters.");
      }
      updatePayload.password = await bcrypt.hash(String(password), 10);
    }
    if (store_id !== undefined) {
      if (!store_id) {
        return createError(res, 400, "store_id cannot be empty.");
      }
      const store = await Store.findById(store_id).where({ isDeleted: false });
      if (!store) return createError(res, 404, "Store not found.");
      updatePayload.store_id = store_id;
    }

    const item = await populateStore(
      User.findOneAndUpdate(
        { _id: req.params.id, isDeleted: false, role: RM_MANAGER_ROLE },
        updatePayload,
        { new: true, runValidators: true },
      ).select("-password"),
    );

    if (!item) return createError(res, 404, "RM manager not found.");
    return successMessage(res, sanitize(item), "RM manager updated successfully.");
  } catch (err) {
    console.error("RmStaff update error:", err);
    return createError(res, 500, err.message || "Failed to update RM manager.");
  }
};

const remove = async (req, res) => {
  try {
    const item = await populateStore(
      User.findOneAndUpdate(
        { _id: req.params.id, isDeleted: false, role: RM_MANAGER_ROLE },
        { isDeleted: true },
        { new: true },
      ).select("-password"),
    );
    if (!item) return createError(res, 404, "RM manager not found.");
    return successMessage(res, sanitize(item), "RM manager removed successfully.");
  } catch (err) {
    console.error("RmStaff remove error:", err);
    return createError(res, 500, err.message || "Failed to remove RM manager.");
  }
};

module.exports = { list, getOne, create, update, remove };
