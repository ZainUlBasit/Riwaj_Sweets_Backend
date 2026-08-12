const Order = require("../Models/Order");
const SaleInvoice = require("../Models/SaleInvoice");
const SupplierPayment = require("../Models/SupplierPayment");
const RawMaterialStock = require("../Models/RawMaterialStock");
const ProductStock = require("../Models/ProductStock");
const { createError, successMessage } = require("../utils/ResponseMessage");

const SECTION = {
  SALE_INVOICE: "sale_invoice",
  RETURN_INVOICE: "return_invoice",
  BUILTI: "builti",
  CASH_CUSTOMER: "cash_customer",
  CASH_SUPPLIER: "cash_supplier",
  SALE_NET: "sale_net",
  PURCHASE_CASH: "purchase_cash",
};

const SECTION_LABELS = {
  [SECTION.SALE_INVOICE]: "Sale Invoice",
  [SECTION.RETURN_INVOICE]: "Return Invoice",
  [SECTION.BUILTI]: "Builti (Purchases)",
  [SECTION.CASH_CUSTOMER]: "Cash Payment — Customer",
  [SECTION.CASH_SUPPLIER]: "Cash Payment — Supplier",
  [SECTION.SALE_NET]: "Sale Invoice + Return Invoice",
  [SECTION.PURCHASE_CASH]: "Builti + Supplier Payment",
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const dayBounds = (dateStr) => {
  const start = new Date(dateStr);
  start.setHours(0, 0, 0, 0);
  const end = new Date(dateStr);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

const parseDateParam = (raw) => {
  const date = String(raw || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return date;
};

async function loadSaleInvoices(start, end) {
  const items = await SaleInvoice.find({
    isDeleted: false,
    invoice_date: { $gte: start, $lte: end },
  })
    .populate("order_id", "order_number barcode customer_info")
    .sort({ invoice_date: -1, invoice_number: -1 })
    .lean();

  return items.map((inv) => ({
    _id: inv._id,
    type: SECTION.SALE_INVOICE,
    ref: inv.invoice_number ? `SI-${inv.invoice_number}` : String(inv._id),
    date: inv.invoice_date,
    party: inv.customer_info?.name || "Walk-in",
    phone: inv.customer_info?.phone || "",
    amount: round2(inv.total),
    paid: round2(inv.paid_amount),
    balance: round2(inv.balance_amount),
    payment_status: inv.payment_status,
    notes: inv.notes || "",
    meta: {
      order_number: inv.order_number,
      barcode: inv.barcode,
      items_count: Array.isArray(inv.items) ? inv.items.length : 0,
    },
  }));
}

async function loadReturnInvoices() {
  // Customer return invoices are not in the live sweets backend yet.
  return [];
}

async function loadBuiltiPurchases(start, end) {
  const [rmRows, productRows] = await Promise.all([
    RawMaterialStock.find({
      isDeleted: false,
      purpose: 1,
      createdAt: { $gte: start, $lte: end },
    })
      .populate("raw_material_id", "name unit")
      .populate("supplier_id", "name contact")
      .sort({ createdAt: -1 })
      .lean(),
    ProductStock.find({
      isDeleted: false,
      source: 2,
      createdAt: { $gte: start, $lte: end },
    })
      .populate("product_id", "name unit")
      .populate("supplier_id", "name contact")
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  const rmItems = rmRows.map((row) => ({
    _id: row._id,
    type: SECTION.BUILTI,
    subtype: "raw_material",
    ref: row.desc || `RM-${String(row._id).slice(-6)}`,
    date: row.createdAt,
    party: row.supplier_id?.name || "Supplier",
    phone: row.supplier_id?.contact || "",
    amount: round2(row.total_price),
    qty: Number(row.quantity || 0),
    item_name: row.raw_material_id?.name || "Raw material",
    notes: row.desc || "",
    meta: {
      unit_price: Number(row.price || 0),
      unit: row.raw_material_id?.unit ?? null,
    },
  }));

  const productItems = productRows.map((row) => ({
    _id: row._id,
    type: SECTION.BUILTI,
    subtype: "product",
    ref: row.stock_code || row.desc || `PS-${String(row._id).slice(-6)}`,
    date: row.createdAt,
    party: row.supplier_id?.name || "Supplier",
    phone: row.supplier_id?.contact || "",
    amount: round2(row.total_price),
    qty: Number(row.quantity || 0),
    item_name: row.product_id?.name || "Product",
    notes: row.desc || "",
    meta: {
      unit_price: Number(row.price || 0),
      unit: row.product_id?.unit ?? null,
      stock_code: row.stock_code || null,
    },
  }));

  return [...rmItems, ...productItems].sort(
    (a, b) => new Date(b.date) - new Date(a.date),
  );
}

async function loadCustomerCashPayments(start, end) {
  const rows = await Order.aggregate([
    { $match: { isDeleted: false } },
    { $unwind: "$payments" },
    {
      $match: {
        "payments.paid_at": { $gte: start, $lte: end },
      },
    },
    { $sort: { "payments.paid_at": -1 } },
    {
      $project: {
        _id: 0,
        order_id: "$_id",
        order_number: 1,
        barcode: 1,
        customer_info: 1,
        payment: "$payments",
      },
    },
  ]);

  return rows.map((row) => ({
    _id: `${row.order_id}-${row.payment?.paid_at || ""}-${row.payment?.amount || 0}`,
    type: SECTION.CASH_CUSTOMER,
    ref: row.order_number ? `ORD-${row.order_number}` : String(row.order_id),
    date: row.payment?.paid_at,
    party: row.customer_info?.name || "Walk-in",
    phone: row.customer_info?.phone || "",
    amount: round2(row.payment?.amount),
    method: row.payment?.method || "cash",
    notes: row.payment?.note || "",
    meta: {
      order_id: row.order_id,
      barcode: row.barcode || "",
    },
  }));
}

async function loadSupplierCashPayments(start, end) {
  const rows = await SupplierPayment.find({
    isDeleted: false,
    payment_date: { $gte: start, $lte: end },
  })
    .populate("supplier_id", "name contact")
    .sort({ payment_date: -1, createdAt: -1 })
    .lean();

  return rows.map((row) => ({
    _id: row._id,
    type: SECTION.CASH_SUPPLIER,
    ref: `SP-${String(row._id).slice(-6).toUpperCase()}`,
    date: row.payment_date,
    party: row.supplier_id?.name || "Supplier",
    phone: row.supplier_id?.contact || "",
    amount: round2(row.amount),
    method: Number(row.payment_type) === 2 ? "bank" : "cash",
    notes: row.notes || "",
    meta: {
      supplier_id: row.supplier_id?._id || row.supplier_id,
      payment_type: row.payment_type,
    },
  }));
}

const sumAmount = (items) =>
  round2(items.reduce((s, row) => s + Number(row.amount || 0), 0));

const sectionSummary = (key, items, extras = {}) => ({
  key,
  label: SECTION_LABELS[key] || key,
  count: items.length,
  amount: sumAmount(items),
  ...extras,
});

async function buildDayPayload(date, { withItems = true } = {}) {
  const { start, end } = dayBounds(date);

  const [sale_invoice, return_invoice, builti, cash_customer, cash_supplier] =
    await Promise.all([
      loadSaleInvoices(start, end),
      loadReturnInvoices(start, end),
      loadBuiltiPurchases(start, end),
      loadCustomerCashPayments(start, end),
      loadSupplierCashPayments(start, end),
    ]);

  const saleAmount = sumAmount(sale_invoice);
  const returnAmount = sumAmount(return_invoice);
  const builtiAmount = sumAmount(builti);
  const customerCashAmount = sumAmount(cash_customer);
  const supplierCashAmount = sumAmount(cash_supplier);

  const sections = {
    [SECTION.SALE_INVOICE]: sectionSummary(SECTION.SALE_INVOICE, sale_invoice),
    [SECTION.RETURN_INVOICE]: sectionSummary(
      SECTION.RETURN_INVOICE,
      return_invoice,
      { note: "Return invoices module abhi live nahi — total 0." },
    ),
    [SECTION.BUILTI]: sectionSummary(SECTION.BUILTI, builti, {
      note: "Supplier se RM / Product stock purchases (Builti).",
    }),
    [SECTION.CASH_CUSTOMER]: sectionSummary(
      SECTION.CASH_CUSTOMER,
      cash_customer,
    ),
    [SECTION.CASH_SUPPLIER]: sectionSummary(
      SECTION.CASH_SUPPLIER,
      cash_supplier,
    ),
    [SECTION.SALE_NET]: {
      key: SECTION.SALE_NET,
      label: SECTION_LABELS[SECTION.SALE_NET],
      count: sale_invoice.length + return_invoice.length,
      amount: round2(saleAmount - returnAmount),
      sale_amount: saleAmount,
      return_amount: returnAmount,
    },
    [SECTION.PURCHASE_CASH]: {
      key: SECTION.PURCHASE_CASH,
      label: SECTION_LABELS[SECTION.PURCHASE_CASH],
      count: builti.length + cash_supplier.length,
      amount: round2(builtiAmount + supplierCashAmount),
      builti_amount: builtiAmount,
      supplier_payment_amount: supplierCashAmount,
    },
  };

  const payload = {
    date,
    sections,
    totals: {
      sale_invoice: saleAmount,
      return_invoice: returnAmount,
      sale_net: round2(saleAmount - returnAmount),
      builti: builtiAmount,
      cash_customer: customerCashAmount,
      cash_supplier: supplierCashAmount,
      purchase_cash: round2(builtiAmount + supplierCashAmount),
      cash_in: customerCashAmount,
      cash_out: supplierCashAmount,
      net_cash: round2(customerCashAmount - supplierCashAmount),
    },
  };

  if (withItems) {
    payload.items = {
      [SECTION.SALE_INVOICE]: sale_invoice,
      [SECTION.RETURN_INVOICE]: return_invoice,
      [SECTION.BUILTI]: builti,
      [SECTION.CASH_CUSTOMER]: cash_customer,
      [SECTION.CASH_SUPPLIER]: cash_supplier,
      [SECTION.SALE_NET]: [...sale_invoice, ...return_invoice],
      [SECTION.PURCHASE_CASH]: [...builti, ...cash_supplier],
    };
  }

  return payload;
}

/**
 * GET /api/daily-report?date=YYYY-MM-DD
 * Day summary cards (no line items).
 */
const summary = async (req, res) => {
  try {
    const date = parseDateParam(req.query.date);
    if (!date) {
      return createError(res, 400, "Valid date required (YYYY-MM-DD).");
    }
    const payload = await buildDayPayload(date, { withItems: false });
    return successMessage(res, payload, "Daily report summary fetched.");
  } catch (err) {
    console.error("DailyReport summary error:", err);
    return createError(res, 500, err.message || "Failed to fetch daily report.");
  }
};

/**
 * GET /api/daily-report/:date
 * Full day detail with all section line items.
 */
const detail = async (req, res) => {
  try {
    const date = parseDateParam(req.params.date);
    if (!date) {
      return createError(res, 400, "Valid date required (YYYY-MM-DD).");
    }
    const section = String(req.params.section || "").trim();
    const payload = await buildDayPayload(date, { withItems: true });

    if (section) {
      if (!SECTION_LABELS[section]) {
        return createError(res, 400, "Invalid report section.");
      }
      return successMessage(
        res,
        {
          date,
          section: {
            ...payload.sections[section],
            items: payload.items[section] || [],
          },
          sections: payload.sections,
          totals: payload.totals,
        },
        "Daily report section fetched.",
      );
    }

    return successMessage(res, payload, "Daily report detail fetched.");
  } catch (err) {
    console.error("DailyReport detail error:", err);
    return createError(res, 500, err.message || "Failed to fetch daily report.");
  }
};

module.exports = {
  summary,
  detail,
  SECTION,
  SECTION_LABELS,
};
