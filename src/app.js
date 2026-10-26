import {
  CATEGORY_COLORS,
  createId,
  currentMonth,
  escapeHtml,
  formatAmountInput,
  formatCurrency,
  formatDate,
  formatMonth,
  formatShortMonth,
  getCategoryRows,
  getMonthSummary,
  inMonth,
  parseAmountToCents,
  parseCsv,
  shiftMonth,
  sortTransactions,
  toLocalIsoDate,
  transactionsToCsv,
} from "./budget.js";
import {
  createAllocationKey,
  defaultSettings,
  deleteRecord,
  loadAppData,
  putRecord,
  replaceAppData,
  seedDefaults,
} from "./store.js";

const app = document.querySelector("#app");
const modal = document.querySelector("#modal");
const modalTitle = document.querySelector("#modal-title");
const modalEyebrow = document.querySelector("#modal-eyebrow");
const modalContent = document.querySelector("#modal-content");
const filePicker = document.querySelector("#file-picker");
const monthLabel = document.querySelector("#month-label");
const toast = document.querySelector("#toast");
const storageStatus = document.querySelector("#storage-status");
const connectionStatus = document.querySelector("#connection-status");

const state = {
  settings: defaultSettings(),
  categories: [],
  allocations: [],
  transactions: [],
  selectedMonth: currentMonth(),
  activeTab: "overview",
  filters: {
    search: "",
    type: "all",
    category: "all",
  },
  importMode: null,
};

let toastTimer;

function money(cents) {
  return formatCurrency(cents, state.settings.currency, state.settings.locale);
}

function categoryById(categoryId) {
  return state.categories.find((category) => category.id === categoryId);
}

function categoryName(categoryId) {
  return categoryById(categoryId)?.name || "Uncategorized";
}

function categoryColor(categoryId) {
  return categoryById(categoryId)?.color || "#89918d";
}

function activeCategories() {
  return state.categories.filter((category) => !category.archived);
}

function upsert(list, item) {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index >= 0) {
    list[index] = item;
  } else {
    list.push(item);
  }
}

function upsertAllocation(allocation) {
  const index = state.allocations.findIndex((entry) => entry.key === allocation.key);
  if (index >= 0) {
    state.allocations[index] = allocation;
  } else {
    state.allocations.push(allocation);
  }
}

function showToast(message, kind = "success") {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3200);
}

function emptyState(title, description, action = "") {
  return `
    <div class="empty-state">
      <span class="empty-illustration" aria-hidden="true">
        <svg viewBox="0 0 64 64">
          <path d="M13 21h38v29H13z" />
          <path d="M20 14h24l7 7H13l7-7Z" />
          <path d="M24 34h16M24 41h10" />
        </svg>
      </span>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(description)}</p>
      ${action}
    </div>
  `;
}

function progressMarkup(row) {
  const progress = Math.min(Math.max(row.progress || 0, 0), 100);
  return `
    <div class="progress-track" aria-label="${escapeHtml(row.name)} budget used ${Math.round(row.progress)}%">
      <span
        class="progress-value ${row.isOverBudget ? "is-over" : ""}"
        style="width: ${progress}%; --category-color: ${escapeHtml(row.color)}"
      ></span>
    </div>
  `;
}

function render() {
  monthLabel.textContent = formatMonth(state.selectedMonth);
  monthLabel.setAttribute("datetime", state.selectedMonth);

  document.querySelectorAll(".tab-button").forEach((button) => {
    const active = button.dataset.tab === state.activeTab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });

  if (state.activeTab === "overview") {
    renderOverview();
  } else if (state.activeTab === "budget") {
    renderBudget();
  } else if (state.activeTab === "transactions") {
    renderTransactions();
  } else {
    renderReports();
  }
}

function renderOverview() {
  const summary = getMonthSummary(
    state.categories,
    state.allocations,
    state.transactions,
    state.selectedMonth,
  );
  const rows = getCategoryRows(
    state.categories,
    state.allocations,
    state.transactions,
    state.selectedMonth,
  );
  const fundedRows = rows.filter((row) => row.budgetCents > 0);
  const recentTransactions = sortTransactions(
    state.transactions.filter((transaction) => inMonth(transaction, state.selectedMonth)),
  ).slice(0, 6);
  const progress = Math.min(Math.max(summary.budgetProgress, 0), 100);
  const budgetTone = summary.budgetRemainingCents < 0 ? "negative" : "positive";

  app.innerHTML = `
    <section class="page-heading">
      <div>
        <p class="eyebrow">Your money at a glance</p>
        <h1>${escapeHtml(formatMonth(state.selectedMonth))}</h1>
        <p>Plan the month, track the details, and keep the rest simple.</p>
      </div>
      <button class="button button-primary" type="button" data-action="add-transaction">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        Add transaction
      </button>
    </section>

    <section class="summary-grid" aria-label="Monthly summary">
      <article class="summary-card summary-card-featured">
        <div class="summary-icon">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 17 10 12l3 3 6-8"/><path d="M15 7h4v4"/></svg>
        </div>
        <p>Budget remaining</p>
        <strong class="${budgetTone}">${money(summary.budgetRemainingCents)}</strong>
        <small>${money(summary.plannedCents)} planned</small>
      </article>
      <article class="summary-card">
        <div class="summary-icon">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16v12H4z"/><path d="M8 7V4h8v3M16 13h2"/></svg>
        </div>
        <p>Spent</p>
        <strong>${money(summary.expenseCents)}</strong>
        <small>${summary.transactionCount} transaction${summary.transactionCount === 1 ? "" : "s"}</small>
      </article>
      <article class="summary-card">
        <div class="summary-icon">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 4v16M7 9l5-5 5 5"/><path d="M5 20h14"/></svg>
        </div>
        <p>Income</p>
        <strong>${money(summary.incomeCents)}</strong>
        <small>Net ${summary.netCents >= 0 ? "+" : ""}${money(summary.netCents)}</small>
      </article>
      <article class="summary-card">
        <div class="summary-icon">
          <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>
        </div>
        <p>Budget used</p>
        <strong>${Math.round(summary.budgetProgress)}%</strong>
        <small>${summary.plannedCents > 0 ? `${money(Math.max(summary.budgetRemainingCents, 0))} still available` : "Set category limits"}</small>
      </article>
    </section>

    <section class="budget-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Monthly plan</p>
          <h2>Budget progress</h2>
        </div>
        <button class="text-button" type="button" data-tab-target="budget">Manage budget</button>
      </div>
      <div class="budget-overview-bar">
        <span style="width: ${progress}%; --bar-color: ${summary.budgetRemainingCents < 0 ? "#d45d3f" : "#e5b84c"}"></span>
      </div>
      ${
        fundedRows.length
          ? `<div class="category-grid">${fundedRows.map(renderOverviewCategory).join("")}</div>`
          : emptyState(
              "Give your categories a plan",
              "Set a spending limit for each category to start tracking progress.",
              `<button class="button button-secondary" type="button" data-tab-target="budget">Set budgets</button>`,
            )
      }
    </section>

    <section class="recent-panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Latest activity</p>
          <h2>Recent transactions</h2>
        </div>
        <button class="text-button" type="button" data-tab-target="transactions">View all</button>
      </div>
      ${
        recentTransactions.length
          ? `<div class="transaction-list">${recentTransactions.map(renderCompactTransaction).join("")}</div>`
          : emptyState(
              "No transactions this month",
              "Add an expense or income entry to begin.",
              `<button class="button button-secondary" type="button" data-action="add-transaction">Add first transaction</button>`,
            )
      }
    </section>
  `;
}

function renderOverviewCategory(row) {
  const percent = Math.round(row.progress);
  return `
    <article class="category-card">
      <div class="category-card-heading">
        <span class="category-swatch" style="--swatch: ${escapeHtml(row.color)}">${escapeHtml(row.name.slice(0, 1))}</span>
        <div>
          <h3>${escapeHtml(row.name)}</h3>
          <p>${money(row.spentCents)} of ${money(row.budgetCents)}</p>
        </div>
        <strong class="${row.isOverBudget ? "negative" : ""}">${percent}%</strong>
      </div>
      ${progressMarkup(row)}
      <div class="category-card-detail">
        <span>${row.isOverBudget ? "Over by" : "Left"}</span>
        <strong class="${row.isOverBudget ? "negative" : ""}">${money(Math.abs(row.remainingCents))}</strong>
      </div>
    </article>
  `;
}

function renderCompactTransaction(transaction) {
  const isIncome = transaction.type === "income";
  return `
    <article class="transaction-compact">
      <span class="transaction-symbol ${isIncome ? "income" : ""}">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          ${isIncome ? '<path d="M12 19V5M7 10l5-5 5 5"/>' : '<path d="M12 5v14M7 14l5 5 5-5"/>'}
        </svg>
      </span>
      <div class="transaction-main">
        <strong>${escapeHtml(transaction.note || (isIncome ? "Income" : categoryName(transaction.categoryId)))}</strong>
        <span>${escapeHtml(isIncome ? "Income" : categoryName(transaction.categoryId))} · ${escapeHtml(formatDate(transaction.date))}</span>
      </div>
      <strong class="transaction-amount ${isIncome ? "income" : ""}">${isIncome ? "+" : "−"}${money(transaction.amountCents)}</strong>
    </article>
  `;
}

function renderBudget() {
  const rows = getCategoryRows(
    state.categories,
    state.allocations,
    state.transactions,
    state.selectedMonth,
  );
  const summary = getMonthSummary(
    state.categories,
    state.allocations,
    state.transactions,
    state.selectedMonth,
  );

  app.innerHTML = `
    <section class="page-heading">
      <div>
        <p class="eyebrow">Monthly plan</p>
        <h1>Build your budget</h1>
        <p>Set a limit for each category. Your plan is saved separately for every month.</p>
      </div>
      <button class="button button-primary" type="button" data-action="add-category">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        New category
      </button>
    </section>

    <section class="plan-strip">
      <div>
        <span>Planned</span>
        <strong>${money(summary.plannedCents)}</strong>
      </div>
      <div>
        <span>Spent</span>
        <strong>${money(summary.expenseCents)}</strong>
      </div>
      <div>
        <span>Remaining</span>
        <strong class="${summary.budgetRemainingCents < 0 ? "negative" : "positive"}">${money(summary.budgetRemainingCents)}</strong>
      </div>
    </section>

    <section class="budget-table-panel">
      <div class="budget-table-header">
        <span>Category</span>
        <span>Spent</span>
        <span>Limit</span>
        <span>Progress</span>
        <span class="visually-hidden">Actions</span>
      </div>
      ${
        rows.length
          ? rows.map(renderBudgetRow).join("")
          : emptyState(
              "No categories yet",
              "Create categories that match the way you spend.",
              `<button class="button button-secondary" type="button" data-action="add-category">Create a category</button>`,
            )
      }
    </section>
  `;
}

function renderBudgetRow(row) {
  return `
    <article class="budget-row">
      <div class="budget-category">
        <span class="category-swatch" style="--swatch: ${escapeHtml(row.color)}">${escapeHtml(row.name.slice(0, 1))}</span>
        <div>
          <strong>${escapeHtml(row.name)}</strong>
          <small>${row.budgetCents > 0 ? `${Math.round(row.progress)}% used` : "No limit set"}</small>
        </div>
      </div>
      <div class="budget-money" data-label="Spent">
        <span>${money(row.spentCents)}</span>
        <small>${row.isOverBudget ? `Over by ${money(Math.abs(row.remainingCents))}` : `${money(Math.max(row.remainingCents, 0))} left`}</small>
      </div>
      <div class="budget-money" data-label="Limit">
        <strong>${row.budgetCents > 0 ? money(row.budgetCents) : "—"}</strong>
      </div>
      <div class="budget-row-progress" data-label="Progress">
        ${progressMarkup(row)}
      </div>
      <div class="row-actions">
        ${
          row.id === "uncategorized"
            ? ""
            : `<button class="icon-button" type="button" data-action="edit-budget" data-id="${escapeHtml(row.id)}" aria-label="Edit ${escapeHtml(row.name)} budget">
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m4 20 4-1 11-11-3-3L5 16l-1 4Z"/><path d="m14 7 3 3"/></svg>
              </button>
              <button class="icon-button danger-hover" type="button" data-action="remove-category" data-id="${escapeHtml(row.id)}" aria-label="Remove ${escapeHtml(row.name)}">
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3m2 0-1 13H8L7 7"/><path d="M10 11v5M14 11v5"/></svg>
              </button>`
        }
      </div>
    </article>
  `;
}

function renderTransactions() {
  app.innerHTML = `
    <section class="page-heading">
      <div>
        <p class="eyebrow">Money in and out</p>
        <h1>Transactions</h1>
        <p>Every entry is stored locally in ${escapeHtml(formatMonth(state.selectedMonth))}.</p>
      </div>
      <button class="button button-primary" type="button" data-action="add-transaction">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        Add transaction
      </button>
    </section>

    <section class="filter-panel" aria-label="Transaction filters">
      <label class="search-field">
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/></svg>
        <span class="visually-hidden">Search transactions</span>
        <input id="transaction-search" type="search" placeholder="Search notes or categories" value="${escapeHtml(state.filters.search)}" />
      </label>
      <label>
        <span class="visually-hidden">Transaction type</span>
        <select id="transaction-type-filter">
          <option value="all" ${state.filters.type === "all" ? "selected" : ""}>All types</option>
          <option value="expense" ${state.filters.type === "expense" ? "selected" : ""}>Expenses</option>
          <option value="income" ${state.filters.type === "income" ? "selected" : ""}>Income</option>
        </select>
      </label>
      <label>
        <span class="visually-hidden">Transaction category</span>
        <select id="transaction-category-filter">
          <option value="all" ${state.filters.category === "all" ? "selected" : ""}>All categories</option>
          ${activeCategories()
            .map(
              (category) =>
                `<option value="${escapeHtml(category.id)}" ${state.filters.category === category.id ? "selected" : ""}>${escapeHtml(category.name)}</option>`,
            )
            .join("")}
        </select>
      </label>
    </section>

    <section class="transactions-panel">
      <div class="transaction-table-header">
        <span>Date</span>
        <span>Description</span>
        <span>Category</span>
        <span>Amount</span>
        <span class="visually-hidden">Actions</span>
      </div>
      <div id="transaction-results"></div>
    </section>
  `;
  renderTransactionResults();
}

function filteredTransactions() {
  const search = state.filters.search.trim().toLowerCase();
  return sortTransactions(state.transactions.filter((transaction) => inMonth(transaction, state.selectedMonth)))
    .filter((transaction) => state.filters.type === "all" || transaction.type === state.filters.type)
    .filter(
      (transaction) =>
        state.filters.category === "all" ||
        (state.filters.category === "income"
          ? transaction.type === "income"
          : transaction.categoryId === state.filters.category),
    )
    .filter((transaction) => {
      if (!search) {
        return true;
      }
      return [
        transaction.note,
        categoryName(transaction.categoryId),
        money(transaction.amountCents),
      ]
        .join(" ")
        .toLowerCase()
        .includes(search);
    });
}

function renderTransactionResults() {
  const container = document.querySelector("#transaction-results");
  if (!container) {
    return;
  }

  const transactions = filteredTransactions();
  const hasAnyTransactions = state.transactions.some((transaction) => inMonth(transaction, state.selectedMonth));

  container.innerHTML = transactions.length
    ? transactions.map(renderFullTransaction).join("")
    : emptyState(
        hasAnyTransactions ? "No matching transactions" : "Nothing recorded yet",
        hasAnyTransactions
          ? "Try changing your search or filters."
          : "Add an expense or income entry for this month.",
        hasAnyTransactions
          ? `<button class="button button-secondary" type="button" data-action="clear-filters">Clear filters</button>`
          : `<button class="button button-secondary" type="button" data-action="add-transaction">Add transaction</button>`,
      );
}

function renderFullTransaction(transaction) {
  const isIncome = transaction.type === "income";
  return `
    <article class="transaction-row">
      <div class="transaction-date" data-label="Date">
        <span>${escapeHtml(formatDate(transaction.date))}</span>
      </div>
      <div class="transaction-description" data-label="Description">
        <span class="transaction-symbol ${isIncome ? "income" : ""}">
          <svg aria-hidden="true" viewBox="0 0 24 24">
            ${isIncome ? '<path d="M12 19V5M7 10l5-5 5 5"/>' : '<path d="M12 5v14M7 14l5 5 5-5"/>'}
          </svg>
        </span>
        <div>
          <strong>${escapeHtml(transaction.note || (isIncome ? "Income" : categoryName(transaction.categoryId)))}</strong>
          <small>${isIncome ? "Income" : "Expense"}</small>
        </div>
      </div>
      <div data-label="Category">
        ${
          isIncome
            ? '<span class="quiet-pill">Income</span>'
            : `<span class="category-pill"><span style="--swatch: ${escapeHtml(categoryColor(transaction.categoryId))}"></span>${escapeHtml(categoryName(transaction.categoryId))}</span>`
        }
      </div>
      <strong class="transaction-amount ${isIncome ? "income" : ""}" data-label="Amount">
        ${isIncome ? "+" : "−"}${money(transaction.amountCents)}
      </strong>
      <div class="row-actions">
        <button class="icon-button" type="button" data-action="edit-transaction" data-id="${escapeHtml(transaction.id)}" aria-label="Edit transaction">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m4 20 4-1 11-11-3-3L5 16l-1 4Z"/><path d="m14 7 3 3"/></svg>
        </button>
        <button class="icon-button danger-hover" type="button" data-action="delete-transaction" data-id="${escapeHtml(transaction.id)}" aria-label="Delete transaction">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3m2 0-1 13H8L7 7"/></svg>
        </button>
      </div>
    </article>
  `;
}

function renderReports() {
  const months = Array.from({ length: 6 }, (_, index) => shiftMonth(state.selectedMonth, index - 5));
  const series = months.map((month) => ({
    month,
    ...getMonthSummary(state.categories, state.allocations, state.transactions, month),
  }));
  const maxValue = Math.max(1, ...series.flatMap((item) => [item.incomeCents, item.expenseCents]));
  const rows = getCategoryRows(
    state.categories,
    state.allocations,
    state.transactions,
    state.selectedMonth,
  )
    .filter((row) => row.spentCents > 0)
    .sort((a, b) => b.spentCents - a.spentCents);
  const monthSummary = series[series.length - 1];
  const maxCategorySpend = Math.max(1, ...rows.map((row) => row.spentCents));

  app.innerHTML = `
    <section class="page-heading">
      <div>
        <p class="eyebrow">Six-month view</p>
        <h1>Reports</h1>
        <p>Spot spending patterns without sending any data anywhere.</p>
      </div>
    </section>

    <section class="report-grid">
      <article class="chart-panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Cash flow</p>
            <h2>Income and spending</h2>
          </div>
          <div class="chart-legend">
            <span><i class="legend-income"></i>Income</span>
            <span><i class="legend-expense"></i>Spent</span>
          </div>
        </div>
        <div class="bar-chart">
          ${series
            .map(
              (item) => `
              <div class="chart-column">
                <div class="chart-value-label">
                  ${item.incomeCents || item.expenseCents ? `<span>${money(item.expenseCents)} spent</span>` : ""}
                </div>
                <div class="chart-bars">
                  <span class="chart-bar income" style="height: ${Math.max((item.incomeCents / maxValue) * 100, item.incomeCents ? 2 : 0)}%"></span>
                  <span class="chart-bar expense ${item.expenseCents > item.incomeCents && item.incomeCents > 0 ? "warning" : ""}" style="height: ${Math.max((item.expenseCents / maxValue) * 100, item.expenseCents ? 2 : 0)}%"></span>
                </div>
                <span class="chart-month ${item.month === state.selectedMonth ? "is-selected" : ""}">${escapeHtml(formatShortMonth(item.month))}</span>
              </div>
            `,
            )
            .join("")}
        </div>
      </article>

      <article class="report-stat-panel">
        <p class="eyebrow">${escapeHtml(formatMonth(state.selectedMonth))}</p>
        <h2>Month snapshot</h2>
        <dl class="stat-list">
          <div><dt>Income</dt><dd>${money(monthSummary.incomeCents)}</dd></div>
          <div><dt>Spending</dt><dd>${money(monthSummary.expenseCents)}</dd></div>
          <div><dt>Net cash flow</dt><dd class="${monthSummary.netCents >= 0 ? "positive" : "negative"}">${monthSummary.netCents >= 0 ? "+" : ""}${money(monthSummary.netCents)}</dd></div>
          <div><dt>Budget left</dt><dd class="${monthSummary.budgetRemainingCents >= 0 ? "positive" : "negative"}">${money(monthSummary.budgetRemainingCents)}</dd></div>
        </dl>
      </article>
    </section>

    <section class="report-breakdown">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Where it went</p>
          <h2>Spending by category</h2>
        </div>
      </div>
      ${
        rows.length
          ? `<div class="breakdown-list">${rows
              .map(
                (row) => `
                <article class="breakdown-row">
                  <span class="category-swatch" style="--swatch: ${escapeHtml(row.color)}">${escapeHtml(row.name.slice(0, 1))}</span>
                  <div class="breakdown-main">
                    <div>
                      <strong>${escapeHtml(row.name)}</strong>
                      <span>${monthSummary.expenseCents > 0 ? Math.round((row.spentCents / monthSummary.expenseCents) * 100) : 0}% of spending</span>
                    </div>
                    <div class="breakdown-track"><span style="width: ${Math.max((row.spentCents / maxCategorySpend) * 100, 2)}%; --category-color: ${escapeHtml(row.color)}"></span></div>
                  </div>
                  <strong>${money(row.spentCents)}</strong>
                </article>
              `,
              )
              .join("")}</div>`
          : emptyState(
              "No spending to analyse",
              "Your category report will appear after you record an expense.",
            )
      }
    </section>
  `;
}

function openTransactionModal(transactionId = null) {
  const existing = state.transactions.find((transaction) => transaction.id === transactionId);
  const isSameMonth = state.selectedMonth === currentMonth();
  const defaultDate = isSameMonth
    ? toLocalIsoDate()
    : `${state.selectedMonth}-${String(Math.min(new Date().getDate(), 28)).padStart(2, "0")}`;
  const categories = activeCategories();
  const income = existing?.type === "income";

  modalEyebrow.textContent = existing ? "Edit entry" : "New entry";
  modalTitle.textContent = existing ? "Update transaction" : "Add transaction";
  modalContent.innerHTML = `
    <form class="form-stack" data-form="transaction" data-id="${escapeHtml(existing?.id || "")}">
      <label>
        <span>Type</span>
        <select name="type" id="transaction-modal-type">
          <option value="expense" ${income ? "" : "selected"}>Expense</option>
          <option value="income" ${income ? "selected" : ""}>Income</option>
        </select>
      </label>
      <label>
        <span>Amount</span>
        <div class="money-input">
          <span>${escapeHtml(currencySymbol(state.settings.currency))}</span>
          <input
            name="amount"
            type="number"
            min="0.01"
            step="0.01"
            inputmode="decimal"
            placeholder="0.00"
            value="${escapeHtml(existing ? formatAmountInput(existing.amountCents) : "")}"
            required
            autofocus
          />
        </div>
      </label>
      <label>
        <span>Date</span>
        <input name="date" type="date" value="${escapeHtml(existing?.date || defaultDate)}" required />
      </label>
      <label id="transaction-category-field">
        <span>Category</span>
        <select name="categoryId" ${income ? "disabled" : ""} ${income ? "" : "required"}>
          ${categories
            .map(
              (category) =>
                `<option value="${escapeHtml(category.id)}" ${existing?.categoryId === category.id ? "selected" : ""}>${escapeHtml(category.name)}</option>`,
            )
            .join("")}
        </select>
      </label>
      <label>
        <span>Note <small>Optional</small></span>
        <input name="note" type="text" maxlength="120" placeholder="What was this for?" value="${escapeHtml(existing?.note || "")}" />
      </label>
      <div class="form-actions">
        <button class="button button-ghost" type="button" data-dialog-close>Cancel</button>
        <button class="button button-primary" type="submit">${existing ? "Save changes" : "Add transaction"}</button>
      </div>
    </form>
  `;
  modal.showModal();
  syncTransactionTypeField();
}

function syncTransactionTypeField() {
  const type = document.querySelector("#transaction-modal-type")?.value;
  const field = document.querySelector("#transaction-category-field");
  const select = field?.querySelector("select");
  if (!field || !select) {
    return;
  }
  const isIncome = type === "income";
  field.classList.toggle("is-muted", isIncome);
  select.disabled = isIncome;
  select.required = !isIncome;
}

function openBudgetModal(categoryId) {
  const category = categoryById(categoryId);
  if (!category) {
    return;
  }
  const allocation = state.allocations.find(
    (item) => item.month === state.selectedMonth && item.categoryId === categoryId,
  );

  modalEyebrow.textContent = formatMonth(state.selectedMonth);
  modalTitle.textContent = `Edit ${category.name}`;
  modalContent.innerHTML = `
    <form class="form-stack" data-form="budget" data-category-id="${escapeHtml(category.id)}">
      <div class="modal-category-summary">
        <span class="category-swatch" style="--swatch: ${escapeHtml(category.color)}">${escapeHtml(category.name.slice(0, 1))}</span>
        <p>Set how much you want to spend on <strong>${escapeHtml(category.name)}</strong> this month.</p>
      </div>
      <label>
        <span>Monthly limit</span>
        <div class="money-input">
          <span>${escapeHtml(currencySymbol(state.settings.currency))}</span>
          <input
            name="amount"
            type="number"
            min="0"
            step="0.01"
            inputmode="decimal"
            placeholder="0.00"
            value="${escapeHtml(allocation ? formatAmountInput(allocation.amountCents) : "")}"
            required
            autofocus
          />
        </div>
        <small>Use 0 to leave this category without a limit.</small>
      </label>
      <div class="form-actions">
        <button class="button button-ghost" type="button" data-dialog-close>Cancel</button>
        <button class="button button-primary" type="submit">Save budget</button>
      </div>
    </form>
  `;
  modal.showModal();
}

function openCategoryModal() {
  modalEyebrow.textContent = formatMonth(state.selectedMonth);
  modalTitle.textContent = "New category";
  modalContent.innerHTML = `
    <form class="form-stack" data-form="category">
      <label>
        <span>Name</span>
        <input name="name" type="text" maxlength="40" placeholder="e.g. Pet care" required autofocus />
      </label>
      <fieldset class="color-fieldset">
        <legend>Colour</legend>
        <div class="color-options">
          ${CATEGORY_COLORS.map(
            (color, index) => `
              <label class="color-choice" style="--swatch: ${color}" title="Colour ${index + 1}">
                <input type="radio" name="color" value="${color}" ${index === 0 ? "checked" : ""} />
                <span></span>
              </label>
            `,
          ).join("")}
        </div>
      </fieldset>
      <label>
        <span>Monthly limit <small>Optional</small></span>
        <div class="money-input">
          <span>${escapeHtml(currencySymbol(state.settings.currency))}</span>
          <input name="amount" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00" />
        </div>
      </label>
      <div class="form-actions">
        <button class="button button-ghost" type="button" data-dialog-close>Cancel</button>
        <button class="button button-primary" type="submit">Create category</button>
      </div>
    </form>
  `;
  modal.showModal();
}

function openDataModal() {
  modalEyebrow.textContent = "Your data";
  modalTitle.textContent = "Backup and portability";
  modalContent.innerHTML = `
    <div class="data-panel">
      <div class="local-data-note">
        <span class="local-data-icon">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3 4 7v5c0 5 3.5 8 8 10 4.5-2 8-5 8-10V7l-8-4Z"/><path d="m9 12 2 2 4-4"/></svg>
        </span>
        <div>
          <strong>No cloud account. No tracking.</strong>
          <p>Your budget lives in this browser on this device. Download a backup before clearing browser data.</p>
        </div>
      </div>
      <div class="data-actions">
        <button class="data-action" type="button" data-action="export-json">
          <span>
            <strong>Full JSON backup</strong>
            <small>Categories, budgets, and transactions</small>
          </span>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 4v11m-4-4 4 4 4-4M5 19h14"/></svg>
        </button>
        <button class="data-action" type="button" data-action="export-csv">
          <span>
            <strong>Export transactions as CSV</strong>
            <small>Useful for spreadsheets</small>
          </span>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 4v11m-4-4 4 4 4-4M5 19h14"/></svg>
        </button>
        <button class="data-action" type="button" data-action="import-json">
          <span>
            <strong>Restore JSON backup</strong>
            <small>Replaces all current local data</small>
          </span>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 16V5m-4 4 4-4 4 4M5 19h14"/></svg>
        </button>
        <button class="data-action" type="button" data-action="import-csv">
          <span>
            <strong>Import transactions from CSV</strong>
            <small>Adds entries and creates missing categories</small>
          </span>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 16V5m-4 4 4-4 4 4M5 19h14"/></svg>
        </button>
      </div>
      <p class="data-footnote">JSON is best for moving or restoring everything. CSV contains transaction rows only.</p>
    </div>
  `;
  modal.showModal();
}

function closeModal() {
  if (modal.open) {
    modal.close();
  }
}

async function saveTransaction(form) {
  const formData = new FormData(form);
  const type = String(formData.get("type"));
  const amountCents = parseAmountToCents(formData.get("amount"));
  const date = String(formData.get("date"));
  const existingId = form.dataset.id;
  const existing = state.transactions.find((transaction) => transaction.id === existingId);

  if (!amountCents || amountCents <= 0) {
    showToast("Enter an amount greater than zero.", "error");
    form.querySelector('[name="amount"]')?.focus();
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    showToast("Choose a valid transaction date.", "error");
    return;
  }

  const categoryId = type === "expense" ? String(formData.get("categoryId") || "") : null;
  if (type === "expense" && !categoryId) {
    showToast("Choose a category for this expense.", "error");
    return;
  }

  const now = new Date().toISOString();
  const record = {
    id: existing?.id || createId("transaction"),
    type,
    amountCents,
    date,
    month: date.slice(0, 7),
    categoryId,
    note: String(formData.get("note") || "").trim(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  await runFormAction(form, async () => {
    await putRecord("transactions", record);
    upsert(state.transactions, record);
    state.selectedMonth = date.slice(0, 7);
    closeModal();
    render();
    showToast(existing ? "Transaction updated." : "Transaction added.");
  });
}

async function saveBudget(form) {
  const amountCents = parseAmountToCents(new FormData(form).get("amount"));
  if (amountCents === null) {
    showToast("Enter a valid budget amount.", "error");
    return;
  }
  const categoryId = form.dataset.categoryId;
  const record = {
    key: createAllocationKey(state.selectedMonth, categoryId),
    month: state.selectedMonth,
    categoryId,
    amountCents,
    updatedAt: new Date().toISOString(),
  };

  await runFormAction(form, async () => {
    await putRecord("allocations", record);
    upsertAllocation(record);
    closeModal();
    render();
    showToast("Monthly budget saved.");
  });
}

async function saveCategory(form) {
  const formData = new FormData(form);
  const name = String(formData.get("name") || "").trim();
  if (!name) {
    showToast("Give the category a name.", "error");
    return;
  }
  if (state.categories.some((category) => category.name.toLowerCase() === name.toLowerCase())) {
    showToast("A category with that name already exists.", "error");
    return;
  }

  const now = new Date().toISOString();
  const category = {
    id: createId("category"),
    name,
    color: String(formData.get("color") || CATEGORY_COLORS[0]),
    sortOrder: Math.max(-1, ...state.categories.map((item) => item.sortOrder ?? -1)) + 1,
    archived: false,
    createdAt: now,
  };
  const amount = parseAmountToCents(formData.get("amount"));

  await runFormAction(form, async () => {
    await putRecord("categories", category);
    state.categories.push(category);

    if (amount && amount > 0) {
      const allocation = {
        key: createAllocationKey(state.selectedMonth, category.id),
        month: state.selectedMonth,
        categoryId: category.id,
        amountCents: amount,
        updatedAt: now,
      };
      await putRecord("allocations", allocation);
      upsertAllocation(allocation);
    }

    closeModal();
    render();
    showToast("Category created.");
  });
}

async function runFormAction(form, action) {
  const submitButton = form.querySelector('button[type="submit"]');
  const previousText = submitButton?.textContent;
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Saving…";
  }
  try {
    await action();
  } catch (error) {
    console.error(error);
    showToast(error.message || "Could not save your changes.", "error");
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = previousText;
    }
  }
}

async function deleteTransaction(transactionId) {
  const transaction = state.transactions.find((item) => item.id === transactionId);
  if (!transaction) {
    return;
  }
  if (!window.confirm(`Delete this ${transaction.type}? This cannot be undone.`)) {
    return;
  }

  try {
    await deleteRecord("transactions", transactionId);
    state.transactions = state.transactions.filter((item) => item.id !== transactionId);
    render();
    showToast("Transaction deleted.");
  } catch (error) {
    console.error(error);
    showToast("Could not delete the transaction.", "error");
  }
}

async function removeCategory(categoryId) {
  const category = categoryById(categoryId);
  if (!category) {
    return;
  }
  const hasTransactions = state.transactions.some((transaction) => transaction.categoryId === categoryId);
  const message = hasTransactions
    ? `"${category.name}" has transactions. It will be hidden from new entries while its history is preserved. Continue?`
    : `Remove "${category.name}" and its monthly limits? This cannot be undone.`;
  if (!window.confirm(message)) {
    return;
  }

  try {
    if (hasTransactions) {
      const archived = { ...category, archived: true, archivedAt: new Date().toISOString() };
      await putRecord("categories", archived);
      upsert(state.categories, archived);
    } else {
      const categoryAllocations = state.allocations.filter(
        (allocation) => allocation.categoryId === categoryId,
      );
      await Promise.all(categoryAllocations.map((allocation) => deleteRecord("allocations", allocation.key)));
      await deleteRecord("categories", categoryId);
      state.categories = state.categories.filter((item) => item.id !== categoryId);
      state.allocations = state.allocations.filter(
        (allocation) => allocation.categoryId !== categoryId,
      );
    }
    render();
    showToast(hasTransactions ? "Category archived." : "Category removed.");
  } catch (error) {
    console.error(error);
    showToast("Could not remove the category.", "error");
  }
}

function currencySymbol(currency = "SGD") {
  return (
    new Intl.NumberFormat(state.settings.locale, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value || currency
  );
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJson() {
  const backup = {
    format: "budget-cal-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    categories: state.categories,
    allocations: state.allocations,
    transactions: state.transactions,
  };
  downloadFile(
    JSON.stringify(backup, null, 2),
    `budget-cal-backup-${toLocalIsoDate()}.json`,
    "application/json",
  );
  showToast("JSON backup downloaded.");
}

function exportCsv() {
  downloadFile(
    `\uFEFF${transactionsToCsv(state.transactions, state.categories)}`,
    `budget-cal-transactions-${toLocalIsoDate()}.csv`,
    "text/csv;charset=utf-8",
  );
  showToast("Transaction CSV downloaded.");
}

function sanitizeBackup(data) {
  if (!data || data.format !== "budget-cal-backup") {
    throw new Error("This is not a Budget Cal backup file.");
  }
  if (!Array.isArray(data.categories) || !Array.isArray(data.allocations) || !Array.isArray(data.transactions)) {
    throw new Error("The backup is missing required budget data.");
  }

  const categories = data.categories
    .filter((category) => category && typeof category.id === "string" && typeof category.name === "string")
    .map((category) => ({
      id: category.id,
      name: category.name,
      color: /^#[0-9a-f]{6}$/i.test(category.color) ? category.color : CATEGORY_COLORS[0],
      sortOrder: Number.isFinite(Number(category.sortOrder))
        ? Number(category.sortOrder)
        : Number.MAX_SAFE_INTEGER,
      archived: Boolean(category.archived),
      createdAt: category.createdAt || new Date().toISOString(),
      ...(category.archivedAt ? { archivedAt: category.archivedAt } : {}),
    }));

  const categoryIds = new Set(categories.map((category) => category.id));
  const allocations = data.allocations
    .filter(
      (allocation) =>
        allocation &&
        categoryIds.has(allocation.categoryId) &&
        /^\d{4}-\d{2}$/.test(allocation.month) &&
        Number.isFinite(Number(allocation.amountCents)),
    )
    .map((allocation) => ({
      key: createAllocationKey(allocation.month, allocation.categoryId),
      month: allocation.month,
      categoryId: allocation.categoryId,
      amountCents: Math.max(0, Math.round(Number(allocation.amountCents))),
      updatedAt: allocation.updatedAt || new Date().toISOString(),
    }));

  const transactions = data.transactions
    .filter(
      (transaction) =>
        transaction &&
        /^\d{4}-\d{2}-\d{2}$/.test(transaction.date) &&
        ["income", "expense"].includes(transaction.type) &&
        Number.isFinite(Number(transaction.amountCents)) &&
        Number(transaction.amountCents) > 0,
    )
    .map((transaction) => ({
      id: typeof transaction.id === "string" ? transaction.id : createId("transaction"),
      type: transaction.type,
      amountCents: Math.round(Number(transaction.amountCents)),
      date: transaction.date,
      month: transaction.date.slice(0, 7),
      categoryId:
        transaction.type === "expense" && categoryIds.has(transaction.categoryId)
          ? transaction.categoryId
          : null,
      note: typeof transaction.note === "string" ? transaction.note.slice(0, 120) : "",
      createdAt: transaction.createdAt || new Date().toISOString(),
      updatedAt: transaction.updatedAt || transaction.createdAt || new Date().toISOString(),
    }));

  return {
    settings: {
      currency:
        typeof data.settings?.currency === "string" ? data.settings.currency.slice(0, 3) : "SGD",
      locale: typeof data.settings?.locale === "string" ? data.settings.locale : "en-SG",
      startedAt: data.settings?.startedAt || new Date().toISOString(),
    },
    categories,
    allocations,
    transactions,
  };
}

async function importBackupFile(file) {
  const text = await file.text();
  const data = sanitizeBackup(JSON.parse(text));
  if (!window.confirm("Restoring this backup replaces all current local budget data. Continue?")) {
    return;
  }
  await replaceAppData(data);
  await loadState();
  closeModal();
  render();
  showToast("Backup restored.");
}

async function importTransactionsFile(file) {
  const rows = parseCsv(await file.text());
  if (rows.length < 2) {
    throw new Error("The CSV file does not contain any transaction rows.");
  }

  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const requiredHeaders = ["date", "type", "category", "amount"];
  if (requiredHeaders.some((header) => !headers.includes(header))) {
    throw new Error("CSV columns must include: date, type, category, amount.");
  }

  const indexes = Object.fromEntries(headers.map((header, index) => [header, index]));
  const categories = [...state.categories];
  const importedTransactions = [];
  const now = new Date().toISOString();

  for (const [rowIndex, row] of rows.slice(1).entries()) {
    const date = row[indexes.date]?.trim();
    const type = row[indexes.type]?.trim().toLowerCase();
    const amountCents = parseAmountToCents(row[indexes.amount]);
    const categoryText = row[indexes.category]?.trim() || "Imported";
    const note = indexes.note !== undefined ? (row[indexes.note] || "").trim() : "";

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !["income", "expense"].includes(type) || !amountCents) {
      throw new Error(`Invalid CSV data on row ${rowIndex + 2}.`);
    }

    let category = categories.find(
      (item) => item.name.toLowerCase() === categoryText.toLowerCase(),
    );
    if (!category && type === "expense") {
      category = {
        id: createId("category"),
        name: categoryText.slice(0, 40),
        color: CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length],
        sortOrder: Math.max(-1, ...categories.map((item) => item.sortOrder ?? -1)) + 1,
        archived: false,
        createdAt: now,
      };
      categories.push(category);
      await putRecord("categories", category);
    }

    const transaction = {
      id: createId("transaction"),
      type,
      amountCents,
      date,
      month: date.slice(0, 7),
      categoryId: type === "expense" ? category?.id || null : null,
      note: note.slice(0, 120),
      createdAt: now,
      updatedAt: now,
    };
    await putRecord("transactions", transaction);
    importedTransactions.push(transaction);
  }

  state.categories = categories;
  state.transactions.push(...importedTransactions);
  state.selectedMonth = importedTransactions.at(-1)?.month || state.selectedMonth;
  closeModal();
  render();
  showToast(`${importedTransactions.length} transactions imported.`);
}

async function loadState() {
  const data = await loadAppData();
  state.settings = data.settings || defaultSettings();
  state.categories = data.categories;
  state.allocations = data.allocations;
  state.transactions = data.transactions;
}

function bindEvents() {
  document.querySelector("#previous-month").addEventListener("click", () => {
    state.selectedMonth = shiftMonth(state.selectedMonth, -1);
    render();
  });
  document.querySelector("#next-month").addEventListener("click", () => {
    state.selectedMonth = shiftMonth(state.selectedMonth, 1);
    render();
  });
  monthLabel.addEventListener("click", () => {
    state.selectedMonth = currentMonth();
    render();
  });
  document.querySelector("#open-data").addEventListener("click", openDataModal);
  document.querySelector("#modal-close").addEventListener("click", closeModal);

  document.querySelector(".tabbar").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) {
      return;
    }
    state.activeTab = button.dataset.tab;
    render();
  });

  app.addEventListener("click", (event) => {
    const tabTarget = event.target.closest("[data-tab-target]");
    if (tabTarget) {
      state.activeTab = tabTarget.dataset.tabTarget;
      render();
      return;
    }

    const button = event.target.closest("[data-action]");
    if (!button) {
      return;
    }

    const action = button.dataset.action;
    if (action === "add-transaction") {
      openTransactionModal();
    } else if (action === "edit-transaction") {
      openTransactionModal(button.dataset.id);
    } else if (action === "delete-transaction") {
      deleteTransaction(button.dataset.id);
    } else if (action === "edit-budget") {
      openBudgetModal(button.dataset.id);
    } else if (action === "add-category") {
      openCategoryModal();
    } else if (action === "remove-category") {
      removeCategory(button.dataset.id);
    } else if (action === "clear-filters") {
      state.filters = { search: "", type: "all", category: "all" };
      renderTransactions();
    }
  });

  app.addEventListener("input", (event) => {
    if (event.target.id === "transaction-search") {
      state.filters.search = event.target.value;
      renderTransactionResults();
    }
  });

  app.addEventListener("change", (event) => {
    if (event.target.id === "transaction-type-filter") {
      state.filters.type = event.target.value;
      renderTransactionResults();
    }
    if (event.target.id === "transaction-category-filter") {
      state.filters.category = event.target.value;
      renderTransactionResults();
    }
  });

  modalContent.addEventListener("change", (event) => {
    if (event.target.id === "transaction-modal-type") {
      syncTransactionTypeField();
    }
  });

  modalContent.addEventListener("click", (event) => {
    if (event.target.closest("[data-dialog-close]")) {
      closeModal();
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button) {
      return;
    }
    if (button.dataset.action === "export-json") {
      exportJson();
    } else if (button.dataset.action === "export-csv") {
      exportCsv();
    } else if (button.dataset.action === "import-json") {
      state.importMode = "json";
      filePicker.accept = ".json,application/json";
      filePicker.click();
    } else if (button.dataset.action === "import-csv") {
      state.importMode = "csv";
      filePicker.accept = ".csv,text/csv";
      filePicker.click();
    }
  });

  modalContent.addEventListener("submit", async (event) => {
    const form = event.target.closest("form[data-form]");
    if (!form) {
      return;
    }
    event.preventDefault();
    if (form.dataset.form === "transaction") {
      await saveTransaction(form);
    } else if (form.dataset.form === "budget") {
      await saveBudget(form);
    } else if (form.dataset.form === "category") {
      await saveCategory(form);
    }
  });

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeModal();
    }
  });

  filePicker.addEventListener("change", async () => {
    const file = filePicker.files?.[0];
    filePicker.value = "";
    if (!file) {
      return;
    }
    try {
      if (state.importMode === "json") {
        await importBackupFile(file);
      } else if (state.importMode === "csv") {
        await importTransactionsFile(file);
      }
    } catch (error) {
      console.error(error);
      showToast(error.message || "Could not import that file.", "error");
    }
  });

  window.addEventListener("online", updateConnectionStatus);
  window.addEventListener("offline", updateConnectionStatus);
}

function updateConnectionStatus() {
  connectionStatus.textContent = navigator.onLine ? "Offline ready" : "Working offline";
  connectionStatus.classList.toggle("is-offline", !navigator.onLine);
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      console.warn("Offline cache could not be installed.", error);
    });
  }
}

async function init() {
  try {
    const data = await seedDefaults();
    state.settings = data.settings || defaultSettings();
    state.categories = data.categories;
    state.allocations = data.allocations;
    state.transactions = data.transactions;
    bindEvents();
    updateConnectionStatus();
    registerServiceWorker();
    render();
  } catch (error) {
    console.error(error);
    storageStatus.textContent = "Local storage unavailable";
    storageStatus.classList.add("has-error");
    app.innerHTML = `
      <section class="fatal-state">
        <p class="eyebrow">Storage problem</p>
        <h1>Budget Cal could not open its local database.</h1>
        <p>${escapeHtml(error.message || "Check that private browsing or browser storage restrictions are not blocking IndexedDB.")}</p>
        <button class="button button-primary" type="button" onclick="location.reload()">Try again</button>
      </section>
    `;
  }
}

init();
