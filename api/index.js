const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});
const express = require("express");
const port = Number(process.env.PORT) || 8000;
const app = express();
const http = require("http");
const server = http.createServer(app);
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const cors = require("cors");

global.rootDirectory = path.resolve(__dirname, "..");

// Behind Hostinger / reverse proxy (HTTPS termination)
app.set("trust proxy", 1);

// CORS allowlist (env-driven, with sensible defaults for prod + local dev).
// Configure by setting CORS_ORIGINS to a comma-separated list, e.g.
//   CORS_ORIGINS="https://www.riwajsweets.com,https://staging.riwajsweets.com"
const DEFAULT_ALLOWED_ORIGINS = [
  "https://www.riwajsweets.com",
  "http://localhost:3000",
  "http://localhost:1420", // Tauri shop desktop (vite)
  "http://localhost:5173",
  "http://localhost:5171",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://localhost:5176",
  "http://localhost:5179",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:1420",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:5175",
  "http://127.0.0.1:5176",
  "http://127.0.0.1:5179",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];

const envOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = [
  ...DEFAULT_ALLOWED_ORIGINS,
  ...envOrigins.filter((o) => !DEFAULT_ALLOWED_ORIGINS.includes(o)),
];

const isLocalhostOrigin = (origin) =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

const isTauriOrigin = (origin) =>
  /^tauri:\/\//.test(origin) ||
  /^https?:\/\/tauri\.localhost(?::\d+)?$/.test(origin);

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman, some desktop shells)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Desktop / local Vite always allowed (Tauri shop POS + local ERP)
    if (isLocalhostOrigin(origin) || isTauriOrigin(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Origin",
    "X-Requested-With",
    "Content-Type",
    "Accept",
    "Authorization",
    "token",
    "accesstoken",
    "refreshtoken",
    "counter-token",
    "countertoken",
    "shop-token",
    "shoptoken",
  ],
  optionsSuccessStatus: 200, // Some legacy browsers choke on 204
};

// Middleware
app.use(cors(corsOptions));

// Additional middleware for cookie handling
app.use((req, res, next) => {
  // Ensure cookies are properly handled for all requests
  res.header("Access-Control-Allow-Credentials", "true");
  next();
});
app.use(cookieParser());
app.use(express.json());

// Database connection middleware for serverless
app.use(async (req, res, next) => {
  try {
    await connectToDatabase();
    next();
  } catch (error) {
    console.error("Database connection failed:", error);
    return res.status(500).json({
      success: false,
      error: { msg: "Database connection failed" },
    });
  }
});

// MongoDB connection with caching for serverless
let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function connectToDatabase() {
  if (cached.conn) {
    return cached.conn;
  }

  const uri =
    process.env.MONGOOSEURL ||
    process.env.MONGODB_URI ||
    process.env.MONGO_URI;

  if (!uri || typeof uri !== "string") {
    throw new Error(
      "MongoDB URI missing. Set MONGOOSEURL (or MONGODB_URI) in environment variables.",
    );
  }

  if (!cached.promise) {
    const opts = {
      bufferCommands: false,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 20_000,
      connectTimeoutMS: 20_000,
      socketTimeoutMS: 120_000,
      family: 4,
      maxIdleTimeMS: 60_000,
    };

    cached.promise = mongoose
      .connect(uri, opts)
      .then((mongoose) => {
        console.log("✅ Database connected");
        return mongoose;
      });
  }

  try {
    cached.conn = await cached.promise;
  } catch (e) {
    cached.promise = null;
    console.error("Database connection error:", e);
    throw e;
  }

  return cached.conn;
}

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "✅ API is working!",
    timestamp: new Date(),
  });
});

app.get("/api/test", (req, res) => {
  res.status(200).json({
    success: true,
    message: "✅ API is working!",
    timestamp: new Date(),
  });
});

// ===================================================
// Optional cron health stub (legacy path kept)
// ===================================================
app.get("/api/cron/reset-call-status-weekly", (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      payload: {
        ran: false,
        reason: "Customer model not enabled in this environment.",
      },
      msg: "Cron endpoint reachable (no-op).",
    },
    meta: null,
    errors: null,
  });
});

// ===================================================
// Store Routes
// ===================================================
const StoreRoutes = require("../routes/store.routes");
app.use("/api/store", StoreRoutes);
// ===================================================
// Product Store Receipt Routes (production area → main store)
// ===================================================
const ProductStoreReceiptRoutes = require("../routes/product-store-receipt.routes");
app.use("/api/product-store-receipt", ProductStoreReceiptRoutes);
// ===================================================
// Product Transfer Routes (main store → shop)
// ===================================================
const ProductTransferRoutes = require("../routes/product-transfer.routes");
app.use("/api/product-transfer", ProductTransferRoutes);
// ===================================================
// Inventory Report Routes
// ===================================================
const InventoryReportRoutes = require("../routes/inventory-report.routes");
app.use("/api/inventory-reports", InventoryReportRoutes);
// ===================================================
// App Version (Electron update check — public)
// ===================================================
const AppVersionRoutes = require("../routes/app-version.routes");
app.use("/api/app-version", AppVersionRoutes);
// ===================================================
// Auth Routes
// ===================================================
const AuthRoutes = require("../routes/auth.routes");
app.use("/api/auth", AuthRoutes);
// ===================================================
// Supplier Routes
// ===================================================
const SupplierRoutes = require("../routes/supplier.routes");
app.use("/api/supplier", SupplierRoutes);
// // ===================================================
// // Users Routes
// // ===================================================
// const UsersRoutes = require("../routes/users.routes");
// app.use("/api/users", UsersRoutes);
// ===================================================
// Raw Material Routes
// ===================================================
const RawMaterialRoutes = require("../routes/raw-material.routes");
app.use("/api/raw-material", RawMaterialRoutes);
// ===================================================
// Raw Material Stock Routes
// ===================================================
const RawMaterialStockRoutes = require("../routes/raw-material-stock.routes");
app.use("/api/raw-material-stock", RawMaterialStockRoutes);
// ===================================================
// Category Routes
// ===================================================
const CategoryRoutes = require("../routes/category.routes");
app.use("/api/category", CategoryRoutes);
// ===================================================
// Payment Method Routes (supplier ledger payment dropdown)
// ===================================================
const PaymentMethodRoutes = require("../routes/payment-method.routes");
app.use("/api/payment-method", PaymentMethodRoutes);
// ===================================================
// Counter Routes
// ===================================================
const CounterRoutes = require("../routes/counter.routes");
app.use("/api/counter", CounterRoutes);
// ===================================================
// Shop Routes (outlet login + POS)
// ===================================================
const ShopRoutes = require("../routes/shop.routes");
app.use("/api/shop", ShopRoutes);
// ===================================================
// Cake Design Routes
// ===================================================
const CakeDesignRoutes = require("../routes/cake-design.routes");
app.use("/api/cake-design", CakeDesignRoutes);
// ===================================================
// Cake Order Routes
// ===================================================
const CakeOrderRoutes = require("../routes/cake-order.routes");
app.use("/api/cake-order", CakeOrderRoutes);
// ===================================================
// Cake staff (mobile app users: order manager + designer)
// ===================================================
const CakeStaffRoutes = require("../routes/cake-staff.routes");
app.use("/api/cake-staff", CakeStaffRoutes);
// ===================================================
// RM Manager staff (web portal users scoped to a store)
// ===================================================
const RmStaffRoutes = require("../routes/rm-staff.routes");
app.use("/api/rm-staff", RmStaffRoutes);
// ===================================================
// Product Routes
// ===================================================
const ProductRoutes = require("../routes/product.routes");
app.use("/api/product", ProductRoutes);
// ===================================================
// Product Stock Routes
// ===================================================
const ProductStockRoutes = require("../routes/product-stock.routes");
app.use("/api/product-stock", ProductStockRoutes);
// ===================================================
// Cake Production Routes
// ===================================================
const CakeProductionRoutes = require("../routes/cake-production.routes");
app.use("/api/cake-production", CakeProductionRoutes);
// ===================================================
// Raw Material Dispatch Routes
// ===================================================
const RawMaterialDispatchRoutes = require("../routes/raw-material-dispatch.routes");
app.use("/api/raw-material-dispatch", RawMaterialDispatchRoutes);
// ===================================================
// Ustad Job (RM issue → FG return tracking)
// ===================================================
const UstadJobRoutes = require("../routes/ustad-job.routes");
app.use("/api/ustad-job", UstadJobRoutes);
// ===================================================
// Ustad master (registered karegar)
// ===================================================
const UstadRoutes = require("../routes/ustad.routes");
app.use("/api/ustad", UstadRoutes);
// ===================================================
// Dispatch Location Routes
// ===================================================
const DispatchLocationRoutes = require("../routes/dispatch-location.routes");
app.use("/api/dispatch-location", DispatchLocationRoutes);
// ===================================================
// Production Dashboard Routes
// ===================================================
const ProductionDashboardRoutes = require("../routes/production-dashboard.routes");
app.use("/api/production-dashboard", ProductionDashboardRoutes);
// ===================================================
// Owner Dashboard Routes
// ===================================================
const DashboardRoutes = require("../routes/dashboard.routes");
app.use("/api/dashboard", DashboardRoutes);
// ===================================================
// Order Routes
// ===================================================
const OrderRoutes = require("../routes/order.routes");
app.use("/api/order", OrderRoutes);
// ===================================================
// Sale Invoice Routes
// ===================================================
const SaleInvoiceRoutes = require("../routes/sale-invoice.routes");
app.use("/api/sale-invoice", SaleInvoiceRoutes);
//==============================================
// Reports
//==============================================
// const ReportRoutes = require("../routes/report.routes");
// app.use("/api/daily-report", ReportRoutes);
// Routes
// app.use("/api/auth", AuthRoutes);

// Remove the previous catch-all CORS and custom error CORS middlewares
// They are no longer needed since headers are handled above

// Fallback error handler — maps common library errors to consistent codes
// while preserving the legacy `{ success, error: { status, msg } }` shape
// expected by the frontend axios layer. Field-level details (when available)
// are surfaced under `errors`.
app.use((err, req, res, next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.message || "Internal Server Error";
  let errors = null;

  // Joi validation errors (when validate() is bypassed and Joi is invoked manually)
  if (err.isJoi || err.name === "ValidationError" && Array.isArray(err.details)) {
    status = 422;
    message = "Validation failed";
    errors = err.details.map((d) => ({
      field: Array.isArray(d.path) ? d.path.join(".") : String(d.path || ""),
      message: d.message,
    }));
  }
  // Mongoose validation errors
  else if (err.name === "ValidationError" && err.errors) {
    status = 422;
    message = "Validation failed";
    errors = Object.keys(err.errors).map((field) => ({
      field,
      message: err.errors[field]?.message || "Invalid value",
    }));
  }
  // Mongoose cast errors (e.g. invalid ObjectId)
  else if (err.name === "CastError") {
    status = 400;
    message = `Invalid ${err.path || "value"}`;
  }
  // JWT auth errors
  else if (err.name === "JsonWebTokenError") {
    status = 401;
    message = "Invalid token.";
  } else if (err.name === "TokenExpiredError") {
    status = 401;
    message = "Token has expired. Please log in again.";
  }
  // Mongo duplicate key
  else if (err.code === 11000) {
    status = 409;
    const field = Object.keys(err.keyValue || {})[0];
    message = field
      ? `Duplicate value for "${field}".`
      : "Duplicate value.";
  }

  res.status(status).json({
    success: false,
    error: { status, msg: message },
    errors,
  });
});

// Start long-lived server (Hostinger / local). Skip only on Vercel serverless.
if (!process.env.VERCEL) {
  server.listen(port, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${port}`);
  });
}

module.exports = app;
