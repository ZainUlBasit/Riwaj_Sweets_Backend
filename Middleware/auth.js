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

/**
 * VerifyAdmin — gate that requires the authenticated user's role to be Admin (1).
 * Operator-precedence fix: previous expression `!req.user.role === 1` evaluated
 * as `(!req.user.role) === 1` (always falsy). Use a strict equality check.
 *
 * Roles enum (Users.role): 1: Admin, 2: Cashier, 3: Saleman, 4: Cake Designer,
 * 5: Cake Order Manager, 6: RM Manager.
 */
const VerifyAdmin = (req, res, next) => {
  if (!req.user || Number(req.user.role) !== 1) {
    return createError(res, 403, "Admin access required.");
  }
  next();
};

/**
 * requireRole(...allowedRoles) — generic role guard. Use after `verifyToken`.
 *
 *   router.delete("/:id", verifyToken, requireRole(1), controller.remove);
 *
 * Plumbed for future per-module phase. Not yet attached to any route.
 */
const requireRole = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    return createError(res, 401, "Authentication required.");
  }
  const role = Number(req.user.role);
  if (!allowedRoles.map(Number).includes(role)) {
    return createError(res, 403, "You don't have permission for this action.");
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
  requireRole,
};
