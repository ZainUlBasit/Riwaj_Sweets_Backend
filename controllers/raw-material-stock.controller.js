const RawMaterialStock = require("../Models/RawMaterialStock");
const RawMaterial = require("../Models/RawMaterial");
const Supplier = require("../Models/Supplier");
const { createError, successMessage } = require("../utils/ResponseMessage");

const list = async (req, res) => {
  try {
    const items = await RawMaterialStock.find({ isDeleted: false })
      .populate("raw_material_id")
      .sort({ createdAt: -1 });
    const deletedItems = await RawMaterialStock.find({ isDeleted: true })
      .populate("raw_material_id")
      .sort({ createdAt: -1 });
    return successMessage(
      res,
      { items, deletedItems },
      "Raw material stock entries fetched successfully."
    );
  } catch (err) {
    console.error("RawMaterialStock list error:", err);
    return createError(res, 500, err.message || "Failed to fetch raw material stock.");
  }
};

const getOne = async (req, res) => {
  try {
    const item = await RawMaterialStock.findById(req.params.id)
      .populate("raw_material_id")
      .where({ isDeleted: false });
    if (!item) return createError(res, 404, "Raw material stock entry not found.");
    return successMessage(res, item, "Raw material stock fetched successfully.");
  } catch (err) {
    console.error("RawMaterialStock getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch raw material stock.");
  }
};

const create = async (req, res) => {
  try {
    const { raw_material_id, desc, quantity, price, total_price } = req.body;
    if (!raw_material_id) {
      return createError(res, 400, "raw_material_id is required.");
    }
    const qty = quantity ?? 0;
    const prc = price ?? 0;
    const totalPrice = total_price ?? qty * prc;

    const rawMaterial = await RawMaterial.findById(raw_material_id).where({
      isDeleted: false,
    });
    if (!rawMaterial) {
      return createError(res, 404, "Raw material not found.");
    }

    const item = await RawMaterialStock.create({
      raw_material_id,
      desc: desc ?? "",
      quantity: qty,
      price: prc,
      total_price: totalPrice,
      isDeleted: false,
    });

    // Us raw material ke supplier ka total_amount aur payable increase karo
    await Supplier.findByIdAndUpdate(rawMaterial.supplier_id, {
      $inc: { total_amount: totalPrice, payable: totalPrice },
    });

    return successMessage(res, item, "Raw material stock entry created successfully.");
  } catch (err) {
    console.error("RawMaterialStock create error:", err);
    return createError(res, 500, err.message || "Failed to create raw material stock.");
  }
};

const update = async (req, res) => {
  try {
    const { raw_material_id, desc, quantity, price, total_price } = req.body;
    const item = await RawMaterialStock.findByIdAndUpdate(
      req.params.id,
      { raw_material_id, desc, quantity, price, total_price, isDeleted: false },
      { new: true, runValidators: true }
    );
    if (!item) return createError(res, 404, "Raw material stock entry not found.");
    return successMessage(res, item, "Raw material stock updated successfully.");
  } catch (err) {
    console.error("RawMaterialStock update error:", err);
    return createError(res, 500, err.message || "Failed to update raw material stock.");
  }
};

const remove = async (req, res) => {
  try {
    const item = await RawMaterialStock.findByIdAndDelete(req.params.id).where({
      isDeleted: false,
    });
    if (!item) return createError(res, 404, "Raw material stock entry not found.");
    return successMessage(res, item, "Raw material stock deleted successfully.");
  } catch (err) {
    console.error("RawMaterialStock remove error:", err);
    return createError(res, 500, err.message || "Failed to delete raw material stock.");
  }
};

module.exports = { list, getOne, create, update, remove };
