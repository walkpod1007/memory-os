#!/usr/bin/env bun
/**
 * qmd-search MCP server — lets a Claude Code session search your notes, cards and archived chats
 * Calls the qmd CLI underneath (BM25 fast search + semantic search)
 *
 * Tools:
 *   - vault_search: fast keyword search (BM25, returns in about a second)
 *   - vault_query:  deep semantic search (vectors + HyDE expansion, 10-20 seconds)
 *   - memory_search / memory_query: the same two, over the archived chat transcripts collection
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { expansionsFromAliases } from './alias-expand.ts'
import {
  searchPipeline, queryPipeline,
  memorySearchPipeline, memoryQueryPipeline,
} from './search-pipeline.ts'
import type { RankedDoc } from './rank-core.ts'

/** Total quota of retrieval routes: variants supplied by the caller + aliases added automatically, at most this many.
 *  Caller-supplied ones take their slots first; automatic ones only fill what is left (see alias-expand.ts). */
const TOTAL_EXPANSION_CAP = 4

function extractDateFromBlock(block: string): string | null {
  // Try path-based date: daily/2026-04-04/0107-session.md → [2026-04-04 01:07]
  const dailyMatch = block.match(/daily\/(\d{4}-\d{2}-\d{2})\/(\d{2})(\d{2})-/)
  if (dailyMatch) {
    return `${dailyMatch[1]} ${dailyMatch[2]}:${dailyMatch[3]}`
  }

  // Try frontmatter date + time in context: date: 2026-04-04 / time: 01:08
  const dateMatch = block.match(/date:\s*(\d{4}-\d{2}-\d{2})/)
  const timeMatch = block.match(/time:\s*(\d{2}:\d{2})/)
  if (dateMatch) {
    return timeMatch ? `${dateMatch[1]} ${timeMatch[1]}` : dateMatch[1]
  }

  // Try filename date: 2026-04-06-norbert-wiener-...-dream.md
  const fileMatch = block.match(/(\d{4}-\d{2}-\d{2})-[a-z]/)
  if (fileMatch) {
    return fileMatch[1]
  }

  return null
}

function formatDocs(docs: RankedDoc[], maxResults: number): string {
  // Results come from search-pipeline (multi-route RRF + weighted ranking);
  // presentation reuses the block (Title/Score/context); without a block it degrades to a one-line path
  const limited = docs.slice(0, maxResults)

  if (limited.length === 0) {
    return 'No results.'
  }

  return limited.map(doc => {
    const block = doc.block ?? doc.path
    const date = extractDateFromBlock(block)
    return date ? `[${date}]\n${block}` : block
  }).join('\n\n---\n\n')
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const mcpServer = new Server(
  { name: 'qmd-search', version: '0.2.0' },
  {
    capabilities: { tools: {} },
    instructions: `Personal notes and memory search. Use it when you need to recall past conversations, look up something the user said, or find an earlier solution or decision.
vault_search returns in about a second and is a good first try; vault_query is more accurate but takes 10-20 seconds, so use it when the first finds nothing.

**Query expansion best practice**: when calling vault_query, first think of 2 semantic variants (different words, a different language, a different angle) and put them in the expansions array.
Example: query="how do I fix the chat bot", expansions=["chat bot restart procedure", "chat bot recovery steps"]
This makes qmd run several vector searches and merge them with RRF, which noticeably improves recall. It also works without expansions (single-query mode).

vault_query also recognizes wiki entries mentioned in the question and adds that entry's aliases (other languages, original titles, short names)
to the multi-route search, so a name written one way also finds the other. Automatic additions are listed at the end of the result; your own expansions always take priority.`,
  }
)

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'vault_search',
      description:
        'Fast search over notes, cards and skills (BM25 keywords, returns in about a second). ' +
        'Good for: a specific event, tool name, error message or person name. ' +
        'Keywords in any language the notes use.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords' },
          max_results: {
            type: 'number',
            description: 'Maximum number of results (default 5)',
            default: 5,
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'vault_query',
      description:
        'Deep semantic search (vectors + HyDE, 10-20 seconds). ' +
        'Good for: vague recall, conceptual questions, "how did I handle X last time". ' +
        'Try vault_search first and use this when that finds nothing.' +
        '\n\n**Query Expansion**: providing an expansions array greatly improves recall. ' +
        'Before calling, think of 2 semantic variants (different words, language or angle) and put them in expansions. ' +
        'Example: query="how do I fix the webhook disconnect", expansions=["webhook connection failure repair","webhook restart procedure"]' +
        '\nAliases of wiki entries mentioned in the question are added automatically (a name written one way also finds the other forms); ' +
        'your expansions take quota first, at most 4 routes in total.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language question (main query)' },
          expansions: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Semantic variant queries (0-4) describing the same intent in different wording, language or angle. ' +
              'If fewer than 4 are given, the remaining quota is filled from the wiki alias table',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of results (default 5)',
            default: 5,
          },
        },
        required: ['query'],
      },
    },
    // ── archived-transcript entry points ────────────
    // Map to memorySearchPipeline / memoryQueryPipeline in search-pipeline.ts,
    // which pass `-c memories` explicitly. The schema reuses the vault_search / vault_query
    // shape (only the name and routing differ), so a caller can switch with the same code.
    // Wording: describe the collection as "archived chat transcripts" (an event stream),
    // not as distilled memory cards; distilled cards and wiki entries stay with
    // vault_search / vault_query.
    {
      name: 'memory_search',
      description:
        'Fast search over archived chat transcripts (the memories collection; BM25 keywords, returns in about a second). ' +
        'Uses the same RRF + weighting pipeline as vault_search; the only difference is the collection argument: `qmd search/vsearch/query` all carry `-c memories`, ' +
        'and a memory-specific time decay is **always applied** (the date is read from the file header "台北時間 ... — end time", 30-day half-life, floor 0.4; ' +
        'missing, bad or future dates go to fixed buckets). It is not controlled by the `QMD_MEMORY_DECAY` environment variable. ' +
        'Good for: a specific past event, person name, error message or decision record.' +
        '\n\n**Scope**: distilled memory cards, wiki entries and insights go through `vault_search` or `vault_query`, ' +
        '**not** memory_*; written rules go through `vault_query` plus `grep -rn`, and counting questions over the event stream go to the raw files with `awk`/`grep -c`.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords' },
          max_results: {
            type: 'number',
            description: 'Maximum number of results (default 5)',
            default: 5,
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'memory_query',
      description:
        'Deep semantic search over archived chat transcripts (the memories collection; vectors + HyDE, 10-20 seconds). ' +
        'Uses the same hybrid pipeline as vault_query; the only difference is the collection argument: `qmd query -c memories` + a memory BM25 fill-in list + a memory deep-vector route, ' +
        'and a memory-specific time decay is **always applied** (the date is read from the file header "台北時間 ... — end time", 30-day half-life, floor 0.4; ' +
        'missing, bad or future dates go to fixed buckets). It is not controlled by the `QMD_MEMORY_DECAY` environment variable. ' +
        'Good for: vague recall of past conversations, conceptual questions, "how did I handle X last time".' +
        '\n\n**Query Expansion**: providing an expansions array greatly improves recall. ' +
        'Before calling, think of 2 semantic variants (different words, language or angle) and put them in expansions. ' +
        'Example: query="what did we discuss in the chat yesterday", expansions=["chat conversation yesterday past","chat webhook schedule"]' +
        '\nAliases of wiki entries mentioned in the question are added automatically; your expansions take quota first, at most 4 routes in total.' +
        '\n\n**Scope**: distilled memory cards, wiki entries and insights go through `vault_search` or `vault_query`, ' +
        '**not** memory_*; written rules go through `vault_query` plus `grep -rn`, and counting questions over the event stream go to the raw files with `awk`/`grep -c`.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language question (main query)' },
          expansions: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Semantic variant queries (0-4) describing the same intent in different wording, language or angle. ' +
              'If fewer than 4 are given, the remaining quota is filled from the wiki alias table',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of results (default 5)',
            default: 5,
          },
        },
        required: ['query'],
      },
    },
  ],
}))

mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  const query = String(args?.query ?? '').trim()

  if (!query) {
    return { content: [{ type: 'text', text: 'ERROR: query must not be empty' }] }
  }

  const maxResults = Number(args?.max_results) || 5

  if (name === 'vault_search') {
    try {
      // Whole sentence + per-keyword multi-route BM25 -> RRF -> weighted ranking.
      // A long question gets zero hits under qmd's native AND semantics; this rescues it
      const docs = await searchPipeline(query)
      const formatted = formatDocs(docs, maxResults)
      return { content: [{ type: 'text', text: formatted }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `vault_search failed: ${err}` }] }
    }
  }

  if (name === 'vault_query') {
    try {
      const given = Array.isArray(args?.expansions) ? (args.expansions as string[]) : []
      // Caller-supplied variants take quota first; automatic alias additions only fill the rest
      const userExpansions = given.map((e) => String(e)).filter((e) => e.trim()).slice(0, TOTAL_EXPANSION_CAP)
      const autoExpansions = expansionsFromAliases(query, {
        limit: TOTAL_EXPANSION_CAP - userExpansions.length,
        exclude: userExpansions,
      })
      const expansions = [...userExpansions, ...autoExpansions]

      // hyde/vec as before; the BM25 side runs per-keyword routes; results then go through
      // type-weight ranking (dump files down-weighted, curated cards slightly up, recency tiebreak) —
      // route building and weights live in search-pipeline.ts / rank-core.ts, shared with qsc-cli for measurement
      const docs = await queryPipeline(query, expansions)
      const formatted = formatDocs(docs, maxResults)
      // Say what was added automatically — an invisible hook-up is as good as none (it may add the wrong thing, and people can only fix what they can see)
      const footer =
        autoExpansions.length > 0
          ? `\n\n---\n(Also added ${autoExpansions.length} route(s) from the wiki alias table: ${autoExpansions.join(', ')})`
          : ''
      return { content: [{ type: 'text', text: formatted + footer }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `vault_query failed: ${err}` }] }
    }
  }

  // ── archived-transcript handlers (memory endpoints) ─────────────────────────
  // Same formatting and error shape as vault_search / vault_query; only the caller
  // changes to memorySearchPipeline / memoryQueryPipeline in search-pipeline.ts,
  // which always pass `-c memories` and always apply memoryDecay: true
  // (always on, independent of QMD_MEMORY_DECAY).
  // The structure deliberately mirrors the two handlers above so the argv and
  // return differences can be compared at a glance.
  if (name === 'memory_search') {
    try {
      const docs = await memorySearchPipeline(query)
      const formatted = formatDocs(docs, maxResults)
      return { content: [{ type: 'text', text: formatted }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `memory_search failed: ${err}` }] }
    }
  }

  if (name === 'memory_query') {
    try {
      const given = Array.isArray(args?.expansions) ? (args.expansions as string[]) : []
      const userExpansions = given.map((e) => String(e)).filter((e) => e.trim()).slice(0, TOTAL_EXPANSION_CAP)
      const autoExpansions = expansionsFromAliases(query, {
        limit: TOTAL_EXPANSION_CAP - userExpansions.length,
        exclude: userExpansions,
      })
      const expansions = [...userExpansions, ...autoExpansions]
      const docs = await memoryQueryPipeline(query, expansions)
      const formatted = formatDocs(docs, maxResults)
      const footer =
        autoExpansions.length > 0
          ? `\n\n---\n(Also added ${autoExpansions.length} route(s) from the wiki alias table: ${autoExpansions.join(', ')})`
          : ''
      return { content: [{ type: 'text', text: formatted + footer }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `memory_query failed: ${err}` }] }
    }
  }

  throw new Error(`Unknown tool: ${name}`)
})

const transport = new StdioServerTransport()
await mcpServer.connect(transport)
