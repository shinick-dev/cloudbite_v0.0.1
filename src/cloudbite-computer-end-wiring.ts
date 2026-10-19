// Safe-end wiring: registers the computer DO end hooks once at module load (index.ts imports this module).
// Wired: the automatic environment backup (cloudbite-computer-backups.ts) over the computer DO's own storage, the owner's own
// Daytona account per item (never substituted) and the storage-only protected-names helper. disk_backup therefore works
// without R2: the stop keeps the disk, the backup is reported on its own line and external files stay "not configured".
// Wired with R2 only: the files resume hook. After the computer object sees the SAME owned machine running again (ordinary
// stop/start, or a blocked/cancelled end) it refreshes the capability and resumes + relaunches the watcher on a machine that
// is already the files writer and was set up by files/agent/configure; any other machine is skipped untouched.
// NOT wired: the files drain. files_verified stays unavailable (409 files_not_configured) until workerd delivery of the
// agent's HTTP calls (computerMachine on this same DO) while the DO alarm awaits the drain is proven not to deadlock and a
// separate re-entry/admission proof exists. Watcher sync during a normal session does not depend on the end gate.
// Hooks run inside the DO serial queue and never call a ComputerService/DO method. Contract: docs/cloudbite/files-integration.md.
import { ComputerBackups, type BackupProvider, type BackupSnapshotInfo, type ComputerBackupStatus } from './cloudbite-computer-backups';
import { COMPUTER_LABEL_OWNER, COMPUTER_OWNER_TAG, COMPUTER_REQUEST_ID, computerAccounts, type ComputerEnv, type ComputerMachineRef } from './cloudbite-computer-contract';
import { restDaytona, type ComputerDaytona } from './cloudbite-computer-daytona';
import { filesBridgeEndpoint, filesBridgeResume } from './cloudbite-computer-files-bridge';
import { FILES_DAYTONA_IO, filesBridgeDeps, type FilesBridgeIo } from './cloudbite-computer-files-integration';
import { stubOf, type FilesEnv } from './cloudbite-computer-files-runtime';
import { computerBackupProtectedNames, setComputerEndHooks, type ComputerBackupHook, type ComputerEndHooks } from './cloudbite-computer-service';
import type { StorageStatusView } from './cloudbite-computer-files-contract';
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

const resumeFailed = (code: string, status = 409) => Object.assign(new Error(code), { code, status });

/** Files resume hook, or undefined without the R2 body store, the files object or a valid gateway (then the computer
 *  object makes no files call and no VM operation). Resolves when resumed or when there is nothing of ours to resume
 *  (machine not the files writer, never set up here); rejects when a step failed or its outcome is unknown, so the
 *  computer object's bounded retry applies. Uses the machine it is given; never promotes a writer: filesAgentGrant only
 *  runs after the files object already names this machine as its writer. */
export function computerFilesResumeHook(env: ComputerEnv, io: FilesBridgeIo = FILES_DAYTONA_IO): ComputerEndHooks['resume'] {
  const fenv = env as FilesEnv;
  if (!fenv.CLOUDBITE_FILES_BUCKET || !fenv.CLOUDBITE_COMPUTER_FILES || !filesBridgeEndpoint(fenv.CLOUDBITE_GATEWAY_URL)) return undefined;
  return async (machine: ComputerMachineRef, requestId: string) => {
    const tag = machine?.labels?.[COMPUTER_LABEL_OWNER];
    if (typeof tag !== 'string' || !COMPUTER_OWNER_TAG.test(tag) || typeof requestId !== 'string' || !COMPUTER_REQUEST_ID.test(requestId))
      throw resumeFailed('bad_request', 400);
    const stub = stubOf(fenv, tag);
    if (!stub) throw resumeFailed('store_not_configured', 503);
    const st = await stub.filesCall(tag, 'status', {});
    if (!('ok' in st)) throw resumeFailed(st.error.code, st.status);
    if ((st.body as { status?: StorageStatusView }).status?.writerMachine !== machine.id) return; // not ours to resume
    const r = await filesBridgeResume(filesBridgeDeps(fenv, tag, machine, io), { requestId });
    if (r.status !== 200) {
      const code = (r.body.error as { code?: unknown } | undefined)?.code;
      throw resumeFailed(typeof code === 'string' ? code : 'resume_failed', r.status);
    }
  };
}

/** [0,1) from the platform CSPRNG (backup name suffixes). */
const random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

export function computerEndHooks(env: ComputerEnv, storage: DurableObjectStorage, daytona: ComputerDaytona = restDaytona,
  filesIo: FilesBridgeIo = FILES_DAYTONA_IO): ComputerEndHooks {
  const mgr = new ComputerBackups({
    store: { get: (k) => storage.get(k), put: (k, v) => storage.put(k, v) },
    provider: computerBackupProvider(env, daytona),
    now: Date.now,
    random,
    protectedNames: (ownerTag) => computerBackupProtectedNames(env, storage, ownerTag),
  });
  const resume = computerFilesResumeHook(env, filesIo);
  return resume ? { backup: computerEndBackupHook(mgr), resume } : { backup: computerEndBackupHook(mgr) };
}

setComputerEndHooks(computerEndHooks);
