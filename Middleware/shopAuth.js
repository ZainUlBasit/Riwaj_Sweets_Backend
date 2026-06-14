const jwt = require("jsonwebtoken");
const Shop = require("../Models/Shop");
const { createError } = require("../utils/ResponseMessage");

const SHOP_SECRET =
  process.env.SHOP_SECRET_KEY ||
  process.env.COUNTER_SECRET_KEY ||
  process.env.ACCESS_SECRET_KEY;

/**
 * Reads shop token from `shop-token` header and loads req.shop.
 */
const verifyShopToken = async (req, res, next) => {
  const token =
    req.headers["shop-token"] ||
    req.headers["shoptoken"] ||
    req.query?.shop_token;

  if (!token) {
    return createError(res, 401, "Shop token required.");
  }

  let decoded;
  try {
    decoded = jwt.verify(token, SHOP_SECRET);
  } catch (_err) {
    return createError(res, 401, "Invalid or expired shop token.");
  }

  if (decoded?.kind !== "shop" || !decoded?.shop_id) {
    return createError(res, 403, "Token is not a shop token.");
  }

  try {
    const shop = await Shop.findById(decoded.shop_id).where({
      isDeleted: false,
    });
    if (!shop) return createError(res, 404, "Shop not found.");
    if (!shop.isActive) {
      return createError(res, 403, "Shop account is deactivated.");
    }
    req.shop = shop;
    next();
  } catch (err) {
    return createError(res, 500, err.message || "Shop auth failed.");
  }
};

module.exports = { verifyShopToken, SHOP_SECRET };
