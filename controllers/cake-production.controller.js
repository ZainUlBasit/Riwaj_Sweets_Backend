const CakeProduction = require("../Models/CakeProduction");
const Product = require("../Models/Products");
const ProductStock = require("../Models/ProductStock");
const DispatchLocation = require("../Models/DispatchLocation");
const UstadJob = require("../Models/UstadJob");
const { JOB_STATUS } = require("../Models/UstadJob");
const Ustad = require("../Models/Ustad");
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
  reverseManualProductionConsumption,
  findFinishedGoodsStore,
  findProductionArea,
  executeStoreReceipt,
  reverseStoreReceipt,
  withTransaction,
} = require("../Services/inventoryService");
const { assertRmManagerStoreAccess, applyStoreLocationFilter, getAssignedStoreId } = require("../utils/storeScope");

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const populateRefs = (q) =>
  q
    .populate("product_id")
    .populate("product_stock_id")
    .populate("location_id")
    .populate({
      path: "store_receipt_id",
      populate: [
        { path: "to_location_id", select: "name location_type" },
        { path: "product_id", select: "name id unit" },
      ],
    })
    .populate({
      path: "raw_materials_consumed.raw_material_id",
      select: "name unit",
    })
    .populate({
      path: "raw_material_stock_id",
      populate: { path: "raw_material_id" },
    })
    .populate("ustad_job_id", "job_code ustad_name rm_value_issued status")
    .populate("ustad_id", "name phone");

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

    const scopedFilter = await applyStoreLocationFilter(req, baseFilter, "location_id");

    const items = await populateRefs(
      CakeProduction.find({ ...scopedFilter, isDeleted: false }).sort({
        production_date: -1,
        createdAt: -1,
      }),
    );
    const deletedItems = await populateRefs(
      CakeProduction.find({ ...scopedFilter, isDeleted: true }).sort({
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
  ustadName = "",
  ustadId = null,
  /** Optional explicit Product Store (finished goods). Required for clear destination. */
  productStoreLocation = null,
  session = null,
}) {
  const opts = session ? { session } : {};
  let productStock = null;
  // Production does NOT deduct raw materials.
  // RM leaves via RM Store → Production dispatch; production only creates finished goods.
  const consumptions = [];
  let storeReceipt = null;

  if (cakes > 0) {
    let fgStore = productStoreLocation || null;
    if (
      fgStore &&
      Number(fgStore.location_type) !== LOCATION_TYPE.FINISHED_GOODS_STORE
    ) {
      const err = new Error("to_location_id must be a Product Store.");
      err.status = 400;
      throw err;
    }
    if (!fgStore && productionLocation?.store_id) {
      fgStore = await findFinishedGoodsStore(
        productionLocation.store_id,
        session,
      );
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
          notes: `Auto from ${productionLocation.name}${
            ustadName ? ` · Ustad: ${ustadName}` : ""
          }`,
          cakeProductionId: referenceId,
          ustadName,
          ustadId,
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
      ustad_name,
      ustad_id,
      ustad_job_id,
      to_location_id,
      product_store_id,
    } = req.body || {};

    if (!production_date) {
      return createError(res, 400, "production_date is required.");
    }
    if (!product_id) {
      return createError(res, 400, "product_id is required.");
    }

    let ustadName = String(ustad_name || "").trim();
    let ustadDocId = null;
    let linkedJob = null;
    if (ustad_job_id) {
      linkedJob = await UstadJob.findById(ustad_job_id).where({
        isDeleted: false,
      });
      if (!linkedJob) {
        return createError(res, 404, "Ustad job not found.");
      }
      if (Number(linkedJob.status) === JOB_STATUS.CLOSED) {
        return createError(res, 400, "Yeh ustad job band ho chuki hai.");
      }
      if (!ustadName) ustadName = linkedJob.ustad_name;
      if (!ustad_id && linkedJob.ustad_id) ustadDocId = linkedJob.ustad_id;
    }
    if (ustad_id || ustadDocId) {
      const u = await Ustad.findById(ustad_id || ustadDocId).where({
        isDeleted: false,
      });
      if (!u) return createError(res, 404, "Registered ustad not found.");
      ustadName = u.name;
      ustadDocId = u._id;
    }
    if (!ustadName) {
      return createError(
        res,
        400,
        "Registered ustad select karein (kis ne tayar kiya).",
      );
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
      const effectiveLocationId =
        location_id || (linkedJob ? linkedJob.location_id : null);
      if (effectiveLocationId) {
        productionLocation = await resolveProductionLocation({
          location_id: effectiveLocationId,
          location,
          required: false,
        });
      }
      if (!productionLocation && cakes > 0) {
        // Prefer store from linked job's production location
        let storeId = getAssignedStoreId(req);
        if (linkedJob?.location_id) {
          const jobLoc = await DispatchLocation.findById(linkedJob.location_id);
          storeId = jobLoc?.store_id || storeId;
        }
        productionLocation = await findProductionArea(storeId);
        if (!productionLocation) {
          productionLocation = await DispatchLocation.findOne({
            location_type: 2,
            isDeleted: false,
          }).sort({ createdAt: 1 });
        }
      }
      if (cakes > 0 && !productionLocation) {
        return createError(
          res,
          400,
          "Production area configure nahi hai. Stores & Locations me store setup karein.",
        );
      }
    } catch (err) {
      return createError(res, err.status || 400, err.message);
    }

    // Job location check only when both exist and were explicitly mismatched via job
    if (
      linkedJob &&
      productionLocation?._id &&
      linkedJob.location_id &&
      String(linkedJob.location_id) !== String(productionLocation._id)
    ) {
      // Prefer job's production location for inventory consistency
      const jobLoc = await DispatchLocation.findById(linkedJob.location_id).where({
        isDeleted: false,
      });
      if (jobLoc) productionLocation = jobLoc;
    }

    if (productionLocation?._id) {
      try {
        await assertRmManagerStoreAccess(req, [productionLocation._id]);
      } catch (err) {
        return createError(res, err.status || 403, err.message);
      }
    }

    // Explicit Product Store destination (Ustad / production receive)
    let productStoreLocation = null;
    const fgLocationId = to_location_id || product_store_id || null;
    if (cakes > 0) {
      if (!fgLocationId) {
        return createError(
          res,
          400,
          "Product Store select karein — finished goods kahan add honge.",
        );
      }
      productStoreLocation = await DispatchLocation.findById(fgLocationId).where({
        isDeleted: false,
      });
      if (!productStoreLocation) {
        return createError(res, 404, "Product Store not found.");
      }
      if (
        Number(productStoreLocation.location_type) !==
        LOCATION_TYPE.FINISHED_GOODS_STORE
      ) {
        return createError(res, 400, "to_location_id must be a Product Store.");
      }
      try {
        await assertRmManagerStoreAccess(req, [productStoreLocation._id]);
      } catch (err) {
        return createError(res, err.status || 403, err.message);
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
            ustad_name: ustadName,
            ustad_id: ustadDocId,
            ustad_job_id: linkedJob?._id ?? null,
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
        userId,
        referenceType: "CakeProduction",
        referenceId: created._id,
        ustadName,
        ustadId: ustadDocId,
        productStoreLocation,
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
      ustad_name,
      ustad_id,
      ustad_job_id,
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
    if (ustad_name !== undefined) {
      const ustadName = String(ustad_name || "").trim();
      if (!ustadName) {
        return createError(res, 400, "Ustad name is required (kis ne tayar kiya).");
      }
      updatePayload.ustad_name = ustadName;
    }
    if (ustad_id !== undefined) {
      if (!ustad_id) {
        updatePayload.ustad_id = null;
      } else {
        const u = await Ustad.findById(ustad_id).where({ isDeleted: false });
        if (!u) return createError(res, 404, "Registered ustad not found.");
        updatePayload.ustad_id = u._id;
        updatePayload.ustad_name = u.name;
      }
    }
    if (ustad_job_id !== undefined) {
      if (!ustad_job_id) {
        updatePayload.ustad_job_id = null;
      } else {
        const linkedJob = await UstadJob.findById(ustad_job_id).where({
          isDeleted: false,
        });
        if (!linkedJob) return createError(res, 404, "Ustad job not found.");
        updatePayload.ustad_job_id = linkedJob._id;
        if (ustad_name === undefined) {
          updatePayload.ustad_name = linkedJob.ustad_name;
        }
      }
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
        userId,
        referenceType: "CakeProduction",
        referenceId: updated._id,
        ustadName: updatePayload.ustad_name ?? existing.ustad_name ?? "",
        ustadId: updatePayload.ustad_id ?? existing.ustad_id ?? null,
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

module.exports = { list, getOne, create, update, remove, reverseProductionImpact };
