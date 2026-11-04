import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { buildCatalog, createSchemaCompiler } from "../scripts/catalog.js";
import standalone from "ajv/dist/standalone/index.js";
import { selectOperations } from "../src/catalog.js";
import snapshot from "../api/openapi.json" with { type: "json" };
import source from "../api/source.json" with { type: "json" };

const exclusions = [
  "tasks.list",
  "tasks.get",
  "tasks.messages",
  "streams.thread",
  "streams.subagent",
  "streams.task",
];

function fixture(schema: Record<string, unknown> = { type: "string" }) {
  return {
    openapi: "3.1.0",
    paths: {
      "/things/{id}": {
        post: {
          operationId: "things.create",
          tags: ["things"],
          summary: "Create thing",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            { name: "verbose", in: "query", schema: { type: "boolean" } },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema } },
          },
        },
      },
    },
    components: { schemas: {} as Record<string, Record<string, unknown>> },
  };
}

function validator(document = fixture()) {
  const [operation] = buildCatalog(document);
  return new Ajv2020({ strict: true, strictTypes: false }).compile(
    operation.inputSchema,
  );
}

describe("catalog coverage and names", () => {
  it("accounts for all 108 operations using exactly the six documented exclusions", () => {
    const operations = buildCatalog(snapshot);
    const ids = Object.values(snapshot.paths).flatMap((path) =>
      Object.values(path).map((op) => op.operationId),
    );
    expect(ids).toHaveLength(108);
    expect(operations).toHaveLength(102);
    expect(
      ids
        .filter((id) => !operations.some((op) => op.operationId === id))
        .sort(),
    ).toEqual([...exclusions].sort());
    expect(new Set(operations.map((op) => op.name)).size).toBe(102);
    expect(
      operations.find((op) => op.operationId === "issues.createState")?.name,
    ).toBe("capy_issues_create_state");
    expect(
      operations.find((op) => op.operationId === "reviewRules.list")?.name,
    ).toBe("capy_review_rules_list");
    expect(operations.every((op) => /^capy_[a-z0-9_]+$/.test(op.name))).toBe(
      true,
    );
  });

  it("sorts deterministically regardless of source path order", () => {
    const reversed = {
      ...snapshot,
      paths: Object.fromEntries(Object.entries(snapshot.paths).reverse()),
    };
    expect(buildCatalog(reversed)).toEqual(buildCatalog(snapshot));
    const names = buildCatalog(snapshot).map((op) => op.name);
    expect(names).toEqual([...names].sort());
  });

  it("rejects colliding normalized names", () => {
    const document = fixture();
    const operation = document.paths["/things/{id}"].post;
    const paths = {
      "/a/{id}": { post: { ...operation, operationId: "things.createThing" } },
      "/b/{id}": { post: { ...operation, operationId: "things.create_thing" } },
    };
    expect(() => buildCatalog({ ...document, paths })).toThrow(/collision/i);
  });

  it("enriches Captain, issue and message semantics and preserves parameter guidance", () => {
    const operations = buildCatalog(snapshot);
    expect(
      operations.find((op) => op.operationId === "captains.create")
        ?.description,
    ).toMatch(/thread ID.*message/i);
    expect(
      operations.find((op) => op.operationId === "issues.create")?.description,
    ).toMatch(/state.*label.*list/i);
    expect(
      operations.find((op) => op.operationId === "messages.send")?.description,
    ).toMatch(/request ID.*reus.*retr/i);
    expect(
      operations.find((op) => op.operationId === "threads.get")?.description,
    ).toContain("path.threadId");
  });

  it("marks GET operations read-only and every mutation conservatively", () => {
    for (const op of buildCatalog(snapshot)) {
      expect(op.annotations).toEqual({
        readOnlyHint: op.method === "GET",
        destructiveHint: op.method !== "GET",
        idempotentHint: op.method === "GET",
        openWorldHint: true,
      });
    }
  });
});

describe("self-contained JSON schemas", () => {
  it.each(
    ["__proto__", "constructor", "toString", "hasOwnProperty"].flatMap((name) =>
      [false, true].map((required) => ({ name, required })),
    ),
  )(
    "preserves prototype-sensitive query parameter $name (required=$required)",
    ({ name, required }) => {
      const document = fixture();
      Object.assign(document.paths["/things/{id}"].post.parameters[1], {
        name,
        required,
      });
      const [operation] = buildCatalog(document);
      const validate = createSchemaCompiler().compile(operation.inputSchema);
      const base = { path: { id: "a" }, body: "text" };
      expect(validate(base)).toBe(!required);
      expect(validate({ ...base, query: {} })).toBe(!required);
      expect(
        validate({ ...base, query: Object.fromEntries([[name, true]]) }),
      ).toBe(true);
      expect(
        validate({ ...base, query: Object.fromEntries([[name, "true"]]) }),
      ).toBe(false);
      expect(
        validate({
          ...base,
          query: Object.fromEntries([
            [name, true],
            ["extra", true],
          ]),
        }),
      ).toBe(false);
    },
  );

  it("preserves prototype-sensitive required path parameters in standalone validators", async () => {
    const document = fixture();
    document.paths["/things/{id}"].post.parameters[0].name = "__proto__";
    const paths = { "/things/{__proto__}": document.paths["/things/{id}"] };
    const [operation] = buildCatalog({ ...document, paths });
    const compiler = createSchemaCompiler();
    const validate = compiler.compile(operation.inputSchema);
    const source = standalone.default(compiler, validate);
    const bundled = await build({
      stdin: { contents: source, resolveDir: resolve(".") },
      bundle: true,
      format: "iife",
      globalName: "compiled",
      write: false,
      platform: "neutral",
    });
    const context = {
      compiled: undefined as
        | undefined
        | { default: (value: unknown) => boolean },
    };
    runInNewContext(bundled.outputFiles[0].text, context, {
      contextCodeGeneration: { strings: false, wasm: false },
    });
    const standaloneValidate = context.compiled!.default;
    expect(
      standaloneValidate({
        path: Object.fromEntries([["__proto__", "a"]]),
        body: "text",
      }),
    ).toBe(true);
    expect(standaloneValidate({ path: {}, body: "text" })).toBe(false);
    expect(
      standaloneValidate({
        path: Object.fromEntries([["__proto__", false]]),
        body: "text",
      }),
    ).toBe(false);
  });

  it("requires path and body while allowing an omitted optional query object", () => {
    const validate = validator();
    expect(validate({ path: { id: "a" }, body: "text" })).toBe(true);
    expect(validate({ body: "text" })).toBe(false);
    expect(validate({ path: {}, body: "text" })).toBe(false);
    expect(validate({ path: { id: "a" } })).toBe(false);
    expect(validate({ path: { id: "a" }, body: "text", extra: 1 })).toBe(false);
    expect(validate({ path: { id: "a", extra: 1 }, body: "text" })).toBe(false);
    expect(
      validate({ path: { id: "a" }, body: "text", query: { extra: 1 } }),
    ).toBe(false);
  });

  it("requires query when a contained parameter is required and keeps optional bodies optional", () => {
    const document = fixture();
    document.paths["/things/{id}"].post.parameters[1].required = true;
    document.paths["/things/{id}"].post.requestBody.required = false;
    const validate = validator(document);
    expect(validate({ path: { id: "a" } })).toBe(false);
    expect(validate({ path: { id: "a" }, query: { verbose: false } })).toBe(
      true,
    );
  });

  it("preserves nested references, recursive schemas, unions, enums and additional properties", () => {
    const document = fixture({ $ref: "#/components/schemas/Node" });
    document.components.schemas = {
      Node: {
        type: "object",
        required: ["value"],
        properties: {
          value: {
            anyOf: [
              { type: "integer", minimum: 1 },
              { type: "string", enum: ["ready"] },
            ],
          },
          next: { $ref: "#/components/schemas/Node" },
          labels: { type: "object", additionalProperties: { type: "boolean" } },
        },
        additionalProperties: false,
      },
      Unused: { type: "string" },
    };
    const [op] = buildCatalog(document);
    const validate = validator(document);
    expect(
      validate({
        path: { id: "a" },
        body: { value: "ready", next: { value: 2 }, labels: { a: true } },
      }),
    ).toBe(true);
    for (const body of [
      { value: "bad" },
      { value: 0 },
      { value: 1, next: { value: false } },
      { value: 1, extra: 1 },
      { value: 1, labels: { a: "true" } },
    ]) {
      expect(validate({ path: { id: "a" }, body })).toBe(false);
    }
    expect(Object.keys(op.inputSchema.$defs as object)).toEqual(["Node"]);
  });

  it("does not coerce, insert defaults, or remove properties", () => {
    const validate = validator(
      fixture({
        type: "object",
        properties: { count: { type: "integer", default: 7 } },
        additionalProperties: false,
      }),
    );
    const input = { path: { id: "a" }, body: { count: "2", unknown: true } };
    expect(validate(input)).toBe(false);
    expect(input).toEqual({
      path: { id: "a" },
      body: { count: "2", unknown: true },
    });
    const absent = { path: { id: "a" }, body: {} };
    expect(validate(absent)).toBe(true);
    expect(absent.body).toEqual({});
  });

  it("rejects unknown or external references", () => {
    for (const $ref of [
      "#/components/schemas/Missing",
      "https://example.com/schema.json",
    ]) {
      expect(() => buildCatalog(fixture({ $ref }))).toThrow(/reference/i);
    }
  });

  it("rejects unknown schema keywords and unsupported dialects rather than losing constraints", () => {
    expect(() =>
      buildCatalog(fixture({ type: "string", madeUpConstraint: true })),
    ).toThrow();
    expect(() => buildCatalog({ ...fixture(), openapi: "3.0.3" })).toThrow(
      /dialect|version/i,
    );
    expect(() =>
      buildCatalog({
        ...fixture(),
        jsonSchemaDialect: "https://example.com/schema",
      }),
    ).toThrow(/dialect/i);
  });

  it.each([
    { style: "deepObject" },
    { explode: false },
    { allowReserved: true },
    { content: { "application/json": {} } },
    { in: "header" },
    { schema: { type: "object", properties: { name: { type: "string" } } } },
  ])("rejects unsupported parameter serialization %j", (patch) => {
    const document = fixture();
    Object.assign(document.paths["/things/{id}"].post.parameters[1], patch);
    expect(() => buildCatalog(document)).toThrow(/parameter|serialization/i);
  });

  it("rejects non-JSON bodies instead of dropping them", () => {
    const document = fixture();
    Object.assign(document.paths["/things/{id}"].post.requestBody, {
      content: { "text/plain": { schema: { type: "string" } } },
    });
    expect(() => buildCatalog(document)).toThrow(/JSON/i);
  });

  it("rejects new streaming responses instead of treating them as finite tools", () => {
    const document = fixture();
    Object.assign(document.paths["/things/{id}"].post, {
      responses: {
        "200": {
          content: { "text/event-stream": { schema: { type: "string" } } },
        },
      },
    });
    expect(() => buildCatalog(document)).toThrow(/JSON|response/i);
  });

  it("rejects missing or extraneous path parameters", () => {
    const document = fixture();
    document.paths["/things/{id}"].post.parameters[0].name = "other";
    expect(() => buildCatalog(document)).toThrow(/path parameter/i);
  });

  it("rejects schema constraints that would require asynchronous validation", () => {
    expect(() =>
      buildCatalog(fixture({ $async: true, type: "string" })),
    ).toThrow(/async/i);
  });
});

describe("runtime selection", () => {
  it("selects all only when absent and uses exact OpenAPI tag names", () => {
    expect(selectOperations()).toHaveLength(102);
    expect(selectOperations("captains")).toHaveLength(5);
    const selected = selectOperations(" captains,issues,captains ");
    expect(new Set(selected.map((op) => op.group))).toEqual(
      new Set(["captains", "issues"]),
    );
    expect(new Set(selected.map((op) => op.name)).size).toBe(selected.length);
    expect(selectOperations("reviewRules").length).toBeGreaterThan(0);
  });

  it.each([
    "",
    " ",
    "captains,",
    ",issues",
    "captains,,issues",
    "unknown",
    "Captains",
    "streams",
    "tasks",
    "captains,secret-canary",
  ])("fails closed for %j without echoing configuration", (groups) => {
    expect(() => selectOperations(groups)).toThrow(
      "Invalid CAPY_TOOL_GROUPS configuration",
    );
    try {
      selectOperations(groups);
    } catch (error) {
      expect(String(error)).not.toContain("secret-canary");
    }
  });
});

describe("generated artifacts", () => {
  it("records the exact pinned snapshot digest", () => {
    expect(
      createHash("sha256")
        .update(readFileSync("api/openapi.json"))
        .digest("hex"),
    ).toBe(source.sha256);
  });

  it("uses equivalent committed standalone validators without eval or schema compilation", async () => {
    const bundled = await build({
      entryPoints: ["src/generated/validators.js"],
      bundle: true,
      format: "iife",
      globalName: "compiled",
      write: false,
      platform: "neutral",
    });
    const context = {
      compiled: undefined as
        | undefined
        | { validators: Record<string, (value: unknown) => boolean> },
    };
    runInNewContext(bundled.outputFiles[0].text, context, {
      contextCodeGeneration: { strings: false, wasm: false },
    });
    const validators = context.compiled!.validators;
    expect(Object.keys(validators)).toHaveLength(102);
    expect(
      validators.capy_threads_get({ path: { threadId: "jam_example" } }),
    ).toBe(true);
    expect(validators.capy_threads_get({ path: { threadId: 7 } })).toBe(false);
    expect(validators.capy_issues_list({ query: { status: "wrong" } })).toBe(
      false,
    );
    expect(
      validators.capy_issues_list({
        query: { stateIds: ["one", "two"], limit: 2 },
      }),
    ).toBe(true);
    const value = { query: { limit: "2" } };
    expect(validators.capy_issues_list(value)).toBe(false);
    expect(value.query.limit).toBe("2");
    const validate = validators.capy_captains_create;
    expect(
      validate({
        body: {
          requestId: "create-1",
          projectId: "project-1",
          name: "Captain",
        },
      }),
    ).toBe(true);
    expect(
      validate({
        body: {
          requestId: "create-1",
          projectId: "project-1",
          name: "Captain",
          model: { modelId: "x", unexpected: true },
        },
      }),
    ).toBe(false);
    expect(
      validators.capy_messages_send({
        path: { threadId: "jam_example" },
        body: { text: "Hello", pullRequestAuthor: null },
      }),
    ).toBe(true);
    expect(
      validators.capy_messages_send({
        path: { threadId: "jam_example" },
        body: { text: "Hello", pullRequestAuthor: "wrong" },
      }),
    ).toBe(false);
    const generated = JSON.parse(
      readFileSync("src/generated/catalog.json", "utf8"),
    );
    expect(generated).toEqual(buildCatalog(snapshot));
    const check = spawnSync("npm", ["run", "generate:check"], {
      encoding: "utf8",
    });
    expect(check.status, check.stdout + check.stderr).toBe(0);
  }, 30_000);

  it("detects artifact and digest drift in check mode without modifying files", () => {
    const directory = mkdtempSync(join(tmpdir(), "capy-catalog-"));
    try {
      for (const path of ["package.json", "api", "scripts", "src/generated"])
        cpSync(path, join(directory, path), { recursive: true });
      symlinkSync(resolve("node_modules"), join(directory, "node_modules"));
      const artifact = join(directory, "src/generated/catalog.json");
      const changed = readFileSync(artifact, "utf8") + "\n";
      writeFileSync(artifact, changed);
      const drift = spawnSync("npm", ["run", "generate:check"], {
        cwd: directory,
        encoding: "utf8",
      });
      expect(drift.status).not.toBe(0);
      expect(drift.stderr).toContain("Generated artifact differs");
      expect(readFileSync(artifact, "utf8")).toBe(changed);
      execFileSync("npm", ["run", "generate"], {
        cwd: directory,
        stdio: "pipe",
      });
      expect(
        spawnSync("npm", ["run", "generate:check"], { cwd: directory }).status,
      ).toBe(0);
      const snapshotPath = join(directory, "api/openapi.json");
      writeFileSync(snapshotPath, readFileSync(snapshotPath, "utf8") + "\n");
      const digestDrift = spawnSync("npm", ["run", "generate:check"], {
        cwd: directory,
        encoding: "utf8",
      });
      expect(digestDrift.status).not.toBe(0);
      expect(digestDrift.stderr).toContain("source digest mismatch");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("refreshes only an explicitly fetched valid snapshot and records its bytes and metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "capy-refresh-"));
    try {
      for (const path of ["package.json", "api", "scripts"])
        cpSync(path, join(directory, path), { recursive: true });
      symlinkSync(resolve("node_modules"), join(directory, "node_modules"));
      const candidate = JSON.stringify(fixture());
      writeFileSync(join(directory, "candidate.json"), candidate);
      writeFileSync(
        join(directory, "fetch.mjs"),
        'import { readFileSync } from "node:fs"; globalThis.fetch = async () => new Response(readFileSync(new URL("./candidate.json", import.meta.url)));',
      );
      const run = () =>
        spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--import",
            "./fetch.mjs",
            "scripts/refresh-api.ts",
          ],
          { cwd: directory, encoding: "utf8" },
        );
      const refreshed = run();
      expect(refreshed.status, refreshed.stdout + refreshed.stderr).toBe(0);
      expect(readFileSync(join(directory, "api/openapi.json"), "utf8")).toBe(
        candidate,
      );
      const metadata = JSON.parse(
        readFileSync(join(directory, "api/source.json"), "utf8"),
      );
      expect(metadata.url).toBe("https://docs.capy.ai/openapi.json");
      expect(metadata.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(metadata.sha256).toBe(
        createHash("sha256").update(candidate).digest("hex"),
      );
      writeFileSync(
        join(directory, "candidate.json"),
        JSON.stringify(fixture({ type: "string", unsupportedConstraint: 1 })),
      );
      expect(run().status).not.toBe(0);
      expect(readFileSync(join(directory, "api/openapi.json"), "utf8")).toBe(
        candidate,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
