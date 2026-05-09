const SaleInvoice = require("../Models/SaleInvoice");
const Counter = require("../Models/Counter");
const { createError, successMessage } = require("../utils/ResponseMessage");

const populateRefs = (q) =>
  q
    .populate("order_id")
    .populate("items.product_id")
    .populate("created_by_counter_id")
    .populate("billed_by_counter_id");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const counterSnapshot = (counter) => ({
  counter_number: counter?.counter_number ?? null,
  type: counter?.type ?? null,
  location: counter?.location ?? "",
});

async function loadCounter(id) {
  if (!id) return null;
  return Counter.findById(id).where({ isDeleted: false });
}

const isLegacyJsonBarcode = (val) => {
  if (typeof val !== "string") return false;
  const s = val.trim();
  if (!s.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(s);
    return !!parsed?.order_id;
  } catch (_err) {
    return false;
  }
};

/**
 * Self-heals legacy SaleInvoice rows whose `barcode` field still contains the
 * old JSON payload. Replaces it with the parent Order's short `barcode_lookup`
 * so thermal print previews never show bakwas JSON.
 */
const ensureCleanBarcode = async (invoices) => {
  const list = Array.isArray(invoices) ? invoices : invoices ? [invoices] : [];
  for (const inv of list) {
    if (!inv) continue;
    if (!isLegacyJsonBarcode(inv.barcode)) continue;
    const orderRef = inv.order_id;
    let lookup = null;
    if (orderRef && typeof orderRef === "object") {
      lookup = orderRef.barcode_lookup || null;
    }
    if (!lookup) {
      lookup = `RW-${inv.order_number || ""}`.toUpperCase();
    }
    inv.barcode = lookup;
    await SaleInvoice.updateOne({ _id: inv._id }, { barcode: lookup });
  }
  return invoices;
};

/**
 * Creates or returns the SaleInvoice for a delivered Order.
 *
 * Exported for order.delivery side-effects and also used by the by-order API
 * as a self-healing read for legacy delivered orders.
 */
async function createFromOrder(orderDoc) {
  if (!orderDoc?._id) return null;

  const existing = await SaleInvoice.findOne({
    order_id: orderDoc._id,
    isDeleted: false,
  });
  if (existing) return existing;

  const createdCounter = await loadCounter(orderDoc.created_by_counter_id);
  const billedCounter = await loadCounter(orderDoc.billed_by_counter_id);
  const total = round2(orderDoc.total);
  const paid = round2(orderDoc.paid_amount);

  return SaleInvoice.create({
    order_id: orderDoc._id,
    order_number: orderDoc.order_number,
    barcode: orderDoc.barcode,
    items: (orderDoc.items || []).map((item) => ({
      product_id: item.product_id,
      name: item.name,
      quantity: item.quantity,
      unit_price: item.unit_price,
      total_price: item.total_price,
    })),
    subtotal: round2(orderDoc.subtotal),
    discount: round2(orderDoc.discount),
    total,
    paid_amount: paid,
    balance_amount: round2(Math.max(0, total - paid)),
    payment_status: orderDoc.payment_status,
    payments: (orderDoc.payments || []).map((p) => ({
      amount: p.amount,
      method: p.method,
      paid_at: p.paid_at,
      received_by_counter_id: p.received_by_counter_id,
      note: p.note,
    })),
    created_by_counter_id: orderDoc.created_by_counter_id || null,
    billed_by_counter_id: orderDoc.billed_by_counter_id || null,
    created_by_counter_snapshot: counterSnapshot(createdCounter),
    billed_by_counter_snapshot: counterSnapshot(billedCounter),
    customer_info: {
      name: orderDoc.customer_info?.name ?? "",
      phone: orderDoc.customer_info?.phone ?? "",
    },
    notes: orderDoc.notes ?? "",
    invoice_date: new Date(),
    delivered_at: orderDoc.delivered_at || new Date(),
    isDeleted: false,
  });
}

const list = async (req, res) => {
  try {
    const { start_date, end_date, payment_status } = req.query || {};
    const filter = { isDeleted: false };
    if (payment_status) filter.payment_status = Number(payment_status);
    if (start_date || end_date) {
      filter.invoice_date = {};
      if (start_date) filter.invoice_date.$gte = new Date(start_date);
      if (end_date) filter.invoice_date.$lte = new Date(end_date);
    }

    const items = await populateRefs(
      SaleInvoice.find(filter).sort({ invoice_date: -1, createdAt: -1 }),
    );
    const deletedItems = await populateRefs(
      SaleInvoice.find({ ...filter, isDeleted: true }).sort({
        invoice_date: -1,
        createdAt: -1,
      }),
    );
    await ensureCleanBarcode(items);
    await ensureCleanBarcode(deletedItems);
    return successMessage(
      res,
      { items, deletedItems },
      "Sale invoices fetched successfully.",
    );
  } catch (err) {
    console.error("SaleInvoice list error:", err);
    return createError(res, 500, err.message || "Failed to fetch invoices.");
  }
};

const getOne = async (req, res) => {
  try {
    const item = await populateRefs(
      SaleInvoice.findById(req.params.id).where({ isDeleted: false }),
    );
    if (!item) return createError(res, 404, "Sale invoice not found.");
    await ensureCleanBarcode(item);
    return successMessage(res, item, "Sale invoice fetched successfully.");
  } catch (err) {
    console.error("SaleInvoice getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch invoice.");
  }
};

const getByOrder = async (req, res) => {
  try {
    const Order = require("../Models/Order");
    const order = await Order.findById(req.params.orderId).where({
      isDeleted: false,
    });
    if (!order) return createError(res, 404, "Order not found.");
    if (Number(order.status) !== 3) {
      return createError(
        res,
        409,
        "Sale invoice is generated after order delivery.",
      );
    }

    const invoice = await createFromOrder(order);
    const populated = await populateRefs(SaleInvoice.findById(invoice._id));
    await ensureCleanBarcode(populated);
    return successMessage(
      res,
      populated,
      "Sale invoice fetched successfully.",
    );
  } catch (err) {
    console.error("SaleInvoice getByOrder error:", err);
    return createError(res, 500, err.message || "Failed to fetch invoice.");
  }
};

const getByBarcode = async (req, res) => {
  try {
    const code = String(req.params.code || "").trim();
    if (!code) return createError(res, 400, "Barcode is required.");
    const item = await populateRefs(
      SaleInvoice.findOne({ barcode: code, isDeleted: false }),
    );
    if (!item) return createError(res, 404, "Sale invoice not found.");
    await ensureCleanBarcode(item);
    return successMessage(res, item, "Sale invoice fetched successfully.");
  } catch (err) {
    console.error("SaleInvoice getByBarcode error:", err);
    return createError(res, 500, err.message || "Failed to fetch invoice.");
  }
};

const remove = async (req, res) => {
  try {
    const item = await SaleInvoice.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true },
    );
    if (!item) return createError(res, 404, "Sale invoice not found.");
    return successMessage(res, item, "Sale invoice deleted successfully.");
  } catch (err) {
    console.error("SaleInvoice remove error:", err);
    return createError(res, 500, err.message || "Failed to delete invoice.");
  }
};

module.exports = {
  list,
  getOne,
  getByOrder,
  getByBarcode,
  remove,
  createFromOrder,
};
