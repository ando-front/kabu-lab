import { STOCKS } from './stocks.js';
import { tickPrice, isMarketOpen, formatSimTime, advanceTime, checkNewsEvent, NEWS_EVENTS } from './simulator.js';

// ============ 状態 ============
const STORAGE_KEY = 'kabu_state_v2';

function defaultState() {
  return {
    cash: 1000000,
    initialCapital: 1000000,
    holdings: {},
    journal: [],
    onboardingSeen: false,
    prices: {},
    prevClose: {},
    simMinute: 9 * 60, // Day 1 · 09:00 から開始
    newsLog: [],       // 発生したニュース履歴
    firedNewsIds: [],  // 再発防止用
    portfolioHistory: [], // 資産推移 [{t, value}]
    lastReviewDay: 0,  // 最後に振り返りを表示した日
    totalCommission: 0, // 支払い手数料累計
    totalTax: 0,        // 支払い税金累計
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
    if (s) return { ...defaultState(), ...JSON.parse(s) };
  } catch (e) {}
  return defaultState();
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {}
}

let state = loadState();
let priceHistory = {};
let currentModalStock = null;
let currentTab = 'buy';
let simSpeed = 1;
let simTickTimer = null;
let lastPrices = {};
let lastTotalValue = null;
let activeNewsEvent = null; // 表示中のニュース

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
  if (isMarketOpen(state.simMinute)) {
    STOCKS.forEach(stock => {
      lastPrices[stock.ticker] = state.prices[stock.ticker];
      state.prices[stock.ticker] = tickPrice(state.prices[stock.ticker], stock);
      if (!priceHistory[stock.ticker]) priceHistory[stock.ticker] = [];
      priceHistory[stock.ticker].push({ t: state.simMinute, price: state.prices[stock.ticker] });
      if (priceHistory[stock.ticker].length > 150) priceHistory[stock.ticker].shift();
    });
  }

  // ニュースイベント判定
  if (!state.firedNewsIds) state.firedNewsIds = [];
  if (!state.newsLog) state.newsLog = [];
  const newsEvt = checkNewsEvent(state.simMinute, state.firedNewsIds);
  if (newsEvt) {
    applyNewsEvent(newsEvt);
  }

  const nextMinute = advanceTime(state.simMinute);
  // 日またぎの判定(15:00到達時に前日終値更新)
  const currentDayMin = state.simMinute % (24 * 60);
  const nextDayMin = nextMinute % (24 * 60);
  if (currentDayMin === 15 * 60 - 1 || nextDayMin === 9 * 60) {
    STOCKS.forEach(stock => { state.prevClose[stock.ticker] = state.prices[stock.ticker]; });
  }
  state.simMinute = nextMinute;

  // 資産推移を記録（10分ごと）
  if (state.simMinute % 10 === 0) {
    if (!state.portfolioHistory) state.portfolioHistory = [];
    const totalVal = state.cash + getTotalStockValue();
    state.portfolioHistory.push({ t: state.simMinute, value: totalVal });
    if (state.portfolioHistory.length > 500) state.portfolioHistory.shift();
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

// ① 銘柄詳細チャート（モーダル内・大きめ・売買マーカー付き）
function buildDetailChart(ticker) {
  const history = priceHistory[ticker];
  if (!history || history.length < 2) return '<div class="pg-empty">データ蓄積中...</div>';
  const prices = history.map(h => h.price);
  const times  = history.map(h => h.t);
  const min = Math.min(...prices) * 0.997;
  const max = Math.max(...prices) * 1.003;
  const range = max - min || 1;
  const W = 600, H = 100;
  const toX = (i) => (i / (history.length - 1)) * W;
  const toY = (v) => H - ((v - min) / range) * H;
  const pts  = history.map((h, i) => `${toX(i).toFixed(1)},${toY(h.price).toFixed(1)}`).join(' ');
  const isUp = prices[prices.length - 1] >= prices[0];
  const color = isUp ? 'var(--green)' : 'var(--red)';
  // 売買マーカー
  const trades = state.journal.filter(e => e.ticker === ticker);
  const markers = trades.map(e => {
    // 一番近いhistoryインデックスを探す
    let closest = 0, bestDiff = Infinity;
    history.forEach((h, i) => { const d = Math.abs(h.t - e.simMinute); if (d < bestDiff) { bestDiff = d; closest = i; } });
    const cx = toX(closest).toFixed(1);
    const cy = toY(history[closest].price).toFixed(1);
    const fill = e.action === 'buy' ? 'var(--green)' : 'var(--red)';
    return `<circle cx="${cx}" cy="${cy}" r="5" fill="${fill}" opacity="0.9"/>
      <text x="${cx}" y="${(parseFloat(cy) - 8).toFixed(1)}" text-anchor="middle" fill="${fill}" font-size="9" font-family="sans-serif">${e.action === 'buy' ? '買' : '売'}</text>`;
  }).join('');
  return `<svg class="detail-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${markers}
  </svg>`;
}

// ② 保有銘柄別損益バーチャート（水平）
function buildPnlBarChart() {
  const tickers = Object.keys(state.holdings);
  if (tickers.length === 0) return '';
  const items = tickers.map(t => {
    const h = state.holdings[t];
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
  const tickers = Object.keys(state.holdings);
  const totalStock = getTotalStockValue();
  const total = state.cash + totalStock;
  if (total <= 0) return '';
  // セグメント定義
  const COLORS = ['#7bd88f','#f9c74f','#ff6b6b','#4ecdc4','#a29bfe','#fd79a8','#fdcb6e','#6c5ce7','#00b894','#e17055','#74b9ff','#55efc4'];
  const segments = [{ label: '現金', value: state.cash, color: '#5a7a65' }];
  tickers.forEach((t, i) => {
    const val = state.prices[t] * state.holdings[t].qty;
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
  const hist = state.portfolioHistory || [];
  if (hist.length < 2) return '<div class="pg-empty">まだデータが少ない。しばらく運用すると資産推移グラフが表示されます。</div>';
  const values = hist.map(h => h.value);
  const min = Math.min(...values, state.initialCapital) * 0.998;
  const max = Math.max(...values, state.initialCapital) * 1.002;
  const range = max - min || 1;
  const W = 600, H = 120;
  const toX = (i) => (i / (hist.length - 1)) * W;
  const toY = (v) => H - ((v - min) / range) * H;
  const points = hist.map((h, i) => `${toX(i).toFixed(1)},${toY(h.value).toFixed(1)}`).join(' ');
  const baseY = toY(state.initialCapital).toFixed(1);
  const lastVal = values[values.length - 1];
  const isUp = lastVal >= state.initialCapital;
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

// ============ レンダリング ============
function getTotalStockValue() {
  let total = 0;
  for (const [ticker, holding] of Object.entries(state.holdings)) {
    const price = state.prices[ticker];
    if (price) total += price * holding.qty;
  }
  return total;
}

function render() {
  document.getElementById('simClock').textContent = formatSimTime(state.simMinute);
  renderPortfolio();
  renderHoldings();
  renderStocks();
  renderJournal();
  renderDiversityScore();
  if (currentModalStock && document.getElementById('modal').classList.contains('show')) {
    updateModalPrice();
    updateSummary();
  }
}

// ============ ニュースイベント適用 ============
function applyNewsEvent(evt) {
  const affected = [];
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
  const tickers = Object.keys(state.holdings);
  if (tickers.length === 0) {
    el.innerHTML = '<span class="div-label">分散スコア</span><span class="div-score div-na">—</span><span class="div-msg">株を買うと分散度がわかる</span>';
    return;
  }
  // 保有評価額の比率で計算（HHI逆数ベース）
  const totalVal = getTotalStockValue();
  const weights = tickers.map(t => {
    const val = state.prices[t] * state.holdings[t].qty;
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

  // 今週のジャーナルエントリ
  const weekJournal = state.journal.filter(e => e.simMinute >= weekStart && e.simMinute < weekEnd);
  // 今週のニュース
  const weekNews = (state.newsLog || []).filter(e => e.simMinute >= weekStart && e.simMinute < weekEnd);
  // 今週の資産推移（始値・終値）
  const hist = (state.portfolioHistory || []).filter(e => e.t >= weekStart && e.t < weekEnd);
  const weekStartVal = hist.length > 0 ? hist[0].value : state.initialCapital;
  const weekEndVal = hist.length > 0 ? hist[hist.length - 1].value : state.cash + getTotalStockValue();
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
    <div class="review-question">
      <strong>🤔 考えてみよう</strong><br>
      ${weekJournal.length > 0
        ? '「なぜ買ったか」の理由と、実際の結果は一致していた？どんな判断が良くて、どんな判断がよくなかったかな？'
        : '今週はトレードしなかったね。チャンスがあったとしたら、どの銘柄を買いたかった？'}
    </div>
  `;
  document.getElementById('reviewModal').classList.add('show');
}

window.closeReview = function() {
  document.getElementById('reviewModal').classList.remove('show');
};

function renderPortfolio() {
  const stockVal = getTotalStockValue();
  const total = state.cash + stockVal;
  const delta = total - state.initialCapital;
  const pct = (delta / state.initialCapital) * 100;

  document.getElementById('totalValue').textContent = formatNum(total);
  document.getElementById('cash').textContent = formatYen(state.cash);
  document.getElementById('stockValue').textContent = formatYen(stockVal);
  document.getElementById('holdingCount').textContent = Object.keys(state.holdings).length;

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

  // 資産推移グラフ
  const graphEl = document.getElementById('portfolioGraph');
  if (graphEl) graphEl.innerHTML = buildPortfolioGraph();
  // 資産構成リング
  const ringEl = document.getElementById('allocationRing');
  if (ringEl) ringEl.innerHTML = buildAllocationRing();
}

function renderHoldings() {
  const container = document.getElementById('holdingsContent');
  const tickers = Object.keys(state.holdings);
  if (tickers.length === 0) {
    container.innerHTML = '<div class="no-holdings">まだ何も持っていない。下の銘柄一覧から買ってみよう。</div>';
    return;
  }
  let html = `<table><thead><tr>
    <th>銘柄</th><th>株数</th><th>平均取得</th><th>現在値</th><th>損益</th><th>保有期間</th>
  </tr></thead><tbody>`;
  const currentDay = Math.floor(state.simMinute / (24 * 60));
  for (const ticker of tickers) {
    const h = state.holdings[ticker];
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
  grid.innerHTML = STOCKS.map(stock => {
    const price = state.prices[stock.ticker];
    const prevClose = state.prevClose[stock.ticker];
    const owned = state.holdings[stock.ticker];
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
  if (state.journal.length === 0) {
    container.innerHTML = '<div style="color: var(--ink-dim); font-size: 13px; padding: 20px 0;">まだ日記はない。買ったり売ったりすると、ここに理由が記録される。</div>';
    return;
  }
  const entries = [...state.journal].reverse().slice(0, 20);
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
  // 会社情報タブ内容
  const holdInfo = state.holdings[ticker];
  const holdDays = holdInfo?.buyMinute != null ? Math.max(0, Math.floor(state.simMinute/(24*60)) - Math.floor(holdInfo.buyMinute/(24*60))) : null;
  document.getElementById('modalInfo').innerHTML = `
    <div class="info-desc">${escapeHtml(stock.desc)}</div>
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
  updateSummary();
  document.getElementById('modal').classList.add('show');
}

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
  const btn = document.getElementById('actionBtn');
  const noteField = document.getElementById('noteField');
  const noteLabel = noteField.querySelector('label');
  if (tab === 'buy') {
    btn.textContent = '買う';
    btn.className = 'action-btn buy-btn';
    noteLabel.textContent = 'なぜ買う? — これが一番大事';
    document.getElementById('note').placeholder = '例: ゲームが好きだから。新作が出そう。';
  } else {
    btn.textContent = '売る';
    btn.className = 'action-btn sell-btn';
    noteLabel.textContent = 'なぜ売る?';
    document.getElementById('note').placeholder = '例: 上がったので利益確定。もっと下がりそう。';
  }
  renderQuickButtons();
  updateSummary();
};

function renderQuickButtons() {
  const container = document.getElementById('quickBtns');
  if (!currentModalStock) { container.innerHTML = ''; return; }
  const price = state.prices[currentModalStock.ticker];
  if (currentTab === 'buy') {
    const maxBuy = Math.floor(state.cash / price);
    const options = [1, 5, 10].filter(n => n <= maxBuy);
    let html = options.map(n => `<button class="quick-btn" data-qty="${n}">${n}株</button>`).join('');
    if (maxBuy > 0) html += `<button class="quick-btn" data-qty="${maxBuy}">全力(${maxBuy}株)</button>`;
    container.innerHTML = html;
  } else {
    const owned = state.holdings[currentModalStock.ticker];
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
    const afterCash = state.cash - totalCost;
    html += `<div class="row" style="color: var(--ink-dim); font-size: 11px; margin-top: 6px;"><span>買った後の現金</span><span style="color:${afterCash < 0 ? 'var(--red)' : 'inherit'}">${formatYen(afterCash)}</span></div>`;
    btn.disabled = qty <= 0 || totalCost > state.cash;
  } else {
    const owned = state.holdings[currentModalStock.ticker];
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
  const qty = parseInt(document.getElementById('qty').value) || 0;
  const note = document.getElementById('note').value.trim();
  const stock = currentModalStock;
  const price = state.prices[stock.ticker];
  const total = qty * price;

  const commission = calcCommission(total);
  if (currentTab === 'buy') {
    const totalCost = total + commission;
    if (totalCost > state.cash || qty <= 0) return;
    state.cash -= totalCost;
    if (!state.totalCommission) state.totalCommission = 0;
    state.totalCommission += commission;
    const existing = state.holdings[stock.ticker];
    if (existing) {
      const newQty = existing.qty + qty;
      const newAvg = ((existing.avgCost * existing.qty) + (price * qty)) / newQty;
      state.holdings[stock.ticker] = { qty: newQty, avgCost: newAvg, buyMinute: existing.buyMinute };
    } else {
      state.holdings[stock.ticker] = { qty, avgCost: price, buyMinute: state.simMinute };
    }
    state.journal.push({
      simMinute: state.simMinute, action: 'buy', ticker: stock.ticker, stockName: stock.name,
      qty, price, total, commission, note
    });
    showToast(`${stock.name}を${qty}株 買った (手数料 ${formatYen(commission)})`);
  } else {
    const existing = state.holdings[stock.ticker];
    if (!existing || qty > existing.qty) return;
    const profit = (price - existing.avgCost) * qty;
    const tax = calcTax(profit);
    const netReceive = total - commission - tax;
    state.cash += netReceive;
    if (!state.totalCommission) state.totalCommission = 0;
    if (!state.totalTax) state.totalTax = 0;
    state.totalCommission += commission;
    state.totalTax += tax;
    if (existing.qty === qty) {
      delete state.holdings[stock.ticker];
    } else {
      state.holdings[stock.ticker] = { qty: existing.qty - qty, avgCost: existing.avgCost, buyMinute: existing.buyMinute };
    }
    const taxMsg = tax > 0 ? ` 税${formatYen(tax)}` : '';
    state.journal.push({
      simMinute: state.simMinute, action: 'sell', ticker: stock.ticker, stockName: stock.name,
      qty, price, total, commission, tax, profit, note
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
<p style="margin-top:12px; color:var(--ink-dim); font-size:13px">※ 手持ちの現金以上は買えません。</p>`,
  },
  {
    title: '💰 資産と損益の確認',
    body: `<ul class="tut-list">
  <li>ページ上部の<strong>「資産合計」</strong>でリアルタイム確認</li>
  <li><strong>「保有銘柄」テーブル</strong>で各株の含み損益を確認</li>
  <li><span style="color:var(--green)">緑 = 含み益（プラス）</span> / <span style="color:var(--red)">赤 = 含み損（マイナス）</span></li>
  <li>グラフ（スパークライン）で値動きの波形を確認できる</li>
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
  const total = state.cash + getTotalStockValue();
  const delta = total - state.initialCapital;
  const deltaSign = delta >= 0 ? '▲' : '▼';
  const deltaColor = delta >= 0 ? 'var(--green)' : 'var(--red)';
  const currentDay = Math.floor(state.simMinute / (24 * 60));

  // 直近7日のトレード
  const recentTrades = state.journal.filter(e => {
    const tradeDay = Math.floor(e.simMinute / (24 * 60));
    return currentDay - tradeDay <= 7;
  });

  // 保有中の銘柄
  const holdingRows = Object.entries(state.holdings).map(([ticker, h]) => {
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

  const commissionTotal = state.totalCommission || 0;
  const taxTotal = state.totalTax || 0;

  document.getElementById('parentReportContent').innerHTML = `
    <h2 class="tut-title">📋 保護者向けレポート</h2>
    <div class="report-date">シム経過: ${formatSimTime(state.simMinute)} (${currentDay}日目)</div>

    <div class="report-section">
      <div class="report-label">💰 資産状況</div>
      <table class="report-table">
        <tr><td>初期資金</td><td>${formatYen(state.initialCapital)}</td></tr>
        <tr><td>現在の総資産</td><td><strong>${formatYen(total)}</strong></td></tr>
        <tr><td>損益</td><td style="color:${deltaColor}">${deltaSign} ${formatYen(Math.abs(delta))} (${(delta/state.initialCapital*100).toFixed(2)}%)</td></tr>
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

// ============ ミッション（Phase 2） ============
const MISSIONS = [
  { id: 'm01', title: 'はじめての買い',    desc: '株を1株以上買ってみよう',              check: (s) => s.journal.some(e => e.action === 'buy') },
  { id: 'm02', title: '理由を書こう',      desc: '「なぜ買うか」を入力して購入しよう',    check: (s) => s.journal.some(e => e.action === 'buy' && e.note && e.note.length >= 5) },
  { id: 'm03', title: 'はじめての売り',    desc: '保有株を1株以上売ってみよう',          check: (s) => s.journal.some(e => e.action === 'sell') },
  { id: 'm04', title: '3銘柄に分散',       desc: '3種類以上の銘柄を同時に保有しよう',    check: (s) => Object.keys(s.holdings).length >= 3 },
  { id: 'm05', title: '5銘柄に分散',       desc: '5種類以上の銘柄を同時に保有しよう',    check: (s) => Object.keys(s.holdings).length >= 5 },
  { id: 'm06', title: 'プラス転換！',       desc: '総資産が初期資金を上回ろう',           check: (s) => (s.cash + Object.entries(s.holdings).reduce((a,[t,h]) => a + (s.prices[t]||0)*h.qty, 0)) > s.initialCapital },
  { id: 'm07', title: '10回トレード',       desc: 'トレードを合計10回以上しよう',         check: (s) => s.journal.length >= 10 },
  { id: 'm08', title: 'ニュースを活かせ',   desc: 'ニュースイベントが5回以上発生するまで運用しよう', check: (s) => (s.firedNewsIds||[]).length >= 5 },
  { id: 'm09', title: '1週間続けた',       desc: 'シム内7日間以上運用しよう',            check: (s) => Math.floor(s.simMinute / (24*60)) >= 7 },
  { id: 'm10', title: '長期投資家',         desc: 'シム内30日間以上運用しよう',           check: (s) => Math.floor(s.simMinute / (24*60)) >= 30 },
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
  const total = state.cash + getTotalStockValue();
  const delta = total - state.initialCapital;
  const sign = delta >= 0 ? '+' : '';
  const lines = [
    `カブラボ トレード日記`,
    `エクスポート日時: ${new Date().toLocaleString('ja-JP')}`,
    `シム経過: ${formatSimTime(state.simMinute)}`,
    `初期資金: ¥${state.initialCapital.toLocaleString('ja-JP')}`,
    `現在資産: ¥${Math.round(total).toLocaleString('ja-JP')} (${sign}¥${Math.round(Math.abs(delta)).toLocaleString('ja-JP')})`,
    ``,
    `===== トレード履歴 =====`,
  ];
  state.journal.forEach((e, i) => {
    const act = e.action === 'buy' ? '買い' : '売り';
    lines.push(`[${i+1}] ${formatSimTime(e.simMinute)} - ${e.stockName}(${e.ticker}) ${act} ${e.qty}株 @ ¥${Math.round(e.price).toLocaleString('ja-JP')} (合計¥${Math.round(e.total).toLocaleString('ja-JP')})`);
    lines.push(`    理由: ${e.note || '(記録なし)'}`);
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
