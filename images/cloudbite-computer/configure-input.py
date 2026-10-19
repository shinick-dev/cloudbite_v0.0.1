#!/usr/bin/python3
"""Configure the desktop owner's IBus Hangul input method; idempotent.

Run as the desktop user with DISPLAY and the shared session bus already exported.
Only IBus's own settings are touched, and only keys the installed schemas declare
(checked with gsettings list-keys, never assumed). Existing engines and toggle keys
are kept; Hangul is moved first and the US layout engine is kept for Latin input.
No XKB layout is overridden. Prints one JSON line: {ok, engine, daemon}.
"""
import json
import os
import subprocess
import sys
import time

GENERAL = 'org.freedesktop.ibus.general'
HANGUL = 'org.freedesktop.ibus.engine.hangul'
ENGINES = ['hangul', 'xkb:us::eng']
SWITCH_KEYS = ['Hangul', 'Shift+space']
TIMEOUT = 5

def run(argv, timeout=TIMEOUT):
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                             stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() if out.returncode == 0 else None

def parse_strv(text):
    # gsettings prints GVariant: ['a', 'b'] or @as [] for an empty array.
    text = (text or '').strip()
    if text.startswith('@as'):
        text = text[3:].strip()
    if not (text.startswith('[') and text.endswith(']')):
        return []
    return [p.strip().strip("'\"") for p in text[1:-1].split(',') if p.strip()]

def strv(values):
    return '[' + ', '.join("'%s'" % v for v in values) + ']'

def configure(cmd=run, wait=time.sleep):
    general = set((cmd(['gsettings', 'list-keys', GENERAL]) or '').split())
    hangul = set((cmd(['gsettings', 'list-keys', HANGUL]) or '').split())
    if 'preload-engines' not in general or not hangul:
        return {'ok': False, 'code': 'ibus_schema_missing', 'engine': None, 'daemon': False}

    for key in ('preload-engines', 'engines-order'):
        if key not in general:
            continue
        current = parse_strv(cmd(['gsettings', 'get', GENERAL, key]))
        wanted = ENGINES + [e for e in current if e not in ENGINES]
        if wanted != current:
            cmd(['gsettings', 'set', GENERAL, key, strv(wanted)])
    if 'hangul-keyboard' in hangul and (cmd(['gsettings', 'get', HANGUL, 'hangul-keyboard']) or '') == "''":
        cmd(['gsettings', 'set', HANGUL, 'hangul-keyboard', '2'])
    if 'switch-keys' in hangul:
        current = (cmd(['gsettings', 'get', HANGUL, 'switch-keys']) or '').strip("'\"")
        keys = [k for k in current.split(',') if k]
        merged = keys + [k for k in SWITCH_KEYS if k.lower() not in {x.lower() for x in keys}]
        if merged != keys:
            cmd(['gsettings', 'set', HANGUL, 'switch-keys', ','.join(merged)])
    if 'initial-input-mode' in hangul:
        if (cmd(['gsettings', 'get', HANGUL, 'initial-input-mode']) or '') != "'latin'":
            cmd(['gsettings', 'set', HANGUL, 'initial-input-mode', 'latin'])

    if cmd(['ibus', 'address']) is None or cmd(['ibus', 'engine']) is None:
        cmd(['ibus-daemon', '--daemonize', '--xim'], timeout=10)
    daemon = False
    for _ in range(20):
        if cmd(['ibus', 'engine']) is not None:
            daemon = True
            break
        wait(0.25)
    if not daemon:
        return {'ok': False, 'code': 'ibus_daemon_unavailable', 'engine': None, 'daemon': False}
    if cmd(['ibus', 'engine']) != 'hangul':
        cmd(['ibus', 'engine', 'hangul'])
    engine = cmd(['ibus', 'engine'])
    result = {'ok': engine == 'hangul', 'engine': engine, 'daemon': True}
    if not result['ok']:
        result['code'] = 'hangul_engine_unavailable'
    return result

if __name__ == '__main__':
    if os.geteuid() == 0:
        print(json.dumps({'ok': False, 'code': 'input_as_root', 'engine': None, 'daemon': False}))
        sys.exit(1)
    if not os.environ.get('DISPLAY') or not os.environ.get('DBUS_SESSION_BUS_ADDRESS'):
        print(json.dumps({'ok': False, 'code': 'session_env_missing', 'engine': None, 'daemon': False}))
        sys.exit(1)
    try:
        result = configure()
    except Exception:
        result = {'ok': False, 'code': 'input_configure_failed', 'engine': None, 'daemon': False}
    print(json.dumps(result))
    sys.exit(0 if result.get('ok') else 1)
