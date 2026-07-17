# 叁笙用量 · Claude Code 用量监控

在 VS Code 状态栏和一个中文看板里，实时看清 Claude Code 的花费、token 和额度。

> **非 Anthropic 官方产品，与 Anthropic 无隶属关系。** 「Claude」「Claude Code」为 Anthropic 商标，此处仅用于说明本扩展的适用对象（for Claude Code）。
>
> 本扩展 fork 自 [AjaySingh10/clusage](https://github.com/AjaySingh10/clusage)（MIT），在其基础上做了大量改造（见下）。

---

## 能做什么

**状态栏**（一眼看用量）
- 今日花费 + 今日 token
- 5h / 7d 两个额度窗口的进度条、百分比、重置倒计时（`5h「1h 54m」██████░░ 71%`）
- 三档变色：过 70% 琥珀、80% 橙、90% 红；**两个窗口各按自己的用量独立判档**，花费永不变色
- 不想被变色打扰？一个开关关掉，保持主题原色

**看板**（点状态栏打开）
- 累计 / 今日 / 本周 / 本月 花费概览
- **5h / 7d 燃烧率与触顶预测**：`~19%/h · 窗口末 ~95%`，快触顶时标红 `⚠ 1h20m 后触顶`——用官方权威额度算，非估算
- **缓存命中率**：看你有多省
- **90 天活动热力图**：GitHub 式，一眼看用量节奏
- 按项目 / 会话 / 模型 拆解，可排序、可筛选
- 会话按对话标题标注（不再是一堆同名项目行）

**隐私**
- **一键隐藏花费**：所有美元变 `$•••`，token / 百分比照旧——截图、直播、演示不暴露花费（连 DOM 源里都不留金额）

---

## 安装

从 VS Code 扩展市场搜索安装，或用打好的 `.vsix`：

```
code --install-extension 叁笙用量-<版本>.vsix
```

装好后状态栏即出现用量；点它打开看板。

---

## 额度数据从哪来（重要）

5h/7d 额度百分比是订阅额度真值，本扩展按「桥优先 + 端点兜底」取：

1. **statusline 桥（推荐，零请求零风险）**：Claude Code 每回合会把额度数据喂给它的 statusline 命令。运行命令面板里的 **「Claude 用量：安装 statusline 桥」**，扩展会装一个包装脚本，把这份官方数据落盘供扩展读取，并**继续转发给你原有的 statusline（如 ccstatusline，不会顶掉）**。此路完全不碰你的登录凭证、不发任何请求。仅 Pro/Max 订阅、且只在 Claude Code 运行时更新。
2. **只读端点兜底**：桥不在或超过 5 分钟没更新（Claude Code 空闲）时，扩展改读 Anthropic 的 `/api/oauth/usage` 只读端点（带缓存、带退避、不产生任何计费请求）。

> ⚠️ 端点兜底会复用你本机 Claude Code 的登录凭证访问一个未公开接口。这属灰色地带、Anthropic 条款不鼓励第三方复用订阅凭证。**装了 statusline 桥即可完全走官方通道、规避这一点**。花费与 token 一律来自本机 `~/.claude/projects/` 日志，纯本地、不上传。

---

## 设置

| 设置项 | 默认 | 说明 |
|---|---|---|
| `clusage.statusBar.format` | `compact` | 状态栏形态：`compact` / `bar` / `cost` |
| `clusage.statusBar.barWidth` | `6` | `bar` 形态进度条字符宽度（3–20） |
| `clusage.statusBar.showResets` | `false` | 在窗口旁显示重置倒计时 |
| `clusage.statusBar.showTodayTokens` | `false` | 花费旁显示今日 token 数 |
| `clusage.statusBar.colorOnHighUsage` | `true` | 高用量变色（关掉则保持主题原色） |
| `clusage.hideCost` | `false` | 隐藏所有美元金额（截图/直播用） |
| `clusage.sessions.showTitles` | `true` | 会话行用对话标题标注 |

---

## 相对上游做了什么

在 [AjaySingh10/clusage](https://github.com/AjaySingh10/clusage) 基础上：状态栏三形态与分窗三档独立变色、会话标题标注与「按本人对话的模型」正确归属、reset 倒计时与今日 token、隐藏花费开关、5h/7d 燃烧率与触顶预测、缓存命中率、90 天活动热力图、statusline 桥（零请求额度源）+ 一键安装、只读端点数据源（去掉了原先「发计费请求测额度」的做法）、增量扫描缓存（大历史下刷新快约两个数量级）、看板 XSS 修复、全中文界面。

## 致谢与许可

Fork 自 [AjaySingh10/clusage](https://github.com/AjaySingh10/clusage)，感谢原作者。MIT 许可，保留上游版权声明，见 [LICENSE](LICENSE)。
