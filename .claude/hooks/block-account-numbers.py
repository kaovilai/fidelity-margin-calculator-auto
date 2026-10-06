#!/usr/bin/env python3
"""PreToolUse hook: keep brokerage account numbers out of this PUBLIC repository.

Blocks (exit code 2, message on stderr) when:
  * Write / Edit / MultiEdit / NotebookEdit would add text containing an account-number pattern;
  * a GitHub MCP tool (push_files, create_or_update_file, comments, ...) would send such text;
  * a Bash `git commit` / `git push` would include such text — in the command itself (e.g. the
    commit message), in the staged diff, in the unstaged diff for `commit -a`, or in unpushed commits.

Only text being ADDED is checked, so removing an account number is always allowed.
Placeholders such as ZXXXXXXXX never match (they contain no digits).

Patterns (deliberately generic — never put real account numbers in this file):
  * Fidelity-style account:  one of Z/Y/X followed by exactly 8 digits   e.g. Z########
  * 9-digit account near the word "account"/"acct"

Known-safe look-alikes (test fixtures etc.) can be allowed by adding regexes, one per line, to
.claude/account-number-allowlist.txt (lines starting with # are comments).

Run `python3 .claude/hooks/block-account-numbers.py --self-test` to verify the patterns.
"""
import json
import os
import re
import subprocess
import sys

PATTERNS = [
    (re.compile(r"\b[ZYX][0-9]{8}\b"), "Fidelity-style account number (letter + 8 digits)"),
    (re.compile(r"(?i)\b(?:acct|account)\b[^\n]{0,30}?\b[0-9]{9}\b"), '9-digit number near "account"'),
]
# Tool-input fields that carry NEW content for the file/edit tools (old_string is deliberately skipped).
NEW_CONTENT_KEYS = {"content", "new_string", "new_source", "text", "body", "message", "comment", "title"}
EDIT_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}


def load_allowlist(project_dir):
    path = os.path.join(project_dir, ".claude", "account-number-allowlist.txt")
    out = []
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#"):
                    out.append(re.compile(line))
    except OSError:
        pass
    return out


def find_matches(text, allow):
    hits = []
    for rx, label in PATTERNS:
        for m in rx.finditer(text):
            if any(a.search(m.group(0)) for a in allow):
                continue
            hits.append((label, m.group(0)))
    return hits


def added_lines(diff_text):
    return "\n".join(l[1:] for l in diff_text.splitlines() if l.startswith("+") and not l.startswith("+++"))


def strings_in(obj, only_new_keys=False, _key=None):
    """Yield string values from a tool_input structure."""
    if isinstance(obj, str):
        if not only_new_keys or _key in NEW_CONTENT_KEYS:
            yield obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield from strings_in(v, only_new_keys, k)
    elif isinstance(obj, list):
        for v in obj:
            yield from strings_in(v, only_new_keys, _key)


def git(cwd, *args):
    try:
        r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=20)
        return r.stdout if r.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def candidate_text(tool, tool_input, cwd):
    """Return the text this tool call would ADD, labelled by where it came from."""
    chunks = []
    if tool in EDIT_TOOLS:
        chunks += [("the content being written", s) for s in strings_in(tool_input, only_new_keys=True)]
    elif tool.startswith("mcp__github__"):
        chunks += [("the GitHub request", s) for s in strings_in(tool_input)]
    elif tool == "Bash":
        cmd = tool_input.get("command", "")
        is_commit = re.search(r"\bgit\b[^|;&\n]*\bcommit\b", cmd) is not None
        is_push = re.search(r"\bgit\b[^|;&\n]*\bpush\b", cmd) is not None
        if is_commit or is_push:
            chunks.append(("the command (e.g. the commit message)", cmd))
        if is_commit:
            chunks.append(("the staged diff", added_lines(git(cwd, "diff", "--cached"))))
            # -a / --all, including combined short flags such as -am or -sa
            if re.search(r"\bcommit\b[^|;&\n]*(?:\s-[a-zA-Z]*a[a-zA-Z]*|\s--all\b)", cmd):
                chunks.append(("the unstaged diff (commit -a)", added_lines(git(cwd, "diff"))))
        if is_push:
            upstream = git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}").strip() or "origin/main"
            chunks.append((f"unpushed commits ({upstream}..HEAD)", added_lines(git(cwd, "log", "-p", "--format=%B", f"{upstream}..HEAD"))))
    return chunks


def main():
    if "--self-test" in sys.argv:
        return self_test()
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0  # never block on an unreadable payload
    tool = payload.get("tool_name", "")
    tool_input = payload.get("tool_input") or {}
    cwd = payload.get("cwd") or os.getcwd()
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR") or cwd
    allow = load_allowlist(project_dir)

    for where, text in candidate_text(tool, tool_input, cwd):
        hits = find_matches(text, allow)
        if hits:
            label, value = hits[0]
            masked = value[:1] + "*" * (len(value) - 1)
            sys.stderr.write(
                f"BLOCKED: {label} ({masked}) found in {where}. This repository is public — never commit "
                "real account numbers. Use a placeholder such as ZXXXXXXXX (or <account>) instead, then retry. "
                "If this is a harmless look-alike, add a regex for it to .claude/account-number-allowlist.txt.\n"
            )
            return 2
    return 0


def self_test():
    fake = "Z" + "12345678"          # built at runtime so this file contains no literal match
    nine = "123" + "456789"
    allow = []
    cases = [
        (f"hash #{fake} here", True),
        (f"Y{'8' * 8}", True),
        (f"my account is {nine}", True),
        ("placeholder ZXXXXXXXX", False),
        ("order 123456789 filled", False),            # 9 digits but not near 'account'
        ("version Z1234567", False),                  # only 7 digits
        (f"{fake}9", False),                          # 9 digits after the letter: not a Fidelity pattern
    ]
    failed = 0
    for text, expect in cases:
        got = bool(find_matches(text, allow))
        flag = "ok " if got == expect else "FAIL"
        failed += got != expect
        print(f"{flag} expect_block={expect!s:5} got={got!s:5}  {text[:50]!r}")
    # Removing (old_string) must not be flagged; adding (new_string) must.
    ti = {"old_string": f"x {fake}", "new_string": "x ZXXXXXXXX"}
    ok = not any(find_matches(s, allow) for _, s in candidate_text("Edit", ti, "."))
    print(("ok " if ok else "FAIL"), "Edit that REMOVES a number is allowed")
    failed += not ok
    ti = {"old_string": "x", "new_string": f"x {fake}"}
    ok = any(find_matches(s, allow) for _, s in candidate_text("Edit", ti, "."))
    print(("ok " if ok else "FAIL"), "Edit that ADDS a number is flagged")
    failed += not ok
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
