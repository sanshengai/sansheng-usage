import * as vscode from 'vscode';
import { UsageSummary, formatCost, formatTokenCount } from './aggregator';
import { QuotaData } from './quota';

const C_AMBER  = '#fbbf24';
const C_ORANGE = '#fb923c';
const C_RED    = '#f87171';

const BAR_FULL  = '█';
const BAR_EMPTY = '░';

// The cost, 5h and 7d groups render as three separate status bar items, and VS
// Code already lays a small gap between adjacent items. GAP is the extra breath in
// front of each window item on top of that. One non-breaking space is enough: the
// per-window tint and the \u300c\u300dbrackets already mark where one group ends, so the
// three sit tight and read as a single unit rather than three scattered blocks. A
// non-breaking space (not a plain one) because a flex row collapses a run of plain
// spaces to one (microsoft/vscode#145852); nbsp survives, and one is never at risk.
const GAP = '\u00a0';

type StatusFormat = 'compact' | 'bar' | 'cost';

/**
 * Utilization 0…1 -> the tint for one quota window, or undefined below the first
 * tier. Three tiers rather than two: the jump straight from amber to red left 70%
 * and 89% looking identically urgent, when only one of them is worth reacting to.
 */
function urgencyColor(v: number): string | undefined {
  if (v >= 0.9) return C_RED;
  if (v >= 0.8) return C_ORANGE;
  if (v >= 0.7) return C_AMBER;
  return undefined;
}

/** Utilization 0…1 -> "███░░░". Clamps, so a maxed (>1) window renders full. */
function bar(v: number, width: number): string {
  const clamped = Math.min(Math.max(v, 0), 1);
  const filled = Math.round(clamped * width);
  return BAR_FULL.repeat(filled) + BAR_EMPTY.repeat(Math.max(0, width - filled));
}

interface StatusConfig {
  format: StatusFormat;
  barWidth: number;
  showResets: boolean;
  showTodayTokens: boolean;
  colorOnHighUsage: boolean;
}

function readConfig(): StatusConfig {
  const cfg = vscode.workspace.getConfiguration('clusage');
  const format = cfg.get<StatusFormat>('statusBar.format', 'compact');
  const barWidth = Math.min(Math.max(cfg.get<number>('statusBar.barWidth', 6), 3), 20);
  const showResets = cfg.get<boolean>('statusBar.showResets', false);
  const showTodayTokens = cfg.get<boolean>('statusBar.showTodayTokens', false);
  const colorOnHighUsage = cfg.get<boolean>('statusBar.colorOnHighUsage', true);
  return { format, barWidth, showResets, showTodayTokens, colorOnHighUsage };
}

export class StatusBarController {
  private readonly main: vscode.StatusBarItem;
  private readonly fiveItem: vscode.StatusBarItem;
  private readonly sevenItem: vscode.StatusBarItem;

  constructor() {
    // A status bar item carries exactly one colour for the whole of its text, so
    // bar mode gives each quota window an item of its own. That is the only way a
    // window can tint on its own utilization while the cost stays uncoloured —
    // tinting the single item could only ever colour everything at once, off
    // whichever window happened to be worse. Right-aligned items sit left to right
    // in descending priority, so these read as cost, then 5h, then 7d.
    this.main      = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.fiveItem  = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.sevenItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    for (const item of this.items) item.command = 'clusage.openPanel';
    this.main.text    = '$(sync~spin) Claude...';
    this.main.tooltip = 'Claude 用量 - 加载中…';
    this.main.show();
  }

  private get items(): vscode.StatusBarItem[] {
    return [this.main, this.fiveItem, this.sevenItem];
  }

  /** Every format but bar renders as a single item; collapse back to just main. */
  private hideWindows(): void {
    this.fiveItem.hide();
    this.sevenItem.hide();
  }

  update(summary: UsageSummary, quota: QuotaData | null): void {
    // No calls made today — show spinner until first request this session
    if (summary.todayTokens === 0) {
      this.hideWindows();
      this.main.color   = undefined;
      this.main.text    = '$(sync~spin) 等待 Claude…';
      this.main.tooltip = '今天还没有 Claude Code 用量';
      return;
    }

    // hideCost redacts the dollar amount everywhere but leaves tokens and quota %
    // visible, so the status bar is safe to show on a stream or screenshot.
    const hideCost = vscode.workspace.getConfiguration('clusage').get<boolean>('hideCost', false);
    const cost = hideCost ? '$•••' : formatCost(summary.todayCost);

    const fmtPct = (v: number) =>
      v > 1      ? '已满' :
      v < 0.0005 ? '0%' :
      v < 0.001  ? '<0.1%' :
      v < 0.1    ? `${(v * 100).toFixed(1)}%` :
                   `${Math.round(v * 100)}%`;

    const { format, barWidth, showResets, showTodayTokens, colorOnHighUsage } = readConfig();
    const tint = (v: number) => (colorOnHighUsage ? urgencyColor(v) : undefined);

    // Optional today's-token suffix on the cost, shared by every format.
    const head = showTodayTokens
      ? `$(graph) ${cost} · ${formatTokenCount(summary.todayTokens)}`
      : `$(graph) ${cost}`;

    if (!quota || format === 'cost') {
      // 'cost' is the user's choice; the !quota branch is a fallback — the quota
      // fetch failed (no creds, offline, transient API error) but we still have
      // real usage data, so show cost-only rather than stalling on the spinner.
      this.hideWindows();
      this.main.color = quota
        ? tint(Math.max(quota.fiveHourUtilization, quota.sevenDayUtilization))
        : undefined;
      this.main.text = head;
    } else if (format === 'bar') {
      // Reset countdowns are opt-in here: compact already shows the 5h reset, but
      // bar drops it for space, so showResets lets bar-mode users get both back.
      // Each countdown sits with the window it describes rather than trailing its
      // percentage, where '71% 1h 54m' reads as if the 71% were what expires.
      const r5 = showResets ? `「${timeUntil(quota.fiveHourResetAt)}」` : '';
      const r7 = showResets ? `「${timeUntil(quota.sevenDayResetAt)}」` : '';
      // Each window still leads with GAP: the spacing VS Code puts between items of
      // its own accord is tighter than these groups need, and below the first tier
      // there is no tint to tell one group from the next either.
      this.main.color = undefined;
      this.main.text  = head;
      this.fiveItem.color = tint(quota.fiveHourUtilization);
      this.fiveItem.text  = `${GAP}5h${r5} ${bar(quota.fiveHourUtilization, barWidth)} ${fmtPct(quota.fiveHourUtilization)}`;
      this.sevenItem.color = tint(quota.sevenDayUtilization);
      this.sevenItem.text  = `${GAP}7d${r7} ${bar(quota.sevenDayUtilization, barWidth)} ${fmtPct(quota.sevenDayUtilization)}`;
      this.fiveItem.show();
      this.sevenItem.show();
    } else {
      this.hideWindows();
      this.main.color = tint(Math.max(quota.fiveHourUtilization, quota.sevenDayUtilization));
      const reset = timeUntil(quota.fiveHourResetAt);
      const r7 = showResets ? ` $(clock)${timeUntil(quota.sevenDayResetAt)}` : '';
      this.main.text = `${head}  5h:${fmtPct(quota.fiveHourUtilization)} $(clock)${reset}  7d:${fmtPct(quota.sevenDayUtilization)}${r7}`;
    }

    const tooltip = buildTooltip(summary, quota, hideCost);
    for (const item of this.items) item.tooltip = tooltip;
  }

  dispose(): void {
    for (const item of this.items) item.dispose();
  }
}

function buildTooltip(summary: UsageSummary, quota: QuotaData | null, hideCost: boolean): vscode.MarkdownString {
  const money = (n: number) => (hideCost ? '$•••' : formatCost(n));
  const fmtDelta = (current: number, ref: number): string => {
    if (ref === 0) return '-';
    const pct = ((current - ref) / ref) * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`;
  };

  const fmtPct = (v: number) =>
    v > 1     ? '**已满**' :
    v < 0.001 ? '0%' :
    v < 0.1   ? `${(v * 100).toFixed(1)}%` :
                `${Math.round(v * 100)}%`;

  const lines: string[] = [
    `**今日用量（API 花费）**`,
    ``,
    `💰 花费: **${money(summary.todayCost)}**`,
    `🔢 Token: ${formatTokenCount(summary.todayTokens)}`,
    `💬 消息: ${summary.todayMessages}`,
  ];

  if (quota) {
    lines.push(
      ``,
      `---`,
      `⚡ **额度**`,
      `· 会话 (5h): **${fmtPct(quota.fiveHourUtilization)}** · ${timeUntil(quota.fiveHourResetAt)}后重置`,
      `· 周 (7d): **${fmtPct(quota.sevenDayUtilization)}** · ${timeUntil(quota.sevenDayResetAt)}后重置`,
    );
  }

  lines.push(
    ``,
    `---`,
    `🔥 连续 ${summary.streakDays} 天`,
    ``,
    `---`,
    `累计: **${money(summary.allTimeCost)}**`,
    ``,
    `*点击打开看板*`,
  );

  const md = new vscode.MarkdownString(lines.join('\n\n'));
  md.isTrusted = true;
  return md;
}

function timeUntil(date: Date): string {
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return 'soon';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
