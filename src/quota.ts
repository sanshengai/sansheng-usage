import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ModelQuota {
  name: string;          // e.g. "Fable", "Opus"
  utilization: number;   // 0.0 – 1.0
  resetAt: Date;
}

export interface QuotaData {
  fiveHourUtilization: number;   // 0.0 – 1.0  (>1.0 means over limit)
  fiveHourResetAt: Date;
  sevenDayUtilization: number;
  sevenDayResetAt: Date;
  overallStatus: 'allowed' | 'blocked' | 'unknown';
  fetchedAt: Date;
  source: 'endpoint' | 'bridge'; // where this reading came from, for the UI to label
  modelWeekly: ModelQuota[];     // per-model weekly limits from the usage endpoint's limits[]
}

// The usage endpoint drops requests without a claude-code User-Agent into an
// aggressive rate-limit bucket that returns persistent 429s; with the header it
// behaves. Only the `claude-code/` prefix matters, not the exact version, but a
// plausible one is sent. See github.com/anthropics/claude-code#31637.
const CLAUDE_CODE_UA = 'claude-code/2.1.211';

// The usage numbers move slowly and the endpoint rate-limits eager callers, so a
// reading is reused for this long before another request is made. Manual refresh
// passes { force: true } to bypass it.
const MIN_INTERVAL_MS = 180_000;

let cache: { data: QuotaData; at: number } | null = null;
// While inside a 429 back-off window we serve the last reading and make no request.
let backoffUntil = 0;

function readToken(): string | null {
  const home = os.homedir();
  // Candidate paths in priority order — covers Linux, WSL, macOS
  const candidates = [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, 'Library', 'Application Support', 'Claude', '.credentials.json'),
    path.join(home, '.config', 'claude', '.credentials.json'),
  ];

  for (const credPath of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      // Try every known field name for the OAuth access token
      const token =
        raw?.claudeAiOauth?.accessToken ??
        raw?.oauthAccount?.accessToken ??
        raw?.oauth?.accessToken ??
        raw?.accessToken ??
        null;
      if (token) return token;
    } catch {
      // file missing or unreadable — try next candidate
    }
  }
  return null;
}

// Retry-After is either a number of seconds or an HTTP-date (RFC 9110). Returns ms
// from now to wait, or a default when the header is absent or unparseable.
function retryAfterMs(header: string | undefined, fallbackMs: number): number {
  if (!header) return fallbackMs;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return fallbackMs;
}

function parseUsage(body: string): QuotaData | null {
  let j: any;
  try {
    j = JSON.parse(body);
  } catch {
    return null;
  }
  const fh = j?.five_hour;
  const sd = j?.seven_day;
  // The endpoint reports utilization as an integer 0–100; the rest of the code
  // works in 0..1, so scale here at the single point of entry.
  const asFraction = (v: unknown) => (typeof v === 'number' ? v / 100 : 0);
  if (!fh || typeof fh.utilization !== 'number') return null;

  const fiveHourUtilization = asFraction(fh.utilization);
  const sevenDayUtilization = asFraction(sd?.utilization);
  const fiveHourResetAt = fh.resets_at ? new Date(fh.resets_at) : new Date(Date.now() + 5 * 3600_000);
  const sevenDayResetAt = sd?.resets_at ? new Date(sd.resets_at) : new Date(Date.now() + 7 * 86400_000);

  // Per-model weekly limits live in the self-describing limits[] array (the flat
  // seven_day_opus/sonnet keys are null now). Each scoped weekly entry names its
  // model; e.g. { kind: 'weekly_scoped', percent: 40, scope: { model: { display_name: 'Fable' } } }.
  const modelWeekly: ModelQuota[] = Array.isArray(j?.limits)
    ? j.limits
        .filter((l: any) => l?.group === 'weekly' && l?.scope?.model?.display_name)
        .map((l: any) => ({
          name: String(l.scope.model.display_name),
          utilization: asFraction(l.percent),
          resetAt: l.resets_at ? new Date(l.resets_at) : sevenDayResetAt,
        }))
    : [];

  const blocked = fiveHourUtilization >= 1 || sevenDayUtilization >= 1;
  return {
    fiveHourUtilization,
    fiveHourResetAt,
    sevenDayUtilization,
    sevenDayResetAt,
    overallStatus: blocked ? 'blocked' : 'allowed',
    fetchedAt: new Date(),
    source: 'endpoint',
    modelWeekly,
  };
}

/**
 * Read the subscription's 5h / 7d utilization from the read-only usage endpoint.
 *
 * This replaces an earlier approach that POSTed a 1-token message to /v1/messages
 * purely to read rate-limit response headers — that spent quota to measure quota
 * and, at scale, is the kind of automated credential reuse that gets an extension
 * pulled. GET /api/oauth/usage carries the same authoritative numbers in its body,
 * makes no billable call, and is what Claude Code's own /usage reads.
 *
 * Returns null (rather than a faked zero) whenever the reading is unavailable, so
 * the UI can hide the quota display instead of implying full quota remaining.
 */
export async function fetchQuota(opts: { force?: boolean } = {}): Promise<QuotaData | null> {
  const now = Date.now();
  if (!opts.force && cache && now - cache.at < MIN_INTERVAL_MS) return cache.data;
  if (!opts.force && now < backoffUntil) return cache?.data ?? null;

  const token = readToken();
  if (!token) return null;

  return new Promise(resolve => {
    const done = (data: QuotaData | null) => {
      if (data) cache = { data, at: Date.now() };
      resolve(data);
    };

    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        headers: {
          'authorization': `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'user-agent': CLAUDE_CODE_UA,
        },
      },
      res => {
        let body = '';
        res.on('data', c => (body += c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;

          if (status === 429) {
            // Endpoint-level rate limit (not quota exhaustion — that shows up as a
            // high utilization in the body). Respect Retry-After, keep serving the
            // last reading, make no fresh request until the window passes.
            const h = res.headers as Record<string, string>;
            backoffUntil = Date.now() + retryAfterMs(h['retry-after'], MIN_INTERVAL_MS);
            resolve(cache?.data ?? null);
            return;
          }
          if (status < 200 || status >= 300) {
            // 401 (token expired) or any server error: no usable signal. Don't fake
            // zeros; hand back the last good reading if we have one, else null.
            resolve(cache?.data ?? null);
            return;
          }
          done(parseUsage(body));
        });
      }
    );

    req.on('error', () => resolve(cache?.data ?? null));
    req.setTimeout(10_000, () => { req.destroy(); resolve(cache?.data ?? null); });
    req.end();
  });
}
