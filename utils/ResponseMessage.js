/**
 * Response envelope helpers.
 *
 * Two surfaces are exposed:
 *
 *  1. Legacy helpers (kept for back-compat, must not change shape):
 *       successMessage(res, payload, msg)
 *       createError(res, status, message)
 *
 *  2. Canonical helpers (additive, used by new code):
 *       sendOk(res, { data, meta, message, status })
 *       sendErr(res, { status, message, errors })
 *
 * Canonical success envelope:
 *   {
 *     success: true,
 *     data:    { payload, msg },   // back-compat fields
 *     meta:    { page, limit, total } | null,
 *     errors:  null,
 *   }
 *
 * Canonical error envelope:
 *   {
 *     success: false,
 *     error:   { status, msg },    // back-compat fields
 *     errors:  Array<{ field?: string, message: string }> | null,
 *   }
 */

const createError = (res, status, message) => {
  const safeStatus = Number.isInteger(status) ? status : 400;
  const err = new Error();
  err.status = safeStatus;
  err.msg = message;
  return res.status(safeStatus).json({
    success: false,
    error: err,
    errors: null,
  });
};

const successMessage = (res, payload, data_msg) => {
  return res.status(200).json({
    success: true,
    data: { payload, msg: data_msg },
    meta: null,
    errors: null,
  });
};

/**
 * Canonical success responder. Preserves the back-compat `data.payload` /
 * `data.msg` fields so existing consumers keep working.
 */
const sendOk = (res, { data = null, meta = null, message = null, status = 200 } = {}) => {
  return res.status(status).json({
    success: true,
    data: { payload: data, msg: message },
    meta: meta,
    errors: null,
  });
};

/**
 * Canonical error responder. Preserves the back-compat `error.status` /
 * `error.msg` fields so existing consumers keep working.
 *
 * `errors` is an optional array of field-level issues, e.g.
 *   [{ field: "name", message: "Name is required" }]
 */
const sendErr = (res, { status = 500, message = "Internal Server Error", errors = null } = {}) => {
  const safeStatus = Number.isInteger(status) ? status : 500;
  return res.status(safeStatus).json({
    success: false,
    error: { status: safeStatus, msg: message },
    errors: Array.isArray(errors) && errors.length > 0 ? errors : null,
  });
};

module.exports = { createError, successMessage, sendOk, sendErr };
