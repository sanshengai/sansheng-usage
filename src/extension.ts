import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { scanAllProjects, initParseCache, flushParseCache } from './parser';
import { aggregate, UsageSummary } from './aggregator';
import { StatusBarController } from './statusBar';
import { showDashboard, refreshDashboard } from './webview';
import { fetchQuota, QuotaData } from './quota';
import { installStatuslineBridge } from './bridge';

let statusBar: StatusBarController | undefined;
let lastSummary: UsageSummary | undefined;
let lastQuota: QuotaData | null = null;
let extContext: vscode.ExtensionContext | undefined;

let usageScanPromise: Promise<void> | undefined;
let usageScanQueued = false;

// globalState round-trips through JSON, so every Date in a restored summary comes
// back as an ISO string; the dashboard then calls .getTime() on it and throws.
// (Predates this fork's changes — it just only bit when the dashboard was opened
// before the first scan finished.)
function reviveSummaryDates(s: UsageSummary): void {
  s.lastUpdated = new Date(s.lastUpdated);
  for (const sess of s.recentSessions ?? []) sess.timestamp = new Date(sess.timestamp);
}

// globalState is only a warm-boot nicety, but an unthrottled update() wrote a few
// hundred KB of summary into it on every streamed turn. One write a minute keeps the
// boot data fresh enough while cutting that churn ~100×.
let lastSummarySavedAt = 0;
const SUMMARY_SAVE_MS = 60_000;

async function doRefreshUsage(): Promise<void> {
  try {
    const { records, titles } = await scanAllProjects();
    lastSummary = aggregate(records, titles);
    if (Date.now() - lastSummarySavedAt > SUMMARY_SAVE_MS) {
      lastSummarySavedAt = Date.now();
      extContext?.globalState.update('lastSummary', lastSummary);
      extContext?.globalState.update('lastSummaryAt', lastSummarySavedAt);
    }
    statusBar?.update(lastSummary, lastQuota);
    refreshDashboard(lastSummary, lastQuota);
  } catch (err) {
    console.error('[clusage] usage refresh error:', err);
  }
}

// A full scan walks every transcript under ~/.claude/projects, which on a large
// history is seconds of I/O. The file watcher fires on every JSONL append, so
// unguarded calls used to overlap: a new scan started while the previous was
// still reading, piling up concurrent walks over the same tree. Coalesce to one
// scan in flight plus at most one queued rerun, so the newest write is never
// dropped and the work never stacks. Callers still get a promise that resolves
// when fresh data has landed (the dashboard command awaits this).
function refreshUsage(): Promise<void> {
  if (usageScanPromise) {
    usageScanQueued = true;
    return usageScanPromise;
  }
  const p = doRefreshUsage().finally(() => {
    usageScanPromise = undefined;
    if (usageScanQueued) {
      usageScanQueued = false;
      void refreshUsage();
    }
  });
  usageScanPromise = p;
  return p;
}

let resetRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let quotaFetchInFlight = false;

async function refreshQuota(): Promise<void> {
  if (quotaFetchInFlight) return;
  quotaFetchInFlight = true;
  try {
    // The usage endpoint always returns both windows in one body (or parseQuota
    // yields null), so there is no longer a missing-7d case to patch around.
    lastQuota = await fetchQuota();
    if (lastQuota) {
      extContext?.globalState.update('lastQuota', {
        ...lastQuota,
        fiveHourResetAt: lastQuota.fiveHourResetAt.toISOString(),
        sevenDayResetAt: lastQuota.sevenDayResetAt.toISOString(),
      });
    }
    if (lastSummary) {
      statusBar?.update(lastSummary, lastQuota);
      refreshDashboard(lastSummary, lastQuota);
    }

    // Schedule an automatic re-fetch right after whichever reset is soonest,
    // so the UI clears itself the moment the quota window rolls over.
    if (resetRefreshTimer) clearTimeout(resetRefreshTimer);
    if (lastQuota) {
      const now = Date.now();
      const candidates = [
        lastQuota.fiveHourResetAt.getTime(),
        lastQuota.sevenDayResetAt.getTime(),
      ].filter(t => t > now);

      if (candidates.length > 0) {
        const nextReset = Math.min(...candidates);
        const delay = nextReset - now + 2000; // 2 s buffer after the reset
        resetRefreshTimer = setTimeout(() => refreshQuota(), delay);
      }
    }
  } catch (err) {
    console.error('[clusage] quota refresh error:', err);
  } finally {
    quotaFetchInFlight = false;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;
  statusBar = new StatusBarController();
  context.subscriptions.push(statusBar);

  // The disk-persisted parse cache turns the first scan of a new window from a full
  // cold parse (~40 s of spinner on a large history) into roughly a warm one.
  initParseCache(context.globalStorageUri.fsPath);

  const cachedSummary = context.globalState.get<UsageSummary>('lastSummary');
  const cachedSummaryAt = context.globalState.get<number>('lastSummaryAt', 0);
  const cachedQuotaRaw = context.globalState.get<any>('lastQuota');

  if (cachedSummary) {
    lastSummary = cachedSummary;
    // Push it straight to the status bar when it was saved earlier TODAY — numbers a
    // few minutes stale beat half a minute of spinner, and the real scan replaces
    // them seconds later. A summary from a previous day stays off the bar: its
    // todayCost belongs to that day, and rendering it would show yesterday's spend
    // as today's. (Dates are revived below — globalState round-trips Date as string.)
    reviveSummaryDates(lastSummary);
    if (new Date(cachedSummaryAt).toDateString() === new Date().toDateString()) {
      statusBar?.update(lastSummary, null);
    }
  }
  if (cachedQuotaRaw) {
    const now = Date.now();
    const fiveHourResetAt = new Date(cachedQuotaRaw.fiveHourResetAt);
    const sevenDayResetAt = new Date(cachedQuotaRaw.sevenDayResetAt);
    lastQuota = {
      ...cachedQuotaRaw,
      fiveHourResetAt,
      sevenDayResetAt,
      fiveHourUtilization: fiveHourResetAt.getTime() <= now ? 0 : cachedQuotaRaw.fiveHourUtilization,
      sevenDayUtilization: sevenDayResetAt.getTime() <= now ? 0 : cachedQuotaRaw.sevenDayUtilization,
      sevenDayHeaderPresent: cachedQuotaRaw.sevenDayHeaderPresent ?? true,
    };
  }
  // Status bar stays on the spinner until refreshUsage() finishes below.

  // registerCommand throws when the id is already taken — which happens for real
  // during a fork migration: the old install is uninstalled on disk but still active
  // in the open window, owning `clusage.*`, while this one hot-activates alongside
  // it. Letting that throw escape activate() froze the whole extension at the
  // spinner (nothing after this line ran). One reload later the old install is gone
  // and the ids are free; until then, degrade to a working status bar without the
  // command rather than a dead extension.
  const safeRegister = (id: string, fn: (...args: any[]) => any): void => {
    try {
      context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    } catch (err) {
      console.error(`[clusage] command '${id}' already registered (stale duplicate install still active?):`, err);
    }
  };

  safeRegister('clusage.openPanel', () => {
    if (lastSummary) {
      showDashboard(context, lastSummary, lastQuota);
    } else {
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '正在加载 Claude 用量数据…' },
        async () => {
          await Promise.all([refreshUsage(), refreshQuota()]);
          if (lastSummary) showDashboard(context, lastSummary, lastQuota);
        }
      );
    }
  });

  safeRegister('clusage.installBridge', async () => {
    const result = installStatuslineBridge();
    if (result.ok) {
      // A fresh reading may now be available without any request; refresh so the UI
      // reflects the new source as soon as Claude Code writes the bridge.
      void refreshQuota();
      vscode.window.showInformationMessage(result.message);
    } else {
      vscode.window.showErrorMessage(result.message);
    }
  });

  // Watch for new JSONL data
  const claudeGlob = new vscode.RelativePattern(
    vscode.Uri.file(path.join(os.homedir(), '.claude', 'projects')),
    '**/*.jsonl'
  );
  const watcher = vscode.workspace.createFileSystemWatcher(claudeGlob);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let quotaDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  const debouncedRefresh = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => refreshUsage(), 500);
    // Quota 1 s after the last JSONL write: the bridge file (preferred source) is
    // refreshed by Claude Code every turn and reading it is a local file stat; the
    // endpoint fallback rate-limits itself to one call per 180 s regardless.
    if (quotaDebounceTimer) clearTimeout(quotaDebounceTimer);
    quotaDebounceTimer = setTimeout(() => refreshQuota(), 1_000);
  };
  watcher.onDidChange(debouncedRefresh, null, context.subscriptions);
  watcher.onDidCreate(debouncedRefresh, null, context.subscriptions);
  context.subscriptions.push(watcher);

  // Re-render on settings changes so format/title toggles apply without a reload.
  // Cheap: both consumers read from the cached summary, no rescan.
  vscode.workspace.onDidChangeConfiguration(e => {
    if (!e.affectsConfiguration('clusage')) return;
    if (lastSummary) {
      statusBar?.update(lastSummary, lastQuota);
      refreshDashboard(lastSummary, lastQuota);
    }
  }, null, context.subscriptions);

  // Poll quota every 5 minutes as a fallback when Claude Code is idle
  const quotaInterval = setInterval(() => refreshQuota(), 5 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(quotaInterval) });

  // Initial load - quota first so the panel shows it immediately
  refreshUsage();
  refreshQuota();
}

export function deactivate(): void {
  if (resetRefreshTimer) clearTimeout(resetRefreshTimer);
  // The debounced persist may still be pending; deactivate gets no second chance,
  // so write synchronously now or the next window starts cold again.
  flushParseCache();
  statusBar?.dispose();
}
