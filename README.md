# Budget Cal

Budget Cal is a local-first personal budgeting web app. It runs from a small local
web server and stores categories, monthly limits, and transactions in the browser's
IndexedDB database. It has no cloud account, analytics, or runtime dependencies.

## Start the app

Requirements: Node.js 20 or newer.

For the easiest start on Windows, double-click `run.cmd`. It starts the local
server and opens Budget Cal in your default browser. Keep the launcher window
open while using the app and press `Ctrl+C` there when you want to stop it.

If Budget Cal is already running, double-clicking the launcher opens the existing
instance without starting another server.

You can also start it from a terminal:

```powershell
npm start
```

Open [http://localhost:4173](http://localhost:4173). There is no `npm install`
step. Stop the server with `Ctrl+C`.

After the first visit, the service worker caches the application shell. It
continues to open without an internet connection while the local server is
running. Your saved budget data never leaves the browser.

## Current features

- Monthly dashboard with income, spending, cash flow, and remaining budget
- Per-category monthly spending limits
- Expense and income entry with editing and deletion
- Transaction filtering and search
- Six-month cash-flow and category reports
- JSON backup and restore
- CSV transaction export and import
- Responsive layout and installable web-app manifest

## Your data

Budget data is stored under the `budget-cal` IndexedDB database in the browser
profile used to open the app. Use **Data → Full JSON backup** regularly. Clearing
browser site data or the browser profile removes the local copy.

JSON restore replaces the current local dataset after confirmation. CSV import adds
transactions to the current dataset and creates missing expense categories.

## Development

Run the calculation tests:

```powershell
npm test
```

The main files are:

- `src/app.js` — interface, forms, imports, and exports
- `src/store.js` — IndexedDB persistence
- `src/budget.js` — budget calculations and CSV helpers
- `styles.css` — responsive visual design
- `service-worker.js` — offline application cache

The local server binds only to `127.0.0.1`.
