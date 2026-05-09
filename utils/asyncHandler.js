/**
 * asyncHandler — opt-in wrapper for async Express handlers.
 *
 * Removes try/catch boilerplate while keeping the existing top-level error
 * handler in `api/index.js` as the single source of error shaping. Existing
 * controllers are untouched; new code can opt in incrementally:
 *
 *   const asyncHandler = require("../utils/asyncHandler");
 *   router.get("/", asyncHandler(async (req, res) => { ... }));
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
