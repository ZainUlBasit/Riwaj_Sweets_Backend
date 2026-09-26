const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const Counter = require("../Models/Counter");
const Shop = require("../Models/Shop");
const Product = require("../Models/Products");
const { createError, successMessage } = require("../utils/ResponseMessage");

const COUNTER_SECRET =
  process.env.COUNTER_SECRET_KEY || process.env.ACCESS_SECRET_KEY;
const COUNTER_TOKEN_TTL = "12h";

const populate = (q) =>
  q
    .populate("assigned_products")
    .populate("shop_id", "name code shop_number location_id isActive");

const sanitize = (doc) => {
  if (!doc) return doc;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj.password_hash;
  return obj;
};

/**
 * Validates assigned_products payload. Accepts an array of strings (ids) or
 * objects with `_id` / `product_id`. Returns the cleaned ObjectId list and
 * verifies every id refers to a non-deleted Product.
 */
const resolveAssignedProducts = async (raw) => {
  if (raw === undefined) return undefined; // not touched
  if (raw === null) return [];
  if (!Array.isArray(raw)) return [];

  const ids = raw
    .map((v) =>
      typeof v === "string" ? v : v?._id ?? v?.product_id ?? null,
    )
    .filter(Boolean);

  if (ids.length === 0) return [];

  const products = await Product.find({
    _id: { $in: ids },
    isDeleted: false,
  }).select("_id");
  const validIds = new Set(products.map((p) => String(p._id)));
  return ids.filter((id) => validIds.has(String(id)));
};

const resolveShopId = async (rawShopId) => {
  if (!rawShopId) return null;
  const shop = await Shop.findById(rawShopId).where({ isDeleted: false });
  return shop || null;
};

/** User-entered counter # — positive integer, unique within shop. */
const resolveCounterNumber = (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
  return n;
};

const assertUniqueCounterNumber = async (shopId, counterNumber, excludeId) => {
  const filter = {
    shop_id: shopId,
    counter_number: counterNumber,
    isDeleted: false,
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return Counter.findOne(filter);
};

const list = async (req, res) => {
  try {
    const shopFilter = req.query?.shop_id
      ? { shop_id: req.query.shop_id }
      : {};
    const items = await populate(
      Counter.find({ isDeleted: false, ...shopFilter }).sort({
        shop_id: 1,
        counter_number: 1,
        createdAt: -1,
      }),
    );
    const deletedItems = await populate(
      Counter.find({ isDeleted: true, ...shopFilter }).sort({
        shop_id: 1,
        counter_number: 1,
        createdAt: -1,
      }),
    );
    return successMessage(
      res,
      {
        items: items.map(sanitize),
        deletedItems: deletedItems.map(sanitize),
      },
      "Counters fetched successfully.",
    );
  } catch (err) {
    console.error("Counter list error:", err);
    return createError(res, 500, err.message || "Failed to fetch counters.");
  }
};

const getOne = async (req, res) => {
  try {
    const item = await populate(
      Counter.findById(req.params.id).where({ isDeleted: false }),
    );
    if (!item) return createError(res, 404, "Counter not found.");
    return successMessage(res, sanitize(item), "Counter fetched successfully.");
  } catch (err) {
    console.error("Counter getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch counter.");
  }
};

const create = async (req, res) => {
  try {
    const {
      shop_id,
      counter_number,
      type,
      location,
      description,
      email,
      password,
      isActive,
      assigned_products,
    } = req.body;

    const shop = await resolveShopId(shop_id);
    if (!shop) {
      return createError(res, 400, "Shop select karein (Riwaj 1 / 2 / 3…).");
    }
    const counterNumber = resolveCounterNumber(counter_number);
    if (counterNumber == null) {
      return createError(res, 400, "Counter number enter karein (1, 2, 3…).");
    }
    const dupNum = await assertUniqueCounterNumber(shop._id, counterNumber);
    if (dupNum) {
      return createError(
        res,
        409,
        `Is shop pe Counter #${counterNumber} pehle se maujood hai.`,
      );
    }
    if (type == null) {
      return createError(res, 400, "Type is required (1: Cash, 2: Sale).");
    }
    if (![1, 2].includes(Number(type))) {
      return createError(res, 400, "Type must be 1 (Cash) or 2 (Sale).");
    }

    let normalizedEmail = null;
    let passwordHash = null;
    if (email || password) {
      if (!email || !password) {
        return createError(
          res,
          422,
          "Both email and password are required for counter login.",
        );
      }
      normalizedEmail = String(email).trim().toLowerCase();
      const existing = await Counter.findOne({
        email: normalizedEmail,
        isDeleted: false,
      });
      if (existing) {
        return createError(
          res,
          409,
          "A counter with this email already exists.",
        );
      }
      passwordHash = await bcrypt.hash(String(password), 10);
    }

    const products = await resolveAssignedProducts(assigned_products);

    const item = await Counter.create({
      shop_id: shop._id,
      counter_number: counterNumber,
      type: Number(type),
      location: location ?? "",
      description: description ?? "",
      email: normalizedEmail,
      password_hash: passwordHash,
      isActive: isActive == null ? true : !!isActive,
      assigned_products: products ?? [],
      isDeleted: false,
    });

    const populated = await populate(Counter.findById(item._id));
    return successMessage(
      res,
      sanitize(populated || item),
      "Counter created successfully.",
    );
  } catch (err) {
    console.error("Counter create error:", err);
    return createError(
      res,
      err.code === 11000 ? 409 : 500,
      err.code === 11000
        ? "Email already in use or counter # conflict for this shop."
        : err.message || "Failed to create counter.",
    );
  }
};

const update = async (req, res) => {
  try {
    const {
      shop_id,
      counter_number,
      type,
      location,
      description,
      email,
      password,
      isActive,
      assigned_products,
    } = req.body;

    const updatePayload = { isDeleted: false };

    if (shop_id !== undefined) {
      const shop = await resolveShopId(shop_id);
      if (!shop) {
        return createError(res, 400, "Shop select karein (Riwaj 1 / 2 / 3…).");
      }
      updatePayload.shop_id = shop._id;
    }
    if (counter_number !== undefined) {
      const counterNumber = resolveCounterNumber(counter_number);
      if (counterNumber == null) {
        return createError(res, 400, "Counter number enter karein (1, 2, 3…).");
      }
      updatePayload.counter_number = counterNumber;
    }

    // Uniqueness of (shop, counter#) after resolving final shop_id
    if (
      updatePayload.counter_number !== undefined ||
      updatePayload.shop_id !== undefined
    ) {
      const current = await Counter.findById(req.params.id).where({
        isDeleted: false,
      });
      if (!current) return createError(res, 404, "Counter not found.");
      const finalShopId = updatePayload.shop_id || current.shop_id;
      const finalNum =
        updatePayload.counter_number !== undefined
          ? updatePayload.counter_number
          : current.counter_number;
      if (finalShopId && finalNum != null) {
        const dupNum = await assertUniqueCounterNumber(
          finalShopId,
          finalNum,
          req.params.id,
        );
        if (dupNum) {
          return createError(
            res,
            409,
            `Is shop pe Counter #${finalNum} pehle se maujood hai.`,
          );
        }
      }
    }

    if (type !== undefined) {
      if (![1, 2].includes(Number(type))) {
        return createError(res, 400, "Type must be 1 (Cash) or 2 (Sale).");
      }
      updatePayload.type = Number(type);
    }
    if (location !== undefined) updatePayload.location = location;
    if (description !== undefined) updatePayload.description = description;
    if (isActive !== undefined) updatePayload.isActive = !!isActive;

    if (email !== undefined) {
      const normalized = email
        ? String(email).trim().toLowerCase()
        : null;
      if (normalized) {
        const dup = await Counter.findOne({
          email: normalized,
          _id: { $ne: req.params.id },
          isDeleted: false,
        });
        if (dup) return createError(res, 409, "Email already in use.");
      }
      updatePayload.email = normalized;
    }
    if (password) {
      updatePayload.password_hash = await bcrypt.hash(String(password), 10);
    }

    const products = await resolveAssignedProducts(assigned_products);
    if (products !== undefined) updatePayload.assigned_products = products;

    const item = await Counter.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      updatePayload,
      { new: true, runValidators: true },
    );
    if (!item) return createError(res, 404, "Counter not found.");

    const populated = await populate(Counter.findById(item._id));
    return successMessage(
      res,
      sanitize(populated || item),
      "Counter updated successfully.",
    );
  } catch (err) {
    console.error("Counter update error:", err);
    return createError(
      res,
      err.code === 11000 ? 409 : 500,
      err.code === 11000
        ? "Email already in use or counter # conflict for this shop."
        : err.message || "Failed to update counter.",
    );
  }
};

const remove = async (req, res) => {
  try {
    const item = await Counter.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true },
    );
    if (!item) return createError(res, 404, "Counter not found.");
    return successMessage(res, sanitize(item), "Counter deleted successfully.");
  } catch (err) {
    console.error("Counter remove error:", err);
    return createError(res, 500, err.message || "Failed to delete counter.");
  }
};

/**
 * POST /api/counter/login
 *
 * Body: { email, password }
 * Returns a counter-scoped JWT (kind="counter") + sanitized counter doc.
 */
const login = async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return createError(res, 422, "Email and password are required.");
    }
    const normalized = String(email).trim().toLowerCase();
    const counter = await Counter.findOne({
      email: normalized,
      isDeleted: false,
    }).select("+password_hash");

    if (!counter || !counter.password_hash) {
      return createError(res, 401, "Invalid email or password.");
    }
    if (!counter.isActive) {
      return createError(res, 403, "Counter is deactivated.");
    }
    const ok = await bcrypt.compare(String(password), counter.password_hash);
    if (!ok) return createError(res, 401, "Invalid email or password.");

    const token = jwt.sign(
      {
        kind: "counter",
        counter_id: String(counter._id),
        type: counter.type,
        shop_id: counter.shop_id ? String(counter.shop_id) : null,
      },
      COUNTER_SECRET,
      { expiresIn: COUNTER_TOKEN_TTL },
    );

    const populated = await populate(Counter.findById(counter._id));
    return successMessage(
      res,
      { token, counter: sanitize(populated) },
      "Counter logged in successfully.",
    );
  } catch (err) {
    console.error("Counter login error:", err);
    return createError(res, 500, err.message || "Failed to login.");
  }
};

/**
 * GET /api/counter/me
 *
 * Returns the currently authenticated counter (counter token required).
 */
const me = async (req, res) => {
  try {
    if (!req.counter?._id) {
      return createError(res, 401, "Counter authentication required.");
    }
    const populated = await populate(
      Counter.findById(req.counter._id).where({ isDeleted: false }),
    );
    if (!populated) return createError(res, 404, "Counter not found.");
    return successMessage(res, sanitize(populated), null);
  } catch (err) {
    console.error("Counter me error:", err);
    return createError(res, 500, err.message || "Failed to load counter.");
  }
};

/**
 * GET /api/counter/products
 *
 * Counter-token gated. Returns the products this counter is allowed to
 * sell. If the counter has explicit `assigned_products`, return only those;
 * otherwise (empty list) treat as "all products" and return every active
 * product. Sale-counter UI uses this to render its product picker.
 */
const myProducts = async (req, res) => {
  try {
    if (!req.counter?._id) {
      return createError(res, 401, "Counter authentication required.");
    }
    const counter = await Counter.findById(req.counter._id)
      .where({ isDeleted: false })
      .select("assigned_products");
    if (!counter) {
      return createError(res, 404, "Counter not found.");
    }
    const assignedIds = (counter.assigned_products || []).map(String);
    const filter = { isDeleted: false };
    if (assignedIds.length > 0) {
      filter._id = { $in: assignedIds };
    }
    const products = await Product.find(filter)
      .populate("category_id")
      .sort({ name: 1 });
    return successMessage(
      res,
      { items: products, mode: assignedIds.length > 0 ? "assigned" : "all" },
      "Products fetched successfully.",
    );
  } catch (err) {
    console.error("Counter myProducts error:", err);
    return createError(res, 500, err.message || "Failed to load products.");
  }
};

module.exports = {
  list,
  getOne,
  create,
  update,
  remove,
  login,
  me,
  myProducts,
};
