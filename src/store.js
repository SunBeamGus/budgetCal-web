import { DEFAULT_CATEGORIES, createId, currentMonth } from "./budget.js";

const DATABASE_NAME = "budget-cal";
const DATABASE_VERSION = 3;
let databasePromise;
let serverConfigPromise;
let hostStatePromise;
let currentStorageMode;
let activeWorkspaceId = localStorage.getItem("budget-cal-active-workspace") || "";

function isServerStorage(mode) {
  return mode === "host" || mode === "mysql";
}

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function fromBase64url(value) {
  const normalized = String(value).replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64url(value) {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function loadServerConfig() {
  if (!serverConfigPromise) {
    serverConfigPromise = (async () => {
      try {
        const response = await fetch("/api/config", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (response.ok) {
          const config = await response.json();
          if (config?.app === "Budget Cal") {
            localStorage.setItem("budget-cal-storage-mode", config.storage);
            return config;
          }
        }
      } catch {
        // Static hosting without the local API falls back to IndexedDB.
      }
      if (isServerStorage(localStorage.getItem("budget-cal-storage-mode"))) {
        throw new Error("The Budget Cal server is unavailable. Start the configured storage mode.");
      }
      localStorage.setItem("budget-cal-storage-mode", "browser");
      return { app: "Budget Cal", storage: "browser" };
    })();
  }
  return serverConfigPromise;
}

export async function getStorageMode() {
  if (!currentStorageMode) {
    currentStorageMode = (await loadServerConfig()).storage;
  }
  return currentStorageMode;
}

export async function getServerPublicOrigin() {
  const config = await loadServerConfig();
  return config.publicOrigin || "";
}

async function hostRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(path === "/api/state" && activeWorkspaceId
        ? { "X-Budget-Cal-Workspace": activeWorkspaceId }
        : {}),
      ...(options.headers || {}),
    },
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The caller handles an empty or malformed error response.
  }
  if (!response.ok) {
    throw new Error(payload?.error || `Host request failed (${response.status}).`);
  }
  return payload;
}

export async function getHostAuthStatus() {
  return hostRequest("/api/auth/status");
}

export async function registerPasskeyAccount({
  username,
  displayName,
  registrationToken = "",
  inviteToken = "",
}) {
  if (!window.PublicKeyCredential || !navigator.credentials?.create) {
    throw new Error("This browser does not support passkeys.");
  }
  const options = await hostRequest("/api/auth/register/options", {
    method: "POST",
    headers: registrationToken
      ? { "X-Budget-Cal-Registration-Token": registrationToken }
      : {},
    body: JSON.stringify({
      username,
      displayName,
      registrationToken,
      inviteToken,
    }),
  });
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: fromBase64url(options.challenge),
      user: { ...options.user, id: fromBase64url(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((item) => ({
        ...item,
        id: fromBase64url(item.id),
      })),
    },
  });
  if (!credential) {
    throw new Error("Passkey creation was cancelled.");
  }
  await hostRequest("/api/auth/register/verify", {
    method: "POST",
    headers: registrationToken
      ? { "X-Budget-Cal-Registration-Token": registrationToken }
      : {},
    body: JSON.stringify({
      credential: {
        id: credential.id,
        type: credential.type,
        response: {
          clientDataJSON: toBase64url(credential.response.clientDataJSON),
          attestationObject: toBase64url(credential.response.attestationObject),
          transports:
            typeof credential.response.getTransports === "function"
              ? credential.response.getTransports()
              : [],
        },
      },
    }),
  });
  hostStatePromise = null;
}

export async function loginHostPasskey(username = "") {
  if (!window.PublicKeyCredential || !navigator.credentials?.get) {
    throw new Error("This browser does not support passkeys.");
  }
  const options = await hostRequest("/api/auth/login/options", {
    method: "POST",
    body: JSON.stringify({ username }),
  });
  const credential = await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: fromBase64url(options.challenge),
      allowCredentials: (options.allowCredentials || []).map((item) => ({
        ...item,
        id: fromBase64url(item.id),
      })),
    },
  });
  if (!credential) {
    throw new Error("Passkey authentication was cancelled.");
  }
  await hostRequest("/api/auth/login/verify", {
    method: "POST",
    body: JSON.stringify({
      credential: {
        id: credential.id,
        type: credential.type,
        response: {
          authenticatorData: toBase64url(credential.response.authenticatorData),
          clientDataJSON: toBase64url(credential.response.clientDataJSON),
          signature: toBase64url(credential.response.signature),
          userHandle: credential.response.userHandle
            ? toBase64url(credential.response.userHandle)
            : null,
        },
      },
    }),
  });
  hostStatePromise = null;
}

export async function listPasskeys() {
  const result = await hostRequest("/api/auth/passkeys");
  return result.passkeys || [];
}

export async function addPasskey(label) {
  if (!window.PublicKeyCredential || !navigator.credentials?.create) {
    throw new Error("This browser does not support passkeys.");
  }
  const options = await hostRequest("/api/auth/passkeys/options", {
    method: "POST",
    body: JSON.stringify({ label }),
  });
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: fromBase64url(options.challenge),
      user: { ...options.user, id: fromBase64url(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((item) => ({
        ...item,
        id: fromBase64url(item.id),
      })),
    },
  });
  if (!credential) {
    throw new Error("Passkey creation was cancelled.");
  }
  await hostRequest("/api/auth/passkeys/verify", {
    method: "POST",
    body: JSON.stringify({
      credential: {
        id: credential.id,
        type: credential.type,
        response: {
          clientDataJSON: toBase64url(credential.response.clientDataJSON),
          attestationObject: toBase64url(credential.response.attestationObject),
          transports:
            typeof credential.response.getTransports === "function"
              ? credential.response.getTransports()
              : [],
        },
      },
    }),
  });
}

export async function deletePasskey(credentialId) {
  await hostRequest(`./api/auth/passkeys/${encodeURIComponent(credentialId)}`, {
    method: "DELETE",
  });
}

export async function lockHostSession() {
  await hostRequest("/api/auth/logout", {
    method: "POST",
    body: "{}",
  });
  hostStatePromise = null;
}

export async function createWorkspaceInvitation(role = "editor") {
  return hostRequest("/api/workspace/invitations", {
    method: "POST",
    body: JSON.stringify({ role, workspaceId: activeWorkspaceId }),
  });
}

export async function listWorkspaceMembers() {
  const result = await hostRequest("/api/workspace/members", {
    headers: { "X-Budget-Cal-Workspace": activeWorkspaceId },
  });
  return result.members || [];
}

export async function updateWorkspaceMemberRole(userId, role) {
  await hostRequest(`./api/workspace/members/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { "X-Budget-Cal-Workspace": activeWorkspaceId },
    body: JSON.stringify({ role }),
  });
}

export async function removeWorkspaceMember(userId) {
  await hostRequest(`./api/workspace/members/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: { "X-Budget-Cal-Workspace": activeWorkspaceId },
  });
}

export async function listWorkspaceInvitations() {
  const result = await hostRequest("/api/workspace/invitations", {
    headers: { "X-Budget-Cal-Workspace": activeWorkspaceId },
  });
  return result.invitations || [];
}

export async function revokeWorkspaceInvitation(invitationId) {
  await hostRequest(
    `./api/workspace/invitations/${encodeURIComponent(invitationId)}`,
    {
      method: "DELETE",
      headers: { "X-Budget-Cal-Workspace": activeWorkspaceId },
    },
  );
}

export async function createWorkspace(name) {
  const workspace = await hostRequest("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  setActiveWorkspace(workspace.workspaceId);
  return workspace;
}

export async function joinWorkspace(inviteToken) {
  const workspace = await hostRequest("/api/workspace/join", {
    method: "POST",
    body: JSON.stringify({ inviteToken }),
  });
  setActiveWorkspace(workspace.workspaceId);
  return workspace;
}

export function setActiveWorkspace(workspaceId) {
  activeWorkspaceId = workspaceId;
  localStorage.setItem("budget-cal-active-workspace", workspaceId);
  hostStatePromise = null;
}

export function getActiveWorkspaceId() {
  return activeWorkspaceId;
}

async function ensureHostState() {
  if (!hostStatePromise) {
    hostStatePromise = hostRequest("/api/state");
  }
  return hostStatePromise;
}

async function saveHostState(state) {
  await hostRequest("/api/state", {
    method: "PUT",
    headers: { "X-Budget-Cal-Request": "save" },
    body: JSON.stringify(state),
  });
  hostStatePromise = Promise.resolve(state);
}

async function mutateHostState(mutator) {
  const current = await ensureHostState();
  const next = clone(current);
  mutator(next);
  await saveHostState(next);
  return next;
}

function upsertHostRecord(storeName, state, record) {
  if (storeName === "meta") {
    state.settings = record;
    return;
  }
  const keyName =
    storeName === "allocations" || storeName === "groupBudgets" ? "key" : "id";
  const index = state[storeName].findIndex((item) => item[keyName] === record[keyName]);
  if (index >= 0) {
    state[storeName][index] = record;
  } else {
    state[storeName].push(record);
  }
}

function deleteHostRecord(storeName, state, key) {
  if (storeName === "meta") {
    state.settings = null;
    return;
  }
  const keyName =
    storeName === "allocations" || storeName === "groupBudgets" ? "key" : "id";
  state[storeName] = state[storeName].filter((item) => item[keyName] !== key);
}

export function openDatabase() {
  if (!("indexedDB" in globalThis)) {
    return Promise.reject(new Error("This browser does not support local database storage."));
  }

  if (databasePromise) {
    return databasePromise;
  }

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains("meta")) {
        database.createObjectStore("meta", { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains("categories")) {
        database.createObjectStore("categories", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("allocations")) {
        const allocations = database.createObjectStore("allocations", { keyPath: "key" });
        allocations.createIndex("month", "month", { unique: false });
      }
      if (!database.objectStoreNames.contains("transactions")) {
        const transactions = database.createObjectStore("transactions", { keyPath: "id" });
        transactions.createIndex("month", "month", { unique: false });
        transactions.createIndex("date", "date", { unique: false });
      }
      if (!database.objectStoreNames.contains("assets")) {
        database.createObjectStore("assets", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("groupBudgets")) {
        const groupBudgets = database.createObjectStore("groupBudgets", { keyPath: "key" });
        groupBudgets.createIndex("month", "month", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the local database."));
  });

  return databasePromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadAppData() {
  if (isServerStorage(await getStorageMode())) {
    return clone(await ensureHostState());
  }
  const database = await openDatabase();
  const transaction = database.transaction([
    "meta",
    "categories",
    "allocations",
    "transactions",
    "assets",
    "groupBudgets",
  ]);

  const [metaRows, categories, allocations, transactions, assets, groupBudgets] = await Promise.all([
    requestResult(transaction.objectStore("meta").getAll()),
    requestResult(transaction.objectStore("categories").getAll()),
    requestResult(transaction.objectStore("allocations").getAll()),
    requestResult(transaction.objectStore("transactions").getAll()),
    requestResult(transaction.objectStore("assets").getAll()),
    requestResult(transaction.objectStore("groupBudgets").getAll()),
  ]);

  return {
    settings: metaRows.find((row) => row.key === "settings") || null,
    categories: categories.sort(
      (a, b) =>
        (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
        String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
        a.name.localeCompare(b.name),
    ),
    allocations,
    transactions,
    assets,
    groupBudgets,
  };
}

export async function seedDefaults() {
  const data = await loadAppData();
  if (data.settings && data.categories.length > 0) {
    return data;
  }

  if (isServerStorage(await getStorageMode())) {
    const now = new Date().toISOString();
    const settings =
      data.settings || {
        key: "settings",
        currency: "SGD",
        locale: "en-SG",
        startedAt: now,
      };
    const categories =
      data.categories.length > 0
        ? data.categories
        : DEFAULT_CATEGORIES.map((category, index) => ({
            id: createId("category"),
            ...category,
            sortOrder: index,
            archived: false,
            createdAt: now,
          }));
    await putRecordsByStore({
      meta: [settings],
      categories,
    });
    return loadAppData();
  }

  const database = await openDatabase();
  const transaction = database.transaction(["meta", "categories"], "readwrite");
  const metaStore = transaction.objectStore("meta");
  const categoryStore = transaction.objectStore("categories");

  if (!data.settings) {
    metaStore.put({
      key: "settings",
      currency: "SGD",
      locale: "en-SG",
      startedAt: new Date().toISOString(),
    });
  }

  if (data.categories.length === 0) {
    for (const [index, category] of DEFAULT_CATEGORIES.entries()) {
      categoryStore.put({
        id: createId("category"),
        ...category,
        sortOrder: index,
        archived: false,
        createdAt: new Date().toISOString(),
      });
    }
  }

  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Setup was cancelled."));
  });

  return loadAppData();
}

export async function putRecord(storeName, record) {
  if (isServerStorage(await getStorageMode())) {
    await mutateHostState((state) => upsertHostRecord(storeName, state, record));
    return record;
  }
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(record);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  return record;
}

export async function putRecords(storeName, records) {
  if (isServerStorage(await getStorageMode())) {
    await mutateHostState((state) => {
      for (const record of records) {
        upsertHostRecord(storeName, state, record);
      }
    });
    return;
  }
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  const store = transaction.objectStore(storeName);
  for (const record of records) {
    store.put(record);
  }
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function putRecordsByStore(recordsByStore) {
  if (isServerStorage(await getStorageMode())) {
    await mutateHostState((state) => {
      for (const [storeName, records] of Object.entries(recordsByStore)) {
        for (const record of records) {
          upsertHostRecord(storeName, state, record);
        }
      }
    });
    return;
  }
  const storeNames = Object.keys(recordsByStore);
  const database = await openDatabase();
  const transaction = database.transaction(storeNames, "readwrite");
  for (const storeName of storeNames) {
    const store = transaction.objectStore(storeName);
    for (const record of recordsByStore[storeName]) {
      store.put(record);
    }
  }
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Changes were cancelled."));
  });
}

export async function deleteRecord(storeName, key) {
  if (isServerStorage(await getStorageMode())) {
    await mutateHostState((state) => deleteHostRecord(storeName, state, key));
    return;
  }
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).delete(key);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function replaceAppData({
  settings,
  categories,
  allocations,
  transactions,
  assets = [],
  groupBudgets = [],
}) {
  if (isServerStorage(await getStorageMode())) {
    const nextState = {
      settings: { key: "settings", ...settings },
      categories,
      allocations,
      transactions,
      assets,
      groupBudgets,
    };
    await saveHostState(nextState);
    return;
  }
  const database = await openDatabase();
  const transaction = database.transaction(
    ["meta", "categories", "allocations", "transactions", "assets", "groupBudgets"],
    "readwrite",
  );

  const metaStore = transaction.objectStore("meta");
  const categoryStore = transaction.objectStore("categories");
  const allocationStore = transaction.objectStore("allocations");
  const transactionStore = transaction.objectStore("transactions");
  const assetStore = transaction.objectStore("assets");
  const groupBudgetStore = transaction.objectStore("groupBudgets");

  metaStore.clear();
  categoryStore.clear();
  allocationStore.clear();
  transactionStore.clear();
  assetStore.clear();
  groupBudgetStore.clear();

  metaStore.put({ key: "settings", ...settings });
  for (const category of categories) {
    categoryStore.put(category);
  }
  for (const allocation of allocations) {
    allocationStore.put(allocation);
  }
  for (const item of transactions) {
    transactionStore.put(item);
  }
  for (const asset of assets) {
    assetStore.put(asset);
  }
  for (const groupBudget of groupBudgets) {
    groupBudgetStore.put(groupBudget);
  }

  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Import was cancelled."));
  });
}

export function createAllocationKey(month, categoryId) {
  return `${month}:${categoryId}`;
}

export function createGroupBudgetKey(month, groupId) {
  return `${month}:${groupId}`;
}

export function defaultSettings() {
  return {
    key: "settings",
    currency: "SGD",
    locale: "en-SG",
    startedAt: new Date().toISOString(),
  };
}

export function makeDemoMonth() {
  return currentMonth();
}
