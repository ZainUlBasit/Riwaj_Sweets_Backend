const Category = require("../Models/Category");
const { createError, successMessage } = require("../utils/ResponseMessage");

const list = async (req, res) => {
  try {
    const categories = await Category.find({ isDeleted: false }).sort({
      createdAt: -1,
    });
    const deletedCategories = await Category.find({ isDeleted: true }).sort({
      createdAt: -1,
    });
    return successMessage(
      res,
      { categories, deletedCategories },
      "Categories fetched successfully."
    );
  } catch (err) {
    console.error("Category list error:", err);
    return createError(res, 500, err.message || "Failed to fetch categories.");
  }
};

const getOne = async (req, res) => {
  try {
    const category = await Category.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!category) return createError(res, 404, "Category not found.");
    return successMessage(res, category, "Category fetched successfully.");
  } catch (err) {
    console.error("Category getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch category.");
  }
};

const create = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return createError(res, 400, "Name is required.");
    const category = await Category.create({ name, isDeleted: false });
    return successMessage(res, category, "Category created successfully.");
  } catch (err) {
    console.error("Category create error:", err);
    return createError(res, 500, err.message || "Failed to create category.");
  }
};

const update = async (req, res) => {
  try {
    const { name } = req.body;
    const category = await Category.findByIdAndUpdate(
      req.params.id,
      { name, isDeleted: false },
      { new: true, runValidators: true }
    );
    if (!category) return createError(res, 404, "Category not found.");
    return successMessage(res, category, "Category updated successfully.");
  } catch (err) {
    console.error("Category update error:", err);
    return createError(res, 500, err.message || "Failed to update category.");
  }
};

const remove = async (req, res) => {
  try {
    const category = await Category.findByIdAndDelete(req.params.id).where({
      isDeleted: false,
    });
    if (!category) return createError(res, 404, "Category not found.");
    return successMessage(res, category, "Category deleted successfully.");
  } catch (err) {
    console.error("Category remove error:", err);
    return createError(res, 500, err.message || "Failed to delete category.");
  }
};

module.exports = { list, getOne, create, update, remove };
