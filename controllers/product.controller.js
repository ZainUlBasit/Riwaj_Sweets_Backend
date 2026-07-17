const Product = require("../Models/Products");
const Category = require("../Models/Category");
const LocationInventory = require("../Models/LocationInventory");
const DispatchLocation = require("../Models/DispatchLocation");
const { createError, successMessage } = require("../utils/ResponseMessage");
const { LOCATION_TYPE } = require("../Services/inventoryService");

const UNIT_LABEL_TO_ID = {
  kg: 1,
  bag: 2,
  piece: 3,
  liter: 4,
  litre: 4,
  ounce: 5,
  pound: 6,
  gallon: 7,
  quart: 8,
  pint: 9,
  cup: 10,
};

const resolveUnit = (value) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= 1 && value <= 10 ? value : null;
  }
  const raw = String(value).trim();
  const asNum = Number(raw);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= 10) return asNum;
  const key = raw.toLowerCase();
  return UNIT_LABEL_TO_ID[key] ?? null;
};

const normalizeHeaderKey = (key) =>
  String(key || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

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

/** Parse BOM from JSON body or multipart string. Returns array or null on bad input. */
const parseBom = (raw) => {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return [];
  let arr = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr)) return null;

  const out = [];
  const seen = new Set();
  for (const row of arr) {
    const rmId = row?.rawMaterialId || row?.raw_material_id;
    const qty = Number(row?.quantity_required_per_unit ?? row?.quantity);
    if (!rmId || !Number.isFinite(qty) || qty < 0) return null;
    if (qty === 0) continue;
    const key = String(rmId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      rawMaterialId: rmId,
      quantity_required_per_unit: qty,
    });
  }
  return out;
};

/** Aggregates per-product qty in main stores vs shops from LocationInventory. */
async function buildLocationStockMaps() {
  const rows = await LocationInventory.aggregate([
    { $match: { isDeleted: false, quantity: { $gt: 0 } } },
    {
      $lookup: {
        from: "dispatchlocations",
        localField: "location_id",
        foreignField: "_id",
        as: "location",
      },
    },
    { $unwind: { path: "$location", preserveNullAndEmptyArrays: false } },
    { $match: { "location.isDeleted": false } },
    {
      $group: {
        _id: {
          product_id: "$product_id",
          location_type: "$location.location_type",
        },
        totalQty: { $sum: "$quantity" },
      },
    },
  ]);

  const mainStore = new Map();
  const shop = new Map();
  for (const row of rows) {
    const pid = String(row._id.product_id);
    const locType = Number(row._id.location_type);
    const qty = Number(row.totalQty || 0);
    if (locType === LOCATION_TYPE.FINISHED_GOODS_STORE) {
      mainStore.set(pid, (mainStore.get(pid) || 0) + qty);
    } else if (locType === LOCATION_TYPE.SHOP) {
      shop.set(pid, (shop.get(pid) || 0) + qty);
    }
  }
  return { mainStore, shop };
}

const attachLocationStock = (product, mainStore, shop) => {
  const doc = product.toObject ? product.toObject() : { ...product };
  const pid = String(doc._id);
  doc.main_store_quantity = mainStore.get(pid) || 0;
  doc.shop_quantity = shop.get(pid) || 0;
  return doc;
};

const list = async (req, res) => {
  try {
    const [{ mainStore, shop }, rawItems, rawDeleted] = await Promise.all([
      buildLocationStockMaps(),
      Product.find({ isDeleted: false })
        .populate("category_id")
        .populate("counter_id")
        .populate("bom.rawMaterialId")
        .sort({ createdAt: -1 }),
      Product.find({ isDeleted: true })
        .populate("category_id")
        .populate("counter_id")
        .populate("bom.rawMaterialId")
        .sort({ createdAt: -1 }),
    ]);

    const items = rawItems.map((p) => attachLocationStock(p, mainStore, shop));
    const deletedItems = rawDeleted.map((p) =>
      attachLocationStock(p, mainStore, shop),
    );

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

/**
 * GET /api/product/location-stock?location_id=
 * Products with quantity at a specific dispatch location (main store, shop, etc.).
 */
const locationStock = async (req, res) => {
  try {
    const { location_id: locationId } = req.query || {};
    if (!locationId) {
      return createError(res, 400, "location_id is required.");
    }

    const location = await DispatchLocation.findById(locationId).where({
      isDeleted: false,
    });
    if (!location) return createError(res, 404, "Location not found.");

    const invRows = await LocationInventory.find({
      location_id: locationId,
      isDeleted: false,
      quantity: { $gt: 0 },
    })
      .populate({
        path: "product_id",
        populate: [{ path: "category_id" }, { path: "counter_id" }],
      })
      .sort({ updatedAt: -1 });

    const items = invRows
      .filter((row) => row.product_id && !row.product_id.isDeleted)
      .map((row) => ({
        product: row.product_id,
        quantity: Number(row.quantity || 0),
        location_id: locationId,
        location_type: location.location_type,
        location_name: location.name,
      }));

    return successMessage(
      res,
      {
        items,
        location: {
          _id: location._id,
          name: location.name,
          location_type: location.location_type,
        },
      },
      "Location product stock fetched.",
    );
  } catch (err) {
    console.error("Product locationStock error:", err);
    return createError(res, 500, err.message || "Failed to fetch location stock.");
  }
};

const getOne = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
      .populate("category_id")
      .populate("counter_id")
      .populate("bom.rawMaterialId")
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
      bom,
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

    const parsedBom = parseBom(bom);
    if (bom !== undefined && parsedBom === null) {
      return createError(
        res,
        400,
        "Invalid bom. Expected [{ rawMaterialId, quantity_required_per_unit }].",
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
    if (parsedBom !== undefined) payload.bom = parsedBom;

    const product = await Product.create(payload);
    const populated = await Product.findById(product._id)
      .populate("category_id")
      .populate("counter_id")
      .populate("bom.rawMaterialId");
    return successMessage(res, populated || product, "Product created successfully.");
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
      bom,
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
    if (bom !== undefined) {
      const parsedBom = parseBom(bom);
      if (parsedBom === null) {
        return createError(
          res,
          400,
          "Invalid bom. Expected [{ rawMaterialId, quantity_required_per_unit }].",
        );
      }
      updatePayload.bom = parsedBom;
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
    )
      .populate("category_id")
      .populate("counter_id")
      .populate("bom.rawMaterialId");
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

/**
 * POST /api/product/import
 *
 * Body: { products: Array<{ name, category|category_name, unit, price?, ... }> }
 * Resolves category by name (creates if missing). Optional `id`/`product_code`
 * sets Products.id for barcode item codes.
 */
const importBulk = async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.products) ? req.body.products : null;
    if (!rows || rows.length === 0) {
      return createError(res, 400, "products array is required.");
    }
    if (rows.length > 500) {
      return createError(res, 400, "Maximum 500 products per import.");
    }

    const categories = await Category.find({ isDeleted: false });
    const categoryByName = new Map(
      categories.map((c) => [String(c.name).trim().toLowerCase(), c]),
    );

    const created = [];
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const rowNum = i + 1;
      const raw = rows[i] || {};
      // Accept both normalized keys and common Excel header aliases.
      const get = (...keys) => {
        for (const k of keys) {
          if (raw[k] !== undefined && raw[k] !== null && raw[k] !== "") {
            return raw[k];
          }
          const nk = normalizeHeaderKey(k);
          for (const [rk, rv] of Object.entries(raw)) {
            if (normalizeHeaderKey(rk) === nk && rv !== undefined && rv !== null && rv !== "") {
              return rv;
            }
          }
        }
        return undefined;
      };

      try {
        const name = String(get("name", "product_name", "product") || "").trim();
        const categoryName = String(
          get("category", "category_name") || "",
        ).trim();
        const unit = resolveUnit(get("unit", "unit_id", "uom"));
        const priceNum = parseNonNegativeNumber(get("price", "sale_price"), {
          fallback: 0,
        });
        const inQty = parseNonNegativeNumber(
          get("in_quantity", "in_qty", "stock_in"),
          { fallback: 0 },
        );
        const outQty = parseNonNegativeNumber(
          get("out_quantity", "out_qty", "stock_out"),
          { fallback: 0 },
        );
        const availQty = parseNonNegativeNumber(
          get("available_quantity", "available_qty", "stock", "qty"),
          { fallback: 0 },
        );
        const productCodeRaw = get("id", "product_code", "item_code", "code");

        if (!name) {
          errors.push({ row: rowNum, message: "Name is required." });
          continue;
        }
        if (!categoryName) {
          errors.push({ row: rowNum, message: "Category is required." });
          continue;
        }
        if (unit == null) {
          errors.push({
            row: rowNum,
            message:
              "Unit is required (1-10 or Kg/Bag/Piece/Liter/Ounce/Pound/Gallon/Quart/Pint/Cup).",
          });
          continue;
        }
        if ([priceNum, inQty, outQty, availQty].some((v) => v === null)) {
          errors.push({
            row: rowNum,
            message: "Price and quantities must be non-negative numbers.",
          });
          continue;
        }

        let category = categoryByName.get(categoryName.toLowerCase());
        if (!category) {
          category = await Category.create({
            name: categoryName,
            isDeleted: false,
          });
          categoryByName.set(categoryName.toLowerCase(), category);
        }

        const payload = {
          name,
          category_id: category._id,
          unit,
          price: priceNum,
          in_quantity: inQty,
          out_quantity: outQty,
          available_quantity: availQty,
          isDeleted: false,
        };

        if (productCodeRaw !== undefined) {
          const code = Number(productCodeRaw);
          if (!Number.isInteger(code) || code <= 0) {
            errors.push({
              row: rowNum,
              message: "id/product_code must be a positive integer.",
            });
            continue;
          }
          const existing = await Product.findOne({
            id: code,
            isDeleted: false,
          }).select("_id");
          if (existing) {
            errors.push({
              row: rowNum,
              message: `Product code ${code} already exists.`,
            });
            continue;
          }
          payload.id = code;
        }

        const product = await Product.create(payload);
        created.push(product);
      } catch (rowErr) {
        errors.push({
          row: rowNum,
          message: rowErr.message || "Failed to import row.",
        });
      }
    }

    return successMessage(
      res,
      {
        created_count: created.length,
        error_count: errors.length,
        created,
        errors,
      },
      `Imported ${created.length} product(s). ${errors.length} row(s) failed.`,
    );
  } catch (err) {
    console.error("Product importBulk error:", err);
    return createError(res, 500, err.message || "Failed to import products.");
  }
};

module.exports = {
  list,
  getOne,
  create,
  update,
  remove,
  locationStock,
  importBulk,
};
