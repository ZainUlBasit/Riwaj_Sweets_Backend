const PaymentMethod = require("../Models/PaymentMethod");
const { createError, successMessage } = require("../utils/ResponseMessage");

const DEFAULTS = [
  { name: "Cash", code: "cash", sort_order: 1 },
  { name: "Bank Transfer", code: "bank_transfer", sort_order: 2 },
  { name: "JazzCash", code: "jazzcash", sort_order: 3 },
  { name: "EasyPaisa", code: "easypaisa", sort_order: 4 },
  { name: "Cheque", code: "cheque", sort_order: 5 },
];

/**
 * Seed default payment methods if collection is empty (active).
 * Safe to call on every list — no-op when rows already exist.
 */
const ensureDefaults = async () => {
  const count = await PaymentMethod.countDocuments({ isDeleted: false });
  if (count > 0) return;

  await PaymentMethod.insertMany(
    DEFAULTS.map((row) => ({
      ...row,
      isActive: true,
      isDeleted: false,
    }))
  );
};

/** GET / — active methods for apps (public) */
const listActive = async (req, res) => {
  try {
    await ensureDefaults();
    const items = await PaymentMethod.find({
      isDeleted: false,
      isActive: true,
    }).sort({ sort_order: 1, name: 1 });

    return successMessage(
      res,
      { items, paymentMethods: items },
      "Payment methods fetched successfully."
    );
  } catch (err) {
    console.error("PaymentMethod listActive error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to fetch payment methods."
    );
  }
};

/** GET /all — active + inactive for admin */
const listAll = async (req, res) => {
  try {
    await ensureDefaults();
    const items = await PaymentMethod.find({ isDeleted: false }).sort({
      sort_order: 1,
      name: 1,
    });
    const deletedItems = await PaymentMethod.find({ isDeleted: true }).sort({
      updatedAt: -1,
    });
    return successMessage(
      res,
      { items, deletedItems, paymentMethods: items },
      "Payment methods fetched successfully."
    );
  } catch (err) {
    console.error("PaymentMethod listAll error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to fetch payment methods."
    );
  }
};

const getOne = async (req, res) => {
  try {
    const item = await PaymentMethod.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!item) return createError(res, 404, "Payment method not found.");
    return successMessage(res, item, "Payment method fetched successfully.");
  } catch (err) {
    console.error("PaymentMethod getOne error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to fetch payment method."
    );
  }
};

const create = async (req, res) => {
  try {
    const { name, code, sort_order, isActive } = req.body || {};
    if (!name || !String(name).trim()) {
      return createError(res, 400, "Name is required.");
    }

    const exists = await PaymentMethod.findOne({
      name: new RegExp(`^${String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
      isDeleted: false,
    });
    if (exists) {
      return createError(res, 400, "Payment method with this name already exists.");
    }

    const item = await PaymentMethod.create({
      name: String(name).trim(),
      code: (code || "").trim().toLowerCase(),
      sort_order: Number(sort_order) || 0,
      isActive: isActive !== false,
      isDeleted: false,
    });

    return successMessage(res, item, "Payment method created successfully.");
  } catch (err) {
    console.error("PaymentMethod create error:", err);
    if (err?.code === 11000) {
      return createError(res, 400, "Payment method with this name already exists.");
    }
    return createError(
      res,
      500,
      err.message || "Failed to create payment method."
    );
  }
};

const update = async (req, res) => {
  try {
    const { name, code, sort_order, isActive } = req.body || {};
    const patch = {};
    if (name != null) patch.name = String(name).trim();
    if (code != null) patch.code = String(code).trim().toLowerCase();
    if (sort_order != null) patch.sort_order = Number(sort_order) || 0;
    if (isActive != null) patch.isActive = !!isActive;

    if (patch.name === "") {
      return createError(res, 400, "Name cannot be empty.");
    }

    const item = await PaymentMethod.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      patch,
      { new: true, runValidators: true }
    );
    if (!item) return createError(res, 404, "Payment method not found.");
    return successMessage(res, item, "Payment method updated successfully.");
  } catch (err) {
    console.error("PaymentMethod update error:", err);
    if (err?.code === 11000) {
      return createError(res, 400, "Payment method with this name already exists.");
    }
    return createError(
      res,
      500,
      err.message || "Failed to update payment method."
    );
  }
};

const remove = async (req, res) => {
  try {
    const item = await PaymentMethod.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true, isActive: false },
      { new: true }
    );
    if (!item) return createError(res, 404, "Payment method not found.");
    return successMessage(res, item, "Payment method deleted successfully.");
  } catch (err) {
    console.error("PaymentMethod remove error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to delete payment method."
    );
  }
};

module.exports = {
  listActive,
  listAll,
  getOne,
  create,
  update,
  remove,
  ensureDefaults,
};
