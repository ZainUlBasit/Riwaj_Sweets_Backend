const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const Shop = require("../Models/Shop");
const Order = require("../Models/Order");
const Product = require("../Models/Products");
const DispatchLocation = require("../Models/DispatchLocation");
const LocationInventory = require("../Models/LocationInventory");
const ProductTransfer = require("../Models/ProductTransfer");
const { TRANSFER_STATUS } = require("../Models/ProductTransfer");
const { createFromOrder } = require("./sale-invoice.controller");
const { resolveProductBarcodeItem } = require("./order.controller");
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
  adjustProduct,
  getInventoryTypeForLocation,
  withTransaction,
} = require("../Services/inventoryService");

const SHOP_TOKEN_TTL = "12h";
const ORDER_STATUS = { PENDING: 1, BILLED: 2, DELIVERED: 3, CANCELLED: 4 };
const PAYMENT_STATUS = { UNPAID: 1, PARTIAL: 2, PAID: 3 };

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

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

/**
 * GET /api/shop/sync/catalog
 * Full catalog + shop location qty for desktop offline cache.
 * Includes zero-qty products so barcodes still resolve offline.
 */
const syncCatalog = async (req, res) => {
  try {
    const shop = req.shop;
    const locationId = shop.location_id;

    const [products, invRows] = await Promise.all([
      Product.find({ isDeleted: false })
        .select("_id id name unit price category_id available_quantity")
        .sort({ name: 1 })
        .lean(),
      LocationInventory.find({
        location_id: locationId,
        inventory_type: INV_TYPE.SHOP,
        isDeleted: false,
      }).lean(),
    ]);

    const qtyByProduct = new Map(
      invRows.map((row) => [String(row.product_id), Number(row.quantity || 0)]),
    );

    const items = products.map((product) => ({
      product_id: String(product._id),
      product_code: Number(product.id),
      name: product.name,
      unit: Number(product.unit),
      price: Number(product.price || 0),
      category_id: product.category_id ? String(product.category_id) : null,
      quantity: qtyByProduct.get(String(product._id)) || 0,
    }));

    return successMessage(
      res,
      {
        shop_id: String(shop._id),
        location_id: locationId ? String(locationId) : null,
        synced_at: new Date().toISOString(),
        items,
      },
      "Shop catalog synced.",
    );
  } catch (err) {
    console.error("Shop syncCatalog error:", err);
    return createError(res, 500, err.message || "Failed to sync catalog.");
  }
};

const todaySales = async (req, res) => {
  try {
    const shop = req.shop;
    const { start_date, end_date } = req.query || {};
    const start = start_date ? new Date(`${start_date}T00:00:00`) : new Date();
    start.setHours(0, 0, 0, 0);
    const end = end_date ? new Date(`${end_date}T23:59:59.999`) : new Date();
    end.setHours(23, 59, 59, 999);

    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      start > end
    ) {
      return createError(res, 400, "Valid date range is required.");
    }

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
        acc.bill_total += Number(order.subtotal || 0);
        acc.discount += Number(order.discount || 0);
        acc.net_total += Number(order.total || 0);
        acc.paid += Number(order.paid_amount || 0);
        // legacy aliases
        acc.total += Number(order.total || 0);
        return acc;
      },
      { count: 0, bill_total: 0, discount: 0, net_total: 0, paid: 0, total: 0 },
    );

    return successMessage(
      res,
      {
        items,
        start_date: start_date || null,
        end_date: end_date || null,
        summary: {
          count: summary.count,
          bill_total: round2(summary.bill_total),
          discount: round2(summary.discount),
          net_total: round2(summary.net_total),
          paid: round2(summary.paid),
          total: round2(summary.total),
        },
      },
      "Shop sales fetched.",
    );
  } catch (err) {
    console.error("Shop todaySales error:", err);
    return createError(res, 500, err.message || "Failed to load sales.");
  }
};

const scanProductBarcode = async (req, res) => {
  try {
    const shop = req.shop;
    const item = await resolveProductBarcodeItem(
      req.body?.barcode || req.body?.code,
    );
    // Stock qty is optional for cart add — fetch in parallel-friendly lean path
    const available_qty = await getLocationInventoryQty(
      shop.location_id,
      item.product_id,
      INV_TYPE.SHOP,
    );
    return successMessage(
      res,
      {
        item: {
          barcode: item.barcode,
          product_id: item.product_id,
          product_code: item.product_code,
          name: item.name,
          unit: item.unit,
          quantity: item.quantity,
          unit_price: item.unit_price,
          total_price: item.total_price,
          available_qty,
          available_quantity: available_qty,
        },
      },
      "Product barcode scanned successfully.",
    );
  } catch (err) {
    if (err.status) return createError(res, err.status, err.message);
    console.error("Shop scanProductBarcode error:", err);
    return createError(res, 500, err.message || "Failed to scan product barcode.");
  }
};

/**
 * POST /api/shop/cash-sale
 * Barcode cash sale — deducts shop location inventory and creates delivered order.
 */
const cashBarcodeSale = async (req, res) => {
  try {
    const shop = req.shop;
    const { items: rawItems, customer_info, notes, discount = 0 } = req.body || {};
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return createError(res, 400, "At least one scanned item is required.");
    }

    const resolved = [];
    const uniqueBarcodes = [];
    const seenBarcode = new Set();
    for (const raw of rawItems) {
      if (!raw?.barcode) {
        return createError(res, 400, "Each item needs a scanned barcode.");
      }
      const code = String(raw.barcode).trim();
      if (!seenBarcode.has(code)) {
        seenBarcode.add(code);
        uniqueBarcodes.push(code);
      }
    }

    const resolvedByBarcode = new Map();
    await Promise.all(
      uniqueBarcodes.map(async (code) => {
        const item = await resolveProductBarcodeItem(code);
        resolvedByBarcode.set(code, item);
      }),
    );

    for (const raw of rawItems) {
      const code = String(raw.barcode).trim();
      const item = resolvedByBarcode.get(code);
      if (!item) {
        return createError(res, 404, `Product not found for barcode ${code}.`);
      }
      resolved.push({
        product_id: item.product_id,
        name: item.name,
        quantity: item.quantity,
        unit_price: item.unit_price,
        total_price: item.total_price,
      });
    }

    const requiredByProduct = new Map();
    const nameByProduct = new Map();
    for (const item of resolved) {
      const key = String(item.product_id);
      requiredByProduct.set(
        key,
        (requiredByProduct.get(key) || 0) + Number(item.quantity || 0),
      );
      nameByProduct.set(key, item.name);
    }

    const stockChecks = await Promise.all(
      [...requiredByProduct.entries()].map(async ([productId, requiredQty]) => {
        const available = await getLocationInventoryQty(
          shop.location_id,
          productId,
          INV_TYPE.SHOP,
        );
        return {
          productId,
          name: nameByProduct.get(productId) || "Product",
          requiredQty,
          available,
        };
      }),
    );

    for (const check of stockChecks) {
      if (check.available < check.requiredQty) {
        return createError(
          res,
          409,
          `Insufficient shop stock for "${check.name}". Available: ${check.available}, requested: ${round3(check.requiredQty)}.`,
        );
      }
    }

    const subtotal = round2(
      resolved.reduce((sum, item) => sum + Number(item.total_price || 0), 0),
    );
    const discountAmt = round2(Math.max(0, Number(discount) || 0));
    if (discountAmt > subtotal) {
      return createError(res, 400, "Discount cannot be greater than subtotal.");
    }
    const total = round2(Math.max(0, subtotal - discountAmt));
    const barcode = generateBarcodeLookup();

    const order = await withTransaction(async (session) => {
      const opts = { session };

      for (const item of resolved) {
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
        await adjustProduct(
          item.product_id,
          { outDelta: item.quantity, availDelta: -item.quantity },
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
            referenceType: "ShopBarcodeSale",
            referenceId: shop._id,
            userId: null,
            notes: `Shop barcode sale: ${shop.name}`,
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
            items: resolved,
            subtotal,
            discount: discountAmt,
            total,
            status: ORDER_STATUS.DELIVERED,
            payment_status: PAYMENT_STATUS.PAID,
            payment_flag: "paid",
            paid_amount: total,
            payments:
              total > 0
                ? [
                    {
                      amount: total,
                      method: "cash",
                      paid_at: new Date(),
                      note: "Shop barcode cash sale",
                    },
                  ]
                : [],
            shop_id: shop._id,
            shop_location_id: shop.location_id,
            customer_info: {
              name: customer_info?.name?.trim() || "",
              phone: customer_info?.phone?.trim() || "",
            },
            notes: notes?.trim() || "Shop barcode cash sale",
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

    return successMessage(res, populated, "Shop cash sale completed successfully.");
  } catch (err) {
    if (err.status) return createError(res, err.status, err.message);
    console.error("Shop cashBarcodeSale error:", err);
    return createError(res, 500, err.message || "Failed to complete shop cash sale.");
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
      client_sale_id,
      local_id,
    } = req.body || {};

    const clientSaleId = String(client_sale_id || local_id || "").trim() || null;

    // Idempotent retry: if desktop lost the response mid-sync, return same order
    if (clientSaleId) {
      const existing = await Order.findOne({
        shop_id: shop._id,
        client_sale_id: clientSaleId,
        isDeleted: false,
      })
        .populate("items.product_id")
        .populate("sale_invoice_id");
      if (existing) {
        return successMessage(
          res,
          existing,
          "Sale already synced (idempotent).",
        );
      }
    }

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
    const discountAmt = round2(Math.max(0, Number(discount) || 0));
    if (discountAmt > subtotal) {
      return createError(res, 400, "Discount cannot be greater than subtotal.");
    }
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
        await adjustProduct(
          item.product_id,
          { outDelta: item.quantity, availDelta: -item.quantity },
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
            client_sale_id: clientSaleId,
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
    // Unique race on client_sale_id — treat as idempotent success
    if (err?.code === 11000 && (err?.keyPattern?.client_sale_id || err?.message?.includes("client_sale_id"))) {
      const shop = req.shop;
      const clientSaleId = String(
        req.body?.client_sale_id || req.body?.local_id || "",
      ).trim();
      if (clientSaleId) {
        const existing = await Order.findOne({
          shop_id: shop._id,
          client_sale_id: clientSaleId,
          isDeleted: false,
        })
          .populate("items.product_id")
          .populate("sale_invoice_id");
        if (existing) {
          return successMessage(
            res,
            existing,
            "Sale already synced (idempotent).",
          );
        }
      }
    }
    console.error("Shop posSale error:", err);
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to complete sale.",
    );
  }
};

/**
 * POST /api/shop/receive-transfer
 * Scan Product Store → Shop transfer barcode (PT-…).
 * Credits this shop's inventory for pending lines on that shipment.
 */
const receiveTransfer = async (req, res) => {
  try {
    const shop = req.shop;
    const code = String(
      req.body?.barcode || req.body?.transfer_code || req.body?.code || "",
    )
      .trim()
      .toUpperCase();

    if (!code) {
      return createError(res, 400, "Transfer barcode is required.");
    }
    if (!shop?.location_id) {
      return createError(res, 400, "Shop has no linked location.");
    }

    const pending = await ProductTransfer.find({
      transfer_code: code,
      to_location_id: shop.location_id,
      status: TRANSFER_STATUS.PENDING,
      isDeleted: false,
    }).populate("product_id", "name id unit price");

    if (!pending.length) {
      const any = await ProductTransfer.findOne({
        transfer_code: code,
        isDeleted: false,
      });
      if (!any) {
        return createError(res, 404, `Transfer barcode not found: ${code}`);
      }
      if (String(any.to_location_id) !== String(shop.location_id)) {
        return createError(
          res,
          403,
          "Yeh transfer kisi aur shop ke liye hai.",
        );
      }
      if (Number(any.status) === TRANSFER_STATUS.RECEIVED) {
        return createError(res, 409, "Yeh transfer pehle hi receive ho chuka hai.");
      }
      return createError(res, 404, "Is barcode pe koi pending stock nahi.");
    }

    const toLoc = await DispatchLocation.findById(shop.location_id).where({
      isDeleted: false,
    });
    if (!toLoc) return createError(res, 404, "Shop location not found.");

    const toInvType = getInventoryTypeForLocation(LOCATION_TYPE.SHOP);
    const now = new Date();

    const receivedItems = await withTransaction(async (session) => {
      const out = [];
      for (const row of pending) {
        const qty = Number(row.quantity || 0);
        const productId = row.product_id?._id || row.product_id;
        const prevQty = await getLocationInventoryQty(
          shop.location_id,
          productId,
          toInvType,
          session,
        );

        await adjustLocationInventory(
          shop.location_id,
          productId,
          qty,
          toInvType,
          session,
        );

        await writeLedger(
          {
            transactionType: TX.SHOP_TRANSFER,
            direction: DIR.IN,
            productId,
            quantity: qty,
            locationId: shop.location_id,
            storeId: toLoc.store_id,
            referenceType: "ProductTransfer",
            referenceId: row._id,
            userId: null,
            notes: `Shop receive [${code}] · ${shop.name}`,
            previousBalance: prevQty,
            newBalance: prevQty + qty,
          },
          session,
        );

        await ProductTransfer.updateOne(
          { _id: row._id },
          {
            $set: {
              status: TRANSFER_STATUS.RECEIVED,
              received_at: now,
              received_by_shop_id: shop._id,
            },
          },
          { session },
        );

        out.push({
          transfer_id: row._id,
          product_id: productId,
          product_code: row.product_id?.id ?? null,
          name: row.product_id?.name || "Product",
          unit: row.product_id?.unit ?? null,
          quantity: qty,
          available_qty: prevQty + qty,
        });
      }
      return out;
    });

    return successMessage(
      res,
      {
        transfer_code: code,
        received_count: receivedItems.length,
        items: receivedItems,
      },
      `${receivedItems.length} item(s) shop stock me add ho gaye.`,
    );
  } catch (err) {
    console.error("Shop receiveTransfer error:", err);
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to receive transfer.",
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
  syncCatalog,
  todaySales,
  scanProductBarcode,
  cashBarcodeSale,
  posSale,
  receiveTransfer,
};
