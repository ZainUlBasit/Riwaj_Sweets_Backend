const mongoose = require("mongoose");
const CakeProduction = require("../Models/CakeProduction");
const RawMaterialStock = require("../Models/RawMaterialStock");
const RawMaterialDispatch = require("../Models/RawMaterialDispatch");
const InventoryLedger = require("../Models/InventoryLedger");
const { createError, successMessage } = require("../utils/ResponseMessage");

/**
 * GET /api/production-dashboard/summary
 *
 * Optional query params (all dates are ISO-parseable):
 *   start_date  — lower bound for cake production_date / dispatch_date
 *   end_date    — upper bound (inclusive) for the same
 *
 * Response payload shape:
 *   {
 *     dailyCakeProduction:   [{ date: "YYYY-MM-DD", totalCakes: number }],
 *     rawMaterialDispatch:   [{ location, rawMaterialName, totalQuantity }],
 *     locationProductionOutput: [{ location, productName, totalQuantity }],
 *     totalRawMaterialInput: number,    // sum of qty in stock entries with purpose=2
 *     totalCakeOutput:       number,    // sum of cakes_produced
 *     efficiency:            string,    // "x.xx" ratio (output / input), or "N/A"
 *     range:                 { start_date, end_date } | null
 *   }
 *
 * Soft-deleted records are excluded.
 */
const getSummary = async (req, res) => {
  try {
    const { start_date, end_date } = req.query || {};

    const range = {};
    if (start_date) range.$gte = new Date(start_date);
    if (end_date) range.$lte = new Date(end_date);
    const hasRange = Object.keys(range).length > 0;

    const productionDateFilter = hasRange ? { production_date: range } : {};
    const dispatchDateFilter = hasRange ? { dispatch_date: range } : {};
    // Stock entries are filtered by `createdAt` since they don't carry a
    // domain-level "production date" of their own.
    const stockDateFilter = hasRange ? { createdAt: range } : {};

    // ---- 1. Daily cake production ----------------------------------------
    const dailyCakeProductionRaw = await CakeProduction.aggregate([
      { $match: { isDeleted: false, ...productionDateFilter } },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$production_date" },
          },
          totalCakes: { $sum: "$cakes_produced" },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: "$_id", totalCakes: 1 } },
    ]);

    // ---- 1b. Production output by location + product ----------------------
    const locationProductionOutputRaw = await CakeProduction.aggregate([
      { $match: { isDeleted: false, ...productionDateFilter } },
      {
        $group: {
          _id: {
            location_id: "$location_id",
            location: "$location",
            product_id: "$product_id",
          },
          totalQuantity: { $sum: "$cakes_produced" },
        },
      },
      {
        $lookup: {
          from: "dispatchlocations",
          localField: "_id.location_id",
          foreignField: "_id",
          as: "production_location",
        },
      },
      {
        $unwind: {
          path: "$production_location",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: "products",
          localField: "_id.product_id",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          location: {
            $ifNull: [
              "$production_location.name",
              { $ifNull: ["$_id.location", "Unassigned"] },
            ],
          },
          locationId: "$_id.location_id",
          productName: { $ifNull: ["$product.name", "Unknown"] },
          totalQuantity: 1,
        },
      },
      { $sort: { location: 1, productName: 1 } },
    ]);

    // ---- 2. Raw material dispatch by location + raw material -------------
    const rawMaterialDispatchRaw = await RawMaterialDispatch.aggregate([
      { $match: { isDeleted: false, ...dispatchDateFilter } },
      {
        $group: {
          _id: {
            location_id: "$location_id",
            location: "$location",
            raw_material_id: "$raw_material_id",
          },
          totalQuantity: { $sum: "$quantity" },
        },
      },
      {
        $lookup: {
          from: "dispatchlocations",
          localField: "_id.location_id",
          foreignField: "_id",
          as: "dispatch_location",
        },
      },
      {
        $unwind: {
          path: "$dispatch_location",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: "rawmaterials",
          localField: "_id.raw_material_id",
          foreignField: "_id",
          as: "raw_material",
        },
      },
      { $unwind: { path: "$raw_material", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          location: { $ifNull: ["$dispatch_location.name", "$_id.location"] },
          locationId: "$_id.location_id",
          rawMaterialName: { $ifNull: ["$raw_material.name", "Unknown"] },
          totalQuantity: 1,
        },
      },
      { $sort: { location: 1, rawMaterialName: 1 } },
    ]);

    // ---- 3. Total raw material input (production-purpose stock) ----------
    const inputAgg = await RawMaterialStock.aggregate([
      { $match: { isDeleted: false, purpose: 2, ...stockDateFilter } },
      {
        $group: {
          _id: null,
          totalQuantity: { $sum: "$quantity" },
        },
      },
    ]);
    const totalRawMaterialInput = Number(inputAgg?.[0]?.totalQuantity || 0);

    // ---- 4. Total cake output --------------------------------------------
    const outputAgg = await CakeProduction.aggregate([
      { $match: { isDeleted: false, ...productionDateFilter } },
      { $group: { _id: null, totalCakes: { $sum: "$cakes_produced" } } },
    ]);
    const totalCakeOutput = Number(outputAgg?.[0]?.totalCakes || 0);

    // ---- 5. Efficiency note (units may differ — cakes vs kg/litre) ------
    let efficiency = "N/A";
    let efficiencyNote =
      "Compares total cakes produced vs total raw material units consumed (mixed units).";
    if (totalRawMaterialInput > 0 && totalCakeOutput > 0) {
      const ratio = totalCakeOutput / totalRawMaterialInput;
      efficiency = Number.isFinite(ratio) ? ratio.toFixed(2) : "N/A";
    }

    // Consumption from ledger (more accurate than purpose=2 stock alone)
    const consumptionAgg = await InventoryLedger.aggregate([
      {
        $match: {
          isDeleted: false,
          transaction_type: 2,
          ...(hasRange ? { createdAt: range } : {}),
        },
      },
      { $group: { _id: null, total: { $sum: "$quantity" } } },
    ]);
    const totalRawMaterialConsumed = Number(consumptionAgg?.[0]?.total || 0);

    return successMessage(
      res,
      {
        dailyCakeProduction: dailyCakeProductionRaw,
        rawMaterialDispatch: rawMaterialDispatchRaw,
        locationProductionOutput: locationProductionOutputRaw,
        totalRawMaterialInput,
        totalRawMaterialConsumed,
        totalCakeOutput,
        efficiency,
        efficiencyNote,
        range: hasRange
          ? {
              start_date: start_date ?? null,
              end_date: end_date ?? null,
            }
          : null,
      },
      "Production dashboard summary fetched successfully.",
    );
  } catch (err) {
    console.error("ProductionDashboard summary error:", err);
    return createError(
      res,
      500,
      err.message || "Failed to build production summary.",
    );
  }
};

// Touch mongoose so the import is meaningful and works in serverless cold
// starts where models may be pre-registered through this module.
void mongoose;

module.exports = { getSummary };
