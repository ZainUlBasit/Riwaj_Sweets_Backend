const Supplier = require("../Models/Supplier");
const { createError, successMessage } = require("../utils/ResponseMessage");

/**
 * GET /api/supplier
 * List all suppliers
 */
const list = async (req, res) => {
  try {
    const items = await Supplier.find({ isDeleted: false }).sort({
      createdAt: -1,
    });
    const deletedItems = await Supplier.find({ isDeleted: true }).sort({
      createdAt: -1,
    });
    // Dual-emit: canonical (items/deletedItems) alongside legacy keys
    // (suppliers/deletedSuppliers) so existing consumers keep working.
    return successMessage(
      res,
      {
        items,
        deletedItems,
        suppliers: items,
        deletedSuppliers: deletedItems,
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
    const { name, contact, address, desc, paid, opening_balance, phone, city, notes } =
      req.body || {};
    if (!name || !String(name).trim()) {
      return createError(res, 400, "Name is required.");
    }
    const contactVal = String(contact || phone || "—").trim() || "—";
    const opening = Number(opening_balance) || 0;
    const paidVal = Number(paid) || 0;

    const supplier = await Supplier.create({
      name: String(name).trim(),
      contact: contactVal,
      address: address ?? city ?? "",
      desc: desc ?? notes ?? "",
      paid: paidVal,
      total_amount: opening,
      payable: Math.max(0, opening - paidVal),
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
 * Soft-delete a supplier by id (sets isDeleted: true). The record continues
 * to appear under `deletedSuppliers` / `deletedItems` in list responses.
 */
const remove = async (req, res) => {
  try {
    const supplier = await Supplier.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true },
    );
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
