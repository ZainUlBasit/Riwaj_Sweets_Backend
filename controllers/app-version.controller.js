/**
 * GET /api/app-version
 * Public — Electron desktop app update check.
 * Returns flat JSON (not the usual success envelope) so the client can
 * read latestVersion / downloadUrl directly.
 */
const getAppVersion = async (req, res) => {
  try {
    const latestVersion = "1.0.8";
    const minimumVersion = "1.0.7";
    const forceUpdate = true;
    const downloadUrl = "";
    // Get the latest version from the database

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
