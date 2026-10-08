'use strict';
/* GAS(スプレッドシート)をDBとして使う層。
 * ・読み込みは起動時に1回だけ → 以後はメモリで動くので速い（GASの遅さが気にならない）
 * ・書き込みは変更をためて、まとめて(バッチで)GASへ送る */
const GAS_URL = process.env.GAS_URL;
const GAS_SECRET = process.env.GAS_SECRET;

const users = new Map();    // uuid -> { id, mcid, color, owned[], sp, createdAt }
const ratings = new Map();  // "uuid:event" -> { id, userId, event, tier, best, testedAt, testerId }
const byUser = new Map();   // uuid -> Map(event -> rating)
const EMPTY = new Map();

let queue = [], timer = null, flushing = false;

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

function index(r) {
  ratings.set(r.id, r);
  if (!byUser.has(r.userId)) byUser.set(r.userId, new Map());
  byUser.get(r.userId).set(r.event, r);
}

async function load() {
  if (!GAS_URL) {
    console.warn('[db] GAS_URL が未設定です。メモリのみで動作します（再起動すると消えます）');
    return;
  }
  const d = await gas({ action: 'load' });
  for (const u of d.users) {
    users.set(u.id, {
      id: u.id, mcid: u.mcid, color: u.color || '',
      owned: u.owned ? u.owned.split(',').filter(Boolean) : [],
      sp: Number(u.sp) || 0, createdAt: Number(u.createdAt) || 0,
    });
  }
  for (const r of d.ratings) {
    index({
      id: r.id, userId: r.userId, event: r.event, tier: r.tier || '', best: r.best || '',
      testedAt: Number(r.testedAt) || 0, testerId: r.testerId || '',
    });
  }
  console.log(`[db] 読み込み完了: users=${users.size} ratings=${ratings.size}`);
}

function push(op) {
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
  users, load, flushAll,
  getRating: (uid, ev) => ratings.get(uid + ':' + ev),
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
