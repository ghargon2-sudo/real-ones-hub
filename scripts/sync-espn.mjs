#!/usr/bin/env node
/**
 * Pulls the Real Ones league out of ESPN and writes it to data.json.
 *
 * Runs in CI, not the browser: ESPN's fantasy API sends no CORS headers, and a
 * private league needs the espn_s2 / SWID cookies, which a static page can't
 * attach. Fetching here and committing the result keeps the hub a static site.
 *
 * Env:
 *   ESPN_LEAGUE_ID  (optional) overrides the Real Ones league id below
 *   ESPN_SEASON     (optional) defaults to the current football season
 *   ESPN_S2, ESPN_SWID (required) Real Ones is a private league
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE = join(ROOT, "data.json");

const DEFAULT_LEAGUE_ID = "535797493"; // Real Ones
const LEAGUE_ID = process.env.ESPN_LEAGUE_ID || DEFAULT_LEAGUE_ID;
const S2 = process.env.ESPN_S2 || "";
const SWID = process.env.ESPN_SWID || "";

// The league is private, so ESPN rejects an uncredentialed read outright.
if (!S2 || !SWID) {
  console.error(
    "ESPN_S2 and ESPN_SWID are required — league " + LEAGUE_ID + " is private.\n" +
    "Add them under Settings > Secrets and variables > Actions > Secrets."
  );
  process.exit(1);
}

// The NFL season rolls over in the spring; before ~June we're still reporting
// on last year's league.
function defaultSeason() {
  const now = new Date();
  return now.getMonth() < 5 ? now.getFullYear() - 1 : now.getFullYear();
}
const SEASON = Number(process.env.ESPN_SEASON) || defaultSeason();

const BASE = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}`;
const warnings = [];

function espnHeaders(extra) {
  const headers = {
    accept: "application/json",
    // ESPN 403s requests without a browser-shaped UA.
    "user-agent": "Mozilla/5.0 (compatible; real-ones-hub sync)",
    ...extra,
  };
  if (S2 && SWID) {
    const swid = SWID.startsWith("{") ? SWID : `{${SWID}}`;
    headers.cookie = `espn_s2=${S2}; SWID=${swid}`;
  }
  return headers;
}

async function espnGet(path, { filter } = {}) {
  const url = `${BASE}${path}`;
  const extra = filter ? { "x-fantasy-filter": JSON.stringify(filter) } : undefined;
  const res = await fetch(url, { headers: espnHeaders(extra) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new Error(
        "ESPN returned 401. The league is private and ESPN_S2 / ESPN_SWID are missing or expired."
      );
    }
    throw new Error(`ESPN ${res.status} for ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/* ---------- shaping ---------- */

function teamName(team) {
  // Newer payloads carry `name`; older ones split it into location + nickname.
  const combined = [team.location, team.nickname].filter(Boolean).join(" ").trim();
  return (team.name || combined || `Team ${team.id}`).trim();
}

function managerName(team, membersById) {
  const ownerId = team.primaryOwner || (team.owners && team.owners[0]);
  const member = ownerId ? membersById[ownerId] : null;
  if (!member) return "";
  const full = [member.firstName, member.lastName].filter(Boolean).join(" ").trim();
  return full || member.displayName || "";
}

const ESPN_POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };

/**
 * Each team's roster, with a redraft trade value attached per player (null when
 * the player is outside the value feed's ranked pool). Feeds the trade analyzer.
 */
function shapeRoster(team, valueByEspnId) {
  const entries = (team.roster && team.roster.entries) || [];
  return entries.map((e) => {
    const p = (e.playerPoolEntry && e.playerPoolEntry.player) || {};
    const espnId = String(e.playerId);
    const v = valueByEspnId[espnId];
    return {
      id: e.playerId,
      name: p.fullName || `Player ${espnId}`,
      pos: ESPN_POS[p.defaultPositionId] || "",
      value: v == null ? null : v,
    };
  });
}

function shapeTeams(league, valueByEspnId) {
  const membersById = {};
  for (const m of league.members || []) membersById[m.id] = m;

  return (league.teams || []).map((t) => {
    const overall = (t.record && t.record.overall) || {};
    return {
      id: t.id,
      team: teamName(t),
      manager: managerName(t, membersById),
      abbrev: t.abbrev || "",
      wins: overall.wins || 0,
      losses: overall.losses || 0,
      ties: overall.ties || 0,
      pointsFor: Number((overall.pointsFor ?? 0).toFixed(2)),
      pointsAgainst: Number((overall.pointsAgainst ?? 0).toFixed(2)),
      roster: shapeRoster(t, valueByEspnId),
    };
  });
}

/**
 * Current redraft trade values from FantasyCalc, keyed by ESPN player id.
 * FantasyCalc carries an espnId on every player, so no name-matching is needed.
 * Best effort: on any failure the rosters still sync, just without values.
 */
async function fetchTradeValues() {
  const url =
    "https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=12&ppr=1";
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`FantasyCalc ${res.status}`);
  const list = await res.json();
  const byId = {};
  for (const row of list || []) {
    const p = row.player || {};
    if (p.espnId != null && row.value != null) byId[String(p.espnId)] = row.value;
  }
  return byId;
}

/**
 * Collapses the ESPN schedule into one entry per week holding every team's
 * score, so the hub can compute skins without knowing about matchups.
 */
function shapeWeeks(league, regularSeasonWeeks) {
  const byWeek = new Map();

  for (const game of league.schedule || []) {
    const week = game.matchupPeriodId;
    if (!week || week > regularSeasonWeeks) continue;
    // UNDECIDED means it hasn't finished; a bye has no opponent.
    if (!game.winner || game.winner === "UNDECIDED") continue;

    if (!byWeek.has(week)) byWeek.set(week, []);
    const scores = byWeek.get(week);
    for (const side of [game.home, game.away]) {
      if (!side || side.teamId == null) continue;
      const points = Number(side.totalPoints ?? 0);
      scores.push({ teamId: side.teamId, score: Number(points.toFixed(2)) });
    }
  }

  return [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([week, scores]) => ({ week, scores: scores.sort((a, b) => b.score - a.score) }));
}

/* ---------- transactions (best effort) ---------- */

const TX_ACTION = {
  ADD: "Added",
  DROP: "Dropped",
  LINEUP: "Lineup",
  TRADE_ACCEPT: "Trade",
  TRADE_PROPOSE: "Trade proposed",
  WAIVER: "Waiver claim",
};

async function fetchPlayerNames(playerIds) {
  if (!playerIds.size) return {};
  // Fetch the active-player list and look ids up from it. An id-filtered query
  // against ESPN's player views quietly returns nothing, so instead we pull the
  // active set once (a few hundred KB) and index it — reliable, and we only do
  // it when there are transactions to label.
  const data = await espnGet(`/players?view=players_wl`, {
    filter: { filterActive: { value: true } },
  });
  const list = Array.isArray(data) ? data : data.players || [];
  const names = {};
  for (const entry of list) {
    const p = entry.player || entry;
    if (p && p.id != null && (p.fullName || p.name)) names[p.id] = p.fullName || p.name;
  }
  return names;
}

// Transaction item types we surface on the hub. ESPN ignores a server-side
// filterType on this view, so draft picks, lineup sets and the like all come
// back and have to be dropped here.
const TX_KEEP = new Set(["ADD", "DROP", "WAIVER", "TRADE_ACCEPT"]);

async function shapeTransactions(regularSeasonWeeks) {
  // No filter here: ESPN rejects a limit without a sort on this view, and the
  // unfiltered response already returns the full transaction list, which we
  // trim client-side after dropping draft/lineup noise.
  const data = await espnGet(`/segments/0/leagues/${LEAGUE_ID}?view=mTransactions2`);

  const raw = data.transactions || [];
  const kept = [];
  const playerIds = new Set();
  for (const tx of raw) {
    if (tx.status && tx.status !== "EXECUTED") continue;
    for (const item of tx.items || []) {
      if (!TX_KEEP.has(item.type)) continue; // skip DRAFT, LINEUP, proposals...
      kept.push({ tx, item });
      if (item.playerId != null) playerIds.add(item.playerId);
    }
  }

  let names = {};
  try {
    names = await fetchPlayerNames(playerIds);
  } catch (e) {
    warnings.push(`Could not resolve player names: ${e.message}`);
  }

  const out = kept.map(({ tx, item }) => ({
    date: tx.proposedDate ? new Date(tx.proposedDate).toISOString().slice(0, 10) : "",
    week: tx.scoringPeriodId && tx.scoringPeriodId <= regularSeasonWeeks ? tx.scoringPeriodId : null,
    teamId: item.toTeamId || item.fromTeamId || tx.teamId || null,
    action: TX_ACTION[item.type] || item.type,
    player: names[item.playerId] || (item.playerId ? `Player ${item.playerId}` : ""),
  }));

  out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return out.slice(0, 100);
}

/* ---------- dues carry-over ---------- */

/**
 * Dues are keyed by ESPN team id, which is stable across renames. Carry the
 * previous file's entries forward. An unrecognised key is resolved in order:
 * the current team name, then the manager of whatever team held that id last
 * sync. Manager is the real anchor — team names drift, ids can be reissued, but
 * the person paying doesn't change — so a payment is never silently dropped.
 */
function carryDues(previous, teams) {
  const prevPaid = (previous && previous.paid) || {};
  const prevTeams = (previous && previous.teams) || [];

  const norm = (s) => String(s || "").split(/\s+/).join(" ").trim().toLowerCase();
  const idByName = {};
  const idByMgr = {};
  for (const t of teams) {
    idByName[t.team] = t.id;
    if (t.manager) idByMgr[norm(t.manager)] = t.id;
  }
  // Which manager held each id in the previous file, to follow an id whose
  // team was renamed or whose id ESPN reassigned.
  const prevMgrById = {};
  for (const t of prevTeams) prevMgrById[String(t.id)] = norm(t.manager);

  const paid = {};
  for (const t of teams) paid[t.id] = false;

  for (const [key, value] of Object.entries(prevPaid)) {
    if (Object.prototype.hasOwnProperty.call(paid, key)) {
      paid[key] = !!value; // key is a current team id
    } else if (idByName[key] != null) {
      paid[idByName[key]] = !!value; // legacy name key
    } else if (prevMgrById[key] != null && idByMgr[prevMgrById[key]] != null) {
      paid[idByMgr[prevMgrById[key]]] = !!value; // id changed, same manager
    } else if (idByMgr[norm(key)] != null) {
      paid[idByMgr[norm(key)]] = !!value; // legacy manager-name key
    } else if (value) {
      // Only a *paid* entry going missing is worth shouting about.
      warnings.push(`Could not carry a PAID dues entry for "${key}" — set it again in admin.html.`);
    }
  }
  return paid;
}

/* ---------- main ---------- */

async function main() {
  console.log(`Syncing ESPN league ${LEAGUE_ID}, season ${SEASON}...`);

  const league = await espnGet(
    `/segments/0/leagues/${LEAGUE_ID}?view=mTeam&view=mSettings&view=mMatchupScore&view=mRoster`
  );

  const settings = league.settings || {};
  const schedSettings = settings.scheduleSettings || {};
  const regularSeasonWeeks = schedSettings.matchupPeriodCount || 13;

  let valueByEspnId = {};
  let valuesOk = false;
  try {
    valueByEspnId = await fetchTradeValues();
    valuesOk = Object.keys(valueByEspnId).length > 0;
    if (!valuesOk) warnings.push("Trade values came back empty from FantasyCalc.");
  } catch (e) {
    warnings.push(`Trade values unavailable: ${e.message}`);
  }

  const teams = shapeTeams(league, valueByEspnId);
  if (!teams.length) throw new Error("ESPN returned no teams — check the league id and season.");
  const weeks = shapeWeeks(league, regularSeasonWeeks);

  let transactions = [];
  try {
    transactions = await shapeTransactions(regularSeasonWeeks);
  } catch (e) {
    warnings.push(`Transactions unavailable: ${e.message}`);
  }

  let previous = {};
  try {
    previous = JSON.parse(await readFile(DATA_FILE, "utf8"));
  } catch {
    console.log("No existing data.json — creating one.");
  }

  const status = league.status || {};
  const next = {
    league: {
      id: String(LEAGUE_ID),
      name: settings.name || previous.league?.name || "Real Ones",
      season: SEASON,
      currentWeek: status.currentMatchupPeriod || status.latestScoringPeriod || 0,
      regularSeasonWeeks,
      teamCount: teams.length,
    },
    // League money is our business, not ESPN's — preserve whatever is on file.
    config: previous.config || {
      duesPerTeam: 75,
      skinsPerWeek: 10,
      payouts: [
        { place: "1st place", amount: 465, note: "Winner of Real Ones" },
        { place: "2nd place", amount: 230, note: "Runner-up" },
        { place: "3rd place", amount: 75, note: "Third place" },
      ],
    },
    teams,
    weeks,
    transactions,
    tradeValues: {
      source: "FantasyCalc — redraft, 12-team, PPR, 1QB",
      ok: valuesOk,
      count: Object.keys(valueByEspnId).length,
    },
    paid: carryDues(previous, teams),
    champions: previous.champions || [],
    updatedAt: new Date().toISOString(),
    syncWarnings: warnings,
  };

  await writeFile(DATA_FILE, JSON.stringify(next, null, 2) + "\n", "utf8");

  console.log(
    `Wrote ${teams.length} teams, ${weeks.length} completed week(s), ${transactions.length} transaction(s).`
  );
  for (const w of warnings) console.warn("warning:", w);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
