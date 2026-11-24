import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { openBrowserTab, watchBrowser } from "./hosted/fixtures/browser-lifecycle.js";

it("allows a cold target beyond five seconds and still times out an unanswered established command", async () => {
  const script = `
    const { Socket } = require("node:net");
    const input = new Socket({ fd: 3, readable: true, writable: false });
    const output = new Socket({ fd: 4, writable: true, readable: false });
    let pending = "";
    input.on("data", chunk => {
      const frames = (pending + chunk).split("\\0");
      pending = frames.pop();
      for (const frame of frames) {
        const { id, method } = JSON.parse(frame);
        if (method.startsWith("Target.")) setTimeout(() =>
          output.write(JSON.stringify({ id, result: { targetId: "target", sessionId: "session" } }) + "\\0"),
          method === "Target.createTarget" ? 5300 : 0);
      }
    });
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const stop = watchBrowser(child);
  try {
    const tab = await openBrowserTab(child);
    await expect(tab("Page.enable")).rejects.toThrow("Browser timed out: Page.enable");
  } finally {
    await stop();
  }
}, 15_000);

it.each([
  ["exit", "process.exit(7)", /^Browser exited: 7$/],
  ["output pipe EOF", "require('node:fs').closeSync(4); setInterval(() => {}, 1000)", /^Browser debugging pipe (?:closed|failed)$/],
  ["malformed frame", "require('node:fs').writeSync(4, 'private-fixture-text' + String.fromCharCode(0)); setInterval(() => {}, 1000)", /^Invalid browser debugging response$/],
])("reports %s during startup promptly without raw child or frame text", async (_, script, message) => {
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const stop = watchBrowser(child);
  try {
    await expect(openBrowserTab(child)).rejects.toThrow(message);
  } finally {
    await stop();
  }
}, 3_000);

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
