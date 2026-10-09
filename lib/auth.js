'use strict';
const crypto = require('crypto');
const { PNG } = require('pngjs');
const drawSkin = require('./skinart');       // 認証用スキンの飾り

const SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-me';
const MS = { id: process.env.MS_CLIENT_ID, secret: process.env.MS_CLIENT_SECRET, redirect: process.env.MS_REDIRECT_URI };
exports.msEnabled = !!(MS.id && MS.secret && MS.redirect);

/* ---------- 署名付きトークン（Cookie用。サーバーに状態を持たない） ---------- */
const mac = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

exports.sign = (payload, days = 365) => {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + days * 864e5 })).toString('base64url');
  return body + '.' + mac(body);
};

exports.verify = token => {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const a = Buffer.from(sig || ''), b = Buffer.from(mac(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
};

const dec = s => { try { return decodeURIComponent(s); } catch { return s; } };
exports.parseCookies = (h = '') => Object.fromEntries(
  h.split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf('=');
    return i < 0 ? [s, ''] : [s.slice(0, i), dec(s.slice(i + 1))];
  })
);

/* ---------- Mojang 公開API：MCID → UUID ---------- */
exports.mojangLookup = async name => {
  let r;
  try { r = await fetch('https://api.mojang.com/users/profiles/minecraft/' + encodeURIComponent(name)); }
  catch { throw new Error('Mojang APIに接続できませんでした。少し待ってからもう一度お試しください'); }
  if (r.status === 404 || r.status === 204) throw new Error('そのMCIDは存在しません（Java版のMCIDを入力してください）');
  if (!r.ok) throw new Error('Mojang APIが混み合っています。少し待ってからもう一度お試しください');
  const j = await r.json();
  return { id: j.id, name: j.name };
};

/* ---------- 開発用ログイン（DEV_LOGIN=1 のときだけ。なりすまし可能なので本番ではOFF） ---------- */
exports.devProfile = async name => {
  try { return await exports.mojangLookup(name); }
  catch { return { id: 'dev' + crypto.createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 29), name }; }
};

/* ---------- スキン認証（Mojangの承認が要らないMCID連携） ----------
 * 1. 認証コードを埋め込んだ専用スキン(PNG)を配る
 * 2. 本人がそのスキンをMinecraftアカウントに設定する
 * 3. Mojangの公開APIで「そのUUIDの現在のスキン」を取得し、コードが一致すれば持ち主と確定 */
const CODE_X = 8, CODE_Y = 8, CODE_PX = 6;   // 頭の正面(8..15, 8..15)の最上段にコードを埋め込む
const pending = new Map();                   // uuid -> { code, name, exp, last }

exports.skinStart = async name => {
  for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
  const p = await exports.mojangLookup(name);
  pending.set(p.id, { code: crypto.randomBytes(16).toString('hex'), name: p.name, exp: Date.now() + 30 * 60e3, last: 0 });
  return p;
};

exports.skinPng = uuid => {
  const v = pending.get(uuid);
  if (!v || v.exp < Date.now()) return null;
  const png = new PNG({ width: 64, height: 64 });
  const put = (x, y, r, g, b) => {
    const i = (y * 64 + x) * 4;
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
  };
  drawSkin(put);                                   // 見た目の飾り（lib/skinart.js）
  const bytes = Buffer.from(v.code, 'hex');
  for (let k = 0; k < CODE_PX; k++) put(CODE_X + k, CODE_Y, bytes[k * 3] || 0, bytes[k * 3 + 1] || 0, bytes[k * 3 + 2] || 0);
  return PNG.sync.write(png);
};

exports.skinCheck = async uuid => {
  const v = pending.get(uuid);
  if (!v || v.exp < Date.now()) throw new Error('認証の有効期限が切れました。最初からやり直してください');
  if (Date.now() - v.last < 20e3) throw new Error('Mojangへの問い合わせが早すぎます。20秒ほど待ってからもう一度押してください');
  v.last = Date.now();

  const pr = await fetch('https://sessionserver.mojang.com/session/minecraft/profile/' + uuid);
  if (pr.status === 429) throw new Error('Mojangのサーバーが混み合っています。1分ほど待ってからもう一度押してください');
  if (!pr.ok) throw new Error('スキン情報を取得できませんでした。少し待ってからもう一度押してください');
  const prof = await pr.json();
  const prop = (prof.properties || []).find(p => p.name === 'textures');
  const skin = prop && JSON.parse(Buffer.from(prop.value, 'base64').toString()).textures?.SKIN;
  if (!skin) throw new Error('スキンが設定されていません。認証用スキンを設定してください');
  const url = new URL(skin.url.replace(/^http:/, 'https:'));
  if (url.hostname !== 'textures.minecraft.net') throw new Error('スキンの取得先が不正です');

  const img = await fetch(url);
  if (!img.ok) throw new Error('スキン画像を取得できませんでした');
  let png;
  try { png = PNG.sync.read(Buffer.from(await img.arrayBuffer())); }
  catch { throw new Error('スキン画像を読み取れませんでした'); }

  const got = Buffer.alloc(CODE_PX * 3);
  if (png.width >= 64 && png.height >= 64) {
    for (let k = 0; k < CODE_PX; k++) {
      const i = (CODE_Y * png.width + CODE_X + k) * 4;
      got[k * 3] = png.data[i]; got[k * 3 + 1] = png.data[i + 1]; got[k * 3 + 2] = png.data[i + 2];
    }
  }
  if (got.subarray(0, 16).toString('hex') !== v.code) {
    throw new Error('認証用スキンがまだ反映されていません。設定して1〜2分待ってから、もう一度押してください');
  }
  pending.delete(uuid);
  return { id: uuid, name: v.name };
};

/* ---------- Microsoft ログイン（公式方式。Mojangへのアプリ承認が下りたら有効化） ---------- */
exports.msLoginUrl = state => 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?' + new URLSearchParams({
  client_id: MS.id, response_type: 'code', redirect_uri: MS.redirect,
  scope: 'XboxLive.signin', state, prompt: 'select_account',
});

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${new URL(url).host} が ${r.status} を返しました ${j.errorMessage || j.XErr || j.error || ''}`);
  return j;
}

exports.msProfile = async code => {
  const tr = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MS.id, client_secret: MS.secret, code, grant_type: 'authorization_code',
      redirect_uri: MS.redirect, scope: 'XboxLive.signin',
    }),
  });
  const t = await tr.json();
  if (!t.access_token) throw new Error('Microsoft認証に失敗: ' + (t.error_description || t.error));

  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + t.access_token },
    RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
  });
  const xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT',
  });
  // ここで "Invalid app registration" が出る場合は、Mojangのアプリ承認がまだです
  const mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${xsts.DisplayClaims.xui[0].uhs};${xsts.Token}`,
  });
  const pr = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: 'Bearer ' + mc.access_token },
  });
  const p = await pr.json();
  if (!p.id) throw new Error('このMicrosoftアカウントはMinecraft Java Editionを持っていません');
  return { id: p.id, name: p.name };
};
