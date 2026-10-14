#!/usr/bin/env python3
"""Offline test for notes/chatlog_redact.py: every secret shape below must be masked,
and ordinary sentences must stay untouched.  Run: python3 tests/test_redact.py"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "notes"))
from chatlog_redact import MASK, redact_text  # noqa: E402

MUST_MASK = [
    ("Password=abc123XYZ", "abc123XYZ"),
    ("password: hunter2abc", "hunter2abc"),
    ("pwd = secret99", "secret99"),
    ("my password is hunter2abc", "hunter2abc"),
    ("密碼是 abc12345", "abc12345"),
    ("密碼：abc12345", "abc12345"),
    ("key sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345 here", "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345"),
    ("key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv"),
    ("Authorization: Bearer abcdef0123456789abcdef", "abcdef0123456789abcdef"),
    ("curl -H 'Bearer abcdef0123456789abcdef'", "abcdef0123456789abcdef"),
    ("postgres://admin:pa55w0rd@db.example.com/app", "pa55w0rd"),
    ("https://user:s3cretpass@example.com/path", "s3cretpass"),
    ("token: abcdef0123456789", "abcdef0123456789"),
    ("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk"),
    ("ya29.a0AbCdEfGhIjKlMnOpQrStUvWx", "ya29.a0AbCdEfGhIjKlMnOpQrStUvWx"),
    ("npm_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7", "npm_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7"),
    ("x -----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\nKUpRKfFLfRYC9AIKjbJTWit\n-----END RSA PRIVATE KEY----- y", "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu"),
    ("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n(truncated, no end line)", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"),
    # previously covered shapes must keep working
    ("api_key: AbCdEfGhIjKl1234", "AbCdEfGhIjKl1234"),
    ("ghp_" + "a" * 36, "a" * 36),
    ("AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"),
]
MUST_KEEP = [
    "The TV goes in the bedroom, budget 900 USD.",
    "請幫我記一下這個密碼管理的想法",
    "the bearer of the news arrived late",
    "I reset the token bucket limit to 100 requests",
    "see https://example.com/docs and http://localhost:8080/api",
    "sk-short",
]


def main():
    bad = 0
    for text, secret in MUST_MASK:
        out, n = redact_text(text)
        if secret in out or MASK not in out or n < 1:
            bad += 1
            print("NOT MASKED:", repr(text), "->", repr(out))
    for text in MUST_KEEP:
        out, n = redact_text(text)
        if out != text:
            bad += 1
            print("OVER-MASKED:", repr(text), "->", repr(out))
    if bad:
        sys.exit(f"FAIL: {bad} case(s)")
    print(f"PASS test_redact ({len(MUST_MASK)} masked, {len(MUST_KEEP)} kept)")


if __name__ == "__main__":
    main()
