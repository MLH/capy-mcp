import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export function watchBrowser(child: ChildProcess) {
  const exited = once(child, "exit").then(() => true, () => false);
  return async () => {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
      child.kill(signal);
      if (await Promise.race([exited, delay(1_500, false, { ref: false })])) return;
    }
    throw new Error("Chromium did not exit during teardown");
  };
}
