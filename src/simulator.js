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

// ============ ニュースイベント ============
// { trigger: 'any'|ticker, priceEffect: +0.05 = +5%, tags: ['車'] で同タグ銘柄に波及 }
export const NEWS_EVENTS = [
  // 個別銘柄イベント
  { id: 'n01', ticker: '7974', headline: '任天堂、新ハード「Switch 2」正式発表！', detail: '新ハード発表は任天堂株の強力な買い材料。期待感から株価が急上昇することが多い。', effect: 0.07, tag: null },
  { id: 'n02', ticker: '7974', headline: '任天堂、主力タイトルの販売が低調', detail: '人気シリーズの新作売上が予想を下回り、売上見通しを下方修正。', effect: -0.05, tag: null },
  { id: 'n03', ticker: '6758', headline: 'ソニー、映画部門が大ヒット作を公開', detail: '興行収入が記録的な数字を叩き出し、エンタメ部門への期待が高まった。', effect: 0.05, tag: null },
  { id: 'n04', ticker: '6758', headline: 'ソニー、PS5の生産コスト上昇で利益圧迫', detail: '部品コストの高騰がゲーム機部門の収益を直撃。短期的にネガティブな材料。', effect: -0.04, tag: null },
  { id: 'n05', ticker: '8136', headline: 'サンリオ、新キャラクターが海外で爆発的人気', detail: 'SNSでバズりグローバルな知名度が急上昇。ライセンス収入への期待感が高まる。', effect: 0.08, tag: null },
  { id: 'n06', ticker: '8136', headline: 'サンリオ、人気キャラの商標侵害問題が発覚', detail: '海外での模倣品問題が報じられ、ブランド価値への懸念が広がった。', effect: -0.04, tag: null },
  { id: 'n07', ticker: '4661', headline: 'オリエンタルランド、入場者数が過去最高を更新', detail: '新エリアオープン効果で年間入場者数が最高記録。収益見通しを上方修正。', effect: 0.06, tag: null },
  { id: 'n08', ticker: '9983', headline: 'ユニクロ、海外新市場への大規模出店を発表', detail: '東南アジア・インド市場への積極展開。長期的な成長期待が株価を押し上げる。', effect: 0.05, tag: null },
  { id: 'n09', ticker: '8306', headline: '三菱UFJ、日銀が追加利上げを決定', detail: '金利上昇は銀行の利ざや改善につながるため、銀行株にとってポジティブな材料。', effect: 0.06, tag: null },
  { id: 'n10', ticker: '8306', headline: '三菱UFJ、大型企業の融資焦げ付き報道', detail: '不良債権問題の懸念が浮上。財務健全性への不安から売りが先行した。', effect: -0.05, tag: null },
  { id: 'n11', ticker: '7203', headline: 'トヨタ、EV新モデルが欧州市場で高評価', detail: '電動化戦略が評価され、欧州での販売シェア拡大への期待が高まる。', effect: 0.04, tag: null },
  { id: 'n12', ticker: '7203', headline: 'トヨタ、部品供給不足で工場の稼働停止', detail: '半導体・部品不足による生産停止。短期的に業績への悪影響が見込まれる。', effect: -0.04, tag: null },
  // 業界・マクロイベント（tag指定で複数銘柄に波及）
  { id: 'n13', ticker: null, tag: '車', headline: '政府、EV購入補助金を大幅拡充と発表', detail: '自動車業界全体に恩恵。特にEVに力を入れるメーカーに買いが集まりやすい。', effect: 0.04 },
  { id: 'n14', ticker: null, tag: '通信', headline: '5G普及加速、通信各社の設備投資が拡大', detail: '通信インフラへの需要増加。安定したキャッシュフローが期待できる通信株に注目。', effect: 0.03 },
  { id: 'n15', ticker: null, tag: '食品', headline: '原材料費の高騰、食品メーカーの利益を圧迫', detail: '小麦・砂糖など原材料コストが上昇。価格転嫁できるかが今後の焦点。', effect: -0.03 },
  { id: 'n16', ticker: null, tag: null, headline: '日銀、大規模金融緩和を維持と発表', detail: 'リスクオン相場が続きやすい環境。株式市場全体に買いの流れが生まれやすい。', effect: 0.02 },
  { id: 'n17', ticker: null, tag: null, headline: '米国で景気後退懸念が高まる', detail: '世界経済への影響から、日本株にも売り圧力がかかりやすい。リスク回避の動き。', effect: -0.025 },
  { id: 'n18', ticker: null, tag: 'ゲーム', headline: 'ゲーム業界、世界の市場規模が過去最大に', detail: 'モバイル・コンソール合計でゲーム市場が急拡大。関連銘柄に投資マネーが流入。', effect: 0.05 },
];

// 発生確率：1tick（1分）あたりの自然発生率
const NEWS_BASE_PROB = 0.002; // 約500分に1回

export function checkNewsEvent(simMinute, firedIds) {
  if (!isMarketOpen(simMinute)) return null;
  if (Math.random() > NEWS_BASE_PROB) return null;
  // まだ発生していないイベントから抽選
  const available = NEWS_EVENTS.filter(e => !firedIds.includes(e.id));
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
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
