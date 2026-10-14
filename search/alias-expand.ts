/**
 * alias-expand — grow vault_query expansions automatically from a wiki alias/variant table
 *
 * Background: an alias-table generator (not included in this repo) writes
 * `$MEMORY_OS_HOME/aliases.json` (regenerate it on a schedule of your own).
 * This module is the half that wires the table into retrieval. The decision rules live
 * here so they can be tested; buried in a request handler in server.ts they could only be checked by eye.
 *
 * Rules:
 *   - stdout is the MCP protocol channel, so this module only ever writes to stderr.
 *   - Every step fails open (returns an empty array). Missing aliases only cost a little recall,
 *     whereas throwing would take the whole vault_query down.
 */

import { readFileSync, statSync } from 'node:fs'

export interface AliasEntry {
  canonical: string
  variants: string[]
  /** Which kind of wording each variant is (labelled by the table generator: slug / title / translation / alias / wrapper).
   *  Older tables lack this field and read as empty — every rule that uses kind must still work on an empty table. */
  kinds?: Record<string, string>
  /** Concept root: the slug of the entry that the entry's frontmatter channel link points to
   *  (resolved by the table generator; e.g. `Example Show (Part 1)` has a channel link to the show entry).
   *  Entries without a channel link have no such field and their root is themselves (see rootOf).
   *  A table with the whole column absent still works. */
  root?: string
}

export interface AliasTable {
  entries: AliasEntry[]
  /** Path the table came from (for diagnostics; null for an empty table) */
  source: string | null
}

export const EMPTY_TABLE: AliasTable = { entries: [], source: null }

/** A variant used as a key ("does this sentence mention this entry") must be at least this long to count.
 *  A one-character key (e.g. "A") matches almost any sentence and the aliases added have nothing to do with the question. */
export const MIN_KEY_LEN = 2
/** An alias that is too long becomes noise to emit (a table may hold 100+ character titles) */
export const MAX_EMIT_LEN = 120
/** How many slots one concept root may take (design choice: at most 1 slot per root,
 *  root = the channel link, otherwise the entry itself). Part 1 and Part 2 of the same show together take one slot,
 *  and a second wording of a single entry is also cut — an accepted recall cost,
 *  in exchange for four slots no longer being eaten by one series. */
export const PER_ROOT_LIMIT = 1

/** A table generator may print JSON null as a string into variants. Such values as keys would make the string "null" hit many unrelated entries,
 *  and emitting them as aliases is pure noise. The real fix belongs in the generator,
 *  but the table is external input, so the loader guards itself. */
const JUNK_VARIANTS = new Set(['null', 'undefined', 'none', 'nan', 'n/a'])

/** Pure-ASCII keys use word-boundary matching, so `AI` does not hit `SAID` and `os` does not hit `most`. */
const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/

const warned = new Set<string>()
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.error(`[alias-expand] ${msg}`)
}

/** For tests: clear the "warn only once" memory */
export function _resetWarnings(): void {
  warned.clear()
}

function defaultTablePath(): string {
  const fromEnv = process.env.QMD_ALIAS_TABLE
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  const home = process.env.HOME || ''
  const base = process.env.MEMORY_OS_HOME || `${home}/.memory-os`
  return `${base}/aliases.json`
}

let cache: { path: string; mtimeMs: number; size: number; table: AliasTable } | null = null

/** For tests: drop the cache so one process can switch tables */
export function _resetCache(): void {
  cache = null
}

/**
 * Load the alias table. The table may be regenerated nightly, so every call stats it once (a few microseconds)
 * and re-reads only when mtime or size changed — a long-running session does not cling to yesterday's table.
 * Missing file / invalid JSON / wrong shape -> an empty table, never an exception.
 */
export function loadAliasTable(path?: string): AliasTable {
  const p = path ?? defaultTablePath()
  let mtimeMs: number
  let size: number
  try {
    const st = statSync(p)
    if (!st.isFile()) {
      warnOnce(`notfile:${p}`, `alias table ${p} is not a regular file; no automatic aliases this round`)
      return EMPTY_TABLE
    }
    mtimeMs = st.mtimeMs
    size = st.size
  } catch {
    warnOnce(`stat:${p}`, `alias table ${p} cannot be read (maybe not generated yet); no automatic aliases this round`)
    return EMPTY_TABLE
  }

  if (cache && cache.path === p && cache.mtimeMs === mtimeMs && cache.size === size) {
    return cache.table
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(p, 'utf-8'))
  } catch (err) {
    warnOnce(`parse:${p}:${mtimeMs}`, `alias table ${p} is not valid JSON (${err}); no automatic aliases this round`)
    return EMPTY_TABLE
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnOnce(`shape:${p}:${mtimeMs}`, `alias table ${p} top level is not an object; no automatic aliases this round`)
    return EMPTY_TABLE
  }

  const entries: AliasEntry[] = []
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const rec = raw as Record<string, unknown>
    const variants = Array.isArray(rec.variants)
      ? (rec.variants.filter((v) => typeof v === 'string' && v.trim()) as string[])
          .map((v) => v.trim())
          .filter((v) => !JUNK_VARIANTS.has(v.toLowerCase()))
      : []
    if (variants.length < 2) continue // only one wording = no "variant" to add
    const canonical =
      typeof rec.canonical === 'string' && rec.canonical.trim() ? rec.canonical.trim() : key
    // kinds is a "name -> kind" map. Check each cell's type instead of trusting it wholesale: the table is external input,
    // and a non-string value should count as unlabelled rather than hand undefined to downstream comparisons.
    let kinds: Record<string, string> | undefined
    if (rec.kinds && typeof rec.kinds === 'object' && !Array.isArray(rec.kinds)) {
      const k: Record<string, string> = {}
      for (const [name, kv] of Object.entries(rec.kinds as Record<string, unknown>)) {
        if (typeof kv === 'string' && kv.trim()) k[name.trim()] = kv.trim().toLowerCase()
      }
      if (Object.keys(k).length) kinds = k
    }
    // root is checked cell by cell too: non-string / blank counts as absent (root falls back to the entry itself)
    const root =
      typeof rec.root === 'string' && rec.root.trim() ? rec.root.trim() : undefined
    entries.push({ canonical, variants, kinds, root })
  }

  const table: AliasTable = { entries, source: p }
  cache = { path: p, mtimeMs, size, table }
  return table
}

function isAscii(s: string): boolean {
  return !CJK_RE.test(s)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether this variant is good enough to be a key */
export function isUsableKey(v: string): boolean {
  return v.trim().length >= MIN_KEY_LEN
}

/** Whether the query mentions this variant */
export function keyHits(query: string, key: string): boolean {
  const k = key.trim()
  if (!isUsableKey(k)) return false
  if (isAscii(k)) {
    // word-boundary matching: an ASCII key must not bite into the middle of a word
    let re: RegExp
    try {
      re = new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRe(k)}(?![A-Za-z0-9_])`, 'i')
    } catch {
      return false
    }
    return re.test(query)
  }
  return query.toLowerCase().includes(k.toLowerCase())
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * The "skeleton" with all punctuation, whitespace and symbols removed. Used to recognise "the same wording differing only in layout".
 * A table can contain pairs that differ only by a half-width vs a full-width hyphen
 * (e.g. `Example Show (Part 1)-x` and `...(Part 1)－x`); sending both is the same route twice,
 * wasting two slots and pushing out a genuinely different entry.
 */
function shapeKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}]/gu, '')
}

/**
 * Slug tail: an explicit separator (- _ /) followed by a run of pure ASCII alphanumerics.
 * Example: `Example Show**-example-user-123**`, `Annual Film Top 10**-example-account**`.
 */
const SLUG_TAIL_RE = /^[-_/][a-z0-9][a-z0-9_-]*$/

/** Normalisation of the raw string for comparison: only case and full/half width, **no punctuation stripping** — the punctuation is the rule itself. */
function rawKey(s: string): string {
  return s.trim().toLowerCase().normalize('NFKC')
}

/**
 * Whether a candidate is "the matched wording plus a source tag" in slug form.
 *
 * The rule works on the **raw string**, not on the skeleton: the skeleton strips all punctuation,
 * and punctuation is the only boundary between "-account" and "(English name, year)".
 * An earlier version looked at "is the tail pure ASCII" on the skeleton and, as a result,
 * killed the most valuable English titles such as `Example Film (Title, 2006)` or
 * `Some Algorithm (Long English Name)` (after the brackets are stripped, the tail looks like pure ASCII).
 * On a real table that version would have blocked hundreds of candidates, mostly English titles / years / subtitles, not account tails.
 */
function isSlugVariantOf(candidateRaw: string, keyRaw: string): boolean {
  if (keyRaw.length < MIN_KEY_LEN) return false
  if (!candidateRaw.startsWith(keyRaw)) return false
  return SLUG_TAIL_RE.test(candidateRaw.slice(keyRaw.length))
}

/** Slug-like: no whitespace, but alphanumeric segments joined with hyphens. On a skeleton collision keep the readable one. */
function looksLikeSlug(s: string): boolean {
  return !/\s/.test(s) && /[a-z0-9][-_][a-z0-9]/i.test(s)
}

/**
 * Secondary sort key comparing code unit by code unit.
 *
 * Why not `localeCompare`: it can rank two strings that differ only in punctuation or whitespace as **equal (0)**
 * (e.g. `Tool Name` vs `Tool  Name`, `fish-like` vs `@fish_like`), and on a collision it falls back to the array's
 * original order — which looks pinned down but is not. That original order comes from the generator's field scan order,
 * so after a rebuild a different representative wording might win and the same sentence would get different expansions on different days.
 *
 * Comparing code units has no "equal rank": any two strings that are not identical always have a winner.
 */
function cmpCodeUnit(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i)
    if (d !== 0) return d
  }
  return a.length - b.length
}

/**
 * "Source-wrapped" variants are not emitted as aliases.
 *
 * A wrapper = the entry's own name plus a tail naming **a source it declared itself** (channel / creator / account / publisher),
 * labelled by the table generator rather than guessed from the surface form here.
 * Examples: `Example Show-example-creator`, `Example Show-episode`, `S01 — Example Topic-demo-show`.
 *
 * Why block them: used as a second retrieval route, such a string queries "the name plus a file-name tag" again —
 * nearly the same route as the main query, but carrying extra noise unrelated to meaning into vector search.
 * It is the same kind of thing as "wordings differing only in punctuation take one slot"; here the excess part is a source tag.
 *
 * **Only the emitting side is blocked, not the key side** — the latter is deliberate, not an omission:
 * wrapper variants are long (the shortest are about 9 characters, the median about 23),
 * and a key only hits when the whole string appears in the question. No natural question types out "name + source tag" in full,
 * so removing that guard would turn no test red — this file has already dropped two such fake guards
 * (an early return on an empty query, an empty-skeleton placeholder) and does not add another.
 *
 * Known cost: a few wrappers are pure Latin letters while the entry name is CJK — those act as a romanised retrieval route,
 * and blocking them is a net loss; the rest are social-post file names, and blocking them is a net gain. The trade is worth it.
 */
function isWrapper(entry: AliasEntry, variant: string): boolean {
  const k = entry.kinds
  if (!k) return false
  // Check both the raw string and the trimmed one: the loader trims both sides so they always match,
  // but a table assembled directly (tests, other callers) has no such guarantee; checking twice is steadier than requiring callers to normalise first.
  return k[variant] === 'wrapper' || k[variant.trim()] === 'wrapper'
}

export interface ExpandOpts {
  /** Total cap on automatic aliases (default 4; the caller deducts the quota the user supplied themselves) */
  limit?: number
  /** Query strings already in use (main query + the caller-supplied expansions), not added again */
  exclude?: string[]
}

/**
 * Recognise which entries the query mentions and return "that entry's other wordings" as extra retrieval routes.
 * Order = the longer the matched key, the earlier (longer = more specific); equal lengths sort stably by canonical,
 * so the same sentence always gets the same expansion set (reproducible, hence testable).
 */
export function autoExpand(query: string, table: AliasTable, opts: ExpandOpts = {}): string[] {
  // No early-return guard for quota <= 0 or an empty query: the former is stopped directly by `out.length >= limit` below,
  // and the latter simply never matches in keyHits. An early return would be one more fake guard that nobody notices when removed.
  // The behaviour is pinned down by tests.
  const limit = opts.limit ?? 4
  const q = String(query ?? '')

  const taken = new Set<string>([norm(q), ...(opts.exclude ?? []).map(norm)])
  // Skeleton-level placeholders: wordings differing only in punctuation count as the same route and do not take extra quota
  const takenShapes = new Set<string>([shapeKey(q), ...(opts.exclude ?? []).map(shapeKey)])
  takenShapes.delete('')

  type Hit = { entry: AliasEntry; keyLen: number; key: string }
  const hits: Hit[] = []
  for (const entry of table.entries) {
    let best: string | null = null
    for (const v of entry.variants) {
      if (!keyHits(q, v)) continue
      const t = v.trim()
      // On equal length break the tie by code unit rather than leaving it to the array's original order — the same `keyLen` can still choose
      // a different representative, which decides what the `shapeKey(hit.key)` de-duplication below compares against; a different representative gives a different expansion set
      if (best === null || t.length > best.length ||
          (t.length === best.length && cmpCodeUnit(t, best) < 0)) best = t
    }
    if (best !== null) hits.push({ entry, keyLen: best.length, key: best })
  }

  hits.sort((a, b) => b.keyLen - a.keyLen || a.entry.canonical.localeCompare(b.entry.canonical))

  const out: string[] = []
  // Placeholder set for concept roots: entries with the same root (a show and its episodes, Part 1 and Part 2) together take at most
  // PER_ROOT_LIMIT slots. Compared with norm, the same normalisation as `taken`.
  // Only a root that really emitted something takes a slot — if every variant of the first entry is filtered out, the next entry of the same root still has a chance.
  const takenRoots = new Set<string>()
  for (const hit of hits) {
    // The total quota is guarded at this one level only. The inner loop used to have an identical `out.length >= limit`,
    // and once PER_ROOT_LIMIT dropped to 1 the two shadowed each other — removing either alone changes no behaviour
    // (mutation testing: each survived on its own, and only removing both turned a test red).
    // Following this file's existing practice (no early return on an empty query, no empty-skeleton placeholder): fake guards are not kept, one real guard is.
    // If PER_ROOT_LIMIT is ever raised above 1, the inner guard has to come back too.
    if (out.length >= limit) break
    const rootKey = norm(hit.entry.root ?? hit.entry.canonical)
    if (takenRoots.has(rootKey)) continue
    let fromThisEntry = 0
    // On a skeleton collision first-come-first-served wins, so the first should be the better one: a readable title ahead of a slug.
    // Example: `A Nice Example Film (2024)` and `A-Nice-Example-Film-2024` have the same skeleton;
    // in the original order the slug would be kept, yet a readable title is clearly more useful than a hyphenated string in vector search.
    // The secondary key is cmpCodeUnit rather than "no sort": when both look like slugs (or neither does),
    // which one survived would depend on the table's original order, and a regeneration could swap the wording.
    const orderedVariants = [...hit.entry.variants].sort(
      (a, b) => Number(looksLikeSlug(a)) - Number(looksLikeSlug(b)) || cmpCodeUnit(a, b)
    )
    for (const v of orderedVariants) {
      if (fromThisEntry >= PER_ROOT_LIMIT) break
      const t = v.trim()
      if (!t || t.length > MAX_EMIT_LEN) continue
      // source-wrapped wordings are not emitted as aliases (see the isWrapper note)
      if (isWrapper(hit.entry, v)) continue
      const n = norm(t)
      if (taken.has(n)) continue
      // the query already contains this wording; adding it would repeat the same route
      if (keyHits(q, t)) continue
      const shape = shapeKey(t)
      // the same wording differing only in punctuation, and someone already holds the slot: do not take another
      if (shape && takenShapes.has(shape)) continue
      // A skeleton identical to the matched wording = the same sentence with different punctuation (the table may hold a quoted alias of the same title),
      // and the query already covers that route. Only exact skeleton equality is compared, not prefixes — a prefix check would wrongly kill
      // the most valuable aliases of the "name (English name, year)" kind.
      if (shape && shape === shapeKey(hit.key)) continue
      // the slug form of "matched wording + source tag" points to the same document; one more route would just be a duplicate vote
      if (isSlugVariantOf(rawKey(t), rawKey(hit.key))) continue
      taken.add(n)
      // Whether an empty skeleton (a string of pure punctuation) enters the placeholder set makes no difference — the `shape &&` in the check above
      // already short-circuits it. No separate `if (shape)` here: that would be a fake guard nobody notices when removed.
      // The `shape &&` above is what really does the work.
      takenShapes.add(shape)
      out.push(t)
      fromThisEntry++
    }
    if (fromThisEntry > 0) takenRoots.add(rootKey)
  }
  return out
}

/** One-step entry point for server.ts: read the table + expand, fail-open throughout */
export function expansionsFromAliases(
  query: string,
  opts: ExpandOpts & { tablePath?: string } = {}
): string[] {
  if (process.env.QMD_ALIAS_EXPAND === '0') return []
  try {
    // No early return for an empty table: autoExpand already returns an empty array for it (same as above, fake guards are not kept)
    return autoExpand(query, loadAliasTable(opts.tablePath), opts)
  } catch (err) {
    warnOnce(`expand:${err}`, `automatic alias expansion failed (${err}); using only the caller-supplied expansions`)
    return []
  }
}
