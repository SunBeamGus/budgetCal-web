import test from "node:test";
import assert from "node:assert/strict";
import {
  formatAmountInput,
  getCategoryRows,
  getMonthSummary,
  parseAmountToCents,
  parseCsv,
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

test("round-trips transactions through CSV", () => {
  const csv = transactionsToCsv(transactions, categories);
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], ["date", "type", "category", "amount", "note"]);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[1], ["2026-10-08", "expense", "Food", "42", ""]);
});

test("parses quoted CSV values and escaped quotes", () => {
  const result = parseCsv('date,note\r\n2026-10-01,"Lunch, coffee"\r\n2026-10-02,"He said ""hello"""');
  assert.deepEqual(result, [
    ["date", "note"],
    ["2026-10-01", "Lunch, coffee"],
    ["2026-10-02", 'He said "hello"'],
  ]);
});
