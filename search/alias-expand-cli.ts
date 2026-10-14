#!/usr/bin/env bun
/**
 * alias-expand-cli — thin wrapper so the acceptance check can be run directly (a third party gets the same verdict)
 *
 * Usage: bun alias-expand-cli.ts "<query>" [limit]
 *   QMD_ALIAS_TABLE=<path>  use a different table (default $MEMORY_OS_HOME/aliases.json)
 *   QMD_ALIAS_EXPAND=0      turn the whole thing off
 * Output: one JSON array line on stdout. A missing or broken table always prints [] and exits 0 (visible proof of fail-open).
 */

import { expansionsFromAliases } from './alias-expand.ts'

const query = process.argv[2] ?? ''
const limit = process.argv[3] ? Number(process.argv[3]) : undefined

const out = expansionsFromAliases(query, limit === undefined ? {} : { limit })
console.log(JSON.stringify(out, null, 0))
