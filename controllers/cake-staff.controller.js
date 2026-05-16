const bcrypt = require("bcrypt");
const User = require("../Models/Users");
const { createError, successMessage } = require("../utils/ResponseMessage");

/** 4 = Cake Designer, 5 = Cake Order Manager (counter) */
const CAKE_ROLES = [4, 5];

const sanitize = (doc) => {
  if (!doc) return doc;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj.password;
  return obj;
};

const list = async (req, res) => {
  try {
    const filter = { isDeleted: false, role: { $in: CAKE_ROLES } };
    const roleParam = req.query.role;
    if (roleParam != null && roleParam !== "") {
      const role = Number(roleParam);
      if (!CAKE_ROLES.includes(role)) {
        return createError(res, 400, "Invalid role filter (4 or 5).");
      }
      filter.role = role;
    }

    const items = await User.find(filter).sort({ createdAt: -1 }).select("-password");
    const deletedItems = await User.find({
      isDeleted: true,
      role: { $in: CAKE_ROLES },
    })
      .sort({ createdAt: -1 })
      .select("-password");

    return successMessage(
      res,
      { items: items.map(sanitize), deletedItems: deletedItems.map(sanitize) },
      "Cake staff fetched successfully.",
    );
  } catch (err) {
    console.error("CakeStaff list error:", err);
    return createError(res, 500, err.message || "Failed to fetch cake staff.");
  }
};

const getOne = async (req, res) => {
  try {
    const item = await User.findOne({
      _id: req.params.id,
      isDeleted: false,
      role: { $in: CAKE_ROLES },
    }).select("-password");
    if (!item) return createError(res, 404, "Cake staff user not found.");
    return successMessage(res, sanitize(item), "Cake staff fetched successfully.");
  } catch (err) {
    console.error("CakeStaff getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch cake staff.");
  }
};

const create = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name?.trim() || !email?.trim() || !password) {
      return createError(res, 400, "Name, email and password are required.");
    }
    const roleNum = Number(role);
    if (!CAKE_ROLES.includes(roleNum)) {
      return createError(
        res,
        400,
        "Role must be 4 (Cake Designer) or 5 (Cake Order Manager).",
      );
    }
    if (String(password).length < 8) {
      return createError(res, 400, "Password must be at least 8 characters.");
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const exists = await User.findOne({ email: normalizedEmail });
    if (exists) return createError(res, 409, "Email already registered.");

    const hashedPassword = await bcrypt.hash(String(password), 10);
    const item = await User.create({
      name: String(name).trim(),
      email: normalizedEmail,
      password: hashedPassword,
      role: roleNum,
      isDeleted: false,
    });

    return successMessage(
      res,
      sanitize(item),
      "Cake staff user created successfully.",
    );
  } catch (err) {
    console.error("CakeStaff create error:", err);
    return createError(res, 500, err.message || "Failed to create cake staff.");
  }
};

const update = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
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
    if (role !== undefined) {
      const roleNum = Number(role);
      if (!CAKE_ROLES.includes(roleNum)) {
        return createError(
          res,
          400,
          "Role must be 4 (Cake Designer) or 5 (Cake Order Manager).",
        );
      }
      updatePayload.role = roleNum;
    }

    const item = await User.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false, role: { $in: CAKE_ROLES } },
      updatePayload,
      { new: true, runValidators: true },
    ).select("-password");

    if (!item) return createError(res, 404, "Cake staff user not found.");
    return successMessage(res, sanitize(item), "Cake staff updated successfully.");
  } catch (err) {
    console.error("CakeStaff update error:", err);
    return createError(res, 500, err.message || "Failed to update cake staff.");
  }
};

const remove = async (req, res) => {
  try {
    const item = await User.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false, role: { $in: CAKE_ROLES } },
      { isDeleted: true },
      { new: true },
    ).select("-password");
    if (!item) return createError(res, 404, "Cake staff user not found.");
    return successMessage(res, sanitize(item), "Cake staff removed successfully.");
  } catch (err) {
    console.error("CakeStaff remove error:", err);
    return createError(res, 500, err.message || "Failed to remove cake staff.");
  }
};

module.exports = { list, getOne, create, update, remove };
