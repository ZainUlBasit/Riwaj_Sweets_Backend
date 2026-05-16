const CakeOrder = require("../Models/CakeOrder");
const { createError, successMessage } = require("../utils/ResponseMessage");

const list = async (req, res) => {
  try {
    const filter = { isDeleted: false };
    const statusParam = req.query.status;
    if (statusParam != null && statusParam !== "") {
      const status = Number(statusParam);
      if (!Number.isFinite(status) || status < 1 || status > 5) {
        return createError(res, 400, "Invalid status filter (1–5).");
      }
      filter.status = status;
    }

    const items = await CakeOrder.find(filter)
      .populate("cake_design_id")
      .sort({ createdAt: -1 });
    const deletedItems = await CakeOrder.find({ isDeleted: true })
      .populate("cake_design_id")
      .sort({ createdAt: -1 });
    return successMessage(
      res,
      { items, deletedItems },
      "Cake orders fetched successfully.",
    );
  } catch (err) {
    console.error("CakeOrder list error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to fetch cake orders.",
    );
  }
};

const getOne = async (req, res) => {
  try {
    const item = await CakeOrder.findById(req.params.id)
      .populate("cake_design_id")
      .where({ isDeleted: false });
    if (!item) return createError(res, 404, "Cake order not found.");
    return successMessage(res, item, "Cake order fetched successfully.");
  } catch (err) {
    console.error("CakeOrder getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch cake order.");
  }
};

const create = async (req, res) => {
  try {
    const { cake_design_id, pound, customization_rupees } = req.body;
    if (!cake_design_id || pound == null) {
      return createError(
        res,
        400,
        "cake_design_id and pound are required.",
      );
    }
    const item = await CakeOrder.create({
      cake_design_id,
      pound: Number(pound),
      customization_rupees: customization_rupees != null ? Number(customization_rupees) : 0,
      status: 1,
      isDeleted: false,
    });
    return successMessage(res, item, "Cake order created successfully.");
  } catch (err) {
    console.error("CakeOrder create error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to create cake order.",
    );
  }
};

const update = async (req, res) => {
  try {
    const { cake_design_id, pound, customization_rupees, status } = req.body;
    const updatePayload = { isDeleted: false };
    if (cake_design_id !== undefined) updatePayload.cake_design_id = cake_design_id;
    if (pound !== undefined) updatePayload.pound = Number(pound);
    if (customization_rupees !== undefined)
      updatePayload.customization_rupees = Number(customization_rupees);
    if (status !== undefined) {
      const nextStatus = Number(status);
      if (!Number.isFinite(nextStatus) || nextStatus < 1 || nextStatus > 5) {
        return createError(res, 400, "Invalid status (1–5).");
      }
      updatePayload.status = nextStatus;
    }

    const item = await CakeOrder.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      updatePayload,
      { new: true, runValidators: true },
    ).populate("cake_design_id");
    if (!item) return createError(res, 404, "Cake order not found.");
    return successMessage(res, item, "Cake order updated successfully.");
  } catch (err) {
    console.error("CakeOrder update error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to update cake order.",
    );
  }
};

const remove = async (req, res) => {
  try {
    const item = await CakeOrder.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true },
    );
    if (!item) return createError(res, 404, "Cake order not found.");
    return successMessage(res, item, "Cake order deleted successfully.");
  } catch (err) {
    console.error("CakeOrder remove error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to delete cake order.",
    );
  }
};

module.exports = { list, getOne, create, update, remove };
