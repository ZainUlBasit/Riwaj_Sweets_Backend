const mongoose = require("mongoose");
const AutoIncrement = require("mongoose-sequence")(mongoose);
const {
  requiredString,
  NumberWithDefault,
  requiredNumberWithDefault,
  requiredBooleanWithDefaultFalse,
} = require("../utils/Types");

const Schema = mongoose.Schema;

// BOM entry: raw material + quantity required per unit of finished product
const BomEntrySchema = new Schema(
  {
    rawMaterialId: {
      type: Schema.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
    },
    quantity_required_per_unit: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
  },
  { _id: false },
);

const PRODUCT_ID_SEQUENCE = "product_id_seq";

/** Default Riwaj Sweets menu — seeded via Product.seedDefaults() or scripts/seed-products.js */
const PRODUCT_SEED_DATA = [
  { id: 1, name: "Sp Mix Biscuits", price: 1200, unit: 1, category: "Sweets" },
  { id: 2, name: "Biscuits", price: 800, unit: 1, category: "Sweets" },
  { id: 3, name: "Coconut Biscuits", price: 1000, unit: 1, category: "Sweets" },
  { id: 4, name: "Sada Biscuits", price: 500, unit: 1, category: "Sweets" },
  { id: 5, name: "Specail Mix Sweets", price: 1200, unit: 1, category: "Sweets" },
  { id: 6, name: "Mix Sweets", price: 900, unit: 1, category: "Sweets" },
  { id: 7, name: "Sp Rasgullay + Jaman", price: 900, unit: 1, category: "Sweets" },
  { id: 8, name: "Sada Rasgullay + Jaman", price: 700, unit: 1, category: "Sweets" },
  { id: 9, name: "Pairay", price: 1000, unit: 1, category: "Sweets" },
  { id: 10, name: "Special Barfi", price: 1000, unit: 1, category: "Sweets" },
  { id: 11, name: "Plain Barfi", price: 900, unit: 1, category: "Sweets" },
  { id: 12, name: "Special Halwajaat", price: 1200, unit: 1, category: "Sweets" },
  { id: 13, name: "Sada Mix Sweets", price: 600, unit: 1, category: "Sweets" },
  { id: 14, name: "Milki Ladoo", price: 1400, unit: 1, category: "Sweets" },
  { id: 15, name: "Cake Pcs", price: 900, unit: 3, category: "Bakery" },
  { id: 16, name: "Chorii", price: 700, unit: 1, category: "Sweets" },
  { id: 17, name: "Shugar Free Biscuits", price: 800, unit: 1, category: "Sweets" },
  { id: 18, name: "Cake Rusk", price: 1000, unit: 1, category: "Sweets" },
  { id: 19, name: "Sugar Puff", price: 600, unit: 1, category: "Sweets" },
  { id: 20, name: "Rijar Methai", price: 480, unit: 1, category: "Sweets" },
  { id: 21, name: "Sawati Methai", price: 480, unit: 1, category: "Sweets" },
  { id: 22, name: "Gur wala Methai", price: 480, unit: 1, category: "Sweets" },
  { id: 23, name: "Namak Paray", price: 450, unit: 1, category: "Sweets" },
  { id: 24, name: "Phaniyn", price: 600, unit: 1, category: "Sweets" },
  { id: 25, name: "Fresh Cream Cake 1P", price: 600, unit: 3, category: "Bakery" },
  { id: 26, name: "Fresh Cream Cake 2P", price: 1200, unit: 3, category: "Bakery" },
  { id: 27, name: "Chocolate Cake 1P", price: 700, unit: 3, category: "Bakery" },
  { id: 28, name: "Chocolate Cake 2P", price: 1400, unit: 3, category: "Bakery" },
  { id: 29, name: "Dry Cake 1P", price: 600, unit: 3, category: "Bakery" },
  { id: 30, name: "Dry Cake 2P", price: 1200, unit: 3, category: "Bakery" },
  { id: 31, name: "Pastry Large", price: 150, unit: 3, category: "Bakery" },
  { id: 32, name: "Pastry Small", price: 100, unit: 3, category: "Bakery" },
  { id: 33, name: "Cup Cake", price: 150, unit: 3, category: "Bakery" },
  { id: 34, name: "Cream Roll", price: 50, unit: 3, category: "Bakery" },
  { id: 35, name: "Donut", price: 50, unit: 3, category: "Bakery" },
  { id: 36, name: "Special Donut", price: 100, unit: 3, category: "Bakery" },
  { id: 37, name: "Oder Cake", price: 1, unit: 3, category: "Bakery" },
  { id: 38, name: "Plain Sandwich", price: 100, unit: 3, category: "Bakery" },
  { id: 39, name: "Fry Sandwich", price: 100, unit: 3, category: "Bakery" },
  { id: 40, name: "Tikka Sandwich", price: 200, unit: 3, category: "Bakery" },
  { id: 41, name: "Olive Sandwich", price: 200, unit: 3, category: "Bakery" },
  { id: 42, name: "Chicken Roll", price: 100, unit: 3, category: "Bakery" },
  { id: 43, name: "Chicken Pie", price: 100, unit: 3, category: "Bakery" },
  { id: 44, name: "Shami Kabab", price: 600, unit: 1, category: "Sweets" },
  { id: 45, name: "Goll Fry", price: 200, unit: 3, category: "Bakery" },
  { id: 46, name: "Chicken Patties", price: 80, unit: 3, category: "Bakery" },
  { id: 47, name: "Tikka Fry", price: 250, unit: 3, category: "Bakery" },
  { id: 48, name: "Tikka Buger", price: 200, unit: 3, category: "Bakery" },
  { id: 49, name: "Zinger Burger", price: 300, unit: 3, category: "Bakery" },
  { id: 50, name: "Pizza Slice", price: 150, unit: 3, category: "Bakery" },
  { id: 51, name: "Chicken Pastry", price: 300, unit: 3, category: "Bakery" },
  { id: 52, name: "Party Pizza", price: 100, unit: 3, category: "Bakery" },
  { id: 53, name: "Spring Roll", price: 100, unit: 3, category: "Bakery" },
  { id: 54, name: "Full Chicken Broast", price: 1200, unit: 3, category: "Bakery" },
  { id: 55, name: "Chicken Shawarma", price: 100, unit: 3, category: "Bakery" },
  { id: 56, name: "Egg Pizza", price: 100, unit: 3, category: "Bakery" },
  { id: 57, name: "Egg Sandwich small", price: 70, unit: 3, category: "Bakery" },
  { id: 58, name: "Egg Sandwich Large", price: 150, unit: 3, category: "Bakery" },
  { id: 59, name: "Chicken Pakora", price: 1200, unit: 1, category: "Sweets" },
  { id: 60, name: "Fresh Pizza Small", price: 900, unit: 3, category: "Bakery" },
  { id: 61, name: "Fresh Pizza Medium", price: 1500, unit: 3, category: "Bakery" },
  { id: 62, name: "Fresh Pizza Large", price: 1800, unit: 3, category: "Bakery" },
  { id: 63, name: "Fersh Pizza X-Large", price: 2500, unit: 3, category: "Bakery" },
  { id: 64, name: "Vegetable Cake", price: 500, unit: 3, category: "Bakery" },
  { id: 65, name: "PLain Cake Small", price: 100, unit: 3, category: "Bakery" },
  { id: 66, name: "Plain Cake Large", price: 200, unit: 3, category: "Bakery" },
  { id: 67, name: "Fruit Cake Small", price: 100, unit: 3, category: "Bakery" },
  { id: 68, name: "Fruit Cake Large", price: 200, unit: 3, category: "Bakery" },
  { id: 69, name: "Chicken Shawarma Large", price: 150, unit: 3, category: "Bakery" },
  { id: 70, name: "Salad", price: 1200, unit: 1, category: "Sweets" },
  { id: 71, name: "Khajoor", price: 10, unit: 3, category: "Bakery" },
  { id: 72, name: "Jalabi", price: 150, unit: 1, category: "Sweets" },
  { id: 73, name: "Amrasy", price: 0, unit: 1, category: "Sweets" },
];

const getSeedStock = (row) => {
  if (row.stock != null) return row.stock;
  const base = row.unit === 3 ? 50 : 25;
  return base + (row.id % 10);
};

const assignNextProductId = async () => {
  const counterCollection = mongoose.connection.collection("counters");
  const filter = { id: PRODUCT_ID_SEQUENCE, reference_value: null };
  const startSeq = 1;

  const existing = await counterCollection.findOne(filter);
  if (!existing) {
    await counterCollection.insertOne({
      id: PRODUCT_ID_SEQUENCE,
      reference_value: null,
      seq: startSeq,
    });
    return startSeq;
  }

  const updated = await counterCollection.findOneAndUpdate(
    filter,
    { $inc: { seq: 1 } },
    { returnDocument: "after" },
  );
  return updated?.seq ?? startSeq;
};

const ProductSchema = new Schema(
  {
    // Human-friendly product code used in barcodes (auto-assigned or set on import).
    id: { type: Number, required: true },
    name: requiredString,
    // Cloudinary `secure_url` of the product image. Optional — products can
    // exist without artwork (e.g. legacy items or quick raw entries).
    image: { type: String, default: null },
    category_id: {
      type: mongoose.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    unit: {
      type: Number,
      enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      required: true,
    }, // 1:kg, 2:bag, 3:piece, 4:liter, 5:ounce, 6:pound, 7:gallon, 8:quart, 9:pint, 10:cup
    price: NumberWithDefault,
    in_quantity: requiredNumberWithDefault,
    out_quantity: requiredNumberWithDefault,
    available_quantity: requiredNumberWithDefault,
    counter_id: {
      type: mongoose.Types.ObjectId,
      ref: "Counter",
      required: false,
    },
    /** Bill of materials — raw material qty required per 1 unit of finished product. */
    bom: {
      type: [BomEntrySchema],
      default: [],
    },
    isDeleted: requiredBooleanWithDefaultFalse,
  },
  {
    timestamps: true,
  },
);

ProductSchema.index({ id: 1 }, { unique: true });

ProductSchema.pre("validate", async function () {
  if (!this.isNew || this.id != null) return;
  this.id = await assignNextProductId();
});

ProductSchema.plugin(AutoIncrement, {
  id: PRODUCT_ID_SEQUENCE,
  inc_field: "id",
  start_seq: 1,
  disable_hooks: true,
});

ProductSchema.statics.seedDefaults = async function ({ skipExisting = true } = {}) {
  const Category = require("./Category");
  const categoryCache = new Map();

  const getCategoryId = async (name) => {
    const key = name.toLowerCase();
    if (categoryCache.has(key)) return categoryCache.get(key);

    let category = await Category.findOne({ name, isDeleted: false });
    if (!category) {
      category = await Category.create({ name, isDeleted: false });
    }
    categoryCache.set(key, category._id);
    return category._id;
  };

  const results = { created: 0, skipped: 0, errors: [] };

  for (const row of PRODUCT_SEED_DATA) {
    try {
      if (skipExisting) {
        const existing = await this.findOne({ id: row.id });
        if (existing) {
          results.skipped += 1;
          continue;
        }
      }

      const category_id = await getCategoryId(row.category);
      const stock = getSeedStock(row);
      await this.create({
        id: row.id,
        name: row.name,
        price: row.price,
        unit: row.unit,
        category_id,
        in_quantity: stock,
        out_quantity: 0,
        available_quantity: stock,
        isDeleted: false,
      });
      results.created += 1;
    } catch (err) {
      results.errors.push({
        id: row.id,
        name: row.name,
        message: err.message || "Failed to seed product.",
      });
    }
  }

  const maxId = Math.max(...PRODUCT_SEED_DATA.map((row) => row.id));
  const counterCollection = mongoose.connection.collection("counters");
  await counterCollection.updateOne(
    { id: PRODUCT_ID_SEQUENCE, reference_value: null },
    { $max: { seq: maxId } },
    { upsert: true },
  );

  return results;
};

ProductSchema.statics.applyDummyStock = async function ({ onlySeeded = true } = {}) {
  const seedById = new Map(PRODUCT_SEED_DATA.map((row) => [row.id, row]));
  const filter = onlySeeded
    ? { id: { $in: PRODUCT_SEED_DATA.map((row) => row.id) }, isDeleted: false }
    : { isDeleted: false };

  const products = await this.find(filter);
  const results = { updated: 0, skipped: 0 };

  for (const product of products) {
    const row = seedById.get(product.id);
    const stock = row ? getSeedStock(row) : product.unit === 3 ? 50 : 25;

    if (
      Number(product.available_quantity) > 0 ||
      Number(product.in_quantity) > 0
    ) {
      results.skipped += 1;
      continue;
    }

    product.in_quantity = stock;
    product.out_quantity = 0;
    product.available_quantity = stock;
    await product.save();
    results.updated += 1;
  }

  return results;
};

const Product = mongoose.model("Product", ProductSchema);

module.exports = Product;
module.exports.PRODUCT_SEED_DATA = PRODUCT_SEED_DATA;
