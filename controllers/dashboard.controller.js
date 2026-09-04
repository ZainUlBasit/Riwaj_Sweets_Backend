const Order = require("../Models/Order");
const Supplier = require("../Models/Supplier");
const Product = require("../Models/Products");
const RawMaterial = require("../Models/RawMaterial");
const CakeOrder = require("../Models/CakeOrder");
const CakeProduction = require("../Models/CakeProduction");
const Shop = require("../Models/Shop");
const UstadJob = require("../Models/UstadJob");
const ProductTransfer = require("../Models/ProductTransfer");
const { TRANSFER_STATUS } = require("../Models/ProductTransfer");
const { LOCATION_TYPE } = require("../Services/inventoryService");
const { createError, successMessage } = require("../utils/ResponseMessage");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const startOfDay = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const endOfDay = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};

const startOfMonth = (d = new Date()) => {
  const x = new Date(d.getFullYear(), d.getMonth(), 1);
  x.setHours(0, 0, 0, 0);
  return x;
};

const startOfYear = (d = new Date()) => {
  const x = new Date(d.getFullYear(), 0, 1);
  x.setHours(0, 0, 0, 0);
  return x;
};

const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

const toDateKey = (d = new Date()) => {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const fmtDateStr = (d) => {
  if (!d) return "";
  try {
    return toDateKey(d);
  } catch {
    return "";
  }
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const resolveOpsPeriod = (query = {}, now = new Date()) => {
  const periodRaw = query.period || query;
  const p = String(
    typeof periodRaw === "object" ? periodRaw.period || "daily" : periodRaw || "daily",
  ).toLowerCase();
  const q = typeof query === "object" && query && !Array.isArray(query) ? query : {};

  if (p === "monthly") {
    let y = now.getFullYear();
    let m = now.getMonth(); // 0-based
    const monthStr = String(q.month || "").trim();
    if (/^\d{4}-\d{2}$/.test(monthStr)) {
      y = Number(monthStr.slice(0, 4));
      m = Number(monthStr.slice(5, 7)) - 1;
    }
    const start = new Date(y, m, 1);
    start.setHours(0, 0, 0, 0);
    const endOfSelectedMonth = new Date(y, m + 1, 0, 23, 59, 59, 999);
    const end =
      y === now.getFullYear() && m === now.getMonth()
        ? endOfDay(now)
        : endOfSelectedMonth;
    return {
      period: "monthly",
      start,
      end,
      start_date: toDateKey(start),
      end_date: toDateKey(end),
      label: `${MONTH_LABELS[m]} ${y}`,
      month: `${y}-${String(m + 1).padStart(2, "0")}`,
    };
  }

  if (p === "yearly") {
    let y = now.getFullYear();
    const yearStr = String(q.year || "").trim();
    if (/^\d{4}$/.test(yearStr)) y = Number(yearStr);
    const start = new Date(y, 0, 1);
    start.setHours(0, 0, 0, 0);
    const endOfSelectedYear = new Date(y, 11, 31, 23, 59, 59, 999);
    const end = y === now.getFullYear() ? endOfDay(now) : endOfSelectedYear;
    return {
      period: "yearly",
      start,
      end,
      start_date: toDateKey(start),
      end_date: toDateKey(end),
      label: String(y),
      year: String(y),
    };
  }

  let day = now;
  const dateStr = String(q.date || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [yy, mm, dd] = dateStr.split("-").map(Number);
    day = new Date(yy, mm - 1, dd);
  }
  const start = startOfDay(day);
  const end = endOfDay(day);
  return {
    period: "daily",
    start,
    end,
    start_date: toDateKey(start),
    end_date: toDateKey(end),
    label: toDateKey(start),
    date: toDateKey(start),
  };
};

/**
 * Admin ops strip: RM Diya, Product Receive (shop/store), Shop IN.
 * Details included for click-through — does not change other dashboard logic.
 */
async function buildOpsInRange(rangeStart, rangeEnd, meta = {}) {
  const [jobs, productions, transfers] = await Promise.all([
    UstadJob.find({ isDeleted: false })
      .select("job_code ustad_name issue_date lines")
      .populate("lines.raw_material_id", "name unit")
      .lean(),
    CakeProduction.find({
      isDeleted: false,
      production_date: { $gte: rangeStart, $lte: rangeEnd },
    })
      .populate("product_id", "name unit price")
      .populate({
        path: "store_receipt_id",
        select: "receipt_code to_location_id",
        populate: { path: "to_location_id", select: "name location_type" },
      })
      .populate({
        path: "product_stock_id",
        select: "location_id",
        populate: { path: "location_id", select: "name location_type" },
      })
      .lean(),
    ProductTransfer.find({
      isDeleted: false,
      status: { $ne: TRANSFER_STATUS.CANCELLED },
      transfer_date: { $gte: rangeStart, $lte: rangeEnd },
    })
      .populate("product_id", "name unit price")
      .populate("from_location_id", "name")
      .populate("to_location_id", "name location_type")
      .lean(),
  ]);

  const rmDetails = [];
  for (const job of jobs) {
    for (const line of job.lines || []) {
      const issuedAt = line.issued_at || job.issue_date;
      if (!issuedAt) continue;
      const t = new Date(issuedAt).getTime();
      if (t < rangeStart.getTime() || t > rangeEnd.getTime()) continue;
      const qty = Number(line.quantity || 0);
      const value = Number(line.line_value || 0);
      rmDetails.push({
        date: fmtDateStr(issuedAt),
        job_code: job.job_code || "—",
        ustad_name: job.ustad_name || "—",
        material: line.raw_material_id?.name || "—",
        unit: line.raw_material_id?.unit || "",
        quantity: round2(qty),
        unit_price: round2(line.unit_price),
        line_value: round2(value),
        is_extra: Boolean(line.is_extra),
      });
    }
  }
  rmDetails.sort((a, b) =>
    String(b.ustad_name).localeCompare(String(a.ustad_name)),
  );

  const rm_diya = {
    value: round2(rmDetails.reduce((s, r) => s + Number(r.line_value || 0), 0)),
    quantity: round2(rmDetails.reduce((s, r) => s + Number(r.quantity || 0), 0)),
    lines_count: rmDetails.length,
    details: rmDetails,
  };

  const byLoc = new Map();
  const bumpLoc = (loc, qty, value) => {
    const id = String(loc?._id || loc?.id || "unknown");
    const name = loc?.name || "—";
    const type = Number(loc?.location_type || 0);
    if (!byLoc.has(id)) {
      byLoc.set(id, {
        id,
        name,
        location_type: type,
        quantity: 0,
        value: 0,
      });
    }
    const row = byLoc.get(id);
    row.quantity = round2(row.quantity + qty);
    row.value = round2(row.value + value);
  };

  const receiveDetails = [];
  for (const p of productions) {
    const qty = Number(p.cakes_produced || 0);
    const unitPrice = Number(p.product_id?.price || 0);
    const value = round2(qty * unitPrice);
    const dest =
      p.store_receipt_id?.to_location_id ||
      p.product_stock_id?.location_id ||
      null;
    const destType = Number(dest?.location_type || 0);
    const destKind =
      destType === LOCATION_TYPE.SHOP
        ? "shop"
        : destType === LOCATION_TYPE.FINISHED_GOODS_STORE
          ? "product_store"
          : "other";
    if (dest) bumpLoc(dest, qty, value);
    receiveDetails.push({
      date: fmtDateStr(p.production_date),
      product_name: p.product_id?.name || "—",
      unit: p.product_id?.unit || "",
      quantity: round2(qty),
      unit_price: round2(unitPrice),
      value,
      destination_name: dest?.name || "—",
      destination_type: destKind,
      ustad_name: p.ustad_name || "—",
      receipt_code: p.store_receipt_id?.receipt_code || null,
    });
  }

  const toShopLocs = [];
  const toStoreLocs = [];
  let shopQty = 0;
  let shopVal = 0;
  let storeQty = 0;
  let storeVal = 0;
  for (const row of byLoc.values()) {
    if (row.location_type === LOCATION_TYPE.SHOP) {
      toShopLocs.push(row);
      shopQty += row.quantity;
      shopVal += row.value;
    } else if (row.location_type === LOCATION_TYPE.FINISHED_GOODS_STORE) {
      toStoreLocs.push(row);
      storeQty += row.quantity;
      storeVal += row.value;
    }
  }
  toShopLocs.sort((a, b) => a.name.localeCompare(b.name));
  toStoreLocs.sort((a, b) => a.name.localeCompare(b.name));

  const product_receive = {
    total_qty: round2(
      receiveDetails.reduce((s, r) => s + Number(r.quantity || 0), 0),
    ),
    total_value: round2(
      receiveDetails.reduce((s, r) => s + Number(r.value || 0), 0),
    ),
    to_shop: {
      quantity: round2(shopQty),
      value: round2(shopVal),
      by_location: toShopLocs,
    },
    to_product_store: {
      quantity: round2(storeQty),
      value: round2(storeVal),
      by_location: toStoreLocs,
    },
    details: receiveDetails,
  };

  // Shop IN = everything that entered a shop:
  // 1) Product Store → Shop transfers
  // 2) Direct production receive into Shop (so every shop with inbound shows up)
  const shopByLoc = new Map();
  const shopDetails = [];
  const bumpShop = (shopId, shopName, qty, value) => {
    const id = String(shopId || "unknown");
    if (!shopByLoc.has(id)) {
      shopByLoc.set(id, {
        id,
        name: shopName || "—",
        quantity: 0,
        value: 0,
      });
    }
    const row = shopByLoc.get(id);
    row.quantity = round2(row.quantity + qty);
    row.value = round2(row.value + value);
  };

  for (const t of transfers) {
    const shop = t.to_location_id;
    if (Number(shop?.location_type) !== LOCATION_TYPE.SHOP) continue;
    const qty = Number(t.quantity || 0);
    const unitPrice = Number(t.product_id?.price || 0);
    const value = round2(qty * unitPrice);
    const shopId = String(shop?._id || "unknown");
    const shopName = shop?.name || "—";
    bumpShop(shopId, shopName, qty, value);
    shopDetails.push({
      date: fmtDateStr(t.transfer_date),
      product_name: t.product_id?.name || "—",
      unit: t.product_id?.unit || "",
      quantity: round2(qty),
      value,
      from_name: t.from_location_id?.name || "—",
      shop_name: shopName,
      transfer_code: t.transfer_code || null,
      status: Number(t.status),
      received: Number(t.status) === TRANSFER_STATUS.RECEIVED,
      source: "transfer",
    });
  }

  for (const p of productions) {
    const dest =
      p.store_receipt_id?.to_location_id ||
      p.product_stock_id?.location_id ||
      null;
    if (!dest || Number(dest.location_type) !== LOCATION_TYPE.SHOP) continue;
    const qty = Number(p.cakes_produced || 0);
    const unitPrice = Number(p.product_id?.price || 0);
    const value = round2(qty * unitPrice);
    const shopId = String(dest._id || "unknown");
    const shopName = dest.name || "—";
    bumpShop(shopId, shopName, qty, value);
    shopDetails.push({
      date: fmtDateStr(p.production_date),
      product_name: p.product_id?.name || "—",
      unit: p.product_id?.unit || "",
      quantity: round2(qty),
      value,
      from_name: "Direct receive",
      shop_name: shopName,
      transfer_code: p.store_receipt_id?.receipt_code || null,
      status: TRANSFER_STATUS.RECEIVED,
      received: true,
      source: "direct_receive",
    });
  }

  shopDetails.sort((a, b) => {
    const byShop = String(a.shop_name).localeCompare(String(b.shop_name));
    if (byShop !== 0) return byShop;
    return String(a.date).localeCompare(String(b.date));
  });

  const by_shop = Array.from(shopByLoc.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const shop_in = {
    total_qty: round2(
      shopDetails.reduce((s, r) => s + Number(r.quantity || 0), 0),
    ),
    total_value: round2(
      shopDetails.reduce((s, r) => s + Number(r.value || 0), 0),
    ),
    by_shop,
    details: shopDetails,
  };

  return {
    period: meta.period || "daily",
    date: meta.end_date || meta.start_date || "",
    start_date: meta.start_date || "",
    end_date: meta.end_date || "",
    label: meta.label || meta.end_date || "",
    rm_diya,
    product_receive,
    shop_in,
  };
}

const ORDER_STATUS = {
  1: "Pending",
  2: "Billed",
  3: "Delivered",
  4: "Cancelled",
};

const PAYMENT_STATUS = {
  1: "Unpaid",
  2: "Partial",
  3: "Paid",
};

const CAKE_ORDER_STATUS = {
  1: "Pending",
  2: "In design",
  3: "Ready",
  4: "Completed",
  5: "Cancelled",
};

/**
 * GET /api/dashboard/get-data
 * Owner / admin business snapshot from live collections.
 */
const getData = async (req, res) => {
  try {
    const now = new Date();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);
    const monthStart = startOfMonth(now);
    const last7Start = startOfDay(addDays(now, -6));
    const last30Start = startOfDay(addDays(now, -29));
    const opsPeriod = resolveOpsPeriod(req.query || {}, now);

    const activeOrderFilter = { isDeleted: false, status: { $ne: 4 } };

    const [
      todaySalesAgg,
      monthSalesAgg,
      collectedTodayAgg,
      ordersToday,
      pendingOrders,
      receivableAgg,
      supplierStats,
      productStockAgg,
      rmStockAgg,
      productCount,
      shopCount,
      openCakeOrders,
      productionTodayAgg,
      orderStatusAgg,
      paymentStatusAgg,
      dailySalesRaw,
      monthlySalesRaw,
      yearlySalesRaw,
      topProductsRaw,
      cakeOrderStatusAgg,
      salesLast30Agg,
      ops,
    ] = await Promise.all([
      Order.aggregate([
        {
          $match: {
            ...activeOrderFilter,
            status: { $in: [2, 3] },
            createdAt: { $gte: todayStart, $lte: todayEnd },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$total" },
            count: { $sum: 1 },
            paid: { $sum: "$paid_amount" },
          },
        },
      ]),
      Order.aggregate([
        {
          $match: {
            ...activeOrderFilter,
            status: { $in: [2, 3] },
            createdAt: { $gte: monthStart, $lte: todayEnd },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$total" },
            count: { $sum: 1 },
            paid: { $sum: "$paid_amount" },
          },
        },
      ]),
      Order.aggregate([
        { $match: { isDeleted: false } },
        { $unwind: "$payments" },
        {
          $match: {
            "payments.paid_at": { $gte: todayStart, $lte: todayEnd },
          },
        },
        { $group: { _id: null, total: { $sum: "$payments.amount" } } },
      ]),
      Order.countDocuments({
        isDeleted: false,
        createdAt: { $gte: todayStart, $lte: todayEnd },
      }),
      Order.countDocuments({ isDeleted: false, status: 1 }),
      Order.aggregate([
        { $match: { ...activeOrderFilter, payment_status: { $in: [1, 2] } } },
        {
          $group: {
            _id: null,
            receivable: {
              $sum: { $subtract: ["$total", { $ifNull: ["$paid_amount", 0] }] },
            },
          },
        },
      ]),
      Supplier.aggregate([
        { $match: { isDeleted: false } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            payable: { $sum: { $ifNull: ["$payable", 0] } },
            total_amount: { $sum: { $ifNull: ["$total_amount", 0] } },
            paid: { $sum: { $ifNull: ["$paid", 0] } },
          },
        },
      ]),
      Product.aggregate([
        { $match: { isDeleted: false } },
        {
          $group: {
            _id: null,
            value: {
              $sum: {
                $multiply: [
                  { $ifNull: ["$available_quantity", 0] },
                  { $ifNull: ["$price", 0] },
                ],
              },
            },
            qty: { $sum: { $ifNull: ["$available_quantity", 0] } },
          },
        },
      ]),
      RawMaterial.aggregate([
        { $match: { isDeleted: false } },
        {
          $group: {
            _id: null,
            value: {
              $sum: {
                $multiply: [
                  { $ifNull: ["$available_quantity", 0] },
                  { $ifNull: ["$price", 0] },
                ],
              },
            },
            qty: { $sum: { $ifNull: ["$available_quantity", 0] } },
          },
        },
      ]),
      Product.countDocuments({ isDeleted: false }),
      Shop.countDocuments({ isDeleted: false }),
      CakeOrder.countDocuments({
        isDeleted: false,
        status: { $in: [1, 2, 3] },
      }),
      CakeProduction.aggregate([
        {
          $match: {
            isDeleted: false,
            production_date: { $gte: todayStart, $lte: todayEnd },
          },
        },
        { $group: { _id: null, total: { $sum: "$cakes_produced" } } },
      ]),
      Order.aggregate([
        { $match: { isDeleted: false } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: { ...activeOrderFilter } },
        { $group: { _id: "$payment_status", count: { $sum: 1 } } },
      ]),
      Order.aggregate([
        {
          $match: {
            ...activeOrderFilter,
            status: { $in: [2, 3] },
            createdAt: { $gte: last7Start, $lte: todayEnd },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
            },
            amount: { $sum: "$total" },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Order.aggregate([
        {
          $match: {
            ...activeOrderFilter,
            status: { $in: [2, 3] },
            createdAt: {
              $gte: new Date(now.getFullYear() - 1, now.getMonth(), 1),
              $lte: todayEnd,
            },
          },
        },
        {
          $group: {
            _id: {
              y: { $year: "$createdAt" },
              m: { $month: "$createdAt" },
            },
            amount: { $sum: "$total" },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.y": 1, "_id.m": 1 } },
      ]),
      Order.aggregate([
        {
          $match: {
            ...activeOrderFilter,
            status: { $in: [2, 3] },
          },
        },
        {
          $group: {
            _id: { $year: "$createdAt" },
            amount: { $sum: "$total" },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Order.aggregate([
        {
          $match: {
            ...activeOrderFilter,
            status: { $in: [2, 3] },
            createdAt: { $gte: last30Start, $lte: todayEnd },
          },
        },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.name",
            quantity: { $sum: "$items.quantity" },
            revenue: { $sum: "$items.total_price" },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 8 },
        {
          $project: {
            _id: 0,
            name: "$_id",
            quantity: 1,
            revenue: 1,
          },
        },
      ]),
      CakeOrder.aggregate([
        { $match: { isDeleted: false } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      Order.aggregate([
        {
          $match: {
            ...activeOrderFilter,
            status: { $in: [2, 3] },
            createdAt: { $gte: last30Start, $lte: todayEnd },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$total" },
            count: { $sum: 1 },
          },
        },
      ]),
      buildOpsInRange(opsPeriod.start, opsPeriod.end, opsPeriod),
    ]);

    const todaySales = todaySalesAgg[0] || { total: 0, count: 0, paid: 0 };
    const monthSales = monthSalesAgg[0] || { total: 0, count: 0, paid: 0 };
    const collectedToday = collectedTodayAgg[0]?.total || 0;
    const receivable = round2(receivableAgg[0]?.receivable || 0);
    const suppliers = supplierStats[0] || {
      count: 0,
      payable: 0,
      total_amount: 0,
      paid: 0,
    };
    const productStock = productStockAgg[0] || { value: 0, qty: 0 };
    const rmStock = rmStockAgg[0] || { value: 0, qty: 0 };
    const stockValue = round2(
      Number(productStock.value || 0) + Number(rmStock.value || 0),
    );
    const payable = round2(suppliers.payable || 0);
    const productionToday = productionTodayAgg[0]?.total || 0;
    const salesLast30 = salesLast30Agg[0] || { total: 0, count: 0 };

    const dailyMap = new Map(
      (dailySalesRaw || []).map((r) => [r._id, round2(r.amount)]),
    );
    const daily = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDays(now, -i);
      const key = d.toISOString().slice(0, 10);
      daily.push({
        label: DAY_LABELS[d.getDay()],
        date: key,
        amount: dailyMap.get(key) || 0,
      });
    }

    const monthMap = new Map(
      (monthlySalesRaw || []).map((r) => [
        `${r._id.y}-${String(r._id.m).padStart(2, "0")}`,
        round2(r.amount),
      ]),
    );
    const monthly = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      monthly.push({
        label: MONTH_LABELS[d.getMonth()],
        date: key,
        amount: monthMap.get(key) || 0,
      });
    }

    const yearly = (yearlySalesRaw || []).map((r) => ({
      label: String(r._id),
      amount: round2(r.amount),
    }));

    const order_status = [1, 2, 3, 4].map((code) => {
      const row = (orderStatusAgg || []).find((r) => Number(r._id) === code);
      return {
        key: code,
        label: ORDER_STATUS[code],
        value: row?.count || 0,
      };
    });

    const payment_status = [1, 2, 3].map((code) => {
      const row = (paymentStatusAgg || []).find((r) => Number(r._id) === code);
      return {
        key: code,
        label: PAYMENT_STATUS[code],
        value: row?.count || 0,
      };
    });

    const cake_order_status = [1, 2, 3, 4, 5].map((code) => {
      const row = (cakeOrderStatusAgg || []).find((r) => Number(r._id) === code);
      return {
        key: code,
        label: CAKE_ORDER_STATUS[code],
        value: row?.count || 0,
      };
    });

    const top_products = (topProductsRaw || []).map((r) => ({
      name: r.name || "Unknown",
      quantity: round2(r.quantity),
      revenue: round2(r.revenue),
    }));

    const netPosition = round2(receivable + stockValue - payable);

    const payload = {
      generated_at: now.toISOString(),
      kpis: {
        today_sales: round2(todaySales.total),
        today_orders: ordersToday,
        today_paid: round2(todaySales.paid),
        collected_today: round2(collectedToday),
        month_sales: round2(monthSales.total),
        month_orders: monthSales.count || 0,
        last30_sales: round2(salesLast30.total),
        last30_orders: salesLast30.count || 0,
        pending_orders: pendingOrders,
        open_cake_orders: openCakeOrders,
        production_today: round2(productionToday),
        suppliers: suppliers.count || 0,
        products: productCount,
        shops: shopCount,
      },
      financial: {
        receivable,
        payable,
        product_stock: round2(productStock.value || 0),
        rm_stock: round2(rmStock.value || 0),
        stock: stockValue,
        net_position: netPosition,
        collected_today: round2(collectedToday),
      },
      current_value: {
        cash: round2(collectedToday),
        bank: 0,
        receivable,
        payable,
        stock: stockValue,
        total_value: netPosition,
      },
      sales_trend: {
        daily,
        monthly,
        yearly,
      },
      order_status,
      payment_status,
      cake_order_status,
      top_products,
      ops,
    };

    return successMessage(res, payload, "Dashboard data fetched successfully.");
  } catch (err) {
    console.error("Dashboard getData error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to fetch dashboard data.",
    );
  }
};

module.exports = { getData };
