// Ищет оценки: Steam для игр, Кинопоиск для фильмов и аниме. Пишет ratings.json.
import fs from "node:fs";
const KP = process.env.KP_TOKEN || "";
const KP_LIMIT = +(process.env.KP_LIMIT || 190);   // запросов к Кинопоиску за один запуск
const STEAM_LIMIT = +(process.env.STEAM_LIMIT || 700);
const STALE = 45 * 864e5, MISS_RETRY = 90 * 864e5;
const data = JSON.parse(fs.readFileSync("data.json", "utf8"));
let R = {}; try { R = JSON.parse(fs.readFileSync("ratings.json", "utf8")); } catch {}
R.steam ||= {}; R.kp ||= {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const norm = s => String(s).toLowerCase().replace(/\(.*?\)/g, " ").split(" + ")[0]
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const due = e => !e || (e.id ? Date.now() - e.u > STALE : Date.now() - e.u > MISS_RETRY);
const save = () => fs.writeFileSync("ratings.json", JSON.stringify(R));

export function pickSteam(title, items) {
  const t = norm(title);
  let best = items.find(i => norm(i.name) === t);
  if (!best) best = items.find(i => { const n = norm(i.name); const [a, b] = n.length < t.length ? [n, t] : [t, n];
    return b.startsWith(a) && a.length / b.length > 0.7 && !/^(\d+|[ivx]+)( |$)/.test(b.slice(a.length).trim()); });
  return best || null;
}
async function steam(it) {
  let id = typeof it.xid === "number" ? it.xid : null;
  if (!id) {
    const r = await fetch("https://store.steampowered.com/api/storesearch/?l=english&cc=us&term=" + encodeURIComponent(norm(it.t)));
    if (r.status === 429) throw new Error("limit");
    const j = await r.json();
    const b = pickSteam(it.t, j.items || []);
    if (!b) return { id: null, u: Date.now() };
    id = b.id;
  }
  const r = await fetch(`https://store.steampowered.com/appreviews/${id}?json=1&language=all&purchase_type=all&num_per_page=0`);
  if (r.status === 429) throw new Error("limit");
  const s = (await r.json()).query_summary || {};
  const n = (s.total_positive || 0) + (s.total_negative || 0);
  if (!n) return { id, pct: null, n: 0, u: Date.now() };
  return { id, pct: Math.round(100 * s.total_positive / n), n, d: s.review_score_desc || "", u: Date.now() };
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
    const r = await fetch("https://api.kinopoisk.dev/v1.4/movie/" + it.xid, { headers: { "X-API-KEY": KP } });
    if ([401, 403, 429].includes(r.status)) throw new Error("limit");
    doc = await r.json();
  } else {
    const r = await fetch("https://api.kinopoisk.dev/v1.4/movie/search?page=1&limit=8&query=" + encodeURIComponent(norm(it.t)), { headers: { "X-API-KEY": KP } });
    if ([401, 403, 429].includes(r.status)) throw new Error("limit");
    doc = pickKp(it.t, (await r.json()).docs || []);
  }
  if (!doc || !doc.id) return { id: null, u: Date.now() };
  const v = doc.rating && doc.rating.kp ? Math.round(doc.rating.kp * 10) / 10 : null;
  return { id: doc.id, r: v, u: Date.now() };
}
async function run(list, store, fn, limit, gap) {
  const todo = list.filter(it => it.xid !== "-" && due(store[it.t])).slice(0, limit);
  console.log("к обработке:", todo.length);
  for (const it of todo) {
    try { store[it.t] = await fn(it); }
    catch (e) { console.log("остановка:", e.message); break; }
    await sleep(gap);
    if (Math.random() < 0.05) save();
  }
}
if (process.argv[1] && process.argv[1].endsWith("ratings.mjs")) {
  await run(data.games || [], R.steam, steam, STEAM_LIMIT, 1200);
  save();
  if (KP) await run([...(data.movies || []), ...(data.anime || [])], R.kp, kp, KP_LIMIT, 400);
  else console.log("KP_TOKEN не задан, Кинопоиск пропущен");
  save();
}
