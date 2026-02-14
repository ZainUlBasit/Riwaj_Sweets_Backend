const Supplier = require("../Models/Supplier");
const { createError, successMessage } = require("../utils/ResponseMessage");

/**
 * GET /api/supplier
 * List all suppliers
 */
const list = async (req, res) => {
  try {
    const suppliers = await Supplier.find({ isDeleted: false }).sort({
      createdAt: -1,
    });
    const deletedSuppliers = await Supplier.find({ isDeleted: true }).sort({
      createdAt: -1,
    });
    return successMessage(
      res,
      {
        suppliers: suppliers,
        deletedSuppliers: deletedSuppliers,
      },
      "Suppliers fetched successfully.",
    );
  } catch (err) {
    console.error("Supplier list error:", err);
    return createError(res, 500, err.message || "Failed to fetch suppliers.");
  }
};

/**
 * GET /api/supplier/:id
 * Get a single supplier by id
 */
const getOne = async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!supplier) {
      return createError(res, 404, "Supplier not found.");
    }
    return successMessage(res, supplier, "Supplier fetched successfully.");
  } catch (err) {
    console.error("Supplier getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch supplier.");
  }
};

/**
 * POST /api/supplier
 * Create a new supplier
 */
const create = async (req, res) => {
  try {
    const { name, contact, address, desc, paid } = req.body;
    if (!name || !contact) {
      return createError(res, 400, "Name and contact are required.");
    }
    const supplier = await Supplier.create({
      name,
      contact,
      address: address ?? "",
      desc: desc ?? "",
      paid: paid ?? 0,
      isDeleted: false,
    });
    return successMessage(res, supplier, "Supplier created successfully.");
  } catch (err) {
    console.error("Supplier create error:", err);
    return createError(res, 500, err.message || "Failed to create supplier.");
  }
};

/**
 * PUT /api/supplier/:id
 * Update a supplier by id
 */
const update = async (req, res) => {
  try {
    const { name, contact, address, desc, paid } = req.body;
    const supplier = await Supplier.findByIdAndUpdate(
      req.params.id,
      { name, contact, address, desc, paid, isDeleted: false },
      { new: true, runValidators: true },
    );
    if (!supplier) {
      return createError(res, 404, "Supplier not found.");
    }
    return successMessage(res, supplier, "Supplier updated successfully.");
  } catch (err) {
    console.error("Supplier update error:", err);
    return createError(res, 500, err.message || "Failed to update supplier.");
  }
};

/**
 * DELETE /api/supplier/:id
 * Delete a supplier by id
 */
const remove = async (req, res) => {
  try {
    const supplier = await Supplier.findByIdAndDelete(req.params.id);
    if (!supplier) {
      return createError(res, 404, "Supplier not found.");
    }
    return successMessage(res, supplier, "Supplier deleted successfully.");
  } catch (err) {
    console.error("Supplier remove error:", err);
    return createError(res, 500, err.message || "Failed to delete supplier.");
  }
};

module.exports = {
  list,
  getOne,
  create,
  update,
  remove,
};
