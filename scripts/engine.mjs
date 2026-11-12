// Signal Desk model engine — runs in Node inside the GitHub Action.
// Pure functions, no dependencies.

export const sma = (a, n) => { const o = new Array(a.length).fill(null); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
export const ema = (a, n) => { const o = new Array(a.length).fill(null); const k = 2 / (n + 1); let e = null; for (let i = 0; i < a.length; i++) { if (a[i] == null) continue; e = e == null ? a[i] : a[i] * k + e * (1 - k); o[i] = e; } return o; };
export function rsi(a, n = 14) { const o = new Array(a.length).fill(null); let g = 0, l = 0; for (let i = 1; i < a.length; i++) { const d = a[i] - a[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0); if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } } return o; }
export function macdHist(a) { const e12 = ema(a, 12), e26 = ema(a, 26); const m = a.map((_, i) => e12[i] - e26[i]); const s = ema(m, 9); return m.map((v, i) => v - s[i]); }
export const mean = x => x.reduce((s, v) => s + v, 0) / Math.max(1, x.length);
export const stdev = x => { const m = mean(x); return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, x.length - 1)); };

// Align a context series {t[], a[]} onto target dates, forward-filling.
export function alignTo(dates, ctx) {
  const out = new Array(dates.length).fill(null); let j = 0, last = null;
  for (let i = 0; i < dates.length; i++) { while (j < ctx.t.length && ctx.t[j] <= dates[i]) { last = ctx.a[j]; j++; } out[i] = last; }
  return out;
}

export function trainLogit(X, y, { iters = 300, lr = 0.25, l2 = 0.03 } = {}) {
  const d = X[0].length, n = X.length;
  const mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mu[j] += x[j] / n;
  for (const x of X) for (let j = 0; j < d; j++) sd[j] += (x[j] - mu[j]) ** 2 / n;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const Z = X.map(x => x.map((v, j) => (v - mu[j]) / sd[j]));
  const w = new Array(d).fill(0); let b = 0;
  const gw = new Array(d);
  for (let it = 0; it < iters; it++) {
    gw.fill(0); let gb = 0;
    for (let k = 0; k < n; k++) { const zk = Z[k]; let z = b; for (let j = 0; j < d; j++) z += w[j] * zk[j]; const e = 1 / (1 + Math.exp(-z)) - y[k]; gb += e; for (let j = 0; j < d; j++) gw[j] += e * zk[j]; }
    b -= lr * gb / n; for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
  }
  const zf = x => x.map((v, j) => (v - mu[j]) / sd[j]);
  return {
    predict(x) { const z = zf(x); let s = b; for (let j = 0; j < d; j++) s += w[j] * z[j]; return 1 / (1 + Math.exp(-s)); },
    contrib(x) { return zf(x).map((v, j) => w[j] * v); },
  };
}

/**
 * series: {t[], o[], h[], l[], c[], a[], v[]}  ascending; a = adjusted close
 * cfg: {horizon, limit, divSeason[], marketKey}
 * ctx: {market?: {t,a}, others: [{key, label, t, a}]}
 */
export function analyze(series, cfg, ctx = {}) {
  const { t, h, l, c, a } = series; const n = a.length;
  const H = cfg.horizon || 5;
  if (n < 120) return { ok: false, reason: `Only ${n} days of history (need 120+).` };

  // "Stale" = no price discovery that day: unchanged close and high == low.
  const stale = a.map((_, i) => i > 0 && c[i] === c[i - 1] && (h[i] == null || h[i] === l[i]));
  const ind = { s20: sma(a, 20), s50: sma(a, 50), rsi: rsi(a, 14), macd: macdHist(a) };
  const dailyPct = c.map((v, i) => i ? v / c[i - 1] - 1 : 0);
  const lr = a.map((v, i) => i ? Math.log(v / a[i - 1]) : 0);

  const mk = ctx.market ? alignTo(t, ctx.market) : null;
  const mkS50 = mk ? sma(mk.map(v => v ?? NaN), 50) : null;
  const others = (ctx.others || []).map(o => ({ ...o, al: alignTo(t, o) }));

  const names = ["1-day return", "5-day return", "20-day return", "RSI", "Gap to 20-day avg", "Gap to 50-day avg", "MACD momentum", "Volatility (20d)", "Trading activity (20d)"];
  if (cfg.limit) names.push("Hit +10% limit recently", "Hit −10% limit recently");
  if (cfg.divSeason?.length) names.push("Dividend season");
  if (mk) names.push(`${ctx.market.label} 20-day trend`, `${ctx.market.label} vs its 50-day avg`);
  for (const o of others) names.push(`${o.label} 20-day move`);

  const START = 60;
  const r = (arr, i, k) => (arr[i] != null && arr[i - k] != null && arr[i - k] > 0) ? Math.log(arr[i] / arr[i - k]) : 0;
  function feats(i) {
    const rets = lr.slice(i - 19, i + 1);
    let liq = 0; for (let j = i - 19; j <= i; j++) if (!stale[j]) liq++;
    const f = [lr[i], r(a, i, 5), r(a, i, 20), (ind.rsi[i] - 50) / 50, a[i] / ind.s20[i] - 1, a[i] / ind.s50[i] - 1, ind.macd[i] / a[i], stdev(rets), liq / 20];
    if (cfg.limit) {
      let up = 0, dn = 0; for (let j = i - 2; j <= i; j++) { if (dailyPct[j] >= cfg.limit * 0.95) up = 1; if (dailyPct[j] <= -cfg.limit * 0.95) dn = 1; }
      f.push(up, dn);
    }
    if (cfg.divSeason?.length) f.push(cfg.divSeason.includes(+t[i].slice(5, 7)) ? 1 : 0);
    if (mk) f.push(r(mk, i, 20), mkS50[i] && isFinite(mkS50[i]) && mk[i] ? mk[i] / mkS50[i] - 1 : 0);
    for (const o of others) f.push(r(o.al, i, 20));
    return f.map(v => isFinite(v) ? v : 0);
  }

  // Samples: days with real trading, whose outcome H sessions later actually moved.
  const S = [];
  for (let i = START; i + H < n; i++) {
    if (stale[i]) continue;
    if (a[i + H] === a[i]) continue;
    S.push({ i, x: feats(i), y: a[i + H] > a[i] ? 1 : 0 });
  }
  if (S.length < 150) return { ok: false, reason: `Only ${S.length} usable trading days after filtering (need 150+).` };

  // Rolling walk-forward: retrain every 21 samples on everything before, with an H-row gap.
  const oos = [];
  const minTrain = Math.min(250, Math.floor(S.length * 0.5));
  for (let s = minTrain; s < S.length; s += 21) {
    const firstRow = S[s].i;
    const train = S.slice(0, s).filter(q => q.i + H <= firstRow);
    if (train.length < 100) continue;
    const ys = train.map(q => q.y);
    const m = trainLogit(train.map(q => q.x), ys);
    const prior = mean(ys);
    for (const q of S.slice(s, s + 21)) oos.push({ i: q.i, t: t[q.i], p: m.predict(q.x), y: q.y, prior });
  }
  const bt = { n: oos.length };
  if (oos.length >= 40) {
    const hits = oos.filter(o => (o.p > 0.5 ? 1 : 0) === o.y).length;
    const up = mean(oos.map(o => o.y));
    bt.hit = hits / oos.length; bt.base = Math.max(up, 1 - up); bt.edge = bt.hit - bt.base;
    bt.brier = mean(oos.map(o => (o.p - o.y) ** 2)); bt.brierBase = mean(oos.map(o => (o.prior - o.y) ** 2));
    const conf = oos.filter(o => Math.abs(o.p - 0.5) >= 0.1);
    bt.confN = conf.length; bt.confHit = conf.length ? conf.filter(o => (o.p > 0.5 ? 1 : 0) === o.y).length / conf.length : null;
    // stability: share of ~6-month chunks where the model beat that chunk's baseline
    const chunks = []; for (let k = 0; k < oos.length; k += 126) chunks.push(oos.slice(k, k + 126));
    const good = chunks.filter(ch => ch.length >= 30).map(ch => { const hh = mean(ch.map(o => (o.p > 0.5 ? 1 : 0) === o.y ? 1 : 0)); const u = mean(ch.map(o => o.y)); return hh > Math.max(u, 1 - u); });
    bt.chunks = good.length; bt.stability = good.length ? good.filter(Boolean).length / good.length : null;
    bt.from = oos[0].t; bt.to = oos[oos.length - 1].t;
  }
  const confidence = bt.edge == null ? "Untested" : (bt.edge > 0.03 && (bt.stability ?? 0) >= 0.6 && bt.brier < bt.brierBase) ? "High" : bt.edge > 0 ? "Low" : "None";

  const final = trainLogit(S.map(q => q.x), S.map(q => q.y));
  const xNow = feats(n - 1);
  const pUp = final.predict(xNow);
  const contrib = final.contrib(xNow).map((v, j) => ({ name: names[j], v: +v.toFixed(3) })).sort((p, q) => Math.abs(q.v) - Math.abs(p.v)).slice(0, 4);

  let liqNow = 0; for (let j = n - 20; j < n; j++) if (!stale[j]) liqNow++; liqNow /= 20;

  // Projection cone over H sessions using recent volatility of trading days only
  const live = lr.slice(-60).filter((v, k) => !stale[n - 60 + k]);
  const sigmaDaily = stdev(lr.slice(-20));
  const mu = 0.5 * mean(lr.slice(-60));
  const cone = []; for (let k = 1; k <= H; k++) { const m = Math.log(a[n - 1]) + mu * k, w = 1.2816 * sigmaDaily * Math.sqrt(k); cone.push([+Math.exp(m).toPrecision(6), +Math.exp(m - w).toPrecision(6), +Math.exp(m + w).toPrecision(6)]); }

  const chg = k => n > k ? a[n - 1] / a[n - 1 - k] - 1 : null;
  const N = Math.min(250, n);
  const rd = v => v == null ? null : +(+v).toPrecision(6);
  return {
    ok: true, H, pUp: +pUp.toFixed(4), confidence, bt: roundObj(bt), contrib, liq: liqNow, illiquid: liqNow < 0.5,
    tradingDays: live.length,
    last: c[n - 1], lastDate: t[n - 1], chg1: chg(1), chg5: chg(5), chg30: chg(21),
    rsi: ind.rsi[n - 1], gap20: a[n - 1] / ind.s20[n - 1] - 1, gap50: a[n - 1] / ind.s50[n - 1] - 1, macd: ind.macd[n - 1] / a[n - 1],
    annVol: sigmaDaily * Math.sqrt(252), cone,
    chart: { t: t.slice(-N), c: a.slice(-N).map(rd), s20: ind.s20.slice(-N).map(rd), s50: ind.s50.slice(-N).map(rd) },
    adjFactor: c[n - 1] / a[n - 1],
  };
}
function roundObj(o) { const r = {}; for (const [k, v] of Object.entries(o)) r[k] = typeof v === "number" ? +v.toFixed(4) : v; return r; }

// Combine model, trend, news, liquidity into one score in [-100,100]
export function signal(an, news) {
  const w = { High: 1, Low: 0.5, None: 0.15, Untested: 0.4 }[an.confidence];
  const tech = (an.pUp - 0.5) * 2 * w;
  const trend = Math.tanh(an.gap50 * 10);
  const nws = news && news.count >= 3 ? news.score : 0;
  const wt = nws ? [0.55, 0.25, 0.2] : [0.65, 0.35, 0];
  let raw = (wt[0] * tech + wt[1] * trend + wt[2] * nws) * 1.6;
  if (an.illiquid) raw *= 0.5;
  // Without a proven model edge, never call it "strong"
  const cap = an.confidence === "High" ? 1 : an.confidence === "Low" ? 0.7 : 0.45;
  const score = Math.round(Math.max(-cap, Math.min(cap, raw)) * 100);
  const label = score >= 55 ? "Strong bullish" : score >= 20 ? "Bullish" : score <= -55 ? "Strong bearish" : score <= -20 ? "Bearish" : "Neutral";
  return { score, label, cls: score >= 20 ? "bull" : score <= -20 ? "bear" : "neu", parts: { tech: +tech.toFixed(3), trend: +trend.toFixed(3), news: +nws.toFixed(3), weight: w } };
}

// ---- headline sentiment ----
const POS = new Set("surge surges surged soar soars soared rally rallies rallied gain gains gained jump jumps jumped climb climbs climbed rise rises rising rose beat beats upgrade upgraded upgrades record bullish outperform outperforms strong stronger boost boosts boosted growth grows profit profits profitable rebound rebounds recover recovers recovery approval approved dividend dividends expansion expands optimism optimistic upbeat highs breakthrough wins buyback inflows eases easing appreciates appreciation stable stabilises stabilizes".split(" "));
const NEG = new Set("plunge plunges plunged fall falls fell drop drops dropped slump slumps slumped miss misses missed downgrade downgraded downgrades loss losses crash crashes crashed bearish weak weaker weakens decline declines declined selloff sell-off fear fears recession default defaults devaluation devalues depreciates depreciation tumble tumbles tumbled slide slides slid warning warns layoffs lawsuit probe fraud scandal hack hacked ban banned sanctions shortage outflows turmoil lows halt halted bankruptcy crisis scarcity losses".split(" "));
const NOT = new Set(["not", "no", "never", "without", "despite"]);
export function headlineScore(title) {
  const w = (title || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
  let s = 0, hits = 0;
  for (let i = 0; i < w.length; i++) { let v = POS.has(w[i]) ? 1 : NEG.has(w[i]) ? -1 : 0; if (!v) continue; if (NOT.has(w[i - 1]) || NOT.has(w[i - 2])) v = -v; s += v; hits++; }
  return hits ? Math.max(-1, Math.min(1, s / Math.max(2, hits))) : 0;
}
export function newsSummary(items, now = Date.now()) {
  if (!items.length) return { count: 0, score: 0, pos: 0, neg: 0 };
  let sw = 0, s = 0, pos = 0, neg = 0;
  for (const it of items) { const wt = Math.exp(-Math.max(0, (now - it.time) / 864e5) / 3); s += it.score * wt; sw += wt; if (it.score > 0.05) pos++; else if (it.score < -0.05) neg++; }
  return { count: items.length, score: +(s / sw).toFixed(3), pos, neg };
}

// Score logged predictions once their horizon has passed.
export function scorePredictions(log, seriesById) {
  for (const p of log) {
    if (p.outcome) continue;
    const s = seriesById[p.id]; if (!s) continue;
    const idx = s.t.indexOf(p.d); if (idx < 0 || idx + p.H >= s.t.length) continue;
    const end = s.a[idx + p.H], start = s.a[idx];
    p.end = s.t[idx + p.H]; p.ret = +(end / start - 1).toFixed(4);
    p.outcome = end > start ? "up" : end < start ? "down" : "flat";
    p.correct = p.outcome === "flat" ? null : (p.p > 0.5) === (p.outcome === "up");
  }
  return log;
}
