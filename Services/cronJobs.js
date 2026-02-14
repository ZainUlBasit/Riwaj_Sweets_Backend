require("dotenv").config();

const Customer = require("../Models/Customer");

// Vercel is serverless; in that environment you should NOT rely on node-cron timers.
const isVercel = Boolean(process.env.VERCEL);

/**
 * Job logic (idempotent):
 * Reset all customer call_status to false.
 */
async function runResetCallStatusWeekly() {
  const result = await Customer.updateMany(
    { isDeleted: false },
    { $set: { call_status: false } }
  );

  return {
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
  };
}

/**
 * Local (non-serverless) scheduler.
 * Cron expression: "0 0 * * 1" => every Monday at 00:00
 */
function scheduleResetCallStatusWeekly() {
  if (isVercel) {
    console.log(
      "ℹ️ Skipping node-cron schedule on Vercel (use Vercel Cron Jobs)."
    );
    return;
  }

  // Lazy import so the file can be used in serverless without relying on timers.
  const cron = require("node-cron");

  cron.schedule("0 0 * * 1", async () => {
    try {
      console.log("🔄 Starting weekly call_status reset...");
      const { modifiedCount } = await runResetCallStatusWeekly();
      console.log(
        `✅ Weekly call_status reset completed. Updated ${modifiedCount} customers.`
      );
    } catch (error) {
      console.error("❌ Error resetting call_status:", error.message);
    }
  });

  console.log(
    "📅 Cron job scheduled (local): Reset call_status every Monday at midnight"
  );
}

module.exports = {
  runResetCallStatusWeekly,
  scheduleResetCallStatusWeekly,
};
