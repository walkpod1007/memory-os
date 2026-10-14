# memory-os

Three small, independent pieces that give a Claude Code assistant a long-term memory without a database server:

1. **notes/** -- a *write-time* observation-note generator. Every night it turns the previous day's chat logs into a dense, dated, speaker-tagged note file using a small LLM (Claude Haiku by default).
2. **recall/** -- `recall-router`, a `UserPromptSubmit` hook. On every prompt it looks for a *high-confidence* match against your skills and memory cards and injects a short "related cards / skills" block. Low confidence means it prints nothing. No network, no model, standard-library Python only.
3. **search/** -- configuration and a small MCP server (`qmd-search`) on top of qmd (a local markdown search CLI): multi-route retrieval (BM25 + vector + alias expansion) fused with RRF and a few ranking heuristics (time decay, down-weighting of dump files).

Extracted from a personal memory system. The memory *cards themselves* are not included, only the format.

> Status: draft v1, extracted by hand from a private codebase. See "Limitations and known issues" before relying on it.

## How the pieces fit

```
raw chats --(notes/chatlog_redact.py)--> redacted mirror --(notes/memory_notes_nightly.py + LLM)--> notes/YYYY-MM-DD.md
                                                                                                         |
cards/*.md  + cards/MEMORY.md  + skills/*/SKILL.md + skill-routes.md                                      |
        |                                                                                                 |
        +--(recall/inject.sh, every prompt, offline)--> "related cards / skills" block in the prompt       |
        +--(qmd index of notes/ and cards/)--(search/server.ts, MCP)--> vault_search / vault_query <-------+
```

* The notes generator is the only part that talks to a network (the Anthropic Messages API) and the only part that costs money. It logs token usage and estimated USD per call to `state/api-spend.tsv` and checks the accumulated spend against `--max-usd` (default 1.0 per run) before every API call. The cost of a call is only known afterwards, so a run can overshoot the cap by at most one call; it then stops with exit code 4 and the interrupted day is not written.
* The recall hook never reads `notes/`. It reads memory *cards* (hand-written or agent-written short files) and skill descriptions.
* The search server reads whatever qmd collections you configure.

## Requirements

| Piece | Needs |
|---|---|
| notes | python3 >= 3.8, an Anthropic API key, network |
| recall | python3 >= 3.8 |
| search | [bun](https://bun.sh), qmd (a local markdown search CLI) (tested with 2.8.x), a local GGUF embedding model downloaded by qmd |

## Install

```bash
git clone <this repo> memory-os && cd memory-os
bash install.sh --check     # prerequisites + offline self-tests in a temp dir, changes nothing
bash install.sh             # creates $MEMORY_OS_HOME layout and prints the hook JSON to add
```

`install.sh` never edits `~/.claude/settings.json` or `~/.config/qmd/index.yml`. It prints what you should add.

Layout it creates under `$MEMORY_OS_HOME` (default `~/.memory-os`):

```
chats/raw/<channel>/<YYYY-MM-DD>.md   your chat logs (input)
chats/redacted/...                    mirror with credentials masked (written by chatlog_redact.py)
notes/YYYY-MM-DD.md                   generated observation notes (output)
cards/MEMORY.md, cards/*.md           memory cards and their index
skills/<name>/SKILL.md, skill-routes.md   skills the recall hook can suggest
state/                                spend log, error log
qmd-embed-model                       one line: the embedding model URI for search/
```

### 1. Notes generator

Input format, one file per channel per day: `chats/redacted/<channel>/<YYYY-MM-DD>.md` containing messages headed by `### HH:MM <emoji> <speaker>`:

```
### 09:12 👤 User
Ordered a 65-inch TV, budget 900 USD.

### 09:13 🤖 AI
Noted.
```

(`👤 User` and a bare empty name map to `MEMORY_NOTES_USER_NAME`; `🤖 AI` maps to `MEMORY_NOTES_ASSISTANT_NAME`; any other name is kept as a group-member display name.) There is no built-in converter from raw Claude Code transcripts or chat exports; you have to produce this layout yourself.

```bash
export ANTHROPIC_API_KEY=...            # or MEMORY_NOTES_KEY_FILE / MEMORY_NOTES_SECURITY_SERVICE, see below
python3 notes/chatlog_redact.py --src ~/.memory-os/chats/raw --out ~/.memory-os/chats/redacted
bash notes/run_nightly.sh --dry-run --day 2026-01-01     # no API call, prints message/chunk counts
bash notes/run_nightly.sh                                # yesterday
bash notes/run_nightly.sh --from 2026-01-01 --to 2026-01-31 --max-usd 2.0   # stops before the next API call once spend >= 2.0
```

Behavior worth knowing: a day is split into <= 30,000-character chunks; each chunk is validated (first line must start with `### 日期`, 3 retries); a day is written atomically only if every chunk passed; unchanged input (same `input_sha256` in the note's frontmatter) is skipped unless `--force`. The prompt and the required note headings are in Traditional Chinese; edit `OBS_RULES_TEMPLATE` in `notes/memory_notes_nightly.py` for other languages. Generated notes carry `untrusted: true` in their frontmatter: they are model output over chat text and should never be treated as instructions.

Time handling: the default "yesterday" and the `generated_at` field use UTC+8 (Taipei time), hard-coded in `memory_notes_nightly.py`; pass `--day` explicitly or edit the timezone if you live elsewhere. `MEMORY_NOTES_API_URL` must be `https://` (plain `http://` is accepted only for localhost, because the key is sent in a header).

Scheduling is up to you (cron, launchd, systemd timer), e.g. `40 4 * * * MEMORY_OS_HOME=$HOME/.memory-os bash /path/to/memory-os/notes/run_nightly.sh`.

Putting the API key somewhere: `run_nightly.sh` tries, in order, `$ANTHROPIC_API_KEY`; the first line of the file named by `$MEMORY_NOTES_KEY_FILE`; on macOS the generic-password item whose service is `$MEMORY_NOTES_SECURITY_SERVICE` (and optional account `$MEMORY_NOTES_SECURITY_ACCOUNT`), created with `security add-generic-password -s <service> -a <account> -w`. Run `memory_notes_nightly.py` directly and it reads only `$ANTHROPIC_API_KEY`.

### 2. recall-router hook

1. Put skills in `$MEMORY_OS_HOME/skills/<name>/SKILL.md` (frontmatter `description:` is what gets matched), optionally a trigger table `$MEMORY_OS_HOME/skill-routes.md` (`| "trigger phrase" | \`skill-name\` |` rows), and cards in `$MEMORY_OS_HOME/cards/`.
2. Add the hook JSON printed by `install.sh` (template: `config/claude-hook.example.json`) to the `hooks` section of the settings file of the scope you want (user-level `~/.claude/settings.json` or a project's `.claude/settings.json`).
3. Test without Claude Code: `echo '{"prompt":"please dim the lights"}' | bash recall/inject.sh`.

Design: the input is the hook's stdin JSON (`prompt` field); output is plain text appended to context, hard-capped at a conservative 800 estimated tokens; **every failure path exits 0 with empty output** so it can never block a prompt; short chit-chat ("ok", "thanks", ...) is short-circuited. Matching is character n-gram overlap with IDF weighting against skill descriptions, trigger phrases, card names/descriptions/bodies, and index titles.

### 3. Search (qmd + MCP)

```bash
cp config/qmd-embed-model.example "$MEMORY_OS_HOME/qmd-embed-model"      # install.sh does this
# merge config/qmd-index.example.yml into ~/.config/qmd/index.yml by hand, fix the paths
qmd update
QMD_EMBED_MODEL="$(grep -v '^#' "$MEMORY_OS_HOME/qmd-embed-model" | head -n 1)" qmd embed   # same model search/ will query with (see "Which embedding model setting wins")
cd search && bun install && bun server.ts                                  # MCP server on stdio
bun qsc-cli.ts query "where did the TV go" -n 5                            # CLI for the same pipeline
```

Register `bun /path/to/memory-os/search/server.ts` as an MCP server in your client. Tools: `vault_search` (BM25, fast), `vault_query` (hybrid with expansions, 10-20 s), plus two memory-collection variants. `search-pipeline.ts` refuses to run if `qmd-embed-model` is missing, on purpose: querying a vector index with the wrong embedding model silently returns bad answers.

**Which embedding model setting wins (important).** qmd resolves the embedding model as: `models.embed` in `~/.config/qmd/index.yml` first, then the `QMD_EMBED_MODEL` environment variable, then its built-in default. `search/` passes the one-line `qmd-embed-model` file to qmd as `QMD_EMBED_MODEL` on every query, so **if `index.yml` sets a different `models.embed`, the file is silently ignored.** Also, `qmd update && qmd embed` run in your own shell only sees what *you* set: either keep `models.embed` in `index.yml` identical to `qmd-embed-model`, or run `QMD_EMBED_MODEL="$(grep -v '^#' $MEMORY_OS_HOME/qmd-embed-model | head -n 1)" qmd embed` so the index is built with the same model that queries use. `bash install.sh` (and `--check`) warns when `index.yml`, `$QMD_EMBED_MODEL` and the model file disagree; it only reads, never edits, your qmd config.

**Embedding / rank models.** Default here is EmbeddingGemma (Google, GGUF, see `config/qmd-embed-model.example`). Qwen3-Embedding (Alibaba) is listed as an optional alternative. Pick whichever fits your own policy; the two are not interchangeable once an index exists, so re-run `qmd embed -f` after switching. I could not verify an "EmbeddingGemma 2" GGUF repo name while preparing this draft; the example file points at the EmbeddingGemma 300M GGUF and says to verify it.

## Environment variables

| Variable | Used by | Default | Meaning |
|---|---|---|---|
| `MEMORY_OS_HOME` | all | `~/.memory-os` | data root |
| `ANTHROPIC_API_KEY` | notes | none | API key |
| `MEMORY_NOTES_KEY_FILE` | run_nightly.sh | none | file whose first line is the key |
| `MEMORY_NOTES_SECURITY_SERVICE`, `MEMORY_NOTES_SECURITY_ACCOUNT` | run_nightly.sh (macOS) | none | generic-password item to read the key from |
| `MEMORY_NOTES_SRC` | notes | `$MEMORY_OS_HOME/chats/redacted` | input root |
| `MEMORY_NOTES_OUT` | notes | `$MEMORY_OS_HOME/notes` | output dir |
| `MEMORY_NOTES_STATE` | notes | `$MEMORY_OS_HOME/state` | spend and error logs |
| `MEMORY_NOTES_PRICES` | notes | `<config dir>/api-prices.tsv` | price table file (edit it; the numbers are examples) |
| `MEMORY_NOTES_CONFIG` | notes | `config/` next to the repo | directory that contains `api-prices.tsv` (`MEMORY_NOTES_PRICES` overrides the file itself) |
| `MEMORY_NOTES_MODEL` | notes | `claude-haiku-5-5` | model id; must exist in the price table |
| `MEMORY_NOTES_API_URL` | notes | Anthropic Messages endpoint | override for a proxy; must be https (http only for localhost) |
| `MEMORY_NOTES_USER_NAME`, `MEMORY_NOTES_ASSISTANT_NAME` | notes | `User`, `Assistant` | speaker labels in the notes |
| `RECALL_ROUTER_ROUTES_MD` | recall | `$MEMORY_OS_HOME/skill-routes.md` | trigger table |
| `RECALL_ROUTER_SKILLS_DIR` | recall | `$MEMORY_OS_HOME/skills` | skills dir |
| `RECALL_ROUTER_MEMORY_MD` | recall | `cards/MEMORY-FULL.idx` + `cards/MEMORY.md` (joined with `:`) | card index file(s); cards are read from the same directory |
| `QMD_BIN` | search | `qmd` | qmd binary |
| `QMD_EMBED_MODEL_FILE` | search | `$MEMORY_OS_HOME/qmd-embed-model` | embedding model URI file |
| `QMD_SEARCH_RETRY_LOG` | search | `$MEMORY_OS_HOME/state/qmd-search-retry.log` | retry ledger |
| `QMD_ALIAS_TABLE`, `QMD_ALIAS_EXPAND` | search | `$MEMORY_OS_HOME/aliases.json`, on | alias expansion table; `0` disables |
| `QMD_MEMORIES_ROOT` | search | `$MEMORY_OS_HOME/sessions/` | root of the optional "memories" collection used for time decay |
| `QMD_MEMORY_DECAY` | search | off | does **not** control the memories collection: time decay there (`memory_search` / `memory_query`) is always on and cannot be turned off. The variable only switches on a deterministic path-order tiebreak for equal scores in `vault_search` / `vault_query` results (`1`, `true`, `yes` or `on`) |

Redaction: `chatlog_redact.py` masks password-looking strings (`password: x`, `Password=x`, `my password is x`, `密碼是 x`), API keys/tokens (including `sk-...`, `Bearer <token>`, JWTs, `ya29.`, `npm_`), PEM private-key blocks, `user:password@` inside URLs and a few other bare key formats, plus any exact string listed (one per line) in `$MEMORY_OS_HOME/redact-denylist.txt`. Keep that file outside any git repo. It is heuristic: **review the mirror before sending anything to an external API.**

## Memory card format (general)

A card is one short Markdown file in `cards/`:

```markdown
---
name: tv-purchase
description: One sentence saying when this card applies, in the words you would use when asking about it.
metadata:
  type: project        # free-form: user | feedback | project | reference ...
---
The fact or rule, stated plainly.

**Why:** the reason or incident behind it.
**How to apply:** when and how it should change behavior.
```

* `description` is the retrieval surface: the recall hook weights description x3, name x2, body x1. Write it for matching, not for style.
* `cards/MEMORY.md` is a *thin index*, not a dump: one line per family, `- 【family】title／title／title`. Add a card by adding its title to the family line. Never load it whole into a session; let recall (or `grep -il`) find cards.
* `cards/MEMORY-FULL.idx` (optional) uses the same line format and may be a longer version of the index.
* Rule of thumb that the design rests on: keep three stores separate, each with its own retrieval method -- *event stream* (raw logs; answer counting questions with grep/awk, not embeddings), *knowledge* (distilled cards/wiki; BM25 + vector), *explicit rules* (instructions; locate semantically, then grep the exact text).

## Evidence, and how much to trust it

In one person's small pilot (30 questions about one week of private chat logs), searching raw logs directly answered 2 of 30; reading nightly observation notes answered 28 of 30; notes plus raw search also 28. That is one person, one week, hand-graded, and the corpus is not included. Treat it as motivation for the write-time-notes idea, not as a benchmark.

## Limitations and known issues

* **Not a turnkey product.** Three parts extracted from a larger system; there is no end-to-end test beyond `install.sh --check` (syntax, recall on demo data, notes `--dry-run`). The notes generator's API path is exercised only against a local mock server in `tests/test_max_usd.py` (no real key used).
* **Notes truncation.** The generator caps output at 16,000 tokens per chunk. On dense days the model can hit `max_tokens`; the script logs it to `state/memory-notes-nightly/errors.log` but still writes the possibly truncated note. Lower the chunk size (`chunk_messages(max_chars=...)`) if you see it.
* **Validation failures.** A chunk whose first line is not `### 日期...` is retried 3 times and then fails the whole day (nothing written). Failure rate on large backfills was not measured.
* **Recall router is tuned for Traditional Chinese.** Thresholds were calibrated on one person's own cards. On English prompts it can match on common words (try `where did the TV go` against the demo data: it also suggests the demo skill via the word "the"). Expect to retune `SKILL_*` / `CONTENT_*` constants and the chit-chat list for your language.
* **search/ is the least portable part.** `rank-core.ts` contains path-pattern weights and decay classes written for one person's collection names (`vault`, `notes`, `daily`, `tickets`, `drafts`, `chatlogs`, `memories`) and a `- 台北時間 ... — YYYY-MM-DD HH:MM` header convention for the optional memories collection. If your collections are named differently those rules silently match nothing. The original unit test file (`alias-expand.test.ts`) is not included; the benchmark harness is not included.
* **Not included on purpose:** the alias-table generator that produces `aliases.json` (alias expansion stays effectively off until you provide that file), a second incremental notes pipeline for coding-assistant transcripts, all real memory cards, notes and logs.
* **Tests:** `python3 tests/test_redact.py` and `python3 tests/test_max_usd.py` run offline (the latter against a local mock server); `bash install.sh --check` runs both.
* The default API model id and the price table are examples; check current model names and prices yourself.

## License

MIT, see `LICENSE`.

---

## 繁體中文摘要

memory-os 把一套個人用的「記憶系統」中三件可獨立使用的部分抽出來：

1. **notes/**：寫入時整理觀察筆記。每晚把前一天的對話（先遮罩密碼與金鑰）交給 Claude Haiku，產出帶時間、發言者、優先級（紅黃綠）的每日筆記。這是唯一會花錢、會連外網的一段，有 `--max-usd` 花費上限（每次呼叫 API 前檢查累計花費，最多超出一次呼叫的金額，超過即停並以代碼 4 結束）與 `state/api-spend.tsv` 記帳。
2. **recall/**：每輪自動召回 hook（`UserPromptSubmit`）。用字元 n-gram 比對 skill 描述與記憶卡，只有高信心才注入「相關卡片／技能」，上限約 800 token；不連網、不用模型，任何錯誤一律靜默放行。
3. **search/**：qmd 檢索設定與 MCP 外掛（BM25＋向量＋別名擴展，RRF 融合、時間衰減）。向量模型預設 EmbeddingGemma，Qwen3-Embedding 列為可選，兩者不能混用，換模型要重建索引。注意 qmd 的 `index.yml` 裡 `models.embed` 優先於環境變數 `QMD_EMBED_MODEL`，若兩者與 `qmd-embed-model` 檔不一致，檔案會被靜默忽略；`install.sh` 會警告。`QMD_MEMORY_DECAY` 不控制記憶集合的時間衰減（該衰減永遠開啟），只影響知識結果同分時的排序。

安裝：`bash install.sh --check` 只檢查並跑離線自測；`bash install.sh` 建立 `$MEMORY_OS_HOME`（預設 `~/.memory-os`）目錄並印出要手動加進 Claude Code settings 的 hook JSON，不會改你的既有設定。API 金鑰由環境變數、金鑰檔、或 macOS `security` 項目（名稱用環境變數設定）取得。

記憶卡格式：一張卡一個 Markdown 檔，frontmatter 有 `name`、`description`、`metadata.type`，內文寫事實加「Why／How to apply」；`MEMORY.md` 只當薄索引（族名加標題），靠 recall 或 grep 找卡，不整份載入。

限制：這是草稿；召回門檻是針對繁體中文與作者自己的卡片校準的，英文提示會誤中常見詞；`search/` 的排序規則寫死了作者的收藏集合命名；筆記產生器在資料很密的日子會撞 `max_tokens` 被截斷；API 路徑只用本機 mock 伺服器測過，沒有實際呼叫。
