'use strict';
/* 認証用スキンの見た目（ただの飾り）。好きに変えてOKです。
 * 注意：頭の正面の一番上の段（x=8〜13, y=8）には、あとから認証コードが上書きされます。
 * put(x, y, r, g, b) は1ピクセルを塗る関数。塗らなかった所は透明になります。 */
module.exports = function drawSkin(put) {
  const px = (x, y, c) => put(x, y, c[0], c[1], c[2]);
  const face = (r, fn) => { for (let j = 0; j < r[3]; j++) for (let i = 0; i < r[2]; i++) px(r[0] + i, r[1] + j, fn(i, j)); };
  // 立体（横w・高さh・奥行きd）の展開図での場所 [x, y, 幅, 高さ]
  const cuboid = (ox, oy, w, h, d) => ({
    top: [ox + d, oy, w, d], bottom: [ox + d + w, oy, w, d],
    right: [ox, oy + d, d, h], front: [ox + d, oy + d, w, h],
    left: [ox + d + w, oy + d, d, h], back: [ox + 2 * d + w, oy + d, w, h],
  });
  const glyph = (rows, x0, y0, c) => rows.forEach((row, j) => [...row].forEach((ch, i) => { if (ch === 'X') px(x0 + i, y0 + j, c); }));

  const SKIN = [236, 190, 150], SKIN_D = [214, 166, 128], WHITE = [245, 245, 250], BLUE = [111, 143, 255];
  const GOLD = [255, 207, 64], MOUTH = [170, 80, 80], SHOE = [20, 22, 34];
  const HAIR = [[70, 50, 140], [96, 72, 180], [125, 100, 215]];
  const SHIRT = [[40, 52, 90], [52, 68, 118]], PANTS = [[34, 40, 66], [44, 52, 84]];
  const hair = (i, j) => HAIR[(i + j) % 3];

  // --- 頭：紫のメッシュ髪・まゆ毛・目・口、外側レイヤーに金のハチマキ ---
  const H = cuboid(0, 0, 8, 8, 8);
  face(H.top, hair);
  face(H.back, (i, j) => HAIR[Math.min(2, j >> 1)]);
  face(H.bottom, () => SKIN_D);
  for (const s of [H.right, H.left]) face(s, (i, j) => (j < 3 ? hair(i, j) : SKIN));
  face(H.front, (i, j) => {
    if (j < 2) return hair(i, j);                                                                 // 前髪（1段目は認証コードで上書き）
    if (j === 3 && (i === 1 || i === 2 || i === 5 || i === 6)) return HAIR[0];                   // まゆ毛
    if (j === 4 || j === 5) { if (i === 1 || i === 6) return WHITE; if (i === 2 || i === 5) return BLUE; }  // 目
    if (j === 6 && (i === 3 || i === 4)) return MOUTH;                                           // 口
    return SKIN;
  });
  for (const x0 of [32, 40, 48, 56]) for (let i = 0; i < 8; i++) px(x0 + i, 10, GOLD);           // ハチマキ

  // --- 体：しま模様のシャツ、胸に金の「P」、背中に「T」、金のベルト ---
  const B = cuboid(16, 16, 8, 12, 4);
  const shirt = i => SHIRT[(i >> 1) & 1];
  for (const s of [B.front, B.back]) face(s, (i, j) => (j === 10 ? GOLD : shirt(i)));
  for (const s of [B.right, B.left]) face(s, (i, j) => (j === 10 ? GOLD : SHIRT[j & 1]));
  face(B.top, () => SHIRT[0]);
  face(B.bottom, () => PANTS[0]);
  glyph(['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X....', 'X....', 'X....'], 21, 22, GOLD);
  glyph(['XXXXX', '..X..', '..X..', '..X..', '..X..', '..X..', '..X..'], 33, 22, GOLD);

  // --- 腕（そで・金のそでぐち・手）と足（ズボン・金のバッジ・くつ） ---
  const limb = (ox, oy, arm) => {
    const L = cuboid(ox, oy, 4, 12, 4);
    for (const s of [L.right, L.front, L.left, L.back]) {
      face(s, (i, j) => {
        if (arm) return j < 7 ? SHIRT[j & 1] : j === 7 ? GOLD : SKIN;
        if (j >= 10) return SHOE;
        if (s === L.front && j === 5 && (i === 1 || i === 2)) return GOLD;
        return PANTS[(j >> 1) & 1];
      });
    }
    face(L.top, () => (arm ? SHIRT[0] : PANTS[0]));
    face(L.bottom, () => (arm ? SKIN_D : SHOE));
  };
  limb(40, 16, true); limb(32, 48, true); limb(0, 16, false); limb(16, 48, false);
};
