'use strict';
/* Practice Tiers - サーバー（Express + Socket.IO）
 * データ: GAS(スプレッドシート) / MCID連携: スキン認証 or Microsoft
 * ログインはCookieではなく「トークン」方式。HTMLをどこ（Render / OneCompiler など）に置いても動く */
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cfg = require('./lib/config');
const db = require('./lib/db');
const auth = require('./lib/auth');

const PORT = process.env.PORT || 3000;
const ENV_ADMINS = (process.env.ADMIN_MCIDS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean); // 任意。基本はスプレッドシートの admins シートで管理
const RETEST_MS = Number(process.env.RETEST_DAYS ?? 14) * 864e5; // 同じ種目を再テストできるまでの日数
const OFFLINE_MS = 3 * 60e3;                                       // 切断が続いたら受付/待機を自動解除

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// どのサイト（OneCompilerなど）のHTMLからでも呼べるようにする。Cookieは使わずトークン認証なので安全
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));   // public/index.html があれば、それがトップページになる
app.get('/', (_, res) => res.type('text/plain').send('Practice Tiers のサーバーは動いています。'));
app.get('/healthz', (_, res) => res.send('ok'));

const fail = msg => { throw new Error(msg); };

// ログイン状態 = 「Authorization: Bearer トークン」（ブラウザが保存して、毎回送ってくる）
const bearer = h => (String(h || '').match(/^Bearer (.+)$/) || [])[1];
const userFromToken = t => { const p = auth.verify(t); return p ? db.users.get(p.uid) || null : null; };

/* ================= ゲームロジック（Tier・ポイント・称号） ================= */
const tierIdx = t => cfg.TIERS.indexOf(t);                       // 未ランクは -1
const hasEvent = id => cfg.EVENTS.some(e => e.id === id);
const evName = id => (cfg.EVENTS.find(e => e.id === id) || {}).name || id;
// 管理者(OP)：スプレッドシートの「admins」シートに書かれたMCID（＋任意で環境変数 ADMIN_MCIDS）。
// その人が一度ログインするとUUIDが自動で記録され、以後は改名されても、同じ名前を取った別人が現れても、本人だけが管理者のまま。
const isAdmin = u => !!u && (
  ENV_ADMINS.includes(u.mcid.toLowerCase()) ||
  db.getAdmins().some(a => (a.uuid ? a.uuid === u.id : a.mcid.toLowerCase() === u.mcid.toLowerCase()))
);
function pinAdmins() {
  for (const a of db.getAdmins()) {
    if (a.uuid) continue;
    const u = db.findByMcid(a.mcid);
    if (u) { a.uuid = u.id; db.pinAdmin(a); }
  }
}
const tierOf = (uid, ev) => (db.getRating(uid, ev) || {}).tier || '';
const titleOf = p => cfg.TITLES.find(t => p >= t.min).name;
const pointsOf = uid => {
  let p = 0;
  for (const r of db.ratingsOf(uid).values()) p += cfg.TIER_POINTS[r.tier] || 0;
  return p;
};

// 公開用プレイヤー情報（誰のものでも見られる）
function pv(uid) {
  const u = db.users.get(uid);
  const ratings = {};
  for (const r of db.ratingsOf(uid).values()) if (r.tier) ratings[r.event] = r.tier;
  const points = pointsOf(uid);
  return { id: uid, mcid: u ? u.mcid : '???', color: u ? u.color : '', points, title: titleOf(points), ratings };
}

// テスターになれる種目（その種目で LT3 以上。管理者は全種目）
const testerEvents = u => isAdmin(u)
  ? cfg.EVENTS.map(e => e.id)
  : cfg.EVENTS.filter(e => tierIdx(tierOf(u.id, e.id)) >= tierIdx(cfg.TESTER_MIN_TIER)).map(e => e.id);

// テスターが付けられるTier（自分のTier以下。管理者は全部）
const allowedTiers = (u, ev) => isAdmin(u) ? cfg.TIERS : cfg.TIERS.filter((_, i) => i <= tierIdx(tierOf(u.id, ev)));

/* ================= テスト（受付・待機列・チャット部屋） ================= */
const sessions = new Map();   // testerId -> { id, event, queue:[uid], roomId }
const rooms = new Map();      // roomId -> { id, testerId, playerId, event, state:'chat'|'testing', messages, seq }
const userRoom = new Map();   // uid -> roomId（テスター・受験者どちらも）
const userQueue = new Map();  // uid -> testerId（待機中）
const online = new Map();     // uid -> Set(socketId)
const offTimers = new Map();

function sessionView(s) {
  const room = s.roomId && rooms.get(s.roomId);
  return {
    id: s.id, event: s.event, tester: pv(s.id), queue: s.queue.map(pv),
    current: room ? pv(room.playerId) : null, state: room ? room.state : 'idle',
  };
}
const sessionViews = () => [...sessions.values()].map(sessionView);

function roomView(r, uid) {
  const isTester = r.testerId === uid;
  return {
    id: r.id, event: r.event, state: r.state, role: isTester ? 'tester' : 'player',
    tester: pv(r.testerId), player: pv(r.playerId),
    allowed: isTester ? allowedTiers(db.users.get(uid), r.event) : [],
    messages: r.messages,
  };
}

function meState(uid) {
  const u = db.users.get(uid);
  if (!u) return null;
  const room = userRoom.has(uid) && rooms.get(userRoom.get(uid));
  const s = sessions.get(uid);
  return {
    user: { ...pv(uid), sp: u.sp, owned: u.owned },
    isAdmin: isAdmin(u),
    testerEvents: testerEvents(u),
    session: s ? sessionView(s) : null,
    queuedIn: userQueue.get(uid) || null,
    room: room ? roomView(room, uid) : null,
  };
}

const pushMe = uid => io.to('u:' + uid).emit('me', meState(uid));
const toast = (uid, msg) => io.to('u:' + uid).emit('toast', msg);
function refresh(uids = []) {              // 受付一覧を全員へ、本人の状態を関係者へ
  io.emit('sessions', sessionViews());
  new Set(uids).forEach(pushMe);
}

function say(r, text, from = null, name = '') {
  const m = { n: ++r.seq, from, name, text, t: Date.now() };
  r.messages.push(m);
  if (r.messages.length > 200) r.messages.shift();
  io.to('u:' + r.testerId).to('u:' + r.playerId).emit('chat:msg', { roomId: r.id, ...m });
}

// 受付中で、チャット中の人がいなければ、待機列の先頭とテスターの一時チャットを作る
function pump(s) {
  if (!s || s.roomId || !s.queue.length) return;
  const playerId = s.queue.shift();
  userQueue.delete(playerId);
  const r = { id: crypto.randomBytes(6).toString('hex'), testerId: s.id, playerId, event: s.event, state: 'chat', messages: [], seq: 0 };
  rooms.set(r.id, r);
  s.roomId = r.id;
  userRoom.set(s.id, r.id);
  userRoom.set(playerId, r.id);
  say(r, 'テストチャットが始まりました。テスターの案内に従って、指定のサーバーに入ってください。');
  toast(playerId, 'あなたの順番です！テストチャットが始まりました');
  pushMe(playerId);
}

function dropRoom(r) {
  rooms.delete(r.id);
  userRoom.delete(r.testerId);
  userRoom.delete(r.playerId);
  const s = sessions.get(r.testerId);
  if (s) s.roomId = null;
}

function openSession(u, ev) {
  if (!hasEvent(ev)) fail('種目が不正です');
  if (!testerEvents(u).includes(ev)) fail(`この種目のテスターではありません（${cfg.TESTER_MIN_TIER}以上が必要です）`);
  if (sessions.has(u.id) || userRoom.has(u.id) || userQueue.has(u.id)) fail('すでにテストに参加中です');
  sessions.set(u.id, { id: u.id, event: ev, queue: [], roomId: null });
  refresh([u.id]);
}

function closeSession(tid, msg = 'テストの受付が終了しました') {
  const s = sessions.get(tid);
  if (!s) return;
  const ids = [tid, ...s.queue];
  if (s.roomId) { const r = rooms.get(s.roomId); ids.push(r.playerId); dropRoom(r); }
  s.queue.forEach(id => userQueue.delete(id));
  sessions.delete(tid);
  ids.forEach(id => toast(id, msg));
  refresh(ids);
}

function joinQueue(u, sid) {
  const s = sessions.get(sid);
  if (!s) fail('このテストはすでに終了しています');
  if (s.id === u.id) fail('自分のテストには申請できません');
  if (sessions.has(u.id) || userRoom.has(u.id) || userQueue.has(u.id)) fail('すでに他のテストに参加中です');
  if (s.queue.length >= cfg.QUEUE_MAX) fail('待機列が満員です');
  const rt = db.getRating(u.id, s.event);
  const wait = rt && rt.testedAt ? rt.testedAt + RETEST_MS - Date.now() : 0;
  if (wait > 0 && !isAdmin(u)) fail(`この種目は再テストまであと${Math.ceil(wait / 864e5)}日待つ必要があります`);
  s.queue.push(u.id);
  userQueue.set(u.id, s.id);
  pump(s);
  refresh([u.id, s.id]);
}

function leaveQueue(u) {
  const sid = userQueue.get(u.id);
  if (!sid) fail('待機列にいません');
  const s = sessions.get(sid);
  if (s) s.queue = s.queue.filter(id => id !== u.id);
  userQueue.delete(u.id);
  refresh([u.id, sid]);
}

const myRoom = u => {
  const r = rooms.get(userRoom.get(u.id));
  if (!r) fail('チャットがありません');
  return r;
};

function startTest(u) {
  const r = myRoom(u);
  if (r.testerId !== u.id) fail('テスターだけが操作できます');
  if (r.state !== 'chat') fail('すでに開始しています');
  r.state = 'testing';
  say(r, 'テストが開始されました');
  refresh([r.testerId, r.playerId]);
}

function cancelRoom(u) {
  const r = myRoom(u);
  const isTester = r.testerId === u.id;
  if (!isTester && r.state === 'testing') fail('テスト中は退出できません。テスターに伝えてください');
  dropRoom(r);
  toast(isTester ? r.playerId : r.testerId, isTester ? 'テスターがチャットを閉じました' : '相手が退出しました');
  pump(sessions.get(r.testerId));
  refresh([r.testerId, r.playerId]);
}

// テスト終了：合否(Tier)を記録 → ランクポイントは自動計算 → チャットは自動で閉じる
function endTest(u, result) {
  const r = myRoom(u);
  if (r.testerId !== u.id) fail('テスターだけが操作できます');
  if (r.state !== 'testing') fail('先に「テスト開始」を押してください');
  if (result && !allowedTiers(u, r.event).includes(result)) fail('そのTierは付けられません（自分のTier以下まで）');

  const p = db.users.get(r.playerId);
  const rt = db.getRating(p.id, r.event) ||
    { id: p.id + ':' + r.event, userId: p.id, event: r.event, tier: '', best: '', testedAt: 0, testerId: '' };
  const from = rt.tier, to = result || rt.tier;      // result が空 = 不合格(変更なし)
  rt.tier = to; rt.testedAt = Date.now(); rt.testerId = u.id;

  let sp = 0;                                         // 自己ベスト更新時だけSPを付与（行き来による水増し防止）
  if (tierIdx(to) > tierIdx(rt.best)) {
    sp = (cfg.TIER_POINTS[to] - (cfg.TIER_POINTS[rt.best] || 0)) * cfg.SP_PER_POINT;
    rt.best = to;
    p.sp += sp;
    db.saveUser(p);
  }
  db.saveRating(rt);
  db.addHistory({
    time: new Date().toISOString(), event: r.event, playerId: p.id, playerMcid: p.mcid,
    testerId: u.id, testerMcid: u.mcid, from, to, spGain: sp,
  });
  toast(p.id, result
    ? `${evName(r.event)} の結果: ${to}${sp ? `（+${sp} SP）` : ''}`
    : `${evName(r.event)} の結果: 変更なし`);
  dropRoom(r);
  pump(sessions.get(u.id));
  refresh([u.id, p.id]);
  io.emit('players:changed');
}

function chat(u, text) {
  const r = myRoom(u);
  text = String(text || '').trim().slice(0, 300);
  if (text) say(r, text, u.id, u.mcid);
}

// 管理者：Tierを直接設定（最初のテスターを作る用。SPは付かない）
function adminSetTier(u, d) {
  if (!isAdmin(u)) fail('管理者だけが使えます');
  const t = db.findByMcid(d.mcid);
  if (!t) fail('そのMCIDはまだ連携されていません（一度ログインしてもらってください）');
  if (!hasEvent(d.event)) fail('種目が不正です');
  if (d.tier && !cfg.TIERS.includes(d.tier)) fail('Tierが不正です');
  const rt = db.getRating(t.id, d.event) ||
    { id: t.id + ':' + d.event, userId: t.id, event: d.event, tier: '', best: '', testedAt: 0, testerId: '' };
  const from = rt.tier;
  rt.tier = d.tier || '';
  if (tierIdx(rt.tier) > tierIdx(rt.best)) rt.best = rt.tier;
  rt.testerId = u.id;
  db.saveRating(rt);
  db.addHistory({
    time: new Date().toISOString(), event: d.event, playerId: t.id, playerMcid: t.mcid,
    testerId: u.id, testerMcid: u.mcid + '(admin)', from, to: rt.tier, spGain: 0,
  });
  io.emit('players:changed');
  refresh([t.id, u.id]);
}

/* ================= Socket.IO ================= */
io.use((socket, next) => {
  const u = userFromToken(socket.handshake.auth && socket.handshake.auth.token);
  socket.uid = u ? u.id : null;
  next();
});

io.on('connection', socket => {
  const uid = socket.uid;
  socket.emit('sessions', sessionViews());
  if (uid) {
    socket.join('u:' + uid);
    if (!online.has(uid)) online.set(uid, new Set());
    online.get(uid).add(socket.id);
    clearTimeout(offTimers.get(uid));
    socket.emit('me', meState(uid));
  }

  const on = (ev, fn) => socket.on(ev, (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const u = uid && db.users.get(uid);
    if (!u) return ack({ error: 'ログインが必要です' });
    try { fn(u, data || {}); ack({ ok: true }); } catch (e) { ack({ error: e.message }); }
  });
  on('session:open', (u, d) => openSession(u, d.event));
  on('session:close', u => closeSession(u.id));
  on('queue:join', (u, d) => joinQueue(u, d.sessionId));
  on('queue:leave', u => leaveQueue(u));
  on('room:start', u => startTest(u));
  on('room:end', (u, d) => endTest(u, d.result || ''));
  on('room:cancel', u => cancelRoom(u));
  on('chat:send', (u, d) => chat(u, d.text));
  on('admin:setTier', (u, d) => adminSetTier(u, d));

  socket.on('disconnect', () => {
    if (!uid) return;
    const set = online.get(uid);
    set.delete(socket.id);
    if (!set.size) offTimers.set(uid, setTimeout(() => goneOffline(uid), OFFLINE_MS));
  });
});

function goneOffline(uid) {
  if (online.get(uid)?.size) return;
  if (sessions.has(uid)) closeSession(uid, 'テスターが退席したため受付を終了しました');
  else if (userQueue.has(uid)) leaveQueue(db.users.get(uid));
}

/* ================= REST API ================= */
const authedUser = req => userFromToken(bearer(req.headers.authorization));

app.get('/api/config', (_, res) => res.json({
  events: cfg.EVENTS, tiers: cfg.TIERS, tierPoints: cfg.TIER_POINTS, titles: cfg.TITLES,
  colors: cfg.COLORS, queueMax: cfg.QUEUE_MAX, testerMinTier: cfg.TESTER_MIN_TIER, spPerPoint: cfg.SP_PER_POINT,
  msLogin: auth.msEnabled,
}));

app.get('/api/me', (req, res) => {
  const u = authedUser(req);
  res.json(u ? meState(u.id) : null);
});

// ランク持ちの全プレイヤー（ランキング・種目別ボード用）
app.get('/api/players', (_, res) => {
  res.json([...db.users.keys()].map(pv).filter(p => Object.keys(p.ratings).length));
});

// 誰のTier/ポイントでも見られる（アイコンをタップした時）
app.get('/api/player/:id', (req, res) => {
  const u = db.users.get(req.params.id) || db.findByMcid(req.params.id);
  if (!u) return res.status(404).json({ error: 'プレイヤーが見つかりません' });
  res.json(pv(u.id));
});

/* ---- ショップ（名前の色） ---- */
function shop(req, res, fn) {
  const u = authedUser(req);
  if (!u) return res.status(401).json({ error: 'ログインが必要です' });
  try {
    fn(u, req.body || {});
    db.saveUser(u);
    io.emit('players:changed');
    refresh([u.id]);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
}
app.post('/api/shop/buy', (req, res) => shop(req, res, (u, d) => {
  if (!Object.hasOwn(cfg.COLORS, d.color)) fail('不正な色です');
  const c = cfg.COLORS[d.color];
  if (u.owned.includes(d.color)) fail('すでに持っています');
  if (u.sp < c.price) fail('SPが足りません');
  u.sp -= c.price;
  u.owned.push(d.color);
  u.color = d.color;
}));
app.post('/api/shop/equip', (req, res) => shop(req, res, (u, d) => {
  if (d.color && !u.owned.includes(d.color)) fail('その色は持っていません');
  u.color = d.color || '';
}));

/* ---- ログイン / MCID連携（成功するとトークンを返す。ブラウザ側が保存して、以後ずっと送る） ---- */
function loginAs(uuid, name) {
  let u = db.users.get(uuid);
  if (!u) { u = { id: uuid, mcid: name, color: '', owned: [], sp: 0, createdAt: Date.now() }; db.saveUser(u); }
  else if (u.mcid !== name) { u.mcid = name; db.saveUser(u); }          // 改名に追従（名前はMCIDに固定）
  pinAdmins();                                                          // 管理者リストにある人なら、ここでUUIDを記録
  return auth.sign({ uid: uuid });
}

// A) スキン認証（Mojangの承認いらず）
const UUID_RE = /^[0-9a-f]{32}$/;
app.post('/auth/skin/start', async (req, res) => {
  try {
    const name = String((req.body || {}).mcid || '').trim();
    if (!/^\w{3,16}$/.test(name)) fail('MCIDは3〜16文字の英数字と_だけです');
    const p = await auth.skinStart(name);
    res.json({ ok: true, mcid: p.name, uuid: p.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/auth/skin/png', (req, res) => {
  const uuid = String(req.query.uuid || '');
  const png = UUID_RE.test(uuid) && auth.skinPng(uuid);
  if (!png) return res.status(404).type('text/plain').send('期限切れです。最初からやり直してください');
  res.set({
    'Content-Type': 'image/png',
    'Content-Disposition': 'attachment; filename="practice-tiers-verify.png"',
    'Cache-Control': 'no-store',
  }).send(png);
});
app.post('/auth/skin/check', async (req, res) => {
  try {
    const uuid = String((req.body || {}).uuid || '');
    if (!UUID_RE.test(uuid)) fail('不正なリクエストです');
    const p = await auth.skinCheck(uuid);
    res.json({ ok: true, token: loginAs(p.id, p.name) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// B) Microsoftログイン（Mojangの承認が下りたら環境変数を入れるだけで有効化。RenderのURLで開いたページ用）
if (auth.msEnabled) {
  app.get('/auth/login', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('oauth_state', state, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 10 * 60e3 });
    res.redirect(auth.msLoginUrl(state));
  });
  app.get('/auth/callback', async (req, res) => {
    try {
      const st = auth.parseCookies(req.headers.cookie).oauth_state;
      if (!req.query.code || !st || req.query.state !== st) fail('ログインの有効期限が切れました。もう一度お試しください');
      const p = await auth.msProfile(String(req.query.code));
      res.redirect('/#token=' + loginAs(p.id, p.name));
    } catch (e) { res.status(400).type('text/plain').send('ログインに失敗しました: ' + e.message); }
  });
}

/* ================= 起動 ================= */
(async () => {
  try { await db.load(); }
  catch (e) { console.error('[db] 起動時の読み込みに失敗しました:', e.message); process.exit(1); }
  pinAdmins();
  setInterval(async () => { await db.refreshAdmins(); pinAdmins(); }, 60e3);   // 「admins」シートの変更を1分ごとに反映
  server.listen(PORT, () => console.log(`Practice Tiers 起動: http://localhost:${PORT}`));
})();

const bye = async () => { await db.flushAll(); process.exit(0); };
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
