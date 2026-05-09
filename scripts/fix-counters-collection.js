/**
 * One-shot migration: fix the `counters` collection collision.
 *
 * Background:
 *   The `mongoose-sequence` plugin uses an internal collection called
 *   `counters` to track auto-increment sequences. It also creates a unique
 *   compound index on `{ id, reference_value }`. The application's domain
 *   `Counter` model was, by Mongoose's default pluralization, also stored
 *   in `counters`, so domain documents (which carry neither `id` nor
 *   `reference_value`) all collided as `{ id: null, reference_value: null }`
 *   and any second insert failed with E11000.
 *
 *   The model has now been pinned to a separate collection,
 *   `sale_counters`. This script moves any pre-existing domain docs out of
 *   `counters` into `sale_counters` (idempotent), so production data is
 *   preserved without restarting auto-increment sequences.
 *
 * Run with:
 *   node scripts/fix-counters-collection.js
 *
 * Requires `mongooseUrl` in the environment (same var the API uses).
 */
require("dotenv").config();
const mongoose = require("mongoose");

const SOURCE = "counters"; // legacy + mongoose-sequence shared collection
const TARGET = "sale_counters"; // new domain Counter collection

async function main() {
  const uri = process.env.mongooseUrl;
  if (!uri) {
    console.error(
      "ERROR: `mongooseUrl` env var is not set. Aborting migration.",
    );
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  const db = mongoose.connection.db;
  const source = db.collection(SOURCE);
  const target = db.collection(TARGET);

  // 1) Domain Counter documents have a `type` field (1=Cash, 2=Sale) and
  //    `counter_number`. Internal sequence documents have neither — they
  //    look like `{ id: "<seq_name>", reference_value: ?, seq: N }`.
  //    We use the presence of `type` as the discriminator.
  const domainQuery = { type: { $in: [1, 2] } };
  const domainDocs = await source.find(domainQuery).toArray();
  console.log(`Found ${domainDocs.length} domain Counter doc(s) in \`counters\`.`);

  if (domainDocs.length > 0) {
    // Use insertMany with `ordered: false` so duplicates (already migrated
    // on a previous run) are skipped without aborting the rest.
    try {
      await target.insertMany(domainDocs, { ordered: false });
      console.log(
        `Inserted ${domainDocs.length} doc(s) into \`${TARGET}\`.`,
      );
    } catch (err) {
      // E11000 here means the docs were already moved on a prior run.
      if (err && err.code === 11000) {
        console.log(
          "Some docs already exist in target (idempotent re-run). Continuing.",
        );
      } else {
        throw err;
      }
    }

    const ids = domainDocs.map((d) => d._id);
    const del = await source.deleteMany({ _id: { $in: ids } });
    console.log(`Removed ${del.deletedCount} domain doc(s) from \`${SOURCE}\`.`);
  }

  // 2) Drop the unique compound index `id_1_reference_value_1` if any
  //    domain documents had been inserted before the plugin's index was
  //    fully populated. This is harmless when the index is absent; it's
  //    also harmless to keep, but dropping prevents future surprises if
  //    the legacy `counters` collection is ever reused for anything else.
  try {
    await source.dropIndex("id_1_reference_value_1");
    console.log(
      "Dropped legacy unique index `id_1_reference_value_1` on `counters`.",
    );
  } catch (err) {
    if (err && (err.codeName === "IndexNotFound" || err.code === 27)) {
      console.log(
        "Legacy index `id_1_reference_value_1` not present — nothing to drop.",
      );
    } else {
      throw err;
    }
  }

  console.log("Migration complete.");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Migration failed:", err);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // best-effort
  }
  process.exit(1);
});
