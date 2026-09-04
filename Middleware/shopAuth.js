const jwt = require("jsonwebtoken");
const Shop = require("../Models/Shop");
const DispatchLocation = require("../Models/DispatchLocation");
const { LOCATION_TYPE } = require("../Services/inventoryService");
const { createError } = require("../utils/ResponseMessage");

const SHOP_SECRET =
  process.env.SHOP_SECRET_KEY ||
  process.env.COUNTER_SECRET_KEY ||
  process.env.ACCESS_SECRET_KEY;

const escapeRegex = (s) =>
  String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * If shop.location_id points at a deleted/missing location, retarget to the
 * active Shop location with the same name (fixes stale Riwaj 1 links).
 */
async function ensureShopLocationHealthy(shop) {
  if (!shop) return shop;
  const linkedId = shop.location_id?._id || shop.location_id;
  if (linkedId) {
    const linked = await DispatchLocation.findById(linkedId).lean();
    if (
      linked &&
      !linked.isDeleted &&
      Number(linked.location_type) === LOCATION_TYPE.SHOP
    ) {
      return shop;
    }
  }

  const name = String(shop.name || "").trim();
  if (!name) return shop;

  const active = await DispatchLocation.findOne({
    isDeleted: false,
    location_type: LOCATION_TYPE.SHOP,
    name: new RegExp(`^${escapeRegex(name)}$`, "i"),
  });
  if (!active) return shop;

  await Shop.updateOne({ _id: shop._id }, { location_id: active._id });
  shop.location_id = active._id;
  return shop;
}

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
    let shop = await Shop.findById(decoded.shop_id).where({
      isDeleted: false,
    });
    if (!shop) return createError(res, 404, "Shop not found.");
    if (!shop.isActive) {
      return createError(res, 403, "Shop account is deactivated.");
    }
    shop = await ensureShopLocationHealthy(shop);
    req.shop = shop;
    next();
  } catch (err) {
    return createError(res, 500, err.message || "Shop auth failed.");
  }
};

module.exports = {
  verifyShopToken,
  SHOP_SECRET,
  ensureShopLocationHealthy,
};
