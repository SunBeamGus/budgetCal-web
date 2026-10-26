import {
  BUDGET_GROUPS,
  CATEGORY_COLORS,
  COMMON_CURRENCIES,
  SUPPORTED_CURRENCIES,
  convertToBaseCents,
  createId,
  currentMonth,
  escapeHtml,
  formatAmountInput,
  formatCurrency,
  formatDate,
  formatMonth,
  formatShortMonth,
  getAssetSummary,
  getBudgetGroupSummary,
  getCategoryRows,
  getMonthSummary,
  getTransactionBaseCents,
  inMonth,
  isValidCurrencyCode,
  moveCategoryOrder,
  normalizeAssetCurrency,
  normalizeCategoryGroup,
  normalizeCurrencyCode,
  normalizeTransactionCurrency,
  parseAmountToCents,
  parseCsv,
  parseExchangeRate,
  shiftMonth,
  sortTransactions,
  toLocalIsoDate,
  transactionsToCsv,
} from "./budget.js";
import {
  createAllocationKey,
  createGroupBudgetKey,
  createWorkspace,
  createWorkspaceInvitation,
  defaultSettings,
  deleteRecord,
  getHostAuthStatus,
  getActiveWorkspaceId,
  getServerPublicOrigin,
  getStorageMode,
  joinWorkspace,
  addPasskey,
  listWorkspaceInvitations,
  listWorkspaceMembers,
  lockHostSession,
  loginHostPasskey,
  loadAppData,
  putRecord,
  putRecordsByStore,
  putRecords,
  registerPasskeyAccount,
  deletePasskey,
  listPasskeys,
  removeWorkspaceMember,
  revokeWorkspaceInvitation,
  setActiveWorkspace,
  updateWorkspaceMemberRole,
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
const accessBanner = document.querySelector("#access-banner");
const workspaceBar = document.querySelector("#workspace-bar");
const workspaceSelect = document.querySelector("#workspace-select");

const state = {
  settings: defaultSettings(),
  categories: [],
  allocations: [],
  transactions: [],
  assets: [],
  groupBudgets: [],
  privacyMode: true,
  storageMode: "browser",
  currentUser: null,
  workspaces: [],
  activeWorkspaceId: "",
  passkeys: [],
  readOnly: false,
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
let categoryOrderSaving = false;
let deferredInstallPrompt = null;
let eventsBound = false;

const ASSET_TYPES = [
  { value: "deposit", label: "Bank deposit", kind: "asset", color: "#3f826d", initial: "D" },
  { value: "cash", label: "Cash", kind: "asset", color: "#d89b35", initial: "C" },
  { value: "investment", label: "Investment", kind: "asset", color: "#3f74a8", initial: "I" },
  { value: "property", label: "House / property", kind: "asset", color: "#d45d3f", initial: "H" },
  { value: "vehicle", label: "Car / vehicle", kind: "asset", color: "#8b68a8", initial: "V" },
  { value: "other_asset", label: "Other asset", kind: "asset", color: "#687a3c", initial: "A" },
  { value: "loan", label: "Loan", kind: "liability", color: "#c35b8d", initial: "L" },
  { value: "credit", label: "Credit / credit card", kind: "liability", color: "#d45d3f", initial: "C" },
  { value: "mortgage", label: "Mortgage", kind: "liability", color: "#976b43", initial: "M" },
  {
    value: "other_liability",
    label: "Other liability",
    kind: "liability",
    color: "#687a8c",
    initial: "O",
  },
];

function money(cents) {
  return state.privacyMode
    ? "***"
    : formatCurrency(cents, state.settings.currency, state.settings.locale);
}

function visibleCurrency(cents, currency) {
  return state.privacyMode
    ? "***"
    : formatCurrency(cents, currency, state.settings.locale);
}

function visiblePercent(value) {
  return state.privacyMode ? "***" : `${Math.round(value)}%`;
}

function visibleRate(value) {
  return state.privacyMode ? "***" : String(value);
}

function originalMoney(transaction) {
  return visibleCurrency(
    transaction.amountCents,
    transaction.currency || state.settings.currency,
  );
}

function hasForeignCurrency(transaction) {
  return normalizeCurrencyCode(transaction.currency, state.settings.currency) !== state.settings.currency;
}

function assetTypeMeta(type) {
  return ASSET_TYPES.find((item) => item.value === type) || ASSET_TYPES[0];
}

function assetOriginalMoney(asset) {
  return visibleCurrency(
    asset.valueCents,
    asset.currency || state.settings.currency,
  );
}

function hasForeignAssetCurrency(asset) {
  return normalizeCurrencyCode(asset.currency, state.settings.currency) !== state.settings.currency;
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

function currencyName(currency) {
  const code = normalizeCurrencyCode(currency);
  try {
    const name = new Intl.DisplayNames([state.settings.locale], {
      type: "currency",
    }).of(code);
    return name && name !== code ? `${code} — ${name}` : code;
  } catch {
    return code;
  }
}

function currencyOptionsMarkup(selectedCurrency) {
  const selected = normalizeCurrencyCode(selectedCurrency);
  const common = [...new Set([state.settings.currency, ...COMMON_CURRENCIES])];
  const commonSet = new Set(common);
  const other = SUPPORTED_CURRENCIES.filter((code) => !commonSet.has(code));
  const option = (code) =>
    `<option value="${escapeHtml(code)}" ${code === selected ? "selected" : ""}>${escapeHtml(currencyName(code))}</option>`;

  return `
    <optgroup label="Common currencies">
      ${common.map(option).join("")}
    </optgroup>
    ${
      other.length
        ? `<optgroup label="All currencies">${other.map(option).join("")}</optgroup>`
        : ""
    }
  `;
}

function activeCategories() {
  return state.categories.filter((category) => !category.archived);
}

function applyStateData(data) {
  const loadedSettings = data.settings || defaultSettings();
  const currency = isValidCurrencyCode(loadedSettings.currency)
    ? normalizeCurrencyCode(loadedSettings.currency)
    : "SGD";
  state.settings = {
    ...defaultSettings(),
    ...loadedSettings,
    key: "settings",
    currency,
  };
  state.categories = data.categories.map((category) => ({
    ...category,
    group: normalizeCategoryGroup(category.group, category.name),
  }));
  state.allocations = data.allocations;
  state.transactions = data.transactions.map((transaction) =>
    normalizeTransactionCurrency(transaction, currency),
  );
  state.assets = (data.assets || []).map((asset) => normalizeAssetCurrency(asset, currency));
  state.groupBudgets = data.groupBudgets || [];
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

function updatePrivacyToggle() {
  const button = document.querySelector("#privacy-toggle");
  const label = document.querySelector("#privacy-toggle-label");
  if (!button || !label) {
    return;
  }
  button.setAttribute("aria-pressed", String(state.privacyMode));
  button.title = state.privacyMode ? "Show financial statistics" : "Hide financial statistics";
  button.classList.toggle("is-revealed", !state.privacyMode);
  label.textContent = state.privacyMode ? "Show" : "Hide";
}

function updateWorkspaceSwitcher() {
  const visible = state.storageMode === "mysql" && state.workspaces.length > 0;
  workspaceBar.hidden = !visible;
  if (!visible) {
    workspaceSelect.innerHTML = "";
    return;
  }
  workspaceSelect.innerHTML = state.workspaces
    .map(
      (workspace) =>
        `<option value="${escapeHtml(workspace.workspaceId)}" ${workspace.workspaceId === state.activeWorkspaceId ? "selected" : ""}>${escapeHtml(workspace.workspaceName)} · ${escapeHtml(workspace.role)}</option>`,
    )
    .join("");
}

function isRunningStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

async function installApp() {
  if (!deferredInstallPrompt) {
    showToast("Use your browser menu to install or add Budget Cal to the home screen.", "error");
    return;
  }
  const prompt = deferredInstallPrompt;
  deferredInstallPrompt = null;
  await prompt.prompt();
  const choice = await prompt.userChoice;
  showToast(
    choice.outcome === "accepted" ? "Budget Cal installation started." : "Installation was dismissed.",
    choice.outcome === "accepted" ? "success" : "error",
  );
}

async function lockHost() {
  try {
    await lockHostSession();
    state.categories = [];
    state.allocations = [];
    state.transactions = [];
    state.assets = [];
    state.groupBudgets = [];
    closeModal();
    const auth = await getHostAuthStatus();
    state.storageMode = "host";
    showAuthGate(auth);
  } catch (error) {
    console.error(error);
    showToast(error.message || "Could not lock host storage.", "error");
  }
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
  const progress = state.privacyMode ? 0 : Math.min(Math.max(row.progress || 0, 0), 100);
  return `
    <div class="progress-track" aria-label="${escapeHtml(row.name)} budget progress ${state.privacyMode ? "hidden" : `${Math.round(row.progress)}%`}">
      <span
        class="progress-value ${row.isOverBudget ? "is-over" : ""}"
        style="width: ${progress}%; --category-color: ${escapeHtml(row.color)}"
      ></span>
    </div>
  `;
}

function render() {
  updatePrivacyToggle();
  updateWorkspaceSwitcher();
  accessBanner.hidden = !state.readOnly;
  accessBanner.textContent = state.readOnly
    ? "Viewer access: this shared budget is read-only."
    : "";
  document.body.classList.toggle("is-read-only", state.readOnly);
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
  } else if (state.activeTab === "assets") {
    renderAssets();
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
    state.groupBudgets,
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
  const progress = state.privacyMode
    ? 0
    : Math.min(Math.max(summary.budgetProgress, 0), 100);

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

    <section class="highlight-grid" aria-label="Financial highlights">
      <article class="highlight-card highlight-cashflow ${summary.netCents < 0 ? "is-negative" : ""}">
        <div class="highlight-topline">
          <span class="highlight-icon">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 17 9 12l3 3 7-8"/><path d="M15 7h4v4"/></svg>
          </span>
          <span>Cash flow</span>
        </div>
        <strong>${money(summary.netCents)}</strong>
        <div class="highlight-footer">
          <span>${money(summary.incomeCents)} income · ${money(summary.expenseCents)} expenses</span>
        </div>
      </article>
      <article class="highlight-card highlight-budget">
        <div class="highlight-topline">
          <span class="highlight-icon">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 19V5m0 14h16M8 16v-4m4 4V8m4 8v-6"/></svg>
          </span>
          <span>Total budget</span>
        </div>
        <strong>${money(summary.plannedCents)}</strong>
        <div class="highlight-footer">
          <span>${money(rows.reduce((sum, row) => sum + row.budgetCents, 0))} category limits</span>
          <button class="text-button" type="button" data-tab-target="budget">Manage</button>
        </div>
      </article>
      <article class="highlight-card highlight-rate ${summary.budgetProgress > 100 ? "is-over" : ""}">
        <div class="highlight-topline">
          <span class="highlight-icon">
            <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>
          </span>
          <span>Spending rate</span>
        </div>
        <strong>${visiblePercent(summary.budgetProgress)}</strong>
        <div class="highlight-rate-track">
          <span style="width: ${state.privacyMode ? 0 : Math.min(summary.budgetProgress, 100)}%"></span>
        </div>
        <div class="highlight-footer">
          <span>${money(summary.expenseCents)} of ${money(summary.plannedCents)}</span>
        </div>
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
        <strong class="${row.isOverBudget ? "negative" : ""}">${visiblePercent(percent)}</strong>
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
        <span>${escapeHtml(isIncome ? "Income" : categoryName(transaction.categoryId))} · ${escapeHtml(formatDate(transaction.date))}${hasForeignCurrency(transaction) ? ` · ${escapeHtml(money(getTransactionBaseCents(transaction)))}` : ""}</span>
      </div>
      <div class="transaction-amount-stack">
        <strong class="transaction-amount ${isIncome ? "income" : ""}">${isIncome ? "+" : "−"}${originalMoney(transaction)}</strong>
        ${hasForeignCurrency(transaction) ? `<small>≈ ${money(getTransactionBaseCents(transaction))}</small>` : ""}
      </div>
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
    state.groupBudgets,
  );
  const categoryCount = rows.filter((row) => row.id !== "uncategorized").length;
  const groups = getBudgetGroupSummary(rows, state.groupBudgets, state.selectedMonth);

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

    <section class="budget-groups" aria-label="Budget totals by category group">
      <div class="budget-groups-heading">
        <div>
          <p class="eyebrow">Total by category group</p>
          <h2>Where the plan goes</h2>
        </div>
        <p>${money(summary.plannedCents)} total planned</p>
      </div>
      <div class="budget-group-grid">
        ${groups.map(renderBudgetGroupSummary).join("")}
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
          ? rows.map((row, index) => renderBudgetRow(row, index, categoryCount)).join("")
          : emptyState(
              "No categories yet",
              "Create categories that match the way you spend.",
              `<button class="button button-secondary" type="button" data-action="add-category">Create a category</button>`,
            )
      }
    </section>
  `;
}

function renderBudgetGroupSummary(group) {
  const progress = state.privacyMode ? 0 : Math.min(Math.max(group.progress, 0), 100);
  return `
    <article class="budget-group-card">
      <div class="budget-group-heading">
        <span class="group-dot" style="--group-color: ${escapeHtml(group.color)}"></span>
        <div>
          <strong>${escapeHtml(group.label)}</strong>
          <small>${group.categoryCount} categor${group.categoryCount === 1 ? "y" : "ies"} · ${money(group.categoryLimitCents)} limits</small>
        </div>
        <strong>${money(group.plannedCents)}</strong>
        <button class="icon-button" type="button" data-action="edit-group-budget" data-id="${escapeHtml(group.id)}" aria-label="Edit ${escapeHtml(group.label)} group budget" title="Edit group budget">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m4 20 4-1 11-11-3-3L5 16l-1 4Z"/><path d="m14 7 3 3"/></svg>
        </button>
      </div>
      <div class="progress-track">
        <span class="progress-value ${group.isOverBudget ? "is-over" : ""}" style="width: ${progress}%; --category-color: ${escapeHtml(group.color)}"></span>
      </div>
      <div class="budget-group-footer">
        <span>${money(group.spentCents)} spent</span>
        <strong class="${group.isOverBudget ? "negative" : ""}">${group.isOverBudget ? `${money(Math.abs(group.remainingCents))} over` : `${money(Math.max(group.remainingCents, 0))} left`}</strong>
      </div>
    </article>
  `;
}

function renderBudgetRow(row, index, categoryCount) {
  const group = BUDGET_GROUPS.find(
    (item) => item.id === normalizeCategoryGroup(row.group, row.name),
  );
  return `
    <article class="budget-row">
      <div class="budget-category">
        <span class="category-swatch" style="--swatch: ${escapeHtml(row.color)}">${escapeHtml(row.name.slice(0, 1))}</span>
        <div>
          <strong>${escapeHtml(row.name)}</strong>
          <small>${escapeHtml(group?.label || "Other")} · ${row.budgetCents > 0 ? `${visiblePercent(row.progress)} used` : "No limit set"}</small>
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
            : `<span class="category-order-controls" aria-label="Reorder ${escapeHtml(row.name)}">
                <button class="icon-button order-button" type="button" data-action="move-category-up" data-id="${escapeHtml(row.id)}" aria-label="Move ${escapeHtml(row.name)} up" title="Move up" ${index === 0 ? "disabled" : ""}>
                  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg>
                </button>
                <button class="icon-button order-button" type="button" data-action="move-category-down" data-id="${escapeHtml(row.id)}" aria-label="Move ${escapeHtml(row.name)} down" title="Move down" ${index === categoryCount - 1 ? "disabled" : ""}>
                  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
                </button>
              </span>
              <button class="icon-button" type="button" data-action="edit-budget" data-id="${escapeHtml(row.id)}" aria-label="Edit ${escapeHtml(row.name)} budget">
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

function renderAssets() {
  const monthSummary = getMonthSummary(
    state.categories,
    state.allocations,
    state.transactions,
    state.selectedMonth,
    state.groupBudgets,
  );
  const summary = getAssetSummary(state.assets, monthSummary.netCents);
  const sortedAssets = [...state.assets].sort(
    (a, b) =>
      String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
      String(a.name).localeCompare(String(b.name)),
  );
  const assets = sortedAssets.filter((asset) => asset.kind === "asset");
  const liabilities = sortedAssets.filter((asset) => asset.kind === "liability");

  app.innerHTML = `
    <section class="page-heading">
      <div>
        <p class="eyebrow">Your financial position</p>
        <h1>Assets & liabilities</h1>
        <p>Track what you own and what you owe. Foreign values are converted using the rates you enter.</p>
      </div>
      <button class="button button-primary" type="button" data-action="add-asset">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        Add item
      </button>
    </section>

    <section class="asset-summary-grid" aria-label="Asset summary">
      <article class="asset-summary-card">
        <span class="asset-summary-label">Total assets</span>
        <strong>${money(summary.totalAssetsCents)}</strong>
        <small>${assets.length + 1} item${assets.length === 0 ? "" : "s"} including cash flow</small>
      </article>
      <article class="asset-summary-card liability">
        <span class="asset-summary-label">Total liabilities</span>
        <strong>${money(summary.totalLiabilitiesCents)}</strong>
        <small>${liabilities.length} item${liabilities.length === 1 ? "" : "s"}</small>
      </article>
      <article class="asset-summary-card net-worth">
        <span class="asset-summary-label">Net worth</span>
        <strong class="${summary.netWorthCents >= 0 ? "positive" : "negative"}">${money(summary.netWorthCents)}</strong>
        <small>Assets minus liabilities</small>
      </article>
    </section>

    <div class="asset-columns">
      <section class="asset-panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Own</p>
            <h2>Assets</h2>
          </div>
          <button class="icon-button" type="button" data-action="add-asset" data-kind="asset" aria-label="Add asset">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>
        ${
          `<div class="asset-list">
            ${renderCashFlowAsset(monthSummary)}
            ${assets.map(renderAssetItem).join("")}
          </div>`
        }
      </section>

      <section class="asset-panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Owe</p>
            <h2>Liabilities</h2>
          </div>
          <button class="icon-button" type="button" data-action="add-asset" data-kind="liability" aria-label="Add liability">
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>
        ${
          liabilities.length
            ? `<div class="asset-list">${liabilities.map(renderAssetItem).join("")}</div>`
            : emptyState(
                "No liabilities added",
                "Add a loan, credit card balance, mortgage, or another debt.",
                `<button class="button button-secondary" type="button" data-action="add-asset" data-kind="liability">Add liability</button>`,
              )
        }
      </section>
    </div>
  `;
}

function renderCashFlowAsset(monthSummary) {
  return `
    <article class="asset-item cash-flow-asset">
      <span class="asset-type-icon cash-flow-icon">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 17 9 12l3 3 7-8"/><path d="M15 7h4v4"/></svg>
      </span>
      <div class="asset-item-main">
        <strong>Cash flow</strong>
        <span>Income minus expenses · ${escapeHtml(formatMonth(state.selectedMonth))}</span>
      </div>
      <div class="asset-item-value">
        <strong class="${monthSummary.netCents >= 0 ? "positive" : "negative"}">${money(monthSummary.netCents)}</strong>
        <small>${money(monthSummary.incomeCents)} income · ${money(monthSummary.expenseCents)} expenses</small>
      </div>
      <span class="quiet-pill">Automatic</span>
    </article>
  `;
}

function renderAssetItem(asset) {
  const type = assetTypeMeta(asset.type);
  const isLiability = asset.kind === "liability";
  return `
    <article class="asset-item">
      <span class="asset-type-icon" style="--swatch: ${escapeHtml(type.color)}">${escapeHtml(type.initial)}</span>
      <div class="asset-item-main">
        <strong>${escapeHtml(asset.name)}</strong>
        <span>${escapeHtml(type.label)}${asset.note ? ` · ${escapeHtml(asset.note)}` : ""}</span>
      </div>
      <div class="asset-item-value">
        <strong class="${isLiability ? "negative" : ""}">${isLiability ? "−" : ""}${money(asset.baseValueCents)}</strong>
        ${
          hasForeignAssetCurrency(asset)
            ? `<small>${assetOriginalMoney(asset)} · 1 ${escapeHtml(asset.currency)} = ${visibleRate(asset.exchangeRate)} ${escapeHtml(state.settings.currency)}</small>`
            : ""
        }
      </div>
      <div class="row-actions">
        <button class="icon-button" type="button" data-action="edit-asset" data-id="${escapeHtml(asset.id)}" aria-label="Edit ${escapeHtml(asset.name)}">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m4 20 4-1 11-11-3-3L5 16l-1 4Z"/><path d="m14 7 3 3"/></svg>
        </button>
        <button class="icon-button danger-hover" type="button" data-action="delete-asset" data-id="${escapeHtml(asset.id)}" aria-label="Delete ${escapeHtml(asset.name)}">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3m2 0-1 13H8L7 7"/><path d="M10 11v5M14 11v5"/></svg>
        </button>
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
        formatCurrency(
          transaction.amountCents,
          transaction.currency || state.settings.currency,
          state.settings.locale,
        ),
        formatCurrency(
          getTransactionBaseCents(transaction),
          state.settings.currency,
          state.settings.locale,
        ),
        transaction.currency,
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
      <div class="transaction-amount-stack" data-label="Amount">
        <strong class="transaction-amount ${isIncome ? "income" : ""}">
          ${isIncome ? "+" : "−"}${originalMoney(transaction)}
        </strong>
        ${hasForeignCurrency(transaction) ? `<small>≈ ${money(getTransactionBaseCents(transaction))}</small>` : ""}
      </div>
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
    ...getMonthSummary(
      state.categories,
      state.allocations,
      state.transactions,
      month,
      state.groupBudgets,
    ),
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
        ${state.privacyMode ? '<p class="privacy-chart-note">*** Statistics hidden</p>' : ""}
        <div class="bar-chart">
          ${series
            .map(
              (item) => `
              <div class="chart-column">
                <div class="chart-value-label">
                  ${item.incomeCents || item.expenseCents ? `<span>${money(item.expenseCents)} spent</span>` : ""}
                </div>
                <div class="chart-bars">
                  <span class="chart-bar income" style="height: ${state.privacyMode ? 0 : Math.max((item.incomeCents / maxValue) * 100, item.incomeCents ? 2 : 0)}%"></span>
                  <span class="chart-bar expense ${item.expenseCents > item.incomeCents && item.incomeCents > 0 ? "warning" : ""}" style="height: ${state.privacyMode ? 0 : Math.max((item.expenseCents / maxValue) * 100, item.expenseCents ? 2 : 0)}%"></span>
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
                      <span>${visiblePercent(monthSummary.expenseCents > 0 ? (row.spentCents / monthSummary.expenseCents) * 100 : 0)} of spending</span>
                    </div>
                    <div class="breakdown-track"><span style="width: ${state.privacyMode ? 0 : Math.max((row.spentCents / maxCategorySpend) * 100, 2)}%; --category-color: ${escapeHtml(row.color)}"></span></div>
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
  const currency = normalizeCurrencyCode(existing?.currency, state.settings.currency);
  const isForeign = currency !== state.settings.currency;

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
      <div class="form-grid currency-form-grid">
        <label>
          <span>Amount</span>
          <div class="money-input">
            <span id="transaction-currency-symbol">${escapeHtml(currencySymbol(currency))}</span>
            <input
              id="transaction-amount"
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
          <span>Currency</span>
          <select
            id="transaction-currency"
            name="currency"
            required
          >
            ${currencyOptionsMarkup(currency)}
          </select>
        </label>
      </div>
      <label id="transaction-exchange-rate-field" ${isForeign ? "" : "hidden"}>
        <span>Exchange rate</span>
        <div class="exchange-rate-input">
          <span id="exchange-rate-from">1 ${escapeHtml(currency)} =</span>
          <input
            id="transaction-exchange-rate"
            name="exchangeRate"
            type="number"
            min="0.00000001"
            step="any"
            inputmode="decimal"
            placeholder="Enter rate"
            value="${escapeHtml(isForeign ? String(existing?.exchangeRate || "") : "")}"
            ${isForeign ? "required" : "disabled"}
          />
          <span>${escapeHtml(state.settings.currency)}</span>
        </div>
        <small>Rates are entered manually and never fetched online.</small>
      </label>
      <div class="conversion-preview" id="transaction-conversion-preview" aria-live="polite" ${isForeign ? "" : "hidden"}></div>
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
  syncTransactionCurrencyFields();
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

function syncTransactionCurrencyFields() {
  const currencyInput = document.querySelector("#transaction-currency");
  const amountInput = document.querySelector("#transaction-amount");
  const rateField = document.querySelector("#transaction-exchange-rate-field");
  const rateInput = document.querySelector("#transaction-exchange-rate");
  const symbol = document.querySelector("#transaction-currency-symbol");
  const rateFrom = document.querySelector("#exchange-rate-from");
  const preview = document.querySelector("#transaction-conversion-preview");
  if (!currencyInput || !amountInput || !rateField || !rateInput || !preview) {
    return;
  }

  const currency = normalizeCurrencyCode(currencyInput.value, "");
  const validCurrency = isValidCurrencyCode(currency);
  const displayCurrency = validCurrency ? currency : normalizeCurrencyCode(currencyInput.value, state.settings.currency);
  const isBase = displayCurrency === state.settings.currency;
  if (symbol) {
    symbol.textContent = currencySymbol(displayCurrency);
  }
  if (rateFrom) {
    rateFrom.textContent = `1 ${displayCurrency} =`;
  }
  rateField.hidden = isBase;
  rateInput.disabled = isBase;
  rateInput.required = !isBase;
  preview.hidden = isBase;

  if (isBase) {
    return;
  }

  const amountCents = parseAmountToCents(amountInput.value);
  const rate = parseExchangeRate(rateInput.value);
  if (!amountCents || !rate) {
    preview.innerHTML = `<span>Enter an amount and exchange rate to preview the converted value.</span>`;
    return;
  }
  preview.innerHTML = `
    <span>Converted amount</span>
    <strong>≈ ${escapeHtml(money(convertToBaseCents(amountCents, rate)))}</strong>
  `;
}

function openAssetModal(assetId = null, defaultKind = "asset") {
  const existing = state.assets.find((asset) => asset.id === assetId);
  const selectedType = ASSET_TYPES.some((type) => type.value === existing?.type)
    ? existing.type
    : ASSET_TYPES.find((type) => type.kind === defaultKind)?.value || "deposit";
  const currency = normalizeCurrencyCode(existing?.currency, state.settings.currency);
  const isForeign = currency !== state.settings.currency;

  modalEyebrow.textContent = existing ? "Update position" : "New position";
  modalTitle.textContent = existing ? "Edit asset or liability" : "Add asset or liability";
  modalContent.innerHTML = `
    <form class="form-stack" data-form="asset" data-id="${escapeHtml(existing?.id || "")}">
      <label>
        <span>Type</span>
        <select id="asset-type" name="type" required>
          <optgroup label="Assets">
            ${ASSET_TYPES.filter((type) => type.kind === "asset")
              .map(
                (type) =>
                  `<option value="${type.value}" ${type.value === selectedType ? "selected" : ""}>${escapeHtml(type.label)}</option>`,
              )
              .join("")}
          </optgroup>
          <optgroup label="Liabilities">
            ${ASSET_TYPES.filter((type) => type.kind === "liability")
              .map(
                (type) =>
                  `<option value="${type.value}" ${type.value === selectedType ? "selected" : ""}>${escapeHtml(type.label)}</option>`,
              )
              .join("")}
          </optgroup>
        </select>
      </label>
      <label>
        <span>Name</span>
        <input
          name="name"
          type="text"
          maxlength="80"
          placeholder="e.g. Emergency savings"
          value="${escapeHtml(existing?.name || "")}"
          required
          autofocus
        />
      </label>
      <div class="form-grid currency-form-grid">
        <label>
          <span>Current value</span>
          <div class="money-input">
            <span id="asset-currency-symbol">${escapeHtml(currencySymbol(currency))}</span>
            <input
              id="asset-value"
              name="value"
              type="number"
              min="0.01"
              step="0.01"
              inputmode="decimal"
              placeholder="0.00"
              value="${escapeHtml(existing ? formatAmountInput(existing.valueCents) : "")}"
              required
            />
          </div>
        </label>
        <label>
          <span>Currency</span>
          <select id="asset-currency" name="currency" required>
            ${currencyOptionsMarkup(currency)}
          </select>
        </label>
      </div>
      <label id="asset-exchange-rate-field" ${isForeign ? "" : "hidden"}>
        <span>Exchange rate</span>
        <div class="exchange-rate-input">
          <span id="asset-exchange-rate-from">1 ${escapeHtml(currency)} =</span>
          <input
            id="asset-exchange-rate"
            name="exchangeRate"
            type="number"
            min="0.00000001"
            step="any"
            inputmode="decimal"
            placeholder="Enter rate"
            value="${escapeHtml(isForeign ? String(existing?.exchangeRate || "") : "")}"
            ${isForeign ? "required" : "disabled"}
          />
          <span>${escapeHtml(state.settings.currency)}</span>
        </div>
        <small>Use the rate that reflects the current estimated value.</small>
      </label>
      <div class="conversion-preview" id="asset-conversion-preview" aria-live="polite" ${isForeign ? "" : "hidden"}></div>
      <label>
        <span>Note <small>Optional</small></span>
        <input name="note" type="text" maxlength="120" placeholder="e.g. Emergency fund" value="${escapeHtml(existing?.note || "")}" />
      </label>
      <div class="form-actions">
        <button class="button button-ghost" type="button" data-dialog-close>Cancel</button>
        <button class="button button-primary" type="submit">${existing ? "Save changes" : "Add item"}</button>
      </div>
    </form>
  `;
  modal.showModal();
  syncAssetCurrencyFields();
}

function syncAssetCurrencyFields() {
  const currencyInput = document.querySelector("#asset-currency");
  const valueInput = document.querySelector("#asset-value");
  const rateField = document.querySelector("#asset-exchange-rate-field");
  const rateInput = document.querySelector("#asset-exchange-rate");
  const symbol = document.querySelector("#asset-currency-symbol");
  const rateFrom = document.querySelector("#asset-exchange-rate-from");
  const preview = document.querySelector("#asset-conversion-preview");
  if (!currencyInput || !valueInput || !rateField || !rateInput || !preview) {
    return;
  }

  const currency = normalizeCurrencyCode(currencyInput.value, state.settings.currency);
  const isBase = currency === state.settings.currency;
  if (symbol) {
    symbol.textContent = currencySymbol(currency);
  }
  if (rateFrom) {
    rateFrom.textContent = `1 ${currency} =`;
  }
  rateField.hidden = isBase;
  rateInput.disabled = isBase;
  rateInput.required = !isBase;
  preview.hidden = isBase;

  if (isBase) {
    return;
  }

  const valueCents = parseAmountToCents(valueInput.value);
  const rate = parseExchangeRate(rateInput.value);
  if (!valueCents || !rate) {
    preview.innerHTML = "<span>Enter a value and exchange rate to preview the converted amount.</span>";
    return;
  }
  preview.innerHTML = `
    <span>Converted value</span>
    <strong>≈ ${escapeHtml(money(convertToBaseCents(valueCents, rate)))}</strong>
  `;
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
        <span>Category group</span>
        <select name="group" required>
          ${BUDGET_GROUPS.map(
            (group) =>
              `<option value="${group.id}" ${normalizeCategoryGroup(category.group, category.name) === group.id ? "selected" : ""}>${escapeHtml(group.label)}</option>`,
          ).join("")}
        </select>
        <small>Group totals show how the overall budget is distributed.</small>
      </label>
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

function openGroupBudgetModal(groupId) {
  const group = BUDGET_GROUPS.find((item) => item.id === groupId);
  if (!group) {
    return;
  }
  const existing = state.groupBudgets.find(
    (budget) => budget.month === state.selectedMonth && budget.groupId === groupId,
  );
  modalEyebrow.textContent = formatMonth(state.selectedMonth);
  modalTitle.textContent = `${group.label} budget`;
  modalContent.innerHTML = `
    <form class="form-stack" data-form="group-budget" data-group-id="${escapeHtml(group.id)}">
      <div class="modal-category-summary">
        <span class="group-dot modal-group-dot" style="--group-color: ${escapeHtml(group.color)}"></span>
        <p>Set the amount you want to allocate to <strong>${escapeHtml(group.label)}</strong> categories this month.</p>
      </div>
      <label>
        <span>Group budget</span>
        <div class="money-input">
          <span>${escapeHtml(currencySymbol(state.settings.currency))}</span>
          <input
            name="amount"
            type="number"
            min="0"
            step="0.01"
            inputmode="decimal"
            placeholder="0.00"
            value="${escapeHtml(existing ? formatAmountInput(existing.amountCents) : "")}"
            required
            autofocus
          />
        </div>
        <small>This value is independent of the individual category limits below it.</small>
      </label>
      <div class="form-actions">
        <button class="button button-ghost" type="button" data-dialog-close>Cancel</button>
        <button class="button button-primary" type="submit">Save group budget</button>
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
        <span>Category group</span>
        <select name="group" required>
          ${BUDGET_GROUPS.map(
            (group) =>
              `<option value="${group.id}" ${group.id === "essentials" ? "selected" : ""}>${escapeHtml(group.label)}</option>`,
          ).join("")}
        </select>
      </label>
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

function openInviteModal() {
  if (state.currentUser?.role !== "owner") {
    showToast("Only the workspace owner can invite members.", "error");
    return;
  }
  modalEyebrow.textContent = "Household access";
  modalTitle.textContent = "Invite a member";
  modalContent.innerHTML = `
    <form class="form-stack" data-form="invite">
      <p class="form-intro">
        Create a one-time invitation link. The invited person will register a passkey and join this shared budget.
      </p>
      <label>
        <span>Role</span>
        <select name="role">
          <option value="editor">Editor — can view and update the budget</option>
          <option value="viewer">Viewer — read-only access</option>
        </select>
      </label>
      <div class="form-actions">
        <button class="button button-ghost" type="button" data-dialog-close>Cancel</button>
        <button class="button button-primary" type="submit">Create invitation</button>
      </div>
    </form>
  `;
  modal.showModal();
}

function renderAdminModal(members, invitations) {
  modalTitle.textContent = "Member control";
  modalContent.innerHTML = `
    <div class="admin-panel">
      <div class="admin-panel-heading">
        <div>
          <p class="eyebrow">${escapeHtml(state.currentUser?.workspaceName || "Workspace")}</p>
          <h3>Members and access</h3>
        </div>
        <button class="button button-primary" type="button" data-action="admin-create-invite">Create invite</button>
      </div>

      <div class="admin-section">
        <h4>Members</h4>
        <div class="admin-list">
          ${members
            .map(
              (member) => `
                <div class="admin-row">
                  <div class="admin-person">
                    <strong>${escapeHtml(member.displayName)}</strong>
                    <span>@${escapeHtml(member.username)}</span>
                  </div>
                  ${
                    member.role === "owner"
                      ? '<span class="role-badge owner">Owner</span>'
                      : `<select class="admin-role-select" data-user-id="${escapeHtml(member.id)}" aria-label="Role for ${escapeHtml(member.displayName)}">
                          <option value="editor" ${member.role === "editor" ? "selected" : ""}>Editor</option>
                          <option value="viewer" ${member.role === "viewer" ? "selected" : ""}>Viewer</option>
                        </select>
                        <button class="icon-button danger-hover" type="button" data-action="admin-remove-member" data-id="${escapeHtml(member.id)}" aria-label="Remove ${escapeHtml(member.displayName)}">
                          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3m2 0-1 13H8L7 7"/></svg>
                        </button>`
                  }
                </div>
              `,
            )
            .join("")}
        </div>
      </div>

      <div class="admin-section">
        <h4>Pending invitations</h4>
        ${
          invitations.length
            ? `<div class="admin-list">${invitations
                .map(
                  (invitation) => `
                    <div class="admin-row">
                      <div class="admin-person">
                        <strong>${escapeHtml(invitation.role)}</strong>
                        <span>Expires ${escapeHtml(new Date(invitation.expiresAt).toLocaleDateString(state.settings.locale))}</span>
                      </div>
                      <button class="text-button" type="button" data-action="admin-revoke-invite" data-id="${escapeHtml(invitation.id)}">Revoke</button>
                    </div>
                  `,
                )
                .join("")}</div>`
            : '<p class="form-intro">No unused invitations.</p>'
        }
      </div>
      <div class="form-actions">
        <button class="button button-ghost" type="button" data-dialog-close>Close</button>
      </div>
    </div>
  `;
  if (!modal.open) modal.showModal();
}

async function openAdminModal() {
  if (state.currentUser?.role !== "owner") {
    showToast("Only the workspace owner can manage members.", "error");
    return;
  }
  if (!modal.open) {
    modalEyebrow.textContent = "Administration";
    modalTitle.textContent = "Member control";
    modalContent.innerHTML = '<p class="form-intro">Loading members…</p>';
    modal.showModal();
  }
  try {
    const [members, invitations] = await Promise.all([
      listWorkspaceMembers(),
      listWorkspaceInvitations(),
    ]);
    renderAdminModal(members, invitations);
  } catch (error) {
    console.error(error);
    showToast(error.message || "Could not load member controls.", "error");
  }
}

function openWorkspaceModal() {
  modalEyebrow.textContent = "Shared budgets";
  modalTitle.textContent = "Create workspace";
  modalContent.innerHTML = `
    <form class="form-stack" data-form="workspace">
      <label>
        <span>Workspace name</span>
        <input name="name" type="text" maxlength="80" placeholder="e.g. Family budget" required autofocus />
      </label>
      <p class="form-intro">You will become the owner and can invite other members to this workspace.</p>
      <div class="form-actions">
        <button class="button button-ghost" type="button" data-dialog-close>Cancel</button>
        <button class="button button-primary" type="submit">Create workspace</button>
      </div>
    </form>
  `;
  modal.showModal();
}

function openAddPasskeyModal() {
  modalEyebrow.textContent = "Account security";
  modalTitle.textContent = "Add a passkey";
  modalContent.innerHTML = `
    <form class="form-stack" data-form="add-passkey">
      <label>
        <span>Passkey name</span>
        <input name="label" type="text" maxlength="80" placeholder="e.g. Work laptop" required autofocus />
      </label>
      <p class="form-intro">
        Use Windows Hello, Touch ID, Face ID, Android screen lock, or another platform authenticator.
      </p>
      <div class="form-actions">
        <button class="button button-ghost" type="button" data-dialog-close>Cancel</button>
        <button class="button button-primary" type="submit">Register passkey</button>
      </div>
    </form>
  `;
  modal.showModal();
}

async function saveAdditionalPasskey(form) {
  const label = String(new FormData(form).get("label") || "").trim();
  if (!label) {
    showToast("Give this passkey a name.", "error");
    return;
  }
  await runFormAction(form, async () => {
    await addPasskey(label);
    state.passkeys = await listPasskeys();
    closeModal();
    render();
    showToast("Passkey added to your account.");
  });
}

async function removePasskey(credentialId) {
  if (!window.confirm("Remove this passkey from your account?")) {
    return;
  }
  try {
    await deletePasskey(credentialId);
    state.passkeys = await listPasskeys();
    render();
    showToast("Passkey removed.");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Could not remove the passkey.", "error");
  }
}

async function saveWorkspace(form) {
  const name = String(new FormData(form).get("name") || "").trim();
  if (!name) {
    showToast("Enter a workspace name.", "error");
    return;
  }
  await runFormAction(form, async () => {
    await createWorkspace(name);
    closeModal();
    await startApplication();
    showToast("Workspace created.");
  });
}

async function createInvitation(form) {
  const role = String(new FormData(form).get("role") || "editor");
  await runFormAction(form, async () => {
    const invitation = await createWorkspaceInvitation(role);
    modalTitle.textContent = "Invitation ready";
    modalContent.innerHTML = `
      <div class="form-stack">
        <p class="form-intro">
          This ${escapeHtml(invitation.role)} invitation expires in seven days and can be used once.
        </p>
        <label>
          <span>Invitation link</span>
          <input id="invitation-link" type="text" readonly value="${escapeHtml(invitation.url)}" />
        </label>
        <div class="form-actions">
          <button class="button button-ghost" type="button" data-dialog-close>Close</button>
          <button class="button button-primary" type="button" data-action="copy-invite">Copy link</button>
        </div>
      </div>
    `;
  });
}

function openDataModal() {
  const hasMonetaryData =
    state.transactions.length > 0 ||
    state.assets.length > 0 ||
    state.allocations.some((allocation) => Number(allocation.amountCents) > 0);
  const installed = isRunningStandalone();
  modalEyebrow.textContent = "Settings and data";
  modalTitle.textContent = "Currency and backups";
  modalContent.innerHTML = `
    <div class="data-panel">
      <div class="local-data-note">
        <span class="local-data-icon">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3 4 7v5c0 5 3.5 8 8 10 4.5-2 8-5 8-10V7l-8-4Z"/><path d="m9 12 2 2 4-4"/></svg>
        </span>
        <div>
          <strong>No cloud account. No tracking.</strong>
          <p>${
            state.storageMode === "mysql"
              ? "This shared household budget is stored in your private MySQL deployment."
              : state.storageMode === "host"
                ? "Your budget is encrypted on this PC and stored locally."
                : "Your budget lives in this browser on this device."
          } Download a backup before changing or clearing storage.</p>
        </div>
      </div>
      ${
        state.storageMode === "mysql"
          ? `<section class="host-security-settings">
              <span class="local-data-icon">
                <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3"/><path d="M5 20c0-4 3-6 7-6s7 2 7 6"/></svg>
              </span>
              <div>
                <strong>${escapeHtml(state.currentUser?.workspaceName || "Shared workspace")}</strong>
                <p>${escapeHtml(state.currentUser?.displayName || "Member")} · ${escapeHtml(state.currentUser?.role || "member")} access</p>
              </div>
              <div class="account-actions">
                <button class="button button-ghost" type="button" data-action="lock-host">Sign out</button>
              </div>
            </section>`
          : state.storageMode === "host"
          ? `<section class="host-security-settings">
              <span class="local-data-icon">
                <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="9" width="14" height="11" rx="3"/><path d="M8 9V7a4 4 0 0 1 8 0v2M12 13v3"/></svg>
              </span>
              <div>
                <strong>Encrypted host storage</strong>
                <p>Your dataset is encrypted on this PC and unlocked with a passkey for this session.</p>
              </div>
              <button class="button button-secondary" type="button" data-action="lock-host">Lock now</button>
            </section>`
          : ""
      }
      ${
        state.storageMode === "mysql"
          ? `<section class="passkey-settings">
              <div class="passkey-settings-heading">
                <div>
                  <strong>Your passkeys</strong>
                  <p>Every passkey signs in to the same account and shared workspaces.</p>
                </div>
                <button class="button button-secondary" type="button" data-action="add-passkey">
                  Add passkey
                </button>
              </div>
              <div class="passkey-list">
                ${state.passkeys
                  .map(
                    (passkey) => `
                      <div class="passkey-item">
                        <span>
                          <strong>${escapeHtml(passkey.label || "Passkey")}</strong>
                          <small>Registered ${escapeHtml(new Date(passkey.createdAt).toLocaleDateString(state.settings.locale))}</small>
                        </span>
                        <button
                          class="icon-button danger-hover"
                          type="button"
                          data-action="delete-passkey"
                          data-id="${escapeHtml(passkey.id)}"
                          aria-label="Delete ${escapeHtml(passkey.label || "passkey")}"
                          ${state.passkeys.length <= 1 ? "disabled" : ""}
                        >
                          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3m2 0-1 13H8L7 7"/></svg>
                        </button>
                      </div>
                    `,
                  )
                  .join("")}
              </div>
            </section>`
          : ""
      }
      <section class="currency-settings">
        <div>
          <strong>Base currency</strong>
          <p>Budgets and reports use this currency. Foreign entries are converted into it.</p>
        </div>
        <form class="inline-settings-form" data-form="settings">
          <select
            name="currency"
            aria-label="Base currency"
            ${hasMonetaryData ? "disabled" : ""}
          >
            ${currencyOptionsMarkup(state.settings.currency)}
          </select>
          <button class="button button-secondary" type="submit" ${hasMonetaryData ? "disabled" : ""}>Save</button>
        </form>
        <small>
          ${
            hasMonetaryData
              ? "The base currency is locked after adding transactions or positive budget limits to prevent mixing incompatible totals."
              : "Choose the base currency before adding budget amounts or transactions."
          }
        </small>
      </section>
      <section class="install-settings">
        <div>
          <strong>Install on this device</strong>
          <p>Add Budget Cal to a PC, tablet, or phone home screen and open it like a native app.</p>
        </div>
        <button
          class="button button-secondary"
          type="button"
          data-action="install-app"
          ${installed || !deferredInstallPrompt ? "disabled" : ""}
        >
          ${installed ? "Installed" : "Install app"}
        </button>
        <small>
          ${
            installed
              ? "Budget Cal is already running as an installed app."
              : deferredInstallPrompt
                ? "Your browser supports one-click installation on this device."
                : "If no install button appears, use your browser menu and choose Install app, Add to Home Screen, or Add to Dock."
          }
        </small>
      </section>
      <div class="data-actions">
        <button class="data-action" type="button" data-action="export-json">
          <span>
            <strong>Full JSON backup</strong>
            <small>Categories, budgets, transactions, and assets</small>
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
  const currency = normalizeCurrencyCode(formData.get("currency"), "");
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
  if (!isValidCurrencyCode(currency)) {
    showToast("Enter a valid three-letter currency code.", "error");
    form.querySelector('[name="currency"]')?.focus();
    return;
  }

  const exchangeRate =
    currency === state.settings.currency
      ? 1
      : parseExchangeRate(formData.get("exchangeRate"));
  if (!exchangeRate) {
    showToast(`Enter the rate from ${currency} to ${state.settings.currency}.`, "error");
    form.querySelector('[name="exchangeRate"]')?.focus();
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
    currency,
    exchangeRate,
    baseAmountCents: convertToBaseCents(amountCents, exchangeRate),
    baseCurrency: state.settings.currency,
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

async function saveAsset(form) {
  const formData = new FormData(form);
  const type = String(formData.get("type") || "");
  const typeDefinition = ASSET_TYPES.find((item) => item.value === type);
  const name = String(formData.get("name") || "").trim();
  const valueCents = parseAmountToCents(formData.get("value"));
  const currency = normalizeCurrencyCode(formData.get("currency"), "");
  const existingId = form.dataset.id;
  const existing = state.assets.find((asset) => asset.id === existingId);

  if (!typeDefinition) {
    showToast("Choose an asset or liability type.", "error");
    return;
  }
  if (!name) {
    showToast("Give this item a name.", "error");
    form.querySelector('[name="name"]')?.focus();
    return;
  }
  if (!valueCents || valueCents <= 0) {
    showToast("Enter a current value greater than zero.", "error");
    form.querySelector('[name="value"]')?.focus();
    return;
  }
  if (!isValidCurrencyCode(currency)) {
    showToast("Choose a valid currency.", "error");
    return;
  }

  const exchangeRate =
    currency === state.settings.currency
      ? 1
      : parseExchangeRate(formData.get("exchangeRate"));
  if (!exchangeRate) {
    showToast(`Enter the rate from ${currency} to ${state.settings.currency}.`, "error");
    form.querySelector('[name="exchangeRate"]')?.focus();
    return;
  }

  const now = new Date().toISOString();
  const record = {
    id: existing?.id || createId("asset"),
    name,
    type,
    kind: typeDefinition.kind,
    valueCents,
    currency,
    exchangeRate,
    baseValueCents: convertToBaseCents(valueCents, exchangeRate),
    baseCurrency: state.settings.currency,
    note: String(formData.get("note") || "").trim(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  await runFormAction(form, async () => {
    await putRecord("assets", record);
    upsert(state.assets, record);
    closeModal();
    render();
    showToast(existing ? "Asset or liability updated." : "Asset or liability added.");
  });
}

async function saveBudget(form) {
  const formData = new FormData(form);
  const amountCents = parseAmountToCents(formData.get("amount"));
  if (amountCents === null) {
    showToast("Enter a valid budget amount.", "error");
    return;
  }
  const categoryId = form.dataset.categoryId;
  const existingCategory = categoryById(categoryId);
  if (!existingCategory) {
    showToast("This category no longer exists.", "error");
    return;
  }
  const updatedCategory = {
    ...existingCategory,
    group: normalizeCategoryGroup(formData.get("group"), existingCategory.name),
    updatedAt: new Date().toISOString(),
  };
  const record = {
    key: createAllocationKey(state.selectedMonth, categoryId),
    month: state.selectedMonth,
    categoryId,
    amountCents,
    updatedAt: new Date().toISOString(),
  };

  await runFormAction(form, async () => {
    await putRecordsByStore({
      categories: [updatedCategory],
      allocations: [record],
    });
    upsert(state.categories, updatedCategory);
    upsertAllocation(record);
    closeModal();
    render();
    showToast("Monthly budget saved.");
  });
}

async function saveGroupBudget(form) {
  const amountCents = parseAmountToCents(new FormData(form).get("amount"));
  if (amountCents === null) {
    showToast("Enter a valid group budget.", "error");
    return;
  }
  const groupId = form.dataset.groupId;
  if (!BUDGET_GROUPS.some((group) => group.id === groupId)) {
    showToast("Choose a valid category group.", "error");
    return;
  }
  const record = {
    key: createGroupBudgetKey(state.selectedMonth, groupId),
    month: state.selectedMonth,
    groupId,
    amountCents,
    updatedAt: new Date().toISOString(),
  };

  await runFormAction(form, async () => {
    await putRecord("groupBudgets", record);
    const index = state.groupBudgets.findIndex((budget) => budget.key === record.key);
    if (index >= 0) {
      state.groupBudgets[index] = record;
    } else {
      state.groupBudgets.push(record);
    }
    closeModal();
    render();
    showToast("Group budget saved.");
  });
}

async function saveSettings(form) {
  const currency = normalizeCurrencyCode(new FormData(form).get("currency"), "");
  if (!isValidCurrencyCode(currency)) {
    showToast("Enter a valid three-letter currency code.", "error");
    form.querySelector('[name="currency"]')?.focus();
    return;
  }

  const hasMonetaryData =
    state.transactions.length > 0 ||
    state.assets.length > 0 ||
    state.allocations.some((allocation) => Number(allocation.amountCents) > 0);
  if (hasMonetaryData && currency !== state.settings.currency) {
    showToast("The base currency is locked while monetary data exists.", "error");
    return;
  }

  const settings = {
    ...state.settings,
    key: "settings",
    currency,
  };
  await runFormAction(form, async () => {
    await putRecord("meta", settings);
    state.settings = settings;
    closeModal();
    render();
    showToast(`Base currency set to ${currency}.`);
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
    group: normalizeCategoryGroup(formData.get("group"), name),
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

async function deleteAsset(assetId) {
  const asset = state.assets.find((item) => item.id === assetId);
  if (!asset) {
    return;
  }
  if (!window.confirm(`Delete "${asset.name}" from your asset list?`)) {
    return;
  }

  try {
    await deleteRecord("assets", assetId);
    state.assets = state.assets.filter((item) => item.id !== assetId);
    render();
    showToast("Asset or liability deleted.");
  } catch (error) {
    console.error(error);
    showToast("Could not delete the asset or liability.", "error");
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

async function moveCategory(categoryId, offset) {
  if (categoryOrderSaving) {
    return;
  }
  const reordered = moveCategoryOrder(state.categories, categoryId, offset);
  if (reordered === state.categories) {
    return;
  }

  categoryOrderSaving = true;
  try {
    await putRecords("categories", reordered);
    state.categories = reordered;
    render();
    showToast(offset < 0 ? "Category moved up." : "Category moved down.");
  } catch (error) {
    console.error(error);
    showToast("Could not save the new category order.", "error");
  } finally {
    categoryOrderSaving = false;
  }
}

function currencySymbol(currency = "SGD") {
  try {
    return (
      new Intl.NumberFormat(state.settings.locale, {
        style: "currency",
        currency: normalizeCurrencyCode(currency),
        currencyDisplay: "narrowSymbol",
      })
        .formatToParts(0)
        .find((part) => part.type === "currency")?.value || currency
    );
  } catch {
    return normalizeCurrencyCode(currency);
  }
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
    version: 4,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    categories: state.categories,
    allocations: state.allocations,
    transactions: state.transactions,
    assets: state.assets,
    groupBudgets: state.groupBudgets,
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
    `\uFEFF${transactionsToCsv(state.transactions, state.categories, state.settings.currency)}`,
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
      group: normalizeCategoryGroup(category.group, category.name),
      archived: Boolean(category.archived),
      createdAt: category.createdAt || new Date().toISOString(),
      ...(category.archivedAt ? { archivedAt: category.archivedAt } : {}),
    }));

  const categoryIds = new Set(categories.map((category) => category.id));
  const requestedBackupCurrency = normalizeCurrencyCode(data.settings?.currency, "SGD");
  const backupCurrency = isValidCurrencyCode(requestedBackupCurrency)
    ? requestedBackupCurrency
    : "SGD";
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
    .map((transaction) => {
      const requestedCurrency = normalizeCurrencyCode(transaction.currency, backupCurrency);
      const currency = isValidCurrencyCode(requestedCurrency) ? requestedCurrency : backupCurrency;
      const exchangeRate =
        currency === backupCurrency ? 1 : parseExchangeRate(transaction.exchangeRate);
      if (!exchangeRate) {
        return null;
      }
      const amountCents = Math.round(Number(transaction.amountCents));
      return {
        id: typeof transaction.id === "string" ? transaction.id : createId("transaction"),
        type: transaction.type,
        amountCents,
        currency,
        exchangeRate,
        baseAmountCents: convertToBaseCents(amountCents, exchangeRate),
        baseCurrency: backupCurrency,
        date: transaction.date,
        month: transaction.date.slice(0, 7),
        categoryId:
          transaction.type === "expense" && categoryIds.has(transaction.categoryId)
            ? transaction.categoryId
            : null,
        note: typeof transaction.note === "string" ? transaction.note.slice(0, 120) : "",
        createdAt: transaction.createdAt || new Date().toISOString(),
        updatedAt: transaction.updatedAt || transaction.createdAt || new Date().toISOString(),
      };
    })
    .filter(Boolean);
  const knownAssetTypes = new Set(ASSET_TYPES.map((type) => type.value));
  const assets = (Array.isArray(data.assets) ? data.assets : [])
    .filter(
      (asset) =>
        asset &&
        knownAssetTypes.has(asset.type) &&
        typeof asset.name === "string" &&
        Number.isFinite(Number(asset.valueCents)) &&
        Number(asset.valueCents) > 0,
    )
    .map((asset) => {
      const type = assetTypeMeta(asset.type);
      const requestedCurrency = normalizeCurrencyCode(asset.currency, backupCurrency);
      const currency = isValidCurrencyCode(requestedCurrency) ? requestedCurrency : backupCurrency;
      const exchangeRate =
        currency === backupCurrency ? 1 : parseExchangeRate(asset.exchangeRate);
      if (!exchangeRate) {
        return null;
      }
      const valueCents = Math.round(Number(asset.valueCents));
      return {
        id: typeof asset.id === "string" ? asset.id : createId("asset"),
        name: asset.name.trim().slice(0, 80),
        type: type.value,
        kind: type.kind,
        valueCents,
        currency,
        exchangeRate,
        baseValueCents: convertToBaseCents(valueCents, exchangeRate),
        baseCurrency: backupCurrency,
        note: typeof asset.note === "string" ? asset.note.slice(0, 120) : "",
        createdAt: asset.createdAt || new Date().toISOString(),
        updatedAt: asset.updatedAt || asset.createdAt || new Date().toISOString(),
      };
    })
    .filter(Boolean);
  const knownGroups = new Set(BUDGET_GROUPS.map((group) => group.id));
  const groupBudgets = (Array.isArray(data.groupBudgets) ? data.groupBudgets : [])
    .filter(
      (budget) =>
        budget &&
        knownGroups.has(budget.groupId) &&
        /^\d{4}-\d{2}$/.test(budget.month) &&
        Number.isFinite(Number(budget.amountCents)),
    )
    .map((budget) => ({
      key: createGroupBudgetKey(budget.month, budget.groupId),
      month: budget.month,
      groupId: budget.groupId,
      amountCents: Math.max(0, Math.round(Number(budget.amountCents))),
      updatedAt: budget.updatedAt || new Date().toISOString(),
    }));

  return {
    settings: {
      currency: backupCurrency,
      locale: typeof data.settings?.locale === "string" ? data.settings.locale : "en-SG",
      startedAt: data.settings?.startedAt || new Date().toISOString(),
    },
    categories,
    allocations,
    transactions,
    assets,
    groupBudgets,
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
    const requestedCurrency =
      indexes.currency !== undefined
        ? normalizeCurrencyCode(row[indexes.currency], "")
        : state.settings.currency;
    const currency = isValidCurrencyCode(requestedCurrency)
      ? requestedCurrency
      : requestedCurrency === ""
        ? state.settings.currency
        : "";
    const exchangeRate =
      currency === state.settings.currency
        ? 1
        : indexes.exchange_rate !== undefined
          ? parseExchangeRate(row[indexes.exchange_rate])
          : null;

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date || "") ||
      !["income", "expense"].includes(type) ||
      !amountCents ||
      !currency ||
      !exchangeRate
    ) {
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
        group: normalizeCategoryGroup("", categoryText),
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
      currency,
      exchangeRate,
      baseAmountCents: convertToBaseCents(amountCents, exchangeRate),
      baseCurrency: state.settings.currency,
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
  applyStateData(data);
}

function bindEvents() {
  if (eventsBound) {
    return;
  }
  eventsBound = true;
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
  workspaceSelect.addEventListener("change", async () => {
    if (!workspaceSelect.value) return;
    setActiveWorkspace(workspaceSelect.value);
    await startApplication();
  });
  document.querySelector("#open-data").addEventListener("click", openDataModal);
  document.querySelector("#privacy-toggle").addEventListener("click", () => {
    state.privacyMode = !state.privacyMode;
    render();
  });
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
    const mutatingActions = new Set([
      "add-transaction",
      "edit-transaction",
      "delete-transaction",
      "add-asset",
      "edit-asset",
      "delete-asset",
      "edit-budget",
      "add-category",
      "remove-category",
      "move-category-up",
      "move-category-down",
      "edit-group-budget",
    ]);
    if (state.readOnly && mutatingActions.has(action)) {
      showToast("Viewer access is read-only.", "error");
      return;
    }
    if (action === "add-transaction") {
      openTransactionModal();
    } else if (action === "edit-transaction") {
      openTransactionModal(button.dataset.id);
    } else if (action === "delete-transaction") {
      deleteTransaction(button.dataset.id);
    } else if (action === "add-asset") {
      openAssetModal(null, button.dataset.kind || "asset");
    } else if (action === "edit-asset") {
      openAssetModal(button.dataset.id);
    } else if (action === "delete-asset") {
      deleteAsset(button.dataset.id);
    } else if (action === "edit-budget") {
      openBudgetModal(button.dataset.id);
    } else if (action === "add-category") {
      openCategoryModal();
    } else if (action === "remove-category") {
      removeCategory(button.dataset.id);
    } else if (action === "move-category-up") {
      moveCategory(button.dataset.id, -1);
    } else if (action === "move-category-down") {
      moveCategory(button.dataset.id, 1);
    } else if (action === "edit-group-budget") {
      openGroupBudgetModal(button.dataset.id);
    } else if (action === "create-invite") {
      openInviteModal();
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
    if (event.target.id === "transaction-currency") {
      syncTransactionCurrencyFields();
    }
    if (event.target.id === "asset-currency") {
      syncAssetCurrencyFields();
    }
    if (event.target.matches(".admin-role-select")) {
      updateWorkspaceMemberRole(
        event.target.dataset.userId,
        event.target.value,
      )
        .then(() => {
          showToast("Member role updated.");
          return openAdminModal();
        })
        .catch((error) => showToast(error.message || "Could not update the role.", "error"));
    }
  });

  modalContent.addEventListener("input", (event) => {
    if (
      event.target.id === "transaction-currency" ||
      event.target.id === "transaction-amount" ||
      event.target.id === "transaction-exchange-rate"
    ) {
      syncTransactionCurrencyFields();
    }
    if (
      event.target.id === "asset-currency" ||
      event.target.id === "asset-value" ||
      event.target.id === "asset-exchange-rate"
    ) {
      syncAssetCurrencyFields();
    }
  });

  modalContent.addEventListener("click", async (event) => {
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
    } else if (button.dataset.action === "manage-members") {
      openAdminModal();
    } else if (button.dataset.action === "admin-create-invite") {
      openInviteModal();
    } else if (button.dataset.action === "admin-remove-member") {
      if (!window.confirm("Remove this member from the workspace?")) return;
      removeWorkspaceMember(button.dataset.id)
        .then(() => {
          showToast("Member removed.");
          return openAdminModal();
        })
        .catch((error) => showToast(error.message || "Could not remove the member.", "error"));
    } else if (button.dataset.action === "admin-revoke-invite") {
      revokeWorkspaceInvitation(button.dataset.id)
        .then(() => {
          showToast("Invitation revoked.");
          return openAdminModal();
        })
        .catch((error) => showToast(error.message || "Could not revoke the invitation.", "error"));
    } else if (button.dataset.action === "create-invite") {
      openInviteModal();
    } else if (button.dataset.action === "add-passkey") {
      openAddPasskeyModal();
    } else if (button.dataset.action === "delete-passkey") {
      removePasskey(button.dataset.id);
    } else if (button.dataset.action === "install-app") {
      installApp();
    } else if (button.dataset.action === "lock-host") {
      lockHost();
    } else if (button.dataset.action === "copy-invite") {
      const link = document.querySelector("#invitation-link");
      if (link) {
        try {
          await navigator.clipboard.writeText(link.value);
          showToast("Invitation link copied.");
        } catch {
          link.select();
          document.execCommand("copy");
          showToast("Invitation link copied.");
        }
      }
    } else if (button.dataset.action === "export-csv") {
      exportCsv();
    } else if (button.dataset.action === "import-json") {
      if (state.readOnly) {
        showToast("Viewer access does not allow imports.", "error");
        return;
      }
      state.importMode = "json";
      filePicker.accept = ".json,application/json";
      filePicker.click();
    } else if (button.dataset.action === "import-csv") {
      if (state.readOnly) {
        showToast("Viewer access does not allow imports.", "error");
        return;
      }
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
    if (
      state.readOnly &&
      ["transaction", "asset", "budget", "category", "group-budget", "settings"].includes(
        form.dataset.form,
      )
    ) {
      showToast("Viewer access is read-only.", "error");
      return;
    }
    if (form.dataset.form === "transaction") {
      await saveTransaction(form);
    } else if (form.dataset.form === "asset") {
      await saveAsset(form);
    } else if (form.dataset.form === "budget") {
      await saveBudget(form);
    } else if (form.dataset.form === "group-budget") {
      await saveGroupBudget(form);
    } else if (form.dataset.form === "category") {
      await saveCategory(form);
    } else if (form.dataset.form === "settings") {
      await saveSettings(form);
    } else if (form.dataset.form === "invite") {
      await createInvitation(form);
    } else if (form.dataset.form === "workspace") {
      await saveWorkspace(form);
    } else if (form.dataset.form === "add-passkey") {
      await saveAdditionalPasskey(form);
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
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    showToast("Budget Cal was installed on this device.");
  });
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

function setStorageStatus(message, error = false) {
  storageStatus.innerHTML = `<span class="status-dot"></span>${escapeHtml(message)}`;
  storageStatus.classList.toggle("has-error", error);
}

function showAuthGate(auth) {
  const isMultiUser = auth.registrationMode !== undefined;
  const inviteFromUrl = new URLSearchParams(location.search).get("invite") || "";
  const inviteFlow = Boolean(inviteFromUrl);
  if (isMultiUser && !auth.registered && !inviteFlow) {
    setStorageStatus("Administrator setup required");
    app.innerHTML = `
      <section class="host-auth-state">
        <span class="host-auth-icon">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 20h16M6 20V9m4 11V9m4 11V9m4 11V9M3 9l9-5 9 5"/></svg>
        </span>
        <p class="eyebrow">System not initialized</p>
        <h1>Set up the administrator</h1>
        <p>The owner account is created separately from the budgeting site.</p>
        <a class="button button-primary" href="./admin/">Open admin console</a>
      </section>
    `;
    return;
  }
  const registered = Boolean(auth.registered) && !inviteFlow;
  const setupMode = auth.registrationMode === "invite" && inviteFlow;
  const action = registered
    ? "Sign in with passkey"
    : isMultiUser
      ? setupMode
        ? "Join household budget"
        : "Create owner account"
      : "Create passkey";
  setStorageStatus(
    state.storageMode === "mysql" ? "Shared MySQL workspace" : "Encrypted host storage",
  );
  app.innerHTML = `
    <section class="host-auth-state">
      <span class="host-auth-icon">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <rect x="5" y="9" width="14" height="11" rx="3"></rect>
          <path d="M8 9V7a4 4 0 0 1 8 0v2M12 13v3"></path>
        </svg>
      </span>
      <p class="eyebrow">${registered ? "Welcome back" : setupMode ? "Invitation" : "Passkey protected"}</p>
      <h1>${registered ? "Sign in to Budget Cal" : setupMode ? "Join the household budget" : "Create your Budget Cal account"}</h1>
      <p>
        ${
          registered
            ? "Enter your username and approve the passkey prompt."
            : "Create a platform passkey using Windows Hello, Touch ID, Face ID, Android screen lock, or another WebAuthn authenticator."
        }
      </p>
      <div class="auth-fields">
        ${
          isMultiUser
            ? `<label class="host-registration-token">
                <span>Username</span>
                <input id="account-username" type="text" autocomplete="username" maxlength="40" required />
              </label>`
            : ""
        }
        ${
          !registered && isMultiUser
            ? `<label class="host-registration-token">
                <span>Display name</span>
                <input id="account-display-name" type="text" autocomplete="name" maxlength="80" required />
              </label>`
            : ""
        }
        ${
          !registered && !setupMode && auth.registrationRequiresToken
            ? `<label class="host-registration-token">
                <span>Server registration token</span>
                <input id="host-registration-token" type="password" autocomplete="off" required />
              </label>`
            : ""
        }
        ${
          !registered && setupMode
            ? `<label class="host-registration-token">
                <span>Invitation code</span>
                <input id="account-invite-token" type="text" autocomplete="off" value="${escapeHtml(inviteFromUrl)}" required />
              </label>`
            : ""
        }
      </div>
      <button class="button button-primary" id="host-passkey-action" type="button">${action}</button>
      ${
        setupMode
          ? '<button class="text-button invite-signin-link" id="invite-existing-account" type="button">Already have an account? Sign in</button>'
          : ""
      }
      <small>
        ${
          registered
            ? "Your passkey authenticates this browser session."
            : setupMode
              ? "Your role in the shared budget is assigned by the invitation."
              : "The first account becomes the workspace owner and can invite other members."
        }
      </small>
    </section>
  `;

  const button = document.querySelector("#host-passkey-action");
  document.querySelector("#invite-existing-account")?.addEventListener("click", () => {
    sessionStorage.setItem("budget-cal-pending-invite", inviteFromUrl);
    history.replaceState({}, "", location.pathname);
    showAuthGate(auth);
  });
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = registered ? "Waiting for passkey…" : "Creating passkey…";
    try {
      if (registered) {
        const username = document.querySelector("#account-username")?.value.trim() || "";
        if (isMultiUser && !username) {
          throw new Error("Enter your username.");
        }
        await loginHostPasskey(username);
      } else {
        const username = document.querySelector("#account-username")?.value.trim() || "";
        const displayName =
          document.querySelector("#account-display-name")?.value.trim() || username;
        if (isMultiUser && (!username || !displayName)) {
          throw new Error("Enter a username and display name.");
        }
        const registrationToken =
          document.querySelector("#host-registration-token")?.value.trim() || "";
        const inviteToken =
          document.querySelector("#account-invite-token")?.value.trim() || "";
        if (auth.registrationRequiresToken && !registrationToken) {
          throw new Error("Enter the server registration token.");
        }
        if (setupMode && !inviteToken) {
          throw new Error("Enter the invitation code.");
        }
        await registerPasskeyAccount({
          username,
          displayName,
          registrationToken,
          inviteToken,
        });
      }
      history.replaceState({}, "", location.pathname);
      await startApplication();
    } catch (error) {
      console.error(error);
      showToast(
        error.name === "NotAllowedError"
          ? "The passkey prompt was dismissed."
          : error.message || "Passkey authentication failed.",
        "error",
      );
      button.disabled = false;
      button.textContent = action;
    }
  });
}

async function showFatalError(error) {
  console.error(error);
  setStorageStatus("Storage unavailable", true);
  app.innerHTML = `
    <section class="fatal-state">
      <p class="eyebrow">Storage problem</p>
      <h1>Budget Cal could not open its data.</h1>
      <p>${escapeHtml(error.message || "Check browser storage and the local Budget Cal server.")}</p>
      <button class="button button-primary" id="fatal-retry" type="button">Try again</button>
    </section>
  `;
  document.querySelector("#fatal-retry")?.addEventListener("click", () => location.reload());
}

function showNoWorkspaceLanding(user) {
  state.currentUser = user;
  state.readOnly = true;
  setStorageStatus(
    user?.isAdmin ? "System administrator" : "No workspace access",
  );
  app.innerHTML = `
    <section class="host-auth-state">
      <span class="host-auth-icon">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 20h16M6 20V9m4 11V9m4 11V9m4 11V9M3 9l9-5 9 5"/></svg>
      </span>
      <p class="eyebrow">${user?.isAdmin ? "System administration" : "Workspace membership required"}</p>
      <h1>${user?.isAdmin ? "Manage Budget Cal separately" : "No workspace access"}</h1>
      <p>
        ${
          user?.isAdmin
            ? "Use the administrator console to create workspaces and invite members. The administrator is not automatically a member of those workspaces."
            : "Ask the system administrator for a workspace invitation."
        }
      </p>
      ${
        user?.isAdmin
          ? '<a class="button button-primary" href="./admin/">Open admin console</a>'
          : '<button class="button button-secondary" id="workspace-signout" type="button">Sign out</button>'
      }
    </section>
  `;
  document.querySelector("#workspace-signout")?.addEventListener("click", async () => {
    await lockHostSession();
    showAuthGate(await getHostAuthStatus());
  });
}

async function startApplication() {
  try {
    if (state.storageMode === "host" || state.storageMode === "mysql") {
      let auth = await getHostAuthStatus();
      if (!auth.authenticated) {
        showAuthGate(auth);
        return;
      }
      if (state.storageMode === "mysql") {
        const pendingInvite =
          new URLSearchParams(location.search).get("invite") ||
          sessionStorage.getItem("budget-cal-pending-invite") ||
          "";
        if (pendingInvite) {
          try {
            await joinWorkspace(pendingInvite);
            auth = await getHostAuthStatus();
            history.replaceState({}, "", location.pathname);
            sessionStorage.removeItem("budget-cal-pending-invite");
            showToast("Joined the shared workspace.");
          } catch (error) {
            showToast(error.message || "Could not join that workspace.", "error");
          }
        }
        state.workspaces = auth.workspaces || [];
        const remembered = getActiveWorkspaceId();
        const selected =
          state.workspaces.find((workspace) => workspace.workspaceId === remembered) ||
          state.workspaces[0];
        if (!selected) {
          state.passkeys = await listPasskeys();
          showNoWorkspaceLanding(auth.user);
          return;
        }
        state.activeWorkspaceId = selected.workspaceId;
        setActiveWorkspace(selected.workspaceId);
        state.currentUser = {
          ...auth.user,
          role: selected.role,
          workspaceId: selected.workspaceId,
          workspaceName: selected.workspaceName,
        };
        state.passkeys = await listPasskeys();
      } else {
        state.currentUser = {
          username: "local-owner",
          displayName: "Local owner",
          role: "owner",
        };
      }
      state.readOnly = state.currentUser.role === "viewer";
    }
    const data = await seedDefaults();
    applyStateData(data);
    bindEvents();
    updateConnectionStatus();
    registerServiceWorker();
    setStorageStatus(
      state.storageMode === "mysql"
        ? `${state.currentUser?.workspaceName || "Shared workspace"} · ${state.currentUser?.role || "member"}`
        : state.storageMode === "host"
          ? "Encrypted on this PC · passkey protected"
        : "Stored only on this device",
    );
    render();
  } catch (error) {
    await showFatalError(error);
  }
}

async function init() {
  try {
    state.storageMode = await getStorageMode();
    const canonicalOrigin = await getServerPublicOrigin();
    if (canonicalOrigin && state.storageMode === "mysql") {
      const currentOrigin = new URL(location.origin).origin;
      if (currentOrigin !== new URL(canonicalOrigin).origin) {
        const canonicalUrl = new URL(
          `${location.pathname}${location.search}${location.hash}`,
          canonicalOrigin,
        );
        location.replace(canonicalUrl.toString());
        return;
      }
    }
    if (state.storageMode === "host" || state.storageMode === "mysql") {
      const auth = await getHostAuthStatus();
      if (!auth.authenticated) {
        showAuthGate(auth);
        return;
      }
    }
    await startApplication();
  } catch (error) {
    await showFatalError(error);
  }
}

init();
