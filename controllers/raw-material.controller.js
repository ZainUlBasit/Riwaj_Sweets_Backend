const RawMaterial = require("../Models/RawMaterial");
const { createError, successMessage } = require("../utils/ResponseMessage");
const {
  TX,
  DIR,
  getUserId,
  writeAudit,
  writeLedger,
  withTransaction,
} = require("../Services/inventoryService");

const list = async (req, res) => {
  try {
    const items = await RawMaterial.find({ isDeleted: false })
      .populate("supplier_id")
      .sort({ createdAt: -1 });
    const deletedItems = await RawMaterial.find({ isDeleted: true })
      .populate("supplier_id")
      .sort({ createdAt: -1 });
    return successMessage(
      res,
      { items, deletedItems },
      "Raw materials fetched successfully."
    );
  } catch (err) {
    console.error("RawMaterial list error:", err);
    return createError(res, 500, err.message || "Failed to fetch raw materials.");
  }
};

const getOne = async (req, res) => {
  try {
    const item = await RawMaterial.findById(req.params.id)
      .populate("supplier_id")
      .where({ isDeleted: false });
    if (!item) return createError(res, 404, "Raw material not found.");
    return successMessage(res, item, "Raw material fetched successfully.");
  } catch (err) {
    console.error("RawMaterial getOne error:", err);
    return createError(res, 500, err.message || "Failed to fetch raw material.");
  }
};

const create = async (req, res) => {
  try {
    const { name, supplier_id, price, unit, opening_quantity } = req.body;
    if (!name || !supplier_id || unit == null) {
      return createError(res, 400, "Name, supplier_id and unit are required.");
    }
    const openingQty = Number(opening_quantity ?? 0);
    if (!Number.isFinite(openingQty) || openingQty < 0) {
      return createError(
        res,
        400,
        "opening_quantity must be a non-negative number.",
      );
    }

    const userId = getUserId(req);
    const item = await withTransaction(async (session) => {
      const [created] = await RawMaterial.create(
        [
          {
            name,
            supplier_id,
            price: price ?? 0,
            unit,
            opening_quantity: openingQty,
            in_quantity: openingQty,
            out_quantity: 0,
            available_quantity: openingQty,
            isDeleted: false,
          },
        ],
        { session },
      );

      if (openingQty > 0) {
        await writeLedger(
          {
            transactionType: TX.ADJUSTMENT,
            direction: DIR.IN,
            rawMaterialId: created._id,
            quantity: openingQty,
            referenceType: "RawMaterial",
            referenceId: created._id,
            userId,
            notes: "Opening quantity",
            previousBalance: 0,
            newBalance: openingQty,
          },
          session,
        );
      }

      await writeAudit({
        entityType: "RawMaterial",
        entityId: created._id,
        action: "create",
        newValue: created.toObject(),
        userId,
        notes: `Raw material created with opening quantity ${openingQty}.`,
        session,
      });

      return created;
    });

    return successMessage(res, item, "Raw material created successfully.");
  } catch (err) {
    console.error("RawMaterial create error:", err);
    return createError(res, 500, err.message || "Failed to create raw material.");
  }
};

const update = async (req, res) => {
  try {
    const { name, supplier_id, price, unit } = req.body;
    const item = await RawMaterial.findByIdAndUpdate(
      req.params.id,
      {
        name,
        supplier_id,
        price,
        unit,
        isDeleted: false,
      },
      { new: true, runValidators: true }
    );
    if (!item) return createError(res, 404, "Raw material not found.");
    return successMessage(res, item, "Raw material updated successfully.");
  } catch (err) {
    console.error("RawMaterial update error:", err);
    return createError(res, 500, err.message || "Failed to update raw material.");
  }
};

const remove = async (req, res) => {
  try {
    const item = await RawMaterial.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { isDeleted: true },
      { new: true }
    );
    if (!item) return createError(res, 404, "Raw material not found.");
    return successMessage(res, item, "Raw material deleted successfully.");
  } catch (err) {
    console.error("RawMaterial remove error:", err);
    return createError(res, 500, err.message || "Failed to delete raw material.");
  }
};

module.exports = { list, getOne, create, update, remove };
