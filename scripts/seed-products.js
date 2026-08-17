/**
 * Seed default Riwaj Sweets product menu into MongoDB.
 *
 * Run with:
 *   node scripts/seed-products.js
 *
 * Requires `MONGOOSEURL` in the environment (same var the API uses).
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("../Models/Products");

async function main() {
  const uri = process.env.MONGOOSEURL;
  if (!uri) {
    console.error("ERROR: `MONGOOSEURL` env var is not set. Aborting seed.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const result = await Product.seedDefaults();
  console.log(
    `Seed complete: ${result.created} created, ${result.skipped} skipped, ${result.errors.length} error(s).`,
  );

  const stockResult = await Product.applyDummyStock();
  console.log(
    `Stock update: ${stockResult.updated} updated, ${stockResult.skipped} skipped.`,
  );

  if (result.errors.length > 0) {
    console.error("Errors:");
    for (const err of result.errors) {
      console.error(`  [${err.id}] ${err.name}: ${err.message}`);
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
