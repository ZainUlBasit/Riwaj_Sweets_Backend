const crypto = require("crypto");
const UstadJob = require("../Models/UstadJob");
const { JOB_STATUS } = require("../Models/UstadJob");
const Ustad = require("../Models/Ustad");
const CakeProduction = require("../Models/CakeProduction");
const RawMaterial = require("../Models/RawMaterial");
const RawMaterialStock = require("../Models/RawMaterialStock");
const RawMaterialDispatch = require("../Models/RawMaterialDispatch");
const DispatchLocation = require("../Models/DispatchLocation");
const { createError, successMessage } = require("../utils/ResponseMessage");
const {
  getUserId,
  writeAudit,
  applyRawMaterialDispatchImpact,
  reverseRawMaterialDispatchImpact,
  validateRmTransferLocations,
  findProductionArea,
  withTransaction,
} = require("../Services/inventoryService");
const {
  assertRmManagerStoreAccess,
  applyStoreLocationFilter,
  getAssignedStoreId,
} = require("../utils/storeScope");

const generateJobCode = () => {
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `UJ-${day}-${rand}`;
};

/**
 * Prefer Production under the manager/ustad/RM godown.
 * Creates a dedicated Production row for that store when missing so RM Managers
 * are not blocked by a Store-1-only Production + store-scope assert mismatch.
 */
async function resolveProductionArea(storeHint) {
  if (storeHint) {
    let prod = await findProductionArea(storeHint);
    if (prod) return prod;

    const Store = require("../Models/Store");
    const store = await Store.findById(storeHint).where({ isDeleted: false });
    const baseName = store?.name ? String(store.name).trim() : "Store";
    const preferredName = `${baseName} — Production`;

    const existingByName = await DispatchLocation.findOne({
      name: new RegExp(
        `^${preferredName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "i",
      ),
      isDeleted: false,
    });
    if (existingByName && Number(existingByName.location_type) === 2) {
      if (!existingByName.store_id) {
        existingByName.store_id = storeHint;
        await existingByName.save();
      }
      return existingByName;
    }

    try {
      return await DispatchLocation.create({
        name: preferredName,
        description: "Internal production (hidden)",
        store_id: storeHint,
        location_type: 2,
        isDeleted: false,
      });
    } catch (err) {
      if (err.code === 11000) {
        return (
          (await findProductionArea(storeHint)) ||
          (await DispatchLocation.findOne({
            name: preferredName,
            isDeleted: false,
          }))
        );
      }
      throw err;
    }
  }

  return DispatchLocation.findOne({
    location_type: 2,
    isDeleted: false,
  }).sort({ createdAt: 1 });
}

const populateJob = (q) =>
  q
    .populate("ustad_id", "name phone")
    .populate("from_location_id", "name location_type store_id")
    .populate("location_id", "name location_type store_id")
    .populate("created_by", "name email")
    .populate("lines.raw_material_id", "name unit price")
    .populate("lines.raw_material_stock_id", "price quantity remaining_quantity desc purpose")
    .populate("lines.dispatch_id")
    .populate("planned_products.product_id", "name id unit");

const buildSummary = async (job) => {
  const productions = await CakeProduction.find({
    ustad_job_id: job._id,
    isDeleted: false,
  })
    .populate("product_id", "name id unit price")
    .populate({
      path: "store_receipt_id",
      select: "receipt_code quantity ustad_name receipt_date to_location_id",
      populate: { path: "to_location_id", select: "name" },
    })
    .sort({ production_date: -1, createdAt: -1 });

  const fgItems = productions.map((p) => {
    const unitPrice = Number(p.product_id?.price || 0);
    const qty = Number(p.cakes_produced || 0);
    return {
      production_id: p._id,
      production_date: p.production_date,
      product_id: p.product_id?._id,
      product_name: p.product_id?.name || "Product",
      product_code: p.product_id?.id ?? null,
      unit: p.product_id?.unit ?? null,
      quantity: qty,
      unit_price: unitPrice,
      line_value: Math.round(qty * unitPrice * 100) / 100,
      receipt_code: p.store_receipt_id?.receipt_code || null,
      store_name: p.store_receipt_id?.to_location_id?.name || null,
      ustad_name: p.ustad_name || job.ustad_name,
    };
  });

  const fg_qty_returned = fgItems.reduce((s, r) => s + Number(r.quantity || 0), 0);
  const fg_value_returned = fgItems.reduce(
    (s, r) => s + Number(r.line_value || 0),
    0,
  );
  const rm_value_issued = Number(job.rm_value_issued || 0);

  return {
    job,
    rm_lines: (job.lines || []).map((line) => ({
      line_id: line._id,
      raw_material_id: line.raw_material_id?._id || line.raw_material_id,
      raw_material_name: line.raw_material_id?.name || "RM",
      unit: line.raw_material_id?.unit ?? null,
      quantity: line.quantity,
      unit_price: line.unit_price,
      line_value: line.line_value,
      batch_desc: line.raw_material_stock_id?.desc || null,
      dispatch_id: line.dispatch_id?._id || line.dispatch_id,
    })),
    fg_items: fgItems,
    totals: {
      rm_value_issued,
      rm_lines_count: (job.lines || []).length,
      fg_qty_returned,
      fg_value_returned,
      fg_items_count: fgItems.length,
      value_difference: Math.round((fg_value_returned - rm_value_issued) * 100) / 100,
    },
  };
};

/**
 * GET /api/ustad-job
 */
const list = async (req, res) => {
  try {
    const { status, ustad_name, location_id, start_date, end_date } =
      req.query || {};

    const baseFilter = { isDeleted: false };
    if (status != null && status !== "") baseFilter.status = Number(status);
    if (ustad_name) {
      baseFilter.ustad_name = new RegExp(
        String(ustad_name).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );
    }
    if (location_id) baseFilter.location_id = location_id;
    if (start_date || end_date) {
      baseFilter.issue_date = {};
      if (start_date) baseFilter.issue_date.$gte = new Date(start_date);
      if (end_date) baseFilter.issue_date.$lte = new Date(end_date);
    }

    const scopedFilter = await applyStoreLocationFilter(
      req,
      baseFilter,
      "location_id",
    );

    const items = await populateJob(
      UstadJob.find(scopedFilter).sort({ issue_date: -1, createdAt: -1 }),
    );

    // Attach light FG rollups for list cards
    const jobIds = items.map((j) => j._id);
    const prodAgg = await CakeProduction.aggregate([
      {
        $match: {
          ustad_job_id: { $in: jobIds },
          isDeleted: false,
        },
      },
      {
        $group: {
          _id: "$ustad_job_id",
          fg_qty: { $sum: "$cakes_produced" },
          fg_count: { $sum: 1 },
        },
      },
    ]);
    const aggMap = new Map(
      prodAgg.map((r) => [String(r._id), r]),
    );

    const withRollup = items.map((job) => {
      const roll = aggMap.get(String(job._id));
      const obj = job.toObject?.() ?? job;
      return {
        ...obj,
        fg_qty_returned: roll?.fg_qty ?? 0,
        fg_items_count: roll?.fg_count ?? 0,
      };
    });

    return successMessage(
      res,
      { items: withRollup },
      "Ustad jobs fetched successfully.",
    );
  } catch (err) {
    console.error("UstadJob list error:", err);
    return createError(res, 500, err.message || "Failed to fetch ustad jobs.");
  }
};

/**
 * GET /api/ustad-job/open?location_id=&ustad_name=
 * Open jobs for production form selector.
 */
const listOpen = async (req, res) => {
  try {
    const { location_id, ustad_name } = req.query || {};
    const baseFilter = { isDeleted: false, status: JOB_STATUS.OPEN };
    if (location_id) baseFilter.location_id = location_id;
    if (ustad_name) {
      baseFilter.ustad_name = new RegExp(
        `^${String(ustad_name).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "i",
      );
    }

    const scopedFilter = await applyStoreLocationFilter(
      req,
      baseFilter,
      "location_id",
    );

    const items = await populateJob(
      UstadJob.find(scopedFilter).sort({ issue_date: -1 }).limit(100),
    );

    return successMessage(res, { items }, "Open ustad jobs fetched.");
  } catch (err) {
    console.error("UstadJob listOpen error:", err);
    return createError(res, 500, err.message || "Failed to fetch open jobs.");
  }
};

/**
 * GET /api/ustad-job/:id
 * Full summary: RM out + FG in.
 */
const getOne = async (req, res) => {
  try {
    const job = await populateJob(
      UstadJob.findById(req.params.id).where({ isDeleted: false }),
    );
    if (!job) return createError(res, 404, "Ustad job not found.");

    try {
      await assertRmManagerStoreAccess(req, [
        job.from_location_id?._id || job.from_location_id,
        job.location_id?._id || job.location_id,
      ]);
    } catch (err) {
      return createError(res, err.status || 403, err.message);
    }

    const summary = await buildSummary(job);
    return successMessage(res, summary, "Ustad job summary fetched.");
  } catch (err) {
    console.error("UstadJob getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch ustad job.");
  }
};

/**
 * POST /api/ustad-job
 * Body: ustad_name, from_location_id, location_id, issue_date, notes,
 *        lines: [{ raw_material_id, raw_material_stock_id, quantity }]
 */
const create = async (req, res) => {
  try {
    const {
      ustad_name,
      ustad_id,
      from_location_id,
      location_id,
      issue_date,
      notes,
      lines,
      planned_products,
    } = req.body || {};

    let ustadName = String(ustad_name || "").trim();
    let ustadDoc = null;
    if (ustad_id) {
      ustadDoc = await Ustad.findById(ustad_id).where({
        isDeleted: false,
        isActive: true,
      });
      if (!ustadDoc) {
        return createError(res, 404, "Registered ustad not found / inactive.");
      }
      ustadName = ustadDoc.name;
    }
    if (!ustadName) {
      return createError(
        res,
        400,
        "Registered ustad select karein (ustad_id required).",
      );
    }
    if (!ustad_id) {
      return createError(
        res,
        400,
        "Ustad pehle register karein, phir yahan select karein.",
      );
    }
    if (!from_location_id) {
      return createError(res, 400, "from_location_id (RM Store) is required.");
    }
    if (!issue_date) {
      return createError(res, 400, "issue_date is required.");
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      return createError(res, 400, "At least one RM line is required.");
    }

    const fromLoc = await DispatchLocation.findById(from_location_id).where({
      isDeleted: false,
    });
    if (!fromLoc) return createError(res, 404, "RM Store not found.");

    // Production area is internal — auto-resolve under assigned/ustad/RM godown.
    let toLoc = null;
    if (location_id) {
      toLoc = await DispatchLocation.findById(location_id).where({
        isDeleted: false,
      });
    }
    if (!toLoc) {
      const storeHint =
        getAssignedStoreId(req) ||
        (ustadDoc?.store_id
          ? String(ustadDoc.store_id._id ?? ustadDoc.store_id)
          : null) ||
        (fromLoc.store_id ? String(fromLoc.store_id) : null);
      toLoc = await resolveProductionArea(storeHint);
    }
    if (!toLoc) {
      return createError(
        res,
        400,
        "Production area configure nahi hai. Stores pe Store setup karein.",
      );
    }

    try {
      await validateRmTransferLocations(fromLoc._id, toLoc._id);
    } catch (err) {
      return createError(res, err.status || 400, err.message);
    }

    try {
      // RM Store (type 1) + Production (type 2) are shared; Product/Shop still scoped.
      await assertRmManagerStoreAccess(req, [fromLoc._id, toLoc._id]);
    } catch (err) {
      return createError(res, err.status || 403, err.message);
    }

    // Validate & snapshot prices for each line
    const normalized = [];
    for (let i = 0; i < lines.length; i++) {
      const row = lines[i] || {};
      const qty = Number(row.quantity);
      if (!row.raw_material_id || !row.raw_material_stock_id) {
        return createError(
          res,
          400,
          `Line ${i + 1}: raw_material_id and raw_material_stock_id are required.`,
        );
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        return createError(res, 400, `Line ${i + 1}: quantity must be > 0.`);
      }

      const [rm, stock] = await Promise.all([
        RawMaterial.findById(row.raw_material_id).where({ isDeleted: false }),
        RawMaterialStock.findById(row.raw_material_stock_id).where({
          isDeleted: false,
        }),
      ]);
      if (!rm) {
        return createError(res, 404, `Line ${i + 1}: raw material not found.`);
      }
      if (!stock) {
        return createError(res, 404, `Line ${i + 1}: stock batch not found.`);
      }
      if (Number(stock.purpose) !== 1) {
        return createError(
          res,
          400,
          `Line ${i + 1}: must use a purchase stock batch.`,
        );
      }
      if (String(stock.raw_material_id) !== String(rm._id)) {
        return createError(
          res,
          400,
          `Line ${i + 1}: stock batch does not match raw material.`,
        );
      }
      const remaining =
        stock.remaining_quantity != null
          ? Number(stock.remaining_quantity)
          : Number(stock.quantity || 0) - Number(stock.out_quantity || 0);
      if (qty > remaining) {
        return createError(
          res,
          409,
          `Line ${i + 1}: insufficient batch. Remaining ${remaining}, requested ${qty}.`,
        );
      }

      const unit_price = Number(stock.price || rm.price || 0);
      const line_value = Math.round(qty * unit_price * 100) / 100;
      normalized.push({
        raw_material_id: rm._id,
        raw_material_stock_id: stock._id,
        quantity: qty,
        unit_price,
        line_value,
      });
    }

    const rm_value_issued =
      Math.round(
        normalized.reduce((s, r) => s + Number(r.line_value || 0), 0) * 100,
      ) / 100;

    const planned = [];
    if (Array.isArray(planned_products)) {
      for (const row of planned_products) {
        const pq = Number(row.quantity);
        if (!row.product_id || !Number.isFinite(pq) || pq <= 0) continue;
        planned.push({ product_id: row.product_id, quantity: pq });
      }
    }

    const userId = getUserId(req);
    const job_code = generateJobCode();

    const created = await withTransaction(async (session) => {
      const opts = { session };
      const [job] = await UstadJob.create(
        [
          {
            job_code,
            ustad_name: ustadName,
            ustad_id: ustadDoc?._id ?? null,
            from_location_id: fromLoc._id,
            location_id: toLoc._id,
            issue_date: new Date(issue_date),
            status: JOB_STATUS.OPEN,
            notes: notes ?? "",
            planned_products: planned,
            lines: [],
            rm_value_issued,
            created_by: userId,
            isDeleted: false,
          },
        ],
        opts,
      );

      const savedLines = [];
      for (const row of normalized) {
        const [dispatch] = await RawMaterialDispatch.create(
          [
            {
              from_location_id: fromLoc._id,
              location_id: toLoc._id,
              location: toLoc.name,
              raw_material_id: row.raw_material_id,
              raw_material_stock_id: row.raw_material_stock_id,
              quantity: row.quantity,
              dispatch_date: new Date(issue_date),
              notes: `Ustad Job ${job_code} · ${ustadName}`,
              ustad_job_id: job._id,
              isDeleted: false,
            },
          ],
          opts,
        );

        await applyRawMaterialDispatchImpact({
          rawMaterialId: row.raw_material_id,
          quantity: row.quantity,
          fromLocationId: fromLoc._id,
          toLocationId: toLoc._id,
          storeId: fromLoc.store_id ?? toLoc.store_id ?? null,
          rawMaterialStockId: row.raw_material_stock_id,
          referenceId: dispatch._id,
          userId,
          notes: `Ustad Job ${job_code} → ${toLoc.name} · ${ustadName}`,
          session,
        });

        savedLines.push({
          ...row,
          dispatch_id: dispatch._id,
        });
      }

      job.lines = savedLines;
      await job.save(opts);

      await writeAudit({
        entityType: "UstadJob",
        entityId: job._id,
        action: "create",
        newValue: job.toObject?.() ?? job,
        userId,
        session,
      });

      return job;
    });

    const populated = await populateJob(UstadJob.findById(created._id));
    const summary = await buildSummary(populated);

    return successMessage(
      res,
      summary,
      `Ustad job ${job_code} created · RM Rs ${rm_value_issued.toLocaleString("en-IN")} issued.`,
    );
  } catch (err) {
    console.error("UstadJob create error:", err);
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to create ustad job.",
    );
  }
};

/**
 * PATCH /api/ustad-job/:id/close
 */
const close = async (req, res) => {
  try {
    const job = await UstadJob.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!job) return createError(res, 404, "Ustad job not found.");

    try {
      await assertRmManagerStoreAccess(req, [
        job.from_location_id,
        job.location_id,
      ]);
    } catch (err) {
      return createError(res, err.status || 403, err.message);
    }

    if (Number(job.status) === JOB_STATUS.CLOSED) {
      return createError(res, 409, "Job already closed.");
    }

    job.status = JOB_STATUS.CLOSED;
    job.closed_at = new Date();
    await job.save();

    const populated = await populateJob(UstadJob.findById(job._id));
    const summary = await buildSummary(populated);
    return successMessage(res, summary, "Ustad job closed.");
  } catch (err) {
    console.error("UstadJob close error:", err);
    return createError(res, 500, err.message || "Failed to close job.");
  }
};

/**
 * PATCH /api/ustad-job/:id/reopen
 */
const reopen = async (req, res) => {
  try {
    const job = await UstadJob.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!job) return createError(res, 404, "Ustad job not found.");

    try {
      await assertRmManagerStoreAccess(req, [
        job.from_location_id,
        job.location_id,
      ]);
    } catch (err) {
      return createError(res, err.status || 403, err.message);
    }

    job.status = JOB_STATUS.OPEN;
    job.closed_at = null;
    await job.save();

    const populated = await populateJob(UstadJob.findById(job._id));
    const summary = await buildSummary(populated);
    return successMessage(res, summary, "Ustad job reopened.");
  } catch (err) {
    console.error("UstadJob reopen error:", err);
    return createError(res, 500, err.message || "Failed to reopen job.");
  }
};

/**
 * DELETE /api/ustad-job/:id
 * Soft-delete + reverse RM dispatches.
 * Admin may cascade-delete linked productions (FG/RM restored) then delete job.
 * Non-admin still blocked when productions are linked.
 */
const remove = async (req, res) => {
  try {
    const job = await UstadJob.findById(req.params.id).where({
      isDeleted: false,
    });
    if (!job) return createError(res, 404, "Ustad job not found.");

    try {
      await assertRmManagerStoreAccess(req, [
        job.from_location_id,
        job.location_id,
      ]);
    } catch (err) {
      return createError(res, err.status || 403, err.message);
    }

    const linkedProductions = await CakeProduction.find({
      ustad_job_id: job._id,
      isDeleted: false,
    });
    const linked = linkedProductions.length;
    const isAdmin = Number(req.user?.role) === 1;

    if (linked > 0 && !isAdmin) {
      return createError(
        res,
        400,
        `Is job pe ${linked} production(s) linked hain. Pehle unhe delete/unlink karein. (Admin cascade delete kar sakta hai.)`,
      );
    }

    const userId = getUserId(req);
    // Lazy require avoids circular load with cake-production ↔ ustad-job
    const { reverseProductionImpact } = require("./cake-production.controller");

    await withTransaction(async (session) => {
      const opts = { session };

      // Admin cascade: reverse each linked production (Product Store + Product qty)
      for (const prod of linkedProductions) {
        await reverseProductionImpact(prod, userId, session);
        await CakeProduction.findByIdAndUpdate(
          prod._id,
          {
            isDeleted: true,
            product_stock_id: null,
            raw_materials_consumed: [],
            store_receipt_id: null,
          },
          { session },
        );
        await writeAudit({
          entityType: "CakeProduction",
          entityId: prod._id,
          action: "delete",
          previousValue: prod.toObject?.() ?? prod,
          userId,
          notes: `Cascade from UstadJob ${job.job_code || job._id}`,
          session,
        });
      }

      for (const line of job.lines || []) {
        if (!line.dispatch_id) continue;
        const dispatch = await RawMaterialDispatch.findById(line.dispatch_id)
          .where({ isDeleted: false })
          .session(session);
        if (!dispatch) continue;

        await reverseRawMaterialDispatchImpact(
          {
            rawMaterialId: dispatch.raw_material_id,
            quantity: dispatch.quantity,
            fromLocationId: dispatch.from_location_id,
            toLocationId: dispatch.location_id,
            generatedStockId: dispatch.generated_stock_id,
            rawMaterialStockId: dispatch.raw_material_stock_id,
            referenceId: dispatch._id,
          },
          userId,
          session,
        );
        dispatch.isDeleted = true;
        dispatch.generated_stock_id = null;
        await dispatch.save(opts);
      }

      job.isDeleted = true;
      await job.save(opts);

      await writeAudit({
        entityType: "UstadJob",
        entityId: job._id,
        action: "delete",
        previousValue: job.toObject?.() ?? job,
        userId,
        notes:
          linked > 0
            ? `Admin cascade: ${linked} production(s) reversed + RM restored`
            : "RM dispatches reversed",
        session,
      });
    });

    return successMessage(
      res,
      { _id: job._id, productions_reversed: linked },
      linked > 0
        ? `Ustad job deleted — ${linked} production(s) + RM stock restored.`
        : "Ustad job deleted — RM stock restored.",
    );
  } catch (err) {
    console.error("UstadJob remove error:", err);
    return createError(
      res,
      err.status || 500,
      err.message || "Failed to delete ustad job.",
    );
  }
};

module.exports = {
  list,
  listOpen,
  getOne,
  create,
  close,
  reopen,
  remove,
  JOB_STATUS,
  generateJobCode,
};
