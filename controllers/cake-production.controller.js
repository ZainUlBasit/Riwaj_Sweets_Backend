const CakeProduction = require("../Models/CakeProduction");
const Product = require("../Models/Products");
const ProductStock = require("../Models/ProductStock");
const DispatchLocation = require("../Models/DispatchLocation");
const { getOrCreateLocation } = require("./dispatch-location.controller");
const { createError, successMessage } = require("../utils/ResponseMessage");
const {
  TX,
  DIR,
  INV_TYPE,
  getUserId,
  writeAudit,
  writeLedger,
  adjustProduct,
  adjustLocationInventory,
  consumeBomForProduction,
  reverseBomConsumption,
  validateBomAvailability,
  withTransaction,
} = require("../Services/inventoryService");

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const populateRefs = (q) =>
  q
    .populate("product_id")
    .populate("product_stock_id")
    .populate("location_id")
    .populate({
      path: "raw_materials_consumed.raw_material_id",
      select: "name unit",
    })
    .populate({
      path: "raw_material_stock_id",
      populate: { path: "raw_material_id" },
    });

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

async function applyProductionImpact({
  product,
  cakes,
  productionDate,
  productionLocation,
  userId,
  referenceType,
  referenceId,
  session = null,
}) {
  const opts = session ? { session } : {};
  let productStock = null;
  let consumptions = [];

  if (cakes > 0) {
    const bomResult = await consumeBomForProduction({
      product,
      unitsProduced: cakes,
      referenceType,
      referenceId,
      locationId: productionLocation?._id ?? null,
      storeId: productionLocation?.store_id ?? null,
      userId,
      notesPrefix: `Production ${new Date(productionDate).toISOString().slice(0, 10)}`,
      session,
    });
    consumptions = bomResult.consumptions;
    const rawMaterialsUsed = bomResult.rawMaterialsUsed;

    const [createdStock] = await ProductStock.create(
      [
        {
          product_id: product._id,
          desc: `Production on ${new Date(productionDate)
            .toISOString()
            .slice(0, 10)}${
            productionLocation?.name ? ` at ${productionLocation.name}` : ""
          }`,
          quantity: cakes,
          price: 0,
          total_price: 0,
          raw_materials_used: rawMaterialsUsed,
          location_id: productionLocation?._id ?? null,
          inventory_type: INV_TYPE.PRODUCTION,
          isDeleted: false,
        },
      ],
      opts,
    );
    productStock = createdStock;

    const prevAvail = Number(product.available_quantity || 0);
    const updatedProduct = await adjustProduct(
      product._id,
      { inDelta: cakes, availDelta: cakes },
      session,
    );

    if (productionLocation?._id) {
      await adjustLocationInventory(
        productionLocation._id,
        product._id,
        cakes,
        INV_TYPE.PRODUCTION,
        session,
      );
    }

    await writeLedger(
      {
        transactionType: TX.PRODUCTION_ENTRY,
        direction: DIR.IN,
        productId: product._id,
        quantity: cakes,
        locationId: productionLocation?._id ?? null,
        storeId: productionLocation?.store_id ?? null,
        referenceType: "CakeProduction",
        referenceId,
        userId,
        notes: `Produced ${cakes} × ${product.name}`,
        previousBalance: prevAvail,
        newBalance: Number(updatedProduct?.available_quantity ?? prevAvail + cakes),
      },
      session,
    );
  }

  return { productStock, consumptions };
}

const create = async (req, res) => {
  try {
    const {
      production_date,
      cakes_produced,
      product_id,
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

    if (cakes > 0) {
      const validation = await validateBomAvailability(product, cakes);
      if (validation.missing) {
        return createError(
          res,
          422,
          "Product has no BOM (bill of materials). Configure raw material recipe on the product before logging production.",
        );
      }
      if (!validation.ok) {
        const detail = validation.shortages
          .map((s) => `${s.name}: need ${s.required}, available ${s.available}`)
          .join("; ");
        return createError(res, 409, `Insufficient raw material stock. ${detail}`);
      }
    }

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

    const userId = getUserId(req);

    const item = await withTransaction(async (session) => {
      const opts = { session };
      const [created] = await CakeProduction.create(
        [
          {
            production_date: new Date(production_date),
            cakes_produced: cakes,
            product_id: product._id,
            location_id: productionLocation?._id ?? null,
            location: productionLocation?.name ?? "",
            notes: notes ?? "",
            isDeleted: false,
          },
        ],
        opts,
      );

      const { productStock, consumptions } = await applyProductionImpact({
        product,
        cakes,
        productionDate: production_date,
        productionLocation,
        userId,
        referenceType: "CakeProduction",
        referenceId: created._id,
        session,
      });

      if (productStock) created.product_stock_id = productStock._id;
      if (consumptions.length) created.raw_materials_consumed = consumptions;
      await created.save(opts);

      await writeAudit({
        entityType: "CakeProduction",
        entityId: created._id,
        action: "create",
        newValue: created.toObject?.() ?? created,
        userId,
        session,
      });

      return created;
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
      err.status || 500,
      err.message || "Failed to create cake production.",
    );
  }
};

const update = async (req, res) => {
  try {
    const {
      production_date,
      cakes_produced,
      product_id,
      location_id,
      location,
      notes,
    } = req.body || {};

    const existing = await CakeProduction.findById(req.params.id);
    if (!existing) return createError(res, 404, "Cake production not found.");

    const userId = getUserId(req);
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

    const finalProduct = await Product.findById(
      updatePayload.product_id ?? existing.product_id,
    ).where({ isDeleted: false });
    if (!finalProduct) return createError(res, 404, "Product not found.");

    const finalCakes =
      updatePayload.cakes_produced ?? existing.cakes_produced ?? 0;

    if (finalCakes > 0) {
      const validation = await validateBomAvailability(finalProduct, finalCakes);
      if (validation.missing) {
        return createError(
          res,
          422,
          "Product has no BOM. Configure raw material recipe before updating production.",
        );
      }
    }

    const item = await withTransaction(async (session) => {
      const opts = { session };

      if (!existing.isDeleted) {
        await reverseProductionImpact(existing, userId, session);
      }

      const updated = await CakeProduction.findByIdAndUpdate(
        req.params.id,
        {
          ...updatePayload,
          product_stock_id: null,
          raw_materials_consumed: [],
          raw_material_stock_id: null,
        },
        { new: true, runValidators: true, ...opts },
      );

      const productionLocation = updatePayload.location_id
        ? await DispatchLocation.findById(updatePayload.location_id).session(session)
        : existing.location_id
          ? await DispatchLocation.findById(existing.location_id).session(session)
          : null;

      const { productStock, consumptions } = await applyProductionImpact({
        product: finalProduct,
        cakes: finalCakes,
        productionDate: updatePayload.production_date ?? existing.production_date,
        productionLocation,
        userId,
        referenceType: "CakeProduction",
        referenceId: updated._id,
        session,
      });

      if (productStock) updated.product_stock_id = productStock._id;
      if (consumptions.length) updated.raw_materials_consumed = consumptions;
      await updated.save(opts);

      await writeAudit({
        entityType: "CakeProduction",
        entityId: updated._id,
        action: "update",
        previousValue: existing.toObject?.() ?? existing,
        newValue: updated.toObject?.() ?? updated,
        userId,
        session,
      });

      return updated;
    });

    const populated = await populateRefs(CakeProduction.findById(item._id));
    return successMessage(res, populated || item, "Cake production updated successfully.");
  } catch (err) {
    console.error("CakeProduction update error:", err);
    return createError(
      res,
      err.status || 500,
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

    const userId = getUserId(req);

    const item = await withTransaction(async (session) => {
      await reverseProductionImpact(existing, userId, session);

      const deleted = await CakeProduction.findByIdAndUpdate(
        req.params.id,
        {
          isDeleted: true,
          product_stock_id: null,
          raw_materials_consumed: [],
        },
        { new: true, session },
      );

      await writeAudit({
        entityType: "CakeProduction",
        entityId: deleted._id,
        action: "delete",
        previousValue: existing.toObject?.() ?? existing,
        userId,
        session,
      });

      return deleted;
    });

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

async function reverseProductionImpact(record, userId = null, session = null) {
  const opts = session ? { session } : {};

  if (record?.raw_materials_consumed?.length) {
    await reverseBomConsumption(record.raw_materials_consumed, userId, session);
  }

  if (!record?.product_stock_id) return;

  const stockQ = ProductStock.findById(record.product_stock_id);
  if (session) stockQ.session(session);
  const stock = await stockQ;
  if (!stock || stock.isDeleted) return;

  const qty = Number(stock.quantity || 0);
  if (qty > 0 && stock.product_id) {
    const productQ = Product.findById(stock.product_id);
    if (session) productQ.session(session);
    const product = await productQ;
    const prevAvail = Number(product?.available_quantity || 0);
    const updated = await adjustProduct(
      stock.product_id,
      { inDelta: -qty, availDelta: -qty },
      session,
    );

    if (stock.location_id) {
      await adjustLocationInventory(
        stock.location_id,
        stock.product_id,
        -qty,
        stock.inventory_type || INV_TYPE.PRODUCTION,
        session,
      );
    }

    await writeLedger(
      {
        transactionType: TX.ADJUSTMENT,
        direction: DIR.OUT,
        productId: stock.product_id,
        quantity: qty,
        locationId: stock.location_id,
        referenceType: "CakeProduction",
        referenceId: record._id,
        userId,
        notes: "Production entry reversed",
        previousBalance: prevAvail,
        newBalance: Number(updated?.available_quantity ?? prevAvail - qty),
      },
      session,
    );
  }

  await ProductStock.findByIdAndUpdate(stock._id, { isDeleted: true }, opts);
}

module.exports = { list, getOne, create, update, remove };
