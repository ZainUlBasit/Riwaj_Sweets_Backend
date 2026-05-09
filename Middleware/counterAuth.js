const jwt = require("jsonwebtoken");
const Counter = require("../Models/Counter");
const { createError } = require("../utils/ResponseMessage");

const COUNTER_SECRET =
  process.env.COUNTER_SECRET_KEY || process.env.ACCESS_SECRET_KEY;

/**
 * verifyCounterToken
 *
 * Reads the counter token from `counter-token` header (preferred), the
 * generic `token` header (fallback for shared clients), or `?counter_token`.
 * Confirms it was signed with `kind="counter"` and that the counter is
 * still active + not soft-deleted, then exposes the loaded Counter on
 * `req.counter`.
 */
const verifyCounterToken = async (req, res, next) => {
  const token =
    req.headers["counter-token"] ||
    req.headers["countertoken"] ||
    req.headers["token"] ||
    req.query?.counter_token;

  if (!token) {
    return createError(res, 401, "Counter token required.");
  }

  let decoded;
  try {
    decoded = jwt.verify(token, COUNTER_SECRET);
  } catch (err) {
    return createError(res, 401, "Invalid or expired counter token.");
  }

  if (decoded?.kind !== "counter" || !decoded?.counter_id) {
    return createError(res, 403, "Token is not a counter token.");
  }

  try {
    const counter = await Counter.findById(decoded.counter_id).where({
      isDeleted: false,
    });
    if (!counter) return createError(res, 404, "Counter not found.");
    if (!counter.isActive) {
      return createError(res, 403, "Counter is deactivated.");
    }
    req.counter = counter;
    next();
  } catch (err) {
    return createError(res, 500, err.message || "Counter auth failed.");
  }
};

/**
 * requireCounterType(...allowedTypes)
 *
 * Use after `verifyCounterToken`. Restricts a route to one or more counter
 * types (1: Cash, 2: Sale).
 */
const requireCounterType = (...allowedTypes) => (req, res, next) => {
  if (!req.counter) {
    return createError(res, 401, "Counter authentication required.");
  }
  if (!allowedTypes.map(Number).includes(Number(req.counter.type))) {
    return createError(
      res,
      403,
      "This counter is not allowed to perform this action.",
    );
  }
  next();
};

module.exports = { verifyCounterToken, requireCounterType };
