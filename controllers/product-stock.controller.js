const ProductStock = require("../Models/ProductStock");
const RawMaterialStock = require("../Models/RawMaterialStock");
const { createError, successMessage } = require("../utils/ResponseMessage");

const list = async (req, res) => {
  try {
    const items = await ProductStock.find({ isDeleted: false })
      .populate("product_id")
      .populate("raw_materials_used.raw_material_id")
      .sort({ createdAt: -1 });
    const deletedItems = await ProductStock.find({ isDeleted: true })
      .populate("product_id")
      .populate("raw_materials_used.raw_material_id")
      .sort({ createdAt: -1 });
    return successMessage(
      res,
      { items, deletedItems },
      "Product stock entries fetched successfully."
    );
  } catch (err) {
    console.error("ProductStock list error:", err);
    return createError(res, 500, err.message || "Failed to fetch product stock.");
  }
};

const getOne = async (req, res) => {
  try {
    const item = await ProductStock.findById(req.params.id)
      .populate("product_id")
      .populate("raw_materials_used.raw_material_id")
      .where({ isDeleted: false });
    if (!item) return createError(res, 404, "Product stock entry not found.");
    return successMessage(res, item, "Product stock fetched successfully.");
  } catch (err) {
    console.error("ProductStock getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch product stock.");
  }
};

const create = async (req, res) => {
  try {
    const { product_id, desc, quantity, price, total_price, raw_materials_used } = req.body;
    if (!product_id) {
      return createError(res, 400, "product_id is required.");
    }
    const item = await ProductStock.create({
      product_id,
      desc: desc ?? "",
      quantity: quantity ?? 0,
      price: price ?? 0,
      total_price: total_price ?? 0,
      raw_materials_used: Array.isArray(raw_materials_used) ? raw_materials_used : [],
      isDeleted: false,
    });

    // Us product stock entry par kaun kaun se raw materials kitni quantity use hue
    for (const rawMaterial of raw_materials_used) {
      await RawMaterialStock.findByIdAndUpdate(rawMaterial.raw_material_id, {
        $inc: { quantity: -rawMaterial.quantity_used },
      });
    }

    return successMessage(res, item, "Product stock entry created successfully.");
  } catch (err) {
    console.error("ProductStock create error:", err);
    return createError(res, 500, err.message || "Failed to create product stock.");
  }
};

const update = async (req, res) => {
  try {
    const { product_id, desc, quantity, price, total_price, raw_materials_used } = req.body;
    const updatePayload = {
      product_id,
      desc,
      quantity,
      price,
      total_price,
      isDeleted: false,
    };
    const oldItem = await ProductStock.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!oldItem) return createError(res, 404, "Product stock entry not found.");
    if (Array.isArray(raw_materials_used)) updatePayload.raw_materials_used = raw_materials_used;
    const item = await ProductStock.findByIdAndUpdate(
      req.params.id,
      updatePayload,
      { new: true, runValidators: true }
    );

    // Us product stock entry par kaun kaun se raw materials kitni quantity use hue
    for (const rawMaterial of raw_materials_used) {
      await RawMaterialStock.findByIdAndUpdate(rawMaterial.raw_material_id, {
        $inc: { quantity: -rawMaterial.quantity_used },
      });
    }
    // Purani raw materials used entry delete karo
    for (const rawMaterial of oldItem?.raw_materials_used ?? []) {
      await RawMaterialStock.findByIdAndUpdate(oldItem.raw_material_id, {
        $inc: { quantity: oldItem.quantity_used },
      });
    }

    if (!item) return createError(res, 404, "Product stock entry not found.");
    return successMessage(res, item, "Product stock updated successfully.");
  } catch (err) {
    console.error("ProductStock update error:", err);
    return createError(res, 500, err.message || "Failed to update product stock.");
  }
};

const remove = async (req, res) => {
  try {
    const item = await ProductStock.findByIdAndDelete(req.params.id).where({
      isDeleted: false,
    });
    if (!item) return createError(res, 404, "Product stock entry not found.");
    // Purani raw materials used entry delete karo
    for (const rawMaterial of item?.raw_materials_used ?? []) {
      await RawMaterialStock.findByIdAndUpdate(rawMaterial.raw_material_id, {
        $inc: { quantity: rawMaterial.quantity_used },
      });
    }
    return successMessage(res, item, "Product stock deleted successfully.");
  } catch (err) {
    console.error("ProductStock remove error:", err);
    return createError(res, 500, err.message || "Failed to delete product stock.");
  }
};

module.exports = { list, getOne, create, update, remove };
