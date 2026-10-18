"""Mock-command IBus Hangul configuration checks; no real session or daemon."""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('configure_input',
    Path(__file__).parent.parent/'images/cloudbite-computer/configure-input.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class Session:
    def __init__(self, hangul_keys=('hangul-keyboard', 'switch-keys', 'initial-input-mode'),
                 engines="['xkb:us::eng', 'anthy']", daemon=False, has_hangul=True):
        self.values = {
            (module.GENERAL, 'preload-engines'): engines,
            (module.GENERAL, 'engines-order'): '@as []',
            (module.HANGUL, 'hangul-keyboard'): "'2'",
            (module.HANGUL, 'switch-keys'): "'Hangul'",
            (module.HANGUL, 'initial-input-mode'): "'latin'"}
        self.hangul_keys, self.daemon, self.has_hangul = hangul_keys, daemon, has_hangul
        self.engine, self.sets, self.starts = 'xkb:us::eng', [], 0
    def __call__(self, argv, timeout=5):
        assert timeout <= 10
        if argv[:2] == ['gsettings', 'list-keys']:
            keys = ['preload-engines', 'engines-order', 'use-system-keyboard-layout'] \
                if argv[2] == module.GENERAL else list(self.hangul_keys)
            return '\n'.join(keys)
        if argv[:2] == ['gsettings', 'get']:
            return self.values[(argv[2], argv[3])]
        if argv[:2] == ['gsettings', 'set']:
            assert argv[3] != 'use-system-keyboard-layout', 'no XKB override'
            self.sets.append(argv[3]); self.values[(argv[2], argv[3])] = \
                argv[4] if argv[4].startswith('[') else "'%s'" % argv[4]
            return ''
        if argv[0] == 'ibus-daemon':
            assert argv == ['ibus-daemon', '--daemonize', '--xim']
            self.starts += 1; self.daemon = True; return ''
        if argv[0] == 'ibus':
            if not self.daemon: return None
            if argv == ['ibus', 'address']: return 'unix:abstract=/tmp/ibus'
            if argv == ['ibus', 'engine']: return self.engine
            if argv == ['ibus', 'engine', 'hangul'] and self.has_hangul:
                self.engine = 'hangul'; return ''
            return None
        raise AssertionError(argv)

s = Session()
assert module.configure(s, lambda _: None) == {'ok': True, 'engine': 'hangul', 'daemon': True}
assert module.parse_strv(s.values[(module.GENERAL, 'preload-engines')]) == ['hangul', 'xkb:us::eng', 'anthy']
assert module.parse_strv(s.values[(module.GENERAL, 'engines-order')]) == ['hangul', 'xkb:us::eng']
assert s.values[(module.HANGUL, 'switch-keys')] == "'Hangul,Shift+space'", 'existing toggle kept'
assert s.values[(module.HANGUL, 'initial-input-mode')] == "'hangul'"
assert s.starts == 1
sets = len(s.sets)
assert module.configure(s, lambda _: None)['ok'] and len(s.sets) == sets and s.starts == 1, 'idempotent'

s = Session(hangul_keys=('hangul-keyboard', 'switch-keys'))
assert module.configure(s, lambda _: None)['ok']
assert 'initial-input-mode' not in s.sets, 'undeclared schema keys are never written'

s = Session(hangul_keys=())
assert module.configure(s, lambda _: None)['code'] == 'ibus_schema_missing' and not s.sets

s = Session(has_hangul=False)
r = module.configure(s, lambda _: None)
assert r == {'ok': False, 'engine': 'xkb:us::eng', 'daemon': True, 'code': 'hangul_engine_unavailable'}

class Dead(Session):
    def __call__(self, argv, timeout=5):
        if argv[0] == 'ibus-daemon': self.starts += 1; return None
        return super().__call__(argv, timeout)
s = Dead(); waits = []
r = module.configure(s, waits.append)
assert r['code'] == 'ibus_daemon_unavailable' and len(waits) == 20, 'bounded wait'
assert module.parse_strv('@as []') == [] and module.parse_strv(None) == []
print('cloudbite-computer-input-method: schema, idempotency and bounded daemon checks passed')
