"""Metadata-only default-keyring boundary checks; no real store or credentials."""
import importlib.util
import sys
import types
from pathlib import Path

fake = types.SimpleNamespace(Interface=lambda obj, _: obj,
    String=lambda s, **_: s, Array=lambda a, **_: a,
    Struct=lambda a, **_: a, Dictionary=lambda d, **_: d)
sys.modules['dbus'] = fake
spec = importlib.util.spec_from_file_location('keyring_default',
    Path(__file__).parent.parent/'images/cloudbite-computer/keyring-default.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class Collection:
    def __init__(self, label, locked=False): self.label, self.locked = label, locked
    def Get(self, interface, key):
        return {'Label': self.label, 'Locked': self.locked}[key]

class Store:
    def __init__(self):
        self.collections = {'/org/freedesktop/secrets/collection/session': Collection('Session')}
        self.default = '/'; self.created = 0; self.sets = 0
    def get_object(self, name, path):
        assert name == 'org.freedesktop.secrets'
        return self if path == '/org/freedesktop/secrets' else self.collections[path]
    def ReadAlias(self, name): assert name == 'default'; return self.default
    def Get(self, interface, key): assert key == 'Collections'; return list(self.collections)
    def OpenSession(self, algorithm, value): assert algorithm == 'plain'; return '', '/session/owned'
    def CreateWithMasterPassword(self, properties, master):
        assert master == ('/session/owned', [], [], 'text/plain')
        assert properties == {'org.freedesktop.Secret.Collection.Label': 'CloudBite Login'}
        self.created += 1
        self.collections['/collection/owned'] = Collection('CloudBite Login')
        return '/collection/owned'
    def SetAlias(self, name, path): assert name == 'default'; self.default = path; self.sets += 1
    def UnlockWithMasterPassword(self, path, master):
        assert self.collections[path].label == 'CloudBite Login'
        assert master == ('/session/owned', [], [], 'text/plain')
        self.collections[path].locked = False

store = Store()
assert module.prepare(store) == {'ok': True}
assert module.prepare(store) == {'ok': True}
assert (store.created, store.sets) == (1, 1), 'one creation, no replacement on reuse'
store.collections[store.default].locked = True
assert module.prepare(store) == {'ok': True}, 'the owned empty-password collection unlocks after restart'
assert (store.created, store.sets) == (1, 1)
for locked in (False, True):
    store = Store(); store.collections['/private'] = Collection('My private store', locked)
    store.default = '/private'
    assert module.prepare(store) == {'ok': not locked}
    assert (store.created, store.sets) == (0, 0), 'existing default untouched, even when locked'
store = Store(); store.collections['/private'] = Collection('My private store')
assert module.prepare(store)['code'] == 'existing_keyring_requires_owner'
assert (store.created, store.sets) == (0, 0)
store = Store(); store.collections['/login'] = Collection('Login', locked=True)
assert module.prepare(store) == {'ok': False}
assert store.created == 0 and store.default == '/login', 'existing Login password is never changed'
print('cloudbite-computer-keyring: boundary and idempotency checks passed')
