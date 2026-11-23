import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { createSchemaCompiler } from "../scripts/catalog.js";
import { selectOperations } from "../src/catalog.js";
import { validators } from "../src/generated/validators.js";

const operations = selectOperations();
const compiler = createSchemaCompiler();

const pointerFields = [
  ["group_by", "WebhookGroupSelector"],
  ["when", "WebhookRuleCondition"],
] as const;

const queryFields = [
  ["capy_attachments_list", { threadId: "jam_example" }, "limit"],
  ["capy_automations_list_batches", { automationId: "aut_example" }, "limit"],
  ["capy_folders_threads", { folderId: "folder_example" }, "limit"],
  ["capy_issues_relations", { code: "CAP-1" }, "limit"],
  ["capy_issues_relations", { code: "CAP-1" }, "offset"],
  ["capy_usage_series", undefined, "limit"],
] as const;

function inputSchema(name: keyof typeof validators) {
  return operations.find((operation) => operation.name === name)!.inputSchema;
}

function automationArgs(field: (typeof pointerFields)[number][0], body_pointer: unknown) {
  return {
    body: {
      requestId: "pattern-test",
      projectId: "project-example",
      name: "Webhook batching",
      prompt: "Process incoming deliveries",
      triggers: [{
        type: "incoming_webhook",
        coalescing: {
          rules: [field === "group_by"
            ? { group_by: [{ body_pointer }] }
            : { group_by: "all", when: [{ body_pointer, equals: "ready" }] }],
          max_events: 2,
          max_wait_seconds: 60,
        },
      }],
    },
  };
}

it.each(pointerFields)("advertises an unambiguous pointer pattern for %s", (_, definition) => {
  expect(inputSchema("capy_automations_create")).toHaveProperty(
    ["$defs", definition, "anyOf", "0", "properties", "body_pointer", "pattern"],
    String.raw`^(?:\/(?:[^~]|~[01])*)?$`,
  );
});

it.each(queryFields)("advertises an unambiguous numeric pattern for %s %j %s", (name, _, field) => {
  expect(inputSchema(name)).toHaveProperty(
    ["properties", "query", "properties", field, "pattern"],
    String.raw`^[+-]?(?:\d+|\d*\.\d+)(?:[Ee][+-]?\d+)?$`,
  );
});

it.each(pointerFields)("preserves %s pointer acceptance in both validators", (field) => {
  const name = "capy_automations_create";
  const advertised = compiler.compile(inputSchema(name));
  const accepted = ["", "/", "/a//b/", "/~0/~1/~01", "/雪/🧪", "/\ud800", "/\r\n\u2028\u2029"];
  const rejected = ["x", "#/x", "~0", "/name/~", "/tag/~2", "/tag/~０", "\n", 1];
  for (const [values, expected] of [[accepted, true], [rejected, false]] as const) {
    for (const value of values) {
      const args = automationArgs(field, value);
      expect(advertised(args), JSON.stringify(value)).toBe(expected);
      expect(validators[name](args), JSON.stringify(value)).toBe(expected);
    }
  }
});

it.each(queryFields)("preserves numeric string acceptance in both validators for %s %j %s", (name, path, field) => {
  const advertised = compiler.compile(inputSchema(name));
  const accepted = ["0", "001", "+10", "-1", ".5", "-.5", "12.30", "1e0", "-1.2E+03", "+.5e-2"];
  const rejected = ["", "+", ".", "1.", "1.e2", "1e", "1e+", "1e.2", "1 2", " 1", "１", "١", "1\n", "1\r\n", "1\u2028", "1\u2029", 1];
  for (const [values, expected] of [[accepted, true], [rejected, false]] as const) {
    for (const value of values) {
      const args = { ...(path ? { path } : {}), query: { [field]: value } };
      expect(advertised(args), JSON.stringify(value)).toBe(expected);
      expect(validators[name](args), JSON.stringify(value)).toBe(expected);
    }
  }
});

it("validates large allowed strings and preserves the pointer length bound in a bounded process", () => {
  const cases = [
    ...pointerFields.flatMap(([field]) => [
      ["capy_automations_create", automationArgs(field, "/" + "🧪".repeat(1_023)), true],
      ["capy_automations_create", automationArgs(field, "/" + "🧪".repeat(1_024)), false],
    ]),
    ...queryFields.map(([name, path, field]) => [
      name,
      { ...(path ? { path } : {}), query: { [field]: `+${"7".repeat(25_000)}e-2` } },
      true,
    ]),
  ];
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { validators } from ${JSON.stringify(new URL("../src/generated/validators.js", import.meta.url).href)};
    for (const [name, args, expected] of JSON.parse(readFileSync(0, "utf8"))) {
      assert.equal(validators[name](args), expected, name);
    }
  `], {
    input: JSON.stringify(cases),
    timeout: 2_000,
    killSignal: "SIGKILL",
    encoding: "utf8",
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
});
