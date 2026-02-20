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

// CORS configuration (explicitly add allowed origin for Vercel frontend)
const allowedOrigins = [
  "https://www.riwajsweets.com",
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
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // In development, be more permissive
    if (
      process.env.NODE_ENV !== "production" &&
      origin.match(/^https?:\/\/localhost(:\d+)?$/)
    ) {
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
// Product Routes
// ===================================================
const ProductRoutes = require("../routes/product.routes");
app.use("/api/product", ProductRoutes);
// ===================================================
// Product Stock Routes
// ===================================================
const ProductStockRoutes = require("../routes/product-stock.routes");
app.use("/api/product-stock", ProductStockRoutes);
//==============================================
// Reports
//==============================================
// const ReportRoutes = require("../routes/report.routes");
// app.use("/api/daily-report", ReportRoutes);
// Routes
// app.use("/api/auth", AuthRoutes);

// Remove the previous catch-all CORS and custom error CORS middlewares
// They are no longer needed since headers are handled above

// Fallback error handler (does not interfere with CORS)
app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    error: { status, msg: err.message || "Internal Server Error" },
  });
});

// Start server
if (!process.env.VERCEL) {
  server.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
  });
}

module.exports = app;
