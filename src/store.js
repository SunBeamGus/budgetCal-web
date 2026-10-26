import { DEFAULT_CATEGORIES, createId, currentMonth } from "./budget.js";

const DATABASE_NAME = "budget-cal";
const DATABASE_VERSION = 1;
let databasePromise;

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
  const database = await openDatabase();
  const transaction = database.transaction(["meta", "categories", "allocations", "transactions"]);

  const [metaRows, categories, allocations, transactions] = await Promise.all([
    requestResult(transaction.objectStore("meta").getAll()),
    requestResult(transaction.objectStore("categories").getAll()),
    requestResult(transaction.objectStore("allocations").getAll()),
    requestResult(transaction.objectStore("transactions").getAll()),
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
  };
}

export async function seedDefaults() {
  const data = await loadAppData();
  if (data.settings && data.categories.length > 0) {
    return data;
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
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(record);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  return record;
}

export async function deleteRecord(storeName, key) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).delete(key);
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function replaceAppData({ settings, categories, allocations, transactions }) {
  const database = await openDatabase();
  const transaction = database.transaction(
    ["meta", "categories", "allocations", "transactions"],
    "readwrite",
  );

  const metaStore = transaction.objectStore("meta");
  const categoryStore = transaction.objectStore("categories");
  const allocationStore = transaction.objectStore("allocations");
  const transactionStore = transaction.objectStore("transactions");

  metaStore.clear();
  categoryStore.clear();
  allocationStore.clear();
  transactionStore.clear();

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

  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Import was cancelled."));
  });
}

export function createAllocationKey(month, categoryId) {
  return `${month}:${categoryId}`;
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
