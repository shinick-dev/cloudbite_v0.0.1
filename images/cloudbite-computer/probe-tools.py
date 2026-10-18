#!/usr/bin/env python3
"""Fixed presence probe for the CloudBite computer tools.

Runs each binary's ``--version`` only, under a throwaway HOME and a minimal environment,
so no login state, token or environment secret is read or reported.  Authentication is
never checked.  Last stdout line: ``{"ok": true, "tools": [{"id", "installed", "version"}]}``
where ``version`` is a bounded version string or null.
"""
import json
import re
import shutil
import subprocess
import tempfile

# id -> command; matches the native entries in src/cloudbite-computer-tools.ts.
TOOLS = (
    ("claude-code", "claude"),
    ("codex", "codex"),
    ("cursor-agent", "cursor-agent"),
    ("antigravity", "agy"),
    ("opencode", "opencode"),
    ("chromium", "chromium"),
    ("node", "/opt/cloudbite/node/bin/node"),
)
PATH = "/usr/local/bin:/opt/cloudbite/node/bin:/usr/bin:/bin"


def probe(command, home):
    exe = shutil.which(command, path=PATH)
    if not exe:
        return False, None
    env = {"PATH": PATH, "HOME": home, "LANG": "C.UTF-8", "NO_COLOR": "1", "DISABLE_AUTOUPDATER": "1"}
    try:
        out = subprocess.run([exe, "--version"], stdin=subprocess.DEVNULL, capture_output=True,
                             text=True, env=env, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return False, None
    match = re.search(r"\d+\.\d+[0-9A-Za-z.+-]*", out.stdout + out.stderr)
    if out.returncode != 0 or not match:
        return False, None
    return True, match.group(0)[:64]


def main():
    home = tempfile.mkdtemp(prefix="cloudbite-probe-")
    try:
        tools = []
        for tool_id, command in TOOLS:
            installed, version = probe(command, home)
            tools.append({"id": tool_id, "installed": installed, "version": version})
    finally:
        shutil.rmtree(home, ignore_errors=True)
    print("\n" + json.dumps({"ok": True, "tools": tools}))


if __name__ == "__main__":
    main()
