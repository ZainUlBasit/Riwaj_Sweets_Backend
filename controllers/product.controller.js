const Product = require("../Models/Products");
const { createError, successMessage } = require("../utils/ResponseMessage");

const list = async (req, res) => {
  try {
    const products = await Product.find({ isDeleted: false })
      .populate("category_id")
      .sort({ createdAt: -1 });
    const deletedProducts = await Product.find({ isDeleted: true })
      .populate("category_id")
      .sort({ createdAt: -1 });
    return successMessage(
      res,
      { products, deletedProducts },
      "Products fetched successfully.",
    );
  } catch (err) {
    console.error("Product list error:", err);
    return createError(res, 500, err.message || "Failed to fetch products.");
  }
};

const getOne = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
      .populate("category_id")
      .where({ isDeleted: false });
    if (!product) return createError(res, 404, "Product not found.");
    return successMessage(res, product, "Product fetched successfully.");
  } catch (err) {
    console.error("Product getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch product.");
  }
};

const create = async (req, res) => {
  try {
    const { name, category_id, price, unit, in_quantity, out_quantity, available_quantity } = req.body;
    if (!name || !category_id || !unit) {
      return createError(res, 400, "Name, category_id and unit are required.");
    }
    const product = await Product.create({
      name,
      category_id,
      price: price ?? 0,
      unit,
      in_quantity: in_quantity ?? 0,
      out_quantity: out_quantity ?? 0,
      available_quantity: available_quantity ?? 0,
      isDeleted: false,
    });
    return successMessage(res, product, "Product created successfully.");
  } catch (err) {
    console.error("Product create error:", err);
    return createError(res, 500, err.message || "Failed to create product.");
  }
};

const update = async (req, res) => {
  try {
    const { name, category_id, price, unit, in_quantity, out_quantity, available_quantity } = req.body;
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { name, category_id, price, unit, in_quantity, out_quantity, available_quantity, isDeleted: false },
      { new: true, runValidators: true },
    );
    if (!product) return createError(res, 404, "Product not found.");
    return successMessage(res, product, "Product updated successfully.");
  } catch (err) {
    console.error("Product update error:", err);
    return createError(res, 500, err.message || "Failed to update product.");
  }
};

const remove = async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id).where({
      isDeleted: false,
    });
    if (!product) return createError(res, 404, "Product not found.");
    return successMessage(res, product, "Product deleted successfully.");
  } catch (err) {
    console.error("Product remove error:", err);
    return createError(res, 500, err.message || "Failed to delete product.");
  }
};

module.exports = { list, getOne, create, update, remove };
