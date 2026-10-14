# memory-os

[English](README.md) | 繁體中文

三個小而獨立的部分，讓 Claude Code 助理擁有長期記憶，而且不需要資料庫伺服器：

1. **notes/**：寫入時觀察筆記（write-time observation notes）產生器。每晚用小型 LLM（預設是 Claude Haiku），把前一天的聊天紀錄整理成一份密度高、標好日期與發言者的筆記檔。
2. **recall/**：`recall-router`，一個 `UserPromptSubmit` hook。每次送出提示時，它會拿提示去比對你的技能（skill）與記憶卡，只有**高信心**的命中才會注入一小段「相關卡片／技能」區塊；信心不足就什麼都不輸出。不連網、不用模型，只用 Python 標準函式庫。
3. **search/**：設定檔與一支小型 MCP（Model Context Protocol）伺服器（`qmd-search`），架在 qmd（本機的 Markdown 搜尋 CLI）之上：多路檢索（BM25＋向量＋別名擴展），用 RRF（Reciprocal Rank Fusion，倒數排名融合）融合結果，再加上幾個排序的啟發式規則（時間衰減、調降傾印檔的權重）。

從一套個人記憶系統中抽出來的。記憶卡**本身**不包含在內，只提供格式。

> 狀態：草稿 v1，從私人程式碼庫手工抽出。要依賴它之前，請先讀「限制與已知問題」。

## 跑分：LongMemEval 完整 500 題

2026-10-10 我們拿 [LongMemEval](https://github.com/xiaowu0162/LongMemEval) 完整題庫（`longmemeval_s_cleaned`，500 題，每題約 50 段對話歷史）跑了一輪。用的是 `notes/` 背後的同一個做法：先由小模型把對話整理成帶日期的觀察筆記，作答模型只讀筆記，作答時完全不檢索。

| 題型 | 答對 | 分數 |
|---|---|---|
| 知識更新（knowledge-update） | 75 / 78 | 96.2% |
| 跨多段對話（multi-session） | 120 / 133 | 90.2% |
| 單段・助理說過的話（single-session-assistant） | 54 / 56 | 96.4% |
| 單段・使用者偏好（single-session-preference） | 30 / 30 | 100% |
| 單段・使用者說過的話（single-session-user） | 68 / 70 | 97.1% |
| 時間推理（temporal-reasoning） | 128 / 133 | 96.2% |
| **整體** | **475 / 500** | **95.0%** |
| 六種題型平均 | | 96.0% |

設定：Claude Haiku 5.5 寫筆記（每題的歷史依日期排序，約 4 萬字元一包）；Claude Sonnet 5.5（effort medium）只讀筆記作答；判分用 LongMemEval 官方提示詞配 `gpt-4o-2024-08-06`。應該拒答的 30 題裡答對 27 題。

同樣 500 題、同一個作答模型與判分方式的對照：

| 做法 | 整體 | 六型平均 |
|---|---|---|
| 向量檢索，取前 5 段對話放進提示 | 88.2% | 90.7% |
| 調校過的混合檢索，用 `search/` 底下的 qmd（BM25＋向量＋重排序，取前 10 段，加日期錨點與兩條作答規則） | 92.2% | 93.2% |
| **寫入時觀察筆記（本做法）** | **95.0%** | **96.0%** |
| Mastra Observational Memory 公布數字，`gpt-5-mini`（[出處](https://mastra.ai/research/observational-memory)） | 93.6% | 94.9% |

這組數字可以信到哪裡：

* **只跑了一輪。** 筆記規則只改一條，99 題的子集就差了 3 題，所以重跑本身就會有幾題的浮動。整體比 Mastra 公布的數字多 7 題，落在這個浮動的邊緣；跨多段對話那一類（120 對 116）是最站得住的差距。
* **作答模型和 Mastra 不同**（Claude Sonnet 5.5 對 `gpt-5-mini`），Mastra 那一列請當參考點看，不是同條件對打。
* **跑分腳本不在這個 repo 裡。** 跑分用的是針對 LongMemEval 調過的觀察提示詞與分包方式；這裡的 `notes/` 是處理真實聊天紀錄的每晚產生器，做法相同，但不是產出這組數字的那支程式。

## 各部分如何組合

```
原始對話 --(notes/chatlog_redact.py)--> 遮罩鏡像 --(notes/memory_notes_nightly.py + LLM)--> notes/YYYY-MM-DD.md
                                                                                                           |
cards/*.md  + cards/MEMORY.md  + skills/*/SKILL.md + skill-routes.md                                       |
        |                                                                                                  |
        +--(recall/inject.sh，每次提示，離線)--> 提示中的「相關卡片／技能」區塊                            |
        +--(notes/ 與 cards/ 的 qmd 索引)--(search/server.ts, MCP)--> vault_search / vault_query <---------+
```

* 筆記產生器是唯一會連網（Anthropic Messages API）的部分，也是唯一會花錢的部分。它每次呼叫都會把 token 用量與估算的美元費用記到 `state/api-spend.tsv`，並在每次呼叫 API 之前，拿累計花費對照 `--max-usd`（預設每次執行 1.0）。一次呼叫的費用要等呼叫完才知道，所以一次執行最多會超出上限一次呼叫的金額；超出之後它會以結束代碼 4 停止，被中斷的那一天不會寫入。
* 召回 hook 從不讀 `notes/`。它讀的是記憶卡（手寫或由 agent 寫的短檔）與技能描述。
* 搜尋伺服器讀的是你設定的 qmd 集合（collection），設了哪些就讀哪些。

## 需求

| 部分 | 需求 |
|---|---|
| notes | python3 >= 3.8、Anthropic API 金鑰、網路 |
| recall | python3 >= 3.8 |
| search | [bun](https://bun.sh)、qmd（本機的 Markdown 搜尋 CLI，測試過 2.8.x）、由 qmd 下載的本機 GGUF 嵌入模型 |

## 安裝

```bash
git clone <this repo> memory-os && cd memory-os
bash install.sh --check     # 檢查前置條件，並在暫存資料夾裡跑離線自我測試，不改動任何東西
bash install.sh             # 建立 $MEMORY_OS_HOME 的資料夾結構，並印出要加進設定的 hook JSON
```

`install.sh` 絕不會修改 `~/.claude/settings.json` 或 `~/.config/qmd/index.yml`，它只會印出你該加進去的內容。

它會在 `$MEMORY_OS_HOME`（預設 `~/.memory-os`）底下建立這樣的結構：

```
chats/raw/<channel>/<YYYY-MM-DD>.md   你的聊天紀錄（輸入）
chats/redacted/...                    遮罩掉憑證的鏡像（由 chatlog_redact.py 寫入）
notes/YYYY-MM-DD.md                   產生出來的觀察筆記（輸出）
cards/MEMORY.md, cards/*.md           記憶卡與其索引
skills/<name>/SKILL.md, skill-routes.md   召回 hook 可以建議的技能
state/                                花費紀錄、錯誤紀錄
qmd-embed-model                       一行文字：search/ 使用的嵌入模型 URI
```

### 1. 筆記產生器

輸入格式：每個頻道每天一個檔，`chats/redacted/<channel>/<YYYY-MM-DD>.md`，內容是以 `### HH:MM <emoji> <speaker>` 為標題的訊息：

```
### 09:12 👤 User
訂了一台 65 吋電視，預算 900 美元。

### 09:13 🤖 AI
好的，已記下。
```

（`👤 User` 與完全空白的名稱會對應到 `MEMORY_NOTES_USER_NAME`；`🤖 AI` 對應到 `MEMORY_NOTES_ASSISTANT_NAME`；其他名稱則原樣保留，當作群組成員的顯示名稱。）目前沒有內建的轉換器，能把原始的 Claude Code 對話紀錄（transcript）或聊天匯出檔轉成這個格式，要請你自己產出這個結構。

```bash
export ANTHROPIC_API_KEY=...            # 或改用 MEMORY_NOTES_KEY_FILE / MEMORY_NOTES_SECURITY_SERVICE，見下方
python3 notes/chatlog_redact.py --src ~/.memory-os/chats/raw --out ~/.memory-os/chats/redacted
bash notes/run_nightly.sh --dry-run --day 2026-01-01     # 不呼叫 API，印出訊息數與區塊數
bash notes/run_nightly.sh                                # 處理昨天
bash notes/run_nightly.sh --from 2026-01-01 --to 2026-01-31 --max-usd 2.0   # 累計花費 >= 2.0 就在下一次 API 呼叫前停止
```

值得知道的行為：一天會被切成每塊不超過 30,000 字元的區塊（chunk）；每個區塊都要驗證合格（第一行必須以 `### 日期` 開頭，驗證失敗最多重試 3 次）；一整天的區塊全部驗證合格，才會以原子方式寫入；輸入沒有變動（筆記 frontmatter 裡的 `input_sha256` 相同）就會略過，除非加上 `--force`。提示詞與必要的筆記標題都是繁體中文；若要改用其他語言，請編輯 `notes/memory_notes_nightly.py` 裡的 `OBS_RULES_TEMPLATE`。產生出來的筆記在 frontmatter 裡帶有 `untrusted: true`：它們是模型針對聊天文字產生的輸出，絕不能當成指令。

時間處理：預設的「昨天」與 `generated_at` 欄位都用 UTC+8（台北時間），寫死在 `memory_notes_nightly.py` 裡；如果你不在這個時區，請明確傳入 `--day`，或自行修改時區。`MEMORY_NOTES_API_URL` 必須是 `https://`（只有 localhost 可以用純 `http://`，因為金鑰是放在標頭裡送出的）。

排程由你自己決定（cron、launchd、systemd timer），例如：`40 4 * * * MEMORY_OS_HOME=$HOME/.memory-os bash /path/to/memory-os/notes/run_nightly.sh`。

API 金鑰放哪裡：`run_nightly.sh` 依序嘗試 `$ANTHROPIC_API_KEY`；`$MEMORY_NOTES_KEY_FILE` 所指檔案的第一行；在 macOS 上，則是服務名稱為 `$MEMORY_NOTES_SECURITY_SERVICE`（以及選用的帳戶 `$MEMORY_NOTES_SECURITY_ACCOUNT`）的一般密碼（generic-password）項目，用 `security add-generic-password -s <service> -a <account> -w` 建立。如果直接執行 `memory_notes_nightly.py`，它只會讀 `$ANTHROPIC_API_KEY`。

### 2. recall-router hook

1. 把技能放在 `$MEMORY_OS_HOME/skills/<name>/SKILL.md`（frontmatter 的 `description:` 就是拿來比對的內容），另外可以選擇性放一份觸發表 `$MEMORY_OS_HOME/skill-routes.md`（資料列格式為 `| "trigger phrase" | \`skill-name\` |`），並把記憶卡放進 `$MEMORY_OS_HOME/cards/`。
2. 把 `install.sh` 印出的 hook JSON（範本：`config/claude-hook.example.json`）加進你想套用範圍的 settings 檔的 `hooks` 區段：使用者層級的 `~/.claude/settings.json`，或專案的 `.claude/settings.json`。
3. 不用開 Claude Code 就能測試：`echo '{"prompt":"please dim the lights"}' | bash recall/inject.sh`。

設計：輸入是 hook 從 stdin 傳入的 JSON（`prompt` 欄位）；輸出是附加到上下文的純文字，硬性上限是保守估計的 800 個 token；**所有失敗路徑的結束代碼一律是 0，而且不輸出任何內容**，所以它絕不會擋住提示；簡短的閒聊（「ok」「thanks」……）會直接略過。比對方式是字元 n-gram 重疊再加上 IDF 加權，比對對象包括技能描述、觸發片語、記憶卡的名稱／描述／內文，以及索引標題。

### 3. 搜尋（qmd + MCP）

```bash
cp config/qmd-embed-model.example "$MEMORY_OS_HOME/qmd-embed-model"      # install.sh 會幫你做這一步
# 手動把 config/qmd-index.example.yml 合併進 ~/.config/qmd/index.yml，並修正裡面的路徑
qmd update
QMD_EMBED_MODEL="$(grep -v '^#' "$MEMORY_OS_HOME/qmd-embed-model" | head -n 1)" qmd embed   # 與 search/ 查詢時用的是同一個模型（見「哪一個嵌入模型設定優先」）
cd search && bun install && bun server.ts                                  # 走 stdio 的 MCP 伺服器
bun qsc-cli.ts query "where did the TV go" -n 5                            # 同一條管線的 CLI 版本
```

把 `bun /path/to/memory-os/search/server.ts` 註冊成你的客戶端裡的 MCP 伺服器。提供的工具有：`vault_search`（BM25，速度快）、`vault_query`（搭配查詢擴展的混合檢索，要 10 到 20 秒），另外還有兩個針對記憶集合的變體。`search-pipeline.ts` 在 `qmd-embed-model` 不存在時會拒絕執行，這是刻意的：用錯誤的嵌入模型去查向量索引，只會悄悄回傳很差的答案。

**哪一個嵌入模型設定優先（重要）**。qmd 決定嵌入模型的順序是：先看 `~/.config/qmd/index.yml` 裡的 `models.embed`，再看環境變數 `QMD_EMBED_MODEL`，最後才是內建預設值。`search/` 每次查詢都會把只有一行的 `qmd-embed-model` 檔，以 `QMD_EMBED_MODEL` 的形式傳給 qmd，所以**如果 `index.yml` 設了不同的 `models.embed`，那個檔案就會被悄悄忽略**。另外，你自己在 shell 裡執行 `qmd update && qmd embed` 時，只看得到*你*設定的內容：請讓 `index.yml` 裡的 `models.embed` 與 `qmd-embed-model` 保持一致，或者執行 `QMD_EMBED_MODEL="$(grep -v '^#' $MEMORY_OS_HOME/qmd-embed-model | head -n 1)" qmd embed`，讓建立索引用的模型和查詢用的模型相同。`bash install.sh`（以及 `--check`）會在 `index.yml`、`$QMD_EMBED_MODEL` 與模型檔三者不一致時發出警告；它只讀取、絕不修改你的 qmd 設定。

**嵌入／排序模型**。這裡預設用 EmbeddingGemma（Google，GGUF 格式，見 `config/qmd-embed-model.example`）。Qwen3-Embedding（阿里巴巴）列為選用的替代方案。要選哪一個，看你自己的使用政策；索引一旦建立，兩者就不能互換，所以換模型之後要重跑 `qmd embed -f`。我在準備這份草稿時，無法確認「EmbeddingGemma 2」的 GGUF 儲存庫名稱；範例檔指向的是 EmbeddingGemma 300M 的 GGUF，並註明要自行確認。

## 環境變數

| 變數 | 使用於 | 預設值 | 意義 |
|---|---|---|---|
| `MEMORY_OS_HOME` | 全部 | `~/.memory-os` | 資料根目錄 |
| `ANTHROPIC_API_KEY` | notes | 無 | API 金鑰 |
| `MEMORY_NOTES_KEY_FILE` | run_nightly.sh | 無 | 第一行是金鑰的檔案 |
| `MEMORY_NOTES_SECURITY_SERVICE`, `MEMORY_NOTES_SECURITY_ACCOUNT` | run_nightly.sh (macOS) | 無 | 用來讀取金鑰的一般密碼（generic-password）項目 |
| `MEMORY_NOTES_SRC` | notes | `$MEMORY_OS_HOME/chats/redacted` | 輸入根目錄 |
| `MEMORY_NOTES_OUT` | notes | `$MEMORY_OS_HOME/notes` | 輸出資料夾 |
| `MEMORY_NOTES_STATE` | notes | `$MEMORY_OS_HOME/state` | 花費與錯誤紀錄 |
| `MEMORY_NOTES_PRICES` | notes | `<config dir>/api-prices.tsv` | 價格表檔案（請自行編輯，裡面的數字只是範例） |
| `MEMORY_NOTES_CONFIG` | notes | repo 旁邊的 `config/` | 內含 `api-prices.tsv` 的資料夾（`MEMORY_NOTES_PRICES` 會覆蓋檔案本身） |
| `MEMORY_NOTES_MODEL` | notes | `claude-haiku-5-5` | 模型 ID；必須存在於價格表中 |
| `MEMORY_NOTES_API_URL` | notes | Anthropic Messages 端點 | 要走代理伺服器時可以覆寫；必須是 https（只有 localhost 可用 http） |
| `MEMORY_NOTES_USER_NAME`, `MEMORY_NOTES_ASSISTANT_NAME` | notes | `User`, `Assistant` | 筆記裡的發言者標籤 |
| `RECALL_ROUTER_ROUTES_MD` | recall | `$MEMORY_OS_HOME/skill-routes.md` | 觸發表 |
| `RECALL_ROUTER_SKILLS_DIR` | recall | `$MEMORY_OS_HOME/skills` | 技能資料夾 |
| `RECALL_ROUTER_MEMORY_MD` | recall | `cards/MEMORY-FULL.idx` + `cards/MEMORY.md`（以 `:` 連接） | 記憶卡索引檔；記憶卡從同一個資料夾讀取 |
| `QMD_BIN` | search | `qmd` | qmd 執行檔 |
| `QMD_EMBED_MODEL_FILE` | search | `$MEMORY_OS_HOME/qmd-embed-model` | 存放嵌入模型 URI 的檔案 |
| `QMD_SEARCH_RETRY_LOG` | search | `$MEMORY_OS_HOME/state/qmd-search-retry.log` | 重試紀錄 |
| `QMD_ALIAS_TABLE`, `QMD_ALIAS_EXPAND` | search | `$MEMORY_OS_HOME/aliases.json`，開啟 | 別名擴展表；設成 `0` 就停用 |
| `QMD_MEMORIES_ROOT` | search | `$MEMORY_OS_HOME/sessions/` | 選用的「memories」集合的根目錄，用於時間衰減 |
| `QMD_MEMORY_DECAY` | search | 關閉 | **不會**控制 memories 集合：該集合的時間衰減（`memory_search` / `memory_query`）永遠開啟，無法關閉。這個變數只會開啟一個決定性的路徑排序，用來處理 `vault_search` / `vault_query` 結果裡分數相同的項目（值為 `1`、`true`、`yes` 或 `on`） |

遮罩處理：`chatlog_redact.py` 會遮罩長得像密碼的字串（`password: x`、`Password=x`、`my password is x`、`密碼是 x`）、API 金鑰與權杖（包括 `sk-...`、`Bearer <token>`、JWT、`ya29.`、`npm_`）、PEM 私密金鑰區塊、URL 裡的 `user:password@`，以及其他幾種單獨出現的金鑰格式；另外，`$MEMORY_OS_HOME/redact-denylist.txt` 裡列出的每一個字串（一行一個）只要完全相符，也會被遮罩。請把那個檔案放在任何 git 儲存庫之外。這套做法是啟發式的：**把任何內容送到外部 API 之前，請先檢查遮罩後的鏡像**。

## 記憶卡格式（通則）

一張卡就是 `cards/` 裡的一個短 Markdown 檔：

```markdown
---
name: tv-purchase
description: 用一句話說明這張卡在什麼情況下適用，用你平常問起這件事時會用的字句。
metadata:
  type: project        # 自由格式：user | feedback | project | reference ...
---
事實或規則，直接講清楚。

**Why:** 背後的原因或事件。
**How to apply:** 什麼時候、要如何改變行為。
```

* `description` 是檢索的比對面：召回 hook 的權重是 description x3、name x2、內文 x1。寫它是為了讓比對命中，不是為了文筆好看。
* `cards/MEMORY.md` 是一份薄索引，不是傾印檔：每個「族」（family）一行，格式為 `- 【family】title／title／title`（族名放在【】裡，後面接標題，標題之間用「／」分隔）。要新增卡片，就把它的標題加到那一族的那一行。不要把整份載入 session；讓召回（或 `grep -il`）去找卡片。
* `cards/MEMORY-FULL.idx`（選用）用同樣的行格式，可以是索引的較長版本。
* 這套設計所依據的經驗法則：把三種儲存分開，各用各的檢索方式：*事件流*（原始紀錄；計數類的問題用 grep/awk 回答，不要用嵌入）、*知識*（提煉過的卡片／wiki；BM25＋向量）、*明文規則*（指令；先用語意定位，再用 grep 找出確切的文字）。

## 證據，以及能信到哪裡

一個人做的小型試驗（針對一週的私人聊天紀錄問 30 個問題）：直接搜尋原始紀錄，30 題答對 2 題；讀每晚的觀察筆記，答對 28 題；筆記加原始紀錄搜尋，同樣是 28 題。這只有一個人、一週的資料，由人工評分，資料集也沒有附上。請把它當成「寫入時筆記」這個想法的動機，不要當成基準測試（benchmark）。公開的基準測試請看上面「跑分：LongMemEval 完整 500 題」那一節。

## 限制與已知問題

* **不是開箱即用的產品**。這是從更大的系統抽出的三個部分；除了 `install.sh --check`（語法檢查、拿示範資料跑召回、筆記 `--dry-run`）之外，沒有端對端測試。筆記產生器的 API 路徑，只在 `tests/test_max_usd.py` 裡對本機的模擬（mock）伺服器跑過（沒有用到真正的金鑰）。
* **筆記截斷**。產生器對每個區塊的輸出上限是 16,000 個 token。資訊密度很高的日子，模型可能撞到 `max_tokens`；腳本會把這件事記到 `state/memory-notes-nightly/errors.log`，但仍會寫入可能已被截斷的筆記。如果你看到這種情況，請調小區塊大小（`chunk_messages(max_chars=...)`）。
* **驗證失敗**。第一行不是 `### 日期...` 的區塊會重試 3 次，之後整天視為失敗（什麼都不寫入）。大量回補（backfill）時的失敗率沒有量測過。
* **recall-router 是針對繁體中文調校的**。門檻是用一個人自己的卡片校準的。遇到英文提示時，它可能因為常見字而誤中（拿 `where did the TV go` 對示範資料試試看：它也會因為「the」這個字而建議示範技能）。請預期要針對你的語言，重新調整 `SKILL_*` / `CONTENT_*` 常數與閒聊清單。
* **`search/` 是最難移植的部分**。`rank-core.ts` 裡的路徑樣式權重與衰減類別，是針對某個人的集合名稱（`vault`、`notes`、`daily`、`tickets`、`drafts`、`chatlogs`、`memories`）寫的，還有一套給選用的 memories 集合用的 `- 台北時間 ... — YYYY-MM-DD HH:MM` 標題慣例。如果你的集合命名不同，這些規則會悄悄地什麼都比對不到。原本的單元測試檔（`alias-expand.test.ts`）沒有附上；跑分用的測試腳本（benchmark harness）也沒有附上。
* **刻意不包含的東西**：產生 `aliases.json` 的別名表產生器（在你自備那個檔案之前，別名擴展實際上是關閉的）、給寫程式助理的對話紀錄用的第二條增量式筆記管線、所有真實的記憶卡、筆記與紀錄。
* **測試**：`python3 tests/test_redact.py` 與 `python3 tests/test_max_usd.py` 都可以離線執行（後者是對本機的模擬伺服器）；`bash install.sh --check` 兩個都會跑。
* 預設的 API 模型 ID 與價格表只是範例；目前的模型名稱與價格請自行確認。

## 授權

MIT，詳見 `LICENSE`。
