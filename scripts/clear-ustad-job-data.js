/**
 * Empty all Ustad Job data (masters — Ustad, Product, RM — stay intact).
 *
 * Soft-deletes:
 *   - UstadJob (+ embedded lines in Mongo)
 *   - RawMaterialDispatch linked via ustad_job_id or job line dispatch_id
 *   - CakeProduction linked via ustad_job_id
 *
 * Inventory is NOT reversed (run after clear-all-inventory-qty if starting fresh).
 *
 * Usage:
 *   node scripts/clear-ustad-job-data.js --dry-run
 *   node scripts/clear-ustad-job-data.js --confirm
 */
require("dotenv").config();
const mongoose = require("mongoose");

const UstadJob = require("../Models/UstadJob");
const RawMaterialDispatch = require("../Models/RawMaterialDispatch");
const CakeProduction = require("../Models/CakeProduction");

async function printCounts(label) {
  const [jobs, dispatches, productions] = await Promise.all([
    UstadJob.countDocuments({ isDeleted: false }),
    RawMaterialDispatch.countDocuments({
      isDeleted: false,
      ustad_job_id: { $ne: null },
    }),
    CakeProduction.countDocuments({
      isDeleted: false,
      ustad_job_id: { $ne: null },
    }),
  ]);

  console.log(`\n${label}`);
  console.log("  Active UstadJob:                    ", jobs);
  console.log("  Active RM dispatch (ustad job):     ", dispatches);
  console.log("  Active CakeProduction (ustad job):  ", productions);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const confirmed = args.includes("--confirm");

  if (!dryRun && !confirmed) {
    console.error(
      "\nRefusing to run. Pass --dry-run (preview) ya --confirm (actually clear).\n" +
        "  node scripts/clear-ustad-job-data.js --dry-run\n" +
        "  node scripts/clear-ustad-job-data.js --confirm\n",
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

  const activeJobs = await UstadJob.find({ isDeleted: false }).select("_id lines");
  const jobIds = activeJobs.map((j) => j._id);
  const dispatchIds = activeJobs
    .flatMap((j) => (j.lines || []).map((l) => l.dispatch_id))
    .filter(Boolean);

  const [prodResult, dispatchByJob, dispatchByLine, jobResult] =
    await Promise.all([
      CakeProduction.updateMany(
        { isDeleted: false, ustad_job_id: { $in: jobIds } },
        {
          $set: {
            isDeleted: true,
            ustad_job_id: null,
            product_stock_id: null,
            store_receipt_id: null,
            raw_materials_consumed: [],
          },
        },
      ),
      RawMaterialDispatch.updateMany(
        { isDeleted: false, ustad_job_id: { $in: jobIds } },
        { $set: { isDeleted: true, ustad_job_id: null, generated_stock_id: null } },
      ),
      dispatchIds.length
        ? RawMaterialDispatch.updateMany(
            { isDeleted: false, _id: { $in: dispatchIds } },
            { $set: { isDeleted: true, ustad_job_id: null, generated_stock_id: null } },
          )
        : Promise.resolve({ modifiedCount: 0 }),
      UstadJob.updateMany({ isDeleted: false }, { $set: { isDeleted: true } }),
    ]);

  console.log("\nWRITES");
  console.log("  UstadJob soft-deleted:              ", jobResult.modifiedCount);
  console.log("  RM dispatch by ustad_job_id:      ", dispatchByJob.modifiedCount);
  console.log("  RM dispatch by line dispatch_id:  ", dispatchByLine.modifiedCount);
  console.log("  CakeProduction soft-deleted:      ", prodResult.modifiedCount);

  await printCounts("AFTER");
  console.log("\nDone. Ustad master list unchanged.");
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
