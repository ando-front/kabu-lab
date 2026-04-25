import { STOCKS } from './stocks.js';
import { tickPrice, isMarketOpen, formatSimTime, advanceTime, checkNewsEvent, NEWS_EVENTS, defaultMacro, evolveMacro, describeMacro } from './simulator.js';
import { SCENARIOS, getScenario } from './scenarios.js';

// ============ 状態 ============
const STORAGE_KEY = 'kabu_state_v2';

// 複数ポートフォリオ(口座)定義
// main: 単一口座(従来)、aggressive/defensive: Phase 2 複数口座機能
function defaultAccount(initial = 1000000) {
  return {
    cash: initial,
    initialCapital: initial,
    holdings: {},
    journal: [],
    portfolioHistory: [],
    totalCommission: 0,
    totalTax: 0,
  };
}

function defaultState() {
  return {
    // 単一口座(後方互換)
    cash: 1000000,
    initialCapital: 1000000,
    holdings: {},
    journal: [],
    portfolioHistory: [],
    totalCommission: 0,
    totalTax: 0,
    // 共通
    onboardingSeen: false,
    prices: {},
    prevClose: {},
    simMinute: 9 * 60, // Day 1 · 09:00 から開始
    newsLog: [],       // 発生したニュース履歴
    firedNewsIds: [],  // 再発防止用
    lastReviewDay: 0,  // 最後に振り返りを表示した日
    // Phase 2: 複数口座
    multiMode: false,                  // true で複数口座モード
    activeAccount: 'main',             // 'main' | 'aggressive' | 'defensive'
    accounts: null,                    // { aggressive: {...}, defensive: {...} } (有効化時に生成)
    // Phase 3: マクロ経済
    macro: defaultMacro(),
    // Phase A: シナリオモード
    scenarioMode: null,         // null | { id, startMinute, firedScriptIdx, finished, savedFreeplay }
  };
}

// 市場時間外（夜間・早朝）なら翌営業日9:00へスキップ
function skipToNextMarketOpen() {
  const dayMin = state.simMinute % (24 * 60);
  const totalDays = Math.floor(state.simMinute / (24 * 60));
  if (dayMin < 9 * 60) {
    state.simMinute = totalDays * 24 * 60 + 9 * 60;
  } else if (dayMin >= 15 * 60) {
    state.simMinute = (totalDays + 1) * 24 * 60 + 9 * 60;
  }
}

function loadState() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) {
      const merged = { ...defaultState(), ...JSON.parse(s) };
      // マイグレーション: macroが未定義なら初期化
      if (!merged.macro) merged.macro = defaultMacro();
      // マルチ口座が中途半端ならフォールバック
      if (merged.multiMode && (!merged.accounts || !merged.accounts.aggressive || !merged.accounts.defensive)) {
        merged.multiMode = false;
        merged.activeAccount = 'main';
      }
      return merged;
    }
  } catch (e) {}
  return defaultState();
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {}
}

let state = loadState();
let priceHistory = {};      // {ticker: [{t, price}]} - スパークライン用
let candleHistory = {};     // {ticker: [{t, open, high, low, close, vol}]} - テクニカル用
let currentModalStock = null;
let currentTab = 'buy';
let currentChartType = 'line'; // line | candle_ma | bb | rsi | volume
let currentChartTf = '15m';    // 15m | 1h | 4h | 1d
let simSpeed = 1;
let simTickTimer = null;
let lastPrices = {};
let lastTotalValue = null;
let activeNewsEvent = null; // 表示中のニュース

// ============ 口座アクセスヘルパー ============
// 単一モードでは state を直接読み書きし、複数口座モードでは accounts[id] を参照する。
// 既存コードは「acc.cash」「acc.holdings」のように acc を経由するよう書き換え済み。
function getActiveAccount() {
  if (state.multiMode && state.accounts && state.accounts[state.activeAccount]) {
    return state.accounts[state.activeAccount];
  }
  return state; // 後方互換: state自身がmain口座
}

function listAccounts() {
  if (!state.multiMode) {
    return [{ id: 'main', name: 'メイン口座', acc: state }];
  }
  return [
    { id: 'aggressive', name: '積極運用', acc: state.accounts.aggressive },
    { id: 'defensive', name: '守り重視', acc: state.accounts.defensive },
  ];
}

window.switchAccount = function(id) {
  if (!state.multiMode) return;
  state.activeAccount = id;
  saveState();
  render();
};

// ============ Phase A: シナリオモード ============
// 起動するとフリープレイ状態を退避し、新規100万円で固定スクリプトを進める。
// 期間が終わるか、ユーザが中断すると元に戻る。
const SCENARIO_FIELDS = [
  'cash','initialCapital','holdings','journal','portfolioHistory','totalCommission','totalTax',
  'simMinute','prices','prevClose','newsLog','firedNewsIds','lastReviewDay',
  'multiMode','activeAccount','accounts','macro','onboardingSeen',
];

function snapshotState() {
  const out = {};
  for (const k of SCENARIO_FIELDS) out[k] = JSON.parse(JSON.stringify(state[k] ?? null));
  return out;
}

function restoreSnapshot(snap) {
  for (const k of SCENARIO_FIELDS) state[k] = snap[k];
}

window.openScenarioPicker = function() {
  const cards = SCENARIOS.map(sc => {
    const goals = sc.learningGoals.map(g => `<span class="sc-goal">${g}</span>`).join('');
    return `<div class="scenario-card" onclick="startScenario('${sc.id}')">
      <div class="sc-badge">${sc.badge}</div>
      <div class="sc-body">
        <div class="sc-name">${sc.name}</div>
        <div class="sc-summary">${escapeHtml(sc.summary)}</div>
        <div class="sc-meta">
          <span class="sc-days">${sc.durationDays}日間</span>
          <div class="sc-goals">${goals}</div>
        </div>
      </div>
    </div>`;
  }).join('');
  document.getElementById('scenarioContent').innerHTML = `
    <h2 class="tut-title">📚 学習シナリオを選ぶ</h2>
    <p style="color:var(--ink-dim);font-size:13px;margin-bottom:14px">
      過去の市場で起きた出来事を再現したシナリオで学べます。<br>
      新しい100万円で開始され、${state.scenarioMode ? '<strong>進行中のシナリオは破棄されます</strong>' : 'フリープレイの状態は退避されます(終了時に復元)'}。
    </p>
    <div class="scenario-list">${cards}</div>
    <button class="tut-btn" style="margin-top:14px" onclick="closeScenarioPicker()">キャンセル</button>
  `;
  document.getElementById('scenarioModal').classList.add('show');
};

window.closeScenarioPicker = function() {
  document.getElementById('scenarioModal').classList.remove('show');
};

window.startScenario = function(id) {
  const sc = getScenario(id);
  if (!sc) return;
  // 既存シナリオ進行中なら確認
  if (state.scenarioMode && !state.scenarioMode.finished) {
    if (!confirm('進行中のシナリオは破棄されます。よろしいですか?')) return;
  }
  // フリープレイ退避(初回起動時のみ。シナリオ→シナリオ切替時は前回の退避を維持)
  const savedFreeplay = (state.scenarioMode && state.scenarioMode.savedFreeplay)
    ? state.scenarioMode.savedFreeplay
    : snapshotState();

  // シナリオ初期化
  state.cash = 1000000;
  state.initialCapital = 1000000;
  state.holdings = {};
  state.journal = [];
  state.portfolioHistory = [];
  state.totalCommission = 0;
  state.totalTax = 0;
  state.simMinute = 9 * 60;     // Day 1 09:00
  state.prices = {};
  state.prevClose = {};
  state.newsLog = [];
  state.firedNewsIds = [];
  state.lastReviewDay = 0;
  state.multiMode = false;
  state.activeAccount = 'main';
  state.accounts = null;
  state.macro = { ...defaultMacro(), ...sc.initialMacro };

  STOCKS.forEach(stk => {
    state.prices[stk.ticker] = stk.basePrice;
    state.prevClose[stk.ticker] = stk.basePrice;
  });
  priceHistory = {};
  candleHistory = {};
  candleBuffer = {};
  lastPrices = {};

  state.scenarioMode = {
    id: sc.id,
    startMinute: state.simMinute,
    firedScriptIdx: [],
    finished: false,
    savedFreeplay,
  };
  saveState();
  closeScenarioPicker();
  showToast(`📚 シナリオ「${sc.name}」を開始しました`);
  render();
};

function exitScenario(restoreFreeplay = true) {
  if (!state.scenarioMode) return;
  const snap = state.scenarioMode.savedFreeplay;
  state.scenarioMode = null;
  if (restoreFreeplay && snap) {
    restoreSnapshot(snap);
  }
  // ヒストリ系はメモリのみなので作り直し
  priceHistory = {};
  candleHistory = {};
  candleBuffer = {};
  lastPrices = {};
  STOCKS.forEach(stk => {
    if (state.prices[stk.ticker] != null) {
      priceHistory[stk.ticker] = [{ t: state.simMinute, price: state.prices[stk.ticker] }];
      lastPrices[stk.ticker] = state.prices[stk.ticker];
    }
  });
  saveState();
  render();
}

window.exitScenario = exitScenario;

// シナリオ進行: 1tickごとに、現在の経過日数 >= script[i].day かつまだ発火していなければ発火
function progressScenario() {
  if (!state.scenarioMode || state.scenarioMode.finished) return;
  const sc = getScenario(state.scenarioMode.id);
  if (!sc) return;
  const elapsedDays = Math.floor((state.simMinute - state.scenarioMode.startMinute) / (24 * 60));

  sc.script.forEach((evt, idx) => {
    if (state.scenarioMode.firedScriptIdx.includes(idx)) return;
    if (elapsedDays < evt.day) return;
    // 市場オープン時のみ発火(終了イベントは例外)
    if (!isMarketOpen(state.simMinute) && idx < sc.script.length - 1) return;
    state.scenarioMode.firedScriptIdx.push(idx);
    applyScenarioEvent(evt, sc);
  });

  // 期間終了判定
  if (elapsedDays >= sc.durationDays && !state.scenarioMode.finished) {
    state.scenarioMode.finished = true;
    showScenarioResult(sc);
  }
}

function applyScenarioEvent(evt, sc) {
  // マクロ更新
  if (evt.macroDelta) {
    if (!state.macro) state.macro = defaultMacro();
    for (const k of ['rate','fx','cycle']) {
      if (evt.macroDelta[k] != null) {
        state.macro[k] = Math.max(-1, Math.min(1, state.macro[k] + evt.macroDelta[k]));
      }
    }
  }
  // 株価への効果
  const affected = [];
  if (evt.effect && evt.effect !== 0) {
    STOCKS.forEach(stk => {
      const matchTicker = evt.ticker && evt.ticker === stk.ticker;
      const matchTag = evt.tag && evt.tag === stk.tag;
      const isGlobal = !evt.ticker && !evt.tag;
      if (matchTicker || matchTag || isGlobal) {
        const before = state.prices[stk.ticker];
        let np = before * (1 + evt.effect);
        np = Math.max(before * 0.95, Math.min(before * 1.05, np));
        np = np < 100 ? Math.round(np * 10) / 10 : Math.round(np);
        state.prices[stk.ticker] = np;
        if (priceHistory[stk.ticker]) {
          priceHistory[stk.ticker].push({ t: state.simMinute, price: np });
          if (priceHistory[stk.ticker].length > 150) priceHistory[stk.ticker].shift();
        }
        affected.push(stk.name);
      }
    });
  }
  const entry = { ...evt, simMinute: state.simMinute, affected, scenario: sc.id };
  state.newsLog.push(entry);
  activeNewsEvent = entry;
  showNewsToast(entry);
}

function showScenarioResult(sc) {
  const total = state.cash + getTotalStockValue();
  const delta = total - state.initialCapital;
  const pct = (delta / state.initialCapital) * 100;
  // 完走記録
  if (!state.completedScenarios) state.completedScenarios = [];
  state.completedScenarios.push({ id: sc.id, delta, pct, completedAt: Date.now() });
  saveState();
  const sign = delta >= 0 ? '+' : '';
  const cls = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'zero';
  const points = sc.debrief.points.map(p => `<li>${escapeHtml(p)}</li>`).join('');
  // タグ別/銘柄別ベスト
  const tagStats = buildDecisionTagStats(state);
  document.getElementById('scenarioResultContent').innerHTML = `
    <h2 class="tut-title">${sc.badge} シナリオ完了 — ${sc.name}</h2>
    <div class="review-perf">
      <div class="review-perf-label">最終損益</div>
      <div class="review-perf-value ${cls}">${sign}${formatYen(delta)} (${sign}${pct.toFixed(2)}%)</div>
    </div>
    <div class="review-section-title">${sc.debrief.title}</div>
    <ul class="scenario-debrief">${points}</ul>
    ${tagStats}
    <div class="review-question">
      <strong>🤔 振り返ろう</strong><br>
      もう一度同じシナリオをやり直すなら、最初に何を変える?
    </div>
    <div style="display:flex;gap:10px;margin-top:18px">
      <button class="tut-btn" style="flex:1" onclick="exitScenario(true);closeScenarioResult()">フリープレイに戻る</button>
      <button class="tut-btn tut-btn-next" style="flex:1" onclick="closeScenarioResult();openScenarioPicker()">別のシナリオへ</button>
    </div>
  `;
  document.getElementById('scenarioResultModal').classList.add('show');
  checkMissionUnlocks();
}

window.closeScenarioResult = function() {
  document.getElementById('scenarioResultModal').classList.remove('show');
};

window.toggleMultiMode = function() {
  if (!state.multiMode) {
    // 単一→複数: 既存口座を「メイン」のまま残し、新しく2口座(各50万円)を作成
    if (!confirm('複数ポートフォリオを開始しますか?\n\n「積極運用(50万円)」と「守り重視(50万円)」の2口座が作成されます。\nメイン口座とは別に並走できます(切り替え可能)。')) return;
    state.accounts = {
      aggressive: defaultAccount(500000),
      defensive: defaultAccount(500000),
    };
    state.multiMode = true;
    state.activeAccount = 'aggressive';
  } else {
    if (!confirm('複数ポートフォリオモードを終了しますか?\n\n2口座のデータは保存されたまま、メイン口座に戻ります。')) return;
    state.multiMode = false;
    state.activeAccount = 'main';
  }
  saveState();
  render();
};

// ============ ローソク足バー構築ヘルパー ============
// 5分足キャンドルを生成
let candleBuffer = {}; // {ticker: {open, high, low, close, vol, barStart}}
const CANDLE_MIN = 15; // 15分足

function pushTick(ticker, price) {
  const barStart = state.simMinute - (state.simMinute % CANDLE_MIN);
  if (!candleBuffer[ticker] || candleBuffer[ticker].barStart !== barStart) {
    // 前のバーを確定
    if (candleBuffer[ticker]) {
      if (!candleHistory[ticker]) candleHistory[ticker] = [];
      candleHistory[ticker].push({ ...candleBuffer[ticker] });
      if (candleHistory[ticker].length > 120) candleHistory[ticker].shift();
    }
    candleBuffer[ticker] = { barStart, open: price, high: price, low: price, close: price, vol: 1 };
  } else {
    const b = candleBuffer[ticker];
    b.high = Math.max(b.high, price);
    b.low  = Math.min(b.low, price);
    b.close = price;
    b.vol++;
  }
}

// ============ 初期化 ============
function initPrices() {
  STOCKS.forEach(stock => {
    if (state.prices[stock.ticker] == null) state.prices[stock.ticker] = stock.basePrice;
    if (state.prevClose[stock.ticker] == null) state.prevClose[stock.ticker] = stock.basePrice;
    if (!priceHistory[stock.ticker]) priceHistory[stock.ticker] = [{ t: state.simMinute, price: state.prices[stock.ticker] }];
    lastPrices[stock.ticker] = state.prices[stock.ticker];
  });
}

// ============ シミュレーションループ ============
function simTick() {
  if (!state.macro) state.macro = defaultMacro();
  // マクロ環境を毎tick少しだけ動かす(市場時間外も)
  state.macro = evolveMacro(state.macro);

  if (isMarketOpen(state.simMinute)) {
    STOCKS.forEach(stock => {
      lastPrices[stock.ticker] = state.prices[stock.ticker];
      state.prices[stock.ticker] = tickPrice(state.prices[stock.ticker], stock, state.macro);
      if (!priceHistory[stock.ticker]) priceHistory[stock.ticker] = [];
      priceHistory[stock.ticker].push({ t: state.simMinute, price: state.prices[stock.ticker] });
      if (priceHistory[stock.ticker].length > 150) priceHistory[stock.ticker].shift();
      pushTick(stock.ticker, state.prices[stock.ticker]);
    });
  }

  // ニュースイベント判定(シナリオモード中はランダムニュース抑制)
  if (!state.firedNewsIds) state.firedNewsIds = [];
  if (!state.newsLog) state.newsLog = [];
  if (!state.scenarioMode) {
    const newsEvt = checkNewsEvent(state.simMinute, state.firedNewsIds);
    if (newsEvt) {
      applyNewsEvent(newsEvt);
    }
  } else {
    progressScenario();
  }

  const nextMinute = advanceTime(state.simMinute);
  // 日またぎの判定(15:00到達時に前日終値更新)
  const currentDayMin = state.simMinute % (24 * 60);
  const nextDayMin = nextMinute % (24 * 60);
  if (currentDayMin === 15 * 60 - 1 || nextDayMin === 9 * 60) {
    STOCKS.forEach(stock => { state.prevClose[stock.ticker] = state.prices[stock.ticker]; });
  }
  state.simMinute = nextMinute;

  // 資産推移を記録（10分ごと） - 全口座について
  if (state.simMinute % 10 === 0) {
    listAccounts().forEach(({ acc }) => {
      if (!acc.portfolioHistory) acc.portfolioHistory = [];
      const totalVal = acc.cash + getStockValueOf(acc);
      acc.portfolioHistory.push({ t: state.simMinute, value: totalVal });
      if (acc.portfolioHistory.length > 500) acc.portfolioHistory.shift();
    });
  }

  // 週次振り返りチェック（7日ごと）
  const currentDay = Math.floor(state.simMinute / (24 * 60));
  if (!state.lastReviewDay) state.lastReviewDay = 0;
  if (currentDay > 0 && currentDay % 7 === 0 && currentDay !== state.lastReviewDay) {
    state.lastReviewDay = currentDay;
    showWeeklyReview(currentDay);
  }

  if (state.simMinute % 10 === 0) saveState();
  render();
}

function startSimLoop() {
  if (simTickTimer) clearInterval(simTickTimer);
  if (simSpeed === 0) return;
  simTickTimer = setInterval(simTick, 6000 / simSpeed);
}

window.setSpeed = function(speed, btn) {
  simSpeed = speed;
  document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  startSimLoop();
};

// ============ フォーマッタ ============
function formatYen(v) {
  if (v == null || isNaN(v)) return '—';
  return '¥' + Math.round(v).toLocaleString('ja-JP');
}
function formatNum(v) { return Math.round(v).toLocaleString('ja-JP'); }

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function buildSparkline(ticker, isUp) {
  const history = priceHistory[ticker];
  if (!history || history.length < 2) return '';
  const prices = history.map(h => h.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const w = 100, h = 40;
  const points = prices.map((v, i) => {
    const x = (i / (prices.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const color = isUp ? 'var(--green)' : 'var(--red)';
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

// ============ テクニカル計算ヘルパー ============
function calcSMA(arr, n) {
  return arr.map((_, i) => {
    if (i < n - 1) return null;
    return arr.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n;
  });
}

function calcEMA(arr, n) {
  const k = 2 / (n + 1);
  const out = Array(arr.length).fill(null);
  let startIdx = arr.findIndex(v => v !== null);
  if (startIdx < 0) return out;
  out[startIdx + n - 1] = arr.slice(startIdx, startIdx + n).reduce((s, v) => s + v, 0) / n;
  for (let i = startIdx + n; i < arr.length; i++) {
    out[i] = arr[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function calcBB(closes, n = 20, mult = 2) {
  const mid = calcSMA(closes, n);
  return closes.map((_, i) => {
    if (mid[i] === null) return { mid: null, upper: null, lower: null };
    const slice = closes.slice(i - n + 1, i + 1);
    const mean = mid[i];
    const sd = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
    return { mid: mean, upper: mean + mult * sd, lower: mean - mult * sd };
  });
}

function calcRSI(closes, n = 14) {
  const out = Array(closes.length).fill(null);
  if (closes.length < n + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / n, avgLoss = losses / n;
  out[n] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (n - 1) + Math.max(d, 0)) / n;
    avgLoss = (avgLoss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// ============ チャート描画 ============
// 共通：チャートタイプ切り替えUIを含むラッパー
function buildDetailChart(ticker) {
  const history = priceHistory[ticker];
  if (!history || history.length < 2) return '<div class="pg-empty">データ蓄積中...（株式市場が開いている間に自動で蓄積されます）</div>';
  const inner = buildChartInner(ticker, currentChartType);
  const tfList = [
    { id: '15m', label: '15分足' },
    { id: '1h',  label: '1時間足' },
    { id: '4h',  label: '4時間足' },
    { id: '1d',  label: '日足' },
  ];
  const types = [
    { id: 'line',   label: '折れ線' },
    { id: 'candle_ma', label: 'ローソク+MA' },
    { id: 'bb',     label: 'ボリンジャー' },
    { id: 'rsi',    label: 'RSI' },
    { id: 'volume', label: '出来高' },
  ];
  const tfBtns = tfList.map(t =>
    `<button class="chart-tf-btn${currentChartTf === t.id ? ' active' : ''}" onclick="switchChartTf('${t.id}')">${t.label}</button>`
  ).join('');
  const btns = types.map(t =>
    `<button class="chart-tab-btn${currentChartType === t.id ? ' active' : ''}" onclick="switchChartType('${t.id}')">${t.label}</button>`
  ).join('');
  const desc = getChartDescription(currentChartType);
  return `
    <div class="chart-toolbar">
      <div class="chart-timeframes">${tfBtns}</div>
      <div class="chart-timeframe-note">時間軸を切り替えると同じ銘柄でも見え方が変わる</div>
    </div>
    <div class="chart-tabs">${btns}</div>
    <div id="chartInner" class="chart-inner">${inner}</div>
    <div class="chart-desc" id="chartDesc">${desc}</div>
  `;
}

window.switchChartType = function(type) {
  currentChartType = type;
  if (!currentModalStock) return;
  document.getElementById('modalChart').innerHTML = buildDetailChart(currentModalStock.ticker);
};

window.switchChartTf = function(tf) {
  currentChartTf = tf;
  if (!currentModalStock) return;
  document.getElementById('modalChart').innerHTML = buildDetailChart(currentModalStock.ticker);
};

function getChartDescription(type) {
  const map = {
    line: `<strong>📈 折れ線チャート</strong> — 株価の動きをシンプルな線で表したもの。値上がりなら<span style="color:var(--green)">緑</span>、値下がりなら<span style="color:var(--red)">赤</span>になる。まず最初に見るチャート。`,
    candle_ma: `<strong>🕯＋〰 ローソク足 + 移動平均線</strong> — 1つの画面で値動きとトレンドを同時に確認。<br>
      <span style="color:var(--green)">■ 緑（陽線）</span>/<span style="color:var(--red)">■ 赤（陰線）</span>で上げ下げ、<span style="color:#f9c74f">黄(SMA5)</span>と<span style="color:#4ecdc4">青(SMA20)</span>で流れを見る。<br>
      まず時間軸を選んでから読むと判断しやすい。`,
    bb: `<strong>📊 ボリンジャーバンド</strong> — 移動平均線(中央線)の上下に「±2σ(シグマ)」の幅の帯を描いたもの。<br>
      約95%の確率で株価はこのバンド内に収まる。<br>
      株価がバンドの上限に近いと「買われ過ぎかも」、下限に近いと「売られ過ぎかも」と読む。`,
    rsi: `<strong>💡 RSI（相対力指数）</strong> — 0〜100の数値で「買われ過ぎ・売られ過ぎ」を示すもの。<br>
      <span style="color:var(--red)">70以上 → 買われ過ぎ（売りを検討）</span><br>
      <span style="color:var(--green)">30以下 → 売られ過ぎ（買いを検討）</span><br>
      ただし強いトレンドのときは無視されることもある。一つの参考指標として使おう。`,
    volume: `<strong>📦 出来高（ボリューム）</strong> — どれだけ多く取引されたかを棒グラフで示す。<br>
      株価が大きく動くとき、出来高も増えることが多い。<br>
      出来高が少ないときの値動きは「信頼性が低い」とも言われる。価格と合わせて確認しよう。`,
  };
  return map[type] || '';
}

function buildChartInner(ticker, type) {
  const history = priceHistory[ticker] || [];
  const candles = getCandlesForChart(ticker, currentChartTf);
  if (history.length < 2) return '<div class="pg-empty">データ蓄積中...</div>';

  if (type === 'line')      return buildLineChartFromCandles(candles);
  if (type === 'candle_ma') return buildCandleMAChart(candles);
  if (type === 'bb')     return buildBBChart(candles, history);
  if (type === 'rsi')    return buildRSIChart(candles, history);
  if (type === 'volume') return buildVolumeChart(candles, history);
  return buildLineChartFromCandles(candles);
}

function aggregateCandles(src, intervalMin) {
  if (!src || src.length === 0) return [];
  const sorted = [...src].sort((a, b) => a.barStart - b.barStart);
  const out = [];
  let cur = null;
  for (const c of sorted) {
    const gStart = c.barStart - (c.barStart % intervalMin);
    if (!cur || cur.barStart !== gStart) {
      if (cur) out.push(cur);
      cur = { barStart: gStart, open: c.open, high: c.high, low: c.low, close: c.close, vol: c.vol || 0 };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.vol += c.vol || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// priceHistoryからダミーcandles生成（candleHistoryが不足の場合のフォールバック）
function getCandlesForChart(ticker, tf = '15m') {
  const hist = [...(candleHistory[ticker] || [])];
  const live = candleBuffer[ticker];
  if (live) hist.push({ ...live });

  const tfMap = { '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
  const intervalMin = tfMap[tf] || 15;

  if (hist.length >= 5) {
    const agged = aggregateCandles(hist, intervalMin);
    return agged.slice(-80);
  }

  // fallback: priceHistoryからOHLC近似
  const ph = priceHistory[ticker] || [];
  const size = Math.max(1, Math.floor(ph.length / 40));
  const out = [];
  for (let i = 0; i < ph.length; i += size) {
    const chunk = ph.slice(i, i + size);
    const prices = chunk.map(h => h.price);
    out.push({
      barStart: chunk[0].t,
      open: prices[0], close: prices[prices.length - 1],
      high: Math.max(...prices), low: Math.min(...prices),
      vol: chunk.length,
    });
  }
  const agged = aggregateCandles(out, intervalMin);
  return agged.slice(-80);
}

const W = 580, H = 130;
function svgWrap(inner, h = H) {
  return `<svg class="detail-chart" viewBox="0 0 ${W} ${h}" preserveAspectRatio="none">${inner}</svg>`;
}
function tradeMarkers(ticker, toX, toY, history) {
  const acc = getActiveAccount();
  const trades = acc.journal.filter(e => e.ticker === ticker);
  return trades.map(e => {
    let closest = 0, bestDiff = Infinity;
    history.forEach((h, i) => { const d = Math.abs(h.t - e.simMinute); if (d < bestDiff) { bestDiff = d; closest = i; } });
    const cx = toX(closest).toFixed(1);
    const cy = toY(history[closest].price).toFixed(1);
    const fill = e.action === 'buy' ? 'var(--green)' : 'var(--red)';
    return `<circle cx="${cx}" cy="${cy}" r="5" fill="${fill}" opacity="0.9"/>
      <text x="${cx}" y="${(parseFloat(cy) - 8).toFixed(1)}" text-anchor="middle" fill="${fill}" font-size="9" font-family="sans-serif">${e.action === 'buy' ? '買' : '売'}</text>`;
  }).join('');
}

function buildLineChart(ticker, history) {
  const prices = history.map(h => h.price);
  const min = Math.min(...prices) * 0.997, max = Math.max(...prices) * 1.003;
  const range = max - min || 1;
  const toX = i => (i / (history.length - 1)) * W;
  const toY = v => H - ((v - min) / range) * H;
  const pts = history.map((h, i) => `${toX(i).toFixed(1)},${toY(h.price).toFixed(1)}`).join(' ');
  const isUp = prices[prices.length - 1] >= prices[0];
  const color = isUp ? 'var(--green)' : 'var(--red)';
  const fillId = 'lf' + ticker;
  const lastX = toX(history.length - 1).toFixed(1);
  return svgWrap(`
    <defs><linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="0,${H} ${pts} ${lastX},${H}" fill="url(#${fillId})"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${tradeMarkers(ticker, toX, toY, history)}
  `);
}

function buildLineChartFromCandles(candles) {
  if (!candles || candles.length < 2) return '<div class="pg-empty">折れ線データ蓄積中...</div>';
  const closes = candles.map(c => c.close);
  const min = Math.min(...closes) * 0.997;
  const max = Math.max(...closes) * 1.003;
  const range = max - min || 1;
  const toX = i => (i / (candles.length - 1)) * W;
  const toY = v => H - ((v - min) / range) * H;
  const pts = closes.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  const isUp = closes[closes.length - 1] >= closes[0];
  const color = isUp ? 'var(--green)' : 'var(--red)';
  const fillId = 'lf2';
  const lastX = toX(candles.length - 1).toFixed(1);
  return svgWrap(`
    <defs><linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="0,${H} ${pts} ${lastX},${H}" fill="url(#${fillId})"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
  `);
}

function buildCandleMAChart(candles) {
  if (candles.length < 2) return '<div class="pg-empty">ローソク足データ蓄積中...</div>';
  const prices = candles.flatMap(c => [c.high, c.low]);
  const closes = candles.map(c => c.close);
  const sma5  = calcSMA(closes, 5);
  const sma20 = calcSMA(closes, 20);
  const maVals = [...sma5.filter(v => v != null), ...sma20.filter(v => v != null)];
  const allPrices = maVals.length ? prices.concat(maVals) : prices;
  const min = Math.min(...allPrices) * 0.997;
  const max = Math.max(...allPrices) * 1.003;
  const range = max - min || 1;
  const toX = i => (i / (candles.length - 1)) * W;
  const toY = v => H - ((v - min) / range) * H;
  const bw = Math.max(2, (W / candles.length) * 0.6);
  const paths = candles.map((c, i) => {
    const x = toX(i);
    const isUp = c.close >= c.open;
    const color = isUp ? 'var(--green)' : 'var(--red)';
    const y1 = toY(Math.max(c.open, c.close)), y2 = toY(Math.min(c.open, c.close));
    const bodyH = Math.max(1, y2 - y1);
    return `<line x1="${x.toFixed(1)}" y1="${toY(c.high).toFixed(1)}" x2="${x.toFixed(1)}" y2="${toY(c.low).toFixed(1)}" stroke="${color}" stroke-width="1" vector-effect="non-scaling-stroke"/>
      <rect x="${(x - bw/2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}" opacity="0.85"/>`;
  }).join('');

  const buildLine = (arr, color, width = 1.5) => {
    const seg = []; let cur = '';
    arr.forEach((v, i) => {
      if (v === null) { if (cur) { seg.push(`<polyline points="${cur.trim()}" fill="none" stroke="${color}" stroke-width="${width}" vector-effect="non-scaling-stroke"/>`); cur = ''; } }
      else cur += ` ${toX(i).toFixed(1)},${toY(v).toFixed(1)}`;
    });
    if (cur) seg.push(`<polyline points="${cur.trim()}" fill="none" stroke="${color}" stroke-width="${width}" vector-effect="non-scaling-stroke"/>`);
    return seg.join('');
  };

  return svgWrap(`
    ${paths}
    ${buildLine(sma5, '#f9c74f', 1.8)}
    ${buildLine(sma20, '#4ecdc4', 1.8)}
    <text x="4" y="12" fill="#f9c74f" font-size="9" font-family="sans-serif">SMA5</text>
    <text x="38" y="12" fill="#4ecdc4" font-size="9" font-family="sans-serif">SMA20</text>
  `);
}

function buildBBChart(candles, history) {
  const closes = candles.map(c => c.close);
  const bb = calcBB(closes, 20, 2);
  const validBB = bb.filter(b => b.upper !== null);
  if (validBB.length < 3) return '<div class="pg-empty">ボリンジャーバンドはデータ20本以上で表示されます</div>';
  const allPrices = [...closes, ...validBB.map(b => b.upper), ...validBB.map(b => b.lower)];
  const min = Math.min(...allPrices) * 0.997, max = Math.max(...allPrices) * 1.003;
  const range = max - min || 1;
  const toX = i => (i / (candles.length - 1)) * W;
  const toY = v => H - ((v - min) / range) * H;
  const buildPts = arr => arr.map((v, i) => v === null ? null : `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`);
  const filterPts = pts => pts.filter(p => p !== null).join(' ');
  const upperPts = filterPts(buildPts(bb.map(b => b.upper)));
  const lowerPts = filterPts(buildPts(bb.map(b => b.lower)));
  const midPts   = filterPts(buildPts(bb.map(b => b.mid)));
  const pricePts = filterPts(candles.map((c, i) => `${toX(i).toFixed(1)},${toY(c.close).toFixed(1)}`));
  // バンド塗り
  const bandPoly = upperPts + ' ' + lowerPts.split(' ').reverse().join(' ');
  return svgWrap(`
    <polygon points="${bandPoly}" fill="var(--green)" opacity="0.08"/>
    <polyline points="${upperPts}" fill="none" stroke="var(--green)" stroke-width="1" stroke-dasharray="3,2" vector-effect="non-scaling-stroke"/>
    <polyline points="${lowerPts}" fill="none" stroke="var(--red)" stroke-width="1" stroke-dasharray="3,2" vector-effect="non-scaling-stroke"/>
    <polyline points="${midPts}" fill="none" stroke="#f9c74f" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <polyline points="${pricePts}" fill="none" stroke="var(--ink)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <text x="4" y="12" fill="#f9c74f" font-size="9" font-family="sans-serif">中心線</text>
    <text x="36" y="12" fill="var(--green)" font-size="9" font-family="sans-serif">+2σ</text>
    <text x="56" y="12" fill="var(--red)" font-size="9" font-family="sans-serif">-2σ</text>
  `);
}

function buildRSIChart(candles, history) {
  const closes = candles.map(c => c.close);
  const rsi = calcRSI(closes, 14);
  const validRsi = rsi.filter(v => v !== null);
  if (validRsi.length < 3) return '<div class="pg-empty">RSIはデータ15本以上で表示されます</div>';
  const RSI_H = 80;
  const toX = i => (i / (rsi.length - 1)) * W;
  const toY = v => RSI_H - (v / 100) * RSI_H;
  const pts = rsi.map((v, i) => v === null ? null : `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).filter(Boolean).join(' ');
  const y70 = toY(70).toFixed(1), y30 = toY(30).toFixed(1), y50 = toY(50).toFixed(1);
  const lastVal = validRsi[validRsi.length - 1];
  const rsiColor = lastVal >= 70 ? 'var(--red)' : lastVal <= 30 ? 'var(--green)' : 'var(--ink)';
  return svgWrap(`
    <rect x="0" y="0" width="${W}" height="${y70}" fill="var(--red)" opacity="0.06"/>
    <rect x="0" y="${y30}" width="${W}" height="${RSI_H - parseFloat(y30)}" fill="var(--green)" opacity="0.06"/>
    <line x1="0" y1="${y70}" x2="${W}" y2="${y70}" stroke="var(--red)" stroke-width="0.8" stroke-dasharray="3,3" vector-effect="non-scaling-stroke"/>
    <line x1="0" y1="${y50}" x2="${W}" y2="${y50}" stroke="var(--border)" stroke-width="0.8" stroke-dasharray="2,4" vector-effect="non-scaling-stroke"/>
    <line x1="0" y1="${y30}" x2="${W}" y2="${y30}" stroke="var(--green)" stroke-width="0.8" stroke-dasharray="3,3" vector-effect="non-scaling-stroke"/>
    <polyline points="${pts}" fill="none" stroke="${rsiColor}" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <text x="4" y="10" fill="var(--red)" font-size="8" font-family="sans-serif">70 買われ過ぎ</text>
    <text x="4" y="${parseFloat(y30) + 10}" fill="var(--green)" font-size="8" font-family="sans-serif">30 売られ過ぎ</text>
    <text x="${W - 30}" y="${toY(lastVal) - 5}" fill="${rsiColor}" font-size="10" font-family="JetBrains Mono,monospace">${lastVal.toFixed(0)}</text>
  `, RSI_H);
}

function buildVolumeChart(candles, history) {
  if (candles.length < 2) return '<div class="pg-empty">出来高データ蓄積中...</div>';
  const VOL_H = 60;
  const maxVol = Math.max(...candles.map(c => c.vol), 1);
  const bw = Math.max(1, (W / candles.length) * 0.7);
  // 上部: 価格折れ線
  const closes = candles.map(c => c.close);
  const pMin = Math.min(...closes) * 0.997, pMax = Math.max(...closes) * 1.003;
  const pRange = pMax - pMin || 1;
  const topH = H - VOL_H - 10;
  const toX = i => (i / (candles.length - 1)) * W;
  const toPy = v => topH - ((v - pMin) / pRange) * topH;
  const toVy = v => H - (v / maxVol) * VOL_H;
  const pricePts = candles.map((c, i) => `${toX(i).toFixed(1)},${toPy(c.close).toFixed(1)}`).join(' ');
  const bars = candles.map((c, i) => {
    const x = toX(i);
    const barH = (c.vol / maxVol) * VOL_H;
    const color = c.close >= c.open ? 'var(--green)' : 'var(--red)';
    return `<rect x="${(x - bw/2).toFixed(1)}" y="${(H - barH).toFixed(1)}" width="${bw.toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}" opacity="0.7"/>`;
  }).join('');
  return svgWrap(`
    <polyline points="${pricePts}" fill="none" stroke="var(--ink)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <line x1="0" y1="${topH + 5}" x2="${W}" y2="${topH + 5}" stroke="var(--border)" stroke-width="0.8"/>
    ${bars}
    <text x="4" y="12" fill="var(--ink-dim)" font-size="8" font-family="sans-serif">価格</text>
    <text x="4" y="${topH + 16}" fill="var(--ink-dim)" font-size="8" font-family="sans-serif">出来高</text>
  `);
}

// ② 保有銘柄別損益バーチャート（水平）
function buildPnlBarChart() {
  const acc = getActiveAccount();
  const tickers = Object.keys(acc.holdings);
  if (tickers.length === 0) return '';
  const items = tickers.map(t => {
    const h = acc.holdings[t];
    const cur = state.prices[t];
    const pnl = (cur - h.avgCost) * h.qty;
    const pct = ((cur - h.avgCost) / h.avgCost) * 100;
    const name = STOCKS.find(s => s.ticker === t)?.name || t;
    return { name, pnl, pct };
  }).sort((a, b) => b.pnl - a.pnl);
  const maxAbs = Math.max(...items.map(i => Math.abs(i.pnl)), 1);
  const rows = items.map(item => {
    const w = Math.round((Math.abs(item.pnl) / maxAbs) * 100);
    const isUp = item.pnl >= 0;
    const cls = isUp ? 'pnl-bar-up' : 'pnl-bar-down';
    const sign = isUp ? '+' : '';
    const pct = item.pct.toFixed(1);
    return `<div class="pnl-bar-row">
      <div class="pnl-bar-label">${item.name}</div>
      <div class="pnl-bar-track">
        <div class="pnl-bar ${cls}" style="width:${w}%"></div>
      </div>
      <div class="pnl-bar-val ${isUp ? 'positive' : 'negative'}">${sign}${pct}%</div>
    </div>`;
  }).join('');
  return `<div class="pnl-bar-chart">${rows}</div>`;
}

// ③ 資産構成リングチャート（現金 + 各銘柄）
function buildAllocationRing() {
  const acc = getActiveAccount();
  const tickers = Object.keys(acc.holdings);
  const totalStock = getStockValueOf(acc);
  const total = acc.cash + totalStock;
  if (total <= 0) return '';
  // セグメント定義
  const COLORS = ['#7bd88f','#f9c74f','#ff6b6b','#4ecdc4','#a29bfe','#fd79a8','#fdcb6e','#6c5ce7','#00b894','#e17055','#74b9ff','#55efc4'];
  const segments = [{ label: '現金', value: acc.cash, color: '#5a7a65' }];
  tickers.forEach((t, i) => {
    const val = state.prices[t] * acc.holdings[t].qty;
    const name = STOCKS.find(s => s.ticker === t)?.name || t;
    segments.push({ label: name, value: val, color: COLORS[i % COLORS.length] });
  });
  // SVGパス生成
  const cx = 80, cy = 80, r = 60, ir = 38;
  let startAngle = -Math.PI / 2;
  let paths = '', legend = '';
  segments.forEach(seg => {
    const angle = (seg.value / total) * 2 * Math.PI;
    const endAngle = startAngle + angle;
    const x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle),   y2 = cy + r * Math.sin(endAngle);
    const ix1 = cx + ir * Math.cos(startAngle), iy1 = cy + ir * Math.sin(startAngle);
    const ix2 = cx + ir * Math.cos(endAngle),   iy2 = cy + ir * Math.sin(endAngle);
    const lg = angle > Math.PI ? 1 : 0;
    if (angle > 0.01) {
      paths += `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${lg},1 ${x2.toFixed(1)},${y2.toFixed(1)} L${ix2.toFixed(1)},${iy2.toFixed(1)} A${ir},${ir} 0 ${lg},0 ${ix1.toFixed(1)},${iy1.toFixed(1)} Z" fill="${seg.color}" opacity="0.85"/>`;
    }
    const pct = ((seg.value / total) * 100).toFixed(1);
    legend += `<div class="ring-legend-item"><span class="ring-dot" style="background:${seg.color}"></span><span>${seg.label}</span><span class="ring-pct">${pct}%</span></div>`;
    startAngle = endAngle;
  });
  return `<div class="ring-wrap">
    <svg viewBox="0 0 160 160" class="ring-svg">
      ${paths}
      <text x="${cx}" y="${cy - 6}" text-anchor="middle" fill="var(--ink-dim)" font-size="9" font-family="JetBrains Mono,monospace">合計</text>
      <text x="${cx}" y="${cy + 10}" text-anchor="middle" fill="var(--ink)" font-size="11" font-weight="bold" font-family="JetBrains Mono,monospace">¥${Math.round(total).toLocaleString('ja-JP')}</text>
    </svg>
    <div class="ring-legend">${legend}</div>
  </div>`;
}

function buildPortfolioGraph() {
  const acc = getActiveAccount();
  // 複数モードでは両口座を重ね描き
  if (state.multiMode && state.accounts) {
    return buildMultiPortfolioGraph();
  }
  const hist = acc.portfolioHistory || [];
  if (hist.length < 2) return '<div class="pg-empty">まだデータが少ない。しばらく運用すると資産推移グラフが表示されます。</div>';
  const values = hist.map(h => h.value);
  const min = Math.min(...values, acc.initialCapital) * 0.998;
  const max = Math.max(...values, acc.initialCapital) * 1.002;
  const range = max - min || 1;
  const W = 600, H = 120;
  const toX = (i) => (i / (hist.length - 1)) * W;
  const toY = (v) => H - ((v - min) / range) * H;
  const points = hist.map((h, i) => `${toX(i).toFixed(1)},${toY(h.value).toFixed(1)}`).join(' ');
  const baseY = toY(acc.initialCapital).toFixed(1);
  const lastVal = values[values.length - 1];
  const isUp = lastVal >= acc.initialCapital;
  const color = isUp ? 'var(--green)' : 'var(--red)';
  const fillId = 'pgFill';
  return `<svg class="portfolio-graph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <line x1="0" y1="${baseY}" x2="${W}" y2="${baseY}" stroke="var(--border)" stroke-width="1" stroke-dasharray="4,3"/>
    <polygon points="${toX(0).toFixed(1)},${H} ${points} ${toX(hist.length-1).toFixed(1)},${H}"
      fill="url(#${fillId})"/>
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

// 複数口座: 両ポートフォリオを%基準で重ね描き(出発点=100%)
function buildMultiPortfolioGraph() {
  const accs = listAccounts();
  const W = 600, H = 130;
  // %基準に変換
  const series = accs.map(({ id, name, acc }) => {
    const hist = acc.portfolioHistory || [];
    if (hist.length < 2) return null;
    const init = acc.initialCapital;
    const pts = hist.map(h => ({ t: h.t, pct: (h.value / init) * 100 }));
    return { id, name, pts };
  }).filter(Boolean);
  if (series.length === 0) return '<div class="pg-empty">まだデータが少ない。両口座でしばらく運用すると比較グラフが表示されます。</div>';
  // y軸範囲
  const allPcts = series.flatMap(s => s.pts.map(p => p.pct));
  const min = Math.min(...allPcts, 100) - 1;
  const max = Math.max(...allPcts, 100) + 1;
  const range = max - min || 1;
  // x軸: 全口座のtを揃える(最大長)
  const maxLen = Math.max(...series.map(s => s.pts.length));
  const toX = (i, len) => (i / (len - 1)) * W;
  const toY = (v) => H - ((v - min) / range) * H;
  const baseY = toY(100).toFixed(1);
  const colorMap = { aggressive: '#ff6b6b', defensive: '#4ecdc4', main: 'var(--green)' };
  const lines = series.map(s => {
    const len = s.pts.length;
    const pts = s.pts.map((p, i) => `${toX(i, len).toFixed(1)},${toY(p.pct).toFixed(1)}`).join(' ');
    const c = colorMap[s.id] || 'var(--ink)';
    return `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  }).join('');
  const legend = series.map(s => {
    const c = colorMap[s.id] || 'var(--ink)';
    const last = s.pts[s.pts.length - 1].pct;
    return `<text fill="${c}" font-size="10" font-family="JetBrains Mono,monospace">${s.name}: ${last.toFixed(1)}%</text>`;
  });
  return `<svg class="portfolio-graph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" y1="${baseY}" x2="${W}" y2="${baseY}" stroke="var(--border)" stroke-width="1" stroke-dasharray="4,3"/>
    ${lines}
    <g transform="translate(8,14)">${legend.map((t, i) => `<g transform="translate(0,${i*12})">${t}</g>`).join('')}</g>
  </svg>`;
}

// ============ レンダリング ============
function getStockValueOf(acc) {
  let total = 0;
  for (const [ticker, holding] of Object.entries(acc.holdings || {})) {
    const price = state.prices[ticker];
    if (price) total += price * holding.qty;
  }
  return total;
}
function getTotalStockValue() {
  return getStockValueOf(getActiveAccount());
}

function render() {
  document.getElementById('simClock').textContent = formatSimTime(state.simMinute);
  renderScenarioBanner();
  renderPortfolio();
  renderHoldings();
  renderStocks();
  renderJournal();
  renderDiversityScore();
  renderPredictions();
  if (currentModalStock && document.getElementById('modal').classList.contains('show')) {
    updateModalPrice();
    updateSummary();
  }
}

function renderScenarioBanner() {
  const el = document.getElementById('scenarioBanner');
  if (!el) return;
  if (!state.scenarioMode) { el.innerHTML = ''; el.style.display = 'none'; return; }
  const sc = getScenario(state.scenarioMode.id);
  if (!sc) { el.innerHTML = ''; el.style.display = 'none'; return; }
  const elapsedDays = Math.max(0, Math.floor((state.simMinute - state.scenarioMode.startMinute) / (24 * 60)));
  const remaining = Math.max(0, sc.durationDays - elapsedDays);
  const progress = Math.min(100, (elapsedDays / sc.durationDays) * 100);
  el.style.display = '';
  el.innerHTML = `
    <div class="sc-banner-inner">
      <div class="sc-banner-badge">${sc.badge}</div>
      <div class="sc-banner-body">
        <div class="sc-banner-title">📚 シナリオ進行中: ${sc.name}</div>
        <div class="sc-banner-meta">経過 ${elapsedDays}日 / 残り ${remaining}日</div>
        <div class="sc-banner-bar"><div class="sc-banner-fill" style="width:${progress.toFixed(1)}%"></div></div>
      </div>
      <button class="sc-banner-quit" onclick="confirmExitScenario()">中断</button>
    </div>
  `;
}

window.confirmExitScenario = function() {
  if (!confirm('シナリオを中断してフリープレイに戻りますか?\n進行中のシナリオデータは破棄されます。')) return;
  exitScenario(true);
};

// ============ 予想 vs 実際カード(L1強化) ============
// 買いトレードの予想株価が予定時刻(7日後)を過ぎたら、振り返りカードを表示。
// 「acknowledged: true」になったエントリは表示しない(表示済みフラグ)
function renderPredictions() {
  const el = document.getElementById('predictionsSection');
  if (!el) return;
  const acc = getActiveAccount();
  const due = (acc.journal || []).filter(e =>
    e.action === 'buy' &&
    e.predictPrice != null &&
    e.predictDueMinute != null &&
    state.simMinute >= e.predictDueMinute &&
    !e.predictAcknowledged
  );
  if (due.length === 0) { el.innerHTML = ''; return; }

  const cards = due.map((e, idx) => {
    const cur = state.prices[e.ticker];
    const predicted = e.predictPrice;
    const predDir = predicted > e.price ? 'up' : predicted < e.price ? 'down' : 'flat';
    const actDir  = cur > e.price ? 'up' : cur < e.price ? 'down' : 'flat';
    const dirHit  = predDir === actDir && predDir !== 'flat';
    const errPct  = Math.abs(predicted - cur) / cur * 100;
    const closeHit = errPct <= 3; // 誤差3%以内で「ほぼ的中」
    let verdict, vCls;
    if (closeHit) { verdict = '🎯 ほぼ的中!'; vCls = 'pred-hit'; }
    else if (dirHit) { verdict = '🔼 方向は当たり'; vCls = 'pred-dir'; }
    else { verdict = '❌ 外れた'; vCls = 'pred-miss'; }
    return `<div class="pred-card ${vCls}">
      <div class="pred-head">
        <span class="pred-stock">${e.stockName}</span>
        <span class="pred-verdict">${verdict}</span>
      </div>
      <div class="pred-grid">
        <div><div class="pred-label">買った時</div><div class="pred-value">${formatYen(e.price)}</div></div>
        <div><div class="pred-label">予想</div><div class="pred-value pred-pred">${formatYen(predicted)}</div></div>
        <div><div class="pred-label">実際 (今)</div><div class="pred-value">${formatYen(cur)}</div></div>
        <div><div class="pred-label">予想との誤差</div><div class="pred-value">${errPct.toFixed(1)}%</div></div>
      </div>
      <div class="pred-reason">買った理由: 「${escapeHtml(e.note) || '(記録なし)'}」</div>
      <button class="pred-ack-btn" onclick="ackPrediction(${acc.journal.indexOf(e)})">✓ 確認した</button>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="section-title">📌 予想の答え合わせ</div>
    <div class="pred-intro">7日前の予想と実際の株価を比べてみよう。当たり外れより<strong>「なぜそう予想したか」</strong>が大事だよ。</div>
    <div class="pred-cards">${cards}</div>
  `;
}

window.ackPrediction = function(idx) {
  const acc = getActiveAccount();
  if (acc.journal[idx]) {
    acc.journal[idx].predictAcknowledged = true;
    saveState();
    renderPredictions();
    checkMissionUnlocks();
  }
};

// ============ ニュースイベント適用 ============
function applyNewsEvent(evt) {
  const affected = [];
  // マクロ要素を持つイベントは指標自体を動かす(株価への直接効果は弱め)
  if (evt.macro) {
    if (!state.macro) state.macro = defaultMacro();
    for (const k of ['rate', 'fx', 'cycle']) {
      if (evt.macro[k] != null) {
        state.macro[k] = Math.max(-1, Math.min(1, state.macro[k] + evt.macro[k]));
      }
    }
  }
  if (evt.effect && evt.effect !== 0) {
    STOCKS.forEach(stock => {
      const matchTicker = evt.ticker && evt.ticker === stock.ticker;
      const matchTag = evt.tag && evt.tag === stock.tag;
      const isGlobal = !evt.ticker && !evt.tag;
      if (matchTicker || matchTag || isGlobal) {
        const before = state.prices[stock.ticker];
        let newPrice = before * (1 + evt.effect);
        // 1tickの±5%制限を適用
        newPrice = Math.max(before * 0.95, Math.min(before * 1.05, newPrice));
        newPrice = newPrice < 100 ? Math.round(newPrice * 10) / 10 : Math.round(newPrice);
        state.prices[stock.ticker] = newPrice;
        if (priceHistory[stock.ticker]) {
          priceHistory[stock.ticker].push({ t: state.simMinute, price: newPrice });
          if (priceHistory[stock.ticker].length > 150) priceHistory[stock.ticker].shift();
        }
        affected.push(stock.name);
      }
    });
  } else if (evt.macro) {
    affected.push('マクロ環境変化');
  }
  state.firedNewsIds.push(evt.id);
  const entry = { ...evt, simMinute: state.simMinute, affected };
  state.newsLog.push(entry);
  activeNewsEvent = entry;
  showNewsToast(entry);
}

function showNewsToast(evt) {
  const el = document.getElementById('newsToast');
  const dirCls = evt.effect > 0 ? 'news-up' : 'news-down';
  const dirStr = evt.effect > 0 ? '▲' : '▼';
  const pct = Math.abs(Math.round(evt.effect * 100));
  el.innerHTML = `
    <div class="news-toast-header"><span class="news-badge">📰 ニュース速報</span><span class="news-pct ${dirCls}">${dirStr}${pct}%</span></div>
    <div class="news-headline">${evt.headline}</div>
    <div class="news-detail">${evt.detail}</div>
    <div class="news-affected">影響: ${evt.affected.join('・')}</div>
  `;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 8000);
}

// ============ 分散スコア ============
function renderDiversityScore() {
  const el = document.getElementById('diversityScore');
  if (!el) return;
  const acc = getActiveAccount();
  const tickers = Object.keys(acc.holdings);
  if (tickers.length === 0) {
    el.innerHTML = '<span class="div-label">分散スコア</span><span class="div-score div-na">—</span><span class="div-msg">株を買うと分散度がわかる</span>';
    return;
  }
  // 保有評価額の比率で計算（HHI逆数ベース）
  const totalVal = getStockValueOf(acc);
  const weights = tickers.map(t => {
    const val = state.prices[t] * acc.holdings[t].qty;
    return val / totalVal;
  });
  const hhi = weights.reduce((sum, w) => sum + w * w, 0);
  const n = tickers.length;
  // HHI: 1=集中、1/n=均等。0〜100スコアに変換
  const score = Math.round((1 - hhi) / (1 - 1 / Math.max(n, 2)) * 100);
  const safeScore = Math.min(100, Math.max(0, isNaN(score) ? 0 : score));
  let grade, msg, cls;
  if (n === 1)       { grade = 'D'; msg = '1銘柄に全集中！分散してみよう'; cls = 'div-d'; }
  else if (safeScore < 40) { grade = 'C'; msg = '一部に偏りがある。もう少し分けてみよう'; cls = 'div-c'; }
  else if (safeScore < 70) { grade = 'B'; msg = 'まずまずの分散。バランスが取れてきた'; cls = 'div-b'; }
  else               { grade = 'A'; msg = '優秀な分散投資！リスクが分散されている'; cls = 'div-a'; }
  el.innerHTML = `<span class="div-label">分散スコア</span><span class="div-score ${cls}">${grade}<small>${safeScore}</small></span><span class="div-msg">${msg}</span>`;
}

// ============ 週次振り返り ============
function showWeeklyReview(day) {
  const weekNum = Math.floor(day / 7);
  const weekStart = (weekNum - 1) * 7 * 24 * 60;
  const weekEnd = weekNum * 7 * 24 * 60;

  const acc = getActiveAccount();
  // 今週のジャーナルエントリ
  const weekJournal = acc.journal.filter(e => e.simMinute >= weekStart && e.simMinute < weekEnd);
  // 今週のニュース
  const weekNews = (state.newsLog || []).filter(e => e.simMinute >= weekStart && e.simMinute < weekEnd);
  // 今週の資産推移（始値・終値）
  const hist = (acc.portfolioHistory || []).filter(e => e.t >= weekStart && e.t < weekEnd);
  const weekStartVal = hist.length > 0 ? hist[0].value : acc.initialCapital;
  const weekEndVal = hist.length > 0 ? hist[hist.length - 1].value : acc.cash + getStockValueOf(acc);
  const weekDelta = weekEndVal - weekStartVal;
  const weekPct = (weekDelta / weekStartVal) * 100;
  const sign = weekDelta >= 0 ? '+' : '';
  const cls = weekDelta > 0 ? 'positive' : weekDelta < 0 ? 'negative' : 'zero';

  const journalHtml = weekJournal.length === 0
    ? '<p style="color:var(--ink-dim);font-size:13px">今週はトレードなし</p>'
    : weekJournal.map(e => {
        const current = state.prices[e.ticker];
        const pnl = current ? (current - e.price) * e.qty * (e.action === 'buy' ? 1 : 0) : null;
        const pnlStr = pnl != null && e.action === 'buy'
          ? `<span class="${pnl >= 0 ? 'positive' : 'negative'}">${pnl >= 0 ? '▲' : '▼'}${formatYen(Math.abs(pnl))} 現在</span>`
          : '';
        return `<div class="review-trade">
          <div class="review-trade-head">
            <span class="${e.action === 'buy' ? 'je-action-buy' : 'je-action-sell'}">${e.stockName}を${e.qty}株 ${e.action === 'buy' ? '買った' : '売った'}</span>
            ${pnlStr}
          </div>
          <div class="review-reason">理由: 「${escapeHtml(e.note) || '(記録なし)'}」</div>
        </div>`;
      }).join('');

  const newsHtml = weekNews.length === 0
    ? '<p style="color:var(--ink-dim);font-size:13px">今週のニュースなし</p>'
    : weekNews.map(e => `<div class="review-news-item">
        <span class="${e.effect > 0 ? 'positive' : 'negative'}">${e.effect > 0 ? '▲' : '▼'}</span>
        ${e.headline}
      </div>`).join('');

  document.getElementById('reviewContent').innerHTML = `
    <h2 class="tut-title">📊 Week ${weekNum} 振り返り</h2>
    <div class="review-perf">
      <div class="review-perf-label">今週の損益</div>
      <div class="review-perf-value ${cls}">${sign}${formatYen(weekDelta)} (${sign}${weekPct.toFixed(2)}%)</div>
    </div>
    <div class="review-section-title">📝 今週のトレードと理由</div>
    ${journalHtml}
    <div class="review-section-title" style="margin-top:18px">📰 今週起きたニュース</div>
    ${newsHtml}
    ${buildDecisionTagStats(acc)}
    <div class="review-question">
      <strong>🤔 考えてみよう</strong><br>
      ${weekJournal.length > 0
        ? '「なぜ買ったか」の理由と、実際の結果は一致していた？どんな判断が良くて、どんな判断がよくなかったかな？'
        : '今週はトレードしなかったね。チャンスがあったとしたら、どの銘柄を買いたかった？'}
    </div>
  `;
  document.getElementById('reviewModal').classList.add('show');
}

// 判断タグ別の勝率集計(累計)
const TAG_LABELS = {
  intuition: { icon: '💭', name: '直感' },
  news:      { icon: '📰', name: 'ニュース' },
  chart:     { icon: '📈', name: 'チャート' },
  diversify: { icon: '⚖', name: '分散' },
};
function buildDecisionTagStats(acc) {
  const buys = (acc.journal || []).filter(e => e.action === 'buy' && e.decisionTag);
  if (buys.length === 0) {
    return `<div class="review-section-title" style="margin-top:18px">🏷 判断タグ別の傾向</div>
      <div style="font-size:12px;color:var(--ink-dim)">まだ判断タグつきの買いがないよ。買うときに「直感/ニュース/チャート/分散」を選ぶと、ここに集計が出るよ。</div>`;
  }
  const tagAggregate = {};
  for (const tag of Object.keys(TAG_LABELS)) tagAggregate[tag] = { count: 0, win: 0, totalPct: 0 };
  for (const e of buys) {
    const cur = state.prices[e.ticker];
    if (!cur) continue;
    const pct = ((cur - e.price) / e.price) * 100;
    const a = tagAggregate[e.decisionTag];
    if (!a) continue;
    a.count++;
    if (pct > 0) a.win++;
    a.totalPct += pct;
  }
  const rows = Object.entries(tagAggregate).filter(([, v]) => v.count > 0).map(([tag, v]) => {
    const lbl = TAG_LABELS[tag];
    const winRate = (v.win / v.count) * 100;
    const avgPct = v.totalPct / v.count;
    const cls = avgPct > 0 ? 'positive' : avgPct < 0 ? 'negative' : 'zero';
    const sign = avgPct >= 0 ? '+' : '';
    return `<tr>
      <td>${lbl.icon} ${lbl.name}</td>
      <td>${v.count}回</td>
      <td>${winRate.toFixed(0)}%</td>
      <td class="${cls}">${sign}${avgPct.toFixed(2)}%</td>
    </tr>`;
  }).join('');
  return `<div class="review-section-title" style="margin-top:18px">🏷 判断タグ別の傾向 (買い・累計)</div>
    <table class="tag-stats-table">
      <thead><tr><th>タグ</th><th>回数</th><th>勝率</th><th>平均含み損益</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="font-size:11px;color:var(--ink-dim);margin-top:6px">※含み損益=現在値ベース。すでに売った銘柄は集計対象外</div>`;
}

window.closeReview = function() {
  document.getElementById('reviewModal').classList.remove('show');
};

function renderPortfolio() {
  const acc = getActiveAccount();
  const stockVal = getStockValueOf(acc);
  const total = acc.cash + stockVal;
  const delta = total - acc.initialCapital;
  const pct = (delta / acc.initialCapital) * 100;

  document.getElementById('totalValue').textContent = formatNum(total);
  document.getElementById('cash').textContent = formatYen(acc.cash);
  document.getElementById('stockValue').textContent = formatYen(stockVal);
  document.getElementById('holdingCount').textContent = Object.keys(acc.holdings).length;

  if (lastTotalValue !== null && stockVal > 0) {
    const wrap = document.getElementById('totalValueWrap');
    if (total > lastTotalValue) {
      wrap.classList.add('flash-up');
      setTimeout(() => wrap.classList.remove('flash-up'), 400);
    } else if (total < lastTotalValue) {
      wrap.classList.add('flash-down');
      setTimeout(() => wrap.classList.remove('flash-down'), 400);
    }
  }
  lastTotalValue = total;

  const deltaEl = document.getElementById('totalDelta');
  const sign = delta > 0 ? '▲' : delta < 0 ? '▼' : '—';
  const cls = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'zero';
  deltaEl.className = `portfolio-delta ${cls}`;
  deltaEl.textContent = `${sign} ${formatYen(Math.abs(delta))} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%) 開始時から`;

  // 口座切替UI
  const accSwitchEl = document.getElementById('accountSwitch');
  if (accSwitchEl) accSwitchEl.innerHTML = buildAccountSwitch();

  // 資産推移グラフ
  const graphEl = document.getElementById('portfolioGraph');
  if (graphEl) graphEl.innerHTML = buildPortfolioGraph();
  // 資産構成リング
  const ringEl = document.getElementById('allocationRing');
  if (ringEl) ringEl.innerHTML = buildAllocationRing();
  // マクロ経済パネル
  const macroEl = document.getElementById('macroPanel');
  if (macroEl) macroEl.innerHTML = buildMacroPanel();
}

// ============ 口座切替UI ============
function buildAccountSwitch() {
  if (!state.multiMode) {
    return `<button class="acc-toggle-btn" onclick="toggleMultiMode()">⚙ 複数ポートフォリオを開始</button>`;
  }
  const accs = listAccounts();
  const cards = accs.map(({ id, name, acc }) => {
    const total = acc.cash + getStockValueOf(acc);
    const delta = total - acc.initialCapital;
    const pct = (delta / acc.initialCapital) * 100;
    const sign = delta >= 0 ? '+' : '';
    const cls = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'zero';
    const isActive = id === state.activeAccount;
    return `<button class="acc-card ${isActive ? 'acc-active' : ''}" onclick="switchAccount('${id}')">
      <div class="acc-name">${name}</div>
      <div class="acc-total">${formatYen(total)}</div>
      <div class="acc-delta ${cls}">${sign}${pct.toFixed(2)}%</div>
    </button>`;
  }).join('');
  return `<div class="acc-switch-wrap">
    <div class="acc-switch-header">
      <span class="acc-switch-title">📂 口座を切り替え</span>
      <button class="acc-toggle-btn-small" onclick="toggleMultiMode()">単一に戻す</button>
    </div>
    <div class="acc-cards">${cards}</div>
  </div>`;
}

// ============ マクロ経済パネル ============
function buildMacroPanel() {
  if (!state.macro) state.macro = defaultMacro();
  const m = describeMacro(state.macro);
  const bar = (v) => {
    // -1〜+1 を 0〜100% へ
    const pct = (v + 1) * 50;
    const knobX = Math.max(2, Math.min(98, pct));
    return `<div class="macro-bar">
      <div class="macro-bar-track">
        <div class="macro-bar-mid"></div>
        <div class="macro-bar-knob" style="left:${knobX}%"></div>
      </div>
    </div>`;
  };
  const colorOf = (v) => v > 0.4 ? 'macro-hi' : v < -0.4 ? 'macro-lo' : 'macro-mid';
  return `<div class="macro-panel">
    <div class="macro-header">🌐 経済指標(マクロ環境)</div>
    <div class="macro-row ${colorOf(m.rate.value)}">
      <div class="macro-label">📈 金利</div>
      ${bar(m.rate.value)}
      <div class="macro-state">${m.rate.label}</div>
      <div class="macro-hint">${m.rate.hint}</div>
    </div>
    <div class="macro-row ${colorOf(m.fx.value)}">
      <div class="macro-label">💴 為替</div>
      ${bar(m.fx.value)}
      <div class="macro-state">${m.fx.label}</div>
      <div class="macro-hint">${m.fx.hint}</div>
    </div>
    <div class="macro-row ${colorOf(m.cycle.value)}">
      <div class="macro-label">🏭 景気</div>
      ${bar(m.cycle.value)}
      <div class="macro-state">${m.cycle.label}</div>
      <div class="macro-hint">${m.cycle.hint}</div>
    </div>
  </div>`;
}

function renderHoldings() {
  const container = document.getElementById('holdingsContent');
  const acc = getActiveAccount();
  const tickers = Object.keys(acc.holdings);
  if (tickers.length === 0) {
    container.innerHTML = '<div class="no-holdings">まだ何も持っていない。下の銘柄一覧から買ってみよう。</div>';
    return;
  }
  let html = `<table><thead><tr>
    <th>銘柄</th><th>株数</th><th>平均取得</th><th>現在値</th><th>損益</th><th>保有期間</th>
  </tr></thead><tbody>`;
  const currentDay = Math.floor(state.simMinute / (24 * 60));
  for (const ticker of tickers) {
    const h = acc.holdings[ticker];
    const stock = STOCKS.find(s => s.ticker === ticker);
    const current = state.prices[ticker];
    const holdDays = h.buyMinute != null ? Math.max(0, currentDay - Math.floor(h.buyMinute / (24 * 60))) : '—';
    const pnl = current ? (current - h.avgCost) * h.qty : 0;
    const pnlPct = current ? ((current - h.avgCost) / h.avgCost) * 100 : 0;
    const cls = pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'zero';
    const sign = pnl > 0 ? '+' : '';
    const holdLabel = holdDays === '—' ? '—' : holdDays === 0 ? '本日' : `${holdDays}日`;
    html += `<tr>
      <td><strong style="font-family:'Zen Kaku Gothic New'">${stock?.name || ticker}</strong></td>
      <td>${h.qty}株</td>
      <td>${formatYen(h.avgCost)}</td>
      <td>${formatYen(current)}</td>
      <td class="${cls}">${sign}${formatYen(pnl)} (${sign}${pnlPct.toFixed(1)}%)</td>
      <td style="font-size:11px;color:var(--ink-dim)">${holdLabel}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  // PnL横棒グラフ
  html += buildPnlBarChart();
  container.innerHTML = html;
}

function renderStocks() {
  const grid = document.getElementById('stocksGrid');
  const acc = getActiveAccount();
  grid.innerHTML = STOCKS.map(stock => {
    const price = state.prices[stock.ticker];
    const prevClose = state.prevClose[stock.ticker];
    const owned = acc.holdings[stock.ticker];
    const change = price - prevClose;
    const pct = prevClose ? (change / prevClose) * 100 : 0;
    const isUp = change >= 0;
    const cls = change > 0 ? 'positive' : change < 0 ? 'negative' : 'zero';
    const sign = change > 0 ? '+' : '';
    const last = lastPrices[stock.ticker];
    let flashCls = '';
    if (last != null && price > last) flashCls = 'flash-up';
    else if (last != null && price < last) flashCls = 'flash-down';

    return `<div class="stock-card" data-ticker="${stock.ticker}">
      <div class="stock-header">
        <div>
          <div class="stock-name">${stock.name}</div>
          <div class="stock-ticker">${stock.ticker} · ${stock.desc}</div>
        </div>
        <span class="stock-tag">${stock.tag}</span>
      </div>
      <div class="stock-price ${flashCls}">${formatYen(price)}</div>
      <div class="stock-change ${cls}">${sign}${formatYen(change)} (${sign}${pct.toFixed(2)}%)</div>
      ${buildSparkline(stock.ticker, isUp)}
      ${owned ? `<div class="stock-owned">★ ${owned.qty}株 保有中</div>` : ''}
    </div>`;
  }).join('');

  // クリックイベント
  grid.querySelectorAll('.stock-card').forEach(card => {
    card.addEventListener('click', () => openModal(card.dataset.ticker));
  });
}

function renderJournal() {
  const container = document.getElementById('journal');
  const acc = getActiveAccount();
  if (acc.journal.length === 0) {
    container.innerHTML = '<div style="color: var(--ink-dim); font-size: 13px; padding: 20px 0;">まだ日記はない。買ったり売ったりすると、ここに理由が記録される。</div>';
    return;
  }
  const entries = [...acc.journal].reverse().slice(0, 20);
  container.innerHTML = entries.map(e => {
    const simTime = formatSimTime(e.simMinute);
    const actionText = e.action === 'buy' ? '買った' : '売った';
    const actionCls = e.action === 'buy' ? 'je-action-buy' : 'je-action-sell';
    return `<div class="journal-entry">
      <div class="je-header">
        <span>${simTime}</span>
        <span class="${actionCls}">${e.stockName}を${e.qty}株 ${actionText}</span>
      </div>
      <div class="je-note">${escapeHtml(e.note) || '(理由なし)'}</div>
      <div class="je-detail">@ ${formatYen(e.price)} · 合計 ${formatYen(e.total)}</div>
    </div>`;
  }).join('');
}

// ============ モーダル ============
function openModal(ticker) {
  const stock = STOCKS.find(s => s.ticker === ticker);
  const price = state.prices[ticker];
  if (!stock || price == null) return;
  currentModalStock = stock;
  document.getElementById('modalName').textContent = stock.name;
  document.getElementById('modalTicker').textContent = `${stock.ticker} · ${stock.tag}`;
  updateModalPrice();
  // 詳細チャート描画
  document.getElementById('modalChart').innerHTML = buildDetailChart(ticker);
  // 会社情報タブ内容(Phase 3: 詳細解説コンテンツ)
  const acc = getActiveAccount();
  const holdInfo = acc.holdings[ticker];
  const holdDays = holdInfo?.buyMinute != null ? Math.max(0, Math.floor(state.simMinute/(24*60)) - Math.floor(holdInfo.buyMinute/(24*60))) : null;
  const moversHtml = (stock.movers || []).map(m => `
    <div class="mover-row"><span class="mover-icon">${m.icon}</span><span class="mover-text">${escapeHtml(m.text)}</span></div>
  `).join('');
  // 感応度バー(マクロ指標が銘柄にどれだけ影響するか)
  const sensBar = (label, val, hi, lo) => {
    const v = val || 0;
    const pct = Math.min(100, Math.abs(v) * 80);
    const color = v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--ink-dim)';
    const dir = v > 0.05 ? hi : v < -0.05 ? lo : '中立';
    return `<div class="sens-row">
      <span class="sens-label">${label}</span>
      <div class="sens-bar"><div class="sens-fill" style="width:${pct.toFixed(0)}%;background:${color}"></div></div>
      <span class="sens-dir" style="color:${color}">${dir}</span>
    </div>`;
  };
  document.getElementById('modalInfo').innerHTML = `
    <div class="info-section">
      <div class="info-section-title">📌 何で稼いでいるか</div>
      <div class="info-business">${escapeHtml(stock.business || stock.desc)}</div>
    </div>
    ${stock.longDesc ? `<div class="info-section">
      <div class="info-section-title">📖 もっと詳しく</div>
      <div class="info-longdesc">${escapeHtml(stock.longDesc)}</div>
    </div>` : ''}
    ${moversHtml ? `<div class="info-section">
      <div class="info-section-title">📊 株価が動く要因</div>
      <div class="movers-list">${moversHtml}</div>
    </div>` : ''}
    <div class="info-section">
      <div class="info-section-title">🌐 マクロ環境への感応度</div>
      <div class="sens-list">
        ${sensBar('金利上昇', stock.rateSensitivity, '追い風', '逆風')}
        ${sensBar('円安進行', stock.fxSensitivity, '追い風', '逆風')}
        ${sensBar('景気拡大', stock.cycleSensitivity, '追い風', '逆風')}
      </div>
      <div class="info-hint">※プラスは「その方向に動くと買われやすい」、マイナスは「売られやすい」</div>
    </div>
    <div class="info-stats">
      <div><span class="info-label">タグ</span><span>${stock.tag}</span></div>
      <div><span class="info-label">基準株価</span><span>${formatYen(stock.basePrice)}</span></div>
      <div><span class="info-label">ボラティリティ</span><span>${(stock.vol*100).toFixed(1)}%/年</span></div>
      ${holdInfo ? `<div><span class="info-label">保有中</span><span class="positive">${holdInfo.qty}株 (${holdDays != null ? holdDays+'日保有' : ''})</span></div>` : ''}
    </div>
  `;
  switchTab('buy');
  document.getElementById('qty').value = 1;
  document.getElementById('note').value = '';
  document.getElementById('predictPrice').value = '';
  document.querySelectorAll('#tagOptions .tag-btn').forEach(b => b.classList.remove('selected'));
  selectedTag = null;
  updateSummary();
  document.getElementById('modal').classList.add('show');
}

// 選択中の判断タグ(intuition/news/chart/diversify)
let selectedTag = null;
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('#tagOptions .tag-btn');
  if (!btn) return;
  const tag = btn.dataset.tag;
  if (selectedTag === tag) {
    selectedTag = null;
    btn.classList.remove('selected');
  } else {
    selectedTag = tag;
    document.querySelectorAll('#tagOptions .tag-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
  }
});

function updateModalPrice() {
  if (!currentModalStock) return;
  const price = state.prices[currentModalStock.ticker];
  const prevClose = state.prevClose[currentModalStock.ticker];
  document.getElementById('modalPrice').textContent = formatYen(price);
  const change = price - prevClose;
  const pct = prevClose ? (change / prevClose) * 100 : 0;
  const sign = change >= 0 ? '+' : '';
  const cls = change > 0 ? 'positive' : change < 0 ? 'negative' : 'zero';
  const changeEl = document.getElementById('modalChange');
  changeEl.textContent = `${sign}${formatYen(change)} (${sign}${pct.toFixed(2)}%) 前日比`;
  changeEl.className = `big-change ${cls}`;
}

window.closeModal = function() {
  document.getElementById('modal').classList.remove('show');
  currentModalStock = null;
};

window.switchTab = function(tab) {
  currentTab = tab;
  document.getElementById('tabBuy').classList.toggle('active', tab === 'buy');
  document.getElementById('tabSell').classList.toggle('active', tab === 'sell');
  document.getElementById('tabInfo').classList.toggle('active', tab === 'info');
  document.getElementById('tradeForm').style.display = tab === 'info' ? 'none' : '';
  document.getElementById('modalInfo').style.display = tab === 'info' ? '' : 'none';
  if (tab === 'info') {
    state.openedInfoTab = true;
    saveState();
    checkMissionUnlocks();
  }
  const btn = document.getElementById('actionBtn');
  const noteField = document.getElementById('noteField');
  const noteLabel = noteField.querySelector('label');
  const predictField = document.getElementById('predictField');
  if (tab === 'buy') {
    btn.textContent = '買う';
    btn.className = 'action-btn buy-btn';
    noteLabel.textContent = 'なぜ買う? — これが一番大事';
    document.getElementById('note').placeholder = '例: ゲームが好きだから。新作が出そう。';
    if (predictField) predictField.style.display = '';
  } else {
    btn.textContent = '売る';
    btn.className = 'action-btn sell-btn';
    noteLabel.textContent = 'なぜ売る?';
    document.getElementById('note').placeholder = '例: 上がったので利益確定。もっと下がりそう。';
    if (predictField) predictField.style.display = 'none';
  }
  renderQuickButtons();
  updateSummary();
};

function renderQuickButtons() {
  const container = document.getElementById('quickBtns');
  if (!currentModalStock) { container.innerHTML = ''; return; }
  const acc = getActiveAccount();
  const price = state.prices[currentModalStock.ticker];
  if (currentTab === 'buy') {
    const maxBuy = Math.floor(acc.cash / price);
    const options = [1, 5, 10].filter(n => n <= maxBuy);
    let html = options.map(n => `<button class="quick-btn" data-qty="${n}">${n}株</button>`).join('');
    if (maxBuy > 0) html += `<button class="quick-btn" data-qty="${maxBuy}">全力(${maxBuy}株)</button>`;
    container.innerHTML = html;
  } else {
    const owned = acc.holdings[currentModalStock.ticker];
    if (!owned) { container.innerHTML = ''; return; }
    const q = owned.qty;
    const options = [1, Math.floor(q/2), q].filter(n => n > 0);
    const unique = [...new Set(options)];
    container.innerHTML = unique.map(n => `<button class="quick-btn" data-qty="${n}">${n===q?'全部':n+'株'}</button>`).join('');
  }
  container.querySelectorAll('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('qty').value = btn.dataset.qty;
      updateSummary();
    });
  });
}

// 手数料計算: 約定代金の0.45%、最低500円
function calcCommission(amount) {
  return Math.max(500, Math.round(amount * 0.0045));
}
// 譲渡益税計算: 利益の20.315%
function calcTax(profit) {
  return profit > 0 ? Math.round(profit * 0.20315) : 0;
}

window.updateSummary = function() {
  if (!currentModalStock) return;
  const acc = getActiveAccount();
  const qty = parseInt(document.getElementById('qty').value) || 0;
  const price = state.prices[currentModalStock.ticker];
  const amount = qty * price;
  const commission = qty > 0 ? calcCommission(amount) : 0;
  const btn = document.getElementById('actionBtn');
  let html = `<div class="row"><span>株価</span><span>${formatYen(price)}</span></div>`;
  html += `<div class="row"><span>株数</span><span>${qty} 株</span></div>`;
  html += `<div class="row"><span>売買代金</span><span>${formatYen(amount)}</span></div>`;
  html += `<div class="row" style="color:var(--ink-dim);font-size:11px"><span>手数料(0.45%)</span><span>${formatYen(commission)}</span></div>`;
  if (currentTab === 'buy') {
    const totalCost = amount + commission;
    html += `<div class="row total"><span>合計必要額</span><span>${formatYen(totalCost)}</span></div>`;
    const afterCash = acc.cash - totalCost;
    html += `<div class="row" style="color: var(--ink-dim); font-size: 11px; margin-top: 6px;"><span>買った後の現金</span><span style="color:${afterCash < 0 ? 'var(--red)' : 'inherit'}">${formatYen(afterCash)}</span></div>`;
    btn.disabled = qty <= 0 || totalCost > acc.cash;
  } else {
    const owned = acc.holdings[currentModalStock.ticker];
    const ownedQty = owned ? owned.qty : 0;
    const profit = owned ? (price - owned.avgCost) * qty : 0;
    const tax = calcTax(profit);
    const netReceive = amount - commission - tax;
    if (tax > 0) html += `<div class="row" style="color:var(--ink-dim);font-size:11px"><span>譲渡益税(20.3%)</span><span>${formatYen(tax)}</span></div>`;
    html += `<div class="row total"><span>手取り</span><span>${formatYen(netReceive)}</span></div>`;
    html += `<div class="row" style="color: var(--ink-dim); font-size: 11px; margin-top: 6px;"><span>保有株数</span><span>${ownedQty} 株</span></div>`;
    btn.disabled = qty <= 0 || qty > ownedQty;
  }
  document.getElementById('summary').innerHTML = html;
};

window.executeTrade = function() {
  const acc = getActiveAccount();
  const qty = parseInt(document.getElementById('qty').value) || 0;
  const note = document.getElementById('note').value.trim();
  const predictRaw = parseFloat(document.getElementById('predictPrice').value);
  const predictPrice = isFinite(predictRaw) && predictRaw > 0 ? predictRaw : null;
  const decisionTag = selectedTag; // intuition | news | chart | diversify | null
  const stock = currentModalStock;
  const price = state.prices[stock.ticker];
  const total = qty * price;

  const commission = calcCommission(total);
  if (currentTab === 'buy') {
    const totalCost = total + commission;
    if (totalCost > acc.cash || qty <= 0) return;
    acc.cash -= totalCost;
    if (!acc.totalCommission) acc.totalCommission = 0;
    acc.totalCommission += commission;
    const existing = acc.holdings[stock.ticker];
    if (existing) {
      const newQty = existing.qty + qty;
      const newAvg = ((existing.avgCost * existing.qty) + (price * qty)) / newQty;
      acc.holdings[stock.ticker] = { qty: newQty, avgCost: newAvg, buyMinute: existing.buyMinute };
    } else {
      acc.holdings[stock.ticker] = { qty, avgCost: price, buyMinute: state.simMinute };
    }
    acc.journal.push({
      simMinute: state.simMinute, action: 'buy', ticker: stock.ticker, stockName: stock.name,
      qty, price, total, commission, note,
      macroSnapshot: state.macro ? { ...state.macro } : null,
      predictPrice,                                       // 1週間後の予想株価
      predictDueMinute: state.simMinute + 7 * 24 * 60,    // 7日後の判定時刻
      decisionTag,                                        // 判断分類
    });
    showToast(`${stock.name}を${qty}株 買った (手数料 ${formatYen(commission)})`);
  } else {
    const existing = acc.holdings[stock.ticker];
    if (!existing || qty > existing.qty) return;
    const profit = (price - existing.avgCost) * qty;
    const tax = calcTax(profit);
    const netReceive = total - commission - tax;
    acc.cash += netReceive;
    if (!acc.totalCommission) acc.totalCommission = 0;
    if (!acc.totalTax) acc.totalTax = 0;
    acc.totalCommission += commission;
    acc.totalTax += tax;
    if (existing.qty === qty) {
      delete acc.holdings[stock.ticker];
    } else {
      acc.holdings[stock.ticker] = { qty: existing.qty - qty, avgCost: existing.avgCost, buyMinute: existing.buyMinute };
    }
    const taxMsg = tax > 0 ? ` 税${formatYen(tax)}` : '';
    acc.journal.push({
      simMinute: state.simMinute, action: 'sell', ticker: stock.ticker, stockName: stock.name,
      qty, price, total, commission, tax, profit, note,
      macroSnapshot: state.macro ? { ...state.macro } : null,
      decisionTag,
    });
    showToast(`${stock.name}を${qty}株 売った (手取り ${formatYen(netReceive)}${taxMsg})`);
  }
  saveState();
  checkMissionUnlocks();
  closeModal();
  render();
};

function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => t.classList.remove('show'), 2800);
}

window.dismissOnboarding = function() {
  state.onboardingSeen = true;
  saveState();
  document.getElementById('onboarding').style.display = 'none';
};

// デバッグ用: コンソールから呼べる
window.resetAll = function() {
  if (confirm('全データをリセットする?')) {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  }
};

// ============ チュートリアル ============
const TUTORIAL_STEPS = [
  {
    title: '📈 カブラボとは？',
    body: `<p><strong style="color:var(--yellow)">100万円の仮想マネー</strong>で、実際の株価水準をもとにしたトレード体験ができるシミュレータです。</p>
<p>リアルなお金は一切減りません。だから思い切って試せます。</p>
<p>目標は<strong>「なぜ買ったか？」を記録する習慣</strong>をつけること。あとで見返すと自分の思考の癖がわかります。</p>`,
  },
  {
    title: '⏩ 時間を進めよう',
    body: `<p>右上の速度ボタンで時間を早送りできます。</p>
<table class="tut-table">
  <tr><td>⏸</td><td>停止</td></tr>
  <tr><td>1x</td><td>実時間（6秒で1分進む）</td></tr>
  <tr><td>5x</td><td>5倍速</td></tr>
  <tr><td>20x</td><td>20倍速（1分で約2日分）</td></tr>
</table>
<p style="margin-top:12px">⚠️ <strong>市場が動くのはシム内9:00〜15:00のみ。</strong><br>それ以外は翌日9:00へ自動スキップされます。</p>`,
  },
  {
    title: '🛒 株の買い方',
    body: `<ol class="tut-list">
  <li>下の銘柄一覧から気になる株のカードをタップ</li>
  <li>株数を入力（クイックボタンも使える）</li>
  <li><strong style="color:var(--yellow)">「なぜ買う？」を必ず書こう</strong> ← これが一番大事！</li>
  <li>「買う」ボタンを押して購入完了</li>
</ol>
<p style="margin-top:12px; color:var(--ink-dim); font-size:13px">
  ⚠️ 株を買うと<strong>手数料（売買金額の0.45%）</strong>がかかります。<br>
  売るときは利益に<strong>税金（約20%）</strong>もかかります。現実でもこれが引かれます。
</p>`,
  },
  {
    title: '💰 資産と損益の確認',
    body: `<ul class="tut-list">
  <li>ページ上部の<strong>「資産合計」</strong>でリアルタイム確認</li>
  <li><strong>「保有銘柄」テーブル</strong>で各株の含み損益・保有日数を確認</li>
  <li><span style="color:var(--green)">緑 = 含み益（プラス）</span> / <span style="color:var(--red)">赤 = 含み損（マイナス）</span></li>
  <li>右側のスパークライン（折れ線）で短期の値動きが見られる</li>
</ul>`,
  },
  {
    title: '📤 株の売り方 & 日記',
    body: `<ol class="tut-list">
  <li>保有している銘柄のカードをタップ</li>
  <li>モーダルで <strong>「売る」タブ</strong> に切り替え</li>
  <li>売りたい株数を入力して「なぜ売る？」を記録</li>
  <li>「売る」ボタンで売却完了</li>
</ol>
<p style="margin-top:12px">売買の記録は<strong>「トレード日記」</strong>に残ります。振り返ることで自分の投資スタイルが見えてきます。</p>`,
  },
  {
    title: '🕯 チャートの種類① ローソク足',
    body: `<p>銘柄カードをタップすると詳細チャートが見られます。</p>
<p><strong>使い方（先にこれだけ覚える）</strong></p>
<ol class="tut-list">
  <li>上段の<strong>時間軸ボタン</strong>で「15分足 / 1時間足 / 4時間足 / 日足」を選ぶ</li>
  <li>下段の<strong>チャート種類タブ</strong>で見たい分析を選ぶ</li>
  <li>迷ったら「ローソク+MA」から始める（値動きとトレンドを同時に見られる）</li>
</ol>
<p style="margin-top:8px;color:var(--ink-dim);font-size:12px">時間軸を長くするほど「細かいノイズ」が減り、大きな流れが見えやすくなります。</p>
<p><strong>ローソク足</strong>は1本の棒で4つの情報をまとめたものです：</p>
<table class="tut-table">
  <tr><td>始値</td><td>その時間帯が始まったときの株価</td></tr>
  <tr><td>終値</td><td>その時間帯が終わったときの株価</td></tr>
  <tr><td>高値</td><td>その時間帯の最高値</td></tr>
  <tr><td>安値</td><td>その時間帯の最安値</td></tr>
</table>
<p style="margin-top:10px">
  <span style="color:var(--green)">■ 緑(陽線)</span> = 終値 &gt; 始値（値上がり）<br>
  <span style="color:var(--red)">■ 赤(陰線)</span> = 終値 &lt; 始値（値下がり）<br>
  棒からはみ出た細い線を<strong>「ひげ」</strong>と呼び、その期間の高値・安値を示します。
</p>`,
  },
  {
    title: '〰 チャートの種類② ローソク+移動平均（統合）',
    body: `<p><strong>ローソク+MA</strong>は、ローソク足の上に移動平均線を重ねた統合チャートです。</p>
<p>「いまの値動き（ローソク）」と「全体の流れ（MA）」を1画面で同時に判断できます。</p>
<table class="tut-table">
  <tr><td style="color:#f9c74f">■ 黄色(SMA5)</td><td>直近5本の平均。価格の近くを動く</td></tr>
  <tr><td style="color:#4ecdc4">■ 青(SMA20)</td><td>直近20本の平均。中期的な流れを示す</td></tr>
</table>
<p style="margin-top:10px">読み方のポイント：</p>
<ul class="tut-list">
  <li>価格が移動平均線より<strong style="color:var(--green)">上</strong> → 上昇トレンドの可能性</li>
  <li>価格が移動平均線より<strong style="color:var(--red)">下</strong> → 下降トレンドの可能性</li>
  <li>短期線が長期線を<strong>上に突き抜けたら買いサイン(ゴールデンクロス)</strong></li>
  <li>短期線が長期線を<strong>下に突き抜けたら売りサイン(デッドクロス)</strong></li>
</ul>`,
  },
  {
    title: '📊 チャートの種類③ ボリンジャーバンド',
    body: `<p><strong>ボリンジャーバンド</strong>は移動平均線の上下に「どれだけ株価が散らばっているか(σ=シグマ)」を示す帯を描いたものです。</p>
<p>統計的に、約95%の確率で株価はこのバンドの内側に収まります。</p>
<ul class="tut-list">
  <li>株価がバンドの<strong style="color:var(--green)">上限に近い</strong> → 「買われ過ぎかも？」と疑うサイン</li>
  <li>株価がバンドの<strong style="color:var(--red)">下限に近い</strong> → 「売られ過ぎかも？」と疑うサイン</li>
  <li>バンドが<strong>広がる</strong> → 値動きが大きくなっている（ボラティリティ上昇）</li>
  <li>バンドが<strong>狭くなる</strong> → 値動きが小さくなっている（次の大きな動きの前兆?）</li>
</ul>`,
  },
  {
    title: '💡 チャートの種類④ RSI',
    body: `<p><strong>RSI（相対力指数）</strong>は0〜100の数字で「今の株価は買われ過ぎ？売られ過ぎ？」を示す指標です。</p>
<table class="tut-table">
  <tr><td style="color:var(--red)">70以上</td><td>買われ過ぎゾーン。値下がりに注意</td></tr>
  <tr><td>50前後</td><td>中立。どちらでもない状態</td></tr>
  <tr><td style="color:var(--green)">30以下</td><td>売られ過ぎゾーン。値上がりに注意</td></tr>
</table>
<p style="margin-top:10px; font-size:12px; color:var(--ink-dim)">
  ⚠️ 注意: RSIだけを見て売買するのは危険！強いトレンドのときは70超え・30割れが長く続くこともあります。他のチャートも合わせて確認しましょう。
</p>`,
  },
  {
    title: '📦 チャートの種類⑤ 出来高',
    body: `<p><strong>出来高（ボリューム）</strong>は「どれだけ多く取引が行われたか」を棒グラフで示したものです。</p>
<ul class="tut-list">
  <li>株価が大きく動くとき、<strong>出来高も一緒に増えることが多い</strong></li>
  <li>価格が上がっていても出来高が少ないなら、<strong>上昇の信頼性が低い</strong>かもしれない</li>
  <li>逆に価格の動きに出来高が伴っているなら、<strong>トレンドが強い</strong>サイン</li>
</ul>
<p style="margin-top:10px">チャートの上部に価格の動き、下部に出来高の棒グラフが表示されます。<br>
<span style="color:var(--green)">緑</span> = 値上がりした期間、<span style="color:var(--red)">赤</span> = 値下がりした期間の出来高です。</p>`,
  },
  {
    title: '🌐 経済指標(マクロ環境)を読もう',
    body: `<p>資産合計の下にある「<strong>🌐 経済指標</strong>」パネルを見てみよう。</p>
<p>株価は会社の業績だけでなく、<strong>世の中全体の経済の状況</strong>でも動きます。表示されているのは3つの指標です:</p>
<table class="tut-table">
  <tr><td>📈 金利</td><td>銀行株は金利上昇で買われやすい / 借金が多い企業は逆風</td></tr>
  <tr><td>💴 為替</td><td>円安は車・ゲームなどの輸出企業に追い風 / 輸入企業は逆風</td></tr>
  <tr><td>🏭 景気</td><td>好景気は銀行・レジャー株に追い風 / 不景気では食品・通信などディフェンシブ株が買われやすい</td></tr>
</table>
<p style="margin-top:10px">指標は時間とともに変化し、ニュースで大きく動くこともあります。<strong>銘柄ごとの「マクロ感応度」</strong>(情報タブで見られる)と組み合わせて読むと、なぜ株が動いたかが見えてきます。</p>`,
  },
  {
    title: '📖 銘柄解説で「会社」を知ろう',
    body: `<p>銘柄カードをタップして「<strong>ℹ 情報</strong>」タブを開いてみよう。</p>
<ul class="tut-list">
  <li><strong>📌 何で稼いでいるか</strong> — 会社のビジネスを一行で</li>
  <li><strong>📖 もっと詳しく</strong> — 中学生向けの会社解説</li>
  <li><strong>📊 株価が動く要因</strong> — どんなニュースで株価が動きやすいか</li>
  <li><strong>🌐 マクロ環境への感応度</strong> — 金利・為替・景気のどれに敏感かをグラフで</li>
</ul>
<p style="margin-top:10px">「<strong>なぜこの会社は儲かる(儲からない)のか?</strong>」を理解してから買うと、値動きの理由が分かるようになります。</p>`,
  },
  {
    title: '📂 複数ポートフォリオで戦略を比較',
    body: `<p>資産パネルにある「<strong>⚙ 複数ポートフォリオを開始</strong>」を押すと、2つの口座を並走できます。</p>
<table class="tut-table">
  <tr><td style="color:var(--red)">積極運用</td><td>50万円。値動きの大きい銘柄に挑戦してみる用</td></tr>
  <tr><td style="color:#4ecdc4">守り重視</td><td>50万円。ディフェンシブ銘柄や分散運用で守る用</td></tr>
</table>
<p style="margin-top:10px">同じ期間・同じ市場環境で、<strong>どちらの戦略が結果的に良かったか</strong>を比較できます。資産推移グラフは%基準で重ね描きされます。</p>
<p style="margin-top:10px;color:var(--ink-dim);font-size:12px">⚠️ メイン口座とは別の世界線です。元に戻すこともできます(データは保持)。</p>`,
  },
  {
    title: '🎯 予想 → 検証 のサイクル',
    body: `<p>このアプリで一番<strong>身につけてほしい力</strong>は「<strong>予想 → 行動 → 答え合わせ</strong>」のサイクルです。</p>
<ol class="tut-list">
  <li>買うときに「<strong>1週間後の予想株価</strong>」を入力する(任意)</li>
  <li>シム内で7日経つと、保有銘柄の下に「📌 予想の答え合わせ」カードが出る</li>
  <li>予想・実際・誤差・買った理由を一緒に見て、自分の考え方のクセを確認</li>
</ol>
<p style="margin-top:10px"><strong>当たり外れより「なぜそう予想したか」が大事。</strong>外れた回数が多いほど、自分の判断のクセが見えてきて、次に活かせます。</p>`,
  },
  {
    title: '🏷 判断タグで自分の傾向を知る',
    body: `<p>買うときに、その判断のもとになったものを選んでみよう(任意):</p>
<table class="tut-table">
  <tr><td>💭 直感</td><td>なんとなく、好きだから</td></tr>
  <tr><td>📰 ニュース</td><td>ニュースイベントを見て決めた</td></tr>
  <tr><td>📈 チャート</td><td>ローソク足やRSI等の指標で判断</td></tr>
  <tr><td>⚖ 分散</td><td>ポートフォリオのバランス調整目的</td></tr>
</table>
<p style="margin-top:10px">週次振り返りに「<strong>🏷 判断タグ別の傾向</strong>」が表示されます。「直感の勝率は低くて、チャート判断は高い」みたいな自分の傾向が分かります。</p>
<p style="margin-top:8px;color:var(--ink-dim);font-size:12px">プロの投資家も同じことをしています(=投資日誌)。これが続けられるとレベルが一段上がります。</p>`,
  },
  {
    title: '📚 学習シナリオで歴史的局面を体験',
    body: `<p>右上の「<strong>📚 シナリオ</strong>」ボタンから、過去に実際に起きた市場の局面を再現したシナリオに挑戦できます。</p>
<table class="tut-table">
  <tr><td>🏦</td><td><strong>2008 リーマン・ショック風</strong> — 金融危機。銀行株急落、ディフェンシブが効く局面</td></tr>
  <tr><td>🦠</td><td><strong>2020 コロナ・ショック風</strong> — 急落から急回復。業種ごとに勝ち負けが分かれる</td></tr>
  <tr><td>📈</td><td><strong>インフレ・利上げ局面</strong> — 銀行追い風、輸入企業逆風、円安</td></tr>
</table>
<p style="margin-top:10px">シナリオは新規100万円・21日間で進行します(フリープレイは退避され、終了時に戻ります)。完了すると「振り返り」が表示され、何を学べたかを確認できます。</p>
<p style="margin-top:8px;color:var(--ink-dim);font-size:12px">同じ局面を何度もやり直せるので、戦略を変えて結果を比較してみよう。</p>`,
  },
  {
    title: '🏆 ミッションに挑戦しよう',
    body: `<p>右上の<strong>「🏆 ミッション」</strong>ボタンで達成目標の一覧が見られます。</p>
<p>チュートリアルで学んだことを実際に試して、ミッションを達成しよう！</p>
<ul class="tut-list">
  <li>📌 まず「はじめての買い」から挑戦</li>
  <li>📌 「なぜ買う？」を入力してから購入してみよう</li>
  <li>📌 3銘柄以上に分散してみよう</li>
  <li>📌 銘柄の「ℹ 情報」タブで会社解説を読もう</li>
  <li>📌 1週間後の予想株価を入力して、答え合わせカードを確認しよう</li>
</ul>
<p style="margin-top:12px; color:var(--ink-dim); font-size:12px">保護者の方: 「📋 保護者レポート」ボタンで子どものトレード記録・理由・達成ミッションを一覧できます。</p>`,
  },
];

let tutStep = 0;

window.openTutorial = function(step = 0) {
  tutStep = step;
  renderTutorial();
  document.getElementById('tutorialModal').classList.add('show');
};

window.closeTutorial = function() {
  document.getElementById('tutorialModal').classList.remove('show');
};

window.tutorialStep = function(delta) {
  tutStep = Math.max(0, Math.min(TUTORIAL_STEPS.length - 1, tutStep + delta));
  renderTutorial();
};

function renderTutorial() {
  const step = TUTORIAL_STEPS[tutStep];
  document.getElementById('tutContent').innerHTML = `
    <h2 class="tut-title">${step.title}</h2>
    <div class="tut-body">${step.body}</div>
  `;
  document.getElementById('tutPrev').disabled = tutStep === 0;
  document.getElementById('tutNext').textContent = tutStep === TUTORIAL_STEPS.length - 1 ? '✓ 閉じる' : '次へ →';
  const dots = document.getElementById('tutDots');
  dots.innerHTML = TUTORIAL_STEPS.map((_, i) =>
    `<span class="tut-dot${i === tutStep ? ' active' : ''}"></span>`
  ).join('');
  if (tutStep === TUTORIAL_STEPS.length - 1) {
    document.getElementById('tutNext').onclick = closeTutorial;
  } else {
    document.getElementById('tutNext').onclick = () => tutorialStep(1);
  }
}

// ============ 保護者向けレポート（Phase 2） ============
window.openParentReport = function() {
  const acc = getActiveAccount();
  const total = acc.cash + getStockValueOf(acc);
  const delta = total - acc.initialCapital;
  const deltaSign = delta >= 0 ? '▲' : '▼';
  const deltaColor = delta >= 0 ? 'var(--green)' : 'var(--red)';
  const currentDay = Math.floor(state.simMinute / (24 * 60));

  // 直近7日のトレード
  const recentTrades = acc.journal.filter(e => {
    const tradeDay = Math.floor(e.simMinute / (24 * 60));
    return currentDay - tradeDay <= 7;
  });

  // 保有中の銘柄
  const holdingRows = Object.entries(acc.holdings).map(([ticker, h]) => {
    const cur = state.prices[ticker];
    const pnl = (cur - h.avgCost) * h.qty;
    const holdDays = h.buyMinute != null ? Math.max(0, currentDay - Math.floor(h.buyMinute / (24*60))) : '—';
    const name = STOCKS.find(s => s.ticker === ticker)?.name || ticker;
    const sign = pnl >= 0 ? '+' : '';
    const color = pnl >= 0 ? 'var(--green)' : 'var(--red)';
    return `<tr>
      <td>${name}</td><td>${h.qty}株 / ${holdDays}日保有</td>
      <td style="color:${color}">${sign}${formatYen(pnl)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="3" style="color:var(--ink-dim)">保有なし</td></tr>';

  // ミッション達成
  const doneMissions = getMissionStatus().filter(m => m.done);
  const missionText = doneMissions.length > 0
    ? doneMissions.map(m => `✅ ${m.title}`).join('　')
    : 'まだ達成なし';

  // 直近トレード
  const tradeRows = recentTrades.length > 0
    ? recentTrades.reverse().map(e => {
        const act = e.action === 'buy' ? '買い' : '売り';
        return `<tr>
          <td>${formatSimTime(e.simMinute)}</td>
          <td>${e.stockName} ${act} ${e.qty}株</td>
          <td style="font-size:11px;color:var(--ink-dim)">${escapeHtml(e.note || '理由の記録なし')}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="3" style="color:var(--ink-dim)">直近7日間のトレードなし</td></tr>';

  const commissionTotal = acc.totalCommission || 0;
  const taxTotal = acc.totalTax || 0;
  const accLabel = state.multiMode ? `(${state.activeAccount === 'aggressive' ? '積極運用' : '守り重視'}口座)` : '';

  document.getElementById('parentReportContent').innerHTML = `
    <h2 class="tut-title">📋 保護者向けレポート ${accLabel}</h2>
    <div class="report-date">シム経過: ${formatSimTime(state.simMinute)} (${currentDay}日目)</div>

    <div class="report-section">
      <div class="report-label">💰 資産状況</div>
      <table class="report-table">
        <tr><td>初期資金</td><td>${formatYen(acc.initialCapital)}</td></tr>
        <tr><td>現在の総資産</td><td><strong>${formatYen(total)}</strong></td></tr>
        <tr><td>損益</td><td style="color:${deltaColor}">${deltaSign} ${formatYen(Math.abs(delta))} (${(delta/acc.initialCapital*100).toFixed(2)}%)</td></tr>
        <tr><td>支払い手数料累計</td><td style="color:var(--ink-dim)">${formatYen(commissionTotal)}</td></tr>
        <tr><td>支払い税金累計</td><td style="color:var(--ink-dim)">${formatYen(taxTotal)}</td></tr>
      </table>
    </div>

    <div class="report-section">
      <div class="report-label">📦 保有銘柄</div>
      <table class="report-table"><thead><tr><th>銘柄</th><th>保有</th><th>損益</th></tr></thead><tbody>${holdingRows}</tbody></table>
    </div>

    <div class="report-section">
      <div class="report-label">📝 直近7日間のトレード + 理由</div>
      <table class="report-table"><thead><tr><th>時刻</th><th>取引</th><th>理由</th></tr></thead><tbody>${tradeRows}</tbody></table>
    </div>

    <div class="report-section">
      <div class="report-label">🏷 判断タグ別の傾向</div>
      ${buildDecisionTagStats(acc)}
    </div>

    <div class="report-section">
      <div class="report-label">🏆 達成済みミッション (${doneMissions.length}/${MISSIONS.length})</div>
      <div style="font-size:13px;line-height:2">${missionText}</div>
    </div>

    <div class="report-section" style="color:var(--ink-dim);font-size:11px;border-top:1px dashed var(--border);padding-top:10px;margin-top:10px">
      ※このシミュレーターは仮想資金を使った学習ツールです。実際の株取引とは異なります。<br>
      保護者の方: 「なぜこの株を買ったの?」と一緒に会話してみてください。
    </div>
  `;
  document.getElementById('parentReportModal').classList.add('show');
};

window.closeParentReport = function() {
  document.getElementById('parentReportModal').classList.remove('show');
};

window.printParentReport = function() {
  window.print();
};

// ============ ミッション（Phase 2 / 拡張: Phase 3） ============
// check は state を受け取り、いずれかの口座で達成すれば true。
function eachAccount(s, fn) {
  const list = [];
  if (s.multiMode && s.accounts) {
    list.push(s.accounts.aggressive, s.accounts.defensive);
  } else {
    list.push(s);
  }
  return list.some(fn);
}

const MISSIONS = [
  { id: 'm01', title: 'はじめての買い',    desc: '株を1株以上買ってみよう',              check: (s) => eachAccount(s, a => a.journal.some(e => e.action === 'buy')) },
  { id: 'm02', title: '理由を書こう',      desc: '「なぜ買うか」を入力して購入しよう',    check: (s) => eachAccount(s, a => a.journal.some(e => e.action === 'buy' && e.note && e.note.length >= 5)) },
  { id: 'm03', title: 'はじめての売り',    desc: '保有株を1株以上売ってみよう',          check: (s) => eachAccount(s, a => a.journal.some(e => e.action === 'sell')) },
  { id: 'm04', title: '3銘柄に分散',       desc: '3種類以上の銘柄を同時に保有しよう',    check: (s) => eachAccount(s, a => Object.keys(a.holdings).length >= 3) },
  { id: 'm05', title: '5銘柄に分散',       desc: '5種類以上の銘柄を同時に保有しよう',    check: (s) => eachAccount(s, a => Object.keys(a.holdings).length >= 5) },
  { id: 'm06', title: 'プラス転換！',       desc: '総資産が初期資金を上回ろう',           check: (s) => eachAccount(s, a => (a.cash + Object.entries(a.holdings).reduce((acc,[t,h]) => acc + (s.prices[t]||0)*h.qty, 0)) > a.initialCapital) },
  { id: 'm07', title: '10回トレード',       desc: 'トレードを合計10回以上しよう',         check: (s) => eachAccount(s, a => a.journal.length >= 10) },
  { id: 'm08', title: 'ニュースを活かせ',   desc: 'ニュースイベントが5回以上発生するまで運用しよう', check: (s) => (s.firedNewsIds||[]).length >= 5 },
  { id: 'm09', title: '1週間続けた',       desc: 'シム内7日間以上運用しよう',            check: (s) => Math.floor(s.simMinute / (24*60)) >= 7 },
  { id: 'm10', title: '長期投資家',         desc: 'シム内30日間以上運用しよう',           check: (s) => Math.floor(s.simMinute / (24*60)) >= 30 },
  // Phase 3 追加ミッション
  { id: 'm11', title: '銘柄解説を読んだ',   desc: '銘柄の「ℹ 情報」タブを開いてみよう',  check: (s) => s.openedInfoTab === true },
  { id: 'm12', title: 'マクロを意識',       desc: 'マクロ環境(金利/為替/景気)が大きく振れる場面で取引しよう', check: (s) => eachAccount(s, a => a.journal.some(e => e.macroSnapshot && (Math.abs(e.macroSnapshot.rate) > 0.4 || Math.abs(e.macroSnapshot.fx) > 0.4 || Math.abs(e.macroSnapshot.cycle) > 0.4))) },
  { id: 'm13', title: '2口座で並走',       desc: '複数ポートフォリオモードで両方の口座で売買しよう', check: (s) => s.multiMode && s.accounts && (s.accounts.aggressive.journal.length > 0) && (s.accounts.defensive.journal.length > 0) },
  // L1強化: 自己観察フック
  { id: 'm14', title: '予想を立ててみた',   desc: '買うときに「1週間後の予想株価」を入力しよう', check: (s) => eachAccount(s, a => a.journal.some(e => e.action === 'buy' && e.predictPrice != null)) },
  { id: 'm15', title: '答え合わせ',         desc: '予想と実際の答え合わせカードを確認しよう', check: (s) => eachAccount(s, a => a.journal.some(e => e.action === 'buy' && e.predictAcknowledged)) },
  { id: 'm16', title: '判断タグを使った',   desc: '買うときに「直感/ニュース/チャート/分散」のタグを選ぼう', check: (s) => eachAccount(s, a => a.journal.some(e => e.action === 'buy' && e.decisionTag)) },
  // Phase A: シナリオモード
  { id: 'm17', title: 'シナリオに挑戦',     desc: '学習シナリオを1つ完走しよう', check: (s) => (s.completedScenarios || []).length >= 1 },
  { id: 'm18', title: 'シナリオで利益',     desc: 'シナリオを利益+で完走しよう', check: (s) => (s.completedScenarios || []).some(r => r.delta > 0) },
  { id: 'm19', title: '3シナリオ制覇',     desc: '3つのシナリオすべてを完走しよう', check: (s) => new Set((s.completedScenarios || []).map(r => r.id)).size >= 3 },
];

function getMissionStatus() {
  return MISSIONS.map(m => ({ ...m, done: m.check(state) }));
}

window.openMissions = function() {
  const missions = getMissionStatus();
  const done = missions.filter(m => m.done).length;
  const rows = missions.map(m => `
    <div class="mission-row ${m.done ? 'mission-done' : ''}">
      <span class="mission-icon">${m.done ? '✅' : '⬜'}</span>
      <div class="mission-info">
        <div class="mission-title">${m.title}</div>
        <div class="mission-desc">${m.desc}</div>
      </div>
    </div>
  `).join('');
  document.getElementById('missionContent').innerHTML = `
    <h2 class="tut-title">🏆 ミッション</h2>
    <div class="mission-progress">
      <div class="mission-bar-track"><div class="mission-bar-fill" style="width:${Math.round(done/missions.length*100)}%"></div></div>
      <span>${done} / ${missions.length} 達成</span>
    </div>
    ${rows}
  `;
  document.getElementById('missionModal').classList.add('show');
};

window.closeMissions = function() {
  document.getElementById('missionModal').classList.remove('show');
};

// ミッション達成トースト
function checkMissionUnlocks() {
  if (!state.unlockedMissions) state.unlockedMissions = [];
  MISSIONS.forEach(m => {
    if (!state.unlockedMissions.includes(m.id) && m.check(state)) {
      state.unlockedMissions.push(m.id);
      showToast(`🏆 ミッション達成: ${m.title}`, false);
    }
  });
}

// ============ 日記エクスポート（Phase 2） ============
window.exportJournal = function() {
  const acc = getActiveAccount();
  const total = acc.cash + getStockValueOf(acc);
  const delta = total - acc.initialCapital;
  const sign = delta >= 0 ? '+' : '';
  const accLabel = state.multiMode ? `(${state.activeAccount === 'aggressive' ? '積極運用' : '守り重視'}口座)` : '';
  const lines = [
    `カブラボ トレード日記 ${accLabel}`,
    `エクスポート日時: ${new Date().toLocaleString('ja-JP')}`,
    `シム経過: ${formatSimTime(state.simMinute)}`,
    `初期資金: ¥${acc.initialCapital.toLocaleString('ja-JP')}`,
    `現在資産: ¥${Math.round(total).toLocaleString('ja-JP')} (${sign}¥${Math.round(Math.abs(delta)).toLocaleString('ja-JP')})`,
    ``,
    `===== トレード履歴 =====`,
  ];
  acc.journal.forEach((e, i) => {
    const act = e.action === 'buy' ? '買い' : '売り';
    lines.push(`[${i+1}] ${formatSimTime(e.simMinute)} - ${e.stockName}(${e.ticker}) ${act} ${e.qty}株 @ ¥${Math.round(e.price).toLocaleString('ja-JP')} (合計¥${Math.round(e.total).toLocaleString('ja-JP')})`);
    lines.push(`    理由: ${e.note || '(記録なし)'}`);
    if (e.macroSnapshot) {
      const m = e.macroSnapshot;
      lines.push(`    そのときのマクロ環境: 金利${m.rate.toFixed(2)} / 為替${m.fx.toFixed(2)} / 景気${m.cycle.toFixed(2)}`);
    }
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'kabu-lab-journal.txt'; a.click();
  URL.revokeObjectURL(url);
};

// ============ ブート ============
if (state.onboardingSeen) {
  document.getElementById('onboarding').style.display = 'none';
}
skipToNextMarketOpen();
initPrices();
render();
startSimLoop();

document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});
document.getElementById('tutorialModal').addEventListener('click', (e) => {
  if (e.target.id === 'tutorialModal') closeTutorial();
});
document.getElementById('reviewModal').addEventListener('click', (e) => {
  if (e.target.id === 'reviewModal') closeReview();
});
document.getElementById('missionModal').addEventListener('click', (e) => {
  if (e.target.id === 'missionModal') closeMissions();
});
document.getElementById('parentReportModal').addEventListener('click', (e) => {
  if (e.target.id === 'parentReportModal') closeParentReport();
});
document.getElementById('scenarioModal').addEventListener('click', (e) => {
  if (e.target.id === 'scenarioModal') closeScenarioPicker();
});
document.getElementById('scenarioResultModal').addEventListener('click', (e) => {
  if (e.target.id === 'scenarioResultModal') closeScenarioResult();
});
