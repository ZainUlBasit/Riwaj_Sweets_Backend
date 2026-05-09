const RawMaterialDispatch = require("../Models/RawMaterialDispatch");
const RawMaterial = require("../Models/RawMaterial");
const RawMaterialStock = require("../Models/RawMaterialStock");
const DispatchLocation = require("../Models/DispatchLocation");
const {
  getOrCreateLocation,
} = require("./dispatch-location.controller");
const { createError, successMessage } = require("../utils/ResponseMessage");

const populateRefs = (q) =>
  q
    .populate("raw_material_id")
    .populate("raw_material_stock_id")
    .populate("location_id");

/**
 * GET /api/raw-material-dispatch
 *
 * Optional query params:
 *   start_date, end_date  — filter `dispatch_date` (inclusive)
 *   location/location_id  — exact location match
 *   raw_material_id       — only dispatches for a specific raw material
 *
 * Response payload uses canonical `items` / `deletedItems` keys.
 */
const list = async (req, res) => {
  try {
    const { start_date, end_date, location, location_id, raw_material_id } =
      req.query || {};

    const range = {};
    if (start_date) range.$gte = new Date(start_date);
    if (end_date) range.$lte = new Date(end_date);

    const baseFilter = {};
    if (Object.keys(range).length > 0) baseFilter.dispatch_date = range;
    if (location_id) {
      baseFilter.location_id = location_id;
    } else if (location) {
      const loc = await DispatchLocation.findOne({
        name: new RegExp(`^${escapeRegex(location)}$`, "i"),
        isDeleted: false,
      });
      if (loc) baseFilter.location_id = loc._id;
      else baseFilter.location = new RegExp(`^${escapeRegex(location)}$`, "i");
    }
    if (raw_material_id) baseFilter.raw_material_id = raw_material_id;

    const items = await populateRefs(
      RawMaterialDispatch.find({ ...baseFilter, isDeleted: false }).sort({
        dispatch_date: -1,
        createdAt: -1,
      }),
    );
    const deletedItems = await populateRefs(
      RawMaterialDispatch.find({ ...baseFilter, isDeleted: true }).sort({
        dispatch_date: -1,
        createdAt: -1,
      }),
    );

    return successMessage(
      res,
      { items, deletedItems },
      "Raw material dispatches fetched successfully.",
    );
  } catch (err) {
    console.error("RawMaterialDispatch list error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to fetch raw material dispatches.",
    );
  }
};

const getOne = async (req, res) => {
  try {
    const item = await populateRefs(
      RawMaterialDispatch.findById(req.params.id).where({ isDeleted: false }),
    );
    if (!item) return createError(res, 404, "Dispatch not found.");
    return successMessage(res, item, "Dispatch fetched successfully.");
  } catch (err) {
    console.error("RawMaterialDispatch getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch dispatch.");
  }
};

/**
 * POST /api/raw-material-dispatch
 *
 * Body: {
 *   location_id? / location, raw_material_id, quantity, dispatch_date,
 *   raw_material_stock_id?, notes?
 * }
 */
const create = async (req, res) => {
  try {
    const {
      location,
      location_id,
      raw_material_id,
      raw_material_stock_id,
      quantity,
      dispatch_date,
      notes,
    } = req.body || {};

    if (!location_id && (!location || !String(location).trim())) {
      return createError(res, 400, "location is required.");
    }
    if (!raw_material_id) {
      return createError(res, 400, "raw_material_id is required.");
    }
    if (!dispatch_date) {
      return createError(res, 400, "dispatch_date is required.");
    }
    const qty = Number(quantity ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) {
      return createError(res, 400, "quantity must be greater than 0.");
    }

    const rawMaterial = await RawMaterial.findById(raw_material_id).where({
      isDeleted: false,
    });
    if (!rawMaterial) {
      return createError(res, 404, "Raw material not found.");
    }

    if (raw_material_stock_id) {
      const stock = await RawMaterialStock.findById(raw_material_stock_id).where(
        { isDeleted: false },
      );
      if (!stock) {
        return createError(res, 404, "Raw material stock batch not found.");
      }
    }

    const dispatchLocation = location_id
      ? await DispatchLocation.findById(location_id).where({ isDeleted: false })
      : await getOrCreateLocation(location);
    if (!dispatchLocation) {
      return createError(res, 404, "Dispatch location not found.");
    }

    const item = await RawMaterialDispatch.create({
      location_id: dispatchLocation._id,
      location: dispatchLocation.name,
      raw_material_id,
      raw_material_stock_id: raw_material_stock_id || null,
      quantity: qty,
      dispatch_date: new Date(dispatch_date),
      notes: notes ?? "",
      isDeleted: false,
    });

    const populated = await populateRefs(
      RawMaterialDispatch.findById(item._id),
    );

    return successMessage(
      res,
      populated || item,
      "Dispatch created successfully.",
    );
  } catch (err) {
    console.error("RawMaterialDispatch create error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to create dispatch.",
    );
  }
};

const update = async (req, res) => {
  try {
    const {
      location,
      location_id,
      raw_material_id,
      raw_material_stock_id,
      quantity,
      dispatch_date,
      notes,
    } = req.body || {};

    const updatePayload = { isDeleted: false };
    if (location_id !== undefined || location !== undefined) {
      if (!location_id && !String(location ?? "").trim()) {
        return createError(res, 400, "location cannot be empty.");
      }
      const dispatchLocation = location_id
        ? await DispatchLocation.findById(location_id).where({
            isDeleted: false,
          })
        : await getOrCreateLocation(location);
      if (!dispatchLocation) {
        return createError(res, 404, "Dispatch location not found.");
      }
      updatePayload.location_id = dispatchLocation._id;
      updatePayload.location = dispatchLocation.name;
    }
    if (raw_material_id !== undefined) {
      const rm = await RawMaterial.findById(raw_material_id).where({
        isDeleted: false,
      });
      if (!rm) return createError(res, 404, "Raw material not found.");
      updatePayload.raw_material_id = raw_material_id;
    }
    if (raw_material_stock_id !== undefined) {
      if (raw_material_stock_id) {
        const stock = await RawMaterialStock.findById(
          raw_material_stock_id,
        ).where({ isDeleted: false });
        if (!stock) {
          return createError(res, 404, "Raw material stock batch not found.");
        }
      }
      updatePayload.raw_material_stock_id = raw_material_stock_id || null;
    }
    if (quantity !== undefined) {
      const qty = Number(quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        return createError(res, 400, "quantity must be greater than 0.");
      }
      updatePayload.quantity = qty;
    }
    if (dispatch_date !== undefined) {
      updatePayload.dispatch_date = new Date(dispatch_date);
    }
    if (notes !== undefined) updatePayload.notes = notes;

    const item = await populateRefs(
      RawMaterialDispatch.findOneAndUpdate(
        { _id: req.params.id, isDeleted: false },
        updatePayload,
        { new: true, runValidators: true },
      ),
    );
    if (!item) return createError(res, 404, "Dispatch not found.");
    return successMessage(res, item, "Dispatch updated successfully.");
  } catch (err) {
    console.error("RawMaterialDispatch update error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to update dispatch.",
    );
  }
};

const remove = async (req, res) => {
  try {
    const item = await RawMaterialDispatch.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true },
    );
    if (!item) return createError(res, 404, "Dispatch not found.");
    return successMessage(res, item, "Dispatch deleted successfully.");
  } catch (err) {
    console.error("RawMaterialDispatch remove error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to delete dispatch.",
    );
  }
};

// Internal helper — escape a user-provided string for safe RegExp use in
// the `location` filter on the list endpoint.
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { list, getOne, create, update, remove };
