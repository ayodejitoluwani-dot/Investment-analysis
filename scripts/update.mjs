// Signal Desk data updater. Runs in GitHub Actions (Node 20+), no dependencies.
// Fetches prices + news, runs the model, writes data/*.json for the web app.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { analyze, signal, headlineScore, newsSummary, scorePredictions, mean } from "./engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function get(url, { type = "json", tries = 3 } = {}) {
  let err;
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": type === "json" ? "application/json,*/*" : "*/*" } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.fatal = true; throw e; }
      return type === "json" ? await r.json() : await r.text();
    } catch (e) { err = e; if (e.fatal) break; await sleep(2000 * (k + 1)); }
  }
  throw err;
}

// ---------- price sources: all return {t[],o[],h[],l[],c[],a[],v[]} ascending ----------
function fromRows(rows) {
  rows.sort((x, y) => (x.t < y.t ? -1 : 1));
  const dedup = []; for (const r of rows) { if (dedup.length && dedup.at(-1).t === r.t) dedup[dedup.length - 1] = r; else dedup.push(r); }
  const k = f => dedup.map(r => r[f] ?? null);
  return { t: k("t"), o: k("o"), h: k("h"), l: k("l"), c: k("c"), a: dedup.map(r => r.a ?? r.c), v: k("v") };
}
const sources = {
  // stockanalysis.com (unofficial JSON used by their own pages). sym like "a/NGX-GTCO", "s/AAPL", "e/SPY"
  async sa(sym) {
    const j = await get(`https://stockanalysis.com/api/symbol/${sym}/history?range=10Y&period=daily`);
    const d = Array.isArray(j.data) ? j.data : j.data?.data;
    if (!d?.length) throw new Error("stockanalysis returned no rows");
    return fromRows(d.filter(r => r.c > 0).map(r => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, a: r.a || r.c, v: r.v })));
  },
  async yahoo(sym) {
    const j = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=10y&interval=1d&includeAdjustedClose=true`);
    const res = j.chart?.result?.[0]; if (!res?.timestamp) throw new Error(j.chart?.error?.description || "Yahoo returned no data");
    const q = res.indicators.quote[0], adj = res.indicators.adjclose?.[0]?.adjclose;
    const rows = res.timestamp.map((ts, i) => ({ t: new Date((ts + (res.meta?.gmtoffset || 0)) * 1000).toISOString().slice(0, 10), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], a: adj?.[i] ?? q.close[i], v: q.volume?.[i] })).filter(r => r.c > 0);
    return fromRows(rows);
  },
  async coingecko(id) {
    const j = await get(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=365&interval=daily`);
    return fromRows(j.prices.map(([ts, p]) => ({ t: new Date(ts).toISOString().slice(0, 10), c: p, a: p })));
  },
};
async function fetchSeries(asset) {
  const tries = [{ source: asset.source, sym: asset.sym }, ...(asset.fallbacks || [])];
  const errs = [];
  for (const s of tries) {
    try { const ser = await sources[s.source](s.sym); await sleep(1200); return { ser, via: `${s.source}:${s.sym}` }; }
    catch (e) { errs.push(`${s.source}:${s.sym} → ${e.message}`); await sleep(1200); }
  }
  throw new Error(errs.join(" | "));
}

// Equal-weight index of a basket (each member rebased to 100), on dates where most members exist.
function basketIndex(list) {
  const maps = list.map(s => new Map(s.t.map((d, i) => [d, s.a[i]])));
  const dates = [...new Set(list.flatMap(s => s.t))].sort();
  const lastSeen = list.map(() => null), base = list.map(() => null);
  const t = [], a = [];
  for (const d of dates) {
    maps.forEach((m, k) => { if (m.has(d)) { lastSeen[k] = m.get(d); if (base[k] == null) base[k] = m.get(d); } });
    const vals = lastSeen.map((v, k) => v == null ? null : (v / base[k]) * 100).filter(v => v != null);
    if (vals.length >= Math.ceil(list.length * 0.6)) { t.push(d); a.push(mean(vals)); }
  }
  // chain-link so members joining later don't jump the index: use daily mean return instead
  const out = [100];
  for (let i = 1; i < t.length; i++) {
    const rets = []; list.forEach((s, k) => { const p = maps[k].get(t[i]), q = maps[k].get(t[i - 1]); if (p && q) rets.push(p / q - 1); });
    out.push(out[i - 1] * (1 + (rets.length ? mean(rets) : 0)));
  }
  return { t, a: out };
}

// ---------- news ----------
const decode = s => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
async function googleNews(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:7d")}&hl=en-NG&gl=NG&ceid=NG:en`;
  const xml = await get(url, { type: "text" });
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const it = m[1], g = tag => decode((it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || "");
    const src = g("source"); let title = g("title"); if (src && title.endsWith(" - " + src)) title = title.slice(0, -(src.length + 3));
    return { title, url: g("link"), src: src || "Google News", time: Date.parse(g("pubDate")) || Date.now() };
  });
}
async function gdelt(q) {
  const j = await get(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`(${q}) sourcelang:english`)}&mode=artlist&format=json&maxrecords=40&timespan=7d&sort=datedesc`, { tries: 2 });
  const tm = s => { const m = (s || "").match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : Date.now(); };
  return (j.articles || []).map(x => ({ title: x.title, url: x.url, src: x.domain, time: tm(x.seendate) }));
}
async function fetchNews(asset) {
  const all = [], errs = [];
  try { all.push(...await googleNews(asset.news)); } catch (e) { errs.push("Google News: " + e.message); }
  await sleep(1500);
  try { all.push(...await gdelt(asset.news)); } catch (e) { errs.push("GDELT: " + e.message); }
  await sleep(5500); // GDELT asks for ≤1 request / 5s
  const cutoff = Date.now() - 7 * 864e5, seen = new Set();
  const items = all.filter(x => x.title && x.time >= cutoff).filter(x => { const k = x.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 70); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((p, q) => q.time - p.time).slice(0, 30).map(x => ({ ...x, score: +headlineScore(x.title).toFixed(2) }));
  return { items, summary: newsSummary(items), errors: errs };
}

const readJSON = async (f, d) => { try { return JSON.parse(await readFile(f, "utf8")); } catch { return d; } };

export async function main() {
  const cfg = JSON.parse(await readFile(path.join(ROOT, "watchlist.json"), "utf8"));
  await mkdir(DATA, { recursive: true });
  const prev = await readJSON(path.join(DATA, "signals.json"), { assets: [] });
  const prevById = Object.fromEntries(prev.assets.map(x => [x.id, x]));
  const series = {}, status = {};

  // 1. Prices for watchlist assets
  for (const a of cfg.assets) {
    try { const { ser, via } = await fetchSeries(a); series[a.id] = ser; status[a.id] = { ok: true, via }; log("price ok", a.id, via, ser.t.length, ser.t.at(-1)); }
    catch (e) { status[a.id] = { ok: false, error: e.message }; log("price FAIL", a.id, e.message); }
  }
  // 2. Market proxies (e.g. NGX large-cap basket)
  const markets = {};
  for (const [key, m] of Object.entries(cfg.markets || {})) {
    if (m.asset) { if (series[m.asset]) markets[key] = { label: m.label, ...series[m.asset] }; continue; }
    const members = [];
    for (const sym of m.basket) {
      const own = cfg.assets.find(x => x.sym === sym && series[x.id]);
      if (own) { members.push(series[own.id]); continue; }
      try { members.push((await fetchSeries({ source: m.source, sym })).ser); } catch (e) { log("basket miss", sym, e.message); }
    }
    if (members.length >= 3) { const idx = basketIndex(members); markets[key] = { label: m.label, ...idx }; log("market", key, members.length, "members", idx.t.length, "days"); }
  }
  // 3. News
  const news = {};
  for (const a of cfg.assets) {
    try { news[a.id] = await fetchNews(a); log("news", a.id, news[a.id].items.length, news[a.id].errors.join("; ")); }
    catch (e) { news[a.id] = { items: [], summary: newsSummary([]), errors: [e.message] }; }
    if (!news[a.id].items.length && prevById[a.id]?.news?.items?.length) news[a.id] = { ...prevById[a.id].news, carried: true, errors: news[a.id].errors };
  }
  // 4. Model
  const out = [];
  for (const a of cfg.assets) {
    const base = { id: a.id, name: a.name, group: a.group, cur: a.cur || "", sym: a.sym, note: a.note || "", status: status[a.id], news: news[a.id] };
    const ser = series[a.id];
    if (!ser) { out.push({ ...base, ok: false, reason: "Price download failed: " + status[a.id].error, ...(prevById[a.id]?.ok ? { stale: prevById[a.id] } : {}) }); continue; }
    const ctx = { market: a.market && markets[a.market] ? markets[a.market] : null, others: (a.context || []).filter(k => series[k] || markets[k]).map(k => ({ key: k, label: (cfg.assets.find(x => x.id === k)?.name || markets[k]?.label || k), ...(series[k] || markets[k]) })) };
    const t0 = Date.now();
    const an = analyze(ser, { horizon: a.horizon, limit: a.limit, divSeason: a.divSeason }, ctx);
    log("model", a.id, an.ok ? `pUp ${an.pUp} conf ${an.confidence} edge ${an.bt.edge}` : an.reason, `${Date.now() - t0}ms`);
    if (!an.ok) { out.push({ ...base, ok: false, reason: an.reason }); continue; }
    out.push({ ...base, ...an, signal: signal(an, news[a.id].summary), ageDays: Math.round((Date.now() - Date.parse(an.lastDate)) / 864e5) });
  }
  // 5. Prediction log: add today's calls, score old ones
  const predFile = path.join(DATA, "predictions.json");
  const preds = await readJSON(predFile, []);
  for (const x of out.filter(x => x.ok)) {
    if (!preds.some(p => p.id === x.id && p.d === x.lastDate)) preds.push({ id: x.id, d: x.lastDate, H: x.H, p: x.pUp, score: x.signal.score, conf: x.confidence, px: x.last });
  }
  scorePredictions(preds, series);
  for (const x of out) {
    const done = preds.filter(p => p.id === x.id && p.correct != null);
    x.live = { n: done.length, hits: done.filter(p => p.correct).length };
  }
  // 6. News tone history (for future model use)
  const nhFile = path.join(DATA, "news_history.json"); const nh = await readJSON(nhFile, {});
  const today = new Date().toISOString().slice(0, 10);
  for (const a of cfg.assets) if (news[a.id]?.items?.length && !news[a.id].carried) { (nh[a.id] ||= {})[today] = news[a.id].summary; }

  await writeFile(path.join(DATA, "signals.json"), JSON.stringify({ updated: new Date().toISOString(), groups: cfg.groups, assets: out }));
  await writeFile(predFile, JSON.stringify(preds));
  await writeFile(nhFile, JSON.stringify(nh));
  const okN = out.filter(x => x.ok).length;
  log(`done: ${okN}/${out.length} assets modelled`);
  if (okN === 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e); process.exit(1); });
