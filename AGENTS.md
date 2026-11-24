# AGENTS.md

## Cursor Cloud specific instructions

### What this project is
A fully client-side static web app: a Russian-language marketplace unit-economics calculator ("YO") for Uzum / WB / Yandex sellers. The entry point is `index.html`, with logic in `script.js`, `finances.js`, `scaleup-yo.js`, and the `wb-*.js` files, plus `style.css`.

### Key facts about the stack
- There is **no build step, no bundler, no `package.json` at the repo root, and no lint/test tooling**. All third-party libraries (Firebase compat SDK, Chart.js, xlsx, jszip, exceljs, jspdf, html2pdf) are loaded from CDNs via `<script>` tags in `index.html`. Do not expect `npm install` / `npm run build` / `npm test` to exist.
- The committed `node_modules/` (only `xlsx` and its deps) is vestigial and not used by the running app or the API function; do not rely on it.
- Firestore is accessed directly from the browser using a hardcoded public web config in `script.js` (project `yoa123`). This connects to the **live/shared cloud Firestore**, so avoid writing throwaway/test documents to product-facing collections. `firestore.rules` currently allows anonymous read/write on the whitelisted collections.

### Running in development
- Serve the repo root as static files, e.g. `python3 -m http.server 8000` (Python 3 is preinstalled), then open `http://localhost:8000/`. This is the dev environment — the app loads all libraries from CDNs and talks directly to live Firestore. Core features (the unit-economics calculator, cost/product management) work with just the static server.
- The single serverless function `api/uzum-proxy.js` (Vercel, CommonJS, uses Node global `fetch`) is a CORS proxy to the Uzum Seller OpenAPI. A plain static server does NOT serve the `/api/*` route, so the optional Uzum sync feature returns 404 under `python3 -m http.server`. To exercise `/api` locally use `vercel dev` (Vercel CLI), which also requires a valid Uzum Seller API key entered in the UI at runtime. This is optional and not needed for core development.

### Lint / test / build
- None configured. There is nothing to lint, test, or build. Validate changes by serving the site and exercising the affected feature in the browser.
