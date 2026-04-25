// 価格シミュレーション - Geometric Brownian Motion ベース
// 1tick = シミュレーション内の1分

// 正規分布っぽい乱数を近似(中心極限定理による和)
function randomNormal() {
  return (Math.random() + Math.random() + Math.random() - 1.5) * 2;
}

// 1分進んだときの新しい価格を返す
export function tickPrice(currentPrice, stock) {
  const dt = 1 / 360; // 1営業日=6時間=360分として、1分の占める割合
  const shock = randomNormal();
  const change = stock.drift * dt + stock.vol * Math.sqrt(dt) * shock;
  let newPrice = currentPrice * (1 + change);
  // サーキットブレーカー的に1tick最大±5%で抑制(教育用)
  newPrice = Math.max(currentPrice * 0.95, Math.min(currentPrice * 1.05, newPrice));
  // 100円未満は小数1位、それ以上は整数に丸め
  return newPrice < 100 ? Math.round(newPrice * 10) / 10 : Math.round(newPrice);
}

// 市場が開いているか(シム時刻: 9:00-15:00)
export function isMarketOpen(simMinute) {
  const dayMinute = simMinute % (24 * 60);
  const hour = Math.floor(dayMinute / 60);
  return hour >= 9 && hour < 15;
}

// シム時刻を人間可読な形式に
export function formatSimTime(simMinute) {
  const totalDays = Math.floor(simMinute / (24 * 60));
  const dayMin = simMinute % (24 * 60);
  const h = Math.floor(dayMin / 60);
  const m = dayMin % 60;
  return `Day ${totalDays + 1} · ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// 15:00終了時に翌日9:00へジャンプ
export function advanceTime(currentMinute) {
  const next = currentMinute + 1;
  const dayMin = next % (24 * 60);
  if (dayMin === 15 * 60) {
    // 15:00ちょうどに達したら、翌日9:00まで飛ばす
    return next + (24 * 60) - (15 * 60) + 9 * 60;
  }
  return next;
}
