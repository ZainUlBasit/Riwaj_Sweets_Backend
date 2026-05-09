const crypto = require("crypto");
const Order = require("../Models/Order");
const Product = require("../Models/Products");
const Counter = require("../Models/Counter");
const { createFromOrder } = require("./sale-invoice.controller");
const { createError, successMessage } = require("../utils/ResponseMessage");

const ORDER_STATUS = { PENDING: 1, BILLED: 2, DELIVERED: 3, CANCELLED: 4 };
const PAYMENT_STATUS = { UNPAID: 1, PARTIAL: 2, PAID: 3 };

const populate = (q) =>
  q
    .populate("items.product_id")
    .populate("sale_invoice_id")
    .populate("created_by_counter_id")
    .populate("billed_by_counter_id");

/** Generates a short lookup code used for old scanners/manual search. */
const generateBarcodeLookup = () => {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `RW-${ts}-${rand}`.slice(0, 24);
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const computePaymentStatus = (paid, total) => {
  if (paid <= 0) return PAYMENT_STATUS.UNPAID;
  if (paid < total) return PAYMENT_STATUS.PARTIAL;
  return PAYMENT_STATUS.PAID;
};

const paymentFlagFromStatus = (status) => {
  if (Number(status) === PAYMENT_STATUS.PAID) return "paid";
  if (Number(status) === PAYMENT_STATUS.PARTIAL) return "partial";
  return "unpaid";
};

/**
 * Self-healing helper: ensures every Order in the given list has a short
 * `barcode_lookup`. Older rows may only have the long JSON `barcode`, which
 * is unsuitable for tables and CODE128 print-outs.
 */
const ensureBarcodeLookups = async (orders) => {
  if (!Array.isArray(orders) || orders.length === 0) return orders;
  const missing = orders.filter((o) => !o.barcode_lookup);
  if (missing.length === 0) return orders;
  for (const order of missing) {
    let lookup = `RW-${order.order_number || ""}`.toUpperCase();
    if (!order.order_number) lookup = generateBarcodeLookup();
    let exists = await Order.findOne({
      _id: { $ne: order._id },
      barcode_lookup: lookup,
    }).select("_id");
    let attempt = 0;
    while (exists && attempt < 5) {
      lookup = generateBarcodeLookup();
      exists = await Order.findOne({ barcode_lookup: lookup }).select("_id");
      attempt += 1;
    }
    order.barcode_lookup = lookup;
    await Order.updateOne({ _id: order._id }, { barcode_lookup: lookup });
  }
  return orders;
};

const buildBarcodePayload = (order) =>
  JSON.stringify({
    t: "RW_ORDER",
    order_id: String(order._id),
    order_number: order.order_number,
    customer: order.customer_info || {},
    items: (order.items || []).map((item) => ({
      itemId: String(item.product_id),
      item_name: item.name,
      qty: item.quantity,
      price: item.unit_price,
      amount: item.total_price,
    })),
  });

const parseBarcode = (code) => {
  const raw = String(code || "").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.order_id) return { orderId: parsed.order_id, raw };
  } catch (_err) {
    // Not JSON: treat as lookup code.
  }
  return { lookup: raw, raw };
};

/**
 * Resolves and validates `items` against current Product master data:
 *   - product must exist + not be soft-deleted
 *   - quantity must be > 0
 *   - unit_price defaults to Product.price if caller didn't pass one
 *   - if a sale counter is the caller, every item must be in
 *     counter.assigned_products (when assigned_products is non-empty)
 */
const resolveItems = async (rawItems, counter) => {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw Object.assign(new Error("At least one item is required."), {
      status: 400,
    });
  }

  const counterAssigned =
    counter?.assigned_products?.length > 0
      ? new Set(counter.assigned_products.map(String))
      : null;

  const out = [];
  for (const raw of rawItems) {
    const id = raw?.product_id ?? raw?._id;
    if (!id) {
      throw Object.assign(new Error("Each item needs a product_id."), {
        status: 400,
      });
    }
    const qty = Number(raw?.quantity ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw Object.assign(
        new Error(`Invalid quantity for item ${id}.`),
        { status: 400 },
      );
    }
    const product = await Product.findById(id).where({ isDeleted: false });
    if (!product) {
      throw Object.assign(new Error("One or more products not found."), {
        status: 404,
      });
    }
    if (counterAssigned && !counterAssigned.has(String(product._id))) {
      throw Object.assign(
        new Error(
          `Product "${product.name}" is not assigned to your counter.`,
        ),
        { status: 403 },
      );
    }

    const unitPrice = round2(
      raw?.unit_price != null ? raw.unit_price : product.price ?? 0,
    );
    out.push({
      product_id: product._id,
      name: product.name,
      quantity: qty,
      unit_price: unitPrice,
      total_price: round2(unitPrice * qty),
    });
  }
  return out;
};

const list = async (req, res) => {
  try {
    const { status, payment_status, start_date, end_date } = req.query || {};
    const filter = { isDeleted: false };

    if (status) filter.status = Number(status);
    if (payment_status) filter.payment_status = Number(payment_status);
    if (start_date || end_date) {
      filter.createdAt = {};
      if (start_date) filter.createdAt.$gte = new Date(start_date);
      if (end_date) filter.createdAt.$lte = new Date(end_date);
    }

    // Counter-token callers see only their own orders.
    if (req.counter?._id) {
      filter.created_by_counter_id = req.counter._id;
    }

    const items = await populate(Order.find(filter).sort({ createdAt: -1 }));
    const deletedItems = await populate(
      Order.find({
        ...filter,
        isDeleted: true,
      }).sort({ createdAt: -1 }),
    );

    await ensureBarcodeLookups(items);
    await ensureBarcodeLookups(deletedItems);

    return successMessage(
      res,
      { items, deletedItems },
      "Orders fetched successfully.",
    );
  } catch (err) {
    console.error("Order list error:", err);
    return createError(res, 500, err.message || "Failed to fetch orders.");
  }
};

const getOne = async (req, res) => {
  try {
    const item = await populate(
      Order.findById(req.params.id).where({ isDeleted: false }),
    );
    if (!item) return createError(res, 404, "Order not found.");
    await ensureBarcodeLookups([item]);
    return successMessage(res, item, "Order fetched successfully.");
  } catch (err) {
    console.error("Order getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch order.");
  }
};

const getByBarcode = async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    if (!code) return createError(res, 400, "Barcode is required.");
    const parsed = parseBarcode(code);
    const query = parsed.orderId
      ? { _id: parsed.orderId, isDeleted: false }
      : {
          isDeleted: false,
          $or: [{ barcode: code }, { barcode_lookup: parsed.lookup || code }],
        };
    const item = await populate(Order.findOne(query));
    if (!item) return createError(res, 404, "Order not found for this barcode.");
    return successMessage(res, item, "Order fetched successfully.");
  } catch (err) {
    console.error("Order getByBarcode error:", err);
    return createError(res, 500, err.message || "Failed to fetch order.");
  }
};

const scanBarcode = async (req, res) => {
  try {
    req.params.code = req.body?.barcode || req.body?.code || "";
    return getByBarcode(req, res);
  } catch (err) {
    console.error("Order scanBarcode error:", err);
    return createError(res, 500, err.message || "Failed to scan barcode.");
  }
};

/**
 * POST /api/order
 *
 * Sale counters (counter token, type=2) and admins (user token) can both
 * create. Sale counter, when scoped, is restricted to its assigned_products.
 */
const create = async (req, res) => {
  try {
    const { items, discount, customer_info, notes, created_by_counter_id } =
      req.body || {};

    // Resolve creator counter:
    //   - counter token -> req.counter
    //   - admin/user token -> optional explicit `created_by_counter_id`
    let creator = req.counter;
    if (!creator && created_by_counter_id) {
      creator = await Counter.findById(created_by_counter_id).where({
        isDeleted: false,
      });
      if (!creator) {
        return createError(res, 404, "Sale counter not found.");
      }
    }
    // Sale-counter must be type 2 when present.
    if (creator && Number(creator.type) !== 2) {
      return createError(
        res,
        403,
        "Only sale counters can create orders.",
      );
    }

    const resolved = await resolveItems(items, creator);
    const subtotal = round2(
      resolved.reduce((sum, i) => sum + i.total_price, 0),
    );
    const discountNum = round2(discount ?? 0);
    if (discountNum < 0 || discountNum > subtotal) {
      return createError(res, 400, "Invalid discount value.");
    }
    const total = round2(subtotal - discountNum);

    const barcodeLookup = generateBarcodeLookup();
    const order = await Order.create({
      // Temporarily use lookup; once Mongo assigns _id/order_number we replace
      // this with the full item-wrapped barcode payload.
      barcode: barcodeLookup,
      barcode_lookup: barcodeLookup,
      items: resolved,
      subtotal,
      discount: discountNum,
      total,
      status: ORDER_STATUS.PENDING,
      payment_status: PAYMENT_STATUS.UNPAID,
      payment_flag: "unpaid",
      paid_amount: 0,
      payments: [],
      created_by_counter_id: creator?._id ?? null,
      customer_info: {
        name: customer_info?.name ?? "",
        phone: customer_info?.phone ?? "",
      },
      notes: notes ?? "",
      isDeleted: false,
    });

    order.barcode = buildBarcodePayload(order);
    await order.save();

    const populated = await populate(Order.findById(order._id));
    return successMessage(
      res,
      populated || order,
      "Order created successfully.",
    );
  } catch (err) {
    if (err.status) return createError(res, err.status, err.message);
    console.error("Order create error:", err);
    return createError(res, 500, err.message || "Failed to create order.");
  }
};

/**
 * POST /api/order/:id/bill
 *
 * Cash counter (or admin) marks an order as billed. Optional `payment` is
 * recorded in the same call so the bill+pay cash flow is one round-trip.
 */
const bill = async (req, res) => {
  try {
    const { payment, billed_by_counter_id } = req.body || {};
    const order = await Order.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!order) return createError(res, 404, "Order not found.");
    if (order.status !== ORDER_STATUS.PENDING) {
      return createError(
        res,
        409,
        "Only pending orders can be billed.",
      );
    }

    let billerId = req.counter?._id || billed_by_counter_id || null;
    if (req.counter && Number(req.counter.type) !== 1) {
      return createError(
        res,
        403,
        "Only cash counters can bill orders.",
      );
    }

    order.status = ORDER_STATUS.BILLED;
    order.billed_at = new Date();
    order.billed_by_counter_id = billerId;

    if (payment && Number(payment.amount) > 0) {
      const amt = round2(payment.amount);
      order.payments.push({
        amount: amt,
        method: payment.method || "cash",
        paid_at: new Date(),
        received_by_counter_id: billerId,
        note: payment.note || "",
      });
      order.paid_amount = round2(order.paid_amount + amt);
    }
    order.payment_status = computePaymentStatus(order.paid_amount, order.total);
    order.payment_flag = paymentFlagFromStatus(order.payment_status);

    await order.save();
    const populated = await populate(Order.findById(order._id));
    return successMessage(res, populated, "Order billed successfully.");
  } catch (err) {
    console.error("Order bill error:", err);
    return createError(res, 500, err.message || "Failed to bill order.");
  }
};

/**
 * POST /api/order/:id/payment
 *
 * Adds a payment entry (partial or full). Recomputes payment_status.
 */
const addPayment = async (req, res) => {
  try {
    const { amount, method, note } = req.body || {};
    const amt = round2(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return createError(res, 400, "Payment amount must be greater than 0.");
    }

    const order = await Order.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!order) return createError(res, 404, "Order not found.");
    if (order.status === ORDER_STATUS.CANCELLED) {
      return createError(res, 409, "Cannot add payment to a cancelled order.");
    }
    if (order.paid_amount + amt > order.total + 0.01) {
      return createError(
        res,
        400,
        `Payment exceeds total. Outstanding: ${round2(
          order.total - order.paid_amount,
        )}`,
      );
    }

    const billerId = req.counter?._id || null;
    order.payments.push({
      amount: amt,
      method: method || "cash",
      paid_at: new Date(),
      received_by_counter_id: billerId,
      note: note || "",
    });
    order.paid_amount = round2(order.paid_amount + amt);
    order.payment_status = computePaymentStatus(order.paid_amount, order.total);
    order.payment_flag = paymentFlagFromStatus(order.payment_status);

    await order.save();
    const populated = await populate(Order.findById(order._id));
    return successMessage(res, populated, "Payment recorded successfully.");
  } catch (err) {
    console.error("Order addPayment error:", err);
    return createError(res, 500, err.message || "Failed to record payment.");
  }
};

/**
 * POST /api/order/:id/deliver
 *
 * Marks the order delivered + decrements Product inventory + records a
 * ProductStock "out" entry per item. Refuses delivery if any item lacks
 * available quantity.
 */
const deliver = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!order) return createError(res, 404, "Order not found.");
    if (order.status === ORDER_STATUS.DELIVERED) {
      return createError(res, 409, "Order already delivered.");
    }
    if (order.status === ORDER_STATUS.CANCELLED) {
      return createError(res, 409, "Cannot deliver a cancelled order.");
    }
    if (order.status === ORDER_STATUS.PENDING) {
      return createError(
        res,
        409,
        "Bill the order before delivering.",
      );
    }

    // Pre-flight stock check.
    for (const item of order.items) {
      const product = await Product.findById(item.product_id).where({
        isDeleted: false,
      });
      if (!product) {
        return createError(
          res,
          404,
          `Product "${item.name}" no longer exists.`,
        );
      }
      const available = Number(product.available_quantity || 0);
      if (available < item.quantity) {
        return createError(
          res,
          409,
          `Insufficient stock for "${item.name}". Available: ${available}, requested: ${item.quantity}.`,
        );
      }
    }

    // Apply: decrement available + bump out_quantity. The Order itself is
    // the audit trail for sales (no ProductStock "out" entry — that model
    // tracks production runs only).
    for (const item of order.items) {
      await Product.findByIdAndUpdate(item.product_id, {
        $inc: {
          available_quantity: -item.quantity,
          out_quantity: item.quantity,
        },
      });
    }

    order.status = ORDER_STATUS.DELIVERED;
    order.delivered_at = new Date();
    await order.save();

    const invoice = await createFromOrder(order);
    if (invoice?._id) {
      order.sale_invoice_id = invoice._id;
      await order.save();
    }

    const populated = await populate(Order.findById(order._id));
    return successMessage(res, populated, "Order delivered successfully.");
  } catch (err) {
    console.error("Order deliver error:", err);
    return createError(res, 500, err.message || "Failed to deliver order.");
  }
};

/**
 * POST /api/order/:id/cancel
 *
 * Allowed from `pending` only. (Billed/delivered orders should be handled
 * with a separate refund flow which is out of scope for Phase 2.)
 */
const cancel = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!order) return createError(res, 404, "Order not found.");
    if (order.status !== ORDER_STATUS.PENDING) {
      return createError(
        res,
        409,
        "Only pending orders can be cancelled.",
      );
    }
    order.status = ORDER_STATUS.CANCELLED;
    order.cancelled_at = new Date();
    await order.save();

    const populated = await populate(Order.findById(order._id));
    return successMessage(res, populated, "Order cancelled successfully.");
  } catch (err) {
    console.error("Order cancel error:", err);
    return createError(res, 500, err.message || "Failed to cancel order.");
  }
};

/**
 * POST /api/order/batch-receive
 *
 * Cash counter can scan several sale-counter orders for the same customer and
 * receive them together. Payment is allocated oldest/order-list-first across
 * the selected orders. `deliver=true` also applies stock movement and creates
 * SaleInvoice rows for each delivered order.
 */
const batchReceive = async (req, res) => {
  try {
    const { order_ids, payment, deliver: shouldDeliver = true } = req.body || {};
    if (!Array.isArray(order_ids) || order_ids.length === 0) {
      return createError(res, 400, "At least one order is required.");
    }

    const ids = [...new Set(order_ids.map(String).filter(Boolean))];
    const orders = await Order.find({
      _id: { $in: ids },
      isDeleted: false,
    }).sort({ createdAt: 1 });

    if (orders.length !== ids.length) {
      return createError(res, 404, "One or more orders were not found.");
    }
    if (orders.some((o) => o.status === ORDER_STATUS.CANCELLED)) {
      return createError(res, 409, "Cancelled orders cannot be received.");
    }
    if (orders.some((o) => o.status === ORDER_STATUS.DELIVERED)) {
      return createError(res, 409, "Delivered orders cannot be received again.");
    }

    if (req.counter && Number(req.counter.type) !== 1) {
      return createError(res, 403, "Only cash counters can receive orders.");
    }

    const billerId = req.counter?._id || req.body?.billed_by_counter_id || null;
    const paymentAmount = round2(payment?.amount ?? 0);
    if (paymentAmount < 0) {
      return createError(res, 400, "Payment amount cannot be negative.");
    }

    if (shouldDeliver) {
      const requiredByProduct = new Map();
      for (const order of orders) {
        for (const item of order.items) {
          const key = String(item.product_id);
          requiredByProduct.set(
            key,
            (requiredByProduct.get(key) || 0) + Number(item.quantity || 0),
          );
        }
      }

      for (const [productId, requiredQty] of requiredByProduct.entries()) {
        const product = await Product.findById(productId).where({
          isDeleted: false,
        });
        if (!product) {
          return createError(res, 404, "One or more products no longer exist.");
        }
        const available = Number(product.available_quantity || 0);
        if (available < requiredQty) {
          return createError(
            res,
            409,
            `Insufficient stock for "${product.name}". Available: ${available}, requested: ${requiredQty}.`,
          );
        }
      }
    }

    let remainingPayment = paymentAmount;
    const updatedIds = [];

    for (const order of orders) {
      if (order.status === ORDER_STATUS.PENDING) {
        order.status = ORDER_STATUS.BILLED;
        order.billed_at = new Date();
        order.billed_by_counter_id = billerId;
      }

      const outstanding = round2(order.total - order.paid_amount);
      const allocation = Math.min(remainingPayment, outstanding);
      if (allocation > 0) {
        order.payments.push({
          amount: allocation,
          method: payment?.method || "cash",
          paid_at: new Date(),
          received_by_counter_id: billerId,
          note: payment?.note || "Batch receive",
        });
        order.paid_amount = round2(order.paid_amount + allocation);
        remainingPayment = round2(remainingPayment - allocation);
      }

      order.payment_status = computePaymentStatus(order.paid_amount, order.total);
      order.payment_flag = paymentFlagFromStatus(order.payment_status);

      if (shouldDeliver) {
        for (const item of order.items) {
          await Product.findByIdAndUpdate(item.product_id, {
            $inc: {
              available_quantity: -item.quantity,
              out_quantity: item.quantity,
            },
          });
        }
        order.status = ORDER_STATUS.DELIVERED;
        order.delivered_at = new Date();
      }

      await order.save();

      if (shouldDeliver) {
        const invoice = await createFromOrder(order);
        if (invoice?._id) {
          order.sale_invoice_id = invoice._id;
          await order.save();
        }
      }
      updatedIds.push(order._id);
    }

    const updated = await populate(
      Order.find({ _id: { $in: updatedIds } }).sort({ createdAt: 1 }),
    );
    return successMessage(
      res,
      {
        items: updated,
        total_received: paymentAmount,
        unallocated_amount: remainingPayment,
      },
      "Orders received successfully.",
    );
  } catch (err) {
    console.error("Order batchReceive error:", err);
    return createError(res, 500, err.message || "Failed to receive orders.");
  }
};

const remove = async (req, res) => {
  try {
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true },
    );
    if (!order) return createError(res, 404, "Order not found.");
    return successMessage(res, order, "Order deleted successfully.");
  } catch (err) {
    console.error("Order remove error:", err);
    return createError(res, 500, err.message || "Failed to delete order.");
  }
};

module.exports = {
  list,
  getOne,
  getByBarcode,
  scanBarcode,
  create,
  bill,
  addPayment,
  deliver,
  batchReceive,
  cancel,
  remove,
};
