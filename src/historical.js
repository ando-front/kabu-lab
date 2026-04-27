// 実データ参照: 各シナリオに対応する現実の歴史的事象と市場の動き (Phase 3 / L4)
//
// J-Quants など実株価APIの直接連携は、静的SPA + 中学生プライバシー要件と
// 相性が悪いため保留。代替として、シナリオに対応する公開された歴史データを
// 静的に同梱し、シナリオ完走時に「実際もこう動いた」を提示する。
//
// 数値は公開された日経平均株価終値の概算 (四捨五入)。
// 教育目的の参考データとして、方向と桁を伝えることが目的。
// シミュレーションは実際の値動きを忠実に再現するものではない。

export const HISTORICAL_REFERENCES = {
  lehman: {
    period: '2008年9月12日 〜 10月10日 (約21営業日)',
    indexLabel: '日経平均株価',
    indexStartLabel: '12,200円台',
    indexEndLabel: '8,300円台',
    indexChangePct: -32,
    aftermathLabel: '10/27に7,162円(バブル後最安値)',
    summary: '世界同時金融危機。約1ヶ月で日経平均は3割超下落、その後さらに底値を更新。',
    insight: 'ディフェンシブ株(食品・通信)に逃げていた人と、銀行・自動車に集中していた人で結果が大きく分かれた。',
    events: [
      { date: '2008-09-15', headline: '米リーマン・ブラザーズが連邦破産法11条を申請', why: '「大きすぎて潰せない」が崩れた瞬間。世界の金融市場が一斉に動揺。' },
      { date: '2008-09-16', headline: '米連邦準備制度、保険最大手AIGを救済', why: '保険最大手の連鎖破綻を回避するための異例の介入。' },
      { date: '2008-09-29', headline: '米下院、金融安定化法案を一度否決', why: 'NYダウが1日で過去最大の777ドル下落、世界の株が連れ安。' },
      { date: '2008-10-08', headline: '米欧主要中銀が協調利下げに踏み切る', why: 'グローバルな金融緩和に乗り出すほどの危機認識。' },
      { date: '2008-10-27', headline: '日経平均、バブル後最安値の7,162円(シナリオ期間後)', why: '狼狽売りの底値圏。ここから長い回復局面が始まる。' },
    ],
  },
  covid: {
    period: '2020年2月21日 〜 3月19日 (約21営業日)',
    indexLabel: '日経平均株価',
    indexStartLabel: '23,400円台',
    indexEndLabel: '16,500円台',
    indexChangePct: -29,
    aftermathLabel: '4月中旬に19,600円台へV字回復',
    summary: 'パンデミック発生で1ヶ月で約3割下落。各国の財政・金融出動で急速にV字回復。',
    insight: '一番怖いタイミングで売った人と、底で買い向かった人の差が極端に出た局面。短期と長期で景色が違う。',
    events: [
      { date: '2020-01-30', headline: 'WHO、新型コロナを「国際的な公衆衛生上の緊急事態」に', why: 'まだ市場は楽観的。ここが伏線になる。' },
      { date: '2020-02-27', headline: '日本政府、全国小中高に一斉休校を要請', why: 'レジャー・外食・交通株が直撃される転換点。' },
      { date: '2020-03-09', headline: 'NYダウが2,013ドル安、サーキットブレーカー発動', why: '原油急落も重なり、リスクオフの最大値。' },
      { date: '2020-03-13', headline: 'WHOがパンデミック宣言', why: '世界経済の半年以上の停滞が現実視される。' },
      { date: '2020-03-19', headline: '日経平均、16,552円まで下落 (約3割安)', why: '最大下落点。ここから1ヶ月で大きく戻す。' },
      { date: '2020-04-07', headline: '日本で緊急事態宣言', why: '株価はすでに底入れ後。「悪材料出尽くし」で買われた。' },
    ],
  },
  inflation: {
    period: '2022年3月9日 〜 3月29日 (約15営業日)',
    indexLabel: '日経平均株価',
    indexStartLabel: '24,700円台',
    indexEndLabel: '28,000円台',
    indexChangePct: 13,
    aftermathLabel: '10/21に円が一時1ドル=151円台 (32年ぶり)',
    summary: '世界的なインフレと米利上げ加速。日本は緩和維持で日米金利差が拡大、急速な円安進行。為替に敏感な業種で明暗。',
    insight: '「全体相場」より「環境に合った銘柄選び」が効く局面。銀行・輸出株が上がり、原材料を輸入する企業が苦戦した。',
    events: [
      { date: '2022-03-09', headline: '日経平均、ウクライナ侵攻ショックで24,717円(年初来安値)', why: 'ここから月内に約+13%反発。下げを買い向かえたか?' },
      { date: '2022-03-16', headline: '米FRB、3年3ヶ月ぶりの利上げ(0.25%)', why: '日米金利差拡大の起点。円安が加速。' },
      { date: '2022-03-28', headline: '日銀、指値オペを実施(10年金利0.25%を防衛)', why: '世界の利上げの中、日本だけ緩和維持を明示。' },
      { date: '2022-04-28', headline: '日銀、指値オペを毎営業日実施に', why: '緩和姿勢を一段と鮮明化。1ドル=130円突破へ。' },
      { date: '2022-10-21', headline: '円が一時1ドル=151円台、32年ぶりの水準', why: '輸出企業の利益拡大の追い風がピークに。' },
    ],
  },
};

// シナリオの結果(ユーザー%)と、当時の指数概算%を比較した1行コメントを返す
export function compareToHistorical(scenarioId, userPct) {
  const ref = HISTORICAL_REFERENCES[scenarioId];
  if (!ref) return null;
  const idx = ref.indexChangePct;
  const sameDirection = (idx >= 0 && userPct >= 0) || (idx < 0 && userPct < 0);
  const userOutperformed = userPct > idx;
  let verdict;
  if (sameDirection) {
    verdict = userOutperformed
      ? `当時の${ref.indexLabel}と同じ方向で、市場全体より良い結果。銘柄選びが効いた。`
      : `当時の${ref.indexLabel}と同じ方向。市場の波には乗れた。`;
  } else {
    verdict = userOutperformed
      ? `当時の${ref.indexLabel}は逆方向に動いた。逆風を凌げたのは大きい。`
      : `当時の${ref.indexLabel}とは違う方向の負け。何が判断のずれを生んだか?`;
  }
  return { ref, idx, verdict };
}

export function getHistorical(scenarioId) {
  return HISTORICAL_REFERENCES[scenarioId] || null;
}
