# Budget Cal

Budget Cal is a local-first personal budgeting web app. It runs from a small local
web server and supports browser-local IndexedDB storage or an encrypted dataset on
the host PC. It has no cloud account or analytics. Browser/local modes require no
third-party packages; MySQL mode uses the `mysql2` driver installed by deployment.

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

The unified launcher accepts three modes:

```text
local  PC-only server; data stays in this browser
lan    Local-network access; each browser has separate data
host   One AES-256-GCM encrypted dataset on this PC, unlocked by passkey
```

Windows: `run.cmd local`, `run.cmd lan`, or `run.cmd host`.

macOS/Linux: `sh run.sh local`, `sh run.sh lan`, or `sh run.sh host`.

You can also use `npm run start:local`, `npm run start:lan`, or
`npm run start:host`.

### macOS and Linux

Run the POSIX launcher:

```sh
sh run.sh
```

It starts the local server and opens Budget Cal in the default browser. You can
also run `npm start` directly.

### Phones and tablets on the same network

To let another device open the app from a PC running the server:

```powershell
run.cmd lan
```

On macOS or Linux:

```sh
sh run.sh lan
```

The server prints one or more `Network access` URLs. Open one of those addresses
on the phone or tablet while both devices are on the same trusted network. Stop
the app with `Ctrl+C` when finished.

This local-first app stores data separately in each browser. Changes made on one
device do not automatically appear on another; use the full JSON backup to move
data. LAN access uses ordinary HTTP, so use it only on a trusted network. PWA
installation and offline service-worker support require a secure origin, such as
`localhost` or an HTTPS deployment.

### Encrypted host mode

Start host mode with `run.cmd host`, `sh run.sh host`, or `npm run start:host`.
The first browser visit asks you to create a platform passkey using Windows
Hello, Touch ID, Face ID, Android screen lock, or another WebAuthn authenticator.
Future browser sessions and server restarts require that passkey again.

Host data is written under `host-data/` using AES-256-GCM authenticated
encryption. The passkey gates the local API session and encrypted dataset. A
separate restricted local key file is used by the server to encrypt the dataset;
keep both `host-data/` and JSON backups safe. Host mode is loopback-only and is
not exposed to the local network.

This is local encryption at rest, not cloud synchronization. The service worker
does not cache the financial API, so encrypted host mode requires the local
server to be running.

### Shared multi-user MySQL mode

MySQL mode supports multiple invitation-managed shared workspaces. Each user can
switch between invited workspaces, and each workspace has independent data,
members, invitations, and roles:

The system administrator uses a separate console at `/admin/`. Successful
bootstrap registration creates the global administrator but does not
automatically add that account to a workspace. The administrator can therefore
manage users and invitations without receiving access to household financial
data. Administrator access to a workspace state is possible only through normal
workspace membership.

- **Owner** — manages passkey invitations and can edit the budget
- **Editor** — can view and update the shared budget
- **Viewer** — has read-only access

The first administrator is created at `/admin/` with
`BUDGET_CAL_REGISTRATION_TOKEN`. Once an account exists, public account
registration is disabled. The administrator creates workspaces and one-time
invitation links from the admin console. Existing users can sign in from an
invitation link and join that workspace as an additional membership.

Every account can register multiple passkeys from **Data → Your passkeys**. All
passkeys authenticate the same account and therefore point to the same set of
workspace memberships. At least one passkey must remain on the account.

The separate administrator console can:

- List users, passkey counts, and workspace memberships
- Disable or re-enable non-admin users
- Create workspaces without joining them
- List all workspace members
- Change an editor to viewer or a viewer to editor
- Remove non-owner members
- List and revoke unused invitation codes
- Generate new editor/viewer invitations

Only the global administrator can access these administration endpoints. Editors
can change budget data, while viewers are prevented from writing both in the
interface and by the server.

MySQL stores users, passkey credentials, workspaces, memberships, invitations,
and encrypted workspace state in separate tables. Each workspace state is
encrypted with AES-256-GCM using a key derived from the protected
`/etc/budget-cal/master.key`. API writes are checked against the logged-in
user's role, and viewer updates are rejected by the server.

Production database setup:

```sh
sudo bash deploy/linux/install-mysql.sh
```

The database connection URL and encryption key location are stored in the
root-only `/etc/budget-cal/budget-cal.env`. Back up both the MySQL `budget_cal`
database and `/etc/budget-cal/master.key`; losing the key makes encrypted
workspace data unrecoverable.

### Deploy to Ubuntu/Linux

Linux production files are under `deploy/linux/`. The current Ubuntu deployment
uses:

- `/opt/budget-cal` for read-only application files
- `/var/lib/budget-cal` for encrypted host data
- `/etc/budget-cal/budget-cal.env` for protected runtime configuration
- `/etc/budget-cal/certs` for the Nginx certificate chain and private key
- `budget-cal.service` for the Node application
- Nginx for HTTP-to-HTTPS redirect, TLS termination, and reverse proxying

After uploading the application archive and deployment files:

```sh
sudo bash /tmp/budget-cal-install-server.sh /tmp/budget-cal-deploy.tar.gz
sudo bash /tmp/budget-cal-install-certificate.sh \
  /tmp/sunbeamgus.top_nginx.zip /tmp/nginx.conf
```

Verify the deployment:

```sh
systemctl status budget-cal nginx
sudo nginx -t
curl -I https://sunbeamgus.top/
```

Read the one-time passkey registration token through SSH:

```sh
sudo cat /etc/budget-cal/registration-token.txt
```

The currently installed TrustAsia certificate expires on **24 January 2027**.
HTTP-01 validation is affected by network interference on this server, so renew
with a DNS-01 challenge from DNSPod or replace the supplied certificate bundle
before expiry.

### Install as an app

Budget Cal includes desktop and mobile install metadata. Open **Data → Install on
this device** for device-specific guidance. Chrome and Edge may show a one-click
install button; Safari users can choose **Add to Home Screen** or **Add to Dock**.

Open [http://localhost:4173](http://localhost:4173). There is no `npm install`
step. Stop the server with `Ctrl+C`.

After the first visit, the service worker caches the application shell. It
continues to open without an internet connection while the local server is
running. Your saved budget data never leaves the browser.

## Current features

- Monthly dashboard with income, spending, cash flow, and remaining budget
- Per-category monthly spending limits
- Overall budget totals separated into Essentials, Lifestyle, Financial, and
  Other category groups
- Independently editable monthly budget for each category group
- Accessible up/down controls for arranging categories, saved across reloads
- Expense and income entry with editing and deletion
- Multiple transaction currencies converted into one base currency
- Offline, manually entered exchange rates with live conversion previews
- Asset and liability tracking with deposits, investments, property, vehicles,
  loans, credit balances, and mortgages
- Base-currency asset totals and a net-worth summary
- Automatic cash-flow asset based on monthly income minus expenses
- Privacy-first statistics that display `***` until explicitly revealed
- Transaction filtering and search
- Six-month cash-flow and category reports
- JSON backup and restore
- CSV transaction export and import
- Responsive layout and installable web-app manifest

## Your data

In `local` and `lan` modes, data is stored under the `budget-cal` IndexedDB
database in each browser profile. Clearing browser site data removes that local
copy.

In `host` mode, the dataset is encrypted in `host-data/budget-cal.enc.json` and
requires the registered passkey. Keep the complete `host-data/` directory safe;
the local key file is required to decrypt the dataset.

Use **Data → Full JSON backup** regularly in every mode.

JSON restore replaces the current local dataset after confirmation. CSV import adds
transactions to the current dataset and creates missing expense categories.

## Assets and liabilities

The **Assets** tab tracks things you own and owe. Each item has a type, name,
current value, currency, optional note, and an offline exchange rate when it uses
a foreign currency.

Assets include bank deposits, cash, investments, houses/property, vehicles, and
other assets. Liabilities include loans, credit or credit-card balances,
mortgages, and other debts. Budget Cal shows total assets, total liabilities, and
net worth in the base currency. Assets are included in full JSON backups.

The Assets tab also includes an automatic **Cash flow** item. It is calculated
from the selected month's income minus expenses and is included in total assets;
it is not manually editable.

## Budget groups

Each of the four budget groups has its own editable monthly budget. The overall
budget is the sum of those four user-defined group budgets. Individual category
limits remain editable and are shown as secondary reference values.

Financial statistics are hidden as `***` by default, including amounts,
percentages, exchange rates, progress bars, and report chart proportions. Use the
header **Show** button to reveal or hide them.

## Multiple currencies

Choose the base currency under **Data → Base currency** before adding budget
amounts or transactions. Budget limits, dashboard totals, and reports use that
base currency.

Each transaction can use any valid three-letter currency code. The currency menu
prioritises SGD, CNY, USD, HKD, EUR, GBP, JPY, MYR and other common currencies,
with the full ISO list available below them. For a foreign currency, enter how
many base-currency units equal one unit of that currency.
Budget Cal stores the original amount, currency, rate, and converted base amount.
No exchange rates are downloaded, so the app continues to work fully offline.

The base currency is locked once transactions or positive budget limits exist.
This avoids silently mixing incompatible converted totals. CSV exports include
`currency` and `exchange_rate` columns; older CSVs without those columns remain
importable using the current base currency.

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

The local server binds only to `127.0.0.1` unless LAN mode is explicitly enabled.
