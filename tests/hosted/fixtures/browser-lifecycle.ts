import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export async function openBrowserTab(child: ChildProcess) {
  const input = child.stdio[3], output = child.stdio[4];
  if (!(input instanceof Writable) || !(output instanceof Readable)) throw new Error("Browser debugging pipe unavailable");
  const pending = new Map<number, {
    finish(result?: { error?: unknown; result: Record<string, unknown> }): void;
  }>();
  let failure: Error | undefined;
  let pipeFault: NodeJS.Timeout | undefined;
  function brokenPipe(reason: string) {
    if (!failure && !pipeFault) pipeFault = setTimeout(() => stop(reason), 100).unref();
  }
  function stop(reason: string) {
    clearTimeout(pipeFault);
    failure ??= new Error(reason);
    for (const command of pending.values()) command.finish();
  }
  child.on("error", () => stop("Browser process failed"));
  child.once("exit", (code, signal) => stop("Browser exited: " + (code ?? signal)));
  if (child.exitCode !== null || child.signalCode !== null) stop("Browser exited: " + (child.exitCode ?? child.signalCode));
  for (const pipe of [input, output]) {
    pipe.on("error", () => brokenPipe("Browser debugging pipe failed"));
    pipe.once("close", () => brokenPipe("Browser debugging pipe closed"));
  }
  output.once("end", () => brokenPipe("Browser debugging pipe closed"));
  let buffer = "", sequence = 0;
  output.setEncoding("utf8").on("data", chunk => {
    const messages = (buffer + chunk).split("\0");
    buffer = messages.pop()!;
    for (const message of messages) {
      try {
        const response = JSON.parse(message);
        pending.get(response.id)?.finish(response);
      } catch {
        stop("Invalid browser debugging response");
      }
    }
  });
  function command(method: string, params: unknown, sessionId: unknown, timeout: number) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (failure) return reject(failure);
      const id = ++sequence;
      const timer = setTimeout(() => stop("Browser timed out: " + method), timeout);
      pending.set(id, { finish(response) {
        pending.delete(id);
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (!response || response.error) reject(new Error("Browser rejected " + method));
        else resolve(response.result);
      } });
      (input as Writable).write(JSON.stringify({ id, method, params, sessionId }) + "\0", error => {
        if (error) brokenPipe("Browser debugging pipe failed");
      });
    });
  }
  const readyBy = performance.now() + 30_000;
  const { targetId } = await command("Target.createTarget", { url: "about:blank" }, undefined, 30_000);
  const { sessionId } = await command("Target.attachToTarget", { targetId, flatten: true }, undefined,
    Math.max(1, readyBy - performance.now()));
  return (method: string, params?: unknown) => command(method, params, sessionId, 5_000);
}

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
