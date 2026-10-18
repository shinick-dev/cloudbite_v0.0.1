#!/usr/bin/python3
"""Initialize the private VM's empty-password default collection.

The private filesystem is the boundary, matching the existing login-keyring policy.
Only a missing collection is created. Existing protected stores stay locked for the
owner. No item or token is read, copied, changed or returned.
"""
import json
import os
import sys
import dbus

def prepare(bus):
    obj = bus.get_object('org.freedesktop.secrets', '/org/freedesktop/secrets')
    service = dbus.Interface(obj, 'org.freedesktop.Secret.Service')
    default = str(service.ReadAlias('default'))
    props = dbus.Interface(obj, 'org.freedesktop.DBus.Properties')
    collections = props.Get('org.freedesktop.Secret.Service', 'Collections')
    if default == '/':
        candidate = None
        for path in collections:
            p = dbus.Interface(bus.get_object('org.freedesktop.secrets', path), 'org.freedesktop.DBus.Properties')
            label = str(p.Get('org.freedesktop.Secret.Collection', 'Label'))
            if label in ('Login', 'login', 'CloudBite Login'):
                candidate = path
                break
        if candidate is None:
            if any(str(p) != '/org/freedesktop/secrets/collection/session' for p in collections):
                return {'ok': False, 'code': 'existing_keyring_requires_owner'}
            _, session = service.OpenSession('plain', dbus.String('', variant_level=1))
            master = dbus.Struct((session, dbus.Array([], signature='y'),
                                 dbus.Array([], signature='y'), 'text/plain'), signature='oayays')
            internal = dbus.Interface(obj, 'org.gnome.keyring.InternalUnsupportedGuiltRiddenInterface')
            candidate = internal.CreateWithMasterPassword(
                dbus.Dictionary({'org.freedesktop.Secret.Collection.Label': dbus.String('CloudBite Login')},
                                signature='sv'), master)
        service.SetAlias('default', candidate)
        default = str(candidate)
    p = dbus.Interface(bus.get_object('org.freedesktop.secrets', default), 'org.freedesktop.DBus.Properties')
    # Our collection is intentionally empty-password inside the private VM. GNOME
    # reloads it locked after a restart; --unlock only targets its special "login"
    # collection, so unlock this known collection explicitly without changing its key.
    if bool(p.Get('org.freedesktop.Secret.Collection', 'Locked')) and str(p.Get(
            'org.freedesktop.Secret.Collection', 'Label')) == 'CloudBite Login':
        _, session = service.OpenSession('plain', dbus.String('', variant_level=1))
        master = dbus.Struct((session, dbus.Array([], signature='y'),
                             dbus.Array([], signature='y'), 'text/plain'), signature='oayays')
        internal = dbus.Interface(obj, 'org.gnome.keyring.InternalUnsupportedGuiltRiddenInterface')
        internal.UnlockWithMasterPassword(default, master)
    return {'ok': not bool(p.Get('org.freedesktop.Secret.Collection', 'Locked'))}

if __name__ == '__main__':
    if os.geteuid() == 0:
        print(json.dumps({'ok': False, 'code': 'keyring_as_root'})); sys.exit(1)
    try:
        result = prepare(dbus.SessionBus())
    except Exception:
        result = {'ok': False, 'code': 'keyring_unavailable'}
    print(json.dumps(result))
    sys.exit(0 if result.get('ok') else 1)
