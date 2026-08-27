# Real Ones — Fantasy Hub

Static site on GitHub Pages. Every number on the page is read from `data.json`;
nothing about the league is hardcoded in the HTML.

## How data gets in

`.github/workflows/sync-espn.yml` runs `scripts/sync-espn.mjs` on a schedule,
which pulls the league from ESPN and commits `data.json`. The page just fetches
that file.

This runs in CI rather than the browser for two reasons: ESPN's fantasy API
sends no CORS headers, so a page on `github.io` can't call it directly, and a
private league needs the `espn_s2` / `SWID` cookies, which a static page has no
safe way to hold.

## Setup (one time)

The league id (`535797493`) is already baked into `scripts/sync-espn.mjs`.
Real Ones is a **private** league — ESPN answers an uncredentialed read with
`401 AUTH_LEAGUE_NOT_VISIBLE` — so the sync needs two cookies to log in as you.

**1. Copy the cookies.** Log into ESPN in a browser, press <kbd>F12</kbd> →
**Application** → Storage → **Cookies** → `https://www.espn.com`. Copy the
*Value* of each:

| Cookie | Looks like |
| --- | --- |
| `espn_s2` | long string, full of `%` escapes |
| `SWID` | `{XXXXXXXX-XXXX-...}`, braces included |

**2. Add them as repository secrets.** Settings → Secrets and variables →
Actions → *Secrets* tab → New repository secret, named `ESPN_S2` and
`ESPN_SWID`. Secrets, not Variables — these are credentials, and GitHub masks
them in logs.

**3. Run it.** Actions → *Sync ESPN league* → Run workflow. After it finishes,
`data.json` is populated and the site shows real records.

These cookies expire every few months. When the sync starts failing with a 401,
re-copy them — that's nearly always the cause.

### Optional overrides

| Name | Kind | Purpose |
| --- | --- | --- |
| `ESPN_LEAGUE_ID` | Variable | point the sync at a different league |
| `ESPN_SEASON` | Variable | pin a season; defaults to the current one |

## Schedule

Hourly on Monday and Tuesday to catch Sunday and Monday night finals, once a
day otherwise. Trigger it by hand any time from the Actions tab.

## Dues

Dues are the one thing ESPN doesn't know about. Toggle them on `admin.html`
(unlisted, commissioner only), which writes only the `paid` field and leaves
everything the sync owns alone. Payments are keyed by ESPN team id, so
renaming a team no longer loses its payment.

## Things you still edit by hand in `data.json`

- `config.duesPerTeam`, `config.skinsPerWeek`, `config.payouts` — league money.
  If the payouts plus the skins reserve don't match the pot, the Prize Pool tab
  says so instead of quietly not adding up.
- `champions` — past season winners. The sync preserves this field.
