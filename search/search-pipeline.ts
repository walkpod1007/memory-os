/**
 * search-pipeline.ts — shared retrieval pipeline for vault_search / vault_query
 * (server.ts and qsc-cli.ts both go through here, so the MCP server and the
 * benchmark CLI measure the same behaviour)
 *
 * searchPipeline: whole sentence + one `qmd search` route per keyword -> RRF merge -> weighted ranking.
 *   qmd's BM25 is AND-semantics, so a long question returns zero hits as a whole sentence;
 *   per-keyword routes rescue it, and the whole-sentence route is kept (it is accurate for
 *   short queries and RRF merging does not make it worse).
 *   Alias block: wiki alias expansion also runs one route each (vote weight 0.5),
 *   to cover the case where the question wording and the document wording share no
 *   vocabulary — splitting words cannot bridge different languages or translated names.
 * queryPipeline: `qmd query` structured query — hyde/vec as before,
 *   the lex lane goes back to a single whole-sentence line (see rank-core.ts RRF block
 *   and the queryPipeline comment below).
 *   BM25 fill-in is done in the outer layer: one qmd search per keyword -> internal RRF
 *   builds a BM25 list -> merged with the qmd query semantic list by a weighted
 *   rrfMerge [1.0, 0.5] -> weighted ranking.
 *   Expansions (user variants + wiki aliases) also feed keywords into the BM25 fill-in
 *   list with an internal vote weight of 0.5 (expansion lanes get a lower weight so they
 *   cannot dilute the correct semantic hit).
 *
 * Concurrency cap: the multi-route qmd calls in both pipelines go through mapCapped, at
 *   most 3 child processes at once. An uncapped Promise.all hit
 *   `SQLITE_SCHEMA: vtable constructor failed` on a few percent of routes, and the
 *   catch in searchRoute swallowed it as "this keyword has no result" — that lane
 *   contributed zero votes, exit code 0, no log line, and the same query returned
 *   different counts on consecutive runs.
 */
import { readFileSync, appendFileSync } from 'node:fs'
import {
  extractKeywords, parseBlocks, rrfMerge, applyWeights, isChannelStatusQuery,
} from './rank-core.ts'
import type { RankedDoc } from './rank-core.ts'
import { expansionsFromAliases } from './alias-expand.ts'

const QMD_BIN = process.env.QMD_BIN ?? 'qmd'
const SEARCH_PER_ROUTE = 200 // candidate pool cap per route
const BM25_KEYWORD_CAP = 4  // at most 4 keywords per question for the fill-in list (avoid route explosion)

// ── expansion-lane parameters ───────────────────────────────────────────────
/** Vote weight of expansion lanes (alias/variant-derived). Observed: too many lex lanes dilute the correct semantic hit,
 *  so expansion lanes get half a vote — they fill in, they do not override the original query lanes. Set 0 = disable expansion lanes (rollback). */
const EXPANSION_ROUTE_WEIGHT = 0.5
/** How many alias lanes the vault_search side adds at most (the alias itself is the FTS query; a short name under AND semantics is just right) */
const ALIAS_ROUTE_CAP = 2
/** Total quota of keywords derived from expansions on the vault_query side (the original BM25 list already has 4 lanes) */
const EXPANSION_BM25_KEYWORD_CAP = 4
/** How many keywords each expansion may contribute at most (stops one long variant from eating the quota) */
const PER_EXPANSION_KEYWORD_CAP = 2

/** De-duplication key: sanitize + lower-case. FTS is case-insensitive, so `AI` and `ai` are one lane;
 *  comparing the raw strings would give the same term two half-votes. */
const routeKey = (s: string) => sanitize(s).toLowerCase()

/** Extract BM25 keywords from expansions (full-sentence semantic variants):
 *  skip terms the original query already has (compared after normalize) and cap the total. Variants are usually
 *  a different language or wording, and their keywords are the bridge across the vocabulary gap (galaxy <-> 銀河系). */
function expansionKeywords(expansions: string[], base: string[]): string[] {
  const seen = new Set(base.map(routeKey))
  const out: string[] = []
  for (const e of expansions) {
    for (const k of extractKeywords(e, PER_EXPANSION_KEYWORD_CAP)) {
      const key = routeKey(k)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(k)
      if (out.length >= EXPANSION_BM25_KEYWORD_CAP) return out
    }
  }
  return out
}

// Single source of truth for the embedding model. This path covers every vault_search /
// vault_query call, the widest reach of all call sites. The truth lives in one line of
// plain text in the `qmd-embed-model` file; change the model by editing only that line.
// If it cannot be read, throw on the spot — better a visible query error than silently
// embedding queries with the wrong model and returning random results.
//
// Note: **re-read on every query, not frozen at module load.** The MCP server is a
// long-running process, and some live for days. If the value were frozen at load time,
// then after the source of truth is changed to a different model those already-running
// processes would query a new-dimension index with the old model. A design that relies on
// "someone remembers to restart" puts correctness on human memory; reading a one-line
// file is cheap enough that the risk is not worth taking.
// Caveat: qmd itself prefers `models.embed` in its index.yml over the QMD_EMBED_MODEL
// environment variable, so if index.yml sets `models.embed` to a different model this file
// is silently ignored by qmd. Keep the two consistent (install.sh --check warns).
const QMD_EMBED_MODEL_FILE = process.env.QMD_EMBED_MODEL_FILE
  ?? `${process.env.MEMORY_OS_HOME ?? `${process.env.HOME}/.memory-os`}/qmd-embed-model`
function qmdEmbedModel(): string {
  let raw: string
  try {
    raw = readFileSync(QMD_EMBED_MODEL_FILE, 'utf8')
  } catch (e) {
    throw new Error(
      `FATAL qmd-env: cannot read the embedding model source of truth ${QMD_EMBED_MODEL_FILE}`
      + ` — refusing to fall back to the default (it would silently give wrong answers): ${e}`,
    )
  }
  for (const line of raw.split('\n')) {
    const v = line.split('#')[0].trim()
    if (v) return v
  }
  throw new Error(`FATAL qmd-env: ${QMD_EMBED_MODEL_FILE} contains no usable model URI`)
}

export async function runQmd(args: string[]): Promise<string> {
  const proc = Bun.spawn([QMD_BIN, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin`,
      QMD_EMBED_MODEL: qmdEmbedModel(),
    },
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`qmd exited ${exitCode}: ${stderr.trim()}`)
  }
  return stdout.trim()
}

// A hyphen inside a word (e.g. my-note, 2026-02-17) is treated by qmd as negation syntax:
// hyde:/vec: lines of query throw outright, and FTS5 in search silently returns zero hits.
// Rule: replace every hyphen with a plain space regardless of position; fold newlines into spaces so extra command lines cannot be injected.
export const sanitize = (text: string) =>
  text
    .replace(/\n/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Maximum number of qmd child processes hitting the same SQLite file at once — **the total budget for one pipeline call**, not a per-stage quota.
 *  Measured with 330 routes x several arms: uncapped, about 4% of routes hit SQLITE_SCHEMA and got swallowed;
 *  a cap of 3 gave zero failures (~480 ms/query), and a cap of 2 also gave zero failures but was slower (~570 ms/query).
 *  This number was measured, not guessed; re-measure before changing it. */
const MAX_CONCURRENT_QMD = 3

/** map with a concurrency cap: at most `cap` run at once, the rest queue; the result order matches the input.
 *  Deliberately no dependency — ten lines are enough here. */
async function mapCapped<T, R>(items: T[], cap: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(cap, items.length)) }, worker)
  )
  return out
}

/** Retry only the "short-lived race while qmd opens the database". Other errors (index really broken, qmd missing)
 *  gain nothing from retrying and would just turn a clear failure into a three-times-slower failure.
 *
 *  These are the **two** error strings observed in practice, not guesses. Every `qmd search` re-runs
 *  `initializeDatabase()`, so when several qmd processes open the same DB while someone is writing:
 *    · `SQLITE_SCHEMA: vtable constructor failed: documents_fts`
 *    · `SQLITE_ERROR: trigger documents_ai already exists` (two processes both decide "the trigger is missing",
 *      then both create it)
 *  Both are start-up races, not a broken index, and a retry succeeds. A first version only
 *  handled the former, so the latter was never retried and was given up on — the fix looked
 *  deployed but only covered half the cases.
 *  SQLITE_BUSY / locked are added too: same family (write-lock contention), same remedy (back off and retry). */
const INIT_RACE =
  /SQLITE_SCHEMA|vtable constructor failed|already exists|SQLITE_BUSY|database is locked/
const ROUTE_RETRIES = 2

/** Concurrency-race event ledger: **a successful retry is also recorded**.
 *
 *  Why a successful retry is worth recording: it means "this time a lane was nearly lost".
 *  A concurrency cap of 3 is a measured safeguard, but indexes grow, machines get busier and
 *  qmd changes versions; when that line stops being enough, **the earliest sign is the RETRY-OK
 *  count starting to rise**. Printing only give-ups means nobody finds out until a lane is
 *  already lost.
 *
 *  Why not console.error: the MCP server is a long-running process and nobody reads its
 *  stderr. A file on disk can be inspected by a daily report.
 *
 *  Implementation: a single-line `appendFileSync` (O_APPEND writes under PIPE_BUF do not
 *  truncate each other across processes). **A write failure is swallowed and never breaks the
 *  pipeline** — this is a side ledger, and a query must not fail because bookkeeping failed;
 *  the cost: if file permissions break, this ledger silently records zero events, so a
 *  report must tell "no events" apart from "ran and was clean". */
const RETRY_LEDGER =
  process.env.QMD_SEARCH_RETRY_LOG ?? `${process.env.MEMORY_OS_HOME ?? `${process.env.HOME}/.memory-os`}/state/qmd-search-retry.log`
function ledger(kind: 'RETRY-OK' | 'GIVEUP', q: string, attempt: number, err: unknown) {
  try {
    const one = String(err).replace(/[\r\n]+/g, ' ').slice(0, 160)
    appendFileSync(
      RETRY_LEDGER,
      `${kind} | ${new Date().toISOString()} | attempt=${attempt} | route=${q.slice(0, 20)} | ${one}\n`,
    )
  } catch { /* side ledger: failing to record must not affect the query */ }
}

/** One qmd search route; no result (non-zero exit or empty output) returns an empty array and does not break the pipeline.
 *
 *  Note: this function is called concurrently and occasionally hits
 *  `SQLITE_SCHEMA: vtable constructor failed: documents_fts`.
 *  An older version conflated that with "really no result", so the lane contributed zero votes,
 *  the query quietly got worse and nothing was logged (the same query on an unchanged index
 *  returned different counts on four consecutive runs).
 *  The main defence is the concurrency cap above; the retry is the second line, for the
 *  occasional hit that still happens within the cap. */
async function searchRoute(q: string): Promise<RankedDoc[]> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= ROUTE_RETRIES; attempt++) {
    try {
      const out = parseBlocks(await runQmd(['search', q, '-n', String(SEARCH_PER_ROUTE)]))
      // attempt > 0 means an earlier attempt hit the race and this retry rescued it: a lane was nearly lost, record it.
      if (attempt > 0) ledger('RETRY-OK', q, attempt, lastErr)
      return out
    } catch (err) {
      lastErr = err
      if (!INIT_RACE.test(String(err))) break
      if (attempt < ROUTE_RETRIES) await new Promise(r => setTimeout(r, 25 * (attempt + 1)))
    }
  }
  // Reaching here means the lane really is gone. The return value matches the old version
  // (an empty array does not break the pipeline); the difference is that it is no longer silent —
  // a query missing a lane becomes visible.
  ledger('GIVEUP', q, ROUTE_RETRIES, lastErr)
  console.error(`[qmd-search] searchRoute gave up; this route contributes no candidates (${q.slice(0, 20)}): ${lastErr}`)
  return []
}

// ── candidate-pool experiment ────────────────────────────────────────────────
// Failure mode: the production semantic lane runs `qmd query <typed lines>`, and qmd's
// structuredSearch hard-codes 20 results for each of the lex and vec lines, which -n, --all
// and -C cannot change. In a measured case, the right document ranked 72nd in a pure vector
// deep list — the ranker did not push it down, it never entered the candidate pool.
// This lane therefore uses `qmd vsearch --min-score 0 -n 150` (vsearch has no such hard cap of 20).
const DEEP_VEC_N = 150
const DEEP_VEC_WEIGHT = 0.5

async function deepVecRoute(q: string): Promise<RankedDoc[]> {
  try {
    return parseBlocks(await runQmd(['vsearch', q, '--min-score', '0', '-n', String(DEEP_VEC_N)]))
  } catch (err) {
    console.error(`[qmd-search] deepVecRoute gave up: ${err}`)
    return []
  }
}

/** BM25 multi-route (whole sentence + per keyword + alias routes) -> RRF -> weights.
 *  Alias routes fail open: if the question names no wiki entry nothing is added.
 *  Empty routes contribute zero to RRF, so they are not filtered out — filtering would misalign weights with routes. */
export async function searchPipeline(query: string): Promise<RankedDoc[]> {
  const clean = sanitize(query)
  const keywords = extractKeywords(query)
  const routes = [clean, ...keywords.filter(k => k !== clean)]
  // Fetch extra candidates first, de-duplicate, then truncate — truncating first would waste quota
  // on name collisions (same shape / same case after sanitize), turning a "2-route cap" into fewer than 2 routes
  const seenRoutes = new Set(routes.map(routeKey))
  const aliasRoutes: string[] = []
  for (const a of expansionsFromAliases(query, { limit: ALIAS_ROUTE_CAP + 2 })) {
    const s = sanitize(a)
    const key = s.toLowerCase()
    if (!s || seenRoutes.has(key)) continue
    seenRoutes.add(key)
    aliasRoutes.push(s)
    if (aliasRoutes.length >= ALIAS_ROUTE_CAP) break
  }
  const weights = [
    ...routes.map(() => 1),
    ...aliasRoutes.map(() => EXPANSION_ROUTE_WEIGHT),
  ]
  const lists = await mapCapped([...routes, ...aliasRoutes], MAX_CONCURRENT_QMD, searchRoute)
  const merged = rrfMerge(lists, 60, weights)
  return applyWeights(merged, new Date(), { channelStatus: isChannelStatusQuery(query) })
}

/** Hybrid query:
 *  a. qmd query internal lines stay semantics-first: hyde + vec + expansions vec lines + a single lex: whole-sentence line.
 *  b. A separate BM25 fill-in list: extractKeywords(query, 4) runs one qmd search per keyword,
 *     plus the keyword routes derived from expansions (internal vote weight 0.5),
 *     combined internally with a weighted rrfMerge into one BM25 list.
 *  c. The two lists are merged with a weighted rrfMerge, weights [1.0, 0.5] — semantic votes weigh twice as much as BM25,
 *     so BM25 only fills in when semantic search finds nothing at all.
 *  d. After merging, applyWeights as usual (channel-status questions pass the classification flag).
 *  e. The two parts (qmd query and the searchRoutes) run in parallel with Promise.all.
 *  extraVecLines lets server.ts inject expansions (user variants + wiki aliases). */
export async function queryPipeline(
  query: string,
  extraVecLines: string[] = []
): Promise<RankedDoc[]> {
  // a. qmd query internal lines: semantics first + a single lex: whole-sentence line (see sanitize at module level)
  const qmdLines = [`hyde:${sanitize(query)}`, `vec:${sanitize(query)}`]
  for (const v of extraVecLines) {
    const t = sanitize(v)
    if (t) qmdLines.push(`vec:${t}`)
  }
  qmdLines.push(`lex:${sanitize(query)}`)

  // b. BM25 fill-in list: original query keywords get full votes, expansion-derived keywords half votes
  const bm25Keywords = extractKeywords(query, BM25_KEYWORD_CAP)
  const expKeywords = expansionKeywords(extraVecLines, [sanitize(query), ...bm25Keywords])
  const bm25Weights = [
    ...bm25Keywords.map(() => 1),
    ...expKeywords.map(() => EXPANSION_ROUTE_WEIGHT),
  ]
  // The cap here is deliberately one lower than in searchPipeline: step e. below also runs a qmd query,
  // which is another child process hitting the same SQLite file. Leaving one slot for it makes the
  // combined process count equal to the 3 that was measured at zero failures.
  const bm25ListsPromise = mapCapped(
    [...bm25Keywords, ...expKeywords], MAX_CONCURRENT_QMD - 2, k => searchRoute(k)
  ).then(lists => rrfMerge(lists, 60, bm25Weights))

  // e. run both in parallel
  const [semanticRaw, bm25List, deepVecList] = await Promise.all([
    runSemanticQuery(qmdLines),
    bm25ListsPromise,
    deepVecRoute(sanitize(query)),
  ])
  const semanticList = semanticRaw ? parseBlocks(semanticRaw) : []

  // c. weighted merge: semantic 1.0, BM25 0.5
  const merged = rrfMerge([semanticList, bm25List, deepVecList], 60, [1.0, 0.5, DEEP_VEC_WEIGHT])
  // d. weighted ranking as usual (channel-status flag)
  return applyWeights(merged, new Date(), { channelStatus: isChannelStatusQuery(query) })
}

/** Wrapped in try/catch: when qmd query fails (reserved characters blow up, exit != 0, ...) degrade to null and the caller falls back to the BM25 fill-in list.
 *  The failure reason goes to stderr so it does not pollute the stdout of qsc-cli.ts. */
async function runSemanticQuery(qmdLines: string[]): Promise<string | null> {
  try {
    return await runQmd(['query', qmdLines.join('\n')])
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[qmd-search] qmd query degraded to the BM25 fill-in list: ${reason}`)
    return null
  }
}

// ── memory leg (explicit `-c memories` collection argument) ───────────────────
//
// Design background:
//   "vault_search only queries the knowledge base by default; to query archived memories,
//   name memories explicitly" — a caller who asks `vault_search` something that only
//   archived memories contain is swallowed by the knowledge default, because the memories
//   collection is `Include: no` and is never touched by default retrieval.
//
// The fix is a **symmetric memory leg** — argv carries `-c memories` explicitly and shares
//   the same RRF merge and applyWeights as the knowledge leg; the only difference is that
//   the query names the memories collection from the start. The knowledge legs
//   (searchPipeline / queryPipeline) stay byte-for-byte unchanged in argv.
//
// This leg handles memory recall that the knowledge leg cannot reach. Memory-leg recall
//   applies time decay unconditionally (see memorySearchPipeline); the QMD_MEMORY_DECAY
//   environment variable only affects the knowledge leg's equal-score tiebreak.
//
// Mapping to the MCP tools in server.ts: memory_search runs memorySearchPipeline,
//   memory_query runs memoryQueryPipeline; both pass `-c memories` in args.
/** Memory version of searchRoute: wraps `qmd search <q> -n 10 -c memories` with retry and back-off.
 *  `-c memories` is the only difference; the rest (INIT_RACE retry, ledger, ROUTE_RETRIES)
 *  is identical to the knowledge searchRoute — deliberately not factored into a shared
 *  function, so the two legs differ only in that argv and the rest of the structure can be
 *  compared at a glance, avoiding the risk of a shared function being silently changed. */
async function memoryRoute(q: string): Promise<RankedDoc[]> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= ROUTE_RETRIES; attempt++) {
    try {
      const out = parseBlocks(
        await runQmd(['search', q, '-n', String(SEARCH_PER_ROUTE), '-c', 'memories'])
      )
      if (attempt > 0) ledger('RETRY-OK', `[memory] ${q}`, attempt, lastErr)
      return out
    } catch (err) {
      lastErr = err
      if (!INIT_RACE.test(String(err))) break
      if (attempt < ROUTE_RETRIES) await new Promise(r => setTimeout(r, 25 * (attempt + 1)))
    }
  }
  ledger('GIVEUP', `[memory] ${q}`, ROUTE_RETRIES, lastErr)
  console.error(`[qmd-search] memoryRoute gave up (${q.slice(0, 20)}): ${lastErr}`)
  return []
}

/** Memory version of deepVecRoute: `qmd vsearch <q> --min-score 0 -n 150 -c memories`.
 *  vsearch has no hard cap of 20, so deep recall still works; `-c memories` lets vsearch
 *  reach the memories collection too (otherwise it is filtered out by Include:no as well). */
async function memoryDeepVecRoute(q: string): Promise<RankedDoc[]> {
  try {
    return parseBlocks(
      await runQmd(['vsearch', q, '--min-score', '0', '-n', String(DEEP_VEC_N), '-c', 'memories'])
    )
  } catch (err) {
    console.error(`[qmd-search] memoryDeepVecRoute gave up: ${err}`)
    return []
  }
}

/** Memory version of runSemanticQuery: `qmd query <typed lines> -c memories`.
 *  The query and lex: line structure is unchanged (hyde/vec + single lex), only `-c memories` is added. */
async function runMemorySemanticQuery(qmdLines: string[]): Promise<string | null> {
  try {
    return await runQmd(['query', qmdLines.join('\n'), '-c', 'memories'])
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[qmd-search] qmd query -c memories degraded to the BM25 fill-in list: ${reason}`)
    return null
  }
}

/** Memory version of searchPipeline: BM25 multi-route (whole sentence + per keyword + alias routes) -> RRF -> weights.
 *  Symmetric with the knowledge searchPipeline; the only differences are that it calls memoryRoute
 *  (argv carries -c memories) and passes { memoryDecay: true } explicitly to applyWeights, so
 *  memory-leg time decay is **always on** and does not read the QMD_MEMORY_DECAY environment variable.
 *  Knowledge-leg paths are not qmd://memories/ and memoryDecayFactor returns 1 for them, so the two legs do not pollute each other.
 *  The sort path-tiebreak is driven by `memOn` inside applyWeights — always true here,
 *  so ties re-order by path; non-memory results are unaffected because their scores do not change. */
export async function memorySearchPipeline(query: string): Promise<RankedDoc[]> {
  const clean = sanitize(query)
  const keywords = extractKeywords(query)
  const routes = [clean, ...keywords.filter(k => k !== clean)]
  const seenRoutes = new Set(routes.map(routeKey))
  const aliasRoutes: string[] = []
  for (const a of expansionsFromAliases(query, { limit: ALIAS_ROUTE_CAP + 2 })) {
    const s = sanitize(a)
    const key = s.toLowerCase()
    if (!s || seenRoutes.has(key)) continue
    seenRoutes.add(key)
    aliasRoutes.push(s)
    if (aliasRoutes.length >= ALIAS_ROUTE_CAP) break
  }
  const weights = [
    ...routes.map(() => 1),
    ...aliasRoutes.map(() => EXPANSION_ROUTE_WEIGHT),
  ]
  const lists = await mapCapped(
    [...routes, ...aliasRoutes], MAX_CONCURRENT_QMD, memoryRoute
  )
  const merged = rrfMerge(lists, 60, weights)
  return applyWeights(merged, new Date(), {
    channelStatus: isChannelStatusQuery(query),
    memoryDecay: true,
  })
}

/** Memory version of queryPipeline: semantic (qmd query -c memories) + BM25 (memoryRoute multi-route)
 *  + memoryDeepVecRoute, three routes in parallel -> weighted RRF -> weights.
 *  Symmetric with queryPipeline; the query line count is 1 (originally 1 + 2 = 3 routes),
 *  and the concurrency cap gives one slot to the deep vec line — the same 3 child processes as the knowledge leg (MAX_CONCURRENT_QMD).
 *  applyWeights passes `memoryDecay: true` explicitly (always on), ignoring QMD_MEMORY_DECAY. */
export async function memoryQueryPipeline(
  query: string,
  extraVecLines: string[] = [],
): Promise<RankedDoc[]> {
  const qmdLines = [`hyde:${sanitize(query)}`, `vec:${sanitize(query)}`]
  for (const v of extraVecLines) {
    const t = sanitize(v)
    if (t) qmdLines.push(`vec:${t}`)
  }
  qmdLines.push(`lex:${sanitize(query)}`)

  const bm25Keywords = extractKeywords(query, BM25_KEYWORD_CAP)
  const expKeywords = expansionKeywords(extraVecLines, [sanitize(query), ...bm25Keywords])
  const bm25Weights = [
    ...bm25Keywords.map(() => 1),
    ...expKeywords.map(() => EXPANSION_ROUTE_WEIGHT),
  ]
  const bm25ListsPromise = mapCapped(
    [...bm25Keywords, ...expKeywords], MAX_CONCURRENT_QMD - 2, k => memoryRoute(k)
  ).then(lists => rrfMerge(lists, 60, bm25Weights))

  const [semanticRaw, bm25List, deepVecList] = await Promise.all([
    runMemorySemanticQuery(qmdLines),
    bm25ListsPromise,
    memoryDeepVecRoute(sanitize(query)),
  ])
  const semanticList = semanticRaw ? parseBlocks(semanticRaw) : []
  const merged = rrfMerge([semanticList, bm25List, deepVecList], 60, [1.0, 0.5, DEEP_VEC_WEIGHT])
  return applyWeights(merged, new Date(), {
    channelStatus: isChannelStatusQuery(query),
    memoryDecay: true,
  })
}
