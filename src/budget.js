export const DEFAULT_CATEGORIES = [
  { name: "Housing", color: "#d45d3f" },
  { name: "Groceries", color: "#3f826d" },
  { name: "Dining", color: "#d89b35" },
  { name: "Transport", color: "#3f74a8" },
  { name: "Utilities", color: "#8b68a8" },
  { name: "Leisure", color: "#c35b8d" },
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

export function formatCurrency(cents, currency = "SGD", locale = "en-SG") {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format((Number(cents) || 0) / 100);
}

export function formatAmountInput(cents) {
  return ((Number(cents) || 0) / 100).toFixed(2);
}

export function inMonth(transaction, month) {
  return String(transaction.date || "").startsWith(`${month}-`);
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
    spentByCategory.set(categoryId, (spentByCategory.get(categoryId) || 0) + transaction.amountCents);
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

export function getMonthSummary(categories, allocations, transactions, month) {
  const periodTransactions = transactions.filter((transaction) => inMonth(transaction, month));
  const incomeCents = periodTransactions
    .filter((transaction) => transaction.type === "income")
    .reduce((sum, transaction) => sum + transaction.amountCents, 0);
  const expenseCents = periodTransactions
    .filter((transaction) => transaction.type === "expense")
    .reduce((sum, transaction) => sum + transaction.amountCents, 0);
  const plannedCents = categories
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

export function sortTransactions(transactions) {
  return [...transactions].sort((a, b) => {
    const byDate = String(b.date).localeCompare(String(a.date));
    if (byDate !== 0) {
      return byDate;
    }
    return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
  });
}

export function transactionToCsv(transaction, categories) {
  const category = categories.find((item) => item.id === transaction.categoryId);
  return [
    transaction.date,
    transaction.type,
    category?.name || "",
    formatAmountInput(transaction.amountCents).replace(/\.00$/, ""),
    transaction.note || "",
  ];
}

export function transactionsToCsv(transactions, categories) {
  const header = ["date", "type", "category", "amount", "note"];
  const rows = sortTransactions(transactions).map((transaction) =>
    transactionToCsv(transaction, categories),
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
