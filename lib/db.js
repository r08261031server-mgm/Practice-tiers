'use strict';
/* GAS(スプレッドシート)をDBとして使う層。
 * ・起動時に全部読み込み → 以後はメモリで動くので速い（GASの遅さが気にならない）
 * ・書き込みは変更をためて、まとめて(バッチで)GASへ送る
 * ・スプレッドシートを手で直した内容（行を消す・値を直す）も、定期的に読み直して反映する（refreshAll） */
const cfg = require('./config');
const GAS_URL = process.env.GAS_URL;
const GAS_SECRET = process.env.GAS_SECRET;

const users = new Map();    // uuid -> { id, mcid, color, owned[], sp, createdAt }
const ratings = new Map();  // rating.id -> { id, userId, event, tier, best, testedAt, testerId }
const byUser = new Map();   // uuid -> Map(event -> rating)
const EMPTY = new Map();
let admins = [];            // [{ raw, mcid, uuid }]  ← スプレッドシートの「admins」シート

let queue = [], timer = null, flushing = false;
let seq = 0;                // このサーバーが書き込んだ回数（読み直しとの行き違いを防ぐのに使う）
const touched = new Map();  // "users:uuid" / "ratings:uuid:event" -> 最後に書き込んだ番号

async function gas(payload) {
  const res = await fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret: GAS_SECRET, ...payload }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('GASの応答がJSONではありません: ' + text.slice(0, 120)); }
  if (!json.ok) throw new Error('GASエラー: ' + json.error);
  return json;
}

const has = (obj, k) => Object.hasOwn(obj, k);
const tierIdx = t => cfg.TIERS.indexOf(t);
const normTier = t => { t = String(t ?? '').trim().toUpperCase(); return cfg.TIERS.includes(t) ? t : ''; };

// シートの1行 → サーバー内の形（手で入力した値が多少おかしくても、安全な形に直す）
function parseUser(r) {
  const id = String(r.id ?? '').trim(), mcid = String(r.mcid ?? '').trim();
  if (!id || !mcid) return null;
  const color = String(r.color ?? '').trim();
  return {
    id, mcid, color: has(cfg.COLORS, color) ? color : '',
    owned: String(r.owned ?? '').split(',').map(s => s.trim()).filter(c => has(cfg.COLORS, c)),
    sp: Math.max(0, Number(r.sp) || 0), createdAt: Number(r.createdAt) || 0,
  };
}
function parseRating(r) {
  const userId = String(r.userId ?? '').trim(), event = String(r.event ?? '').trim();
  if (!userId || !event) return null;
  const tier = normTier(r.tier);
  let best = normTier(r.best);
  if (tierIdx(tier) > tierIdx(best)) best = tier;      // 手でTierを上げても、あとからSPが付かないようにする
  return {
    id: String(r.id ?? '').trim() || userId + ':' + event, userId, event, tier, best,
    testedAt: Number(r.testedAt) || 0, testerId: String(r.testerId ?? '').trim(),
  };
}
const toAdmins = rows => rows
  .map(a => ({ raw: String(a.mcid ?? ''), mcid: String(a.mcid ?? '').trim(), uuid: String(a.uuid ?? '').trim() }))
  .filter(a => a.mcid);

function index(r) {
  ratings.set(r.id, r);
  if (!byUser.has(r.userId)) byUser.set(r.userId, new Map());
  byUser.get(r.userId).set(r.event, r);
}
function unindex(r) {
  ratings.delete(r.id);
  const m = byUser.get(r.userId);
  if (m) { m.delete(r.event); if (!m.size) byUser.delete(r.userId); }
}
const sameUser = (a, b) => a.mcid === b.mcid && a.color === b.color && a.sp === b.sp && a.createdAt === b.createdAt && a.owned.join() === b.owned.join();
const sameRating = (a, b) => a.id === b.id && a.tier === b.tier && a.best === b.best && a.testedAt === b.testedAt && a.testerId === b.testerId;

// シートの内容を、サーバーの記憶に合わせ込む（シートが正。ただし読み込み中にこのサーバーが書いた行は触らない）
function applySheet(d, start) {
  const skip = k => (touched.get(k) || 0) > start;
  let changed = false;
  const removed = [];

  const su = new Map();
  for (const row of d.users || []) { const u = parseUser(row); if (u) su.set(u.id, u); }
  for (const [id, u] of su) {
    if (skip('users:' + id)) continue;
    const old = users.get(id);
    if (!old) { users.set(id, u); changed = true; }
    else if (!sameUser(old, u)) { Object.assign(old, u); changed = true; }
  }
  for (const id of [...users.keys()]) {
    if (!su.has(id) && !skip('users:' + id)) { users.delete(id); removed.push(id); changed = true; }
  }

  const sr = new Map();
  for (const row of d.ratings || []) { const r = parseRating(row); if (r) sr.set(r.userId + ':' + r.event, r); }
  for (const [k, r] of sr) {
    if (skip('ratings:' + k)) continue;
    const old = (byUser.get(r.userId) || EMPTY).get(r.event);
    if (!old) { index(r); changed = true; }
    else if (!sameRating(old, r)) { unindex(old); Object.assign(old, r); index(old); changed = true; }
  }
  for (const r of [...ratings.values()]) {
    const k = r.userId + ':' + r.event;
    if (!sr.has(k) && !skip('ratings:' + k)) { unindex(r); changed = true; }
  }

  admins = toAdmins(d.admins || []);
  return { changed, removed };
}

async function load() {
  if (!GAS_URL) {
    console.warn('[db] GAS_URL が未設定です。メモリのみで動作します（再起動すると消えます）');
    return;
  }
  applySheet(await gas({ action: 'load' }), seq);
  console.log(`[db] 読み込み完了: users=${users.size} ratings=${ratings.size} admins=${admins.length}`);
}

// スプレッドシートを手で直した内容を取り込む（行を消した → 記憶からも消える／値を直した → 記憶も直る）
async function refreshAll() {
  if (!GAS_URL || queue.length || flushing) return { changed: false, removed: [] };   // 書き込み待ちがある間は、次の機会に
  const start = seq;
  const res = applySheet(await gas({ action: 'load' }), start);
  for (const [k, v] of touched) if (v <= start) touched.delete(k);
  return res;
}

// 管理者リストだけ取り直す（古い server.js が呼んでいても動くよう残してある）
async function refreshAdmins() {
  if (!GAS_URL) return;
  try { admins = toAdmins((await gas({ action: 'admins' })).admins || []); }
  catch (e) { console.error('[db] 管理者リストの更新に失敗しました:', e.message); }
}

function push(op) {
  seq++;
  const r = op.row;
  if (op.t === 'users') touched.set('users:' + r.id, seq);
  else if (op.t === 'ratings') touched.set('ratings:' + r.userId + ':' + r.event, seq);
  queue.push(op);
  if (!timer) timer = setTimeout(flush, 1500);
}

async function flush() {
  timer = null;
  if (!GAS_URL || flushing || !queue.length) return;
  flushing = true;
  const ops = queue.splice(0, 100);
  try {
    await gas({ action: 'batch', ops });
  } catch (e) {
    console.error('[db] 書き込み失敗。あとで再送します:', e.message);
    queue.unshift(...ops);
  }
  flushing = false;
  if (queue.length) timer = setTimeout(flush, 2000);
}

// 終了時に残りを書き出す
async function flushAll() {
  clearTimeout(timer); timer = null;
  for (let i = 0; i < 5 && queue.length && !flushing; i++) await flush();
}

module.exports = {
  users, load, flushAll, refreshAll, refreshAdmins,
  getAdmins: () => admins,
  ownerCheck: async key => (GAS_URL ? (await gas({ action: 'owner', key })).owner === true : false),   // 合言葉の確認はGAS側
  pinAdmin: a => push({ t: 'admins', op: 'upsert', row: { mcid: a.raw, uuid: a.uuid } }),
  getRating: (uid, ev) => (byUser.get(uid) || EMPTY).get(ev),
  ratingsOf: uid => byUser.get(uid) || EMPTY,
  findByMcid: name => [...users.values()].find(u => u.mcid.toLowerCase() === String(name).toLowerCase()),
  saveUser(u) {
    users.set(u.id, u);
    push({ t: 'users', op: 'upsert', row: { ...u, owned: u.owned.join(',') } });
  },
  saveRating(r) {
    index(r);
    push({ t: 'ratings', op: 'upsert', row: r });
  },
  addHistory(row) {
    push({ t: 'history', op: 'append', row });
  },
};
