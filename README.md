# Revenue Department, GOs and Circulars

A lightweight website that lets users type a prompt and get the **exact passages** from
Government Orders (G.O.s) and Circulars stored in a public Google Drive folder.

- **Heading:** *Revenue Department, GOs and Circulars*
- **Prompt box:** type any question — a GO number, subject, village, district, or date
- **Reply:** the closest matching passages, quoted exactly, with document name and page number

Source documents: [GOs and Circulars — Google Drive folder](https://drive.google.com/drive/folders/1uUM85UZc3SdEj-l0efUluhaQdaQOltTS)
(contains `GOs and circulars 2024-26.pdf` — 399 pages of Andhra Pradesh Revenue Department orders, 2024–2026).

---

## How it works

1. On startup the server **scans the Drive folder** (via its public `embeddedfolderview` endpoint)
   and lists every PDF found, together with its last-modified date.
2. Each PDF is **downloaded and text-extracted** page-by-page (`pdf-parse`). Extracted text and
   the PDF itself are cached on disk per file, and a **manifest** records each file's name and
   last-modified date.
3. When a prompt is submitted, the server **scores every page** against the prompt:
   - token frequency (longer tokens weighted more), normalized for page length,
   - dot-insensitive matching (`GOMs No30` matches `G.O.Ms.No.30`),
   - ×3 boost for exact query phrases, ×2.5 for the referenced GO number,
   - ×2.2 boost when the query matches a document's own file name.
4. The top 8 matches are returned as exact quoted snippets under the prompt box.

### Reading newly added documents (auto-refresh)

The server keeps watching the Drive folder — no restart needed:

- **Periodic scan:** the folder is re-listed every **5 minutes** (configurable, see below).
- **On-demand scan:** every query also triggers a background re-scan if the last check is
  older than 5 minutes, and the UI has a **⟳ Check Drive now** button.
- **Incremental:** only *new or updated* files (name/last-modified changed) are downloaded and
  re-extracted; unchanged files reuse their cached text instantly.
- **Removals:** files deleted from Drive are dropped from the index on the next scan.
- New documents usually become searchable within seconds of the scan that spots them — watch the
  **Recent activity** feed on the site, or call `POST /api/refresh?wait=1` to force a synchronous scan.

> Note: matching is keyword/phrase based — no AI model is involved, so replies are always exact
> excerpts from the documents.

## Project structure

```
.
├── server.js              # Express server: Drive scan, PDF indexing, search API
├── public/
│   └── index.html         # The website (heading, prompt box, reply area)
├── scripts/
│   └── test-extract.js    # Standalone PDF extraction test
├── package.json
├── render.yaml            # One-click deploy config for Render
└── README.md
```

## Running locally

Requirements: **Node.js 18+** (uses the built-in `fetch`).

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

The first run downloads the PDF (~59 MB) from Drive and indexes it — this takes about
20–30 seconds. The download is cached in your OS temp dir (`go-circulars-cache`), so later
starts are fast. Watch the console for:

```
[index] READY — 398 page chunks searchable.
```

### Configuration (optional)

| Env var | Default | Purpose |
|---------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `DRIVE_FOLDER_ID` | `1uUM85UZc3SdEj-l0efUluhaQdaQOltTS` | Drive folder to scan |
| `AUTO_REFRESH_MS` | `300000` (5 min) | How often to re-list the Drive folder for new documents |

To use a **different Drive folder**, set `DRIVE_FOLDER_ID` — no code changes needed. The folder
must be shared publicly ("Anyone with the link → Viewer").

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | The website |
| `/api/status` | GET | Index status, indexed files, recent sync activity |
| `/api/ask` | POST | `{ "prompt": "G.O.Ms.No.260" }` → exact matches |
| `/api/refresh` | POST | Re-scan Drive now (`?wait=1` synchronous, `?force=1` bypass cooldown) |
| `/api/drive-files` | GET | Live listing of the Drive folder |

Example:

```bash
curl -X POST http://localhost:3000/api/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt":"What is G.O.Ms.No.260 dated 04-05-2026 about?"}'
```

## Publishing on GitHub

1. Create a new repository on GitHub (do **not** add a license/readme through the UI if you
   want to push these files as-is).
2. Then:

```bash
git init
git add .
git commit -m "Revenue Department GOs & Circulars lookup site"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

3. Add topics/description on the repo page for discoverability.

## Hosting options

**GitHub Pages alone is not enough** — it serves static files only, but this app needs a Node
server for the PDF download/extraction/search. Two easy paths:

### Option A — Static frontend on GitHub Pages + Render backend (recommended)

1. Deploy this repo to [Render](https://render.com) (free tier) using the included
   `render.yaml`: **New → Blueprint**, select your repo, and Render reads `render.yaml`.
2. Note the deployed API URL, e.g. `https://your-app.onrender.com`.
3. Publish **only the `public/` folder** to GitHub Pages (see *Deploying the static site* below),
   and set the API base once, either by:
   - setting `window.API_BASE = "https://your-app.onrender.com"` via a small script tag, or
   - adding `<script>/* API base */</script>` customization in `public/index.html`.

The site is fully static-friendly: point the frontend at the remote API and GitHub Pages serves
the UI from `https://<user>.github.io/<repo>/`.

### Option B — Everything on Render (simplest)

Deploy the whole repo to Render with `render.yaml` — the UI and API are served from the same
origin, no CORS or Pages setup needed.

### Deploying the static site to GitHub Pages (Option A)

In your GitHub repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**, then
use this workflow (save as `.github/workflows/pages.yml`):

```yaml
name: Deploy static site to Pages
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: public
      - uses: actions/deploy-pages@v4
        id: deployment
```

### Render notes

- First request after idle may take ~50s on the free tier (cold start) while the PDF is
  re-indexed — the cached download makes this fast if the disk cache survives, otherwise the
  59 MB download happens once.
- Set env var `PORT` is injected by Render automatically.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Index error" at startup | Check the Drive folder is public and the ID is correct |
| "No files found in Drive folder" | Folder empty or listing blocked — open the folder link in a browser to confirm |
| Slow first query | Wait for `[index] READY` in the server console |
| Poor results | Try a GO number (`G.O.Ms.No.575`), a distinctive place name, or a date |

## License

MIT — see [LICENSE](LICENSE).
