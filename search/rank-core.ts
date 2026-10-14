/**
 * rank-core.ts — retrieval quality core
 *
 * Keyword block: qmd's BM25 is AND-semantics and does not strip function words
 *   (buildFTS5Query joins all terms with ' AND '), so a long natural-language
 *   question almost always returns zero hits. extractKeywords splits the question
 *   into content keywords; callers run one query per keyword and merge with RRF,
 *   which is equivalent to OR plus weighting.
 * Weights block: applyWeights — the observed failure mode is dilution by "grab-bag"
 *   files (whole chat exports, month-long logs, archives), not by age.
 *   So the main lever is down-weighting bulk dump files and slightly up-weighting
 *   curated cards; recency is only a small tiebreak, not a strong decay
 *   (the correct answer is often an old file, and strong decay would hurt).
 * RRF block: rrfMerge weights — why queryPipeline does not push the lexical lane into
 *   qmd's internal multi-lane RRF (vote imbalance):
 *     expanding lexical from one lane to four (one per keyword) gives BM25 hits
 *     (usually short, specific terms) four votes in qmd's internal RRF and dilutes
 *     the correct semantic hit out of the top ranks.
 *     Fix: keep a single lex lane (the whole sentence) inside qmd query and do the
 *     BM25 contribution in an outer weighted rrfMerge — semantic votes weigh 1.0,
 *     BM25 votes weigh 0.5, so BM25 only fills in when semantic search finds nothing.
 *
 * Rollback: set all WEIGHTS factors to 1, RECENCY_TIEBREAK to 0, and have the
 *   extractKeywords caller go back to a single query to restore the old behaviour.
 */

// ── node module imports ─────────────────────────────────────────────────────
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'

// ── keyword extraction ───────────────────────────────────────────────────────

// Function words act as separators. The single-character set deliberately avoids
// characters that commonly form content words.
const STOP_CHARS = new Set(
  '的了是在有很也就都不我你他她它們這那個跟和與但沒到要會能嗎呢吧啊喔耶哦欸啦嘛呀唷又再先只把被讓對從當比較還或者如果因為所以然後其實可能應該覺得知道記得幫請問想找查'.split('')
)
const STOP_WORDS = new Set([
  '一間', '一個', '一下', '一份', '那個', '這個', '什麼', '哪裡', '哪個', '怎麼', '如何',
  '有沒有', '是不是', '之前', '後來', '時候', '好像', '大概', '同時', '旁邊',
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'is', 'was', 'that',
])

/** Split a natural-language question into content keywords (longer first, at most `cap`). */
export function extractKeywords(query: string, cap = 6): string[] {
  const runs: string[] = []
  let buf = ''
  const flush = () => {
    if (buf) { runs.push(buf); buf = '' }
  }
  for (const ch of query) {
    if (/[\s\p{P}]/u.test(ch) || STOP_CHARS.has(ch)) flush()
    else buf += ch
  }
  flush()
  const seen = new Set<string>()
  const kept: string[] = []
  for (const r of runs) {
    const t = r.trim()
    if (t.length < 2) continue // single characters are too generic; BM25 noise
    if (STOP_WORDS.has(t.toLowerCase())) continue
    if (seen.has(t)) continue
    seen.add(t)
    kept.push(t)
  }
  // Longer terms are more specific, keep them first; equal length keeps original order (stable sort)
  return kept.sort((a, b) => b.length - a.length).slice(0, cap)
}

// ── result parsing ───────────────────────────────────────────────────────────

export interface RankedDoc {
  path: string      // qmd://collection/path (without the :line suffix)
  score: number     // engine score (0-1) or RRF fused score
  block?: string    // raw output block (Title/Score/context, for MCP display)
}

/** Parse block output (qmd search/query/vsearch without --files).
 *  The first line of a block looks like `qmd://vault/x/y.md:17 #de6d3b`; the Score line like `Score:  95%`. */
export function parseBlocks(raw: string): RankedDoc[] {
  const out: RankedDoc[] = []
  for (const block of raw.split(/\n\n(?=qmd:\/\/)/)) {
    const b = block.trim()
    if (!b) continue
    const head = b.match(/^(qmd:\/\/\S+?)(?::\d+)?\s+#/m)
    if (!head) continue
    const scoreM = b.match(/^Score:\s*(\d+)%/m)
    out.push({ path: head[1], score: scoreM ? Number(scoreM[1]) / 100 : 0, block: b })
  }
  return out
}

/** Parse --files output (`#hash,0.95,qmd://...`, one hit per line). */
export function parseFilesLines(raw: string): RankedDoc[] {
  const out: RankedDoc[] = []
  for (const line of raw.split('\n')) {
    const m = line.match(/^#\w+,([\d.]+),(qmd:\/\/\S+)/)
    if (m) out.push({ path: m[2].replace(/:\d+$/, ''), score: Number(m[1]) })
  }
  return out
}

// ── RRF merge ────────────────────────────────────────────────────────────────

/** Reciprocal Rank Fusion. Each input list is already sorted by its own lane;
 *  returns a de-duplicated list sorted by fused score.
 *  For the same path, the first version that carries a block wins; k=60 is the conventional value.
 *  weights?: per-lane vote weight (default all 1); omitted = original behaviour.
 *  When merging a "semantic list" with a "BM25 fill-in list", semantic votes weigh 1.0
 *  and BM25 votes 0.5, so BM25 only fills in when semantic search finds nothing
 *  instead of overriding it (see the queryPipeline comment). */
export function rrfMerge(lists: RankedDoc[][], k = 60, weights?: number[]): RankedDoc[] {
  const w = weights ?? lists.map(() => 1)
  const acc = new Map<string, RankedDoc & { rrf: number }>()
  lists.forEach((list, li) => {
    const lw = w[li] ?? 1
    list.forEach((doc, idx) => {
      const prev = acc.get(doc.path)
      const inc = lw / (k + idx + 1)
      if (prev) {
        prev.rrf += inc
        if (!prev.block && doc.block) prev.block = doc.block
      } else {
        acc.set(doc.path, { ...doc, rrf: inc })
      }
    })
  })
  return [...acc.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .map(({ rrf, ...doc }) => ({ ...doc, score: rrf }))
}

// ── weights by document type + recency tiebreak ─────────────────────────────

/** Weight table. Set everything to 1 (and RECENCY_TIEBREAK to 0) to restore the old behaviour. */
export const WEIGHTS: { pattern: RegExp; factor: number; why: string }[] = [
  // Down-weight grab-bag dump files: whole chat exports, month-long digests, archives —
  // they touch every topic a little and steal rank from the specific card.
  // Note: path rules must carry the `i` flag. qmd keeps the original case in qmd:// paths,
  // while this table is written in lower case; rules that do not match never raise an
  // error, they just never fire and look like "the mechanism has no effect on these files".
  { pattern: /archives\/chats\//i, factor: 0.6, why: 'raw chat dump' },
  { pattern: /claude-export\/[^/]*txt[^/]*\.md$/i, factor: 0.6, why: 'full conversation export' },
  { pattern: /\/40-archive\//i, factor: 0.7, why: 'archive area' },
  { pattern: /\/daily\/\d{4}-\d{2}\.md$/i, factor: 0.7, why: 'month-long digest log' },
  // Slightly up-weight curated cards: distilled content is usually the one being looked for
  { pattern: /\/wiki\/entities\//i, factor: 1.1, why: 'wiki entity card' },
  { pattern: /\/70-insights\//i, factor: 1.1, why: 'insight atom card' },
]
/** On equal scores, slightly favour the most recent; no strong decay.
 *  Multiplies together with decayFactor rather than being replaced by it —
 *  they handle different things; setting this to 0 caused a regression where
 *  a new work item lost to an undated old file.
 *  Setting it to 0 and emptying DECAY_CLASSES restores the original behaviour (rollback). */
export const RECENCY_TIEBREAK = 0.05

// ── block 1: type-specific time decay ───────────────────────────────────────
//
// Polarity is deliberately "no decay by default, decay is an allow-list". An index
// may contain scripts/ skills/ state/ tests/ rules/ wiki/ style directories holding
// "current code and rules"; those must not be down-weighted just because a filename
// carries a date. Better to under-decay than to over-decay — over-decay breaks the
// "old but stable questions must not regress" acceptance rule.
//
// Honest scope: this mechanism only looks at dates **in the path**. Collections whose
// paths rarely carry dates (curated wiki pages, rules, skills) are naturally immune;
// logs, raw captures, archives and tickets usually carry dates and are where it bites.
// For other note collections whose paths rarely carry dates, this mechanism does
// **not** claim to handle their freshness.
//
// Note: write the prefix against the **collection root**, not against the repo's
// directory layout. Daily/tickets/drafts/chatlogs are separate qmd collections, not
// subdirectories of "notes"; a rule written as `qmd://notes/daily/` matches nothing
// and raises no error. Use `qmd ls` to see the collection list.
// Case-insensitive (`i`) for the same reason as above: the index keeps original case.
export const DECAY_CLASSES: { pattern: RegExp; why: string }[] = [
  { pattern: /^qmd:\/\/daily\//i, why: 'daily log: state of that day, not current the next day' },
  { pattern: /^qmd:\/\/chatlogs\//i, why: 'raw chat dump' },
  { pattern: /^qmd:\/\/notes\/cold-storage\//i, why: 'archive area' },
  { pattern: /^qmd:\/\/tickets\//i, why: 'tickets: the newer ticket describes the current approach' },
  { pattern: /^qmd:\/\/drafts\//i, why: 'drafts and review reports: superseded by later versions' },
  { pattern: /^qmd:\/\/vault\/drafts\//i, why: 'drafts and review reports: superseded by later versions' },
  { pattern: /^qmd:\/\/vault\/40-archive\//i, why: 'archive area' },
  { pattern: /^qmd:\/\/vault\/raw\//i, why: 'capture cards: snapshot at the time' },
]
export const DECAY_HALF_LIFE_DAYS = 90
/** Decay floor. Without a floor an old file would be multiplied by a tiny factor and
 *  effectively vanish from the candidate list, but a collection often holds an "old and
 *  unique" correct answer — the only file that ever covered a topic.
 *  Decay should push newer files above older ones on the same topic, not clear old files out. */
export const DECAY_FLOOR = 0.5

/** Returns [DECAY_FLOOR, 1]. Not in the decay list, or no date in the path: always 1 (no decay). */
export function decayFactor(path: string, now = new Date()): number {
  if (!DECAY_CLASSES.some(c => c.pattern.test(path))) return 1
  const d = dateFromPath(path)
  if (!d) return 1
  const age = (now.getTime() - d.getTime()) / 86400000
  if (age <= 0) return 1 // date in the path is in the future (scheduled file): no reward, no penalty
  return DECAY_FLOOR + (1 - DECAY_FLOOR) * Math.pow(0.5, age / DECAY_HALF_LIFE_DAYS)
}

// ── block 3: local down-weighting of daily logs for "current status of a channel" questions ──
//
// Failure mode: for a question like "what is group/channel X doing now", the correct
// answer is a current-status document (channel config, role description, handoff
// ticket), but per-day session logs under daily/ mention that channel every day, in
// such volume that they crowd the status document out. Down-weighting daily/ globally
// would hurt "look back at that day" queries, so this is a **query-classification
// flag**: only when the question contains both a channel word and a status word, and
// it is off by default.
//
// Stacking with the time decay: daily/ is in DECAY_CLASSES (half-life 90 days, floor
// 0.5), and this penalty multiplies by another 0.5, so old daily logs bottom out at
// 0.25 and new ones at 0.5. This is controlled: it is a dedicated path for the
// "channel status" question type, whose correct answer does not live in daily/, and
// other question types are untouched.
// The word list is deliberately conservative: a missed detection only skips one
// down-weighting, while a false detection pushes a correct daily hit down. So bare
// generic words (product line, assembly line) are not included, and neither are
// high-frequency generic words ("still running", "change to"), which would false-trigger
// on questions such as "change this line to cron".
const CHANNEL_TOKENS_CJK = ['群', '頻道', '條線']
const CHANNEL_TOKENS_ASCII = /\b(channel|session)\b/i
const STATE_TOKENS = ['現在', '目前', '現況', '職務', '狀態', '轉任', '負責', '還有在', '管什麼']

/** Channel-status query: counts only when a channel word and a status word **both** appear (either alone is too generic). */
export function isChannelStatusQuery(query: string): boolean {
  const hasChannel = CHANNEL_TOKENS_CJK.some(t => query.includes(t))
    || CHANNEL_TOKENS_ASCII.test(query)
  if (!hasChannel) return false
  return STATE_TOKENS.some(t => query.includes(t))
}

/** Extra down-weight for per-day session logs on channel-status questions. 1 = disabled (rollback). */
export const CHANNEL_STATUS_DAILY_FACTOR = 0.5
/** Only bites per-day session logs (daily/YYYY-MM-DD/...); month-long digests are handled by WEIGHTS. */
// Prefix note: daily is a **separate collection** (qmd://daily/...), not under notes —
// a rule written against the wrong prefix matches nothing and the penalty never fires.
const DAILY_SESSION_LOG_RE = /^qmd:\/\/daily\/\d{4}-\d{2}-\d{2}\//

// ── block 4: time decay for the memories collection ────────────────────────
//
// Why this layer exists (and how it differs from block 1 `decayFactor`):
//   Block 1 decays only when the path contains a date AND matches DECAY_CLASSES. That
//   is for daily/chatlogs/drafts-style content ("state of that day, replaced by later versions").
//   Memory retrieval has a different failure mode: qmd://memories/ holds distilled
//   cards, which should not be skipped just because the path has no date (many memory
//   cards are undated), nor decayed hard just because the path has one.
//   Block 4 treats memories as their own group, uses **only real dates** (from the path
//   or the file header) for half-life decay, and sends missing/bad/future dates to
//   explicit, deterministic buckets (never "treat <=0 as newest").
//
// Scope: only affects the qmd://memories/ prefix. Knowledge collections (qmd://vault/,
//   qmd://notes/, qmd://daily/, ...) keep their original behaviour, **byte-for-byte
//   compatible**, unless a caller explicitly mixes memories into the same result list.
//
// Formula: for a valid past date  f(d) = MEMORY_DECAY_FLOOR + (1 - MEMORY_DECAY_FLOOR) x 0.5^(age/HALF_LIFE)
//   missing/bad date   MISSING_TIMESTAMP_FACTOR (default 0.85; not 1 — "missing" is a signal)
//   future date        FUTURE_TIMESTAMP_FACTOR  (default 0.5; not 1 — a future date usually means a scheduling mistake)
//
// Memory-leg decay is always on in the pipelines (see memoryQueryPipeline). The
// QMD_MEMORY_DECAY environment variable only controls the path-lexicographic tiebreak
// for equal scores in the non-memory leg (see memoryDecayEnabled below). When it is
// off, applyWeights keeps the original behaviour for knowledge results, byte-for-byte.
//
// Tiebreak note: the path tiebreak in sort **must** be wrapped in `memOn`. An
// unconditional (b.score - a.score) || (a.path < b.path ? ...) comparator would reorder
// pure-knowledge ties by path when the flag is off, violating the contract that
// knowledge/non-memory results remain byte/order compatible. So the comparator only
// appends path ordering when memOn is true; otherwise .sort() falls back to the
// native stable sort.
/** Only matches paths starting with `qmd://memories/...`. Case-insensitive (same lesson as block 1). */
export const MEMORY_PATH_RE = /^qmd:\/\/memories\//i
/** Missing-date bucket: explicitly not "newest". Default 0.85 — slightly below new memories but not dropped from the list. */
export const MISSING_TIMESTAMP_FACTOR = 0.85
/** Future-date bucket: scheduled file / data error, explicitly not "newest of the newest".
 *  Default 0.5 — below the missing bucket, since a future date usually means someone
 *  planted a fake latest timestamp, which is higher risk. */
export const FUTURE_TIMESTAMP_FACTOR = 0.5
/** Half-life of the memory group. 30 days — slower than daily, hotter than vault.
 *  Design intent: for the same meaning, a relevant card from the last week should beat
 *  one from a month ago; a 30-day half-life gives about 0.72 at 14 days and 0.5 at 90 days. */
export const MEMORY_HALF_LIFE_DAYS = 30
/** Memory decay floor. Same logic as block 1: decay re-orders, it does not evict. */
export const MEMORY_DECAY_FLOOR = 0.4

// ── memories collection root (read-only) ────────────────────────────────────

/** Local root of the archived-session (memories) collection. Time is read from the file header:
 *  - URI `qmd://memories/md/session-<id>.md` resolves to `${ROOT}md/<file>.md`
 *  - absolute paths and `..` escapes are rejected
 *  - only the first 5 lines are read, looking for `- Taipei time ... — YYYY-MM-DD HH:MM` (end time)
 *  - any parse failure / missing file / escape / bad date -> MISSING_TIMESTAMP_FACTOR
 *
 *  Taipei-time header lines are the only time source for undated memory paths. */
export const MEMORIES_COLLECTION_ROOT =
  process.env.QMD_MEMORIES_ROOT ?? `${process.env.MEMORY_OS_HOME ?? `${process.env.HOME}/.memory-os`}/sessions/`

/** Header line inside qmd://memories/ files: `- 台北時間 YYYY-MM-DD HH:MM — YYYY-MM-DD HH:MM` (Taipei time, UTC+8)
 *  group 3+4 = end date + time; group 1+2 = start (spare). */
const MEMORY_HEADER_DATE_RE =
  /\s*-\s*台北時間\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*—\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/

/** One-time slug -> absolute path index: maps the URI qmd emits (hyphenated file name
 *  session-<id>.md) to the real file on disk (underscored session_<id>.md).
 *
 *  Rule: replace the first `_` in the file name with `-`. The index only trusts the slug
 *  qmd emits and never builds paths by string concatenation.
 *  Index failure / disk unreadable / slug not in the allow-list -> entry is null (fail-closed).
 *
 *  The index is built lazily on first resolveMemoryPath (no start-up I/O); if
 *  MEMORIES_COLLECTION_ROOT does not exist the index is an empty map (still fail-closed).
 *
 *  Version coupling risk: qmd currently normalizes the first underscore of a file name
 *  to a hyphen. If qmd changes that rule later (for example all underscores, or a more
 *  elaborate slug encoding), this index must be re-derived. If the index is empty, the
 *  memory leg falls into the MISSING bucket instead of silently looking healthy. */

/** qmd file-name normalization rule: replace the first `_` with `-`. */
const QMD_SLUG_NORMALIZE_RE = /^([^_]+)_(.+)$/

let _memorySlugIndex: Map<string, string | null> | null = null
let _memorySlugIndexRoot: string | null = null

/** Rebuild the index; do nothing for the same ROOT. On failure (dir missing / readdir error) return an empty map. */
function buildMemorySlugIndex(root: string): Map<string, string | null> {
  if (_memorySlugIndex && _memorySlugIndexRoot === root) return _memorySlugIndex
  _memorySlugIndexRoot = root
  const idx = new Map<string, string | null>()
  try {
    const mdDir = nodePath.resolve(root, 'md')
    const files = nodeFs.readdirSync(mdDir)
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      const m = f.match(QMD_SLUG_NORMALIZE_RE)
      if (!m) continue
      const qmdSlug = `${m[1]}-${m[2]}`                     // file name as qmd emits it
      idx.set(qmdSlug, nodePath.join(mdDir, f))
    }
    // also accept the original on-disk name as a key, so an underscore URI is not misjudged
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      if (!idx.has(f)) idx.set(f, nodePath.join(mdDir, f))
    }
  } catch {
    // failure: empty index; resolveMemoryPath then returns null for everything -> MISSING bucket
  }
  _memorySlugIndex = idx
  return idx
}

/** Safely resolve a `qmd://memories/<rel>` URI to an absolute path under the collection root.
 *  Rejects: absolute <rel>, `..` escapes, URL-encoded escapes, paths outside the collection, unknown slugs.
 *  Returns null on failure; the caller falls into the MISSING_TIMESTAMP_FACTOR bucket.
 *
 *  The qmd URI file name is hyphenated (session-<id>.md) while the on-disk name is
 *  underscored (session_<id>.md), so they cannot be concatenated: look up the last path
 *  segment (basename) in the slug index and return the real absolute path on a hit; null on a miss. */
export function resolveMemoryPath(uri: string): string | null {
  if (typeof uri !== 'string') return null
  if (!uri.startsWith('qmd://memories/')) return null
  const rel = uri.slice('qmd://memories/'.length)
  if (!rel || rel.length > 1024) return null
  // reject absolute paths / NUL / newline (path injection)
  if (rel[0] === '/' || rel.includes('\0') || rel.includes('\n')) return null
  // index lookup — the basename (last segment) is the slug
  const idx = buildMemorySlugIndex(MEMORIES_COLLECTION_ROOT)
  const base = nodePath.basename(rel)
  if (!base || base.includes('\0') || base === '.' || base === '..') return null
  const abs = idx.get(base)
  if (abs === undefined) return null   // slug not in the allow-list -> fail-closed
  if (abs === null) return null        // entry explicitly marked null -> fail-closed
  // the resolved path must still be under ROOT
  const rootNorm = nodePath.resolve(MEMORIES_COLLECTION_ROOT)
  if (abs !== rootNorm && !abs.startsWith(rootNorm + nodePath.sep)) {
    return null
  }
  return abs
}

/** Read the end time from the header of a `qmd://memories/<rel>` file. Notes:
 *  - missing file / escape -> null
 *  - no `- 台北時間 ... — YYYY-MM-DD HH:MM` line within the first 5 lines -> null
 *  - bad date -> null
 *  Stops at line 5; never reads the whole file.
 *
 *  The header time is Taipei time (UTC+8); we append `+08:00` to the ISO string so
 *  the date is not misread as host-local time.
 *
 *  Cached per absolute path within the process; null results (parse failures) are
 *  cached too so the file system is not hit repeatedly. */
const _memoryEndDateCache = new Map<string, Date | null>()

export function readMemoryEndDate(uri: string): Date | null {
  const abs = resolveMemoryPath(uri)
  if (!abs) return null
  // cache hit returns directly (null counts as a hit)
  if (_memoryEndDateCache.has(abs)) return _memoryEndDateCache.get(abs)!
  let fd: number | null = null
  let result: Date | null = null
  try {
    fd = nodeFs.openSync(abs, 'r')
    const buf = Buffer.alloc(4096)
    // read at most 4 KiB at a time: enough for a small file; for a large file only the first 4 KiB (>=5 lines).
    const n = nodeFs.readSync(fd, buf, 0, buf.length, 0)
    const head = buf.subarray(0, n).toString('utf8')
    const lines = head.split(/\r?\n/).slice(0, 5)
    for (const line of lines) {
      const m = line.match(MEMORY_HEADER_DATE_RE)
      if (m) {
        // group 3 = end date YYYY-MM-DD; group 4 = end HH:MM; +08:00 = Taipei time
        const d = new Date(`${m[3]}T${m[4]}:00+08:00`)
        result = isNaN(d.getTime()) ? null : d
        break
      }
    }
  } catch {
    result = null
  } finally {
    if (fd !== null) {
      try { nodeFs.closeSync(fd) } catch { /* noop */ }
    }
    _memoryEndDateCache.set(abs, result)
  }
  return result
}

/** Clear the header-time cache (for tests; do not call in normal use). */
export function _clearMemoryEndDateCache(): void {
  _memoryEndDateCache.clear()
}

/** Memory time-decay factor. Always in [MEMORY_DECAY_FLOOR, 1], monotonically
 *  decreasing in past days; missing/bad/future dates go to explicit buckets and are
 *  never silently treated as newest.
 *  Only applies to `qmd://memories/...`; non-memory paths return 1 (knowledge layer untouched).
 *
 *  Most memory URIs carry no date. A path that carries a date uses it (legacy path);
 *  an undated one reads the end time from the file header
 *  `- 台北時間 ... — END_DATE`. Missing file / escape / bad date -> MISSING bucket. */
export function memoryDecayFactor(path: string, now: Date = new Date()): number {
  if (!MEMORY_PATH_RE.test(path)) return 1 // non-memory: no decay (knowledge layer byte-compatible)
  // 1) legacy path first: the path carries a date -> use it directly (keeps existing behaviour)
  const d = dateFromPath(path)
  if (d && !isNaN(d.getTime())) {
    const ageDays = (now.getTime() - d.getTime()) / 86400000
    if (ageDays < 0) return FUTURE_TIMESTAMP_FACTOR // future date: scheduling / data error
    return MEMORY_DECAY_FLOOR + (1 - MEMORY_DECAY_FLOOR) * Math.pow(0.5, ageDays / MEMORY_HALF_LIFE_DAYS)
  }
  // 2) no date in the path -> read the file header (- 台北時間 ... — END_DATE)
  const head = readMemoryEndDate(path)
  if (!head) return MISSING_TIMESTAMP_FACTOR // parse failure falls into the MISSING bucket
  const ageDays = (now.getTime() - head.getTime()) / 86400000
  if (ageDays < 0) return FUTURE_TIMESTAMP_FACTOR // future date
  return MEMORY_DECAY_FLOOR + (1 - MEMORY_DECAY_FLOOR) * Math.pow(0.5, ageDays / MEMORY_HALF_LIFE_DAYS)
}

/** Feature flag: environment variable `QMD_MEMORY_DECAY`. Default off; 1/true/yes/on = on.
 *
 *  Scope: this flag has **one** purpose — it controls the equal-score path tiebreak for
 *  the **knowledge leg** (searchPipeline/queryPipeline; non-memory), i.e. the default
 *  of `memOn` inside applyWeights. The memory leg (memorySearchPipeline /
 *  memoryQueryPipeline) is always-on with `memoryDecay: true` and does not read this
 *  env, so the contract "knowledge/non-memory results remain byte/order compatible"
 *  holds: with the env unset, the knowledge leg has memOn=false and falls back to the
 *  native stable sort. Do not extend it to the memory leg. */
export function memoryDecayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.QMD_MEMORY_DECAY ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

export interface ApplyWeightsOpts {
  /** Channel-status query (as judged by isChannelStatusQuery); when true, per-day daily logs get an extra down-weight */
  channelStatus?: boolean
  /** Whether to apply memory-specific time decay. Defaults to what `memoryDecayEnabled()`
   *  resolves from `QMD_MEMORY_DECAY` (off keeps block 1 behaviour). Callers may override. */
  memoryDecay?: boolean
}

const DATE_RE = /(\d{4})-(\d{2})-(\d{2})/

/** Extract a date from a path (file name or directory segment); null if none, never touches the file system. */
export function dateFromPath(path: string): Date | null {
  const m = path.match(DATE_RE)
  if (!m) return null
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`)
  return isNaN(d.getTime()) ? null : d
}

/** score' = score x prod(type weights) x decayFactor(path) x (1 + RECENCY_TIEBREAK x freshness)
 *  freshness in [0,1]: linear decay within 180 days, 0 after; a path without a date counts as 0 (no penalty).
 *  decayFactor in [DECAY_FLOOR, 1]: decays only when in DECAY_CLASSES and the path has a date.
 *  The two terms multiply: for non-decay classes decayFactor is always 1.
 *  opts.channelStatus: on channel-status questions per-day daily logs are additionally
 *  multiplied by CHANNEL_STATUS_DAILY_FACTOR; omitted = no change. */
export function applyWeights(
  docs: RankedDoc[],
  now = new Date(),
  opts: ApplyWeightsOpts = {},
): RankedDoc[] {
  const memOn = opts.memoryDecay ?? memoryDecayEnabled()
  return docs
    .map(doc => {
      let f = 1
      for (const w of WEIGHTS) if (w.pattern.test(doc.path)) f *= w.factor
      if (opts.channelStatus && DAILY_SESSION_LOG_RE.test(doc.path)) {
        f *= CHANNEL_STATUS_DAILY_FACTOR
      }
      if (memOn) f *= memoryDecayFactor(doc.path, now)
      const d = dateFromPath(doc.path)
      let fresh = 0
      if (d) {
        const days = (now.getTime() - d.getTime()) / 86400000
        if (days >= 0 && days <= 180) fresh = 1 - days / 180
      }
      return { ...doc, score: doc.score * f * decayFactor(doc.path, now) * (1 + RECENCY_TIEBREAK * fresh) }
    })
    /* Stable tiebreak: path lexicographic order is appended only when memOn.
       With memOn = false the sort falls back to the native stable sort
       .sort((a, b) => b.score - a.score), identical for identical input.
       With memOn = true: pure memory ties re-order by path; knowledge results have
       memoryDecayFactor === 1, so scores do not change and the tiebreak only matters
       when scores are truly equal. */
    .sort((a, b) => (b.score - a.score) || (memOn && a.path < b.path ? -1 : memOn && a.path > b.path ? 1 : 0))
}

// ── self-exclusion for measurement ───────────────────────────────────────────

/** Benchmark files quote the test questions verbatim and would grab rank for every question.
 *  Exclude them when measuring; do not exclude in daily retrieval (a user who really
 *  searches for the benchmark should find it). */
export const BENCH_SELF_RE =
  /(?:^|\/)memory-benchmark\//

export function excludeBenchSelf(docs: RankedDoc[]): RankedDoc[] {
  return docs.filter(d => !BENCH_SELF_RE.test(d.path))
}
