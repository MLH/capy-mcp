import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import { selectOperations } from "../src/catalog.js";

const artifact = new URL("../dist/stdio.js", import.meta.url).pathname;
const baseEnv = { PATH: process.env.PATH ?? "", CAPY_API_KEY: "fake-stdio-secret" };
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "wire-test", version: "1" } } };

describe("production STDIO executable", () => {
  it("has a Node shebang, executable mode, and package bin mapping", async () => {
    expect((await readFile(artifact, "utf8")).startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect((await stat(artifact)).mode & 0o111).not.toBe(0);
    expect(JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).bin).toEqual({ "capy-mcp": "dist/stdio.js" });
  });

  it.each([undefined, "captains,issues,messages"])("initializes and lists configured tools (%s) through the official client", async (groups) => {
    const transport = new StdioClientTransport({ command: artifact, env: { ...baseEnv, ...(groups === undefined ? {} : { CAPY_TOOL_GROUPS: groups }) }, stderr: "pipe" });
    const client = new Client({ name: "stdio-test", version: "1" });
    const errors: unknown[] = [];
    let stderr = "";
    client.onerror = (error) => errors.push(error);
    transport.stderr?.on("data", (data) => { stderr += String(data); });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe("capy-mcp");
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(selectOperations(groups).map((tool) => tool.name));
    } finally {
      await client.close();
    }
    expect(errors).toEqual([]);
    expect(stderr).toBe("");
  });

  it.each(["EOF", "SIGINT", "SIGTERM"] as const)("writes only protocol JSON and exits cleanly on %s", async (shutdown) => {
    const child = spawn(process.execPath, [artifact], { env: baseEnv, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    const closed = once(child, "close");
    try {
      child.stdin.write(`${JSON.stringify(initialize)}\n`);
      await once(child.stdout, "data");
      if (shutdown === "EOF") child.stdin.end();
      else child.kill(shutdown);
      expect(await closed).toEqual([0, null]);
      const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "capy-mcp" } } });
      expect(stderr).toBe("");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  it.each([
    { CAPY_API_KEY: undefined },
    { CAPY_API_KEY: "" },
    { CAPY_API_KEY: " \t " },
    { CAPY_API_KEY: "fake-secret\nheader" },
    { CAPY_TOOL_GROUPS: "" },
    { CAPY_TOOL_GROUPS: "fake-secret-invalid-group" },
  ])("fails closed with a sanitized startup error for %j", async (overrides) => {
    const child = spawn(process.execPath, [artifact], { env: { ...baseEnv, ...overrides }, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    const [code] = await once(child, "close");
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("capy-mcp: invalid startup configuration\n");
    expect(stderr).not.toContain("fake-secret");
  });
});
