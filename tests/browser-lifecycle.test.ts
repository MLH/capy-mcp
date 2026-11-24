import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { watchBrowser } from "./hosted/fixtures/browser-lifecycle.js";

it("returns when a child has already exited by signal", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const stop = watchBrowser(child);
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  expect(await exited).toEqual([null, "SIGTERM"]);
  await stop();
}, 2_000);

it("returns when a child has already exited with a nonzero code", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" });
  const stop = watchBrowser(child);
  expect(await once(child, "exit")).toEqual([3, null]);
  await stop();
});

it("terminates a running child and waits for the exit", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const stop = watchBrowser(child);
  try {
    await stop();
    expect(child.signalCode).toBe("SIGTERM");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

it("bounds teardown when a running child ignores SIGTERM", async () => {
  const child = spawn(process.execPath, ["-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready')",
  ], { stdio: ["ignore", "pipe", "ignore"] });
  const stop = watchBrowser(child);
  const exited = once(child, "exit");
  try {
    await once(child.stdout, "data");
    expect(await Promise.race([stop().then(() => true), delay(4_000, false, { ref: false })])).toBe(true);
    expect(child.signalCode).toBe("SIGKILL");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});
