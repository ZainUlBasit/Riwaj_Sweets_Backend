const Ustad = require("../Models/Ustad");
const { createError, successMessage } = require("../utils/ResponseMessage");
const { getAssignedStoreId } = require("../utils/storeScope");

const parseMoney = (raw) => {
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
};
/**
 * GET /api/ustad
 */
const list = async (req, res) => {
  try {
    const filter = { isDeleted: false };
    const activeOnly = String(req.query.active || "") === "1";
    if (activeOnly) filter.isActive = true;

    const assignedStoreId = getAssignedStoreId(req);
    if (assignedStoreId) {
      filter.$or = [
        { store_id: assignedStoreId },
        { store_id: null },
        { store_id: { $exists: false } },
      ];
    } else if (req.query.store_id) {
      filter.store_id = req.query.store_id;
    }

    const items = await Ustad.find(filter)
      .populate("store_id", "name")
      .sort({ name: 1, createdAt: -1 });
    const deletedItems = await Ustad.find({ isDeleted: true })
      .populate("store_id", "name")
      .sort({ name: 1 });

    return successMessage(
      res,
      { items, deletedItems, ustads: items },
      "Ustads fetched successfully.",
    );
  } catch (err) {
    console.error("Ustad list error:", err);
    return createError(res, 500, err.message || "Failed to fetch ustads.");
  }
};

const getOne = async (req, res) => {
  try {
    const item = await Ustad.findById(req.params.id)
      .where({ isDeleted: false })
      .populate("store_id", "name");
    if (!item) return createError(res, 404, "Ustad not found.");
    return successMessage(res, item, "Ustad fetched successfully.");
  } catch (err) {
    console.error("Ustad getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch ustad.");
  }
};

const create = async (req, res) => {
  try {
    const {
      name,
      phone,
      notes,
      store_id,
      isActive,
      salary,
      bejli_expense,
      meal_expense,
      tea_expense,
    } = req.body || {};
    const trimmed = String(name || "").trim();
    if (!trimmed) return createError(res, 400, "Ustad name is required.");

    const parsedSalary = parseMoney(salary);
    const parsedBejli = parseMoney(bejli_expense);
    const parsedMeal = parseMoney(meal_expense);
    const parsedTea = parseMoney(tea_expense);
    if (parsedSalary === null) {
      return createError(res, 400, "Valid salary enter karein (0 ya zyada).");
    }
    if (parsedBejli === null) {
      return createError(res, 400, "Valid bejli expense enter karein (0 ya zyada).");
    }
    if (parsedMeal === null) {
      return createError(res, 400, "Valid meal expense enter karein (0 ya zyada).");
    }
    if (parsedTea === null) {
      return createError(res, 400, "Valid tae expense enter karein (0 ya zyada).");
    }

    const assignedStoreId = getAssignedStoreId(req);
    const storeId = store_id || assignedStoreId || null;

    const duplicate = await Ustad.findOne({
      name: new RegExp(
        `^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "i",
      ),
      isDeleted: false,
      ...(storeId ? { store_id: storeId } : {}),
    });
    if (duplicate) {
      return createError(res, 409, "Is naam ka ustad pehle se registered hai.");
    }

    const item = await Ustad.create({
      name: trimmed,
      phone: String(phone || "").trim(),
      notes: String(notes || "").trim(),
      salary: parsedSalary,
      bejli_expense: parsedBejli,
      meal_expense: parsedMeal,
      tea_expense: parsedTea,
      store_id: storeId,
      isActive: isActive === false ? false : true,
      isDeleted: false,
    });

    return successMessage(res, item, "Ustad registered successfully.");
  } catch (err) {
    console.error("Ustad create error:", err);
    return createError(res, 500, err.message || "Failed to register ustad.");
  }
};

const update = async (req, res) => {
  try {
    const existing = await Ustad.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!existing) return createError(res, 404, "Ustad not found.");

    const {
      name,
      phone,
      notes,
      store_id,
      isActive,
      salary,
      bejli_expense,
      meal_expense,
      tea_expense,
    } = req.body || {};
    const payload = {};
    if (name !== undefined) {
      const trimmed = String(name || "").trim();
      if (!trimmed) return createError(res, 400, "Ustad name is required.");
      payload.name = trimmed;
    }
    if (phone !== undefined) payload.phone = String(phone || "").trim();
    if (notes !== undefined) payload.notes = String(notes || "").trim();
    if (salary !== undefined) {
      const parsedSalary = parseMoney(salary);
      if (parsedSalary === null) {
        return createError(res, 400, "Valid salary enter karein (0 ya zyada).");
      }
      payload.salary = parsedSalary;
    }
    if (bejli_expense !== undefined) {
      const parsedBejli = parseMoney(bejli_expense);
      if (parsedBejli === null) {
        return createError(res, 400, "Valid bejli expense enter karein (0 ya zyada).");
      }
      payload.bejli_expense = parsedBejli;
    }
    if (meal_expense !== undefined) {
      const parsedMeal = parseMoney(meal_expense);
      if (parsedMeal === null) {
        return createError(res, 400, "Valid meal expense enter karein (0 ya zyada).");
      }
      payload.meal_expense = parsedMeal;
    }
    if (tea_expense !== undefined) {
      const parsedTea = parseMoney(tea_expense);
      if (parsedTea === null) {
        return createError(res, 400, "Valid tae expense enter karein (0 ya zyada).");
      }
      payload.tea_expense = parsedTea;
    }
    if (store_id !== undefined) payload.store_id = store_id || null;
    if (isActive !== undefined) payload.isActive = !!isActive;

    const item = await Ustad.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    }).populate("store_id", "name");

    return successMessage(res, item, "Ustad updated successfully.");
  } catch (err) {
    console.error("Ustad update error:", err);
    return createError(res, 500, err.message || "Failed to update ustad.");
  }
};

const remove = async (req, res) => {
  try {
    const item = await Ustad.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true, isActive: false },
      { new: true },
    );
    if (!item) return createError(res, 404, "Ustad not found.");
    return successMessage(res, item, "Ustad removed successfully.");
  } catch (err) {
    console.error("Ustad remove error:", err);
    return createError(res, 500, err.message || "Failed to remove ustad.");
  }
};

module.exports = { list, getOne, create, update, remove };
