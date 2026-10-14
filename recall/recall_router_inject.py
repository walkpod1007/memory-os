#!/usr/bin/env python3
"""Recall Router 加法注入器核心。

設計目的：UserPromptSubmit 加法注入器——每則 prompt 只在高信心命中時輸出一個
「相關卡片／技能」資料區塊，低信心完全靜默，注入上限 800 tokens
（無 tokenizer 時採保守上界 2000 Unicode chars）。

設計紀律：
- 純字元層＋skill description 概念短詞字典，不依賴 qmd vsearch、模型、網路。
- 任何錯誤 fail-open：rc=0、stdout 空、stderr 無 traceback／prompt 原文。
- 不讀寫正式 qmd 索引、不建立新外部服務依賴。
- 本檔自包含 router
  的最小必要邏輯（normalize／char_ngrams／dice／ngram_idf／score_pair／
  parse_routes_md／parse_skill_descriptions），不 import 任何外部模組。
"""
from __future__ import annotations

import json
import hashlib
import math
import os
import re
import sys
import tempfile
import time
from dataclasses import dataclass, field
from typing import Dict, List, Tuple

# ---------------------------------------------------------------------------
# 設定：資料根目錄（環境變數 MEMORY_OS_HOME，預設 ~/.memory-os）與注入上限
# ---------------------------------------------------------------------------
# Injection cap: 800 tokens. A flat character cap (2000 chars) does not guarantee
# that in pure-Chinese text (1 CJK char is roughly 1-2 tokens), so a conservative
# class-weighted token estimate is used instead:
#   - runs of ASCII: 1 token per 4 characters, rounded up
#   - CJK / CJK Ext A-F / CJK Compatibility / Kangxi Radicals:
#     2 tokens per character (conservative upper bound)
#   - any other Unicode (latin-ext, emoji, symbols, ...): 1 token per character
# When the estimate exceeds TOKEN_CAP_HARD, the output is trimmed character by character
# until the estimate is within the cap. Only the truncation at the end of build_capsule
# is affected; the confidence gate and the card/skill selection are not.
MEMORY_OS_HOME = os.environ.get("MEMORY_OS_HOME") or os.path.join(os.path.expanduser("~"), ".memory-os")
TOKEN_CAP_HARD = 800
# Legacy constant kept for compatibility (truncation no longer depends on it)
CHAR_CAP_FALLBACK = 2000

# Confidence thresholds (calibrated on a small set of positive/negative example sentences).
# Three kinds of hit get different thresholds:
#   substr_in (the doc is fully inside the query): a rare substring hit, low threshold
#   substr_of (the query is inside the doc): prone to false hits on short frequent words, high threshold
#   cov (n-gram coverage): only long sentences push the score up, high threshold
SKILL_MIN_TOP_SCORE = 4.0      # fallback（任何 path 都需超過）
SKILL_SUBSTR_IN_MIN = 8.0      # 「關燈」、「git」這類罕見子字串
SKILL_SUBSTR_OF_MIN = 50.0     # 「OK!」這類高頻短詞會被自然壓低
SKILL_COV_MIN = 15.0           # long chatty sentences produce coverage noise
MEMORY_MIN_TOP_SCORE = 0.6
QUERY_MIN_CHARS = 2            # 觸發詞常是 2 字（關燈、開燈）；< 2 視為純標點
MAX_SKILLS_IN_CAPSULE = 3

# Content-search confidence threshold. After per-field weighting (desc x3 + name x2 + body x1),
# a rare word that really hits the description naturally raises the score, while frequent noise is pushed
# down by IDF. Calibrated offline on a card set plus about 20 positive/negative sentences: lowering the
# threshold from 5.0 to 4.0 lets a rephrased query still hit (for example "the tool stops working after
# moving to another machine", where only a few rare words co-occur in the description). Chit-chat
# is kept at zero injection by "query too short and no ASCII literal -> content gate stays closed"
# (see the is_substantial check in build_capsule), independent of the threshold.
CONTENT_MIN_SCORE = 4.0
CONTENT_SUBSTR_OF_MIN = 18.0    # 「OK」「今天」在 description 內仍偏高頻
CONTENT_COV_MIN = 5.0

MAX_CARDS_IN_CAPSULE = 6   # content search prints card name + description

# ---------------------------------------------------------------------------
# Self-contained character layer (the minimum logic needed)
# ---------------------------------------------------------------------------

_PUNCT_RE = re.compile(
    r"[\s「」『』（）()\[\]【】〈〉《》,\.\uFF0C\u3002!\uFF01?\uFF1F:\uFF1A;\uFF1B'\"、／/…*`~＋+\-—_/]"
)


def normalize(s: str) -> str:
    s = s.strip().casefold()
    s = _PUNCT_RE.sub("", s)
    return s


# ---------------------------------------------------------------------------
# Fixed chit-chat list (regression set)
# ---------------------------------------------------------------------------
# CHITCHAT_PHRASES is built with normalize(x), so entries such as "OK", "Yes", "No" do not
# become dead entries (after casefold / punctuation stripping they would otherwise not equal
# themselves; these entries otherwise relied on the len<5 rule).
# The list also covers thanks / thank you / thx / ty / good night / good morning / bye and
# Chinese variants such as 好的謝謝, 謝啦, 沒問題, 辛苦了, 讚, 棒, 晚安安, 嗯嗯, 哈哈哈;
# case is absorbed by normalize.
# Rule: a query whose normalized length is < 8 and whose tokens are ALL in the greeting table
# is also pure chit-chat; neither the skill section nor the card section is injected. This rule
# short-circuits at the start of build_capsule (see _is_chitchat_by_token_set).

_CHITCHAT_LIST = (
    # The original 20 phrases (order preserved)
    "好～", "晚安", "哈哈", "嗯", "等一下", "早安", "謝謝", "在嗎", "收到",
    "OK", "ok", "Yes", "yes", "No", "好的", "好的收到了", "了解", "沒事",
    "再見", "喔",
    # Additional variants (case differences are absorbed by normalize)
    "Thanks", "thank you", "Thanks!", "Thanks.", "Thank you.",
    "thx", "THX", "ty", "TY",
    "Good night", "good night", "Good morning", "good morning",
    "Bye", "bye", "Goodbye", "goodbye",
    "好的謝謝", "謝啦", "沒問題", "沒問題就這樣",
    "辛苦了", "讚", "棒", "收到謝謝", "了解謝謝",
    "晚安安", "早安安", "嗯嗯", "哈哈哈",
    "OK thanks", "ok thanks", "Thanks!", "Thanks~",
    "好的好的", "沒事沒事", "好喔", "嗯好", "嗯啊",
)
assert len(_CHITCHAT_LIST) == 59, (
    "the fixed chit-chat list should have 59 phrases (20 base + 39 variants); "
    "if you change the count, re-check the chit-chat tests"
)

CHITCHAT_PHRASES = frozenset(normalize(x) for x in _CHITCHAT_LIST)

# Greeting-word table (used by the rule "normalized query < 8 chars and every token is a greeting word").
# Common short greeting / closing words in Chinese and English. It only classifies tokens; it does not compare whole strings.
_CHITCHAT_GREETING_WORDS = frozenset([
    # common English greeting / closing words (includes "you", otherwise "thank you" would not match)
    "thanks", "thank", "thx", "ty", "ok", "okay", "yes", "no", "bye",
    "bye", "hi", "hello", "good", "night", "morning", "sir", "maam",
    "please", "thanks", "ty", "you",
    # common Chinese greeting words
    "謝", "謝謝", "好", "嗯", "哈", "晚安", "早安", "收到", "了解",
    "沒問題", "辛苦", "讚", "棒", "再見", "嗨", "哈囉",
    # reduplicated words / verbal tics (the token rule uses these to catch 嗯嗯, 哈哈哈, 晚安安 and similar)
    "謝謝", "嗯嗯", "哈哈", "哈哈哈", "安安",
])
# Punctuation-stripped version of the greeting table (the token rule compares each token after casefold + punctuation stripping).
# _normalize_greeting_word_local and _PUNCT_TRANS_TABLE must be defined first, then the frozenset
# is built (the generator is only iterated when frozenset() is constructed, so the function must already be bound).

# punctuation translation table (PUNCT_RE uses re; here str.translate deletes directly)
_PUNCT_TRANS_TABLE = str.maketrans(
    "",
    "",
    " \t\n\r「」『』（）()[]【】〈〉《》,.\uFF0C\u3002!\uFF01?\uFF1F:\uFF1A;\uFF1B'\"、／/…*`~＋+-—_/"
)


def _normalize_greeting_word_local(w: str) -> str:
    """招呼詞表自身的正規化：casefold + 去標點（與 normalize() 同語意）。"""
    return w.strip().casefold().translate(_PUNCT_TRANS_TABLE)


_CHITCHAT_GREETING_WORDS_NORM = frozenset(
    _normalize_greeting_word_local(w) for w in _CHITCHAT_GREETING_WORDS
)


def _is_chitchat_by_token_set(raw_query: str) -> bool:
    """Split the original query into tokens, normalize each one; if **every** token is < 8 characters
    and all of them are in the greeting table, treat the query as chit-chat.

    Interface contract:
    - 收到**原始** prompt（不再傳入已 normalize 過、刪掉空白的字串）。
    - 先用空白／全形空白／標點切開成原始 token。
    - 每個 token 各自跑 casefold + 去標點（即同 `normalize()` 語意），
      命中招呼詞表即視為招呼詞。
    - 過濾掉空 token；剩餘 tokens **每個**長度 < 8 且全部命中招呼詞表
      才算閒聊（防「foo 謝啦」「好 我要派工」這類被誤判）。
    - 對單 token 也適用（"好"→`好`，length 1 < 8，命中 → True）。

    比對流程：
    - 切 token → 逐 token 正規化 → 收集非空 token
    - 全部 token 命中招呼詞表 且 每個 token 長度 < 8 → True
    """
    if not raw_query:
        return False
    # 切 token：空白／全形空白／標點都當分隔
    raw_tokens = re.split(
        r"[\s\u3000\uFF0C\u3002!\uFF01?\uFF1F:\uFF1A;\uFF1B,.\"\'「」『』（）()\[\]【】〈〉《》、／/…*`~＋+\-—_/]+",
        raw_query,
    )
    norm_tokens = []
    for tok in raw_tokens:
        t = tok.strip().casefold().translate(_PUNCT_TRANS_TABLE)
        if t:
            norm_tokens.append(t)
    if not norm_tokens:
        return False
    # Per token: in the greeting table and length < 8 (each token individually < 8,
    # not the concatenation < 8), so that "ok thanks" (okthanks 拼起來 8) 才能命中。
    for t in norm_tokens:
        if t not in _CHITCHAT_GREETING_WORDS_NORM:
            return False
        if len(t) >= 8:
            return False
    return True


def char_ngrams(s: str, n: int) -> set:
    if len(s) < n:
        return {s} if s else set()
    return {s[i:i + n] for i in range(len(s) - n + 1)}


def dice(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    if inter == 0:
        return 0.0
    return 2.0 * inter / (len(a) + len(b))


def build_ngram_idf(docs, n: int) -> dict:
    df = {}
    for d in docs:
        for g in char_ngrams(d.norm, n):
            df[g] = df.get(g, 0) + 1
    N = max(1, len(docs))
    return {g: math.log((N + 1) / (c + 1)) + 1.0 for g, c in df.items()}


def _coverage(query_norm: str, doc_norm: str, idf: dict, n: int) -> float:
    dg = char_ngrams(doc_norm, n)
    if not dg:
        return 0.0
    qg = char_ngrams(query_norm, n)
    inter = dg & qg
    if not inter:
        return 0.0
    num = sum(idf.get(g, 1.0) for g in inter)
    den = sum(idf.get(g, 1.0) for g in dg)
    return num / den if den else 0.0


@dataclass
class Doc:
    text: str       # 原始觸發詞 / 卡片標題（顯示用）
    norm: str       # 正規化供比對
    key: str        # skill 名 / 記憶族名
    extra: str = "" # 顯示用附註
    source: str = ""  # 來源檔案


def doc_rarity(doc_norm: str, bi_idf: dict) -> float:
    """doc 的 2-gram 平均 rarity（IDF 值越高 = 越罕見 → 越值得信）。
    用於子字串命中乘上權重：避免「OK」這類常見短詞被當高信心命中。
    """
    grams = char_ngrams(doc_norm, 2)
    if not grams:
        return 1.0
    vals = [bi_idf.get(g, 1.0) for g in grams]
    return sum(vals) / len(vals)


def score_pair(query_norm: str, doc_norm: str, bi_idf: dict, tri_idf: dict) -> float:
    """Same idea as the plain scorer, but a substring hit is multiplied by the doc's rarity:
    short frequent words such as "OK" are pushed down, rare words such as "lights off" are pulled up.
    A query shorter than 2 characters after normalization always returns 0.0, avoiding single-character false hits.
    """
    if not doc_norm or not query_norm or len(query_norm) < QUERY_MIN_CHARS:
        return 0.0
    rarity = doc_rarity(doc_norm, bi_idf)
    if doc_norm in query_norm:
        return (8.0 + min(len(doc_norm), 12) * 1.5) * rarity
    if len(doc_norm) > 4 and query_norm in doc_norm:
        return (4.0 + len(query_norm) * 0.8) * rarity
    cov2 = _coverage(query_norm, doc_norm, bi_idf, 2)
    cov3 = _coverage(query_norm, doc_norm, tri_idf, 3)
    return cov2 * 4.0 * rarity + cov3 * 6.0 * rarity


# ---------------------------------------------------------------------------
# 索引建構：skill-routes.md + skills/*/SKILL.md description 的觸發段
# ---------------------------------------------------------------------------

_SKILL_NAME_RE = re.compile(r"`([a-zA-Z][a-zA-Z0-9_\-\.]{1,40})`")
_QUOTE_TOKEN_RE = re.compile(r"「([^」]{1,40})」")
_ANNOTATION_STRIP_RE = re.compile(r"（[^（）]*）")


def _skill_dirs(skills_dir: str) -> set:
    try:
        return {
            d for d in os.listdir(skills_dir)
            if os.path.isdir(os.path.join(skills_dir, d))
            and os.path.exists(os.path.join(skills_dir, d, "SKILL.md"))
        }
    except FileNotFoundError:
        return set()


def parse_routes_md(path: str, skills_dir: str) -> List[Doc]:
    docs: List[Doc] = []
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return docs
    valid_skills = _skill_dirs(skills_dir)
    for line in lines:
        line = line.rstrip("\n")
        if not line.startswith("| "):
            continue
        if re.match(r"^\|[\s:\-]+\|[\s:\-]+\|?\s*$", line):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 2:
            continue
        trigger_cell, skill_cell = cells[0], cells[1]
        if trigger_cell.lower() in ("trigger",) or skill_cell.lower() in ("skill",):
            continue
        m_all = _SKILL_NAME_RE.findall(skill_cell)
        skill_name = None
        for cand in m_all:
            if cand in valid_skills:
                skill_name = cand
                break
        if skill_name is None:
            continue
        quoted = _QUOTE_TOKEN_RE.findall(trigger_cell)
        phrases = list(dict.fromkeys(quoted)) if quoted else []
        whole = _ANNOTATION_STRIP_RE.sub("", trigger_cell).strip()
        whole = whole.strip("「」")
        if whole and whole not in phrases:
            phrases.append(whole)
        for ph in phrases:
            ph = ph.strip()
            if len(ph) < 2:
                continue
            docs.append(Doc(text=ph, norm=normalize(ph), key=skill_name,
                            extra=skill_name, source="skill-routes.md"))
    return docs


_DESC_RE = re.compile(r"^description:\s*(.*)$", re.MULTILINE)
_TRIGGER_SPLIT_RE = re.compile(r"[、，,]")


def parse_skill_descriptions(skills_dir: str) -> List[Doc]:
    """從 SKILL.md frontmatter description 抽「觸發：」段的短詞列表。"""
    docs: List[Doc] = []
    try:
        names = sorted(os.listdir(skills_dir))
    except FileNotFoundError:
        return docs
    for name in names:
        skill_md = os.path.join(skills_dir, name, "SKILL.md")
        if not os.path.isfile(skill_md):
            continue
        try:
            with open(skill_md, encoding="utf-8", errors="ignore") as f:
                head = f.read(4000)
        except Exception:
            continue
        m = _DESC_RE.search(head)
        if not m:
            continue
        desc = m.group(1)
        if "觸發：" not in desc:
            continue
        after = desc.split("觸發：", 1)[1]
        after = re.split(r"[。；]?\s*不觸發", after)[0]
        after = re.split(r"消歧[：:：]", after)[0]
        for token in _TRIGGER_SPLIT_RE.split(after):
            token = token.strip().strip("「」")
            token = re.sub(r"\([^\)]*\)$", "", token).strip()
            if len(token) < 2 or len(token) > 40:
                continue
            docs.append(Doc(text=token, norm=normalize(token), key=name,
                            extra=name, source="SKILL.md"))
    return docs


def parse_skill_concepts(skills_dir: str) -> List[Doc]:
    """從 SKILL.md frontmatter description 抽「觸發：」之前的概念短詞：
    例如 openhue description 全文是「控制 Philips Hue 燈光和情境...
    使用時機：開燈、關燈、hue、燈光情境、調亮度、調燈光顏色、openhue、hue 燈、
    換個情境。」，去掉觸發段後留下「控制 Philips Hue 燈光和情境...」，切成
    短詞（中文 2-3 字、英文單詞）作為 skill 的概念輔助字典。
    這層是用 router 的字元層邏輯擴充，不引入外部模型。
    """
    docs: List[Doc] = []
    try:
        names = sorted(os.listdir(skills_dir))
    except FileNotFoundError:
        return docs
    for name in names:
        skill_md = os.path.join(skills_dir, name, "SKILL.md")
        if not os.path.isfile(skill_md):
            continue
        try:
            with open(skill_md, encoding="utf-8", errors="ignore") as f:
                head = f.read(4000)
        except Exception:
            continue
        m = _DESC_RE.search(head)
        if not m:
            continue
        desc = m.group(1)
        if "觸發：" in desc:
            before = desc.split("觸發：", 1)[0]
        else:
            before = desc
        # 切短詞：英文 word、中文 2-3 字
        tokens = re.findall(r"[A-Za-z][A-Za-z0-9_\-]{1,30}|[一-鿿]{2,3}", before)
        seen = set()
        for tok in tokens:
            tok_n = normalize(tok)
            if not tok_n or len(tok_n) < 2 or len(tok) > 30:
                continue
            if tok_n in seen:
                continue
            seen.add(tok_n)
            docs.append(Doc(text=tok, norm=tok_n, key=name, extra=name,
                            source="SKILL.md.concept"))
    return docs


# ---------------------------------------------------------------------------
# 索引建構：MEMORY 索引（純本機讀，不寫）
# ---------------------------------------------------------------------------

_FAMILY_LINE_RE = re.compile(r"^- 【(.+?)】(.*)$")


def parse_memory_md(path: str) -> List[Doc]:
    docs: List[Doc] = []
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return docs
    for line in lines:
        line = line.rstrip("\n")
        m = _FAMILY_LINE_RE.match(line)
        if not m:
            continue
        family, rest = m.group(1).strip(), m.group(2).strip()
        for title in rest.split("／"):
            title = title.strip()
            if len(title) < 2:
                continue
            docs.append(Doc(text=title, norm=normalize(title), key=family,
                            extra=family, source="MEMORY.md"))
    return docs


# ---------------------------------------------------------------------------
# 卡片內容索引：
# 對記憶目錄裡每張 *.md（除 MEMORY.md / MEMORY-FULL.idx 等非卡檔）取
#   frontmatter name / description 與正文前 1500 字元；用既有的
#   char_ngrams / ngram_idf / score_pair 打分，description 權重 3、
#   name 權重 2、正文 1。索引可做快取檔，置於系統暫存目錄，絕不寫進
#   記憶目錄或 repo（節錄、key、路徑全在記憶目錄內，本文遵守）。
# ---------------------------------------------------------------------------

_NAME_FRONT_RE = re.compile(r"^name:\s*(.+?)\s*$", re.MULTILINE)
_DESC_FRONT_RE = re.compile(r"^description:\s*(.*?)(?=\n\S|\Z)", re.MULTILINE | re.DOTALL)
# 在 frontmatter 與正文之間尋找結束標記
_FRONT_END_RE = re.compile(r"^---\s*$", re.MULTILINE)


@dataclass
class CardRecord:
    key: str            # 卡名（檔名去 .md / frontmatter name 兩者同意的）
    name: str           # frontmatter name 原字串
    description: str    # frontmatter description 原字串
    body: str           # 正文（前 BODY_HEAD_CHARS 字元）
    source: str = ""    # 來源檔路徑


# 取多少正文
BODY_HEAD_CHARS = 1500
# 不視為卡片的檔名模式（MEMORY 系列、SLUGS、check-slugs、hidden）
_NONCARD_RE = re.compile(r"^(MEMORY|SLUGS|check-slugs|\.|\#).*", re.IGNORECASE)


def _split_frontmatter(text: str) -> Tuple[str, str]:
    """切出 (frontmatter 內文, 正文)。沒 frontmatter 就 ("", text)。"""
    if not text.startswith("---"):
        return "", text
    m = _FRONT_END_RE.search(text, 3)  # 從第 4 字元起找下一個 ---
    if not m:
        return "", text
    return text[3:m.start()], text[m.end():]


def _extract_front_fields(front: str) -> Tuple[str, str]:
    """從 frontmatter 內文抽 (name, description)。找不到各自回 ""。

    YAML 描述常用兩種寫法：
      description: foo bar baz              ← 單行
      description: |
        多行
      description: "含「」與「:」的引號串"
      description: '...'
    為了不引入 yaml 依賴，這裡只處理「頂層以 `description:` 開頭、
    延續行若以空白開頭視為同欄位（多行裸字串）」這個鬆散規則。"""
    name = ""
    desc = ""
    # name 永遠當作單行
    m = _NAME_FRONT_RE.search(front)
    if m:
        name = m.group(1).strip().strip('"').strip("'")
    # description：先抓首行，再吞「縮排延續行」
    m = _DESC_FRONT_RE.search(front)
    if not m:
        return name, desc
    raw = m.group(1).rstrip("\n")
    # 切行；首行是 key 之後的內容
    lines = raw.split("\n")
    first = lines[0]
    # 去掉常見前綴："|" / ">" / "-"（YAML 區塊指示符）
    stripped_first = first.lstrip()
    if stripped_first.startswith(("|", ">", "-")):
        first_val = ""
        block_indicator = stripped_first[0]
    else:
        first_val = first
        block_indicator = ""
    # 將引號外層吃掉
    def _unquote(s: str) -> str:
        s = s.strip()
        if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
            return s[1:-1]
        return s
    first_val = _unquote(first_val)
    parts = [first_val]
    # 延續行：以空白（space/tab）開頭的行
    for ln in lines[1:]:
        if ln and ln[0] in (" ", "\t"):
            parts.append(_unquote(ln.strip()))
        else:
            break
    desc = "".join(parts).strip()
    # 支援 block scalar：將多行 join 成單行（用空格；以利後續 normalize）
    if block_indicator in ("|", ">"):
        desc = desc.replace("\n", " ")
    return name, desc


def _extract_card_fields(path: str) -> CardRecord | None:
    """讀一張卡 .md，回 CardRecord。任何解析失敗回 None（fail-open）。"""
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            text = f.read()
    except Exception:
        return None
    if not text:
        return None
    front, body = _split_frontmatter(text)
    name, description = _extract_front_fields(front) if front else ("", "")
    if not name:
        # 退回檔名（去 .md）
        base = os.path.basename(path)
        if base.endswith(".md"):
            base = base[:-3]
        name = base
    # 取正文前 BODY_HEAD_CHARS
    body_excerpt = body[:BODY_HEAD_CHARS] if body else ""
    return CardRecord(
        key=name,
        name=name,
        description=description,
        body=body_excerpt,
        source=path,
    )


def parse_cards_dir(dir_path: str) -> List[CardRecord]:
    """讀目錄裡所有 *.md，排除 MEMORY 系列。失敗／缺目錄回空 list。"""
    cards: List[CardRecord] = []
    if not dir_path or not os.path.isdir(dir_path):
        return cards
    try:
        names = sorted(os.listdir(dir_path))
    except Exception:
        return cards
    for n in names:
        if not n.endswith(".md"):
            continue
        if _NONCARD_RE.match(n):
            continue
        full = os.path.join(dir_path, n)
        if not os.path.isfile(full):
            continue
        rec = _extract_card_fields(full)
        if rec is None:
            continue
        if not rec.name:
            continue
        cards.append(rec)
    return cards


def _mem_dir_for_memory_md(memory_md: str) -> str:
    """從既有 MEMORY.md 路徑（同目錄下卡檔）回傳記憶目錄字串。"""
    if not memory_md:
        return ""
    # memory_md 可能多份以 os.pathsep 分，取第一份即可定位記憶目錄
    first = memory_md.split(os.pathsep)[0].strip() if memory_md else ""
    if not first:
        return ""
    return os.path.dirname(first) or ""


# ---------------------------------------------------------------------------
# 索引快取（系統暫存目錄；以目錄 mtime + 卡數 + 目錄絕對路徑 hash 為 key；
# 不寫進 repo 或記憶目錄。寫入走 mkstemp + os.replace 避免 symlink 攻擊。）
# ---------------------------------------------------------------------------

_CONTENT_CACHE_PREFIX = "recall-router-content"


def _content_cache_key(mem_dir: str) -> str:
    """以記憶目錄的「絕對路徑 hash + 卡數 + 最大 mtime」計算快取 key。

    The first 8 hex characters of the sha1 of the memory directory's absolute path are part of the key,
    so two directories that happen to share the same card count and max mtime do not share a cache.
    """
    if not mem_dir:
        return ""
    abs_dir = os.path.abspath(mem_dir)
    dir_hash = hashlib.sha1(abs_dir.encode("utf-8", "ignore")).hexdigest()[:8]
    try:
        names = os.listdir(mem_dir)
    except Exception:
        names = []
    md_paths = []
    for n in names:
        if n.endswith(".md") and not _NONCARD_RE.match(n):
            md_paths.append(os.path.join(mem_dir, n))
    if not md_paths:
        return f"{dir_hash}_0_0"
    max_mtime_ns = 0
    for p in md_paths:
        try:
            st = os.stat(p)
            if int(st.st_mtime_ns) > max_mtime_ns:
                max_mtime_ns = int(st.st_mtime_ns)
        except Exception:
            pass
    return f"{dir_hash}_{len(md_paths)}_{max_mtime_ns}"


def _content_cache_path(mem_dir: str, key: str = "") -> str:
    """算最終快取檔路徑。key 已有就直接用，省一次 stat 整目錄。"""
    if not key:
        key = _content_cache_key(mem_dir)
    if not key:
        return ""
    return os.path.join(tempfile.gettempdir(), f"{_CONTENT_CACHE_PREFIX}-{key}.json")


def _load_content_cache(mem_dir: str, key: str = "") -> List[CardRecord] | None:
    """讀快取。檔不存在／損壞／key 對不上回 None。"""
    if not key:
        key = _content_cache_key(mem_dir)
    path = _content_cache_path(mem_dir, key)
    if not path or not os.path.isfile(path):
        return None
    # 拒絕 symlink（避免有人放個 victim 路徑當快取檔，load 端意外走過）
    try:
        if os.path.islink(path):
            return None
    except Exception:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    if data.get("key") != key:
        return None
    raw_list = data.get("cards")
    if not isinstance(raw_list, list):
        return None
    out = []
    for item in raw_list:
        if not isinstance(item, dict):
            continue
        try:
            out.append(CardRecord(
                key=item.get("key", ""),
                name=item.get("name", ""),
                description=item.get("description", ""),
                body=item.get("body", ""),
                source=item.get("source", ""),
            ))
        except Exception:
            continue
    return out


def _prune_stale_content_caches(tmp_dir: str, keep_path: str,
                                 own_dir_hash: str, own_key: str) -> None:
    """刪掉同 tmp_dir 下、同樣本記憶目錄的「不是自己這份」舊快取。

    Conditions: only delete files with the same prefix, in the same tmp directory, that are not our own.
    Also only files whose name contains this directory's dir_hash, so another memory directory's
    cache is never deleted (if another hook points RECALL_ROUTER_MEMORY_MD elsewhere, its cache is
    not evicted by our cold start; only older keys for the same directory are cleaned).
    No mtime condition (adding one would make repeated runs within an hour wipe each other's caches).
    """
    if not own_dir_hash or not own_key:
        return
    prefix = _CONTENT_CACHE_PREFIX + "-"
    try:
        names = os.listdir(tmp_dir)
    except Exception:
        return
    for n in names:
        if not (n.startswith(prefix) and n.endswith(".json")):
            continue
        # n 格式：recall-router-content-<key>.json
        # key 格式：<dir_hash>_N_M（dir_hash 是 8 個 hex char）
        # 只接受 key 第一段等於 own_dir_hash 的檔；其他目錄的不碰
        middle = n[len(prefix):-len(".json")]
        parts = middle.split("_", 1)
        if not parts or parts[0] != own_dir_hash:
            continue
        full = os.path.join(tmp_dir, n)
        if full == keep_path or middle == own_key:
            continue
        try:
            os.remove(full)
        except Exception:
            # 同名 symlink 撞 victim、或檔已被別人刪：吞掉
            pass


def _save_content_cache(mem_dir: str, cards: List[CardRecord], key: str = "") -> None:
    """Write the cache. Failures are swallowed (a failed cache write must never break the hook).

    Safety properties:
    - mkstemp gives a truly random .tmp name (O_EXCL + 0600, safe by default)
    - the write goes through os.fdopen in text mode
    - os.replace moves it atomically to the final path
    - if the final path is a symlink, skip the write (attack surface: a TMPDIR planted with a
      symlink would be replaced with cache content; not writing avoids it)
    - after a successful write, remove older caches in the same tmp_dir with the same dir_hash
      (never another memory directory's)

    The key is supplied by the caller; _content_cache_key(mem_dir) is not recomputed here.
    key="" falls back automatically (backward-compatible signature).
    """
    try:
        if not key:
            key = _content_cache_key(mem_dir)
        if not key:
            return
        # derive dir_hash for pruning (do not recompute the key; take only its first segment)
        own_dir_hash = key.split("_", 1)[0] if "_" in key else ""
        payload = {
            "key": key,
            "built_at": time.time(),
            "cards": [
                {"key": c.key, "name": c.name, "description": c.description,
                 "body": c.body, "source": c.source}
                for c in cards
            ],
        }
        tmp_dir = tempfile.gettempdir()
        final = _content_cache_path(mem_dir, key)
        if not final:
            return
        # final is a symlink → 跳過寫入，照常回傳結果
        if os.path.islink(final):
            return
        # mkstemp 在 tmp_dir 建一個 0600 隨機檔；prefix 帶 key
        # 便於事後清舊檔時只看「同 prefix 開頭」
        fd, tmp_path = tempfile.mkstemp(
            dir=tmp_dir,
            prefix=f"{_CONTENT_CACHE_PREFIX}-{key}-",
            suffix=".tmp",
        )
        try:
            try:
                os.fchmod(fd, 0o600)
            except Exception:
                pass
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False)
        except Exception:
            try:
                os.remove(tmp_path)
            except Exception:
                pass
            return
        # 原子搬到 final
        try:
            os.replace(tmp_path, final)
        except Exception:
            try:
                os.remove(tmp_path)
            except Exception:
                pass
            return
        # 寫成功：清同 tmp_dir + 同 dir_hash 下的舊快取
        if own_dir_hash:
            _prune_stale_content_caches(tmp_dir, final, own_dir_hash, key)
    except Exception:
        return


def build_content_index(mem_dir: str) -> Tuple[List[CardRecord], dict, dict]:
    """建（cards, bi_idf_concat, tri_idf_concat）。

    IDF 用「per-card weighted concat」建一份；這樣 doc 端就把
    name×2 + desc×3 + body×1 的權重內建進 n-gram 出現頻率。
    命中分仍走既有 score_pair，substr_in / substr_of / cov 三類行為保留。
    """
    if not mem_dir or not os.path.isdir(mem_dir):
        return [], {}, {}
    # cache_key is computed once and passed to both load and save (saves two whole-directory stats)
    key = _content_cache_key(mem_dir)
    cards = _load_content_cache(mem_dir, key)
    if cards is None:
        cards = parse_cards_dir(mem_dir)
        if cards:
            # pass the already computed key straight in; save does not call _content_cache_key() again
            _save_content_cache(mem_dir, cards, key)
    if not cards:
        return [], {}, {}
    # 構建「per-card 帶權重的字串」(description×3 + name×2 + body×1)
    weighted_docs = []
    for c in cards:
        pieces = []
        if c.description:
            pieces.append(c.description)
            pieces.append(c.description)
            pieces.append(c.description)
        if c.name:
            pieces.append(c.name)
            pieces.append(c.name)
        if c.body:
            pieces.append(c.body)
        s = " ".join(p for p in pieces if p)
        if not s.strip():
            continue
        weighted_docs.append(Doc(text=c.key, norm=normalize(s), key=c.key,
                                 extra=c.description[:60], source="card-content"))
    bi = build_ngram_idf(weighted_docs, 2)
    tri = build_ngram_idf(weighted_docs, 3)
    return cards, bi, tri


def score_card(query_norm: str, card: CardRecord, bi: dict, tri: dict,
               w_name: int = 2, w_desc: int = 3, w_body: int = 1) -> Tuple[float, str]:
    """對一張卡打分（分項加權），並回傳 hit_kind。

    用既有 score_pair 對三個欄位各算一次，加權合計。hit_kind
    取「分數最高的那一欄」的分類。
    """
    if not query_norm or len(query_norm) < QUERY_MIN_CHARS:
        return 0.0, "cov"
    parts = []
    kinds = []
    if card.name:
        s = score_pair(query_norm, normalize(card.name), bi, tri)
        if s > 0:
            parts.append(s * w_name)
            kinds.append(_classify_hit_kind(query_norm, normalize(card.name)))
    if card.description:
        s = score_pair(query_norm, normalize(card.description), bi, tri)
        if s > 0:
            parts.append(s * w_desc)
            kinds.append(_classify_hit_kind(query_norm, normalize(card.description)))
    if card.body:
        s = score_pair(query_norm, normalize(card.body), bi, tri)
        if s > 0:
            parts.append(s * w_body)
            kinds.append(_classify_hit_kind(query_norm, normalize(card.body)))
    if not parts:
        return 0.0, "cov"
    # hit_kind：取最大 part 對應的欄位分類；同名取第一次
    best_idx = 0
    best_val = parts[0]
    for i, v in enumerate(parts):
        if v > best_val:
            best_val = v
            best_idx = i
    total = sum(parts)
    return total, kinds[best_idx]


# ---------------------------------------------------------------------------
# 模組級快取索引
# ---------------------------------------------------------------------------

@dataclass
class Indexes:
    skill_docs: List[Doc]
    memory_docs: List[Doc]
    skill_bi_idf: dict
    skill_tri_idf: dict
    mem_bi_idf: dict
    mem_tri_idf: dict
    # 卡片內容索引
    content_cards: List["CardRecord"] = field(default_factory=list)
    content_bi_idf: dict = field(default_factory=dict)
    content_tri_idf: dict = field(default_factory=dict)


def build_indexes(routes_md: str, skills_dir: str, memory_md: str) -> Indexes:
    seen = set()
    skill_docs: List[Doc] = []
    for d in parse_routes_md(routes_md, skills_dir) + parse_skill_descriptions(skills_dir) + parse_skill_concepts(skills_dir):
        sig = (d.key, d.norm)
        if sig in seen or not d.norm:
            continue
        seen.add(sig)
        skill_docs.append(d)
    skill_bi_idf = build_ngram_idf(skill_docs, 2)
    skill_tri_idf = build_ngram_idf(skill_docs, 3)

    seen = set()
    memory_docs: List[Doc] = []
    mem_parsed: List[Doc] = []
    for _p in memory_md.split(os.pathsep):
        if _p:
            mem_parsed += parse_memory_md(_p)
    for d in mem_parsed:
        sig = (d.key, d.norm)
        if sig in seen or not d.norm:
            continue
        seen.add(sig)
        memory_docs.append(d)
    mem_bi_idf = build_ngram_idf(memory_docs, 2)
    mem_tri_idf = build_ngram_idf(memory_docs, 3)

    # 卡片內容索引：從 memory_md 同目錄拉
    mem_dir = _mem_dir_for_memory_md(memory_md)
    content_cards, c_bi, c_tri = build_content_index(mem_dir)

    return Indexes(skill_docs=skill_docs, memory_docs=memory_docs,
                   skill_bi_idf=skill_bi_idf, skill_tri_idf=skill_tri_idf,
                   mem_bi_idf=mem_bi_idf, mem_tri_idf=mem_tri_idf,
                   content_cards=content_cards,
                   content_bi_idf=c_bi, content_tri_idf=c_tri)


# ---------------------------------------------------------------------------
# 注入上限：分類加權保守 token 估算
# ---------------------------------------------------------------------------

# CJK 與相關區段集合（保守上界）
_CJK_RANGES = (
    (0x4E00, 0x9FFF),       # CJK Unified Ideographs
    (0x3400, 0x4DBF),       # CJK Unified Ideographs Extension A
    (0x20000, 0x2A6DF),     # Extension B
    (0x2A700, 0x2B73F),     # Extension C
    (0x2B740, 0x2B81F),     # Extension D
    (0x2B820, 0x2CEAF),     # Extension E
    (0x2CEB0, 0x2EBEF),     # Extension F
    (0xF900, 0xFAFF),       # CJK Compatibility Ideographs
    (0x2F800, 0x2FA1F),     # CJK Compatibility Supplement
)


def _is_cjk(cp: int) -> bool:
    for lo, hi in _CJK_RANGES:
        if lo <= cp <= hi:
            return True
    return False


def estimate_tokens(s: str) -> int:
    """分類加權保守 token 估算（無 tokenizer 環境）。

    權重（向上取整；保守上界）：
      - CJK / CJK Ext A-F / CJK Compatibility / Kangxi Radicals：2 tokens/char
      - 其餘 Unicode（含 latin-ext、emoji、標點）：1 token/char
      - ASCII 連續區段（cp < 0x80）：4 chars = 1 token，無條件進位
    """
    if not s:
        return 0
    total = 0
    ascii_run = 0
    for ch in s:
        cp = ord(ch)
        if _is_cjk(cp):
            if ascii_run > 0:
                total += math.ceil(ascii_run / 4)
                ascii_run = 0
            total += 2
        elif cp < 0x80:
            ascii_run += 1
        else:
            if ascii_run > 0:
                total += math.ceil(ascii_run / 4)
                ascii_run = 0
            total += 1
    if ascii_run > 0:
        total += math.ceil(ascii_run / 4)
    return total


def _truncate_to_token_cap(body: str, cap: int = TOKEN_CAP_HARD) -> Tuple[str, bool]:
    """把 body 逐字元遞減直到 estimate_tokens(body) ≤ cap。

    回傳 (截後 body, 是否觸發截斷)。若 body 已 ≤ cap，原樣回傳。
    """
    if estimate_tokens(body) <= cap:
        return body, False
    # 二分找最大長度 prefix 使其估計 ≤ cap
    lo, hi = 0, len(body)
    # 先確保 hi 一定超 cap；用 estimate_tokens 收斂
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if estimate_tokens(body[:mid]) <= cap:
            lo = mid
        else:
            hi = mid - 1
    return body[:lo], True


# ---------------------------------------------------------------------------
# 檢索與 confidence gate
# ---------------------------------------------------------------------------


@dataclass
class Hit:
    score: float
    doc: Doc
    hit_kind: str  # "substr_in" | "substr_of" | "cov" — 用於 confidence gate 區分


def _classify_hit_kind(query_norm: str, doc_norm: str) -> str:
    if doc_norm in query_norm:
        return "substr_in"
    if len(doc_norm) > 4 and query_norm in doc_norm:
        return "substr_of"
    return "cov"


def _rank(query_norm: str, docs: List[Doc], bi_idf: dict, tri_idf: dict, min_score: float) -> List[Hit]:
    scored = []
    for d in docs:
        s = score_pair(query_norm, d.norm, bi_idf, tri_idf)
        if s >= min_score:
            scored.append(Hit(score=s, doc=d, hit_kind=_classify_hit_kind(query_norm, d.norm)))
    scored.sort(key=lambda x: -x.score)
    return scored


@dataclass
class Capsule:
    skills: List[str] = field(default_factory=list)
    cards: List[Tuple[str, str]] = field(default_factory=list)  # (family, title)
    raw_skill_lines: List[str] = field(default_factory=list)
    raw_card_lines: List[str] = field(default_factory=list)


@dataclass
class RouterResult:
    capsule: str
    skills: List[str]
    cards: List[Tuple[str, str]]
    skill_top_score: float
    memory_top_score: float
    char_ms: float
    total_ms: float
    short_circuit_reason: str = ""


def build_capsule(idx_obj: Indexes, query: str,
                  max_skills: int = MAX_SKILLS_IN_CAPSULE,
                  max_cards: int = MAX_CARDS_IN_CAPSULE) -> RouterResult:
    t0 = time.perf_counter()
    qn = normalize(query)

    # 過短閒聊、空 prompt、slash command → 零輸出
    if len(qn) < QUERY_MIN_CHARS:
        return RouterResult(capsule="", skills=[], cards=[],
                            skill_top_score=0.0, memory_top_score=0.0,
                            char_ms=0.0, total_ms=(time.perf_counter()-t0)*1000,
                            short_circuit_reason="short")
    q = query.lstrip()
    if q.startswith("/") or q.startswith("!"):
        return RouterResult(capsule="", skills=[], cards=[],
                            skill_top_score=0.0, memory_top_score=0.0,
                            char_ms=0.0, total_ms=(time.perf_counter()-t0)*1000,
                            short_circuit_reason="slash")

    skill_hits = _rank(qn, idx_obj.skill_docs, idx_obj.skill_bi_idf, idx_obj.skill_tri_idf, 0.0)
    mem_hits = _rank(qn, idx_obj.memory_docs, idx_obj.mem_bi_idf, idx_obj.mem_tri_idf, 0.0)

    # ---- 對每張記憶卡做內容加權打分 ----
    content_card_hits = []
    if idx_obj.content_cards and idx_obj.content_bi_idf:
        for c in idx_obj.content_cards:
            s, kind = score_card(qn, c, idx_obj.content_bi_idf, idx_obj.content_tri_idf)
            if s >= CONTENT_MIN_SCORE * 0.4:  # 篩掉幾乎沒碰的
                content_card_hits.append((s, kind, c))
        content_card_hits.sort(key=lambda x: -x[0])

    skill_top = skill_hits[0].score if skill_hits else 0.0
    mem_top = mem_hits[0].score if mem_hits else 0.0
    content_top = content_card_hits[0][0] if content_card_hits else 0.0

    # ---- confidence gate ----
    # 三種命中來源給不同門檻：
    #   substr_in（doc 完全在 query 內）：「關燈」「git」罕見子字串 → 8.0
    #   substr_of（query 在 doc 中）：「OK」「今天」高頻短詞被自然壓低 → 28.0
    #   cov（n-gram coverage）：長句 coverage 雜訊 → 12.0
    passed = False
    for h in skill_hits:
        if h.hit_kind == "substr_in" and h.score >= SKILL_SUBSTR_IN_MIN:
            passed = True
            break
        if h.hit_kind == "substr_of" and h.score >= SKILL_SUBSTR_OF_MIN:
            passed = True
            break
        if h.hit_kind == "cov" and h.score >= SKILL_COV_MIN:
            passed = True
            break

    # ---- a content hit can also pass the gate (instead of comparing family names only) ----
    # The "chit-chat gets zero injection" rule is kept: a query shorter than 5 characters after
    # normalization never opens the content gate, in any language (no ASCII exemption, so short
    # pure-ASCII phrases such as "OK" / "Yes" cannot slip through and flood the context).
    # The CHITCHAT short-circuit at the main entry already handles most of these; this is the second line of defence.
    if not passed and content_card_hits:
        is_substantial = len(qn) >= 5
        if is_substantial:
            for s, kind, _c in content_card_hits:
                if kind == "substr_in" and s >= SKILL_SUBSTR_IN_MIN:
                    passed = True
                    break
                if kind == "substr_of" and s >= CONTENT_SUBSTR_OF_MIN:
                    passed = True
                    break
                if kind == "cov" and s >= CONTENT_COV_MIN:
                    passed = True
                    break

    if not passed:
        return RouterResult(capsule="", skills=[], cards=[],
                            skill_top_score=skill_top, memory_top_score=mem_top,
                            char_ms=0.0, total_ms=(time.perf_counter()-t0)*1000,
                            short_circuit_reason="low_confidence")

    # ---- 挑選 skill（去重保留順序、≤ max_skills）----
    chosen_skills: List[str] = []
    skill_lines: List[str] = []
    skill_keys_seen = set()
    # 為了顯示穩定：以 skill 為單位挑「該 skill 內最高分 doc」的最短 text
    best_text_per_key: Dict[str, str] = {}
    best_score_per_key: Dict[str, float] = {}
    for h in skill_hits:
        if h.doc.key in best_score_per_key:
            if h.score > best_score_per_key[h.doc.key]:
                best_score_per_key[h.doc.key] = h.score
                # 取較短文字顯示（避免補遺表長句）
                if len(h.doc.text) < len(best_text_per_key[h.doc.key]):
                    best_text_per_key[h.doc.key] = h.doc.text
        else:
            best_score_per_key[h.doc.key] = h.score
            best_text_per_key[h.doc.key] = h.doc.text
    # 依分數排序
    sorted_keys = sorted(best_score_per_key.keys(),
                         key=lambda k: -best_score_per_key[k])
    for k in sorted_keys:
        if len(chosen_skills) >= max_skills:
            break
        chosen_skills.append(k)
        trig = best_text_per_key[k]
        if len(trig) > 24:
            trig = trig[:24]
        skill_lines.append(f"- 「{trig}」→ `{k}`")

    # ---- 挑選記憶卡（內容搜尋為主）----
    # 規則：依分數排序；分數 ≥ CONTENT_MIN_SCORE 才印；最多 max_cards 張；
    # 列印格式：「【卡名】description 前 60 字」。
    chosen_cards: List[Tuple[str, str]] = []
    card_lines: List[str] = []
    seen_keys: set = set()
    for s, _kind, c in content_card_hits:
        if s < CONTENT_MIN_SCORE:
            break
        if len(chosen_cards) >= max_cards:
            break
        if c.key in seen_keys:
            continue
        seen_keys.add(c.key)
        snippet = (c.description or c.body).strip().replace("\n", " ")
        if len(snippet) > 60:
            snippet = snippet[:60]
        chosen_cards.append((c.key, snippet))
        card_lines.append(f"- 【{c.key}】{snippet}")

    # 若內容搜尋沒結果但技能 gate 通了，降級用 MEMORY.md 族名版（沿用舊行為）
    if not chosen_cards and mem_hits:
        card_titles_seen = set()
        for h in mem_hits:
            if len(chosen_cards) >= max_cards:
                break
            if h.doc.text in card_titles_seen:
                continue
            card_titles_seen.add(h.doc.text)
            chosen_cards.append((h.doc.key, h.doc.text))
            card_lines.append(f"- 【{h.doc.key}】{h.doc.text}")

    if not chosen_skills and not chosen_cards:
        return RouterResult(capsule="", skills=[], cards=[],
                            skill_top_score=skill_top, memory_top_score=mem_top,
                            char_ms=0.0, total_ms=(time.perf_counter()-t0)*1000,
                            short_circuit_reason="empty_capsule")

    # ---- 組裝 capsule ----
    body_lines: List[str] = ["相關卡片／技能"]
    if skill_lines:
        body_lines.append("")
        body_lines.append("技能：")
        body_lines.extend(skill_lines)
    if card_lines:
        body_lines.append("")
        body_lines.append("卡片：")
        body_lines.extend(card_lines)
    body = "\n".join(body_lines)

    # ---- 注入上限：分類加權保守 token 估算----
    # 不再依賴 CHAR_CAP_FALLBACK（舊邏輯：len(body) > 2000 → 截到 2000 chars）；
    # 純中文 body 時 2000 chars ≈ 2000~4000 tokens，仍會超 800 tokens 上限。
    # 改用 estimate_tokens：CJK 2/字元、ASCII ceil(N/4)、其餘 Unicode 1/字元。
    # 估計 > 800 時逐字元遞減直到估計 ≤ 800。
    truncated = False
    if estimate_tokens(body) > TOKEN_CAP_HARD:
        body, truncated = _truncate_to_token_cap(body, TOKEN_CAP_HARD)
        body += "\n（已截斷以符合注入上限）"

    total_ms = (time.perf_counter() - t0) * 1000
    return RouterResult(capsule=body, skills=chosen_skills, cards=chosen_cards,
                        skill_top_score=skill_top, memory_top_score=mem_top,
                        char_ms=total_ms, total_ms=total_ms,
                        short_circuit_reason="" if not truncated else "truncated")


# ---------------------------------------------------------------------------
# CLI 入口：從 stdin 讀 UserPromptSubmit JSON，stdout 輸出 capsule 或空
# ---------------------------------------------------------------------------


def _read_prompt_from_stdin() -> str:
    raw = sys.stdin.read()
    if not raw:
        return ""
    try:
        obj = json.loads(raw)
    except Exception:
        # fail-open: malformed JSON -> empty string -> zero output
        return ""
    if not isinstance(obj, dict):
        return ""
    # UserPromptSubmit JSON 內 prompt 欄是字串
    prompt = obj.get("prompt")
    if not isinstance(prompt, str):
        return ""
    return prompt


def main(argv=None) -> int:
    # fail-open: 把整個 main 流程（含讀 stdin、解 JSON、normalize、
    # 短路、build_indexes、build_capsule、print）全部包進最外層
    # try/except BaseException。KeyboardInterrupt／SystemExit 仍要 re-raise
    # 才能讓 host hook 正常收束。
    #
    # 驗收：read() 拋 OSError、JSON 解碼炸、normalize() 炸、build_indexes
    # 炸、build_capsule 炸——一律 rc=0、stdout 空、stderr 至多一行摘要
    # （不得吐 traceback／prompt 原文）。
    try:
        return _main_inner(argv)
    except BaseException as exc:
        if isinstance(exc, (KeyboardInterrupt, SystemExit)):
            raise
        # 寫一行到 stderr；不要 traceback、不要 prompt 原文
        try:
            sys.stderr.write(
                "recall_router_inject: fail-open "
                f"({type(exc).__name__})\n"
            )
        except Exception:
            pass
        try:
            sys.stdout.write("")
        except Exception:
            pass
        return 0


def _main_inner(argv) -> int:
    routes_md = os.environ.get(
        "RECALL_ROUTER_ROUTES_MD",
        os.path.join(MEMORY_OS_HOME, "skill-routes.md"),
    )
    skills_dir = os.environ.get(
        "RECALL_ROUTER_SKILLS_DIR",
        os.path.join(MEMORY_OS_HOME, "skills"),
    )
    memory_md = os.environ.get(
        "RECALL_ROUTER_MEMORY_MD",
        os.path.join(MEMORY_OS_HOME, "cards", "MEMORY-FULL.idx")
        + os.pathsep
        + os.path.join(MEMORY_OS_HOME, "cards", "MEMORY.md"),
    )
    if len(argv or []) > 1:
        # 支援離線測試：argv[1] 直接是 prompt 字串（不走 stdin JSON）
        prompt = argv[1]
    else:
        prompt = _read_prompt_from_stdin()
    # CHITCHAT short-circuit: if the normalized prompt equals a known phrase, return empty
    # without even building the indexes (no card reads, no IDF, no cache writes).
    # This is the last line of defence for "chit-chat gets zero injection" and is harder than the is_substantial heuristic.
    norm = normalize(prompt)
    if norm in CHITCHAT_PHRASES:
        print("", end="")
        return 0
    # Pass the **original** prompt; the helper splits tokens and normalizes each one itself, so
    # multi-word greetings ("ok thanks", "thank you", "OK 謝謝") are caught by the token rule
    # instead of relying on listing every sentence in CHITCHAT_PHRASES.
    if _is_chitchat_by_token_set(prompt):
        print("", end="")
        return 0
    try:
        idx_obj = build_indexes(routes_md, skills_dir, memory_md)
        result = build_capsule(idx_obj, prompt)
    except Exception:
        # any error: fail-open, rc=0 and empty stdout
        print("", end="")
        return 0
    print(result.capsule, end="")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))