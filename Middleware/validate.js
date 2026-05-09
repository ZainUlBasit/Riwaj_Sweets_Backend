const { sendErr } = require("../utils/ResponseMessage");

/**
 * validate(schema, source = "body") — generic Joi validator middleware.
 *
 * On failure responds with HTTP 422 and the canonical error envelope:
 *   {
 *     success: false,
 *     error:   { status: 422, msg: "Validation failed" },
 *     errors:  [{ field, message }, ...]
 *   }
 *
 * On success it replaces `req[source]` with the (coerced) validated value so
 * downstream controllers receive a clean payload. Unknown keys are stripped
 * by default to keep payloads predictable.
 *
 * Not yet attached to existing routes. Available for new/changed routes.
 *
 * Example:
 *   const Joi = require("joi");
 *   const validate = require("../Middleware/validate");
 *   const schema = Joi.object({ name: Joi.string().required() });
 *   router.post("/", validate(schema), controller.create);
 */
const validate = (schema, source = "body") => (req, res, next) => {
  if (!schema || typeof schema.validate !== "function") {
    return next(new Error("validate(schema): a Joi schema is required."));
  }

  const target = req[source];
  const { value, error } = schema.validate(target, {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });

  if (error) {
    const errors = (error.details || []).map((d) => ({
      field: Array.isArray(d.path) ? d.path.join(".") : String(d.path || ""),
      message: d.message,
    }));
    return sendErr(res, {
      status: 422,
      message: "Validation failed",
      errors,
    });
  }

  req[source] = value;
  next();
};

module.exports = validate;
