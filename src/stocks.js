// 銘柄マスタ
// basePrice: 2026年4月時点の実際の株価水準を参考に設定
// vol: 日次ボラティリティの係数(大きいほど値動きが激しい)
// drift: 長期トレンド(正=緩やかに上昇傾向、負=下降傾向)

export const STOCKS = [
  { ticker: '7203', name: 'トヨタ自動車',         tag: '車',       desc: '世界最大級の自動車メーカー', basePrice: 2850,  vol: 0.012, drift: 0.00005 },
  { ticker: '6758', name: 'ソニーグループ',       tag: 'エンタメ', desc: 'ゲーム・映画・音楽・電機',   basePrice: 3680,  vol: 0.018, drift: 0.00008 },
  { ticker: '7974', name: '任天堂',               tag: 'ゲーム',   desc: 'スイッチ、マリオ、ゼルダ',   basePrice: 9420,  vol: 0.022, drift: 0.00010 },
  { ticker: '8306', name: '三菱UFJ',              tag: '銀行',     desc: '日本最大のメガバンク',       basePrice: 1890,  vol: 0.015, drift: 0.00003 },
  { ticker: '7267', name: 'ホンダ',               tag: '車',       desc: 'バイク・車・飛行機',         basePrice: 1560,  vol: 0.014, drift: 0.00002 },
  { ticker: '9983', name: 'ファーストリテイリング', tag: '小売',   desc: 'ユニクロの会社',             basePrice: 48200, vol: 0.016, drift: 0.00006 },
  { ticker: '9432', name: 'NTT',                  tag: '通信',     desc: '日本最大の通信会社',         basePrice: 158,   vol: 0.010, drift: 0.00002 },
  { ticker: '9433', name: 'KDDI',                 tag: '通信',     desc: 'auの会社',                   basePrice: 4920,  vol: 0.011, drift: 0.00003 },
  { ticker: '4661', name: 'オリエンタルランド',   tag: 'レジャー', desc: '東京ディズニーリゾート運営', basePrice: 3420,  vol: 0.020, drift: 0.00004 },
  { ticker: '8136', name: 'サンリオ',             tag: 'キャラ',   desc: 'ハローキティなど',           basePrice: 5840,  vol: 0.028, drift: 0.00012 },
  { ticker: '2801', name: 'キッコーマン',         tag: '食品',     desc: 'しょうゆで世界的',           basePrice: 1620,  vol: 0.013, drift: 0.00001 },
  { ticker: '2587', name: 'サントリー食品',       tag: '食品',     desc: 'ジュース・コーヒー',         basePrice: 4880,  vol: 0.012, drift: 0.00002 },
];
