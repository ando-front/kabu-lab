// 学習シナリオ定義 (Phase A: シナリオモード)
//
// 各シナリオは以下を持つ:
//   id, name, badge, summary, learningGoals[], durationDays
//   initialMacro: { rate, fx, cycle }      // 開始時のマクロ環境
//   script: [ { day, headline, detail, effect?, tag?, ticker?, macroDelta? } ]
//     day = 開始からの経過日数(0始まり)
//     macroDelta は state.macro に加算(クランプは呼び出し側)
//
// シナリオは「決まった筋書き」で進行するので、ランダムニュースイベントは
// シナリオモード中は抑制する(simulator.js の checkNewsEvent 呼び出し側で制御)。

export const SCENARIOS = [
  {
    id: 'lehman',
    name: '2008 リーマン・ショック風',
    badge: '🏦',
    summary: '世界的な金融危機が日本市場を直撃。銀行株が急落し、景気敏感株もつられて崩れる。一方でディフェンシブ銘柄(食品・通信)は持ちこたえる場面も。',
    learningGoals: ['L2 リスクとリターン', 'L3 分散投資の意味', 'L4 外部要因と株価'],
    durationDays: 21,
    initialMacro: { rate: 0.1, fx: -0.2, cycle: -0.1 },
    script: [
      { day: 1, headline: '米大手投資銀行が経営破綻', detail: '世界の金融市場に動揺が走る。リスク回避の動きが本格化し、日本株にも売り圧力。', effect: -0.025 },
      { day: 2, headline: '銀行株への信用不安が連鎖', detail: '銀行間の貸し借りが滞る懸念。三菱UFJなど金融株が売られる。', tag: '銀行', effect: -0.04 },
      { day: 3, headline: '為替、急速な円高が進行', detail: 'リスク回避の円買い。輸出株(車・ゲーム)に逆風。', macroDelta: { fx: -0.5 } },
      { day: 4, headline: 'トヨタ・ホンダ、利益見通しを下方修正', detail: '円高と海外販売不振のダブルパンチ。', tag: '車', effect: -0.04 },
      { day: 6, headline: '景気後退が鮮明に', detail: '消費・設備投資が冷え込み、企業業績悪化が広がる。', macroDelta: { cycle: -0.5 }, effect: -0.02 },
      { day: 7, headline: 'オリエンタルランド、入場者数減少', detail: '景気悪化でレジャー支出が手控えられる。', ticker: '4661', effect: -0.05 },
      { day: 9, headline: '日銀、緊急利下げを実施', detail: '景気下支えのため政策金利を引き下げ。銀行株には逆風だが市場全体には買い材料。', macroDelta: { rate: -0.6 }, effect: 0.015 },
      { day: 10, headline: 'ディフェンシブ株に資金流入', detail: '景気変動に強い食品・通信株が見直し買い。', tag: '食品', effect: 0.03 },
      { day: 12, headline: '通信株が安定推移', detail: '不景気でも通信費は払い続けるためディフェンシブ性を発揮。', tag: '通信', effect: 0.02 },
      { day: 14, headline: '世界協調利下げで底打ち感', detail: '各国中銀の連携で市場心理が改善。', macroDelta: { cycle: 0.2 }, effect: 0.025 },
      { day: 16, headline: '輸出株が円安一服で反発', detail: '為替が落ち着き、輸出企業に買い戻し。', macroDelta: { fx: 0.3 }, tag: '車', effect: 0.03 },
      { day: 18, headline: '経済対策で景気指標改善', detail: '政府の財政出動が効果を発揮し始める。', macroDelta: { cycle: 0.3 }, effect: 0.02 },
      { day: 20, headline: 'シナリオ終了 — 危機は去ったが学びは残る', detail: 'ボラティリティの高い局面では分散とディフェンシブが効く、を体感したか?', effect: 0 },
    ],
    debrief: {
      title: '🏦 リーマン・ショックから学ぶ',
      points: [
        '【L3】1銘柄集中投資は危機時に致命的。複数銘柄に分散していたか?',
        '【L4】世界経済の連鎖はあらゆる株に影響する。マクロを読む重要性。',
        '【L2】ディフェンシブ株(食品・通信)は不景気で相対的に強い。リスクとリターンの非対称性。',
        '【L5】危機の底で買えた人が、回復局面で大きなリターンを得る(=長期視点)。',
      ],
    },
  },
  {
    id: 'covid',
    name: '2020 コロナ・ショック風',
    badge: '🦠',
    summary: '感染症の世界拡大で景気が急停止。レジャー・自動車が直撃される一方、巣ごもりで一部のエンタメは恩恵。急落から急回復するV字パターン。',
    learningGoals: ['L2 リスクとリターン', 'L4 外部要因と株価', 'L5 長期 vs 短期'],
    durationDays: 21,
    initialMacro: { rate: -0.2, fx: 0, cycle: 0.1 },
    script: [
      { day: 1, headline: '新型感染症、世界的拡大の懸念', detail: 'WHOが警戒を強化。リスク資産から資金流出。', effect: -0.02, macroDelta: { cycle: -0.3 } },
      { day: 2, headline: 'オリエンタルランド、テーマパーク休園を決定', detail: '感染拡大防止のため臨時休園。業績への直撃が確実視される。', ticker: '4661', effect: -0.06 },
      { day: 3, headline: '世界的なロックダウンが拡大', detail: '消費・移動が急激に縮小。景気指標が悪化方向へ。', macroDelta: { cycle: -0.6 }, effect: -0.03 },
      { day: 4, headline: '自動車各社、工場の稼働停止', detail: 'サプライチェーン寸断と需要減のダブルパンチ。', tag: '車', effect: -0.05 },
      { day: 5, headline: '日銀、金融緩和を強化', detail: '異例の量的緩和拡大。市場心理にいったん買い戻し。', macroDelta: { rate: -0.5 }, effect: 0.02 },
      { day: 7, headline: '巣ごもり需要でゲーム業界が活況', detail: '在宅時間増加でゲームソフト・ハードが品薄に。', tag: 'ゲーム', effect: 0.06 },
      { day: 8, headline: 'ソニー、PSのネット会員数が過去最高', detail: '巣ごもりエンタメの代表格としてソニーに注目。', ticker: '6758', effect: 0.04 },
      { day: 10, headline: 'ワクチン開発進展のニュース', detail: '製薬大手の臨床試験が好結果。市場に楽観ムード。', effect: 0.03, macroDelta: { cycle: 0.3 } },
      { day: 12, headline: '輸出株、円安基調で反発', detail: '景気回復期待から円が売られる。', macroDelta: { fx: 0.3 }, tag: '車', effect: 0.025 },
      { day: 14, headline: '景気指標、底入れの兆し', detail: '消費者心理指数が改善。',  macroDelta: { cycle: 0.4 }, effect: 0.02 },
      { day: 16, headline: 'オリエンタルランド、段階的な営業再開', detail: '感染対策を徹底しつつ来園者を限定的に受け入れ。', ticker: '4661', effect: 0.05 },
      { day: 18, headline: '世界的な株価V字回復', detail: 'ハイテク・エンタメ主導で過去最高値を更新する地域も。', effect: 0.025 },
      { day: 20, headline: 'シナリオ終了 — 急落と急回復のV字', detail: '一番怖い局面で売っていた人と、買い向かった人で結果が大きく分かれた。', effect: 0 },
    ],
    debrief: {
      title: '🦠 コロナ・ショックから学ぶ',
      points: [
        '【L2】恐怖が最大になった瞬間が、結果的に絶好の買い場だったケースが多い(=逆張り思考)。',
        '【L4】同じ「危機」でも、業種ごとに勝ち負けが大きく分かれる(レジャー直撃 / ゲーム恩恵)。',
        '【L5】短期では絶望的でも、長期で見ればV字回復することがある。慌てて売るリスク。',
        '【L1】「なぜ今買うか/売るか」を言葉にできていたか?恐怖は判断を狂わせる。',
      ],
    },
  },
  {
    id: 'inflation',
    name: 'インフレ・利上げ局面',
    badge: '📈',
    summary: '物価上昇が止まらず、中央銀行が利上げを継続。銀行株は追い風だが、原材料を輸入する企業は逆風。為替は円安が進む展開。',
    learningGoals: ['L2 リスクとリターン', 'L4 外部要因と株価'],
    durationDays: 21,
    initialMacro: { rate: 0.3, fx: 0.3, cycle: 0.2 },
    script: [
      { day: 1, headline: '消費者物価指数、過去最高水準を更新', detail: 'インフレが加速。中央銀行が利上げを示唆。', macroDelta: { rate: 0.2 }, effect: 0 },
      { day: 2, headline: '銀行株に買い殺到', detail: '利ざや拡大期待で金融株が一斉高。', tag: '銀行', effect: 0.05 },
      { day: 3, headline: '原材料費高騰で食品メーカー苦戦', detail: '小麦・砂糖・大豆の価格急騰。価格転嫁が課題。', tag: '食品', effect: -0.04 },
      { day: 5, headline: '為替、急速な円安が進行', detail: '日米金利差拡大で円売り加速。1ドル=160円台へ。', macroDelta: { fx: 0.5 } },
      { day: 6, headline: '輸出株が円安恩恵で大幅高', detail: 'トヨタ・ソニー・任天堂など海外売上の多い銘柄に買い。', tag: '車', effect: 0.04 },
      { day: 7, headline: '任天堂、海外売上比率の高さで恩恵', detail: '円安効果で利益見通し上方修正。', ticker: '7974', effect: 0.05 },
      { day: 9, headline: '日銀、追加利上げを決定', detail: 'インフレ抑制最優先の姿勢を鮮明に。', macroDelta: { rate: 0.3 }, effect: -0.01 },
      { day: 10, headline: '住宅ローン金利上昇、消費マインド冷え込み', detail: '家計の負担増加で景気指数がやや悪化。', macroDelta: { cycle: -0.2 }, effect: -0.015 },
      { day: 12, headline: 'ユニクロ、価格改定で対応', detail: 'コスト上昇分の一部を価格に転嫁。', ticker: '9983', effect: 0.02 },
      { day: 14, headline: '通信株、ディフェンシブ性で底堅い', detail: '金利上昇は逆風だが、安定収益で値持ち。', tag: '通信', effect: 0.01 },
      { day: 16, headline: '為替介入の観測広がる', detail: '行き過ぎた円安に当局が警戒感。', macroDelta: { fx: -0.2 }, effect: 0 },
      { day: 18, headline: 'インフレ鈍化の兆候', detail: '物価上昇率がピークアウトの可能性。', macroDelta: { rate: -0.1, cycle: 0.2 }, effect: 0.015 },
      { day: 20, headline: 'シナリオ終了 — 環境に合った銘柄選び', detail: '同じ市場でも、銀行は上がり、食品は苦しんだ。マクロ感応度を意識できたか?', effect: 0 },
    ],
    debrief: {
      title: '📈 インフレ局面から学ぶ',
      points: [
        '【L4】金利上昇局面では銀行株が強く、借入の多い企業や住宅関連が逆風になりやすい。',
        '【L4】円安は輸出企業(車・ゲーム)に追い風、輸入依存企業(原材料を海外調達)に逆風。',
        '【L3】業種を分散していれば、勝つ銘柄と負ける銘柄で全体の振れ幅を抑えられる。',
        '【L2】「全体相場」より「環境に合った銘柄選び」が効いてくる局面。',
      ],
    },
  },
];

export function getScenario(id) {
  return SCENARIOS.find(s => s.id === id) || null;
}
