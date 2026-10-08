import { Store } from './store.js';
import type { Sender } from './automation.js';

export function startWorker(store: Store, sender: Sender, report: (message: string) => void) {
  let running: Promise<void> | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      try {
        await store.recoverInterrupted();
        await store.processNext(sender);
      } catch { report('Reply worker failed; no private data logged'); }
    })().finally(() => { running = undefined; });
  };
  const timer = setInterval(tick, 1000);
  tick();
  return { async stop() { stopped = true; clearInterval(timer); await running; } };
}
