import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as os from 'os';

export interface UsageRecord {
  timestamp: Date;
  sessionId: string;
  projectPath: string;
  model: string;
  /**
   * True for rows a subagent produced. Those carry the sessionId of the
   * conversation that launched them, so they are indistinguishable from the main
   * conversation's own rows by sessionId alone.
   */
  isSidechain: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;   // total: 5m + 1h (for display/aggregation)
  cacheWrite5mTokens: number; // priced at 1.25× base input
  cacheWrite1hTokens: number; // priced at 2.0× base input
  costUSD: number;
}

// Claude Code names each conversation and stores it right in the transcript:
//   {"type":"ai-title","aiTitle":"...","sessionId":"..."}       - auto-generated
//   {"type":"custom-title","customTitle":"...","sessionId":"..."} - user-renamed
// Both are rewritten on nearly every turn (hundreds of identical rows per file)
// and the two coexist rather than replace each other, so a renamed session keeps
// emitting its old ai-title. Last-one-wins per kind; custom beats ai at display
// time (see resolveSessionTitle) because it is the user's explicit choice.
export interface SessionTitle {
  ai?: string;
  custom?: string;
}

export interface ScanResult {
  records: UsageRecord[];
  titles: Map<string, SessionTitle>;
}

// Per-file parse cache, keyed by absolute path, invalidated by mtime. Lets a
// re-scan re-read only the files that actually changed. Module-level so it
// survives across scanAllProjects calls for the life of the extension host.
const fileCache = new Map<string, { mtimeMs: number; parse: FileParse }>();

// ── Disk persistence for the cache ─────────────────────────────────────────────
// The in-memory cache dies with the extension host, so every new window used to pay
// a full cold parse of the whole history (~40 s on a large one) behind a status-bar
// spinner. Persisting the cache makes a cold start cost roughly one warm scan: load
// the file, then mtime-validate as usual — only files that actually changed since
// the last session get re-read. The format hoists per-file constants (projectPath)
// and stores records as tuples, gzipped; a large history lands in the low MBs.
// Any read/shape problem just means starting cold, exactly like before the cache.
// v2: per-record projectPath via a per-file string table. v1 hoisted one path per
// file, which corrupted per-project attribution (see type comment below); a v1 file
// read with the v2 layout would mis-parse silently, so the version gate must reject it.
const CACHE_VERSION = 2;
let cacheFilePath: string | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
const PERSIST_DEBOUNCE_MS = 60_000;

// A record's projectPath comes from its row's own `cwd` (parser below), and one
// session file spans every directory Claude cd'd through — so the path must be
// stored per record, never hoisted per file. Hoisting it collapsed 446 projects
// into 147 and re-attributed their costs to whichever path came first in the file.
// A per-file string table keeps the size win without the corruption: each record
// carries an index into it.
type CachedRecordTuple = [number, string, string, 0 | 1, number, number, number, number, number, number, number, number];
type CachedFileEntry = [string, number, string[], CachedRecordTuple[], Array<[string, string | undefined, string | undefined]>];

export function initParseCache(storageDir: string): void {
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    cacheFilePath = path.join(storageDir, `parse-cache-v${CACHE_VERSION}.json.gz`);
    if (!fs.existsSync(cacheFilePath)) return;
    const zlib = require('zlib') as typeof import('zlib');
    const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(cacheFilePath)).toString('utf8'));
    if (raw?.v !== CACHE_VERSION || !Array.isArray(raw.files)) return;
    for (const [p, mtimeMs, paths, recs, titles] of raw.files as CachedFileEntry[]) {
      const records: UsageRecord[] = recs.map(
        ([t, sid, model, side, inp, out, cr, cw, c5, c1, cost, pIdx]) => ({
          timestamp: new Date(t), sessionId: sid, projectPath: paths[pIdx] ?? '', model,
          isSidechain: side === 1,
          inputTokens: inp, outputTokens: out, cacheReadTokens: cr,
          cacheWriteTokens: cw, cacheWrite5mTokens: c5, cacheWrite1hTokens: c1,
          costUSD: cost,
        })
      );
      const titlePairs: Array<[string, SessionTitle]> = titles.map(
        ([sid, ai, custom]) => [sid, { ai, custom }]
      );
      fileCache.set(p, { mtimeMs, parse: { records, titles: titlePairs } });
    }
  } catch (err) {
    fileCache.clear();
    console.error('[clusage] parse cache load failed, starting cold:', err);
  }
}

function schedulePersist(): void {
  if (!cacheFilePath) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persistTimer = undefined; flushParseCache(); }, PERSIST_DEBOUNCE_MS);
}

/** Synchronous write; also called from deactivate() where async work is not awaited. */
export function flushParseCache(): void {
  if (!cacheFilePath) return;
  try {
    const files: CachedFileEntry[] = [];
    for (const [p, { mtimeMs, parse }] of fileCache) {
      const paths: string[] = [];
      const pathIdx = new Map<string, number>();
      const idxOf = (pp: string): number => {
        let i = pathIdx.get(pp);
        if (i === undefined) { i = paths.length; paths.push(pp); pathIdx.set(pp, i); }
        return i;
      };
      files.push([
        p, mtimeMs, paths,
        parse.records.map((r): CachedRecordTuple => [
          r.timestamp.getTime(), r.sessionId, r.model, r.isSidechain ? 1 : 0,
          r.inputTokens, r.outputTokens, r.cacheReadTokens,
          r.cacheWriteTokens, r.cacheWrite5mTokens, r.cacheWrite1hTokens, r.costUSD,
          idxOf(r.projectPath),
        ]),
        parse.titles.map(([sid, t]): [string, string | undefined, string | undefined] => [sid, t.ai, t.custom]),
      ]);
    }
    const zlib = require('zlib') as typeof import('zlib');
    const body = zlib.gzipSync(Buffer.from(JSON.stringify({ v: CACHE_VERSION, files }), 'utf8'));
    const tmp = `${cacheFilePath}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, cacheFilePath);
  } catch (err) {
    console.error('[clusage] parse cache persist failed:', err);
  }
}

/** custom > ai > undefined. Callers fall back to the project name. */
export function resolveSessionTitle(t: SessionTitle | undefined): string | undefined {
  return t?.custom || t?.ai || undefined;
}

// Per-million-token prices: [input, output, cacheWrite5m, cacheWrite1h, cacheRead]
// More-specific prefixes MUST come before broader ones (startsWith matching).
const PRICING_TABLE: Array<[string, number, number, number, number, number]> = [
  // Fable 5 - $10 / $50
  ['claude-fable-5',    10,    50,  12.50,  20,   1.00],
  // Opus 4.8 - $5 / $25 (must precede 'claude-opus-4')
  ['claude-opus-4-8',    5,    25,   6.25,  10,   0.50],
  // Opus 4.5 / 4.6 / 4.7 - repriced at $5 / $25 (must precede 'claude-opus-4')
  ['claude-opus-4-5',    5,    25,   6.25,  10,   0.50],
  ['claude-opus-4-6',    5,    25,   6.25,  10,   0.50],
  ['claude-opus-4-7',    5,    25,   6.25,  10,   0.50],
  // Opus 4 (deprecated) and 4.1 - original $15 / $75 tier
  ['claude-opus-4',     15,    75,  18.75,  30,   1.50],
  // Sonnet 4.x - $3 / $15
  ['claude-sonnet-4',    3,    15,   3.75,   6,   0.30],
  // Haiku 4.5 - repriced at $1 / $5 (must precede 'claude-haiku-4')
  ['claude-haiku-4-5',   1,     5,   1.25,   2,   0.10],
  // Generic Haiku 4.x fallback
  ['claude-haiku-4',     1,     5,   1.25,   2,   0.10],
  // Claude 3.x legacy - new-style IDs first (claude-haiku-3-5-*)
  ['claude-haiku-3-5',   0.8,   4,   1.00,  1.60, 0.08],
  ['claude-3-opus',     15,    75,  18.75,  30,   1.50],
  ['claude-3-5-sonnet',  3,    15,   3.75,   6,   0.30],
  ['claude-3-5-haiku',   0.8,   4,   1.00,  1.60, 0.08],
  ['claude-3-sonnet',    3,    15,   3.75,   6,   0.30],
  ['claude-3-haiku',    0.25, 1.25, 0.3125, 0.50, 0.025],
];
const DEFAULT_PRICING: [number, number, number, number, number] = [3, 15, 3.75, 6, 0.30];

function getPricing(model: string): [number, number, number, number, number] {
  for (const [prefix, input, output, cacheWrite5m, cacheWrite1h, cacheRead] of PRICING_TABLE) {
    if (model.startsWith(prefix)) {
      return [input, output, cacheWrite5m, cacheWrite1h, cacheRead];
    }
  }
  return DEFAULT_PRICING;
}

function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheWrite5mTokens: number,
  cacheWrite1hTokens: number,
  cacheReadTokens: number
): number {
  const [inputPrice, outputPrice, cacheWrite5mPrice, cacheWrite1hPrice, cacheReadPrice] = getPricing(model);
  const M = 1_000_000;
  return (
    (inputTokens        * inputPrice)       / M +
    (outputTokens       * outputPrice)      / M +
    (cacheWrite5mTokens * cacheWrite5mPrice) / M +
    (cacheWrite1hTokens * cacheWrite1hPrice) / M +
    (cacheReadTokens    * cacheReadPrice)   / M
  );
}

// One file's parse: the records it yielded and the session titles it declared.
// A file owns both, so a cached parse can be replayed without re-reading the file
// and without a shared map being mutated as a side effect.
interface FileParse {
  records: UsageRecord[];
  titles: Array<[string, SessionTitle]>;
}

async function readJsonlFile(
  filePath: string,
  projectPath: string
): Promise<FileParse> {
  const records: UsageRecord[] = [];
  const titles = new Map<string, SessionTitle>();
  const empty: FileParse = { records, titles: [] };

  // A real transcript is a few MB at most (the largest seen in practice is single
  // digits). A file orders of magnitude larger is corrupt — most dangerously one
  // written as a single enormous line, which readline would buffer whole into
  // memory before we could look at it. Skip such files rather than risk the OOM.
  const MAX_FILE_BYTES = 200 * 1024 * 1024;
  try {
    if (fs.statSync(filePath).size > MAX_FILE_BYTES) return empty;
  } catch {
    return empty;
  }

  // Claude Code appends the same final assistant message multiple times under different
  // outer UUIDs. Deduplicate by the inner message.id so each API response is counted once.
  const seenMsgIds = new Set<string>();

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);

      // Title rows carry their own sessionId and no usage — harvest and move on.
      // Only main-session transcripts contain them; subagent transcripts under
      // <sessionId>/subagents/ carry the parent sessionId on their usage rows, so
      // their tokens roll up into the parent session without needing a title here.
      if (obj.type === 'ai-title' || obj.type === 'custom-title') {
        const sid: string = obj.sessionId ?? '';
        const value: unknown = obj.type === 'ai-title' ? obj.aiTitle : obj.customTitle;
        if (sid && typeof value === 'string' && value.trim()) {
          const entry = titles.get(sid) ?? {};
          if (obj.type === 'ai-title') entry.ai = value;
          else entry.custom = value;
          titles.set(sid, entry);
        }
        continue;
      }

      if (obj.type !== 'assistant') continue;

      const msg = obj.message;
      if (!msg?.usage) continue;

      // Skip streaming intermediates - stop_reason is null until the final chunk.
      if (msg.stop_reason === null || msg.stop_reason === undefined) continue;

      // Skip duplicates - Claude Code writes the same final message several times.
      const msgId: string = msg.id ?? '';
      if (msgId) {
        if (seenMsgIds.has(msgId)) continue;
        seenMsgIds.add(msgId);
      }

      const usage = msg.usage;
      const inputTokens = usage.input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

      // Split cache writes by tier - 1h writes cost 2× base input, 5m writes cost 1.25×.
      // Claude Code exclusively uses 1h caching; the sub-object is present in all known
      // JSONL versions, but we fall back gracefully when it's absent.
      const cc = usage.cache_creation ?? {};
      const cacheWrite5mTokens: number = cc.ephemeral_5m_input_tokens ?? 0;
      const cacheWrite1hTokens: number = cc.ephemeral_1h_input_tokens ?? (usage.cache_creation_input_tokens ?? 0);
      const cacheWriteTokens = cacheWrite5mTokens + cacheWrite1hTokens;

      if (inputTokens === 0 && outputTokens === 0 && cacheWriteTokens === 0 && cacheReadTokens === 0) {
        continue;
      }

      const projectDir = obj.cwd ?? projectPath;
      const model: string = msg.model ?? 'unknown';

      const costUSD = computeCost(model, inputTokens, outputTokens, cacheWrite5mTokens, cacheWrite1hTokens, cacheReadTokens);

      records.push({
        timestamp: new Date(obj.timestamp ?? Date.now()),
        sessionId: obj.sessionId ?? '',
        projectPath: projectDir,
        model,
        // Absent on old transcripts, where nothing was a subagent anyway.
        isSidechain: obj.isSidechain === true,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        cacheWrite5mTokens,
        cacheWrite1hTokens,
        costUSD,
      });
    } catch {
      // Skip malformed lines
    }
  }

  return { records, titles: [...titles] };
}

// Recursively collect every *.jsonl under a project directory. Claude Code
// nests subagent transcripts under <sessionId>/subagents/, so a flat readdir
// would miss them.
function collectJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

export async function scanAllProjects(): Promise<ScanResult> {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  const allRecords: UsageRecord[] = [];
  const titles = new Map<string, SessionTitle>();

  let projectDirs: string[];
  try {
    // withFileTypes reads each entry's type from the directory read itself, so a
    // single entry vanishing or being unreadable mid-scan can't throw the way a
    // per-entry statSync could — which used to abort the whole scan and blank the
    // dashboard, rather than just skipping the one directory.
    projectDirs = fs.readdirSync(claudeDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return { records: allRecords, titles };
  }

  const seenPaths = new Set<string>();

  for (const projectDir of projectDirs) {
    const projectPath = '/' + projectDir.replace(/^-/, '').replace(/-/g, '/');
    const dirPath = path.join(claudeDir, projectDir);

    for (const filePath of collectJsonlFiles(dirPath)) {
      seenPaths.add(filePath);

      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        continue; // vanished between listing and stat
      }

      // A transcript is append-only, so an unchanged mtime means an unchanged
      // parse. Reuse it: the watcher fires this scan on every JSONL append, and
      // re-reading the whole ~4.5 GB history each time is the tool's worst cost.
      let parse: FileParse | undefined = fileCache.get(filePath)?.mtimeMs === mtimeMs
        ? fileCache.get(filePath)!.parse
        : undefined;
      if (!parse) {
        try {
          parse = await readJsonlFile(filePath, projectPath);
        } catch {
          continue; // unreadable file
        }
        fileCache.set(filePath, { mtimeMs, parse });
      }

      allRecords.push(...parse.records);
      for (const [sid, t] of parse.titles) {
        const prev = titles.get(sid);
        // custom > ai; merge field-wise so neither kind clobbers the other.
        titles.set(sid, { ai: t.ai ?? prev?.ai, custom: t.custom ?? prev?.custom });
      }
    }
  }

  // Drop cache entries for files that no longer exist so the map can't grow without
  // bound as sessions come and go.
  for (const key of fileCache.keys()) {
    if (!seenPaths.has(key)) fileCache.delete(key);
  }

  // Persist after the prune so the snapshot only ever holds live files. Debounced:
  // while Claude streams, scans land every turn and a multi-MB gzip write per turn
  // would cost more than the cache saves.
  schedulePersist();

  return { records: allRecords, titles };
}
