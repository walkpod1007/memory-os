#!/usr/bin/env python3
"""把逐字稿裡的「登入憑證」遮掉，產出一份給檢索與筆記產生器用的鏡像。

為什麼要有這支：逐字稿進了檢索索引、或送進外部模型 API 之前，裡面貼過的明文密碼
就等於進了檢索範圍／離開了本機。這支只遮「拿了就能登入」的字串：密碼、token、
API key；金額、帳號名稱、訂單等一般內容原樣保留（要不要遮金流，自己改 RULES）。

原始檔一個字都不動。這支只寫鏡像目錄，鏡像才是索引與筆記產生器的對象。
"""
import argparse
import os
import re
from pathlib import Path

MASK = '［已遮罩：登入憑證］'

# 每條規則：(說明, 正規式, 要遮的 group 編號)
# 刻意保守——寧可漏遮也不要把正常對話遮成無法閱讀。
RULES = [
    # PEM private key block (also a truncated block that has a BEGIN line but no END line)
    ('PEM 私鑰區塊',
     re.compile(r'()(-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|\Z))'), 2),
    # user:password@host embedded in a URL (postgres://user:pa55@host/db, https://u:p@host)
    ('URL 內嵌 user:pass@',
     re.compile(r'(\b[A-Za-z][A-Za-z0-9+.\-]*://[^\s/:@]+:)([^\s/@]+)(?=@)'), 2),
    # password with any common separator: "password: x", "Password=x", "密碼是 x", "my password is x"
    ('密碼：xxx / 密码:xxx / password: xxx / Password=xxx / password is xxx / 密碼是 xxx',
     re.compile(r'((?:密碼|密码|passwd|password|passphrase|pwd)\s*(?:[:：=]|是|為|\bis\b|\bwas\b)\s*)(\S+)', re.I), 2),
    ('子帳號密碼：xxx',
     re.compile(r'((?:子帳號密碼|帳密)\s*[:：]\s*)(\S+)', re.I), 2),
    ('API key / token / secret',
     re.compile(r'((?:api[_ -]?key|(?:access|auth|refresh|client)[_ -]?(?:token|secret)|token|secret)\s*[:：=]\s*)([A-Za-z0-9_\-\.]{12,})', re.I), 2),
    # Bearer <token> without a colon (e.g. "Authorization: Bearer eyJ..."), and "bearer: <token>"
    ('Bearer token',
     re.compile(r'(\bbearer\s*[:：=]?\s+)([A-Za-z0-9_\-\.=+/~]{16,})', re.I), 2),
    # keys pasted bare, without any label
    ('裸貼金鑰 xoxb-／sk-／ghp_／github_pat_／AKIA／AIza／ya29.／npm_／JWT',
     re.compile(r'()(\b(?:xox[abposr]-[0-9A-Za-z-]{10,}|sk-[A-Za-z0-9_\-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|AIza[0-9A-Za-z_\-]{35}|ya29\.[0-9A-Za-z_\-]{20,}|npm_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,})(?![A-Za-z0-9_\-]))'), 2),
]

# 「帳號：a@b 密碼：c」這種成對出現時，帳號那半不遮（要知道是哪個帳號被外洩）。

# 結構規則：同一行「信箱 + 空白 + 一串非空白」——常見的貼法，沒有任何標籤可比。
# 後半至少 6 字元、且不是信箱／網址／純中文，才當成密碼。
EMAIL_PAIR = re.compile(
    r'([\w.+-]+@[\w-]+\.[\w.-]+)([ \t]{1,})([^\s@]{6,})(?=\s|$)')


def _looks_like_secret(s: str) -> bool:
    if s.startswith(('http', 'www.')) or '@' in s:
        return False
    if not re.search(r'[A-Za-z]', s) or not re.search(r'[0-9]', s):
        return False          # 假設密碼為英數混合
    return True


def load_denylist(path):
    """一行一個字串的黑名單。**刻意放在 repo 外**（預設 $MEMORY_OS_HOME/redact-denylist.txt），
    因為把祕密寫進 scripts/ 等於把它送進版控——那正是這支要解決的問題。"""
    p = Path(path).expanduser()
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding='utf-8').splitlines():
        s = line.strip()
        if s and not s.startswith('#'):
            out.append(s)
    return sorted(set(out), key=len, reverse=True)   # 長的先換，避免子字串先被吃掉


def redact_text(t: str, denylist=()):
    n = 0
    for _, rx, gi in RULES:
        def sub(m):
            nonlocal n
            n += 1
            return m.group(1) + MASK
        t, _k = rx.subn(sub, t)

    def pair_sub(m):
        nonlocal n
        if not _looks_like_secret(m.group(3)):
            return m.group(0)
        n += 1
        return m.group(1) + m.group(2) + MASK
    t = EMAIL_PAIR.sub(pair_sub, t)

    for s in denylist:
        if s in t:
            n += t.count(s)
            t = t.replace(s, MASK)
        # 半遮版也要收：對話裡常見把密碼寫成「前半****」，
        # 完整字串比不到，但露出來的前半仍然是密碼的一半。
        head = s[:max(4, len(s) // 2)]
        rx = re.compile(re.escape(head) + r'\*{2,}')
        t, k = rx.subn(MASK, t)
        n += k
    return t, n


def main():
    ap = argparse.ArgumentParser()
    home = Path(os.environ.get('MEMORY_OS_HOME') or (Path.home() / '.memory-os'))
    ap.add_argument('--src', default=str(home / 'chats' / 'raw'))
    ap.add_argument('--out', default=str(home / 'chats' / 'redacted'))
    ap.add_argument('--subdirs', default='.', help='逗號分隔的 src 子目錄；預設 . ＝整個 src')
    ap.add_argument('--denylist', default=str(home / 'redact-denylist.txt'),
                    help='一行一個字串的祕密黑名單，刻意放在 repo 外')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    src, out = Path(a.src), Path(a.out)
    deny = load_denylist(a.denylist)
    files = hits = masked = 0
    for sub in a.subdirs.split(','):
        for f in sorted((src / sub).rglob('*.md')):
            rel = f.relative_to(src)
            t = f.read_text(encoding='utf-8', errors='replace')
            r, n = redact_text(t, deny)
            files += 1
            if n:
                hits += 1
                masked += n
            if not a.dry_run:
                d = out / rel
                d.parent.mkdir(parents=True, exist_ok=True)
                d.write_text(r, encoding='utf-8')
    verb = '會遮' if a.dry_run else '已遮'
    print(f'{files} 個檔；{hits} 個檔命中，{verb} {masked} 處 → {out}')
    print(f'黑名單 {len(deny)} 條（{a.denylist}）')


if __name__ == '__main__':
    main()
