# TSLA / SPCX dashboard

- `index.html` is the dashboard.
- `scripts/update.mjs` fetches earnings dates (Yahoo / Nasdaq), SEC filings (EDGAR), Google News headlines and daily prices.
- `.github/workflows/update-feed.yml` runs it every weekday after the US close and at 8 am ET, and saves `data/feed.json`.

## Setup (one time)
1. Create a new public GitHub repository and upload everything in this folder, including the hidden `.github` folder.
2. Settings → Secrets and variables → Actions → New repository secret: name `SEC_UA`, value `Your Name your@email.com` (the SEC asks for contact info).
3. Settings → Pages → Deploy from branch → `main`, folder `/ (root)`. The dashboard will be at `https://<username>.github.io/<repo>/`.
4. Actions tab → enable workflows → "Update dashboard feed" → Run workflow, to fill the feed the first time.
