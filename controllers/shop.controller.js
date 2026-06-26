const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const Shop = require("../Models/Shop");
const Order = require("../Models/Order");
const Product = require("../Models/Products");
const DispatchLocation = require("../Models/DispatchLocation");
const LocationInventory = require("../Models/LocationInventory");
const { createFromOrder } = require("./sale-invoice.controller");
const { createError, successMessage } = require("../utils/ResponseMessage");
const { SHOP_SECRET } = require("../Middleware/shopAuth");
const {
  TX,
  DIR,
  INV_TYPE,
  LOCATION_TYPE,
  writeLedger,
  adjustLocationInventory,
  getLocationInventoryQty,
  withTransaction,
} = require("../Services/inventoryService");

const SHOP_TOKEN_TTL = "12h";
const ORDER_STATUS = { PENDING: 1, BILLED: 2, DELIVERED: 3, CANCELLED: 4 };
const PAYMENT_STATUS = { UNPAID: 1, PARTIAL: 2, PAID: 3 };

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const populateShop = (q) =>
  q.populate({
    path: "location_id",
    select: "name location_type store_id description",
  });

const sanitize = (doc) => {
  if (!doc) return doc;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj.password_hash;
  return obj;
};

const generateBarcodeLookup = () => {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `SH-${ts}-${rand}`.slice(0, 24);
};

async function validateShopLocation(locationId, excludeShopId = null) {
  const loc = await DispatchLocation.findById(locationId).where({
    isDeleted: false,
  });
  if (!loc) {
    const err = new Error("Shop location not found.");
    err.status = 404;
    throw err;
  }
  if (Number(loc.location_type) !== LOCATION_TYPE.SHOP) {
    const err = new Error(
      "Selected location must be a Shop (create under Stores & Locations).",
    );
    err.status = 400;
    throw err;
  }
  const filter = { location_id: locationId, isDeleted: false };
  if (excludeShopId) filter._id = { $ne: excludeShopId };
  const existing = await Shop.findOne(filter);
  if (existing) {
    const err = new Error("This shop location already has a shop account.");
    err.status = 409;
    throw err;
  }
  return loc;
}

const list = async (_req, res) => {
  try {
    const items = await populateShop(
      Shop.find({ isDeleted: false }).sort({ shop_number: 1 }),
    );
    const deletedItems = await populateShop(
      Shop.find({ isDeleted: true }).sort({ shop_number: 1 }),
    );
    return successMessage(
      res,
      { items: items.map(sanitize), deletedItems: deletedItems.map(sanitize) },
      "Shops fetched successfully.",
    );
  } catch (err) {
    console.error("Shop list error:", err);
    return createError(res, 500, err.message || "Failed to fetch shops.");
  }
};

const getOne = async (req, res) => {
  try {
    const item = await populateShop(
      Shop.findById(req.params.id).where({ isDeleted: false }),
    );
    if (!item) return createError(res, 404, "Shop not found.");
    return successMessage(res, sanitize(item), "Shop fetched successfully.");
  } catch (err) {
    console.error("Shop getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch shop.");
  }
};

const create = async (req, res) => {
  try {
    const {
      name,
      code,
      location_id,
      email,
      password,
      phone,
      address,
      isActive,
    } = req.body || {};

    if (!name?.trim()) return createError(res, 400, "name is required.");
    if (!location_id) return createError(res, 400, "location_id is required.");
    if (!email?.trim() || !password) {
      return createError(res, 422, "email and password are required.");
    }
    if (String(password).length < 4) {
      return createError(res, 422, "Password must be at least 4 characters.");
    }

    try {
      await validateShopLocation(location_id);
    } catch (err) {
      return createError(res, err.status || 400, err.message);
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const dup = await Shop.findOne({ email: normalizedEmail, isDeleted: false });
    if (dup) return createError(res, 409, "Email already in use.");

    const passwordHash = await bcrypt.hash(String(password), 10);
    const item = await Shop.create({
      name: String(name).trim(),
      code: code?.trim() || "",
      location_id,
      email: normalizedEmail,
      password_hash: passwordHash,
      phone: phone?.trim() || "",
      address: address?.trim() || "",
      isActive: isActive == null ? true : !!isActive,
      isDeleted: false,
    });

    const populated = await populateShop(Shop.findById(item._id));
    return successMessage(
      res,
      sanitize(populated || item),
      "Shop created successfully.",
    );
  } catch (err) {
    console.error("Shop create error:", err);
    return createError(
      res,
      err.code === 11000 ? 409 : 500,
      err.code === 11000 ? "Shop email or location already exists." : err.message,
    );
  }
};

const update = async (req, res) => {
  try {
    const {
      name,
      code,
      location_id,
      email,
      password,
      phone,
      address,
      isActive,
    } = req.body || {};

    const updatePayload = { isDeleted: false };

    if (name !== undefined) {
      if (!String(name).trim()) return createError(res, 400, "name cannot be empty.");
      updatePayload.name = String(name).trim();
    }
    if (code !== undefined) updatePayload.code = code?.trim() || "";
    if (phone !== undefined) updatePayload.phone = phone?.trim() || "";
    if (address !== undefined) updatePayload.address = address?.trim() || "";
    if (isActive !== undefined) updatePayload.isActive = !!isActive;

    if (location_id !== undefined) {
      try {
        await validateShopLocation(location_id, req.params.id);
      } catch (err) {
        return createError(res, err.status || 400, err.message);
      }
      updatePayload.location_id = location_id;
    }

    if (email !== undefined) {
      const normalized = email ? String(email).trim().toLowerCase() : null;
      if (!normalized) return createError(res, 400, "email cannot be empty.");
      const dup = await Shop.findOne({
        email: normalized,
        _id: { $ne: req.params.id },
        isDeleted: false,
      });
      if (dup) return createError(res, 409, "Email already in use.");
      updatePayload.email = normalized;
    }
    if (password) {
      if (String(password).length < 4) {
        return createError(res, 422, "Password must be at least 4 characters.");
      }
      updatePayload.password_hash = await bcrypt.hash(String(password), 10);
    }

    const item = await Shop.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      updatePayload,
      { new: true, runValidators: true },
    );
    if (!item) return createError(res, 404, "Shop not found.");

    const populated = await populateShop(Shop.findById(item._id));
    return successMessage(
      res,
      sanitize(populated || item),
      "Shop updated successfully.",
    );
  } catch (err) {
    console.error("Shop update error:", err);
    return createError(res, 500, err.message || "Failed to update shop.");
  }
};

const remove = async (req, res) => {
  try {
    const item = await Shop.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true },
    );
    if (!item) return createError(res, 404, "Shop not found.");
    return successMessage(res, sanitize(item), "Shop deleted successfully.");
  } catch (err) {
    console.error("Shop remove error:", err);
    return createError(res, 500, err.message || "Failed to delete shop.");
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return createError(res, 422, "Email and password are required.");
    }
    const normalized = String(email).trim().toLowerCase();
    const shop = await Shop.findOne({ email: normalized, isDeleted: false }).select(
      "+password_hash",
    );
    if (!shop || !shop.password_hash) {
      return createError(res, 401, "Invalid email or password.");
    }
    if (!shop.isActive) {
      return createError(res, 403, "Shop account is deactivated.");
    }
    const ok = await bcrypt.compare(String(password), shop.password_hash);
    if (!ok) return createError(res, 401, "Invalid email or password.");

    const token = jwt.sign(
      { kind: "shop", shop_id: String(shop._id) },
      SHOP_SECRET,
      { expiresIn: SHOP_TOKEN_TTL },
    );

    const populated = await populateShop(Shop.findById(shop._id));
    return successMessage(
      res,
      { token, shop: sanitize(populated) },
      "Shop logged in successfully.",
    );
  } catch (err) {
    console.error("Shop login error:", err);
    return createError(res, 500, err.message || "Failed to login.");
  }
};

const me = async (req, res) => {
  try {
    if (!req.shop?._id) {
      return createError(res, 401, "Shop authentication required.");
    }
    const populated = await populateShop(
      Shop.findById(req.shop._id).where({ isDeleted: false }),
    );
    if (!populated) return createError(res, 404, "Shop not found.");
    return successMessage(res, sanitize(populated), null);
  } catch (err) {
    console.error("Shop me error:", err);
    return createError(res, 500, err.message || "Failed to load shop.");
  }
};

const inventory = async (req, res) => {
  try {
    const shop = req.shop;
    const locationId = shop.location_id;

    const [products, invRows] = await Promise.all([
      Product.find({ isDeleted: false }).sort({ name: 1 }),
      LocationInventory.find({
        location_id: locationId,
        inventory_type: INV_TYPE.SHOP,
        isDeleted: false,
      }),
    ]);

    const qtyByProduct = new Map(
      invRows.map((row) => [String(row.product_id), Number(row.quantity || 0)]),
    );

    const items = products
      .map((product) => ({
        product,
        quantity: qtyByProduct.get(String(product._id)) || 0,
      }))
      .filter((row) => row.quantity > 0);

    return successMessage(
      res,
      { items, mode: items.length ? "location" : "empty" },
      "Shop inventory fetched.",
    );
  } catch (err) {
    console.error("Shop inventory error:", err);
    return createError(res, 500, err.message || "Failed to load inventory.");
  }
};

const todaySales = async (req, res) => {
  try {
    const shop = req.shop;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const items = await Order.find({
      shop_id: shop._id,
      isDeleted: false,
      status: ORDER_STATUS.DELIVERED,
      delivered_at: { $gte: start, $lte: end },
    })
      .populate("items.product_id")
      .sort({ delivered_at: -1 });

    const summary = items.reduce(
      (acc, order) => {
        acc.count += 1;
        acc.total += Number(order.total || 0);
        acc.paid += Number(order.paid_amount || 0);
        return acc;
      },
      { count: 0, total: 0, paid: 0 },
    );

    return successMessage(
      res,
      { items, summary: { ...summary, total: round2(summary.total), paid: round2(summary.paid) } },
      "Today's sales fetched.",
    );
  } catch (err) {
    console.error("Shop todaySales error:", err);
    return createError(res, 500, err.message || "Failed to load sales.");
  }
};

/**
 * POST /api/shop/pos/sale
 * Direct cash counter sale — deducts shop inventory and creates delivered order.
 */
const posSale = async (req, res) => {
  try {
    const shop = req.shop;
    const {
      items: rawItems,
      discount = 0,
      payment,
      customer_info,
      notes,
    } = req.body || {};

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return createError(res, 400, "At least one item is required.");
    }

    const resolvedItems = [];
    for (const raw of rawItems) {
      const productId = raw?.product_id ?? raw?._id;
      const qty = Number(raw?.quantity ?? 0);
      if (!productId || !qty || qty <= 0) {
        return createError(res, 400, "Each item needs product_id and quantity > 0.");
      }
      const product = await Product.findById(productId).where({ isDeleted: false });
      if (!product) {
        return createError(res, 404, "One or more products not found.");
      }
      const locationQty = await getLocationInventoryQty(
        shop.location_id,
        product._id,
        INV_TYPE.SHOP,
      );
      if (locationQty < qty) {
        return createError(
          res,
          409,
          `Insufficient shop stock for "${product.name}". Available: ${locationQty}, requested: ${qty}. Transfer stock from main store first.`,
        );
      }
      const unitPrice = round2(raw.unit_price ?? product.price ?? 0);
      resolvedItems.push({
        product_id: product._id,
        name: product.name,
        quantity: qty,
        unit_price: unitPrice,
        total_price: round2(unitPrice * qty),
      });
    }

    const subtotal = round2(
      resolvedItems.reduce((sum, item) => sum + item.total_price, 0),
    );
    const discountAmt = round2(Math.max(0, discount));
    const total = round2(Math.max(0, subtotal - discountAmt));
    const paidAmount = round2(payment?.amount ?? total);
    if (paidAmount < 0) {
      return createError(res, 400, "Payment amount cannot be negative.");
    }

    const paymentStatus =
      paidAmount <= 0
        ? PAYMENT_STATUS.UNPAID
        : paidAmount < total
          ? PAYMENT_STATUS.PARTIAL
          : PAYMENT_STATUS.PAID;

    const barcode = generateBarcodeLookup();

    const order = await withTransaction(async (session) => {
      const opts = { session };

      for (const item of resolvedItems) {
        const prevQty = await getLocationInventoryQty(
          shop.location_id,
          item.product_id,
          INV_TYPE.SHOP,
          session,
        );
        await adjustLocationInventory(
          shop.location_id,
          item.product_id,
          -item.quantity,
          INV_TYPE.SHOP,
          session,
        );
        await writeLedger(
          {
            transactionType: TX.PRODUCT_SALE,
            direction: DIR.OUT,
            productId: item.product_id,
            quantity: item.quantity,
            locationId: shop.location_id,
            storeId: null,
            referenceType: "ShopSale",
            referenceId: shop._id,
            userId: null,
            notes: `Shop sale: ${shop.name}`,
            previousBalance: prevQty,
            newBalance: prevQty - item.quantity,
          },
          session,
        );
      }

      const [created] = await Order.create(
        [
          {
            barcode,
            barcode_lookup: barcode,
            items: resolvedItems,
            subtotal,
            discount: discountAmt,
            total,
            status: ORDER_STATUS.DELIVERED,
            payment_status: paymentStatus,
            payment_flag:
              paymentStatus === PAYMENT_STATUS.PAID
                ? "paid"
                : paymentStatus === PAYMENT_STATUS.PARTIAL
                  ? "partial"
                  : "unpaid",
            paid_amount: Math.min(paidAmount, total),
            payments:
              paidAmount > 0
                ? [
                    {
                      amount: Math.min(paidAmount, total),
                      method: payment?.method || "cash",
                      paid_at: new Date(),
                      note: payment?.note || "Shop POS",
                    },
                  ]
                : [],
            shop_id: shop._id,
            shop_location_id: shop.location_id,
            customer_info: {
              name: customer_info?.name?.trim() || "",
              phone: customer_info?.phone?.trim() || "",
            },
            notes: notes?.trim() || "",
            billed_at: new Date(),
            delivered_at: new Date(),
            isDeleted: false,
          },
        ],
        opts,
      );

      return created;
    });

    const invoice = await createFromOrder(order);
    if (invoice?._id) {
      order.sale_invoice_id = invoice._id;
      await order.save();
    }

    const populated = await Order.findById(order._id)
      .populate("items.product_id")
      .populate("sale_invoice_id");

    return successMessage(res, populated, "Sale completed successfully.");
  } catch (err) {
    console.error("Shop posSale error:", err);
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to complete sale.",
    );
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
  inventory,
  todaySales,
  posSale,
};
