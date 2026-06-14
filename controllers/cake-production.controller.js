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
  LOCATION_TYPE,
  getUserId,
  writeAudit,
  writeLedger,
  adjustProduct,
  adjustLocationInventory,
  reverseBomConsumption,
  applyManualProductionConsumption,
  reverseManualProductionConsumption,
  findFinishedGoodsStore,
  executeStoreReceipt,
  reverseStoreReceipt,
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
      path: "store_receipt_id",
      populate: { path: "to_location_id", select: "name location_type" },
    })
    .populate({
      path: "raw_materials_consumed.raw_material_id",
      select: "name unit",
    })
    .populate({
      path: "raw_material_stock_id",
      populate: { path: "raw_material_id" },
    });

async function resolveProductionLocation({ location_id, location, required = false }) {
  if (location_id) {
    const loc = await DispatchLocation.findById(location_id).where({
      isDeleted: false,
    });
    if (!loc) {
      const err = new Error("Production area not found.");
      err.status = 404;
      throw err;
    }
    if (Number(loc.location_type || LOCATION_TYPE.PRODUCTION_AREA) !== LOCATION_TYPE.PRODUCTION_AREA) {
      const err = new Error(
        "Selected location must be a production area. Add one under Stores & Locations.",
      );
      err.status = 400;
      throw err;
    }
    return loc;
  }

  if ((location ?? "").trim()) {
    const loc = await getOrCreateLocation(location);
    if (!loc) {
      const err = new Error("Production area not found.");
      err.status = 404;
      throw err;
    }
    if (Number(loc.location_type || LOCATION_TYPE.PRODUCTION_AREA) !== LOCATION_TYPE.PRODUCTION_AREA) {
      const err = new Error(
        "Location must be a production area. Select from Stores & Locations.",
      );
      err.status = 400;
      throw err;
    }
    return loc;
  }

  if (required) {
    const err = new Error(
      "Production area is required. Log production from a configured production area.",
    );
    err.status = 400;
    throw err;
  }
  return null;
}

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
  rawMaterialsConsumed = [],
  userId,
  referenceType,
  referenceId,
  session = null,
}) {
  const opts = session ? { session } : {};
  let productStock = null;
  let consumptions = [];
  let storeReceipt = null;

  if (productionLocation?._id && rawMaterialsConsumed?.length) {
    consumptions = await applyManualProductionConsumption({
      rawMaterialsConsumed,
      productionLocationId: productionLocation._id,
      referenceType,
      referenceId,
      userId,
      notesPrefix: `Production: ${product.name}`,
      session,
    });
  }

  if (cakes > 0) {
    let fgStore = null;
    if (productionLocation?.store_id) {
      fgStore = await findFinishedGoodsStore(productionLocation.store_id, session);
    }

    const stockLocationId = fgStore?._id ?? productionLocation?._id ?? null;
    const stockInvType = fgStore ? INV_TYPE.STORE : INV_TYPE.PRODUCTION;

    const [createdStock] = await ProductStock.create(
      [
        {
          product_id: product._id,
          desc: `Production on ${new Date(productionDate)
            .toISOString()
            .slice(0, 10)}${
            productionLocation?.name ? ` at ${productionLocation.name}` : ""
          }${fgStore?.name ? ` → ${fgStore.name}` : ""}`,
          quantity: cakes,
          price: 0,
          total_price: 0,
          raw_materials_used: [],
          location_id: stockLocationId,
          inventory_type: stockInvType,
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
      if (fgStore?._id) {
        await adjustLocationInventory(
          productionLocation._id,
          product._id,
          cakes,
          INV_TYPE.PRODUCTION,
          session,
        );
        storeReceipt = await executeStoreReceipt({
          fromLocationId: productionLocation._id,
          toLocationId: fgStore._id,
          productId: product._id,
          quantity: cakes,
          receiptDate: productionDate,
          userId,
          referenceType: "CakeProduction",
          referenceId,
          notes: `Auto from ${productionLocation.name}`,
          cakeProductionId: referenceId,
          session,
        });
      } else {
        await adjustLocationInventory(
          productionLocation._id,
          product._id,
          cakes,
          INV_TYPE.PRODUCTION,
          session,
        );
      }
    }

    const inventoryLocationId = fgStore?._id ?? productionLocation?._id ?? null;
    await writeLedger(
      {
        transactionType: TX.PRODUCTION_ENTRY,
        direction: DIR.IN,
        productId: product._id,
        quantity: cakes,
        locationId: inventoryLocationId,
        storeId: fgStore?.store_id ?? productionLocation?.store_id ?? null,
        referenceType: "CakeProduction",
        referenceId,
        userId,
        notes: fgStore
          ? `Produced ${cakes} × ${product.name} at ${productionLocation?.name ?? "?"} → ${fgStore.name}`
          : `Produced ${cakes} × ${product.name}${
              productionLocation?.name ? ` at ${productionLocation.name}` : ""
            }`,
        previousBalance: prevAvail,
        newBalance: Number(updatedProduct?.available_quantity ?? prevAvail + cakes),
      },
      session,
    );
  }

  return { productStock, consumptions, storeReceipt };
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
      raw_materials_consumed,
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
    try {
      productionLocation = await resolveProductionLocation({
        location_id,
        location,
        required: cakes > 0,
      });
    } catch (err) {
      return createError(res, err.status || 400, err.message);
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

      const { productStock, consumptions, storeReceipt } = await applyProductionImpact({
        product,
        cakes,
        productionDate: production_date,
        productionLocation,
        rawMaterialsConsumed: raw_materials_consumed,
        userId,
        referenceType: "CakeProduction",
        referenceId: created._id,
        session,
      });

      if (productStock) created.product_stock_id = productStock._id;
      if (consumptions.length) created.raw_materials_consumed = consumptions;
      if (storeReceipt) created.store_receipt_id = storeReceipt._id;
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
      raw_materials_consumed,
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
        if ((updatePayload.cakes_produced ?? existing.cakes_produced ?? 0) > 0) {
          return createError(res, 400, "Production area is required when quantity is greater than 0.");
        }
        updatePayload.location_id = null;
        updatePayload.location = "";
      } else {
        try {
          const productionLocation = await resolveProductionLocation({
            location_id,
            location,
            required: true,
          });
          updatePayload.location_id = productionLocation._id;
          updatePayload.location = productionLocation.name;
        } catch (err) {
          return createError(res, err.status || 400, err.message);
        }
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
      const effectiveLocationId =
        updatePayload.location_id ?? existing.location_id ?? null;
      if (!effectiveLocationId) {
        return createError(
          res,
          400,
          "Production area is required when quantity is greater than 0.",
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
          store_receipt_id: null,
        },
        { new: true, runValidators: true, ...opts },
      );

      const productionLocation = updatePayload.location_id
        ? await DispatchLocation.findById(updatePayload.location_id).session(session)
        : existing.location_id
          ? await DispatchLocation.findById(existing.location_id).session(session)
          : null;

      const { productStock, consumptions, storeReceipt } = await applyProductionImpact({
        product: finalProduct,
        cakes: finalCakes,
        productionDate: updatePayload.production_date ?? existing.production_date,
        productionLocation,
        rawMaterialsConsumed:
          raw_materials_consumed !== undefined
            ? raw_materials_consumed
            : existing.raw_materials_consumed,
        userId,
        referenceType: "CakeProduction",
        referenceId: updated._id,
        session,
      });

      if (productStock) updated.product_stock_id = productStock._id;
      if (consumptions.length) updated.raw_materials_consumed = consumptions;
      if (storeReceipt) updated.store_receipt_id = storeReceipt._id;
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
          store_receipt_id: null,
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

  if (record?.raw_materials_consumed?.length && record?.location_id) {
    const hasStockEntries = record.raw_materials_consumed.some(
      (row) => row.stock_entry_id,
    );
    if (hasStockEntries) {
      await reverseBomConsumption(record.raw_materials_consumed, userId, session);
    } else {
      await reverseManualProductionConsumption(
        record.raw_materials_consumed,
        record.location_id,
        userId,
        session,
      );
    }
  }

  if (record?.store_receipt_id) {
    await reverseStoreReceipt(record.store_receipt_id, userId, session, {
      restoreToProduction: false,
    });
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

    if (stock.location_id && !record?.store_receipt_id) {
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
