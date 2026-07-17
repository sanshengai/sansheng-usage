import * as vscode from 'vscode';
import { UsageSummary, formatCost, formatTokenCount } from './aggregator';
import { QuotaData } from './quota';

let currentPanel: vscode.WebviewPanel | undefined;
let extensionUri: vscode.Uri | undefined;

// currentPanel can outlive the panel it points at: reinstalling or reloading the
// extension with the dashboard open tears the panel down without onDidDispose
// getting to run, leaving a handle onto a dead panel. Optional chaining does not
// help — the handle is not undefined, it is disposed — and WebviewPanel exposes no
// way to ask, so touching it is the only test there is. Every getter on a disposed
// panel throws 'Webview is disposed'; read the cheapest one and catch that, and
// nothing else, so a genuine rendering failure still surfaces as itself.
function isDisposed(panel: vscode.WebviewPanel): boolean {
  try {
    void panel.visible;
    return false;
  } catch {
    return true;
  }
}

export function showDashboard(context: vscode.ExtensionContext, summary: UsageSummary, quota: QuotaData | null): void {
  extensionUri = context.extensionUri;
  if (currentPanel && isDisposed(currentPanel)) currentPanel = undefined;
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    currentPanel.webview.html = getHtml(currentPanel.webview, summary, quota);
    return;
  }
  currentPanel = vscode.window.createWebviewPanel(
    'clusage.dashboard', 'Claude Usage', vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
  );
  currentPanel.webview.html = getHtml(currentPanel.webview, summary, quota);
  currentPanel.onDidDispose(() => { currentPanel = undefined; }, null, context.subscriptions);
}

export function refreshDashboard(summary: UsageSummary, quota: QuotaData | null): void {
  if (currentPanel && isDisposed(currentPanel)) currentPanel = undefined;
  if (currentPanel?.visible) {
    currentPanel.webview.html = getHtml(currentPanel.webview, summary, quota);
  }
}

function relativeTime(date: Date): string {
  const d = Date.now() - date.getTime();
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const dy = Math.floor(h / 24);
  if (dy < 30) return `${dy}d ago`;
  return date.toLocaleDateString();
}

function modelShortName(model: string): string {
  const s = model.replace(/^claude-/, '').replace(/-(\d)/, ' $1');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pct(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 100);
}

const PROJECT_PALETTE = ['#f87171','#fb923c','#fbbf24','#4ade80','#34d399','#5eead4','#60a5fa','#a78bfa','#f472b6','#e879f9'];
function projectColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0x7fffffff;
  return PROJECT_PALETTE[h % PROJECT_PALETTE.length];
}

function donutSvg(share: number, color: string): string {
  const r = 22, circ = 2 * Math.PI * r;
  const dash = share > 0 ? Math.max((share / 100) * circ, 3) : 0;
  return `<svg width="54" height="54" viewBox="0 0 54 54">
    <circle cx="27" cy="27" r="${r}" fill="none" stroke="#2a2a35" stroke-width="5"/>
    <circle cx="27" cy="27" r="${r}" fill="none" stroke="${color}" stroke-width="5"
      stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}"
      transform="rotate(-90 27 27)" stroke-linecap="round"/>
    <text x="27" y="31" text-anchor="middle" font-size="10" font-weight="700" fill="${color}">${Math.round(share)}%</text>
  </svg>`;
}

function changeBadge(current: number, prev: number): string {
  if (prev <= 0) return '';
  const p = ((current - prev) / prev) * 100;
  return p >= 0
    ? `<span class="badge-up">↑${Math.round(p)}%</span>`
    : `<span class="badge-dn">↓${Math.abs(Math.round(p))}%</span>`;
}

function heroVal(n: number): string {
  if (n < 0.01) return n === 0 ? '$0<span class="hero-dec">.00</span>' : `${(n * 100).toFixed(2)}¢`;
  const s = n.toFixed(2);
  const dot = s.indexOf('.');
  return `$${s.slice(0, dot)}<span class="hero-dec">${s.slice(dot)}</span>`;
}

function timeUntil(date: Date): string {
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return 'soon';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) { const d = Math.floor(h / 24); return `in ${d}d ${h % 24}h`; }
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// JSON destined for an inline <script> block. Plain JSON.stringify leaves '<' and
// '>' intact, so a session title (which the user controls by renaming a Claude
// Code conversation) containing "</script>" would close the block early and let
// the rest execute as markup. Escaping the three HTML-significant characters to
// their \uXXXX forms keeps the text valid JSON while making it impossible to
// break out of the script context; the two line-separator code points are
// escaped too, since they are valid JSON but illegal in a JS string literal.
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const MODEL_COLORS = ['#f97316', '#7c6af7', '#5eead4', '#4ade80', '#f472b6', '#60a5fa', '#fbbf24'];

interface QuotaProjection {
  ratePerHour: number;   // percentage points of the window consumed per hour
  projectedPct: number;  // extrapolated utilization at the window's reset, in %
  fullInMs: number | null; // ms until 100% at the current rate, or null if the window resets first
}

// Project a rolling quota window forward from its authoritative utilization and
// reset time — no JSONL estimate involved. If x% is used and the window has been
// open for h hours (reset time minus the window length gives its start), the rate
// is x/h per hour and the utilization at reset extrapolates to x·(window/elapsed).
// Returns null too early in a window to extrapolate, or with nothing used yet.
function projectQuota(util: number, resetAt: Date, windowMs: number): QuotaProjection | null {
  const now = Date.now();
  const elapsed = now - (resetAt.getTime() - windowMs);
  if (elapsed <= 60_000 || util <= 0) return null;
  const ratePerHour = (util / elapsed) * 3_600_000 * 100;
  const projectedPct = Math.min((util * windowMs) / elapsed, 9.99) * 100;
  const remaining = resetAt.getTime() - now;
  const msToFull = util < 1 ? ((1 - util) * elapsed) / util : 0;
  return {
    ratePerHour,
    projectedPct,
    fullInMs: util < 1 && msToFull < remaining ? msToFull : null,
  };
}

function humanDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// One projection line for a quota card: rate, extrapolated end-of-window %, and a
// time-to-full warning when the window is on track to cap before it resets.
function projectionLine(p: QuotaProjection | null): string {
  if (!p) return '';
  const full = p.fullInMs !== null
    ? ` <span class="proj-warn">⚠ ${humanDur(p.fullInMs)} 后触顶</span>`
    : '';
  return `<div class="quota-proj">~${p.ratePerHour.toFixed(0)}%/h · ~${p.projectedPct.toFixed(0)}% 窗口末${full}</div>`;
}

// GitHub-style activity grid over the last 90 days. Each cell is one day, shaded by
// that day's cost relative to the busiest day — a relative intensity, never a dollar
// figure, so it is safe under hideCost (the hover title drops the amount there too).
// Cells flow down 7-row columns, and the first day is padded to its weekday row so
// each row reads as one weekday, like the contribution graph.
function heatmap(daily: number[], hideCost: boolean): string {
  const DAY = 86400_000;
  // Shade by quantile among the days that had activity, not as a fraction of the busiest
  // day. A single outlier (one big batch run) otherwise flattens every ordinary day into
  // the bottom level and the grid renders as one flat block of colour — which is exactly
  // what it did. Quantiles put a quarter of the active days in each level, so the shading
  // always carries contrast whatever the spread. Still relative, never a dollar figure,
  // so it stays safe under hideCost.
  const ranked = daily.filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p: number): number =>
    ranked.length ? ranked[Math.min(ranked.length - 1, Math.floor(ranked.length * p))] : 0;
  const q1 = q(0.25);
  const q2 = q(0.5);
  const q3 = q(0.75);
  const bucket = (v: number): number => {
    if (v <= 0) return 0;
    if (v <= q1) return 1;
    if (v <= q2) return 2;
    if (v <= q3) return 3;
    return 4;
  };
  const now = Date.now();
  const dayOf = (i: number): Date => new Date(now - (daily.length - 1 - i) * DAY);
  const pad = dayOf(0).getDay();

  const cells: string[] = [];
  for (let i = 0; i < pad; i++) cells.push('<div class="hm-cell hm-pad"></div>');
  for (let i = 0; i < daily.length; i++) {
    const label = dayOf(i).toLocaleDateString();
    const title = hideCost ? label : `${label} · ${formatCost(daily[i])}`;
    cells.push(`<div class="hm-cell hm-l${bucket(daily[i])}" title="${escHtml(title)}"></div>`);
  }

  // A month marker sits above the column whose first day opens a new month, so the
  // 90-day span reads as dates instead of an anonymous grid.
  const cols = Math.ceil((pad + daily.length) / 7);
  const months: string[] = [];
  let seen = -1;
  for (let c = 0; c < cols; c++) {
    const i = c * 7 - pad;
    if (i < 0 || i >= daily.length) continue;
    const m = dayOf(i).getMonth();
    if (m === seen) continue;
    seen = m;
    months.push(`<span class="hm-mon" style="grid-column:${c + 1}">${m + 1}月</span>`);
  }

  // The two figures the grid can show but never states outright.
  const active = daily.filter((v) => v > 0).length;
  let run = 0;
  let best = 0;
  for (const v of daily) {
    run = v > 0 ? run + 1 : 0;
    if (run > best) best = run;
  }
  const swatches = [0, 1, 2, 3, 4].map((l) => `<i class="hm-cell hm-l${l}"></i>`).join('');

  return `<div class="hm-wrap">
    <div class="hm-plot">
      <div class="hm-mons" style="grid-template-columns:repeat(${cols},var(--hm-c))">${months.join('')}</div>
      <div class="hm-body">
        <div class="hm-wd"><span></span><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span></div>
        <div class="heatmap">${cells.join('')}</div>
      </div>
    </div>
    <div class="hm-side">
      <div class="hm-fig"><b>${active}</b><span>天有活动 · 共 ${daily.length} 天</span></div>
      <div class="hm-fig"><b>${best}</b><span>天最长连续</span></div>
      <div class="hm-legend">少${swatches}多</div>
    </div>
  </div>`;
}

function getHtml(webview: vscode.Webview, summary: UsageSummary, quota: QuotaData | null): string {
  const iconUri = extensionUri
    ? webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'icon.png'))
    : '';

  const { tokenBreakdown, todayTokenBreakdown, byProject, byModel, recentSessions,
    prevWeekCost, prevMonthCost } = summary;

  // hideCost masks every dollar figure — the usage stays visible (tokens, %, bars),
  // only the money is redacted — so the dashboard is safe to screenshot or stream.
  const hideCost = vscode.workspace.getConfiguration('clusage').get<boolean>('hideCost', false);
  const money = (n: number) => (hideCost ? '$•••' : formatCost(n));
  const heroMoney = (n: number) => (hideCost ? '$•••' : heroVal(n));


  const totalToday = todayTokenBreakdown.input + todayTokenBreakdown.output + todayTokenBreakdown.cacheRead + todayTokenBreakdown.cacheWrite;
  const totalAllTime = tokenBreakdown.input + tokenBreakdown.output + tokenBreakdown.cacheRead + tokenBreakdown.cacheWrite;

  // Cache hit rate: of the prompt-side tokens (fresh input + cache writes + cache
  // reads), the share served from cache. High means context is being reused
  // efficiently, which is most of where the cost savings on a long session come
  // from. Output tokens aren't prompt-side, so they're left out of the base.
  const cacheRate = (bd: typeof tokenBreakdown) => {
    const promptSide = bd.input + bd.cacheRead + bd.cacheWrite;
    return promptSide > 0 ? bd.cacheRead / promptSide : 0;
  };
  const cachePct = (bd: typeof tokenBreakdown) => `${Math.round(cacheRate(bd) * 100)}% 命中缓存`;
  const totalModelCost = byModel.reduce((s, m) => s + m.costUSD, 0);
  const totalModelTokens = byModel.reduce((s, m) => s + m.totalTokens, 0);
  const totalRequests = byModel.reduce((s, m) => s + m.requestCount, 0);
  const avgCostPerReq = totalRequests > 0 ? totalModelCost / totalRequests : 0;

  // Quota percentages
  const fivePct = quota ? Math.min(quota.fiveHourUtilization * 100, 100) : 0;
  const sevenPct = quota ? Math.min(quota.sevenDayUtilization * 100, 100) : 0;
  const fiveClass = fivePct >= 90 ? 'danger' : fivePct >= 70 ? 'warn' : 'ok';
  const sevenClass = sevenPct >= 90 ? 'danger' : sevenPct >= 70 ? 'warn' : 'ok';

  function fmtPct(p: number, cls: string): string {
    if (p > 100) return `<span class="quota-pct danger">Limit reached</span>`;
    if (p < 0.05) return `<span class="quota-pct ${cls}">&lt; 0.1% used</span>`;
    if (p < 10) return `<span class="quota-pct ${cls}">${p.toFixed(1)}% used</span>`;
    return `<span class="quota-pct ${cls}">${Math.round(p)}% used</span>`;
  }

  function tokenGrid(bd: typeof tokenBreakdown, total: number, label: string): string {
    const items = [
      { label: '输入',       val: bd.input,      color: '#7c6af7' },
      { label: '输出',      val: bd.output,     color: '#4ade80' },
      { label: '缓存读',  val: bd.cacheRead,  color: '#5eead4' },
      { label: '缓存写', val: bd.cacheWrite, color: '#fbbf24' },
    ];
    return items.map((item, i) => {
      const p = pct(item.val, total);
      return `<div class="token-card" style="animation-delay:${60 + i * 30}ms">
        <div class="token-header">
          <span class="tdot" style="background:${item.color}"></span>
          <span class="token-lbl">${item.label}</span>
          <span class="token-pct-lbl">${p}% of ${label}</span>
        </div>
        <div class="token-val">${formatTokenCount(item.val)}</div>
        <div class="tbar"><div class="tbar-fill" style="width:${p}%;background:${item.color}"></div></div>
      </div>`;
    }).join('');
  }

  function modelCards(fullWidth: boolean): string {
    return byModel.map((m, i) => {
      const share = pct(m.costUSD, totalModelCost);
      const color = MODEL_COLORS[i % MODEL_COLORS.length];
      const shortId = m.model.replace('claude-', '');
      const costStr = m.costUSD.toFixed(2);
      const dot = costStr.indexOf('.');
      const costHtml = hideCost
        ? '$•••'
        : `$${costStr.slice(0, dot)}<span class="model-cost-dec">${costStr.slice(dot)}</span>`;
      return `
      <div class="model-card${fullWidth ? ' model-card-full' : ''}" style="animation-delay:${i * 60}ms">
        <div class="model-card-left">
          <div class="model-card-header">
            <span class="model-card-name">${escHtml(modelShortName(m.model))}</span>
            <span class="tag">${escHtml(shortId)}</span>
          </div>
          <div class="model-card-cost">${costHtml}</div>
          <div class="muted" style="font-size:11px;margin-top:2px">${formatTokenCount(m.totalTokens)} tok · ${m.requestCount.toLocaleString()} req</div>
          <div class="model-bar-track"><div class="model-bar-fill" style="width:${share}%;background:${color}"></div></div>
        </div>
        <div class="model-card-right">${donutSvg(share, color)}</div>
      </div>`;
    }).join('');
  }

  // JSON for JS sort/filter — script-safe because it lands inside an inline <script>.
  // The client only ever sorts by `cost` and sizes a share bar from it, both purely
  // relative, so under hideCost we ship each item's share of the total (scaled to an
  // integer) instead of the dollar amount — the DOM then carries no spend, not even
  // in source, while sort order and bar proportions are preserved exactly.
  const topProjects = byProject.slice(0, 30);
  const projTotal = topProjects.reduce((s, p) => s + p.costUSD, 0) || 1;
  const maskCostNum = (usd: number, total: number) =>
    hideCost ? Math.round((usd / total) * 1_000_000) : usd;
  const projectsJson = jsonForScript(topProjects.map(p => ({
    color: projectColor(p.displayName),
    name: p.displayName,
    sessions: p.sessionCount,
    tokens: p.totalTokens,
    tokensFmt: formatTokenCount(p.totalTokens),
    cost: maskCostNum(p.costUSD, projTotal),
    costFmt: money(p.costUSD),
  })));

  // The dot stays coloured by project so sessions of one project still read as a
  // group; only the label switches to the conversation title.
  const showTitles = vscode.workspace.getConfiguration('clusage').get<boolean>('sessions.showTitles', true);
  const sessTotal = recentSessions.reduce((s, x) => s + x.costUSD, 0) || 1;
  const sessionsJson = jsonForScript(recentSessions.map(s => ({
    color: projectColor(s.displayName),
    project: s.displayName,
    name: (showTitles && s.title) ? s.title : s.displayName,
    model: modelShortName(s.model),
    cost: maskCostNum(s.costUSD, sessTotal),
    costFmt: money(s.costUSD),
    tokens: s.totalTokens,
    tokensFmt: formatTokenCount(s.totalTokens),
    time: relativeTime(s.timestamp),
  })));

  const allModels = [...new Set(recentSessions.map(s => modelShortName(s.model)))];
  const modelPills = ['All', ...allModels].map((m, i) =>
    `<button class="pill${i === 0 ? ' active' : ''}" data-model="${escHtml(m)}" onclick="filterSessions(this)">${escHtml(m)}</button>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Usage</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg:           var(--vscode-editor-background, #1e1e1e);
  --bg-1:         var(--vscode-sideBar-background, #252526);
  --bg-2:         var(--vscode-list-hoverBackground, #2d2d30);
  --line:         var(--vscode-panel-border, #333335);
  --fg:           var(--vscode-editor-foreground, #e8e8ea);
  --fg-mute:      var(--vscode-descriptionForeground, #a1a1a6);
  --fg-dim:       #6e6e74;
  --fg-faint:     #4a4a50;
  --accent:       #d97757;
  --accent-hi:    #e08e72;
  --accent-bg:    rgba(217,119,87,.12);
  --accent-line:  rgba(217,119,87,.28);
  --ok:           #4ade80;
  --err:          #f87171;
  --warn:         #fbbf24;
  --global:       #74a8e8;
  --global-bg:    rgba(116,168,232,.10);
  --global-ln:    rgba(116,168,232,.28);
  --project:      #b89bf0;
  --project-bg:   rgba(184,155,240,.10);
  --project-ln:   rgba(184,155,240,.28);
  --sans:         var(--vscode-font-family, -apple-system, 'Segoe UI', system-ui, sans-serif);
  --mono:         var(--vscode-editor-font-family, ui-monospace, 'SF Mono', Menlo, monospace);
  --r-sm:         4px;
  --r:            6px;
  --r-lg:         10px;
  /* aliases used throughout this file */
  --surface:      var(--bg-1);
  --surface2:     var(--bg-2);
  --border:       var(--line);
  --text:         var(--fg);
  --muted:        var(--fg-mute);
  --accent2:      #5eead4;
  --green:        var(--ok);
  --amber:        var(--warn);
  --rose:         var(--err);
  --blue:         var(--global);
  --orange:       var(--accent);
  --radius:       var(--r-lg);
  --radius-sm:    var(--r);
}
body { background: var(--bg); color: var(--fg); font-family: var(--sans); font-size: 13px; line-height: 1.5; min-height: 100vh; -webkit-font-smoothing: antialiased; }

/* ── Top bar ── */
.topbar { display: flex; align-items: center; justify-content: space-between; padding: 10px 20px; background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; }
.topbar-left { display: flex; align-items: center; gap: 10px; }
.topbar-icon { width: 26px; height: 26px; border-radius: 6px; overflow: hidden; flex-shrink: 0; }
.topbar-icon img { width: 100%; height: 100%; display: block; }
.topbar-title { font-size: 14px; font-weight: 600; }
.topbar-path { font-size: 11px; color: var(--muted); }
.topbar-right { display: flex; align-items: center; gap: 14px; }
.live-badge { display: flex; align-items: center; gap: 5px; background: rgba(74,222,128,.12); border: 1px solid rgba(74,222,128,.3); border-radius: 12px; padding: 2px 9px; font-size: 11px; color: var(--green); }
.live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); animation: pulse 2s infinite; }
.updated { font-size: 11px; color: var(--muted); }

/* ── Tabs ── */
.tabs { display: flex; padding: 0 20px; background: var(--surface); border-bottom: 1px solid var(--border); gap: 2px; }
.tab-btn { display: flex; align-items: center; gap: 6px; padding: 10px 14px; font-size: 12px; font-weight: 500; color: var(--muted); background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer; transition: color 0.15s; margin-bottom: -1px; white-space: nowrap; }
.tab-btn:hover { color: var(--text); }
.tab-btn.active { color: var(--fg); border-bottom-color: var(--accent); }
.tab-count { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 1px 6px; font-size: 10px; color: var(--muted); }

/* ── Panels ── */
.panel { padding: 20px; }
.panel.hidden { display: none; }

/* ── Section headers ── */
.sec-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
.sec-title { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.07em; }
.sec-meta { font-size: 11px; color: var(--muted); }
.section { margin-bottom: 24px; }

/* ── Hero cards ── */
.hero-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
.hero-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; position: relative; overflow: hidden; animation: fadeUp 0.3s ease both; }
.hero-card.today { border-color: var(--accent-line); background: var(--accent-bg); }
.hero-label { font-size: 11px; color: var(--fg-mute); text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; margin-bottom: 6px; }
.hero-card.today .hero-label { color: var(--accent); }
.hero-value { font-size: 28px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; color: var(--fg); }
.hero-card.today .hero-value { color: var(--accent); }
.hero-dec { font-size: 16px; font-weight: 600; opacity: 0.55; }
.hero-sub { font-size: 11px; color: var(--fg-dim); margin-top: 7px; }
.hero-badge { position: absolute; bottom: 13px; right: 14px; font-size: 11px; font-weight: 600; }
.badge-up { color: var(--ok);  background: rgba(74,222,128,.15); border-radius: var(--r-sm); padding: 2px 6px; }
.badge-dn { color: var(--err); background: rgba(248,113,113,.15); border-radius: var(--r-sm); padding: 2px 6px; }

/* ── Token breakdown ── */
.token-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.token-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; animation: fadeUp 0.3s ease both; }
.token-header { display: flex; align-items: center; gap: 5px; margin-bottom: 6px; }
.tdot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.token-lbl { font-size: 11px; color: var(--muted); flex: 1; }
.token-pct-lbl { font-size: 10px; color: var(--muted); }
.token-val { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
.tbar { height: 3px; background: var(--border); border-radius: 2px; margin-top: 10px; overflow: hidden; }
.tbar-fill { height: 100%; border-radius: 2px; transition: width 0.5s ease; }

/* ── Quota ── */
.quota-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.quota-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 18px; animation: fadeUp 0.3s ease both; }
.quota-card-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.quota-label { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.quota-win-label { font-size: 10px; color: var(--muted); letter-spacing: 0.05em; }
.quota-cost { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
.quota-tokens { font-size: 11px; color: var(--muted); margin-bottom: 10px; }
.q-track { height: 5px; background: var(--border); border-radius: 3px; overflow: hidden; margin-bottom: 7px; }
.q-fill { height: 100%; border-radius: 3px; transition: width 0.6s ease; }
.q-fill.ok     { background: linear-gradient(90deg, var(--accent), var(--accent2)); }
.q-fill.warn   { background: linear-gradient(90deg, var(--amber), #f59e0b); }
.q-fill.danger { background: linear-gradient(90deg, var(--rose), #ef4444); }
.quota-footer { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); }
.quota-proj { font-size: 10.5px; color: var(--muted); margin-top: 6px; opacity: .85; }
.proj-warn { color: var(--rose); font-weight: 600; }
/* --hm-c is the column pitch: the cell plus its gap. The month row and the grid share
   it so a marker lands exactly over its column. */
.hm-wrap { --hm-c: 21px; display: flex; align-items: flex-start; gap: 44px; flex-wrap: wrap; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; overflow-x: auto; }
.hm-plot { width: max-content; }
.hm-mons { display: grid; margin-left: 22px; margin-bottom: 6px; height: 12px; }
.hm-mon { font-size: 10px; color: var(--fg-dim); white-space: nowrap; letter-spacing: .02em; }
.hm-body { display: flex; gap: 7px; }
.hm-wd { display: grid; grid-template-rows: repeat(7, 18px); gap: 3px; width: 15px; }
.hm-wd span { font-size: 10px; line-height: 18px; color: var(--fg-dim); }
.heatmap { display: grid; grid-template-rows: repeat(7, 18px); grid-auto-flow: column; grid-auto-columns: 18px; gap: 3px; width: max-content; }
.hm-cell { width: 18px; height: 18px; border-radius: 3px; }
.hm-pad { visibility: hidden; }
.hm-side { display: flex; flex-direction: column; gap: 14px; padding-top: 18px; }
.hm-fig { display: flex; align-items: baseline; gap: 7px; }
.hm-fig b { font-size: 22px; font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; }
.hm-fig span { font-size: 11px; color: var(--fg-mute); }
.hm-legend { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--fg-dim); margin-top: 2px; }
.hm-legend i { width: 11px; height: 11px; border-radius: 2px; display: inline-block; }
.hm-legend i:first-of-type { margin-left: 4px; }
.hm-legend i:last-of-type { margin-right: 4px; }
.hm-l0 { background: var(--border); }
.hm-l1 { background: rgba(94, 234, 212, .16); }
.hm-l2 { background: rgba(94, 234, 212, .38); }
.hm-l3 { background: rgba(94, 234, 212, .66); }
.hm-l4 { background: rgba(94, 234, 212, 1); }
.quota-pct.ok     { color: var(--accent2); font-weight: 600; }
.quota-pct.warn   { color: var(--amber); font-weight: 600; }
.quota-pct.danger { color: var(--rose); font-weight: 600; }

/* ── Model cards ── */
.model-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.model-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; display: flex; align-items: center; gap: 12px; animation: fadeUp 0.3s ease both; }
.model-card-full { grid-column: 1 / -1; }
.model-card-left { flex: 1; min-width: 0; }
.model-card-right { flex-shrink: 0; }
.model-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
.model-card-name { font-size: 15px; font-weight: 600; }
.model-card-cost { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; margin-top: 4px; }
.model-cost-dec { font-size: 14px; opacity: 0.65; }
.model-bar-track { height: 3px; background: var(--border); border-radius: 2px; margin-top: 12px; overflow: hidden; }
.model-bar-fill { height: 100%; border-radius: 2px; transition: width 0.5s ease; }

/* ── Tags ── */
.tag { background: var(--surface2); border: 1px solid var(--border); padding: 1px 6px; border-radius: 4px; font-size: 10px; color: var(--muted); white-space: nowrap; }

/* ── Projects tab ── */
.tab-controls { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
.search-input { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 10px; font-size: 12px; color: var(--text); outline: none; width: 220px; }
.search-input::placeholder { color: var(--muted); }
.search-input:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-bg); }
.sort-btn { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 5px 10px; font-size: 11px; color: var(--muted); cursor: pointer; transition: all 0.15s; }
.sort-btn:hover { color: var(--text); border-color: var(--muted); }
.sort-btn.active { color: var(--fg); background: var(--bg-2); border-color: var(--accent-line); }
.table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.proj-table { width: 100%; border-collapse: collapse; }
.proj-table thead tr { background: var(--surface2); border-bottom: 1px solid var(--border); }
.proj-table th { padding: 8px 14px; font-size: 10px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; text-align: left; }
.proj-table th.right, .proj-table td.right { text-align: right; }
.proj-table td { padding: 10px 14px; font-size: 12px; border-bottom: 1px solid var(--border); }
.proj-table tr:last-child td { border-bottom: none; }
.proj-table tr:hover td { background: var(--surface2); }
.proj-name-cell { display: flex; align-items: center; gap: 8px; }
.proj-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.proj-name-text { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 300px; }
.cost-cell { color: var(--green); font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
.share-bar-bg { height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; width: 140px; }
.share-bar-fill { height: 100%; background: linear-gradient(90deg, var(--orange), #fb923c); border-radius: 2px; }
.muted { color: var(--muted); }

/* ── Sessions tab ── */
.sessions-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.session-row { display: flex; align-items: center; padding: 11px 16px; border-bottom: 1px solid var(--border); gap: 10px; transition: background 0.15s; }
.session-row:last-child { border-bottom: none; }
.session-row:hover { background: var(--surface2); }
.sess-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.sess-name { font-weight: 500; font-size: 12px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sess-right { display: flex; align-items: center; gap: 16px; flex-shrink: 0; font-size: 12px; }
.sess-cost { color: var(--green); font-weight: 600; font-variant-numeric: tabular-nums; }
.sess-tokens { color: var(--muted); font-size: 11px; text-align: right; line-height: 1.3; }
.sess-time { color: var(--muted); font-size: 11px; min-width: 55px; text-align: right; }
.model-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.pill { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 3px 10px; font-size: 11px; color: var(--muted); cursor: pointer; transition: all 0.15s; }
.pill:hover { color: var(--text); }
.pill.active { background: var(--accent-bg); border-color: var(--accent-line); color: var(--accent); }

/* ── Models tab summary ── */
.model-summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
.model-summary-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; animation: fadeUp 0.3s ease both; }
.model-summary-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
.model-summary-value { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; line-height: 1; }
.model-summary-sub { font-size: 11px; color: var(--muted); margin-top: 5px; }
.model-detail-list { display: flex; flex-direction: column; gap: 10px; }

/* ── Animations ── */
@keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>
</head>
<body>

<!-- Top bar -->
<div class="topbar">
  <div class="topbar-left">
    ${iconUri ? `<div class="topbar-icon"><img src="${iconUri}" alt=""/></div>` : ''}
    <div>
      <div class="topbar-title">Claude Usage</div>
      <div class="topbar-path">~/.claude/projects</div>
    </div>
  </div>
  <div class="topbar-right">
    <div class="live-badge"><span class="live-dot"></span>实时</div>
    <span class="updated">更新于 ${new Date(summary.lastUpdated).toLocaleTimeString()}</span>
  </div>
</div>

<!-- Tabs -->
<nav class="tabs">
  <button class="tab-btn active" data-tab="overview"  onclick="switchTab('overview')">⊞ 总览</button>
  <button class="tab-btn"        data-tab="projects"  onclick="switchTab('projects')">☰ 项目 <span class="tab-count">${byProject.length}</span></button>
  <button class="tab-btn"        data-tab="sessions"  onclick="switchTab('sessions')">◷ 会话 <span class="tab-count">${recentSessions.length}</span></button>
  <button class="tab-btn"        data-tab="models"    onclick="switchTab('models')">▣ 模型 <span class="tab-count">${byModel.length}</span></button>
</nav>

<!-- ═══ OVERVIEW ═══ -->
<div id="tab-overview" class="panel">

  <div class="hero-grid">
    <div class="hero-card" style="animation-delay:0ms">
      <div class="hero-label">累计</div>
      <div class="hero-value">${heroMoney(summary.allTimeCost)}</div>
      <div class="hero-sub">${formatTokenCount(summary.allTimeTokens)} tokens</div>
    </div>
    <div class="hero-card today" style="animation-delay:50ms">
      <div class="hero-label">今日</div>
      <div class="hero-value">${heroMoney(summary.todayCost)}</div>
      <div class="hero-sub">${formatTokenCount(summary.todayTokens)} tokens</div>
    </div>
    <div class="hero-card" style="animation-delay:100ms">
      <div class="hero-label">本周</div>
      <div class="hero-value">${heroMoney(summary.weekCost)}</div>
      <div class="hero-sub">7 天窗口</div>
    </div>
    <div class="hero-card" style="animation-delay:150ms">
      <div class="hero-label">本月</div>
      <div class="hero-value">${heroMoney(summary.monthCost)}</div>
      <div class="hero-sub">自然月</div>
    </div>
  </div>

  <div class="section">
    <div class="sec-header">
      <span class="sec-title">今日 Token</span>
      <span class="sec-meta">共 ${formatTokenCount(totalToday)} · ${cachePct(todayTokenBreakdown)}</span>
    </div>
    <div class="token-grid">${tokenGrid(todayTokenBreakdown, totalToday, 'today')}</div>
  </div>

  <div class="section">
    <div class="sec-header"><span class="sec-title">用量窗口与额度</span></div>
    <div class="quota-grid">
      <div class="quota-card" style="animation-delay:0ms">
        <div class="quota-card-header">
          <span class="quota-label">当前会话</span>
          <span class="quota-win-label">5 小时</span>
        </div>
        <div class="quota-cost">${money(summary.lastFiveHours.cost)}</div>
        <div class="quota-tokens">${formatTokenCount(summary.lastFiveHours.tokens)} tokens</div>
        ${quota ? `<div class="q-track"><div class="q-fill ${fiveClass}" style="width:${fivePct}%"></div></div>
        <div class="quota-footer"><span>${timeUntil(quota.fiveHourResetAt)}</span>${fmtPct(fivePct, fiveClass)}</div>
        ${projectionLine(projectQuota(quota.fiveHourUtilization, quota.fiveHourResetAt, 5 * 3600_000))}
        ${typeof quota.contextPct === 'number' ? `<div class="quota-proj">上下文占用 ${Math.round(quota.contextPct)}%</div>` : ''}` : ''}
      </div>
      <div class="quota-card" style="animation-delay:60ms">
        <div class="quota-card-header">
          <span class="quota-label">本周</span>
          <span class="quota-win-label">7 天</span>
        </div>
        <div class="quota-cost">${money(summary.lastWeek.cost)}</div>
        <div class="quota-tokens">${formatTokenCount(summary.lastWeek.tokens)} tokens</div>
        ${quota ? `<div class="q-track"><div class="q-fill ${sevenClass}" style="width:${sevenPct}%"></div></div>
        <div class="quota-footer"><span>${timeUntil(quota.sevenDayResetAt)}</span>${fmtPct(sevenPct, sevenClass)}</div>
        ${projectionLine(projectQuota(quota.sevenDayUtilization, quota.sevenDayResetAt, 7 * 86400_000))}` : ''}
      </div>
      <div class="quota-card" style="animation-delay:120ms">
        <div class="quota-card-header">
          <span class="quota-label">最近一小时</span>
          <span class="quota-win-label">60 分钟</span>
        </div>
        <div class="quota-cost">${money(summary.lastHour.cost)}</div>
        <div class="quota-tokens">${formatTokenCount(summary.lastHour.tokens)} tokens</div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="sec-header">
      <span class="sec-title">活动</span>
      <span class="sec-meta">近 90 天</span>
    </div>
    ${heatmap(summary.dailyCost, hideCost)}
  </div>

  <div class="section">
    <div class="sec-header">
      <span class="sec-title">模型分布</span>
      <span class="sec-meta">${money(totalModelCost)} 共 · ${formatTokenCount(totalModelTokens)} tokens</span>
    </div>
    <div class="model-grid">${modelCards(false)}</div>
  </div>

  <div class="section">
    <div class="sec-header">
      <span class="sec-title">累计 Token</span>
      <span class="sec-meta">共 ${formatTokenCount(totalAllTime)} · ${cachePct(tokenBreakdown)}</span>
    </div>
    <div class="token-grid">${tokenGrid(tokenBreakdown, totalAllTime, 'total')}</div>
  </div>

</div>

<!-- ═══ PROJECTS ═══ -->
<div id="tab-projects" class="panel hidden">
  <div class="sec-header" style="margin-bottom:14px">
    <span class="sec-title">项目</span>
    <span class="sec-meta">${byProject.length} 个</span>
  </div>
  <div class="tab-controls">
    <input class="search-input" id="proj-search" placeholder="筛选项目…" oninput="renderProjects()"/>
    <button class="sort-btn active" id="sort-cost"     onclick="sortProjects('cost')">↓ 花费</button>
    <button class="sort-btn"        id="sort-tokens"   onclick="sortProjects('tokens')">↓ Token</button>
    <button class="sort-btn"        id="sort-sessions" onclick="sortProjects('sessions')">↓ 会话</button>
    <button class="sort-btn"        id="sort-name"     onclick="sortProjects('name')">↓ 名称</button>
  </div>
  <div class="table-wrap">
    <table class="proj-table">
      <thead><tr>
        <th>项目</th>
        <th class="right">会话</th>
        <th class="right">Token</th>
        <th class="right">花费</th>
        <th>花费占比</th>
      </tr></thead>
      <tbody id="proj-tbody"></tbody>
    </table>
  </div>
</div>

<!-- ═══ SESSIONS ═══ -->
<div id="tab-sessions" class="panel hidden">
  <div class="sec-header" style="margin-bottom:14px">
    <span class="sec-title">最近会话</span>
    <span class="sec-meta">${recentSessions.length} 个会话</span>
  </div>
  <div class="tab-controls">
    <input class="search-input" id="sess-search" placeholder="筛选会话…" oninput="renderSessions()"/>
    <div class="model-pills">${modelPills}</div>
  </div>
  <div class="sessions-wrap" id="sessions-list"></div>
</div>

<!-- ═══ MODELS ═══ -->
<div id="tab-models" class="panel hidden">
  <div class="sec-header" style="margin-bottom:14px">
    <span class="sec-title">模型分布</span>
    <span class="sec-meta">${byModel.length} 个模型 · ${totalRequests.toLocaleString()} 次请求</span>
  </div>
  <div class="model-summary-grid">
    <div class="model-summary-card" style="animation-delay:0ms">
      <div class="model-summary-label">总花费</div>
      <div class="model-summary-value" style="color:var(--orange)">${heroMoney(totalModelCost)}</div>
      <div class="model-summary-sub">${byModel.length} 个模型</div>
    </div>
    <div class="model-summary-card" style="animation-delay:60ms">
      <div class="model-summary-label">总 Token</div>
      <div class="model-summary-value" style="color:var(--accent2)">${formatTokenCount(totalModelTokens)}</div>
      <div class="model-summary-sub">输入 + 输出 + 缓存</div>
    </div>
    <div class="model-summary-card" style="animation-delay:120ms">
      <div class="model-summary-label">请求数</div>
      <div class="model-summary-value" style="color:var(--accent)">${totalRequests.toLocaleString()}</div>
      <div class="model-summary-sub">均价 ${money(avgCostPerReq)}/次</div>
    </div>
  </div>
  <div class="sec-header" style="margin-bottom:10px"><span class="sec-title">明细</span></div>
  <div class="model-detail-list">${modelCards(true)}</div>
</div>

<script>
const PROJECTS = ${projectsJson};
const SESSIONS = ${sessionsJson};
let sortKey = 'cost', sortDir = -1, sessModel = 'All';

function switchTab(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.remove('hidden');
  document.querySelector('[data-tab="' + name + '"]').classList.add('active');
}

function sortProjects(key) {
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('sort-' + key).classList.add('active');
  if (sortKey === key) { sortDir *= -1; } else { sortKey = key; sortDir = key === 'name' ? 1 : -1; }
  renderProjects();
}

function renderProjects() {
  const q = (document.getElementById('proj-search').value || '').toLowerCase();
  let rows = PROJECTS.filter(p => p.name.toLowerCase().includes(q));
  rows.sort((a, b) => {
    let va = a[sortKey], vb = b[sortKey];
    if (sortKey === 'name') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
    return va < vb ? -sortDir : va > vb ? sortDir : 0;
  });
  const maxCost = rows.reduce((m, r) => Math.max(m, r.cost), 0.001);
  document.getElementById('proj-tbody').innerHTML = rows.map(p => {
    const w = Math.round((p.cost / maxCost) * 100);
    return '<tr>' +
      '<td><div class="proj-name-cell"><span class="proj-dot" style="background:' + p.color + '"></span>' +
      '<span class="proj-name-text">' + esc(p.name) + '</span></div></td>' +
      '<td class="right muted">' + p.sessions + '</td>' +
      '<td class="right muted">' + p.tokensFmt + '</td>' +
      '<td class="cost-cell">' + p.costFmt + '</td>' +
      '<td><div class="share-bar-bg"><div class="share-bar-fill" style="width:' + w + '%"></div></div></td>' +
      '</tr>';
  }).join('');
}

function filterSessions(btn) {
  if (btn) {
    document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    sessModel = btn.dataset.model;
  }
  renderSessions();
}

function renderSessions() {
  const q = (document.getElementById('sess-search') ? document.getElementById('sess-search').value : '').toLowerCase();
  const rows = SESSIONS.filter(s =>
    (sessModel === 'All' || s.model === sessModel) &&
    (!q || s.name.toLowerCase().includes(q) || s.project.toLowerCase().includes(q))
  );
  document.getElementById('sessions-list').innerHTML = rows.length
    ? rows.map(s =>
        '<div class="session-row" title="' + esc(s.project) + '">' +
        '<span class="sess-dot" style="background:' + s.color + '"></span>' +
        '<span class="sess-name">' + esc(s.name) + '</span>' +
        '<span class="tag">' + esc(s.model) + '</span>' +
        '<div class="sess-right">' +
        '<span class="sess-cost">' + s.costFmt + '</span>' +
        '<span class="sess-tokens">' + s.tokensFmt + '<br>tok</span>' +
        '<span class="sess-time">' + s.time + '</span>' +
        '</div></div>'
      ).join('')
    : '<div class="muted" style="padding:24px;text-align:center">无匹配会话</div>';
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

renderProjects();
renderSessions();
</script>
</body>
</html>`;
}
