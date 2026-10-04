# RowReady

A spreadsheet cleanup workbench built with React and NestJS. Open CSV, TSV, or Excel tables, preview fixes, edit cells, undo changes, export clean data, and download a PDF cleanup report. General cleanup is the default; an optional inventory preset adds specialized checks and transformations. Files are processed in browser Web Workers; the API handles recipe presets and configuration validation only. No login, database, storage service, telemetry, or paid API is required.

## Run locally

Use Node.js **22.12 or newer** (Node 22 LTS is configured in `.nvmrc`) and npm 10 or newer.

```sh
npm ci
npm run dev
```

- App: http://127.0.0.1:5173
- API documentation: http://127.0.0.1:3001/api/docs
- Health check: http://127.0.0.1:3001/api/health

Vite proxies `/api` to NestJS locally. There are no required environment variables for development. The shared package builds when starting development; restart `npm run dev` after changing shared engine code so both apps use the updated build.

## Stack

Stable npm releases checked on October 4, 2026. Exact versions are pinned in workspace manifests and the root lockfile.

| Layer | Packages |
| --- | --- |
| Frontend | React 19.3.0, Vite 8.3.2, TypeScript 7.0.2 |
| Styling | Tailwind CSS 4.3.3, shadcn/ui Button and Dialog, Radix UI 1.6.7, Lucide icons |
| File formats | SheetJS CE 0.20.3, pdf-lib 1.17.1, local Noto Sans fonts |
| Backend | NestJS 12.1.2, Express 5.2.1, Swagger 12.0.2 |
| API compiler | TypeScript 6.0.3, the latest release supported by the Swagger peer dependency |
| Tests | Vitest 5.0.3, Testing Library, Happy DOM, Supertest, Playwright 1.63.0 |
| Deployment | Two Vercel Hobby projects; no database initially |

SheetJS is installed from its official CDN tarball because the npm `xlsx` release is outdated. Excel and PDF libraries are loaded only when needed in the browser worker. Fonts are bundled locally, with no external font service. License notices are available through Help and `apps/web/public/licenses.txt`.

The shadcn components are local source files downloaded from the current `new-york-v4` registry, with imports adapted to this app. They can be customized in `apps/web/src/components/ui`.

## Project structure

```text
apps/
  web/                 React interface, file workers, Excel/PDF exports, component tests
  api/                 NestJS modules, validation, Swagger, HTTP tests
packages/
  shared/              Typed CSV engine, recipes, contracts, data tests
e2e/                  Playwright browser workflows
```

`packages/shared` is a private npm workspace, not a published package. Its compiled exports are shared by the browser bundle and API. Run installs from the repository root; keep one lockfile.

## Commands

```sh
npm run build          # Build shared code, API, and frontend
npm run typecheck      # Check the API and frontend TypeScript
npm test               # Data, state, API-client, React, and HTTP tests
npm run test:e2e        # Chromium browser tests; run build first
npm run versions       # Show installed core framework versions
```

On a new machine, install the browser before running end-to-end checks:

```sh
npx playwright install chromium
```

The browser tests run against the production build and exercise actual Web Workers, API requests, Excel worksheet selection, CSV/XLSX/PDF downloads, malformed imports, and mobile layout. CI installs Chromium with its operating-system dependencies. No Vercel CLI dependency is needed for dashboard deployment.

## Features

- Empty workspace on startup. Open or drop your own file to begin; no demo rows are preloaded.
- UTF-8 CSV/TSV import with comma, semicolon, and tab detection, quoted delimiters, escaped quotes, and multiline cells.
- Excel `.xlsx` import with worksheet selection and a new, single-sheet Excel export of text values.
- PDF cleanup reports with before/after quality, net changes, applied steps, manual edits, and up to 100 remaining review findings.
- Two presets: **General cleanup** for extra spaces and exact duplicates, and **Inventory cleanup** for SKU, category, and price formatting as well. Individual steps can be toggled before previewing.
- Optional tools for selected columns: normalize repeated spaces, change text casing, literal find and replace, and remove duplicates by a chosen key. These tools start off and require column selection.
- Excel formula inspection using each cell's saved result and original formula metadata. No formulas are evaluated, and exports contain values only.
- Staged preview, current/preview comparison, apply/discard, cell editing, search, row filters, pagination, last 20 undo steps, and reset.
- General checks flag extra spaces, exact duplicates, and blank values for review. Blank values may be intentional and are never filled automatically.
- Optional inventory checks flag missing prices, invalid stock, mixed currencies, and conflicting SKUs.
- CSV export with optional spreadsheet-formula protection, enabled by default.
- Offline fallback to bundled presets and local validation when the API is unavailable.
- Optional compatibility with the original host’s five `document.modelContext` tools; registration and callbacks are simulated in tests. Native host support has not been verified for this migration.

## Data rules and limits

Files are limited to **5 MB, 20,000 data rows, and 100 columns**. CSV/TSV inputs must be UTF-8 with unique, nonempty headers and consistent row lengths. Malformed imports leave the current workspace intact.

General cleanup treats every column as text. It does not infer business rules from names such as Price, Stock, or SKU, and does not automatically reformat dates, numbers, letter case, or leading-zero identifiers. Previewed changes become permanent in the current session only when applied. Selected cleaning steps control transformations; the active preset controls which review checks are run.

Optional column tools need explicit configuration. Repeated-space normalization collapses runs of ordinary and nonbreaking spaces while keeping tabs and line breaks. Casing supports lowercase, uppercase, and title case. Find and replace matches literal, case-sensitive text; it does not interpret regular expressions. Review case changes and replacements in the preview before applying them.

Excel import accepts unencrypted `.xlsx` workbooks. Choose one visible worksheet containing a flat table; the first nonempty row becomes its header and empty rows are skipped. A row containing a formula with a saved blank result is retained. Displayed values become text, preserving custom number formats and displayed dates. Error cells, merged cells, hidden worksheets, and formula-based headers are rejected with an actionable message. Use text headers and unmerge cells in Excel before importing. ZIP metadata is checked against a 32 MB expanded-size limit before parsing.

Formula cells import their saved displayed results, which may be outdated. RowReady never calculates formulas or updates dependent cells. The formula inspector retains the source address, formula, and imported result even after editing the current text value. Shared formulas are resolved per cell; array formulas retain the anchor expression and range. A missing saved result, formula error, or unresolved expression stops the import: recalculate and save in Excel, or paste results as values, then try again. Numeric zero, false, and explicitly saved empty string results are supported. The source worksheet XML is checked so an absent cache is never silently converted to zero.

Excel export creates a new workbook containing a `Cleaned data` sheet. All cells are stored as literal text, including formula-like strings, so leading zeros stay intact. Original workbook formatting, formulas, and other sheets are not round-tripped. Cells over Excel’s 32,767-character limit require CSV export instead.

PDF reports reflect committed changes, including undo/reset history; selected but unapplied steps and previews are excluded. The report names the active review profile and uses that same profile for both original and current quality counts. Issue lists are capped at 100 entries with the true total and a truncation notice. Very long labels are shortened explicitly, and characters unavailable in the embedded font are replaced with `?` with a note. These report limits do not modify your data. PDF import is outside this version’s scope.

With **Inventory cleanup**, prices use a decimal point and comma thousands separators. `$1,234.50` becomes `1234.50` when price normalization is selected; ambiguous `12,50` values stay flagged. There is no currency conversion. Mixed currency symbols in one price column block automatic price normalization. Category formatting uses title case; review acronym and brand-name changes before applying.

The inventory profile recognizes headers including SKU / Product Code / Item Code, Category / Department, Price / Unit Price / Cost, and Stock / Quantity / Qty / On Hand. Unknown columns are preserved. A row passing either profile's checks is not a guarantee of business accuracy; review the original records and any requirements of the system receiving your data.

Exact-duplicate removal compares every column after selected transformations and keeps the first match. A shared SKU alone does not cause deletion under the default presets. The optional **Duplicates by column** tool instead compares the selected key columns and retains the first matching row, even if other columns differ. Rows with any blank key value are retained for review. Original row IDs and leading-zero identifiers are preserved. Spreadsheet applications may still infer number types when opening a CSV; import identifier columns as text when leading zeros matter.

Data, history, and previews live in memory. Refreshing or closing the tab ends the session. Export first to keep your changes.

## API and privacy

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Service health |
| `GET /api/recipes` | Presets and operation definitions |
| `GET /api/recipes/:id` | One recipe preset |
| `POST /api/recipes/validate` | Validate `{ "version": 1, "operations": ["trim"] }` |
| `GET /api/docs` | Interactive Swagger documentation |
| `GET /api/docs-json` | OpenAPI document |

The frontend sends only recipe version and operation IDs. Column selections, casing modes, find/replace text, and duplicate-key settings stay local, along with filenames, headers, cell values, formula metadata, and file bytes. None of these enter API requests. The API rejects unknown request fields and limits JSON bodies to 16 KiB. It has no upload endpoint or database.

`WEB_ORIGINS` is an exact, comma-separated CORS allowlist; `PORT` defaults to 3001. NestJS reads these from the process environment (it does not automatically load `.env`). The frontend's optional `VITE_API_URL` is described in `apps/web/.env.example` and is public build-time configuration.

## Vercel deployment

See [docs/VERCEL.md](docs/VERCEL.md) for the two-project setup, shared-package build, environment variables, and free Hobby plan constraints. The desired frontend domain is `row-ready.vercel.app`, subject to availability. This migration has been verified locally and has **not** been deployed to Vercel.
