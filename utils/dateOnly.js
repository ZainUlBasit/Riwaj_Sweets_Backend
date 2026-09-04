/**
 * Calendar-date helpers (YYYY-MM-DD). Avoids Date timezone shift on comparisons.
 */

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const parseDateOnly = (value) => {
  if (value == null || value === "") return null;
  const s = String(value).trim().slice(0, 10);
  return DATE_ONLY_RE.test(s) ? s : null;
};

/** Local server calendar today as YYYY-MM-DD. */
const todayDateOnly = () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

/**
 * Resolve list/report query to a single calendar day (or legacy range).
 * Prefers `date`. Falls back to start_date / end_date (same-day when one missing).
 */
const resolveQueryDateRange = (query = {}) => {
  const single = parseDateOnly(query.date);
  if (single) {
    return { start_date: single, end_date: single, error: null };
  }

  const start = parseDateOnly(query.start_date);
  const end = parseDateOnly(query.end_date);

  if (!start && !end) {
    return { start_date: null, end_date: null, error: null };
  }

  const start_date = start || end;
  const end_date = end || start;
  if (!start_date || !end_date) {
    return { start_date: null, end_date: null, error: "Invalid date." };
  }
  if (start_date > end_date) {
    return {
      start_date: null,
      end_date: null,
      error: "Invalid date range.",
    };
  }
  return { start_date, end_date, error: null };
};

/**
 * Reject past calendar dates for create/update entry fields.
 * Returns YYYY-MM-DD or throws { status, message }.
 */
const assertNotPastDate = (value, fieldLabel = "Date") => {
  const s = parseDateOnly(value);
  if (!s) {
    const err = new Error(`Invalid ${fieldLabel}.`);
    err.status = 400;
    throw err;
  }
  if (s < todayDateOnly()) {
    const err = new Error(
      `${fieldLabel} purani nahi ho sakti. Aaj ya future date select karein.`,
    );
    err.status = 400;
    throw err;
  }
  return s;
};

module.exports = {
  parseDateOnly,
  todayDateOnly,
  resolveQueryDateRange,
  assertNotPastDate,
};
