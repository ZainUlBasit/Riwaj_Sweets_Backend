const Product = require("../Models/Products");
const { createError, successMessage } = require("../utils/ResponseMessage");

// Cloudinary configuration for product image uploads. Same env vars as
// cake-design (CLOUD_NAME / API_KEY / API_SECRET) so a single Cloudinary
// account serves the whole app.
const cloudinary = require("cloudinary").v2;
require("dotenv").config();

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
  secure: true,
});

// Streams a multer-memory file buffer to Cloudinary and resolves with the
// final secure URL. Centralised here so create/update share one code path.
const uploadProductImage = (file) =>
  new Promise((resolve, reject) => {
    if (!file?.buffer) {
      resolve(null);
      return;
    }
    const stream = cloudinary.uploader.upload_stream(
      { folder: "products" },
      (error, result) => {
        if (error) reject(error);
        else resolve(result?.secure_url || null);
      },
    );
    stream.end(file.buffer);
  });

// Multer ships everything as strings (multipart/form-data). Coerce a value
// into a non-negative finite number; returns `null` on a parse failure so
// callers can return a 400 instead of silently writing NaN.
const parseNonNegativeNumber = (value, { fallback = 0 } = {}) => {
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
};

const list = async (req, res) => {
  try {
    const items = await Product.find({ isDeleted: false })
      .populate("category_id")
      .populate("counter_id")
      .sort({ createdAt: -1 });
    const deletedItems = await Product.find({ isDeleted: true })
      .populate("category_id")
      .populate("counter_id")
      .sort({ createdAt: -1 });
    return successMessage(
      res,
      {
        items,
        deletedItems,
        products: items,
        deletedProducts: deletedItems,
      },
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
      .populate("counter_id")
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
    const {
      name,
      category_id,
      price,
      unit,
      in_quantity,
      out_quantity,
      available_quantity,
      counter_id,
    } = req.body;

    if (!name || !category_id || !unit) {
      return createError(res, 400, "Name, category_id and unit are required.");
    }

    const priceNum = parseNonNegativeNumber(price);
    const inQty = parseNonNegativeNumber(in_quantity);
    const outQty = parseNonNegativeNumber(out_quantity);
    const availQty = parseNonNegativeNumber(available_quantity);
    if ([priceNum, inQty, outQty, availQty].some((v) => v === null)) {
      return createError(
        res,
        400,
        "Price and quantities must be non-negative numbers.",
      );
    }

    let imageUrl = null;
    if (req.file) {
      try {
        imageUrl = await uploadProductImage(req.file);
      } catch (uploadError) {
        console.error("Product image upload failed:", uploadError);
        return createError(
          res,
          500,
          "Failed to upload product image: " + uploadError.message,
        );
      }
    }

    const payload = {
      name,
      category_id,
      price: priceNum,
      unit: Number(unit),
      in_quantity: inQty,
      out_quantity: outQty,
      available_quantity: availQty,
      isDeleted: false,
    };
    if (imageUrl) payload.image = imageUrl;
    if (counter_id !== undefined && counter_id !== null && counter_id !== "") {
      payload.counter_id = counter_id;
    }

    const product = await Product.create(payload);
    return successMessage(res, product, "Product created successfully.");
  } catch (err) {
    console.error("Product create error:", err);
    return createError(res, 500, err.message || "Failed to create product.");
  }
};

const update = async (req, res) => {
  try {
    const {
      name,
      category_id,
      price,
      unit,
      in_quantity,
      out_quantity,
      available_quantity,
      counter_id,
      remove_image,
    } = req.body;

    const updatePayload = { isDeleted: false };
    if (name !== undefined) updatePayload.name = name;
    if (category_id !== undefined) updatePayload.category_id = category_id;
    if (unit !== undefined) updatePayload.unit = Number(unit);

    if (price !== undefined) {
      const parsed = parseNonNegativeNumber(price);
      if (parsed === null) {
        return createError(res, 400, "Price must be a non-negative number.");
      }
      updatePayload.price = parsed;
    }
    if (in_quantity !== undefined) {
      const parsed = parseNonNegativeNumber(in_quantity);
      if (parsed === null) {
        return createError(res, 400, "in_quantity must be non-negative.");
      }
      updatePayload.in_quantity = parsed;
    }
    if (out_quantity !== undefined) {
      const parsed = parseNonNegativeNumber(out_quantity);
      if (parsed === null) {
        return createError(res, 400, "out_quantity must be non-negative.");
      }
      updatePayload.out_quantity = parsed;
    }
    if (available_quantity !== undefined) {
      const parsed = parseNonNegativeNumber(available_quantity);
      if (parsed === null) {
        return createError(
          res,
          400,
          "available_quantity must be non-negative.",
        );
      }
      updatePayload.available_quantity = parsed;
    }
    if (counter_id !== undefined) {
      updatePayload.counter_id = counter_id || null;
    }

    // Image handling:
    //   - new file uploaded -> replace `image` with new Cloudinary URL
    //   - explicit `remove_image=true` -> clear the image
    //   - otherwise leave the existing image untouched
    if (req.file) {
      try {
        const imageUrl = await uploadProductImage(req.file);
        if (imageUrl) updatePayload.image = imageUrl;
      } catch (uploadError) {
        console.error("Product image upload failed:", uploadError);
        return createError(
          res,
          500,
          "Failed to upload product image: " + uploadError.message,
        );
      }
    } else if (
      remove_image === true ||
      remove_image === "true" ||
      remove_image === "1"
    ) {
      updatePayload.image = null;
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      updatePayload,
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
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true },
    );
    if (!product) return createError(res, 404, "Product not found.");
    return successMessage(res, product, "Product deleted successfully.");
  } catch (err) {
    console.error("Product remove error:", err);
    return createError(res, 500, err.message || "Failed to delete product.");
  }
};

module.exports = { list, getOne, create, update, remove };
