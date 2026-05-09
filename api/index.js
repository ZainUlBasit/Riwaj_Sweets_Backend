require("dotenv").config();
const express = require("express");
const port = process.env.PORT || 8000;
const app = express();
const http = require("http");
const server = http.createServer(app);
const mongoose = require("mongoose");
const path = require("path");
const cookieParser = require("cookie-parser");
const cors = require("cors");

global.rootDirectory = path.resolve(__dirname);

// CORS allowlist (env-driven, with sensible defaults for prod + local dev).
// Configure by setting CORS_ORIGINS to a comma-separated list, e.g.
//   CORS_ORIGINS="https://www.riwajsweets.com,https://staging.riwajsweets.com"
const DEFAULT_ALLOWED_ORIGINS = [
  "https://www.riwajsweets.com",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:5171",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://localhost:5176",
  "http://localhost:5179",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:5175",
  "http://127.0.0.1:5176",
  "http://127.0.0.1:5179",
];

const envOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowedOrigins = envOrigins.length > 0 ? envOrigins : DEFAULT_ALLOWED_ORIGINS;

const isLocalhostOrigin = (origin) =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // In development, be more permissive for any localhost/127.0.0.1 origin
    if (process.env.NODE_ENV !== "production" && isLocalhostOrigin(origin)) {
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

  if (!cached.promise) {
    const opts = {
      bufferCommands: false,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      family: 4,
      maxIdleTimeMS: 30000,
    };

    cached.promise = mongoose
      .connect(process.env.mongooseUrl, opts)
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
// Vercel Cron stub
// ===================================================
// `vercel.json` schedules this endpoint weekly. The original implementation
// in Services/cronJobs.js depends on a Customer model that does not exist
// in this repo — returning a documented no-op keeps the cron green and
// surfaces a clear status payload for monitoring.
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
// Counter Routes
// ===================================================
const CounterRoutes = require("../routes/counter.routes");
app.use("/api/counter", CounterRoutes);
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

// Start server
if (!process.env.VERCEL) {
  server.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
  });
}

module.exports = app;
