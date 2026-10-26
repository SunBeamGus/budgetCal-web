import test from "node:test";
import assert from "node:assert/strict";
import {
  BUDGET_GROUPS,
  COMMON_CURRENCIES,
  SUPPORTED_CURRENCIES,
  convertToBaseCents,
  formatAmountInput,
  getAssetSummary,
  getBudgetGroupSummary,
  getCategoryRows,
  getMonthSummary,
  getTransactionBaseCents,
  isValidCurrencyCode,
  moveCategoryOrder,
  normalizeAssetCurrency,
  normalizeCategoryGroup,
  normalizeTransactionCurrency,
  parseAmountToCents,
  parseCsv,
  parseExchangeRate,
  shiftMonth,
  transactionsToCsv,
} from "../src/budget.js";

const categories = [
  { id: "food", name: "Food", color: "#3f826d", archived: false },
  { id: "home", name: "Home", color: "#d45d3f", archived: false },
];

const allocations = [
  { key: "2026-10:food", month: "2026-10", categoryId: "food", amountCents: 50000 },
  { key: "2026-10:home", month: "2026-10", categoryId: "home", amountCents: 200000 },
];

const transactions = [
  {
    id: "expense-1",
    type: "expense",
    amountCents: 12500,
    date: "2026-10-03",
    categoryId: "food",
  },
  {
    id: "expense-2",
    type: "expense",
    amountCents: 4200,
    date: "2026-10-08",
    categoryId: "food",
  },
  {
    id: "income-1",
    type: "income",
    amountCents: 300000,
    date: "2026-10-01",
    categoryId: null,
  },
  {
    id: "expense-previous",
    type: "expense",
    amountCents: 99900,
    date: "2026-09-30",
    categoryId: "food",
  },
];

test("parses money values into integer cents", () => {
  assert.equal(parseAmountToCents("1,234.56"), 123456);
  assert.equal(parseAmountToCents("S$ 85"), 8500);
  assert.equal(parseAmountToCents("0.1"), 10);
  assert.equal(parseAmountToCents(""), null);
  assert.equal(parseAmountToCents("-12"), null);
  assert.equal(formatAmountInput(123456), "1234.56");
});

test("moves between months across year boundaries", () => {
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-06", 4), "2026-10");
});

test("parses exchange rates and validates currency codes", () => {
  assert.equal(parseExchangeRate("1.3525"), 1.3525);
  assert.equal(parseExchangeRate("0"), null);
  assert.equal(parseExchangeRate("not a rate"), null);
  assert.equal(convertToBaseCents(1000, 1.35), 1350);
  assert.equal(isValidCurrencyCode("usd"), true);
  assert.equal(isValidCurrencyCode("XYZ"), false);
  assert(COMMON_CURRENCIES.includes("CNY"));
  assert(COMMON_CURRENCIES.includes("USD"));
  assert(COMMON_CURRENCIES.includes("HKD"));
  assert(SUPPORTED_CURRENCIES.includes("CNY"));
  assert(SUPPORTED_CURRENCIES.includes("USD"));
  assert(SUPPORTED_CURRENCIES.includes("HKD"));
});

test("calculates monthly totals and category progress", () => {
  const summary = getMonthSummary(categories, allocations, transactions, "2026-10");
  assert.equal(summary.incomeCents, 300000);
  assert.equal(summary.expenseCents, 16700);
  assert.equal(summary.plannedCents, 250000);
  assert.equal(summary.budgetRemainingCents, 233300);
  assert.equal(summary.netCents, 283300);
  assert.equal(summary.transactionCount, 3);

  const rows = getCategoryRows(categories, allocations, transactions, "2026-10");
  assert.equal(rows[0].spentCents, 16700);
  assert.equal(rows[0].remainingCents, 33300);
  assert.equal(rows[0].progress, 33.4);
  assert.equal(rows[1].spentCents, 0);
});

test("converts foreign transactions into base-currency totals", () => {
  const foreignTransactions = [
    ...transactions,
    {
      id: "foreign-1",
      type: "expense",
      amountCents: 10000,
      currency: "USD",
      exchangeRate: 1.35,
      baseAmountCents: 13500,
      date: "2026-10-10",
      categoryId: "home",
    },
  ];
  const summary = getMonthSummary(categories, allocations, foreignTransactions, "2026-10");
  assert.equal(summary.expenseCents, 30200);
  assert.equal(getTransactionBaseCents(foreignTransactions.at(-1)), 13500);

  const legacy = normalizeTransactionCurrency(
    { amountCents: 8900, date: "2026-10-01" },
    "SGD",
  );
  assert.equal(legacy.currency, "SGD");
  assert.equal(legacy.exchangeRate, 1);
  assert.equal(legacy.baseAmountCents, 8900);
});

test("normalizes assets and calculates net worth by kind", () => {
  const foreignAsset = normalizeAssetCurrency(
    {
      id: "car",
      kind: "asset",
      valueCents: 2000000,
      currency: "USD",
      exchangeRate: 1.35,
    },
    "SGD",
  );
  assert.equal(foreignAsset.baseValueCents, 2700000);
  assert.equal(foreignAsset.currency, "USD");

  const summary = getAssetSummary([
    { kind: "asset", baseValueCents: 5000000 },
    foreignAsset,
    { kind: "liability", baseValueCents: 1500000 },
  ], 500000);
  assert.equal(summary.manualAssetsCents, 7700000);
  assert.equal(summary.cashFlowCents, 500000);
  assert.equal(summary.totalAssetsCents, 8200000);
  assert.equal(summary.totalLiabilitiesCents, 1500000);
  assert.equal(summary.netWorthCents, 6700000);
  assert.equal(summary.itemCount, 3);
});

test("marks an over-budget category and includes uncategorized spending", () => {
  const overSpent = [
    ...transactions,
    {
      id: "expense-3",
      type: "expense",
      amountCents: 50000,
      date: "2026-10-12",
      categoryId: "food",
    },
    {
      id: "expense-4",
      type: "expense",
      amountCents: 3000,
      date: "2026-10-12",
      categoryId: null,
    },
  ];
  const rows = getCategoryRows(categories, allocations, overSpent, "2026-10");
  assert.equal(rows[0].isOverBudget, true);
  assert.equal(rows[0].remainingCents, -16700);
  assert.equal(rows.at(-1).name, "Uncategorized");
  assert.equal(rows.at(-1).spentCents, 3000);
});

test("moves active categories and preserves archived categories after them", () => {
  const ordered = [
    { ...categories[0], sortOrder: 0 },
    { ...categories[1], sortOrder: 1 },
    { id: "archived", name: "Old", archived: true, sortOrder: 2 },
  ];
  const moved = moveCategoryOrder(ordered, "home", -1);
  assert.deepEqual(
    moved.map((category) => category.id),
    ["home", "food", "archived"],
  );
  assert.deepEqual(
    moved.map((category) => category.sortOrder),
    [0, 1, 2],
  );
  assert.equal(moveCategoryOrder(moved, "home", -1), moved);
  assert.equal(moveCategoryOrder(moved, "archived", 1), moved);
});

test("separates budget totals into category groups", () => {
  const groupedCategories = [
    { id: "needs", name: "Housing", color: "#111111", group: "essentials", archived: false },
    { id: "wants", name: "Dining", color: "#222222", group: "lifestyle", archived: false },
    { id: "future", name: "Savings", color: "#333333", group: "financial", archived: false },
  ];
  const groupedAllocations = [
    { month: "2026-10", categoryId: "needs", amountCents: 100000 },
    { month: "2026-10", categoryId: "wants", amountCents: 50000 },
    { month: "2026-10", categoryId: "future", amountCents: 30000 },
  ];
  const groupedTransactions = [
    {
      type: "expense",
      amountCents: 25000,
      baseAmountCents: 25000,
      date: "2026-10-05",
      categoryId: "needs",
    },
    {
      type: "expense",
      amountCents: 12000,
      baseAmountCents: 12000,
      date: "2026-10-06",
      categoryId: "wants",
    },
  ];
  const rows = getCategoryRows(
    groupedCategories,
    groupedAllocations,
    groupedTransactions,
    "2026-10",
  );
  const groupBudgets = [
    { month: "2026-10", groupId: "essentials", amountCents: 110000 },
    { month: "2026-10", groupId: "lifestyle", amountCents: 40000 },
    { month: "2026-10", groupId: "financial", amountCents: 60000 },
  ];
  const groups = getBudgetGroupSummary(rows, groupBudgets, "2026-10");
  const essentials = groups.find((group) => group.id === "essentials");
  const lifestyle = groups.find((group) => group.id === "lifestyle");
  const financial = groups.find((group) => group.id === "financial");

  assert.equal(essentials.plannedCents, 110000);
  assert.equal(essentials.categoryLimitCents, 100000);
  assert.equal(essentials.spentCents, 25000);
  assert.equal(lifestyle.remainingCents, 28000);
  assert.equal(financial.spentCents, 0);
  const groupSummary = getMonthSummary(
    groupedCategories,
    groupedAllocations,
    groupedTransactions,
    "2026-10",
    groupBudgets,
  );
  assert.equal(groupSummary.plannedCents, 210000);
  assert.deepEqual(
    groups.map((group) => group.id),
    ["essentials", "lifestyle", "financial", "other"],
  );
  assert.equal(BUDGET_GROUPS.length, 4);
  assert.equal(normalizeCategoryGroup("needs"), "essentials");
  assert.equal(normalizeCategoryGroup("", "Credit card"), "financial");
});

test("round-trips transactions through CSV", () => {
  const csv = transactionsToCsv(transactions, categories);
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], [
    "date",
    "type",
    "category",
    "amount",
    "currency",
    "exchange_rate",
    "note",
  ]);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[1], ["2026-10-08", "expense", "Food", "42", "SGD", "1", ""]);
});

test("parses quoted CSV values and escaped quotes", () => {
  const result = parseCsv('date,note\r\n2026-10-01,"Lunch, coffee"\r\n2026-10-02,"He said ""hello"""');
  assert.deepEqual(result, [
    ["date", "note"],
    ["2026-10-01", "Lunch, coffee"],
    ["2026-10-02", 'He said "hello"'],
  ]);
});
