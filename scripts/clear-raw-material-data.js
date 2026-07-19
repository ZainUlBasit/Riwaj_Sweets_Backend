/**
 * Clear ALL Raw Material data for a fresh start.
 *
 * Ye script raw material se juri saari inventory clear karti hai taake aap
 * actual data zero se enter kar sako. Suppliers, shops, locations, orders aur
 * finished products SAFE rehte hain.
 *
 * Kya clear hota hai:
 *   - RawMaterial               (master list)
 *   - RawMaterialStock          (purchases / stock-in batches)
 *   - RawMaterialDispatch       (RM Store -> Production/Shop transfers)
 *   - LocationRawMaterialInventory  (per-location RM balances)
 *   - InventoryLedger           (sirf raw_material wali movement rows)
 *   - InventoryAuditLog         (RawMaterial / RawMaterialStock / RawMaterialDispatch)
 *   - Product.bom               (products ke andar RM links -> khaali)
 *   - CakeProduction.raw_materials_consumed  (-> khaali)
 *   - ProductStock.raw_materials_used        (-> khaali)
 *
 * Requires `mongooseUrl` env var (wahi jo API use karti hai).
 *
 * Usage:
 *   node scripts/clear-raw-material-data.js --dry-run   # sirf counts, kuch delete nahi
 *   node scripts/clear-raw-material-data.js --confirm   # actually clear kare
 */
require("dotenv").config();
const mongoose = require("mongoose");

const RawMaterial = require("../Models/RawMaterial");
const RawMaterialStock = require("../Models/RawMaterialStock");
const RawMaterialDispatch = require("../Models/RawMaterialDispatch");
const LocationRawMaterialInventory = require("../Models/LocationRawMaterialInventory");
const InventoryLedger = require("../Models/InventoryLedger");
const InventoryAuditLog = require("../Models/InventoryAuditLog");
const Product = require("../Models/Products");
const CakeProduction = require("../Models/CakeProduction");
const ProductStock = require("../Models/ProductStock");

const RM_AUDIT_ENTITY_TYPES = [
  "RawMaterial",
  "RawMaterialStock",
  "RawMaterialDispatch",
];

const LEDGER_FILTER = { raw_material_id: { $ne: null } };
const AUDIT_FILTER = { entity_type: { $in: RM_AUDIT_ENTITY_TYPES } };
const BOM_FILTER = { bom: { $exists: true, $ne: [] } };
const CAKE_FILTER = { raw_materials_consumed: { $exists: true, $ne: [] } };
const PRODUCT_STOCK_FILTER = {
  raw_materials_used: { $exists: true, $ne: [] },
};

async function printCounts(label) {
  const [
    materials,
    stock,
    dispatch,
    locBalances,
    ledger,
    audit,
    bomProducts,
    cakeRuns,
    stockRuns,
  ] = await Promise.all([
    RawMaterial.countDocuments({}),
    RawMaterialStock.countDocuments({}),
    RawMaterialDispatch.countDocuments({}),
    LocationRawMaterialInventory.countDocuments({}),
    InventoryLedger.countDocuments(LEDGER_FILTER),
    InventoryAuditLog.countDocuments(AUDIT_FILTER),
    Product.countDocuments(BOM_FILTER),
    CakeProduction.countDocuments(CAKE_FILTER),
    ProductStock.countDocuments(PRODUCT_STOCK_FILTER),
  ]);

  console.log(`\n${label}`);
  console.log("  RawMaterial (master):            ", materials);
  console.log("  RawMaterialStock (purchases):    ", stock);
  console.log("  RawMaterialDispatch:             ", dispatch);
  console.log("  LocationRawMaterialInventory:    ", locBalances);
  console.log("  InventoryLedger (RM rows):       ", ledger);
  console.log("  InventoryAuditLog (RM entities): ", audit);
  console.log("  Products with BOM:               ", bomProducts);
  console.log("  CakeProduction w/ consumption:   ", cakeRuns);
  console.log("  ProductStock w/ RM usage:        ", stockRuns);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const confirmed = args.includes("--confirm");

  if (!dryRun && !confirmed) {
    console.error(
      "\nRefusing to run. Pass --dry-run (safe preview) ya --confirm (actually clear).\n" +
        "  node scripts/clear-raw-material-data.js --dry-run\n" +
        "  node scripts/clear-raw-material-data.js --confirm\n",
    );
    process.exit(1);
  }

  const uri = process.env.mongooseUrl;
  if (!uri) {
    console.error("ERROR: `mongooseUrl` env var set nahi hai. Aborting.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  await printCounts("BEFORE (current data):");

  if (dryRun) {
    console.log("\n[dry-run] Kuch delete nahi kiya gaya. --confirm se chalao.");
    await mongoose.disconnect();
    return;
  }

  console.log("\nClearing raw material data...");

  const results = {};
  results.dispatch = (await RawMaterialDispatch.deleteMany({})).deletedCount;
  results.locBalances = (
    await LocationRawMaterialInventory.deleteMany({})
  ).deletedCount;
  results.stock = (await RawMaterialStock.deleteMany({})).deletedCount;
  results.ledger = (await InventoryLedger.deleteMany(LEDGER_FILTER)).deletedCount;
  results.audit = (await InventoryAuditLog.deleteMany(AUDIT_FILTER)).deletedCount;
  results.materials = (await RawMaterial.deleteMany({})).deletedCount;

  results.bom = (
    await Product.updateMany(BOM_FILTER, { $set: { bom: [] } })
  ).modifiedCount;
  results.cake = (
    await CakeProduction.updateMany(CAKE_FILTER, {
      $set: { raw_materials_consumed: [] },
    })
  ).modifiedCount;
  results.productStock = (
    await ProductStock.updateMany(PRODUCT_STOCK_FILTER, {
      $set: { raw_materials_used: [] },
    })
  ).modifiedCount;

  // Reset the RawMaterial auto-increment counter (agar mongoose-sequence use hua ho).
  try {
    const counters = mongoose.connection.collection("counters");
    await counters.deleteMany({ id: /raw.?material/i });
  } catch (err) {
    console.warn("Counter reset skipped:", err.message);
  }

  console.log("\nDeleted / updated:");
  console.log("  RawMaterialDispatch deleted:        ", results.dispatch);
  console.log("  LocationRawMaterialInventory deleted:", results.locBalances);
  console.log("  RawMaterialStock deleted:           ", results.stock);
  console.log("  InventoryLedger (RM) deleted:       ", results.ledger);
  console.log("  InventoryAuditLog (RM) deleted:     ", results.audit);
  console.log("  RawMaterial deleted:                ", results.materials);
  console.log("  Products BOM cleared:               ", results.bom);
  console.log("  CakeProduction consumption cleared: ", results.cake);
  console.log("  ProductStock RM usage cleared:      ", results.productStock);

  await printCounts("AFTER (should be all zero):");

  console.log("\nDone. Ab aap actual raw material fresh add kar sakte ho.");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Clear failed:", err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
