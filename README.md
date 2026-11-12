# Signal Desk

A personal investment signal dashboard for NGX stocks, oil & FX, US stocks and crypto.

- `index.html` is the web app (served by GitHub Pages).
- `watchlist.json` lists what to track. Edit it to add or remove assets.
- `scripts/update.mjs` + `scripts/engine.mjs` download prices and news, run the model and write `data/`.
- `.github/workflows/update.yml` runs the updater every weekday at 23:17 Lagos time and commits the new data.

## Setup
1. Upload all files, keeping the folders (`scripts/`, `.github/workflows/`).
2. Settings → Pages → Deploy from branch `main`, folder `/ (root)`.
3. Actions tab → enable workflows if asked → **Update Signal Desk data** → **Run workflow**.
4. After about 5 minutes, open your Pages link.

## Adding an asset
Add an entry to `watchlist.json`. For an NGX stock, copy an existing NGX entry and change `id`, `name`, `sym` (`a/NGX-TICKER`) and `news`.
For US stocks use `"source": "sa", "sym": "s/TICKER"`, for ETFs `"e/TICKER"`, and for anything on Yahoo Finance `"source": "yahoo", "sym": "<Yahoo symbol>"`.

## Data sources
stockanalysis.com (unofficial JSON), Yahoo Finance chart API, CoinGecko, Google News RSS and GDELT. These are free and unofficial, so any of them can change without notice. A failed source shows as a warning in the app, and the Action log says which one failed.
