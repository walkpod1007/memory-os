#!/usr/bin/env bun
/**
 * qsc-cli.ts — CLI entry point to the production retrieval pipeline (for measurement)
 *
 * The real logic of vault_search / vault_query lives in search-pipeline.ts (shared with server.ts),
 * so measuring through this entry point measures production behaviour instead of calling qmd directly.
 *
 * Usage (output format mirrors `qmd ... --files`, one line `#qsc,<score>,<qmd://path>`):
 *   bun qsc-cli.ts search "natural-language question" [-n 10] [--no-exclude-bench]
 *   bun qsc-cli.ts query  "natural-language question" [-n 10] [--no-exclude-bench]
 *
 * By default benchmark files are excluded (they quote the test questions verbatim and would grab rank;
 * a guard against self-contamination, see BENCH_SELF_RE in rank-core.ts); the daily MCP path does not exclude them.
 */
import { searchPipeline, queryPipeline } from './search-pipeline.ts'
import { excludeBenchSelf } from './rank-core.ts'
import { expansionsFromAliases } from './alias-expand.ts'

/** Same value as TOTAL_EXPANSION_CAP in server.ts. The CLI has no caller-supplied expansions,
 *  so the whole quota goes to automatic wiki alias expansion — without it, the query mode measured here
 *  would have one route fewer than production (server.ts expands automatically)
 *  and "measuring production behaviour" would not hold. */
const TOTAL_EXPANSION_CAP = 4

const [mode, query, ...rest] = process.argv.slice(2)
if (!mode || !query || !['search', 'query'].includes(mode)) {
  console.error('usage: qsc-cli.ts search|query "<query>" [-n N] [--no-exclude-bench]')
  process.exit(2)
}
let n = 10
const nIdx = rest.indexOf('-n')
if (nIdx >= 0 && rest[nIdx + 1]) n = parseInt(rest[nIdx + 1], 10) || 10
const exclude = !rest.includes('--no-exclude-bench')

let docs = mode === 'search'
  ? await searchPipeline(query)
  : await queryPipeline(query, expansionsFromAliases(query, { limit: TOTAL_EXPANSION_CAP }))
if (exclude) docs = excludeBenchSelf(docs)
for (const d of docs.slice(0, n)) {
  console.log(`#qsc,${d.score.toFixed(4)},${d.path}`)
}
