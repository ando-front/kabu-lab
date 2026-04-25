import { STOCKS } from './stocks.js';
import { tickPrice, isMarketOpen, formatSimTime, advanceTime } from './simulator.js';

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
    simMinute: 0,
  };
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

  const nextMinute = advanceTime(state.simMinute);
  // 日またぎの判定(15:00到達時に前日終値更新)
  const currentDayMin = state.simMinute % (24 * 60);
  const nextDayMin = nextMinute % (24 * 60);
  if (currentDayMin === 15 * 60 - 1 || nextDayMin === 9 * 60) {
    STOCKS.forEach(stock => { state.prevClose[stock.ticker] = state.prices[stock.ticker]; });
  }
  state.simMinute = nextMinute;

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
  if (currentModalStock && document.getElementById('modal').classList.contains('show')) {
    updateModalPrice();
    updateSummary();
  }
}

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
}

function renderHoldings() {
  const container = document.getElementById('holdingsContent');
  const tickers = Object.keys(state.holdings);
  if (tickers.length === 0) {
    container.innerHTML = '<div class="no-holdings">まだ何も持っていない。下の銘柄一覧から買ってみよう。</div>';
    return;
  }
  let html = `<table><thead><tr>
    <th>銘柄</th><th>株数</th><th>平均取得</th><th>現在値</th><th>損益</th>
  </tr></thead><tbody>`;
  for (const ticker of tickers) {
    const h = state.holdings[ticker];
    const stock = STOCKS.find(s => s.ticker === ticker);
    const current = state.prices[ticker];
    const pnl = current ? (current - h.avgCost) * h.qty : 0;
    const pnlPct = current ? ((current - h.avgCost) / h.avgCost) * 100 : 0;
    const cls = pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'zero';
    const sign = pnl > 0 ? '+' : '';
    html += `<tr>
      <td><strong style="font-family:'Zen Kaku Gothic New'">${stock?.name || ticker}</strong></td>
      <td>${h.qty}株</td>
      <td>${formatYen(h.avgCost)}</td>
      <td>${formatYen(current)}</td>
      <td class="${cls}">${sign}${formatYen(pnl)} (${sign}${pnlPct.toFixed(1)}%)</td>
    </tr>`;
  }
  html += '</tbody></table>';
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
  document.getElementById('modalTicker').textContent = `${stock.ticker} · ${stock.desc}`;
  updateModalPrice();
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

window.updateSummary = function() {
  if (!currentModalStock) return;
  const qty = parseInt(document.getElementById('qty').value) || 0;
  const price = state.prices[currentModalStock.ticker];
  const total = qty * price;
  const btn = document.getElementById('actionBtn');
  let html = `<div class="row"><span>株価</span><span>${formatYen(price)}</span></div>`;
  html += `<div class="row"><span>株数</span><span>${qty} 株</span></div>`;
  html += `<div class="row total"><span>${currentTab === 'buy' ? '必要資金' : '受取金額'}</span><span>${formatYen(total)}</span></div>`;
  if (currentTab === 'buy') {
    const afterCash = state.cash - total;
    html += `<div class="row" style="color: var(--ink-dim); font-size: 11px; margin-top: 6px;"><span>買った後の現金</span><span>${formatYen(afterCash)}</span></div>`;
    btn.disabled = qty <= 0 || total > state.cash;
  } else {
    const owned = state.holdings[currentModalStock.ticker];
    const ownedQty = owned ? owned.qty : 0;
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

  if (currentTab === 'buy') {
    if (total > state.cash || qty <= 0) return;
    state.cash -= total;
    const existing = state.holdings[stock.ticker];
    if (existing) {
      const newQty = existing.qty + qty;
      const newAvg = ((existing.avgCost * existing.qty) + (price * qty)) / newQty;
      state.holdings[stock.ticker] = { qty: newQty, avgCost: newAvg };
    } else {
      state.holdings[stock.ticker] = { qty, avgCost: price };
    }
    state.journal.push({
      simMinute: state.simMinute, action: 'buy', ticker: stock.ticker, stockName: stock.name,
      qty, price, total, note
    });
    showToast(`${stock.name}を${qty}株 買った`);
  } else {
    const existing = state.holdings[stock.ticker];
    if (!existing || qty > existing.qty) return;
    state.cash += total;
    if (existing.qty === qty) {
      delete state.holdings[stock.ticker];
    } else {
      state.holdings[stock.ticker] = { qty: existing.qty - qty, avgCost: existing.avgCost };
    }
    state.journal.push({
      simMinute: state.simMinute, action: 'sell', ticker: stock.ticker, stockName: stock.name,
      qty, price, total, note
    });
    showToast(`${stock.name}を${qty}株 売った`);
  }
  saveState();
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

// ============ ブート ============
if (state.onboardingSeen) {
  document.getElementById('onboarding').style.display = 'none';
}
initPrices();
render();
startSimLoop();

document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});
