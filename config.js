'use strict';
/* ===== Practice Tiers 設定 =====
 * 種目・Tier・ポイント・称号・名前色の価格は、ここだけ編集すれば画面にも自動で反映されます。 */

// 種目（id は英数字のみ）
exports.EVENTS = [
  { id: 'sword',     name: 'Sword' },
  { id: 'axe',       name: 'Axe' },
  { id: 'uhc',       name: 'UHC' },
  { id: 'smp',       name: 'SMP' },
  { id: 'pot',       name: 'Pot' },
  { id: 'npot',      name: 'Netherite Pot' },
  { id: 'mace',      name: 'Mace' },
  { id: 'spearmace', name: 'Spear Mace' },
  { id: 'crystal',   name: 'Crystal' },
  { id: 'cart',      name: 'Cart' },
  { id: 'bow',       name: 'Bow' },
  { id: 'elytra',    name: 'Elytra' },
];

// Tier（弱い → 強い の順）。ZT が最上位
exports.TIERS = ['LT5', 'HT5', 'LT4', 'HT4', 'LT3', 'HT3', 'LT2', 'HT2', 'LT1', 'HT1', 'ZT3', 'ZT2', 'ZT1'];

// Tierごとのランクポイント（MCTiersに近い値。ZTは独自）
exports.TIER_POINTS = { LT5: 1, HT5: 2, LT4: 3, HT4: 4, LT3: 6, HT3: 10, LT2: 20, HT2: 32, LT1: 44, HT1: 60, ZT3: 80, ZT2: 100, ZT1: 130 };

// 称号（総ランクポイント → 称号。大きい順に並べる）
exports.TITLES = [
  { min: 400, name: 'Combat Grandmaster' },
  { min: 250, name: 'Combat Master' },
  { min: 100, name: 'Combat Ace' },
  { min: 50,  name: 'Combat Specialist' },
  { min: 20,  name: 'Combat Cadet' },
  { min: 10,  name: 'Combat Novice' },
  { min: 0,   name: 'Rookie' },
];

exports.TESTER_MIN_TIER = 'LT3'; // その種目でこのTier以上ならテスターになれる
exports.QUEUE_MAX = 10;          // 待機列の枠数（1テストの合計人数ではなく「同時に並べる人数」）

// ショップ用ポイント(SP)：Tierが自己ベストを更新した時に「上がったランクポイント × この値」をもらえる
exports.SP_PER_POINT = 10;

// 名前の色ショップ（SPで購入）
exports.COLORS = {
  blue:    { name: 'ブルー',     price: 300 },
  red:     { name: 'レッド',     price: 500 },
  gold:    { name: 'ゴールド',   price: 1000 },
  rainbow: { name: 'レインボー', price: 2500 },
};
