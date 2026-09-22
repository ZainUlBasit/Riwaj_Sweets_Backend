const mongoose = require("mongoose");
const Supplier = require("../Models/Supplier");
const SupplierPayment = require("../Models/SupplierPayment");
const SupplierReturn = require("../Models/SupplierReturn");
const RawMaterialStock = require("../Models/RawMaterialStock");
const ProductStock = require("../Models/ProductStock");
const { createError, successMessage } = require("../utils/ResponseMessage");

const PAYMENT_TYPE_LABEL = { 1: "Cash", 2: "Bank" };

const getSupplierOr404 = async (id) =>
  Supplier.findById(id).where({ isDeleted: false });

/**
 * POST /api/supplier/:id/payments
 * Record a payment to the supplier and update paid / payable.
 */
const createPayment = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const supplierId = req.params.id;
    const { amount, payment_date, payment_type, notes } = req.body || {};
    const amt = Number(amount);

    if (!Number.isFinite(amt) || amt <= 0) {
      await session.abortTransaction();
      return createError(res, 400, "Payment amount must be greater than 0.");
    }

    const supplier = await getSupplierOr404(supplierId).session(session);
    if (!supplier) {
      await session.abortTransaction();
      return createError(res, 404, "Supplier not found.");
    }

    const typeNum = Number(payment_type ?? 1);
    if (typeNum !== 1 && typeNum !== 2) {
      await session.abortTransaction();
      return createError(res, 400, "payment_type must be 1 (Cash) or 2 (Bank).");
    }

    const paymentDate = payment_date ? new Date(payment_date) : new Date();
    if (Number.isNaN(paymentDate.getTime())) {
      await session.abortTransaction();
      return createError(res, 400, "Invalid payment_date.");
    }

    const [payment] = await SupplierPayment.create(
      [
        {
          supplier_id: supplier._id,
          amount: amt,
          payment_date: paymentDate,
          payment_type: typeNum,
          notes: (notes || "").trim(),
          isDeleted: false,
        },
      ],
      { session },
    );

    const updated = await Supplier.findByIdAndUpdate(
      supplier._id,
      { $inc: { paid: amt, payable: -amt } },
      { new: true, session },
    );

    await session.commitTransaction();
    return successMessage(
      res,
      { payment, supplier: updated },
      "Payment recorded.",
    );
  } catch (err) {
    await session.abortTransaction();
    console.error("Supplier createPayment error:", err);
    return createError(res, 500, err.message || "Failed to record payment.");
  } finally {
    session.endSession();
  }
};

/**
 * POST /api/supplier/:id/returns
 * Purchase return — decreases payable + total_amount (debit).
 */
const createReturn = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const supplierId = req.params.id;
    const { amount, return_date, notes, reference } = req.body || {};
    const amt = Number(amount);

    if (!Number.isFinite(amt) || amt <= 0) {
      await session.abortTransaction();
      return createError(res, 400, "Return amount must be greater than 0.");
    }

    const supplier = await getSupplierOr404(supplierId).session(session);
    if (!supplier) {
      await session.abortTransaction();
      return createError(res, 404, "Supplier not found.");
    }

    const returnDate = return_date ? new Date(return_date) : new Date();
    if (Number.isNaN(returnDate.getTime())) {
      await session.abortTransaction();
      return createError(res, 400, "Invalid return_date.");
    }

    const [ret] = await SupplierReturn.create(
      [
        {
          supplier_id: supplier._id,
          amount: amt,
          return_date: returnDate,
          reference: (reference || "").trim(),
          notes: (notes || "").trim(),
          isDeleted: false,
        },
      ],
      { session },
    );

    const updated = await Supplier.findByIdAndUpdate(
      supplier._id,
      { $inc: { payable: -amt, total_amount: -amt } },
      { new: true, session },
    );

    await session.commitTransaction();
    return successMessage(
      res,
      { return: ret, supplier: updated },
      "Purchase return recorded.",
    );
  } catch (err) {
    await session.abortTransaction();
    console.error("Supplier createReturn error:", err);
    return createError(res, 500, err.message || "Failed to record return.");
  } finally {
    session.endSession();
  }
};

/**
 * GET /api/supplier/:id/payments
 */
const listPayments = async (req, res) => {
  try {
    const supplier = await getSupplierOr404(req.params.id);
    if (!supplier) {
      return createError(res, 404, "Supplier not found.");
    }

    const items = await SupplierPayment.find({
      supplier_id: supplier._id,
      isDeleted: false,
    }).sort({ payment_date: -1, createdAt: -1 });

    return successMessage(
      res,
      { supplier, items },
      "Payments fetched successfully.",
    );
  } catch (err) {
    console.error("Supplier listPayments error:", err);
    return createError(res, 500, err.message || "Failed to fetch payments.");
  }
};

/**
 * DELETE /api/supplier/payments/:paymentId
 * Soft-delete payment and reverse paid / payable.
 */
const removePayment = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const payment = await SupplierPayment.findOne({
      _id: req.params.paymentId,
      isDeleted: false,
    }).session(session);

    if (!payment) {
      await session.abortTransaction();
      return createError(res, 404, "Payment not found.");
    }

    payment.isDeleted = true;
    await payment.save({ session });

    const updated = await Supplier.findByIdAndUpdate(
      payment.supplier_id,
      { $inc: { paid: -payment.amount, payable: payment.amount } },
      { new: true, session },
    );

    await session.commitTransaction();
    return successMessage(
      res,
      { payment, supplier: updated },
      "Payment deleted.",
    );
  } catch (err) {
    await session.abortTransaction();
    console.error("Supplier removePayment error:", err);
    return createError(res, 500, err.message || "Failed to delete payment.");
  } finally {
    session.endSession();
  }
};

/**
 * GET /api/supplier/:id/ledger
 * Chronological ledger: purchases + payments + returns.
 */
const ledger = async (req, res) => {
  try {
    const supplier = await getSupplierOr404(req.params.id);
    if (!supplier) {
      return createError(res, 404, "Supplier not found.");
    }

    const supplierId = supplier._id;

    const [rmPurchases, productPurchases, payments, returns] = await Promise.all([
      RawMaterialStock.find({
        supplier_id: supplierId,
        isDeleted: false,
        purpose: 1,
      })
        .populate("raw_material_id", "name")
        .select("desc total_price quantity price createdAt raw_material_id")
        .lean(),
      ProductStock.find({
        supplier_id: supplierId,
        isDeleted: false,
        source: 2,
      })
        .populate("product_id", "name")
        .select("desc total_price quantity price createdAt product_id")
        .lean(),
      SupplierPayment.find({
        supplier_id: supplierId,
        isDeleted: false,
      })
        .select("amount payment_date payment_type notes createdAt")
        .lean(),
      SupplierReturn.find({
        supplier_id: supplierId,
        isDeleted: false,
      })
        .select("amount return_date reference notes createdAt")
        .lean(),
    ]);

    const entries = [];

    for (const row of rmPurchases) {
      const amt = Number(row.total_price || 0);
      if (amt <= 0) continue;
      const rmName = row.raw_material_id?.name || "RM";
      entries.push({
        id: `rm-${row._id}`,
        date: row.createdAt,
        type: "purchase",
        kind: "raw_material",
        title: `RM purchase — ${rmName}`,
        description: row.desc || "",
        debit: amt,
        credit: 0,
        ref_id: row._id,
      });
    }

    for (const row of productPurchases) {
      const amt = Number(row.total_price || 0);
      if (amt <= 0) continue;
      const pName = row.product_id?.name || "Product";
      entries.push({
        id: `ps-${row._id}`,
        date: row.createdAt,
        type: "purchase",
        kind: "product",
        title: `Product purchase — ${pName}`,
        description: row.desc || "",
        debit: amt,
        credit: 0,
        ref_id: row._id,
      });
    }

    for (const row of payments) {
      const amt = Number(row.amount || 0);
      if (amt <= 0) continue;
      const typeLabel = PAYMENT_TYPE_LABEL[row.payment_type] || "Payment";
      entries.push({
        id: `pay-${row._id}`,
        date: row.payment_date || row.createdAt,
        type: "payment",
        kind: "payment",
        title: `Payment (${typeLabel})`,
        description: row.notes || "",
        debit: 0,
        credit: amt,
        ref_id: row._id,
        payment_type: row.payment_type,
      });
    }

    for (const row of returns) {
      const amt = Number(row.amount || 0);
      if (amt <= 0) continue;
      entries.push({
        id: `ret-${row._id}`,
        date: row.return_date || row.createdAt,
        type: "return",
        kind: "return",
        title: "Purchase Return",
        description: row.notes || "",
        reference: row.reference || "",
        debit: 0,
        credit: amt,
        ref_id: row._id,
      });
    }

    entries.sort((a, b) => {
      const ta = new Date(a.date).getTime();
      const tb = new Date(b.date).getTime();
      if (ta !== tb) return ta - tb;
      return String(a.id).localeCompare(String(b.id));
    });

    let running = 0;
    const items = entries.map((e) => {
      running += Number(e.debit || 0) - Number(e.credit || 0);
      return {
        ...e,
        balance: Math.round(running * 100) / 100,
      };
    });

    return successMessage(
      res,
      {
        supplier,
        items,
        summary: {
          total_amount: Number(supplier.total_amount || 0),
          paid: Number(supplier.paid || 0),
          payable: Number(supplier.payable || 0),
          ledger_balance: Math.round(running * 100) / 100,
        },
      },
      "Supplier ledger fetched.",
    );
  } catch (err) {
    console.error("Supplier ledger error:", err);
    return createError(res, 500, err.message || "Failed to fetch ledger.");
  }
};

module.exports = {
  createPayment,
  createReturn,
  listPayments,
  removePayment,
  ledger,
};
