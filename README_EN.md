# Sansheng Usage · Claude Code usage monitor

[中文](./README.md) | **English**

See Claude Code spending, tokens and quota in real time, in the VS Code status bar and a dashboard (the dashboard interface is in Chinese).

> **Not an official Anthropic product and not affiliated with Anthropic.** "Claude" and "Claude Code" are trademarks of Anthropic, used here only to describe what this extension works with (for Claude Code).
>
> This extension is a fork of [AjaySingh10/clusage](https://github.com/AjaySingh10/clusage) (MIT), with extensive changes (see below).

---

![Status bar: spending plus 5h/7d quota progress bars and reset countdowns](https://sanshengai.top/sansheng-usage/statusbar.png)

![Dashboard overview: today/total spending and tokens, burn rate and limit forecast, 90-day activity heatmap](https://sanshengai.top/sansheng-usage/overview.png)

![Project view: spending broken down by project, sortable and filterable](https://sanshengai.top/sansheng-usage/projects.png)

## What it does

**Status bar** (usage at a glance)
- Today's spending and today's tokens
- Progress bars, percentages and reset countdowns for both the 5h and 7d quota windows (`5h「1h 54m」██████░░ 71%`)
- Three colour levels: amber past 70%, orange past 80%, red past 90%; **each window is graded on its own usage**, and spending never changes colour
- Don't want the colours? Turn them off with one switch and keep your theme's colours

**Dashboard** (click the status bar to open)
- Overview of total / today / this week / this month spending
- **5h / 7d burn rate and limit forecast**: `~19%/h · ~95% at window end`, shown in red when close to the limit (`⚠ limit in 1h20m`), calculated from the official quota rather than an estimate
- **Cache hit rate**: how much you are saving
- **90-day activity heatmap**: GitHub-style, to see your usage rhythm at a glance
- Breakdown by project / session / model, sortable and filterable
- Sessions labelled by conversation title (instead of rows of identically named projects)

**Privacy**
- **Hide spending with one click**: every dollar amount becomes `$•••` while tokens and percentages stay; safe for screenshots, live streams and demos (amounts are not even left in the DOM source)

---

## Install

Search for it in the VS Code Extensions marketplace, or use a packaged `.vsix`:

```
code --install-extension 叁笙用量-<version>.vsix
```

Once installed, usage appears in the status bar; click it to open the dashboard.

---

## Where the quota data comes from (important)

The 5h/7d quota percentages are the real subscription quota values. The extension reads them "bridge first, endpoint as fallback":

1. **statusline bridge (recommended, zero requests, zero risk)**: every turn, Claude Code feeds quota data to its statusline command. Run **"Claude 用量：安装 statusline 桥"** (install statusline bridge) from the Command Palette and the extension installs a wrapper script that saves this official data to disk for the extension to read, **while still forwarding it to your existing statusline (such as ccstatusline, which is not replaced)**. This path never touches your login credentials and sends no requests. Pro/Max subscriptions only, and it only updates while Claude Code is running.
2. **Read-only endpoint fallback**: when the bridge is missing or has not updated for more than 5 minutes (Claude Code idle), the extension reads Anthropic's read-only `/api/oauth/usage` endpoint instead (cached, with backoff, and never making any billable request).

> ⚠️ The endpoint fallback reuses your local Claude Code login credentials to call an undocumented endpoint. This is a grey area, and Anthropic's terms discourage third parties from reusing subscription credentials. **Installing the statusline bridge keeps everything on the official channel and avoids this.** Spending and token figures always come from the local logs in `~/.claude/projects/`; purely local, nothing uploaded.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `clusage.statusBar.format` | `compact` | Status bar style: `compact` / `bar` / `cost` |
| `clusage.statusBar.barWidth` | `6` | Progress bar width in characters for the `bar` style (3–20) |
| `clusage.statusBar.showResets` | `false` | Show reset countdowns next to the windows |
| `clusage.statusBar.showTodayTokens` | `false` | Show today's token count next to spending |
| `clusage.statusBar.colorOnHighUsage` | `true` | Change colour at high usage (off keeps the theme colours) |
| `clusage.hideCost` | `false` | Hide all dollar amounts (for screenshots and live streams) |
| `clusage.sessions.showTitles` | `true` | Label session rows with conversation titles |

---

## What changed from upstream

Built on [AjaySingh10/clusage](https://github.com/AjaySingh10/clusage): three status bar styles with independent three-level colours per window; session title labels and correct attribution by the model of your own conversations; reset countdowns and today's tokens; a hide-spending switch; 5h/7d burn rate and limit forecast; cache hit rate; a 90-day activity heatmap; the statusline bridge (a zero-request quota source) with one-click install; a read-only endpoint data source (replacing the original approach of sending billable requests to measure quota); an incremental scan cache (refreshes about two orders of magnitude faster with long histories); a dashboard XSS fix; and a fully Chinese interface.

## Credits and license

Forked from [AjaySingh10/clusage](https://github.com/AjaySingh10/clusage); thanks to the original author. MIT licensed, with the upstream copyright notice retained; see the `LICENSE` file in the extension package for the full license.
