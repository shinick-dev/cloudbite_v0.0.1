import type { Dt } from './lab';
import { LabDemoService, type DemoDeps, type DemoRef } from './lab-demo-service';
import { demoCommand, demoFile, demoSandbox } from './lab-demo-native';
import type { Fail, Lab, Session } from './state';

type DemoLab = Lab & { teacherDemoFor?: string };
export interface DemoStateDeps {
  storage: DurableObjectStorage;
  now(): number;
  checkAdmin(token: string): Promise<boolean>;
  lab(id: string): Promise<DemoLab | undefined>;
  daytona(): Promise<Dt | Fail>;
  create: DemoDeps['create'];
  warm: DemoDeps['warm'];
  seatOrigin(label: string): string;
}
const bad = (v: unknown): v is Fail => !!v && typeof v === 'object' && 'status' in v && 'error' in v;

export function makeDemoService(d: DemoStateDeps) {
  const parent = async (id: string) => {
    const lab = await d.lab(id);
    return !!lab && !lab.teacherDemoFor;
  };
  const demo = async (id: string): Promise<DemoRef | undefined> => {
    const lab = await d.lab(id);
    if (!lab?.teacherDemoFor || lab.seats.length !== 1) return;
    const seat = lab.seats[0];
    if (!seat.label || !await parent(lab.teacherDemoFor)) return;
    const mapping = await d.storage.get<{ lab: string; n: number }>('seat:' + seat.code);
    if (mapping?.lab !== id || mapping.n !== seat.n) return;
    const sess = seat.sid ? await d.storage.get<Session>('sess:' + seat.sid) : undefined;
    const valid = !!sess && sess.lab === id && !sess.revoked && sess.expiresAt > d.now();
    return { id, parentId: lab.teacherDemoFor, code: seat.code, label: seat.label, sandboxId: seat.sandboxId, expiresAt: lab.expiresAt, ready: !!seat.sandboxId && valid && !seat.error, error: seat.error };
  };
  const gateFor = (token: string, ref: DemoRef) => async () => {
    if (!await d.checkAdmin(token)) return false;
    const current = await demo(ref.id);
    return !!current?.ready && current.sandboxId === ref.sandboxId && current.parentId === ref.parentId && current.code === ref.code;
  };
  return new LabDemoService({
    storage: d.storage, now: d.now, checkAdmin: d.checkAdmin, parent, demo, create: d.create, warm: d.warm, origin: d.seatOrigin,
    async command(token, ref, command) {
      const gate = gateFor(token, ref);
      const c = await d.daytona(); if (bad(c)) throw Error('demo provider unavailable');
      if (!ref.sandboxId || !await gate()) throw Error('demo changed');
      const sb = await demoSandbox(c, ref.sandboxId);
      return demoCommand(c, sb, command, gate);
    },
    async file(token, ref, filename, save) {
      const gate = gateFor(token, ref);
      const c = await d.daytona(); if (bad(c)) throw Error('demo provider unavailable');
      if (!ref.sandboxId || !await gate()) throw Error('demo changed');
      const sb = await demoSandbox(c, ref.sandboxId);
      return demoFile(c, sb, filename, save, gate);
    },
  });
}
