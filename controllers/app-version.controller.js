/**
 * GET /api/app-version
 * Public — Electron desktop app update check.
 * Returns flat JSON (not the usual success envelope) so the client can
 * read latestVersion / downloadUrl directly.
 */
const getAppVersion = async (req, res) => {
  try {
    const latestVersion =
      process.env.APP_LATEST_VERSION || "1.0.6";
    const minimumVersion =
      process.env.APP_MINIMUM_VERSION || "1.0.5";
    const forceUpdate =
      String(process.env.APP_FORCE_UPDATE || "true").toLowerCase() ===
      "true";
    const downloadUrl = process.env.APP_DOWNLOAD_URL || "";

    return res.status(200).json({
      latestVersion,
      minimumVersion,
      forceUpdate,
      downloadUrl,
    });
  } catch (err) {
    console.error("app-version error:", err);
    return res.status(500).json({
      latestVersion: null,
      minimumVersion: null,
      forceUpdate: false,
      downloadUrl: null,
      error: err.message || "Failed to fetch app version.",
    });
  }
};

module.exports = { getAppVersion };
