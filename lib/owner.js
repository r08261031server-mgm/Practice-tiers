'use strict';
/* オーナー用ログイン（スキン認証を飛ばして、そのMCIDとして入る）
 * 入力欄に「合言葉@MCID」と打つと使える。
 * 合言葉そのものは、このコードにも GitHub にも書かれておらず、GAS のスクリプトプロパティ OWNER_KEY にだけある。
 * 合っているかの確認は GAS が行う。間違いが続くと、一定時間ロックされる。 */
const db = require('./db');

// 失敗が続いたらロックする入れ物：windowMs の間に max 回失敗 → lockMs の間ロック
function makeLimiter(max, windowMs, lockMs) {
  const m = new Map();
  return {
    locked: k => (m.get(k) ? m.get(k).until : 0) > Date.now(),
    fail(k) {
      const now = Date.now();
      let e = m.get(k);
      if (!e || now - e.t0 > windowMs) e = { n: 0, t0: now, until: 0 };
      if (++e.n >= max) { e.until = now + lockMs; e.n = 0; e.t0 = now; }
      m.set(k, e);
      if (m.size > 5000) m.delete(m.keys().next().value);      // 溜まりすぎないよう、古いものから消す
    },
    reset: k => m.delete(k),
  };
}
const perIp = makeLimiter(5, 10 * 60e3, 10 * 60e3);     // 同じIPから10分で5回失敗 → 10分ロック
const overall = makeLimiter(50, 60 * 60e3, 10 * 60e3);  // 全体で1時間に50回失敗 → 10分ロック

// 「何か@MCID」の形なら { key, name } を返す（それ以外は null）
exports.parse = text => {
  const i = text.lastIndexOf('@');
  const name = text.slice(i + 1).trim();
  return i > 0 && /^\w{3,16}$/.test(name) ? { key: text.slice(0, i), name } : null;
};

// 合言葉が合っていれば true（確認はGAS）。ロック中・GASに届かないときは false
exports.verify = async (ip, key) => {
  if (perIp.locked(ip) || overall.locked('all')) return false;
  let ok = false;
  try { ok = await db.ownerCheck(key); }
  catch (e) { console.error('[owner] GASで確認できませんでした:', e.message); }
  if (ok) perIp.reset(ip);
  else { perIp.fail(ip); overall.fail('all'); }
  return ok;
};
