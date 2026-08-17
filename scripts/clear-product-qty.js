/**
 * Clear product quantities only (masters stay intact).
 *
 * Does NOT delete:
 *   - Product, RawMaterial, Supplier, Shop, Store
 *   - ProductStock / LocationInventory documents (qty zeroed, rows kept)
 *
 * Clears / resets:
 *   - Product.in_quantity / out_quantity / available_quantity → 0
 *   - LocationInventory.quantity → 0
 *   - ProductStock.quantity / total_price → 0
 *
 * Requires `MONGOOSEURL` env var.
 *
 * Usage:
 *   node scripts/clear-product-qty.js --dry-run
 *   node scripts/clear-product-qty.js --confirm
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Product = require("../Models/Products");
const ProductStock = require("../Models/ProductStock");
const LocationInventory = require("../Models/LocationInventory");

async function printCounts(label) {
  const [
    products,
    productsWithQty,
    locationRows,
    locationWithQty,
    stockRows,
    stockWithQty,
  ] = await Promise.all([
    Product.countDocuments({}),
    Product.countDocuments({
      $or: [
        { in_quantity: { $gt: 0 } },
        { out_quantity: { $gt: 0 } },
        { available_quantity: { $gt: 0 } },
      ],
    }),
    LocationInventory.countDocuments({}),
    LocationInventory.countDocuments({ quantity: { $gt: 0 } }),
    ProductStock.countDocuments({}),
    ProductStock.countDocuments({ quantity: { $gt: 0 } }),
  ]);

  console.log(`\n${label}`);
  console.log("  Product (master docs):              ", products);
  console.log("  Product with qty > 0:               ", productsWithQty);
  console.log("  LocationInventory rows:             ", locationRows);
  console.log("  LocationInventory with qty > 0:     ", locationWithQty);
  console.log("  ProductStock rows:                  ", stockRows);
  console.log("  ProductStock with qty > 0:          ", stockWithQty);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const confirmed = args.includes("--confirm");

  if (!dryRun && !confirmed) {
    console.error(
      "\nRefusing to run. Pass --dry-run (safe preview) ya --confirm (actually clear).\n" +
        "  node scripts/clear-product-qty.js --dry-run\n" +
        "  node scripts/clear-product-qty.js --confirm\n",
    );
    process.exit(1);
  }

  if (!process.env.MONGOOSEURL) {
    console.error("MONGOOSEURL env var missing.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGOOSEURL);
  console.log("Connected.");

  await printCounts("BEFORE");

  if (dryRun) {
    console.log("\nDry-run only — no writes.");
    await mongoose.disconnect();
    return;
  }

  const productResult = await Product.updateMany(
    {},
    {
      $set: {
        in_quantity: 0,
        out_quantity: 0,
        available_quantity: 0,
      },
    },
  );

  const locationResult = await LocationInventory.updateMany(
    {},
    { $set: { quantity: 0 } },
  );

  const stockResult = await ProductStock.updateMany(
    {},
    { $set: { quantity: 0, total_price: 0 } },
  );

  console.log("\nWRITES");
  console.log("  Product qty zeroed (matched):       ", productResult.matchedCount);
  console.log("  Product qty zeroed (modified):      ", productResult.modifiedCount);
  console.log("  LocationInventory zeroed (matched): ", locationResult.matchedCount);
  console.log("  LocationInventory zeroed (modified):", locationResult.modifiedCount);
  console.log("  ProductStock zeroed (matched):      ", stockResult.matchedCount);
  console.log("  ProductStock zeroed (modified):     ", stockResult.modifiedCount);

  await printCounts("AFTER");
  console.log("\nDone. Shops / Stores / Suppliers / RawMaterials / Products kept.");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
