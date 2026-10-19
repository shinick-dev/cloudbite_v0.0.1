// Safe-end wiring: registers the computer DO end hooks once at module load (index.ts imports this module).
// Wired: the automatic environment backup (cloudbite-computer-backups.ts) over the computer DO's own storage, the owner's own
// Daytona account per item (never substituted) and the storage-only protected-names helper. disk_backup therefore works
// without R2: the stop keeps the disk, the backup is reported on its own line and external files stay "not configured".
// NOT wired: the files drain. files_verified stays unavailable (409 files_not_configured) until (1) the watcher + agent
// combined prepare-end report is installed and launched on the machine, and (2) workerd delivery of the agent's HTTP calls
// (computerMachine on this same DO) while the DO alarm awaits the drain is proven not to deadlock. Hooks run inside the DO
// serial queue and never call a ComputerService/DO method. Contract: docs/cloudbite/files-integration.md.
import { ComputerBackups, type BackupProvider, type BackupSnapshotInfo, type ComputerBackupStatus } from './cloudbite-computer-backups';
import { computerAccounts, type ComputerEnv } from './cloudbite-computer-contract';
import { restDaytona, type ComputerDaytona } from './cloudbite-computer-daytona';
import { computerBackupProtectedNames, setComputerEndHooks, type ComputerBackupHook, type ComputerEndHooks } from './cloudbite-computer-service';
import type { Dt } from './lab';

/** An error that proves nothing was sent (definite 4xx for the backups manager). */
const refused = (why: string) => Object.assign(new Error(why), { status: 400 });

/** Daytona adapter for the backups manager. Every call uses the item's own configured account; a missing account is a
 *  definite refusal before any request (never another account). Provider errors keep their HTTP status. */
export function computerBackupProvider(env: ComputerEnv, daytona: ComputerDaytona = restDaytona): BackupProvider {
  const dt = (account: string): Dt => {
    const a = computerAccounts(env).find((x) => x.id === account);
    if (!a) throw refused('account_not_configured');
    return { api: a.api, key: a.key };
  };
  return {
    getSnapshot: async (account, nameOrId) => (await daytona.getSnapshot(dt(account), nameOrId)) as BackupSnapshotInfo | null,
    // restDaytona.createSnapshot always sends includeMemory:false (a cold filesystem capture).
    createSnapshot: async (account, machineId, name) => { await daytona.createSnapshot(dt(account), machineId, name); },
    removeSnapshot: async (account, id) => {
      const c = dt(account);
      if (!daytona.removeSnapshot) throw refused('remove_unavailable');
      return daytona.removeSnapshot(c, id); // DELETE by id only
    },
  };
}

/** An unconfirmed create (work:false) can only be resolved by an explicit reconcile; the end flow treats it as blocked
 *  at once instead of polling a status that cannot change on its own. The reason stays visible. */
const settle = (s: ComputerBackupStatus): ComputerBackupStatus =>
  s.state === 'unknown' && s.reason === 'create_unconfirmed' && s.work !== true ? { ...s, state: 'blocked' } : s;

/** The end-flow hook over the manager. begin (explicit end only, from the alarm) first re-reads unconfirmed creates by
 *  exact name: read-only, it never creates, deletes or drops anything; a proven capture is adopted, the rest stays blocking. */
export function computerEndBackupHook(mgr: ComputerBackups): ComputerBackupHook {
  return {
    async begin(ownerTag, req) {
      try {
        if ((await mgr.summary(ownerTag))?.items.some((i) => i.state === 'unconfirmed')) await mgr.reconcile(ownerTag);
      } catch { /* recheck is best effort; begin below still refuses while anything stays unconfirmed */ }
      return settle(await mgr.begin(ownerTag, req));
    },
    tick: async (ownerTag) => settle(await mgr.tick(ownerTag)),
    status: async (ownerTag) => { const s = await mgr.status(ownerTag); return s && settle(s); },
  };
}

/** [0,1) from the platform CSPRNG (backup name suffixes). */
const random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

export function computerEndHooks(env: ComputerEnv, storage: DurableObjectStorage, daytona: ComputerDaytona = restDaytona): ComputerEndHooks {
  const mgr = new ComputerBackups({
    store: { get: (k) => storage.get(k), put: (k, v) => storage.put(k, v) },
    provider: computerBackupProvider(env, daytona),
    now: Date.now,
    random,
    protectedNames: (ownerTag) => computerBackupProtectedNames(env, storage, ownerTag),
  });
  return { backup: computerEndBackupHook(mgr) };
}

setComputerEndHooks(computerEndHooks);
