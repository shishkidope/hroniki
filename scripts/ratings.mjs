// Ищет оценки: Steam для игр, Кинопоиск для фильмов и аниме. Пишет ratings.json.
import fs from "node:fs";
const KP = process.env.KP_TOKEN || "";
const KP_LIMIT = +(process.env.KP_LIMIT || 190);   // запросов к Кинопоиску за один запуск
const STEAM_LIMIT = +(process.env.STEAM_LIMIT || 700);
const STALE = 45 * 864e5, MISS_RETRY = 3 * 864e5;
const data = JSON.parse(fs.readFileSync("data.json", "utf8"));
let R = {}; try { R = JSON.parse(fs.readFileSync("ratings.json", "utf8")); } catch {}
R.steam ||= {}; R.kp ||= {};
if (R.v !== 2) { for (const k of Object.keys(R.steam)) if (!R.steam[k].id) delete R.steam[k]; R.v = 2; }
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
async function getJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { "User-Agent": UA, "Accept": "application/json", "Accept-Language": "en-US,en;q=0.9", ...(opts.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url.split("?")[0] + " " + t.slice(0, 120));
  try { return JSON.parse(t); } catch { throw new Error("ответ не JSON (" + r.status + ") " + url.split("?")[0] + " " + t.slice(0, 80).replace(/\s+/g, " ")); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const norm = s => String(s).toLowerCase().replace(/\(.*?\)/g, " ").split(" + ")[0]
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const due = e => !e || (e.id ? Date.now() - e.u > STALE : Date.now() - e.u > MISS_RETRY);
const save = () => fs.writeFileSync("ratings.json", JSON.stringify(R));

const STOP = new Set(["the", "a", "an", "of", "and", "to"]);
const ED = new Set(["edition", "remastered", "remaster", "definitive", "deluxe", "goty", "game", "year", "complete", "enhanced", "director", "s", "cut", "collection", "ultimate", "anniversary", "prepare", "die", "hd", "redux", "reloaded", "reforged", "special", "legendary", "gold", "digital", "version", "bundle"]);
const core = s => norm(s).split(" ").filter(w => w && !STOP.has(w) && !ED.has(w));
const key = a => [...new Set(a)].sort().join(" ");
export function pickSteam(title, items) {
  const t = norm(title);
  const exact = items.find(i => norm(i.name) === t);
  if (exact) return exact;
  const T = core(title);
  if (!T.length) return null;
  return items.find(i => { const C = core(i.name); return C.length && key(C) === key(T); }) || null;
}
async function steam(it) {
  let id = typeof it.xid === "number" ? it.xid : null;
  if (!id) {
    const term = encodeURIComponent(norm(it.t));
    let items;
    try { items = (await getJson("https://store.steampowered.com/api/storesearch/?l=english&cc=us&term=" + term)).items || []; }
    catch (e) {
      if (!/не JSON/.test(e.message)) throw e;
      const h = await (await fetch("https://store.steampowered.com/search/suggest?f=games&cc=US&l=english&term=" + term, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" } })).text();
      items = [...h.matchAll(/data-ds-appid="(\d+)"[\s\S]*?<div class="match_name">([^<]*)<\/div>/g)].map(m => ({ id: +m[1], name: m[2].replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"') }));
      if (!items.length && !/match_name|search_suggest/.test(h)) throw new Error("Steam вернул не то: " + h.slice(0, 100));
    }
    const b = pickSteam(it.t, items);
    if (!b) return { id: null, c: items.slice(0, 3).map(i => [i.id, i.name]), u: Date.now() };
    id = b.id;
  }
  const v = await reviews(id);
  return { id, pct: v.pct, n: v.n, d: v.d, u: Date.now() };
}
async function reviews(id) {
  try {
    const s = (await getJson(`https://store.steampowered.com/appreviews/${id}?json=1&language=all&purchase_type=all&num_per_page=0`)).query_summary || {};
    const n = (s.total_positive || 0) + (s.total_negative || 0);
    return { pct: n ? Math.round(100 * s.total_positive / n) : null, n, d: s.review_score_desc || "" };
  } catch (e) {
    if (!/не JSON/.test(e.message)) throw e;
    const j = await getJson("https://steamspy.com/api.php?request=appdetails&appid=" + id);   // запасной источник
    const n = (j.positive || 0) + (j.negative || 0);
    return { pct: n ? Math.round(100 * j.positive / n) : null, n, d: "" };
  }
}
export function pickKp(title, docs) {
  const y = +((String(title).match(/\((?:[^)]*?)(\d{4})/) || [])[1] || 0), t = norm(title);
  const ok = d => [d.name, d.alternativeName, d.enName].filter(Boolean).some(n => norm(n) === t);
  const yr = d => !y || !d.year || Math.abs(d.year - y) <= 1;
  return docs.find(d => ok(d) && yr(d)) || docs.find(d => ok(d)) || null;
}
async function kp(it) {
  let doc;
  if (typeof it.xid === "number") {
    doc = await getJson("https://api.kinopoisk.dev/v1.4/movie/" + it.xid, { headers: { "X-API-KEY": KP } });
  } else {
    doc = pickKp(it.t, ((await getJson("https://api.kinopoisk.dev/v1.4/movie/search?page=1&limit=8&query=" + encodeURIComponent(norm(it.t)), { headers: { "X-API-KEY": KP } })).docs) || []);
  }
  if (!doc || !doc.id) return { id: null, u: Date.now() };
  const v = doc.rating && doc.rating.kp ? Math.round(doc.rating.kp * 10) / 10 : null;
  return { id: doc.id, r: v, u: Date.now() };
}
async function run(list, store, fn, limit, gap) {
  const todo = list.filter(it => it.xid !== "-" && due(store[it.t])).slice(0, limit);
  console.log(fn.name, "к обработке:", todo.length);
  let ok = 0, miss = 0;
  for (const it of todo) {
    try { store[it.t] = await fn(it); }
    catch (e) { console.log(fn.name, "остановка на «" + it.t + "»:", e.message); break; }
    if (store[it.t].id) ok++; else miss++;
    if (ok + miss <= 8) console.log("  ", it.t, "→", JSON.stringify(store[it.t]));
    await sleep(gap);
    if (Math.random() < 0.05) save();
  }
  console.log(fn.name, "найдено:", ok, "не найдено:", miss);
}
if (process.argv[1] && process.argv[1].endsWith("ratings.mjs")) {
  console.log("ratings.mjs v5");
  await run(data.games || [], R.steam, steam, STEAM_LIMIT, 1200);
  save();
  const lines = [];
  for (const [t, e] of Object.entries(R.steam)) if (!e.id && e.c && e.c.length) lines.push("- **" + t + "** → " + e.c.map(([id, n]) => `[${n}](https://store.steampowered.com/app/${id}/)`).join(" · "));
  fs.writeFileSync("unmatched.md", "# Игры без оценки Steam\n\nЕсли среди вариантов есть нужная, скопируй ссылку и вставь в поле «Оценка агрегатора» этой записи на сайте.\n\n" + lines.join("\n") + "\n");
  if (KP) await run([...(data.movies || []), ...(data.anime || [])], R.kp, kp, KP_LIMIT, 400);
  else console.log("KP_TOKEN не задан, Кинопоиск пропущен");
  save();
}
