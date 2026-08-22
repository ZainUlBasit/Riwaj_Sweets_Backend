/**
 * Zero ALL inventory quantities + supplier balances (masters stay intact).
 *
 * Resets to 0:
 *   - Product: in_quantity, out_quantity, available_quantity
 *   - LocationInventory.quantity (Product Store 1/2, Shop 1/2, etc.)
 *   - ProductStock.quantity, total_price
 *   - RawMaterial: opening_quantity, in_quantity, out_quantity, available_quantity
 *   - RawMaterialStock: quantity, out_quantity, remaining_quantity, total_price
 *   - LocationRawMaterialInventory.quantity
 *   - Supplier: total_amount, paid, payable
 *   - SupplierPayment: soft-deleted (so payable stays 0 on Laravel too)
 *
 * Does NOT delete Product, RawMaterial, Supplier, Shop, Store, or location masters.
 *
 * Usage:
 *   node scripts/clear-all-inventory-qty.js --dry-run
 *   node scripts/clear-all-inventory-qty.js --confirm
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Product = require("../Models/Products");
const ProductStock = require("../Models/ProductStock");
const LocationInventory = require("../Models/LocationInventory");
const RawMaterial = require("../Models/RawMaterial");
const RawMaterialStock = require("../Models/RawMaterialStock");
const LocationRawMaterialInventory = require("../Models/LocationRawMaterialInventory");
const Supplier = require("../Models/Supplier");
const SupplierPayment = require("../Models/SupplierPayment");

async function countNonZero(model, filter = {}) {
  return model.countDocuments(filter);
}

async function printCounts(label) {
  const [
    productsWithQty,
    locationWithQty,
    stockWithQty,
    rmWithQty,
    rmStockWithQty,
    rmLocWithQty,
    suppliersWithBal,
    activePayments,
  ] = await Promise.all([
    Product.countDocuments({
      $or: [
        { in_quantity: { $gt: 0 } },
        { out_quantity: { $gt: 0 } },
        { available_quantity: { $gt: 0 } },
      ],
    }),
    LocationInventory.countDocuments({ quantity: { $gt: 0 } }),
    ProductStock.countDocuments({
      $or: [{ quantity: { $gt: 0 } }, { total_price: { $gt: 0 } }],
    }),
    RawMaterial.countDocuments({
      $or: [
        { opening_quantity: { $gt: 0 } },
        { in_quantity: { $gt: 0 } },
        { out_quantity: { $gt: 0 } },
        { available_quantity: { $gt: 0 } },
      ],
    }),
    RawMaterialStock.countDocuments({
      $or: [
        { quantity: { $gt: 0 } },
        { out_quantity: { $gt: 0 } },
        { remaining_quantity: { $gt: 0 } },
        { total_price: { $gt: 0 } },
      ],
    }),
    LocationRawMaterialInventory.countDocuments({ quantity: { $gt: 0 } }),
    Supplier.countDocuments({
      $or: [
        { total_amount: { $gt: 0 } },
        { paid: { $gt: 0 } },
        { payable: { $gt: 0 } },
      ],
    }),
    SupplierPayment.countDocuments({ isDeleted: false }),
  ]);

  console.log(`\n${label}`);
  console.log("  Product with qty > 0:              ", productsWithQty);
  console.log("  LocationInventory with qty > 0:  ", locationWithQty);
  console.log("  ProductStock with qty/price > 0:   ", stockWithQty);
  console.log("  RawMaterial with qty > 0:          ", rmWithQty);
  console.log("  RawMaterialStock with qty > 0:     ", rmStockWithQty);
  console.log("  LocationRawMaterialInventory > 0:  ", rmLocWithQty);
  console.log("  Supplier with balance > 0:         ", suppliersWithBal);
  console.log("  Active SupplierPayment rows:       ", activePayments);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const confirmed = args.includes("--confirm");

  if (!dryRun && !confirmed) {
    console.error(
      "\nRefusing to run. Pass --dry-run (preview) ya --confirm (actually clear).\n" +
        "  node scripts/clear-all-inventory-qty.js --dry-run\n" +
        "  node scripts/clear-all-inventory-qty.js --confirm\n",
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

  const [
    productResult,
    locationResult,
    stockResult,
    rmResult,
    rmStockResult,
    rmLocResult,
    supplierResult,
    paymentResult,
  ] = await Promise.all([
    Product.updateMany(
      {},
      {
        $set: {
          in_quantity: 0,
          out_quantity: 0,
          available_quantity: 0,
        },
      },
    ),
    LocationInventory.updateMany({}, { $set: { quantity: 0 } }),
    ProductStock.updateMany({}, { $set: { quantity: 0, total_price: 0 } }),
    RawMaterial.updateMany(
      {},
      {
        $set: {
          opening_quantity: 0,
          in_quantity: 0,
          out_quantity: 0,
          available_quantity: 0,
        },
      },
    ),
    RawMaterialStock.updateMany(
      {},
      {
        $set: {
          quantity: 0,
          out_quantity: 0,
          remaining_quantity: 0,
          total_price: 0,
        },
      },
    ),
    LocationRawMaterialInventory.updateMany({}, { $set: { quantity: 0 } }),
    Supplier.updateMany(
      {},
      { $set: { total_amount: 0, paid: 0, payable: 0 } },
    ),
    SupplierPayment.updateMany(
      { isDeleted: false },
      { $set: { isDeleted: true } },
    ),
  ]);

  console.log("\nWRITES");
  console.log("  Product zeroed (modified):         ", productResult.modifiedCount);
  console.log("  LocationInventory zeroed:          ", locationResult.modifiedCount);
  console.log("  ProductStock zeroed:               ", stockResult.modifiedCount);
  console.log("  RawMaterial zeroed:                ", rmResult.modifiedCount);
  console.log("  RawMaterialStock zeroed:           ", rmStockResult.modifiedCount);
  console.log("  LocationRawMaterialInventory:      ", rmLocResult.modifiedCount);
  console.log("  Supplier balances zeroed:        ", supplierResult.modifiedCount);
  console.log("  SupplierPayment soft-deleted:      ", paymentResult.modifiedCount);

  await printCounts("AFTER");
  console.log(
    "\nDone. Masters kept — Product, RawMaterial, Supplier, Stores, Shops.",
  );
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
