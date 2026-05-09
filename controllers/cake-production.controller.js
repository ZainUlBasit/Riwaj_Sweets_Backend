const CakeProduction = require("../Models/CakeProduction");
const RawMaterialStock = require("../Models/RawMaterialStock");
const Product = require("../Models/Products");
const ProductStock = require("../Models/ProductStock");
const DispatchLocation = require("../Models/DispatchLocation");
const { getOrCreateLocation } = require("./dispatch-location.controller");
const { createError, successMessage } = require("../utils/ResponseMessage");

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const populateRefs = (q) =>
  q
    .populate("product_id")
    .populate("product_stock_id")
    .populate("location_id")
    .populate({
      path: "raw_material_stock_id",
      populate: { path: "raw_material_id" },
    });

/**
 * GET /api/cake-production
 *
 * Optional query params:
 *   start_date, end_date  — ISO dates to filter `production_date` (inclusive)
 *
 * Response payload uses canonical `items` / `deletedItems` keys.
 */
const list = async (req, res) => {
  try {
    const { start_date, end_date, location_id, location } = req.query || {};

    const range = {};
    if (start_date) range.$gte = new Date(start_date);
    if (end_date) range.$lte = new Date(end_date);

    const baseFilter = {};
    if (Object.keys(range).length > 0) baseFilter.production_date = range;
    if (location_id) baseFilter.location_id = location_id;
    else if (location)
      baseFilter.location = new RegExp(`^${escapeRegex(location)}$`, "i");

    // Backfill older production records that were created before
    // product_stock_id auto-linking existed. This keeps GET responses and
    // inventory state consistent without requiring a manual migration first.
    await ensureProductStockLinks(baseFilter);

    const items = await populateRefs(
      CakeProduction.find({ ...baseFilter, isDeleted: false }).sort({
        production_date: -1,
        createdAt: -1,
      }),
    );
    const deletedItems = await populateRefs(
      CakeProduction.find({ ...baseFilter, isDeleted: true }).sort({
        production_date: -1,
        createdAt: -1,
      }),
    );

    return successMessage(
      res,
      { items, deletedItems },
      "Cake productions fetched successfully.",
    );
  } catch (err) {
    console.error("CakeProduction list error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to fetch cake productions.",
    );
  }
};

const getOne = async (req, res) => {
  try {
    await ensureProductStockLinks({ _id: req.params.id });

    const item = await populateRefs(
      CakeProduction.findById(req.params.id).where({ isDeleted: false }),
    );
    if (!item) return createError(res, 404, "Cake production not found.");
    return successMessage(res, item, "Cake production fetched successfully.");
  } catch (err) {
    console.error("CakeProduction getOne error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to fetch cake production.",
    );
  }
};

/**
 * POST /api/cake-production
 *
 * Body: { production_date, cakes_produced, product_id, location_id?/location?, raw_material_stock_id?, notes? }
 *
 * Side-effects (when cakes_produced > 0):
 *   - creates a ProductStock row for the chosen product with
 *     quantity = cakes_produced, price = 0
 *   - increments Product.in_quantity / Product.available_quantity
 *
 * The auto-created stock id is persisted on the CakeProduction record so
 * edit/delete can reverse the impact deterministically.
 */
const create = async (req, res) => {
  try {
    const {
      production_date,
      cakes_produced,
      product_id,
      raw_material_stock_id,
      location_id,
      location,
      notes,
    } = req.body || {};

    if (!production_date) {
      return createError(res, 400, "production_date is required.");
    }
    if (!product_id) {
      return createError(res, 400, "product_id is required.");
    }
    const cakes = Number(cakes_produced ?? 0);
    if (!Number.isFinite(cakes) || cakes < 0) {
      return createError(
        res,
        400,
        "cakes_produced must be a non-negative number.",
      );
    }

    const product = await Product.findById(product_id).where({
      isDeleted: false,
    });
    if (!product) return createError(res, 404, "Product not found.");

    let productionLocation = null;
    if (location_id) {
      productionLocation = await DispatchLocation.findById(location_id).where({
        isDeleted: false,
      });
      if (!productionLocation) {
        return createError(res, 404, "Production location not found.");
      }
    } else if ((location ?? "").trim()) {
      productionLocation = await getOrCreateLocation(location);
      if (!productionLocation) {
        return createError(res, 404, "Production location not found.");
      }
    }

    let stockRef = null;
    if (raw_material_stock_id) {
      const batch = await RawMaterialStock.findById(
        raw_material_stock_id,
      ).where({ isDeleted: false });
      if (!batch) {
        return createError(res, 404, "Raw material stock batch not found.");
      }
      stockRef = raw_material_stock_id;
    }

    // Step 1: create the ProductStock entry (if any cakes were produced)
    let productStock = null;
    if (cakes > 0) {
      productStock = await ProductStock.create({
        product_id: product._id,
        desc: `Cake production on ${new Date(production_date)
          .toISOString()
          .slice(0, 10)}${
          productionLocation?.name ? ` at ${productionLocation.name}` : ""
        }`,
        quantity: cakes,
        price: 0,
        total_price: 0,
        raw_materials_used: [],
        isDeleted: false,
      });

      await Product.findByIdAndUpdate(product._id, {
        $inc: { in_quantity: cakes, available_quantity: cakes },
      });
    }

    // Step 2: persist the cake production log
    const item = await CakeProduction.create({
      production_date: new Date(production_date),
      cakes_produced: cakes,
      product_id: product._id,
      location_id: productionLocation?._id ?? null,
      location: productionLocation?.name ?? "",
      product_stock_id: productStock?._id ?? null,
      raw_material_stock_id: stockRef,
      notes: notes ?? "",
      isDeleted: false,
    });

    const populated = await populateRefs(CakeProduction.findById(item._id));

    return successMessage(
      res,
      populated || item,
      "Cake production created successfully.",
    );
  } catch (err) {
    console.error("CakeProduction create error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to create cake production.",
    );
  }
};

/**
 * PATCH /api/cake-production/:id
 *
 * Re-syncs the linked ProductStock + Product inventory whenever the
 * production count or chosen product change. Strategy:
 *   1. Reverse the previously applied stock + product qty.
 *   2. Apply the new stock + product qty.
 * This keeps the math correct even when a record is restored from the
 * soft-deleted state via update.
 */
const update = async (req, res) => {
  try {
    const {
      production_date,
      cakes_produced,
      product_id,
      raw_material_stock_id,
      location_id,
      location,
      notes,
    } = req.body || {};

    const existing = await CakeProduction.findById(req.params.id);
    if (!existing) return createError(res, 404, "Cake production not found.");

    const updatePayload = { isDeleted: false };
    if (production_date !== undefined)
      updatePayload.production_date = new Date(production_date);
    if (cakes_produced !== undefined) {
      const cakes = Number(cakes_produced);
      if (!Number.isFinite(cakes) || cakes < 0) {
        return createError(
          res,
          400,
          "cakes_produced must be a non-negative number.",
        );
      }
      updatePayload.cakes_produced = cakes;
    }
    if (product_id !== undefined) {
      const product = await Product.findById(product_id).where({
        isDeleted: false,
      });
      if (!product) return createError(res, 404, "Product not found.");
      updatePayload.product_id = product._id;
    }
    if (raw_material_stock_id !== undefined) {
      if (raw_material_stock_id === null || raw_material_stock_id === "") {
        updatePayload.raw_material_stock_id = null;
      } else {
        const batch = await RawMaterialStock.findById(
          raw_material_stock_id,
        ).where({ isDeleted: false });
        if (!batch) {
          return createError(res, 404, "Raw material stock batch not found.");
        }
        updatePayload.raw_material_stock_id = raw_material_stock_id;
      }
    }
    if (location_id !== undefined || location !== undefined) {
      if (
        (location_id === null || location_id === "") &&
        (location === null || location === "" || location === undefined)
      ) {
        updatePayload.location_id = null;
        updatePayload.location = "";
      } else {
        const productionLocation = location_id
          ? await DispatchLocation.findById(location_id).where({
              isDeleted: false,
            })
          : await getOrCreateLocation(location);
        if (!productionLocation) {
          return createError(res, 404, "Production location not found.");
        }
        updatePayload.location_id = productionLocation._id;
        updatePayload.location = productionLocation.name;
      }
    }
    if (notes !== undefined) updatePayload.notes = notes;

    // ---- Reverse prior inventory impact (only if it was applied) ----
    const wasActive = !existing.isDeleted;
    if (wasActive) {
      await reverseProductImpact(existing);
    }

    // ---- Apply new inventory impact ----
    const finalProductId =
      updatePayload.product_id ?? existing.product_id ?? null;
    const finalCakes =
      updatePayload.cakes_produced ?? existing.cakes_produced ?? 0;

    let newStock = null;
    if (finalProductId && finalCakes > 0) {
      const refDate = updatePayload.production_date ?? existing.production_date;
      newStock = await ProductStock.create({
        product_id: finalProductId,
        desc: `Cake production on ${new Date(refDate)
          .toISOString()
          .slice(0, 10)}${
          updatePayload.location || existing.location
            ? ` at ${updatePayload.location || existing.location}`
            : ""
        }`,
        quantity: finalCakes,
        price: 0,
        total_price: 0,
        raw_materials_used: [],
        isDeleted: false,
      });

      await Product.findByIdAndUpdate(finalProductId, {
        $inc: { in_quantity: finalCakes, available_quantity: finalCakes },
      });
    }
    updatePayload.product_stock_id = newStock?._id ?? null;

    const item = await populateRefs(
      CakeProduction.findByIdAndUpdate(req.params.id, updatePayload, {
        new: true,
        runValidators: true,
      }),
    );
    if (!item) return createError(res, 404, "Cake production not found.");
    return successMessage(res, item, "Cake production updated successfully.");
  } catch (err) {
    console.error("CakeProduction update error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to update cake production.",
    );
  }
};

const remove = async (req, res) => {
  try {
    const existing = await CakeProduction.findById(req.params.id);
    if (!existing || existing.isDeleted) {
      return createError(res, 404, "Cake production not found.");
    }

    // Reverse the linked ProductStock + Product qty before soft-deleting.
    await reverseProductImpact(existing);

    const item = await CakeProduction.findByIdAndUpdate(
      req.params.id,
      { isDeleted: true, product_stock_id: null },
      { new: true },
    );
    return successMessage(res, item, "Cake production deleted successfully.");
  } catch (err) {
    console.error("CakeProduction remove error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to delete cake production.",
    );
  }
};

/**
 * Reverses the inventory side-effects of a CakeProduction record:
 *   - soft-deletes the linked ProductStock (if still active)
 *   - decrements Product.in_quantity / available_quantity by the qty that
 *     was applied originally
 *
 * Idempotent — safe to call multiple times.
 */
async function reverseProductImpact(record) {
  if (!record?.product_stock_id) return;

  const stock = await ProductStock.findById(record.product_stock_id);
  if (!stock || stock.isDeleted) return;

  const qty = Number(stock.quantity || 0);
  if (qty > 0 && stock.product_id) {
    await Product.findByIdAndUpdate(stock.product_id, {
      $inc: { in_quantity: -qty, available_quantity: -qty },
    });
  }

  await ProductStock.findByIdAndUpdate(stock._id, { isDeleted: true });
}

/**
 * Creates the missing ProductStock link for active CakeProduction rows that:
 *   - have a product_id,
 *   - have cakes_produced > 0,
 *   - do not have product_stock_id yet.
 *
 * Old rows without product_id cannot be inferred safely; user should edit
 * those rows and choose the product.
 */
async function ensureProductStockLinks(filter = {}) {
  const rows = await CakeProduction.find({
    ...filter,
    isDeleted: false,
    product_stock_id: null,
    product_id: { $exists: true, $ne: null },
    cakes_produced: { $gt: 0 },
  });

  for (const row of rows) {
    const product = await Product.findById(row.product_id).where({
      isDeleted: false,
    });
    if (!product) continue;

    const productStock = await ProductStock.create({
      product_id: product._id,
      desc: `Cake production on ${new Date(row.production_date)
        .toISOString()
        .slice(0, 10)}${row.location ? ` at ${row.location}` : ""}`,
      quantity: row.cakes_produced,
      price: 0,
      total_price: 0,
      raw_materials_used: [],
      isDeleted: false,
    });

    await Product.findByIdAndUpdate(product._id, {
      $inc: {
        in_quantity: row.cakes_produced,
        available_quantity: row.cakes_produced,
      },
    });

    await CakeProduction.findByIdAndUpdate(row._id, {
      product_stock_id: productStock._id,
    });
  }
}

module.exports = { list, getOne, create, update, remove };
