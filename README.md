# check-live-die-reviews

Check whether **Google Maps review links** (`https://maps.app.goo.gl/...`) are still alive, and
optionally write the result back to a Google Sheet.

Built on a simple idea: a review is dead when Google says so — we just need the cheapest way to
read that one signal.

## How it decides

| Status | DOM marker | Meaning |
|---|---|---|
| `ALIVE` | `.rsqaWe` | review panel renders a date |
| `DEAD` | `.PbZDve .HlvSq` | "This review is no longer available" (any locale) |

Text matching is not used: the page language depends on the link/IP, so the same review can render
`a year ago`, `8 tháng trước`, `hace un año`, ...

## Why a browser (and why nothing cheaper works)

Everything below was tested; the conclusion is that **one page load per review is the hard floor**.

| Approach | Result |
|---|---|
| `GET` short link + grep HTML | 200 OK, but the page is a JS shell — the verdict is rendered client-side |
| Googlebot / lite UA | same, verdict still client-side |
| Internal RPC `maps/timeline/_rpc/pc` | returns the review JSON, but 400 without `x-maps-bgkey` + `ei` |
| Replay a captured `x-maps-bgkey` + `ei` | 200 for that exact review, 400 for any other review id (even on the same place) |
| Parse `APP_INITIALIZATION_STATE` | contains viewport/config only, no review data |

`x-maps-bgkey` is a per-page-load BotGuard token bound to the review id, so it can't be minted
offline or shared across links.

## Install

```bash
npm install
npx playwright install chrome   # or use an existing Chrome install (channel: "chrome")
```

## Usage

```bash
node check.js                      # Google Sheet -> check -> write J/K
node check.js --dry                # check, print only
node check.js --force              # ignore the 24h cache
node check.js --links links.json   # ad-hoc list, no Google credentials needed
```

`links.json` is a plain array:

```json
["https://maps.app.goo.gl/xxxx", "https://maps.app.goo.gl/yyyy"]
```

Output for `--links`:

```json
[{ "link": "https://maps.app.goo.gl/xxxx", "status": "ALIVE" }]
```

## Google Sheets mode

1. Create a service account and download its JSON key.
2. Share the spreadsheet with the service account email as **Editor** (Editor, because the tool
   writes the result columns).
3. Copy `config.example.json` to `config.json` and fill in `spreadsheetId`, `sheets`, `credentials`.
4. `node check.js`

The tool writes:

- column `J` — `Tình Trạng Review` = `SỐNG` / `CHẾT` / `?`
- column `K` — `Ngày Check`

Existing columns are never touched. `linksColumn`, `statusColumn` and `dateColumn` are configurable.

## Performance / footprint

Measured on a 4 GB RAM box with Chrome 158:

- ~1.8 s per link wall-clock (2 workers) → 100 links in ~3 minutes cold
- 0 s on a re-run within 24 h (results cached in `state.json`)
- ~300 MB peak RAM: single-process Chrome, images/CSS/fonts/map tiles/analytics blocked,
  persistent profile so the JS bundle is served from disk cache, browser restart every 20 links
- auto-drops to 1 worker when free RAM < `minFreeMB`

## Tuning (`config.json`)

| Key | Default | Meaning |
|---|---|---|
| `concurrency` | 2 | parallel tabs (1–4 is the sweet spot; more gets throttled) |
| `restartEvery` | 20 | links per browser instance before a clean restart |
| `verdictTimeout` | 12000 | ms to wait for the verdict node |
| `minFreeMB` | 700 | RAM guard, drops to 1 worker below this |
| `linksColumn` | 1 | 0-based index of the link column (B) |
| `statusColumn` | `J` | where the status is written |
| `dateColumn` | `K` | where the check date is written |

## Notes

- A `420`/throttle from Google shows up as `UNKNOWN`; the tool retries twice and leaves the cell `?`.
- Killing orphaned headless Chrome is Windows-specific (`powershell`). On macOS/Linux the kill step
  is a no-op; everything else works the same.

## License

MIT
