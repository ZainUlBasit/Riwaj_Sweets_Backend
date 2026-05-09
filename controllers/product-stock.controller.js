const ProductStock = require("../Models/ProductStock");
const Product = require("../Models/Products");
const RawMaterial = require("../Models/RawMaterial");
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
    const qty = quantity ?? 0;
    const product = await Product.findById(product_id).where({ isDeleted: false });
    if (!product) return createError(res, 404, "Product not found.");

    const item = await ProductStock.create({
      product_id,
      desc: desc ?? "",
      quantity: qty,
      price: price ?? 0,
      total_price: total_price ?? qty * (price ?? 0),
      raw_materials_used: Array.isArray(raw_materials_used) ? raw_materials_used : [],
      isDeleted: false,
    });

    // Product ki in_quantity aur available_quantity increase (jaise raw-material-stock se RawMaterial)
    await Product.findByIdAndUpdate(product_id, {
      $inc: { in_quantity: qty, available_quantity: qty },
    });

    // Raw materials use hue to unki out_quantity / available_quantity adjust
    if (Array.isArray(raw_materials_used)) {
      for (const rm of raw_materials_used) {
        if (rm.raw_material_id && rm.quantity_used != null) {
          await RawMaterial.findByIdAndUpdate(rm.raw_material_id, {
            $inc: { out_quantity: rm.quantity_used, available_quantity: -rm.quantity_used },
          });
        }
      }
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
    const oldItem = await ProductStock.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!oldItem) return createError(res, 404, "Product stock entry not found.");

    const oldQty = oldItem.quantity ?? 0;
    const newQty = quantity ?? oldItem.quantity ?? 0;
    const newProductId = product_id ?? oldItem.product_id;

    // Purane product se in_quantity aur available_quantity decrement
    await Product.findByIdAndUpdate(oldItem.product_id, {
      $inc: { in_quantity: -oldQty, available_quantity: -oldQty },
    });

    const updatePayload = {
      product_id: newProductId,
      desc: desc !== undefined ? desc : oldItem.desc,
      quantity: newQty,
      price: price !== undefined ? price : oldItem.price,
      total_price: total_price !== undefined ? total_price : newQty * (price ?? oldItem.price ?? 0),
      isDeleted: false,
    };
    if (Array.isArray(raw_materials_used)) updatePayload.raw_materials_used = raw_materials_used;

    const item = await ProductStock.findByIdAndUpdate(
      req.params.id,
      updatePayload,
      { new: true, runValidators: true }
    );

    // Naye product par in_quantity aur available_quantity increment
    await Product.findByIdAndUpdate(newProductId, {
      $inc: { in_quantity: newQty, available_quantity: newQty },
    });

    return successMessage(res, item, "Product stock updated successfully.");
  } catch (err) {
    console.error("ProductStock update error:", err);
    return createError(res, 500, err.message || "Failed to update product stock.");
  }
};

const remove = async (req, res) => {
  try {
    const item = await ProductStock.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!item) return createError(res, 404, "Product stock entry not found.");

    const qty = item.quantity ?? 0;
    // Product se in_quantity aur available_quantity decrement
    await Product.findByIdAndUpdate(item.product_id, {
      $inc: { in_quantity: -qty, available_quantity: -qty },
    });

    // Soft-delete the stock entry. The active-doc filter above guarantees
    // the inventory reversal runs at most once per entry.
    const deleted = await ProductStock.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true }
    );

    return successMessage(res, deleted || item, "Product stock deleted successfully.");
  } catch (err) {
    console.error("ProductStock remove error:", err);
    return createError(res, 500, err.message || "Failed to delete product stock.");
  }
};

module.exports = { list, getOne, create, update, remove };
