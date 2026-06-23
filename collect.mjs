/*
 * LoR Meta Collector
 * -------------------
 * Sbírá ranked standard zápasy z Riot LoR API, páruje decky na archetypy
 * (championi z deck_code + regiony z pole factions) a ukládá denní buckety
 * matchup winratů + počtů her decků.
 *
 * Běží v GitHub Actions na cronu. Stav (frontier, navštívené puuids,
 * zpracované match IDs, denní buckety, champ mapa) je v JSONBinu, aby byl
 * sběr resumable mezi běhy. Výstup data/stats.json čte frontend na Pages.
 *
 * ENV (GitHub Actions Secrets):
 *   RIOT_API_KEY     - schválený "Race to 1k LP" klíč (non-expiring)
 *   JSONBIN_KEY      - JSONBin X-Master-Key
 *   JSONBIN_BIN_ID   - ID binu pro stav
 *
 * Spuštění:  node collect.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG_PATH = path.join(process.cwd(), 'config.json');
const STATS_PATH = path.join(process.cwd(), 'data', 'stats.json');

const DEFAULT_CONFIG = {
  regions: ['europe', 'americas', 'asia'],   // clustery
  gameTypeAllow: ['Ranked'],      // ověř v logu DISTINCT a uprav podle reality
  maxWindowDays: 21,              // kolik dní bucketů držet (14d + rezerva na patch)
  patchStart: '2026-06-03',       // začátek aktuálního patche (uprav každý patch)
  maxRequestsPerRun: 200,         // celkový backstop (rate limiter + MD cap jsou primární)
  maxMatchDetailsPerRun: 15,      // detailů zápasů/běh (×6 běhů/hod = 90, pod 100/hod)
  maxMatchesPerPuuid: 5,          // radši víc hráčů než hodně zápasů jednoho
  maxFrontier: 6000,              // strop velikosti crawl fronty na region
  maxProcessedIds: 120000,        // strop dedup setu (FIFO prune)
  champRefreshHours: 168,         // jak často obnovovat champ mapu z Data Dragon
  seeds: {                        // bootstrap účty per region (Name#TAG)
    europe: [],
    americas: [],
    asia: []
  },
  dataDragonSets: [
    'set1','set2','set3','set4','set5','set6','set6cde',
    'set7','set7b','set8','set9','set10','set11','set12'
  ]
};

// ---------------------------------------------------------------------------
// Rate limiter: respektuje 30 req / 10 s a 500 req / 10 min + per-run cap
// ---------------------------------------------------------------------------
class RateLimiter {
  constructor(maxRun, windows) {
    this.maxRun = maxRun;
    this.used = 0;
    // windows: [{ ms, max }] — sleduje časy requestů v každém okně
    this.windows = windows.map(w => ({ ms: w.ms, max: w.max, hits: [] }));
  }
  async take() {
    if (this.used >= this.maxRun) {
      throw new Error('RUN_CAP'); // signál pro čisté ukončení běhu
    }
    /* eslint-disable no-constant-condition */
    while (true) {
      const now = Date.now();
      let wait = 0;
      for (const w of this.windows) {
        w.hits = w.hits.filter(t => now - t < w.ms);
        if (w.hits.length >= w.max) wait = Math.max(wait, w.ms - (now - w.hits[0]));
      }
      if (wait <= 0) break;
      await sleep(Math.max(250, wait));
    }
    const t = Date.now();
    for (const w of this.windows) w.hits.push(t);
    this.used++;
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Když 429 vrátí Retry-After delší než tohle (= zásah hodinového per-method
// limitu), nečekáme — ukončíme běh a uložíme progress; naváže další cron.
const LONG_429_THRESHOLD = 90;

// ---------------------------------------------------------------------------
// HTTP helper (Riot) s retry na 429
// ---------------------------------------------------------------------------
async function riotGet(cluster, pathSeg, limiter, apiKey) {
  const url = `https://${cluster}.api.riotgames.com${pathSeg}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    await limiter.take();
    const res = await fetch(url, { headers: { 'X-Riot-Token': apiKey } });
    if (res.status === 429) {
      const retry = parseInt(res.headers.get('retry-after') || '10', 10);
      if (retry > LONG_429_THRESHOLD) {
        console.warn(`[429] ${pathSeg} -> Retry-After ${retry}s (hodinový limit) — končím běh, naváže další cron`);
        throw new Error('RATE_HALT');
      }
      console.warn(`[429] ${pathSeg} -> čekám ${retry}s`);
      await sleep((retry + 1) * 1000);
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[${res.status}] ${pathSeg}`);
      return null;
    }
    return res.json();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deck code decoder (ověřeno proti referenčnímu vektoru)
// ---------------------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const FACTION_ID = {0:'DE',1:'FR',2:'IO',3:'NX',4:'PZ',5:'SI',6:'BW',7:'SH',9:'MT',10:'BC',12:'RU'};

function base32Decode(str) {
  str = String(str).toUpperCase().replace(/=+$/, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of str) {
    const idx = B32.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >> bits) & 0xFF); }
  }
  return out;
}

function decodeDeck(code) {
  return decodeDeckCounts(code).map(c => c.code);
}

// jako decodeDeck, ale vrací i počet kopií: [{code, count}]
function decodeDeckCounts(code) {
  const bytes = base32Decode(code);
  if (!bytes || bytes.length < 2) return [];
  let pos = 1;
  const varint = () => {
    let result = 0, shift = 0, b;
    do {
      if (pos >= bytes.length) return result >>> 0;
      b = bytes[pos++]; result |= (b & 0x7F) << shift; shift += 7;
    } while (b & 0x80);
    return result >>> 0;
  };
  const cards = [];
  try {
    for (let count = 3; count >= 1; count--) {
      const numGroups = varint();
      for (let g = 0; g < numGroups; g++) {
        const numCards = varint();
        const set = varint();
        const faction = varint();
        for (let c = 0; c < numCards; c++) {
          cards.push({ set, faction, num: varint(), count });
        }
      }
    }
    while (pos < bytes.length) {
      const count = varint();
      const set = varint(), faction = varint(), num = varint();
      cards.push({ set, faction, num, count });
    }
  } catch { /* poškozený kód -> vrať co máme */ }
  return cards.map(c => ({
    code: String(c.set).padStart(2, '0') + (FACTION_ID[c.faction] ?? '??') + String(c.num).padStart(3, '0'),
    count: c.count
  }));
}

// ---------------------------------------------------------------------------
// Archetype label:  "Champ/champ (Region/region)" abecedně
// Region decku = MINIMÁLNÍ množina regionů pokrývající všechny karty.
// Multiregionové karty (Scholar's Pioneer = FR+DE) se přiřadí k regionu, který
// deck už má (z mono-region karet), takže nenafouknou region navíc.
// `cardRegions` = code -> [regiony] pouze pro multiregionové karty (z Data Dragonu);
// mono karty mají region v kódu (01NX038 -> NX).
// ---------------------------------------------------------------------------
function cardRegionsOf(code, cardRegions) {
  const multi = cardRegions && cardRegions[code];
  if (multi && multi.length) return multi;
  const r = code.slice(2, 4);
  return /^[A-Z]{2}$/.test(r) ? [r] : [];
}
function deckRegions(codes, cardRegions) {
  const per = codes.map(c => cardRegionsOf(c, cardRegions)).filter(a => a.length);
  const forced = new Set();
  for (const regs of per) if (regs.length === 1) forced.add(regs[0]);   // mono karty určují jádro
  let uncovered = per.filter(regs => regs.length > 1 && !regs.some(r => forced.has(r)));
  while (uncovered.length) {                                           // pokrytí zbytku greedy
    const counts = {};
    for (const regs of uncovered) for (const r of regs) counts[r] = (counts[r] || 0) + 1;
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    forced.add(best);
    uncovered = uncovered.filter(regs => !regs.some(r => forced.has(r)));
  }
  return [...forced].sort();
}
function buildLabel(deckCode, cardRegions, champMap) {
  const codes = decodeDeck(deckCode);
  const regions = deckRegions(codes, cardRegions);
  const champs = [...new Set(codes.map(code => champMap[code]).filter(Boolean))].sort();
  const regionPart = regions.length ? `(${regions.join('/')})` : '(??)';
  return champs.length ? `${champs.join('/')} ${regionPart}` : `champless ${regionPart}`;
}

// ---------------------------------------------------------------------------
// Data Dragon: cardCode -> jméno championa  +  multiregionové karty -> [regiony]
// ---------------------------------------------------------------------------
const REGION_REF = {
  Demacia: 'DE', Freljord: 'FR', Ionia: 'IO', Noxus: 'NX', PiltoverZaun: 'PZ',
  ShadowIsles: 'SI', Bilgewater: 'BW', Shurima: 'SH', Targon: 'MT', MtTargon: 'MT',
  BandleCity: 'BC', Runeterra: 'RU'
};
async function fetchChampMap(cfg) {
  const map = {};          // cardCode -> champion name
  const cardRegions = {};  // cardCode -> [region codes]  (jen multiregionové karty)
  for (const set of cfg.dataDragonSets) {
    const url = `https://dd.b.pvp.net/latest/${set}/en_us/data/${set}-en_us.json`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const cards = await res.json();
      for (const c of cards) {
        if (!c || !c.cardCode) continue;
        if (c.supertype === 'Champion' && c.name) map[c.cardCode] = c.name;
        const regs = [...new Set((c.regionRefs || []).map(r => REGION_REF[r]).filter(Boolean))];
        if (regs.length > 1) cardRegions[c.cardCode] = regs;   // ukládej jen multiregion
      }
    } catch (e) {
      console.warn(`[DataDragon] ${set} přeskočeno: ${e.message}`);
    }
  }
  console.log(`[DataDragon] championů: ${Object.keys(map).length}, multiregion karet: ${Object.keys(cardRegions).length}`);
  return { champMap: map, cardRegions };
}

// ---------------------------------------------------------------------------
// Firebase Realtime Database stav (REST)
// Pozn.: Firebase klíče nesmí obsahovat  . $ # [ ] /  — archetyp labely mají
// "/" (FR/IO, Karma/Sett), takže klíče při ukládání reverzibilně enkódujeme.
// Hodnoty (stats.json pro frontend) zůstávají s normálními labely.
// ---------------------------------------------------------------------------
const encKey = (k) => k.replace(/[.$#\[\]/]/g, c => '~' + c.charCodeAt(0).toString(16) + '~');
const decKey = (k) => k.replace(/~([0-9a-f]+)~/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

function encodeKeys(o) {
  if (Array.isArray(o)) return o.map(encodeKeys);
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) out[encKey(k)] = encodeKeys(v);
    return out;
  }
  return o;
}
function decodeKeys(o) {
  if (Array.isArray(o)) return o.map(decodeKeys);
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) out[decKey(k)] = decodeKeys(v);
    return out;
  }
  return o;
}

async function loadState(dbUrl, secret) {
  try {
    const res = await fetch(`${dbUrl}/lor-meta.json?auth=${secret}`);
    if (res.ok) {
      const data = await res.json();
      return data ? decodeKeys(data) : {};
    }
    console.warn(`[Firebase] load: ${res.status}`);
  } catch (e) {
    console.warn(`[Firebase] load selhal: ${e.message}`);
  }
  return {};
}

async function saveState(dbUrl, secret, state) {
  const res = await fetch(`${dbUrl}/lor-meta.json?auth=${secret}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(encodeKeys(state))
  });
  if (!res.ok) console.warn(`[Firebase] save selhal: ${res.status}`);
}

// ---------------------------------------------------------------------------
// Pomocné
// ---------------------------------------------------------------------------
const ACCOUNT_CLUSTER = { europe: 'europe', americas: 'americas', asia: 'asia' };

function dayKey(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function bucketFor(days, dk, region, format) {
  days[dk] ??= {};
  days[dk][region] ??= {};
  days[dk][region][format] ??= { matchups: {}, deckGames: {} };
  return days[dk][region][format];
}

function pruneDays(days, maxDays) {
  const keys = Object.keys(days).sort();
  const cutoff = new Date(Date.now() - maxDays * 86400_000).toISOString().slice(0, 10);
  for (const k of keys) if (k < cutoff) delete days[k];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const apiKey = process.env.RIOT_API_KEY;
  const fbSecret = process.env.FIREBASE_SECRET;
  if (!apiKey) throw new Error('Chybí RIOT_API_KEY');
  if (!fbSecret) throw new Error('Chybí FIREBASE_SECRET');

  let cfg = DEFAULT_CONFIG;
  try {
    cfg = { ...DEFAULT_CONFIG, ...JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')) };
  } catch { console.warn('[config] použ. default'); }
  if (!cfg.firebaseUrl) throw new Error('Chybí firebaseUrl v config.json');
  const dbUrl = cfg.firebaseUrl.replace(/\/$/, '');

  const limiter = new RateLimiter(cfg.maxRequestsPerRun, [
    { ms: 1000, max: 18 },      // app: 20 req / 1 s  (rezerva)
    { ms: 120000, max: 95 }     // app: 100 req / 2 min (rezerva)
  ]);
  const state = await loadState(dbUrl, fbSecret);
  state.regions ??= {};        // { europe:{frontier:[],visited:[]}, ... }
  state.processed ??= [];
  state.days ??= {};
  state.champMap ??= {};
  state.cardRegions ??= {};     // multiregionové karty pro správné regiony decku
  state.comp ??= {};            // archetyp -> { n, c:{ cardCode:[decků, kopií] } }
  state.champFetchedAt ??= 0;

  const processed = new Set(state.processed);
  const gameTypeTally = {};
  const infoSamples = [];
  const perRegionCap = Math.max(1, Math.floor(cfg.maxRequestsPerRun / cfg.regions.length));
  const perRegionMd = Math.max(1, Math.floor(cfg.maxMatchDetailsPerRun / cfg.regions.length));
  let mdGlobal = 0;  // detaily zápasů stažené v tomto běhu (hlídá 100/hod limit)

  // Champ mapa + regiony karet (obnov jednou za champRefreshHours)
  const champStale = Date.now() - state.champFetchedAt > cfg.champRefreshHours * 3600_000;
  if (champStale || Object.keys(state.champMap).length === 0) {
    try {
      const fresh = await fetchChampMap(cfg);
      if (Object.keys(fresh.champMap).length > 0) {
        state.champMap = fresh.champMap;
        state.cardRegions = fresh.cardRegions;
        state.champFetchedAt = Date.now();
      }
    } catch (e) { console.warn(`[DataDragon] ${e.message}`); }
  }
  const champMap = state.champMap;
  const cardRegions = state.cardRegions || {};

  // Self-test dekodéru (sanity, neutratí requesty)
  const selfTest = decodeDeck('CEBAIAIFB4WDANQIAEAQGDAUDAQSIJZUAIAQCBIFAEAQCBAA')[0];
  console.log(`[selftest] decode -> ${selfTest} (čekáno 01SI015)`);

  try {
    for (const cluster of cfg.regions) {
      const acct = ACCOUNT_CLUSTER[cluster] || cluster;
      state.regions[cluster] ??= {};
      const reg = state.regions[cluster];
      reg.frontier ??= [];          // Firebase zahazuje prázdná pole -> doplň
      reg.visited ??= [];
      const visited = new Set(reg.visited);
      const startUsed = limiter.used;

      // Seed do fronty regionu, pokud je prázdná
      if (reg.frontier.length === 0) {
        const seeds = (cfg.seeds && cfg.seeds[cluster]) || [];
        for (const rid of seeds) {
          if (!rid.includes('#')) continue;
          const [name, tag] = rid.split('#');
          const a = await riotGet(acct,
            `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`,
            limiter, apiKey);
          if (a?.puuid && !visited.has(a.puuid)) reg.frontier.push(a.puuid);
          else if (!a) console.warn(`[${cluster}] seed neresolvnut: ${rid}`);
        }
        console.log(`[${cluster}] seed -> frontier ${reg.frontier.length}`);
      }

      // Crawl — primárně limitované rozpočtem detailů zápasů (100/hod strop)
      let regionMd = 0;
      while (reg.frontier.length > 0 && regionMd < perRegionMd
             && mdGlobal < cfg.maxMatchDetailsPerRun
             && (limiter.used - startUsed) < perRegionCap) {

        const puuid = reg.frontier[0];           // peek (shift až po dokončení)
        if (visited.has(puuid)) { reg.frontier.shift(); continue; }

        const ids = await riotGet(cluster,
          `/lor/match/v1/matches/by-puuid/${puuid}/ids`, limiter, apiKey);

        let stoppedEarly = false;
        if (Array.isArray(ids)) {
          for (const matchId of ids.slice(0, cfg.maxMatchesPerPuuid)) {
            if (processed.has(matchId)) continue;
            if (regionMd >= perRegionMd || mdGlobal >= cfg.maxMatchDetailsPerRun) {
              stoppedEarly = true; break;        // nech puuid ve frontě pro další běh
            }
            const m = await riotGet(cluster, `/lor/match/v1/matches/${matchId}`, limiter, apiKey);
            processed.add(matchId); regionMd++; mdGlobal++;
            if (!m?.info) continue;

            const gt = m.info.game_type || m.info.type || 'unknown';
            const gm = m.info.game_mode || '?';
            const gf = m.info.game_format || m.info.format || '?';
            const tallyKey = `${gm} / ${gt} / ${gf}`;
            gameTypeTally[tallyKey] = (gameTypeTally[tallyKey] || 0) + 1;
            if (infoSamples.length < 3) {
              const { players: _p, ...rest } = m.info;
              infoSamples.push(rest);
            }
            if (!cfg.gameTypeAllow.includes(gt)) continue;

            const dk = dayKey(m.info.game_start_time_utc);
            if (!dk) continue;
            const cutoff = new Date(Date.now() - cfg.maxWindowDays * 86400_000).toISOString().slice(0, 10);
            if (dk < cutoff) continue;

            const players = m.info.players || [];
            if (players.length !== 2) continue;

            // snowball: soupeři do fronty TOHOTO regionu
            for (const p of (m.metadata?.participants || [])) {
              if (!visited.has(p) && reg.frontier.length < cfg.maxFrontier) reg.frontier.push(p);
            }

            const [pa, pb] = players;
            const la = buildLabel(pa.deck_code, cardRegions, champMap);
            const lb2 = buildLabel(pb.deck_code, cardRegions, champMap);
            const aWon = pa.game_outcome === 'win';

            // složení decku per archetyp: kolik decků kartu hraje + kolik kopií celkem
            for (const [lab, dc] of [[la, pa.deck_code], [lb2, pb.deck_code]]) {
              const comp = (state.comp[lab] ??= { n: 0, c: {} });
              comp.n++;
              for (const { code, count } of decodeDeckCounts(dc)) {
                const e = (comp.c[code] ??= [0, 0]);   // [decků, kopií]
                e[0]++; e[1] += count;
              }
            }

            // formát: zatím SUROVÁ hodnota z API; po prvním běhu podle logu
            // [info SAMPLE] potvrdíme správné pole a mapování Standard/Eternal.
            const fmt = String(m.info.game_format ?? m.info.format ?? 'unknown');
            const bucket = bucketFor(state.days, dk, cluster, fmt);

            for (const [lab, won] of [[la, aWon], [lb2, !aWon]]) {
              bucket.deckGames[lab] ??= { games: 0, wins: 0 };
              bucket.deckGames[lab].games++;
              if (won) bucket.deckGames[lab].wins++;
            }
            if (la !== lb2) {
              const kAB = `${la}@@${lb2}`, kBA = `${lb2}@@${la}`;
              bucket.matchups[kAB] ??= { games: 0, wins: 0 };
              bucket.matchups[kBA] ??= { games: 0, wins: 0 };
              bucket.matchups[kAB].games++; if (aWon) bucket.matchups[kAB].wins++;
              bucket.matchups[kBA].games++; if (!aWon) bucket.matchups[kBA].wins++;
            }
          }
        }

        if (stoppedEarly) break;     // rozpočet vyčerpán uprostřed hráče -> necháme ho ve frontě
        reg.frontier.shift();        // hráč hotový -> ven z fronty
        visited.add(puuid);
      }
      console.log(`[${cluster}] detaily zápasů: ${regionMd}, frontier: ${reg.frontier.length}`);

      reg.visited = [...visited].slice(-100000);
    }
  } catch (e) {
    if (e.message === 'RUN_CAP' || e.message === 'RATE_HALT') {
      console.log(`[stop] ${e.message} — ukládám progress, naváže další cron`);
    } else {
      console.error('[chyba]', e);
    }
  }

  // Prune + persist
  pruneDays(state.days, cfg.maxWindowDays);
  state.processed = [...processed].slice(-cfg.maxProcessedIds);
  // comp: zahoď šum (n<2) a omez na top ~80 karet/archetyp, ať stav neroste
  for (const [lab, c] of Object.entries(state.comp)) {
    if (!c || c.n < 2) { delete state.comp[lab]; continue; }
    const codes = Object.keys(c.c || {});
    if (codes.length > 80) {
      const keep = codes.sort((a, b) => c.c[b][0] - c.c[a][0]).slice(0, 80);
      const nc = {}; for (const k of keep) nc[k] = c.c[k];
      c.c = nc;
    }
  }

  await saveState(dbUrl, fbSecret, state);

  // Výstup pro frontend
  const stats = {
    generatedAt: new Date().toISOString(),
    patchStart: cfg.patchStart,
    regions: cfg.regions,
    windows: [
      { key: '2d', label: 'Poslední 2 dny', days: 2 },
      { key: '7d', label: 'Týden', days: 7 },
      { key: '14d', label: '14 dní', days: 14 },
      { key: 'patch', label: 'Od patche', sincePatch: true }
    ],
    days: state.days,
    comp: state.comp,
    champMap: state.champMap   // pro zobrazení jmen karet v sešitu
  };
  await fs.mkdir(path.dirname(STATS_PATH), { recursive: true });
  await fs.writeFile(STATS_PATH, JSON.stringify(stats));

  const frontiers = Object.fromEntries(cfg.regions.map(r => [r, state.regions[r]?.frontier?.length ?? 0]));
  console.log(`[hotovo] requestů: ${limiter.used}, dnů v bucketu: ${Object.keys(state.days).length}, frontiers: ${JSON.stringify(frontiers)}`);
  console.log('[mode/type/format DISTINCT]', JSON.stringify(gameTypeTally));
  console.log('[info SAMPLE]', JSON.stringify(infoSamples));
}

main().catch(e => { console.error(e); process.exit(1); });
