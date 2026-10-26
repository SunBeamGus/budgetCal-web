export const DEFAULT_CATEGORIES = [
  { name: "Housing", color: "#d45d3f", group: "essentials" },
  { name: "Groceries", color: "#3f826d", group: "essentials" },
  { name: "Dining", color: "#d89b35", group: "lifestyle" },
  { name: "Transport", color: "#3f74a8", group: "essentials" },
  { name: "Utilities", color: "#8b68a8", group: "essentials" },
  { name: "Leisure", color: "#c35b8d", group: "lifestyle" },
];

export const BUDGET_GROUPS = [
  { id: "essentials", label: "Essentials", color: "#3f826d" },
  { id: "lifestyle", label: "Lifestyle", color: "#d89b35" },
  { id: "financial", label: "Financial", color: "#3f74a8" },
  { id: "other", label: "Other", color: "#89918d" },
];

export const CATEGORY_COLORS = [
  "#d45d3f",
  "#3f826d",
  "#d89b35",
  "#3f74a8",
  "#8b68a8",
  "#c35b8d",
  "#687a3c",
  "#976b43",
];

export const COMMON_CURRENCIES = [
  "SGD",
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CNY",
  "MYR",
  "AUD",
  "CAD",
  "HKD",
  "INR",
  "THB",
  "KRW",
  "IDR",
  "PHP",
  "TWD",
];

export const SUPPORTED_CURRENCIES =
  typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("currency")
    : [...COMMON_CURRENCIES];

const SUPPORTED_ISO_CURRENCIES = new Set(SUPPORTED_CURRENCIES);

const MONTH_FORMATTER = new Intl.DateTimeFormat("en", {
  month: "long",
  year: "numeric",
});

const SHORT_DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const SHORT_MONTH_FORMATTER = new Intl.DateTimeFormat("en", {
  month: "short",
});

export function createId(prefix = "id") {
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${randomPart}`;
}

export function toLocalIsoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function currentMonth(date = new Date()) {
  return toLocalIsoDate(date).slice(0, 7);
}

export function shiftMonth(month, offset) {
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(year, monthNumber - 1 + offset, 1, 12);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}`;
}

export function formatMonth(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return MONTH_FORMATTER.format(new Date(year, monthNumber - 1, 1, 12));
}

export function formatShortMonth(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  return SHORT_MONTH_FORMATTER.format(new Date(year, monthNumber - 1, 1, 12));
}

export function formatDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return SHORT_DATE_FORMATTER.format(new Date(year, month - 1, day, 12));
}

export function parseAmountToCents(value) {
  const normalized = String(value ?? "")
    .trim()
    .replaceAll(",", "")
    .replace(/[^\d.-]/g, "");

  if (!normalized || !Number.isFinite(Number(normalized))) {
    return null;
  }

  const amount = Number(normalized);
  if (amount < 0) {
    return null;
  }

  return Math.round((amount + Number.EPSILON) * 100);
}

export function normalizeCurrencyCode(value, fallback = "SGD") {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : fallback;
}

export function isValidCurrencyCode(value) {
  const code = normalizeCurrencyCode(value, "");
  if (!code) {
    return false;
  }
  return SUPPORTED_ISO_CURRENCIES.has(code);
}

export function parseExchangeRate(value) {
  const normalized = String(value ?? "").trim().replaceAll(",", "");
  if (!normalized || !Number.isFinite(Number(normalized))) {
    return null;
  }
  const rate = Number(normalized);
  return rate > 0 ? Math.round(rate * 100000000) / 100000000 : null;
}

export function convertToBaseCents(amountCents, exchangeRate = 1) {
  const amount = Number(amountCents) || 0;
  const rate = Number(exchangeRate);
  return Math.round(amount * (Number.isFinite(rate) && rate > 0 ? rate : 1));
}

export function getTransactionBaseCents(transaction) {
  const baseAmount = Number(transaction.baseAmountCents);
  if (Number.isFinite(baseAmount) && baseAmount >= 0) {
    return Math.round(baseAmount);
  }
  return convertToBaseCents(transaction.amountCents, transaction.exchangeRate);
}

export function normalizeTransactionCurrency(transaction, baseCurrency = "SGD") {
  const currency = normalizeCurrencyCode(transaction.currency, baseCurrency);
  const exchangeRate =
    currency === baseCurrency ? 1 : parseExchangeRate(transaction.exchangeRate) || 1;
  return {
    ...transaction,
    currency,
    exchangeRate,
    baseAmountCents: getTransactionBaseCents({
      ...transaction,
      currency,
      exchangeRate,
    }),
  };
}

export function normalizeAssetCurrency(asset, baseCurrency = "SGD") {
  const currency = normalizeCurrencyCode(asset.currency, baseCurrency);
  const exchangeRate =
    currency === baseCurrency ? 1 : parseExchangeRate(asset.exchangeRate) || 1;
  const valueCents = Math.max(0, Math.round(Number(asset.valueCents) || 0));
  return {
    ...asset,
    currency,
    exchangeRate,
    baseValueCents: convertToBaseCents(valueCents, exchangeRate),
    baseCurrency,
  };
}

export function formatCurrency(cents, currency = "SGD", locale = "en-SG") {
  const code = normalizeCurrencyCode(currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format((Number(cents) || 0) / 100);
  } catch {
    return `${code} ${((Number(cents) || 0) / 100).toFixed(2)}`;
  }
}

export function formatAmountInput(cents) {
  return ((Number(cents) || 0) / 100).toFixed(2);
}

export function inMonth(transaction, month) {
  return String(transaction.date || "").startsWith(`${month}-`);
}

export function normalizeCategoryGroup(group, categoryName = "") {
  const normalized = String(group || "").trim().toLowerCase();
  const aliases = {
    essential: "essentials",
    needs: "essentials",
    wants: "lifestyle",
    savings: "financial",
    debt: "financial",
  };
  const groupId = aliases[normalized] || normalized;
  if (BUDGET_GROUPS.some((item) => item.id === groupId)) {
    return groupId;
  }

  const name = String(categoryName).toLowerCase();
  if (/dining|leisure|entertainment|shopping/.test(name)) {
    return "lifestyle";
  }
  if (/saving|invest|loan|debt|credit|mortgage/.test(name)) {
    return "financial";
  }
  if (/housing|grocery|food|transport|utility|utilities|insurance|health/.test(name)) {
    return "essentials";
  }
  return "other";
}

export function getCategoryRows(categories, allocations, transactions, month) {
  const budgetByCategory = new Map(
    allocations
      .filter((allocation) => allocation.month === month)
      .map((allocation) => [allocation.categoryId, Number(allocation.amountCents) || 0]),
  );

  const spentByCategory = new Map();
  for (const transaction of transactions) {
    if (transaction.type !== "expense" || !inMonth(transaction, month)) {
      continue;
    }
    const categoryId = transaction.categoryId || "uncategorized";
    spentByCategory.set(
      categoryId,
      (spentByCategory.get(categoryId) || 0) + getTransactionBaseCents(transaction),
    );
  }

  const rows = categories
    .filter((category) => !category.archived)
    .map((category) => {
      const budgetCents = budgetByCategory.get(category.id) || 0;
      const spentCents = spentByCategory.get(category.id) || 0;
      const remainingCents = budgetCents - spentCents;
      const progress = budgetCents > 0 ? (spentCents / budgetCents) * 100 : spentCents > 0 ? 100 : 0;

      return {
        ...category,
        group: normalizeCategoryGroup(category.group, category.name),
        budgetCents,
        spentCents,
        remainingCents,
        progress,
        isOverBudget: spentCents > budgetCents,
      };
    });

  const knownCategoryIds = new Set(categories.map((category) => category.id));
  const uncategorizedSpent = [...spentByCategory.entries()]
    .filter(([categoryId]) => !knownCategoryIds.has(categoryId))
    .reduce((sum, [, amount]) => sum + amount, 0);

  if (uncategorizedSpent > 0) {
    rows.push({
      id: "uncategorized",
      name: "Uncategorized",
      color: "#89918d",
      group: "other",
      archived: false,
      budgetCents: 0,
      spentCents: uncategorizedSpent,
      remainingCents: -uncategorizedSpent,
      progress: 100,
      isOverBudget: true,
    });
  }

  return rows;
}

export function getBudgetGroupSummary(rows, groupBudgets = [], month = "") {
  return BUDGET_GROUPS.map((group) => {
    const groupRows = rows.filter(
      (row) => normalizeCategoryGroup(row.group, row.name) === group.id,
    );
    const groupBudget = groupBudgets.find(
      (budget) => budget.month === month && budget.groupId === group.id,
    );
    const plannedCents = Number(groupBudget?.amountCents) || 0;
    const categoryLimitCents = groupRows.reduce((sum, row) => sum + row.budgetCents, 0);
    const spentCents = groupRows.reduce((sum, row) => sum + row.spentCents, 0);
    const remainingCents = plannedCents - spentCents;
    return {
      ...group,
      categoryCount: groupRows.filter((row) => row.id !== "uncategorized").length,
      plannedCents,
      categoryLimitCents,
      spentCents,
      remainingCents,
      progress: plannedCents > 0 ? (spentCents / plannedCents) * 100 : spentCents > 0 ? 100 : 0,
      isOverBudget: spentCents > plannedCents,
    };
  });
}

export function moveCategoryOrder(categories, categoryId, offset) {
  if (![-1, 1].includes(offset)) {
    return categories;
  }
  const active = categories.filter((category) => !category.archived);
  const currentIndex = active.findIndex((category) => category.id === categoryId);
  const targetIndex = currentIndex + offset;
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= active.length) {
    return categories;
  }

  [active[currentIndex], active[targetIndex]] = [active[targetIndex], active[currentIndex]];
  const archived = categories.filter((category) => category.archived);
  return [...active, ...archived].map((category, index) => ({
    ...category,
    sortOrder: index,
  }));
}

export function getMonthSummary(categories, allocations, transactions, month, groupBudgets = null) {
  const periodTransactions = transactions.filter((transaction) => inMonth(transaction, month));
  const incomeCents = periodTransactions
    .filter((transaction) => transaction.type === "income")
    .reduce((sum, transaction) => sum + getTransactionBaseCents(transaction), 0);
  const expenseCents = periodTransactions
    .filter((transaction) => transaction.type === "expense")
    .reduce((sum, transaction) => sum + getTransactionBaseCents(transaction), 0);
  const plannedCents = groupBudgets
    ? groupBudgets
        .filter((budget) => budget.month === month)
        .reduce((sum, budget) => sum + (Number(budget.amountCents) || 0), 0)
    : categories
        .filter((category) => !category.archived)
        .reduce((sum, category) => {
          const allocation = allocations.find(
            (item) => item.month === month && item.categoryId === category.id,
          );
          return sum + (allocation?.amountCents || 0);
        }, 0);

  return {
    month,
    incomeCents,
    expenseCents,
    plannedCents,
    budgetRemainingCents: plannedCents - expenseCents,
    netCents: incomeCents - expenseCents,
    budgetProgress: plannedCents > 0 ? (expenseCents / plannedCents) * 100 : expenseCents > 0 ? 100 : 0,
    transactionCount: periodTransactions.length,
  };
}

export function getAssetSummary(assets, cashFlowCents = 0) {
  const manualAssetsCents = assets
    .filter((asset) => asset.kind === "asset")
    .reduce((sum, asset) => sum + (Number(asset.baseValueCents) || 0), 0);
  const totalLiabilitiesCents = assets
    .filter((asset) => asset.kind === "liability")
    .reduce((sum, asset) => sum + (Number(asset.baseValueCents) || 0), 0);

  return {
    manualAssetsCents,
    cashFlowCents,
    totalAssetsCents: manualAssetsCents + cashFlowCents,
    totalLiabilitiesCents,
    netWorthCents: manualAssetsCents + cashFlowCents - totalLiabilitiesCents,
    itemCount: assets.length,
  };
}

export function sortTransactions(transactions) {
  return [...transactions].sort((a, b) => {
    const byDate = String(b.date).localeCompare(String(a.date));
    if (byDate !== 0) {
      return byDate;
    }
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
}

export function transactionToCsv(transaction, categories, baseCurrency = "SGD") {
  const category = categories.find((item) => item.id === transaction.categoryId);
  const currency = normalizeCurrencyCode(transaction.currency, baseCurrency);
  const exchangeRate =
    currency === baseCurrency ? 1 : parseExchangeRate(transaction.exchangeRate) || 1;
  return [
    transaction.date,
    transaction.type,
    category?.name || "",
    formatAmountInput(transaction.amountCents).replace(/\.00$/, ""),
    currency,
    String(exchangeRate),
    transaction.note || "",
  ];
}

export function transactionsToCsv(transactions, categories, baseCurrency = "SGD") {
  const header = ["date", "type", "category", "amount", "currency", "exchange_rate", "note"];
  const rows = sortTransactions(transactions).map((transaction) =>
    transactionToCsv(transaction, categories, baseCurrency),
  );
  return [header, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

export function parseCsv(text) {
  const source = String(text ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (quoted && character === '"' && next === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") {
        index += 1;
      }
      row.push(value);
      if (row.some((cell) => cell.trim() !== "")) {
        rows.push(row);
      }
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  row.push(value);
  if (row.some((cell) => cell.trim() !== "")) {
    rows.push(row);
  }

  return rows;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
