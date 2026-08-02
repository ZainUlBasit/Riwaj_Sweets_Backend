const Order = require("../Models/Order");
const Supplier = require("../Models/Supplier");
const Product = require("../Models/Products");
const RawMaterial = require("../Models/RawMaterial");
const CakeOrder = require("../Models/CakeOrder");
const CakeProduction = require("../Models/CakeProduction");
const Shop = require("../Models/Shop");
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

const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
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
    ] = await Promise.all([
      // Today's delivered / billed order totals
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
      // Daily sales — last 7 days
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
      // Monthly — last 12 calendar months
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

    // Fill last 7 days continuously
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

    // Fill last 12 months
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
      // Back-compat keys used by older UI fragments
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
