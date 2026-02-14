const { createError } = require("../utils/ResponseMessage");
const jwt = require("jsonwebtoken");
const privateKey = process.env.ACCESS_SECRET_KEY;

const verifyToken = (req, res, next) => {
  const token = req.headers["token"]; // Custom header

  if (!token) {
    return createError(res, 401, "Access denied. No token provided.");
  }

  try {
    const decoded = jwt.verify(token, privateKey);
    req.user = decoded;

    if (!decoded) {
      return createError(res, 403, "Invalid or expired token.");
    }
    next();
  } catch (err) {
    return createError(res, 403, "Invalid or expired token.");
  }
};

const verifyTokenBody = (req, res, next) => {
  const token = req.body.token; // Custom header

  if (!token) {
    return createError(res, 401, "Access denied. No token provided.");
  }

  try {
    const decoded = jwt.verify(token, privateKey);
    req.user = decoded;

    if (!decoded) {
      return createError(res, 403, "Invalid or expired token.");
    }
    next();
  } catch (err) {
    return createError(res, 403, "Invalid or expired token.");
  }
};

const VerifyUserCookie = (req, res, next) => {
  const token = req.headers["token"] || req.cookies.token;

  if (!token) {
    return createError(res, 401, "Access denied. No token provided.");
  }

  try {
    const decoded = jwt.verify(token, privateKey);
    req.user = decoded;

    if (!decoded) {
      return createError(res, 403, "Invalid or expired token.");
    }
    next();
  } catch (err) {
    return createError(res, 403, "Invalid or expired token.");
  }
};

const VerifyAdmin = (req, res, next) => {
  // Check if user has branch information
  if (!req.user || !req.user.role === 1) {
    return createError(res, 403, "Admin access required.");
  }
  next();
};

const VerifyBranch = (req, res, next) => {
  // Check if user has branch information
  if (!req.user || !req.user.branchId) {
    return createError(res, 403, "Branch access required.");
  }

  // If branchId is provided in params, verify it matches user's branch
  if (req.params.id && req.params.id !== req.user.branchId) {
    return createError(res, 403, "Access denied to this branch.");
  }

  next();
};

module.exports = {
  verifyToken,
  verifyTokenBody,
  VerifyUserCookie,
  VerifyBranch,
  VerifyAdmin,
};
