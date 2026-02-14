const mongoose = require("mongoose");

const requiredString = {
  type: String,
  required: true,
};

const labourRef = {
  type: mongoose.Types.ObjectId,
  ref: "Labour",
};
const requiredDateTimeStamp = {
  type: Number,
  required: true,
};
const requiredNumber = {
  type: Number,
  required: true,
};

const requiredStringOptional = {
  type: String,
};
const requiredNumberOptional = {
  type: Number,
};

const optionalNumber = {
  type: Number,
  required: false,
  default: null,
};

const requiredDate = {
  type: Date,
  required: true,
};

const requiredNumberWithDefault = {
  type: Number,
  required: true,
  default: 0,
};

const NumberWithDefault = {
  type: Number,
  default: 0,
};

const InvoiceTypeEnum = {
  type: Number,
  enum: [1, 2], // 1: Whole Sale 2: Counter Sale
  required: true,
};

const customerTypeEnum = {
  type: Number,
  enum: [1, 2], // 1: Guest 2: Customer
  required: true,
};

const accountTypeEnumNotRequired = {
  type: Number,
  enum: [1, 2], // 1: Cash 2: Bank
};

const accountTypeEnum = {
  type: Number,
  enum: [1, 2], // 1: Cash 2: Bank
  required: true,
};

const userTypeEnum = {
  type: Number,
  enum: [1, 2], // 1: Customer 2: Vendor
  required: true,
};

const nonProductTypeEnum = {
  type: Number,
  enum: [1, 2], // 1: Credit 2: Debit
  required: true,
};

const paymentTypeEnum = {
  type: Number,
  enum: [1, 2], // 1: Cash 2: Bank
  required: true,
};

const requiredBooleanWithDefaultFalse = {
  type: Boolean,
  required: true,
  default: false,
};

const requiredBooleanWithDefaultTrue = {
  type: Boolean,
  required: true,
  default: true,
};

const expenseTypeEnum = {
  type: Number,
  enum: [1, 2, 3, 4], // 1: Rent 2: Kitchen 3:Salary 4:Other
  required: true,
};
const payerTypeEnum = {
  type: Number,
  enum: [1, 2],
  required: true,
}; // 1: Company 2: Customer

const saleTypeEnum = {
  type: Number,
  enum: [1, 2],
  required: true,
}; // 1: Sale 2: Return

const CustomerInvoiceItemRef = {
  type: mongoose.Types.ObjectId,
  ref: "CustomerInvoiceItem",
};

const CustomerReturnItemRef = {
  type: mongoose.Types.ObjectId,
  ref: "CustomerReturnItem",
};

const VendorRef = {
  type: mongoose.Types.ObjectId,
  ref: "Vendor",
};

const EmployeeRef = {
  type: mongoose.Types.ObjectId,
  ref: "Employee",
};
const LabourTypeRef = {
  type: mongoose.Types.ObjectId,
  ref: "LabourType",
};

const ExpenseTypeRef = {
  type: mongoose.Types.ObjectId,
  ref: "ExpenseType",
};

const BrandRef = {
  type: mongoose.Types.ObjectId,
  ref: "Brand",
};

const StockRef = {
  type: mongoose.Types.ObjectId,
  ref: "Stock",
};

const customerRef = {
  type: mongoose.Types.ObjectId,
  ref: "Customer",
};

const itemRef = {
  type: mongoose.Types.ObjectId,
  ref: "Item",
};

const accountRef = {
  type: mongoose.Types.ObjectId,
  ref: "Account",
};

const productRef = {
  type: mongoose.Types.ObjectId,
  ref: "Product",
};

module.exports = {
  requiredString,
  requiredNumber,
  requiredNumberOptional,
  optionalNumber,
  requiredDate,
  requiredNumberWithDefault,
  NumberWithDefault,
  customerTypeEnum,
  paymentTypeEnum,
  requiredBooleanWithDefaultFalse,
  requiredBooleanWithDefaultTrue,
  expenseTypeEnum,
  payerTypeEnum,
  saleTypeEnum,
  VendorRef,
  customerRef,
  EmployeeRef,
  itemRef,
  accountRef,
  productRef,
  StockRef,
  BrandRef,
  LabourTypeRef,
  ExpenseTypeRef,
  CustomerInvoiceItemRef,
  accountTypeEnum,
  accountTypeEnumNotRequired,
  requiredStringOptional,
  InvoiceTypeEnum,
  userTypeEnum,
  nonProductTypeEnum,
  CustomerReturnItemRef,
  requiredDateTimeStamp,
  labourRef,
};
