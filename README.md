# RowReady

A web-based inventory CSV cleanup workbench. All file processing happens in the visitor's browser. The deployed app has no runtime dependencies, paid APIs, database, account system, telemetry, or server-side file uploads.

## Run locally

Requires Node.js 22 or later.

```sh
npm start
```

Open http://127.0.0.1:4173. No dependency installation is needed to serve the app.

To install the development-only DOM test dependency and run the checks:

```sh
npm ci
npm test
```

## What it does

- Imports UTF-8 CSV or TSV, with comma, semicolon, or tab detection; supports quoted delimiters, escaped quotes, and multiline cells.
- Provides a sample inventory immediately, with no signup.
- Previews trimming, uppercase product codes, consistent category capitalization, price formatting, and exact duplicate removal.
- Compares the current inventory with a staged preview before applying changes.
- Preserves unknown columns, leading-zero identifiers as CSV text, original row IDs, and the original dataset for reset.
- Flags missing prices, invalid stock, mixed currencies, and conflicting product codes for manual review.
- Supports cell editing, search, row filters, pagination, the last 20 undo steps, and reset.
- Exports CSV with optional spreadsheet-formula protection, enabled by default.

## Data rules and limits

Files are limited to 5 MB, 20,000 data rows, and 100 columns. Inputs must be UTF-8 with unique, nonempty headers and consistent row lengths. Malformed files are rejected without replacing the current workspace.

Prices use a decimal point and comma thousands separators. For example, `$1,234.50` becomes `1234.50`. Decimal-comma values such as `12,50` stay flagged; no currency conversion occurs. Mixed currency symbols in one price column block automatic price normalization. Categories use title case; review acronym or brand-name changes before applying.

Recognized inventory headers include SKU / Product Code / Item Code, Category / Department, Price / Unit Price / Cost, and Stock / Quantity / Qty / On Hand. Other columns are retained and can still be trimmed or edited. An issue-free row means it passes these checks; it does not guarantee external inventory-system compatibility.

Duplicate removal compares every column after the selected cleanup steps. A shared SKU alone is never grounds for deletion. The first exact match is retained.

The original data, history, and pending previews live in memory. Refreshing or closing the tab ends the session; export to keep changes. CSV preserves identifier text, but spreadsheet applications may infer number types when opening it. Import identifier columns explicitly as text when leading zeros matter.

## Project structure

- `dist/index.html`: accessible application shell and dialogs
- `dist/styles.css`: responsive workbench styles
- `dist/app.js`: UI, immutable edit history, staged cleanup, import and export
- `dist/data.js`: pure CSV parser, analyzer, transformations, serializer
- `dist/worker.js`: isolated browser-worker parsing and UTF-8 decoding
- `dist/icons.js`: local interface icons
- `tests/`: data-integrity checks and simulated-DOM user journeys
- `server.mjs`: local static development server

`dist/` is the complete static website. It can be hosted on a free static-hosting tier. The package dependencies are only for development tests and are not shipped with the website.

## Verification

Tests exercise malformed input, round-trip CSV preservation, quoted multiline records, leading-zero IDs, price conventions, conflicting SKUs, duplicates, preview/apply/undo, cell editing, search, pagination, download generation, and parsing through a worker thread adapter. DOM checks use Happy DOM, not a full browser rendering engine. Real browser visual QA was unavailable in the build environment.

Optional WebMCP tools are feature-detected and share the UI's actions. Registration and input/state behavior are checked in a simulated DOM. A browser with native WebMCP support was unavailable, so live WebMCP verification remains pending. Normal browser operation does not depend on it.
