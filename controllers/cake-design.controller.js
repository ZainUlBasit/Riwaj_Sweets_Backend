const CakeDesign = require("../Models/CakeDesigns");
const { createError, successMessage } = require("../utils/ResponseMessage");

// Cloudinary configuration for image uploads
const cloudinary = require("cloudinary").v2;
require("dotenv").config();

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET,
  secure: true,
});

const list = async (req, res) => {
  try {
    const items = await CakeDesign.find({ isDeleted: false }).sort({
      createdAt: -1,
    });
    const deletedItems = await CakeDesign.find({ isDeleted: true }).sort({
      createdAt: -1,
    });
    return successMessage(
      res,
      { items, deletedItems },
      "Cake designs fetched successfully.",
    );
  } catch (err) {
    console.error("CakeDesign list error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to fetch cake designs.",
    );
  }
};

const getOne = async (req, res) => {
  try {
    const item = await CakeDesign.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!item) return createError(res, 404, "Cake design not found.");
    return successMessage(res, item, "Cake design fetched successfully.");
  } catch (err) {
    console.error("CakeDesign getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch cake design.");
  }
};

// Coerce the multipart form / JSON `price_per_pound` value into a non-negative
// number. Returns `null` if the input is unparseable so callers can surface a
// 400. Empty / undefined inputs resolve to 0 so older clients keep working.
const parsePricePerPound = (value) => {
  if (value === undefined || value === null || value === "") return 0;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
};

const create = async (req, res) => {
  try {
    const { title, description, price_per_pound } = req.body;
    if (!title || !description) {
      return createError(res, 400, "Title and description are required.");
    }
    if (!req.file) {
      return createError(res, 400, "Image is required.");
    }
    const pricePerPound = parsePricePerPound(price_per_pound);
    if (pricePerPound === null) {
      return createError(
        res,
        400,
        "price_per_pound must be a non-negative number.",
      );
    }
    let cakeDesignImageUrl = null;
    try {
      cakeDesignImageUrl = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: "cake-designs" },
          (error, result) => {
            if (error) reject(error);
            else resolve(result.secure_url);
          },
        );
        stream.end(req.file.buffer);
      });
    } catch (uploadError) {
      console.error("Image upload failed:", uploadError);
      return createError(
        res,
        500,
        "Failed to upload cake design image: " + uploadError.message,
      );
    }
    const item = await CakeDesign.create({
      title,
      image: cakeDesignImageUrl,
      description,
      price_per_pound: pricePerPound,
      isDeleted: false,
    });
    return successMessage(res, item, "Cake design created successfully.");
  } catch (err) {
    console.error("CakeDesign create error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to create cake design.",
    );
  }
};

const update = async (req, res) => {
  try {
    const { title, description, price_per_pound } = req.body;
    const updatePayload = { isDeleted: false };
    if (title !== undefined) updatePayload.title = title;
    if (description !== undefined) updatePayload.description = description;
    if (price_per_pound !== undefined) {
      const parsed = parsePricePerPound(price_per_pound);
      if (parsed === null) {
        return createError(
          res,
          400,
          "price_per_pound must be a non-negative number.",
        );
      }
      updatePayload.price_per_pound = parsed;
    }

    if (req.file) {
      try {
        const cakeDesignImageUrl = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: "cake-designs" },
            (error, result) => {
              if (error) reject(error);
              else resolve(result.secure_url);
            },
          );
          stream.end(req.file.buffer);
        });
        updatePayload.image = cakeDesignImageUrl;
      } catch (uploadError) {
        console.error("Image upload failed:", uploadError);
        return createError(
          res,
          500,
          "Failed to upload cake design image: " + uploadError.message,
        );
      }
    }

    const item = await CakeDesign.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      updatePayload,
      { new: true, runValidators: true },
    );
    if (!item) return createError(res, 404, "Cake design not found.");
    return successMessage(res, item, "Cake design updated successfully.");
  } catch (err) {
    console.error("CakeDesign update error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to update cake design.",
    );
  }
};

const remove = async (req, res) => {
  try {
    const item = await CakeDesign.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true },
    );
    if (!item) return createError(res, 404, "Cake design not found.");
    return successMessage(res, item, "Cake design deleted successfully.");
  } catch (err) {
    console.error("CakeDesign remove error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to delete cake design.",
    );
  }
};

module.exports = { list, getOne, create, update, remove };
