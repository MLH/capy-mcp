import { Ajv2020 } from "ajv/dist/2020.js";
import { default as formats } from "ajv-formats";
import type { JsonSchema, Operation } from "../src/catalog.js";

type Schema = boolean | JsonSchema;

interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  schema?: Schema;
  description?: string;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
  content?: unknown;
  $ref?: string;
}

interface ApiOperation {
  operationId: string;
  tags: string[];
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Schema }>;
    $ref?: string;
  };
  responses?: Record<
    string,
    { content?: Record<string, unknown>; $ref?: string }
  >;
}

export interface OpenApiDocument {
  openapi: string;
  jsonSchemaDialect?: string;
  paths: Record<string, { parameters?: Parameter[]; [key: string]: unknown }>;
  components?: { schemas?: Record<string, Schema> };
}

export const excludedOperations = {
  "tasks.list": "Use subagents.list instead of this legacy alias.",
  "tasks.get": "Use subagents.get instead of this legacy alias.",
  "tasks.messages": "Use subagents.messages instead of this legacy alias.",
  "streams.thread":
    "Use threads.get and messages.list for finite JSON status and message pages.",
  "streams.subagent":
    "Use subagents.get and subagents.messages for finite JSON status and message pages.",
  "streams.task":
    "Use subagents.get and subagents.messages instead of the legacy continuous stream.",
};

export const schemaDialect = "https://json-schema.org/draft/2020-12/schema";

const normalizedPatterns = new Map([
  [String.raw`^(?:\/(?:[^~]|~[01])*)*$`, String.raw`^(?:\/(?:[^~]|~[01])*)?$`],
  [
    String.raw`^[+-]?\d*\.?\d+(?:[Ee][+-]?\d+)?$`,
    String.raw`^[+-]?(?:\d+|\d*\.\d+)(?:[Ee][+-]?\d+)?$`,
  ],
]);

export function createSchemaCompiler() {
  const compiler = new Ajv2020({
    strict: true,
    strictTypes: false,
    ownProperties: true,
    allowMatchingProperties: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    code: { source: true, esm: true },
  });
  formats.default(compiler);
  return compiler;
}

function objectSchema(
  properties: Record<string, Schema>,
  required: string[],
): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function resolveReference(
  document: OpenApiDocument,
  reference: string,
): Schema {
  if (!reference.startsWith("#/components/schemas/"))
    throw new Error(`Unsupported schema reference: ${reference}`);
  let value: unknown = document;
  for (const key of reference
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      throw new Error(`Unknown schema reference: ${reference}`);
    value = (value as Record<string, unknown>)[key];
  }
  if (
    typeof value !== "boolean" &&
    (!value || typeof value !== "object" || Array.isArray(value))
  )
    throw new Error(`Invalid schema reference: ${reference}`);
  return value as Schema;
}

function parameterShape(
  document: OpenApiDocument,
  schema: Schema,
  location: "path" | "query" | "item",
  seen = new Set<Schema>(),
): boolean {
  if (typeof schema === "boolean" || seen.has(schema)) return false;
  const visited = new Set([...seen, schema]);
  if (typeof schema.$ref === "string")
    return parameterShape(
      document,
      resolveReference(document, schema.$ref),
      location,
      visited,
    );
  if (Array.isArray(schema.anyOf))
    return schema.anyOf.every((part) =>
      parameterShape(document, part, location, visited),
    );
  if (Array.isArray(schema.oneOf))
    return schema.oneOf.every((part) =>
      parameterShape(document, part, location, visited),
    );
  if (schema.type === "string") return true;
  if (
    location !== "path" &&
    ["number", "integer", "boolean"].includes(String(schema.type))
  )
    return true;
  if (schema.type === "array" && location === "query")
    return parameterShape(document, schema.items as Schema, "item", visited);
  return false;
}

function selfContained(
  document: OpenApiDocument,
  input: JsonSchema,
): JsonSchema {
  const definitions: Record<string, Schema> = Object.create(null);
  const singleSchemas = new Set([
    "items",
    "additionalProperties",
    "unevaluatedProperties",
    "unevaluatedItems",
    "contains",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
    "contentSchema",
  ]);
  const schemaMaps = new Set([
    "properties",
    "patternProperties",
    "$defs",
    "dependentSchemas",
  ]);
  const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

  function copy(schema: Schema): Schema {
    if (typeof schema === "boolean") return schema;
    const result: JsonSchema = {};
    for (const [key, value] of Object.entries(schema)) {
      if (["$id", "$anchor", "$dynamicAnchor", "$dynamicRef"].includes(key))
        throw new Error(`Unsupported schema reference keyword: ${key}`);
      if (key === "$schema" && value !== schemaDialect)
        throw new Error("Unsupported schema dialect");
      if (key === "$ref") {
        if (typeof value !== "string")
          throw new Error("Invalid schema reference");
        resolveReference(document, value);
        const encodedName = value
          .slice("#/components/schemas/".length)
          .split("/")[0];
        const name = encodedName.replace(/~1/g, "/").replace(/~0/g, "~");
        if (!Object.hasOwn(definitions, name)) {
          definitions[name] = true;
          definitions[name] = copy(
            resolveReference(document, `#/components/schemas/${encodedName}`),
          );
        }
        result[key] = value.replace("#/components/schemas/", "#/$defs/");
      } else if (singleSchemas.has(key)) {
        result[key] = copy(value as Schema);
      } else if (schemaMaps.has(key)) {
        result[key] = Object.fromEntries(
          Object.entries(value as Record<string, Schema>).map(
            ([name, child]) => [name, copy(child)],
          ),
        );
      } else if (schemaArrays.has(key)) {
        result[key] = (value as Schema[]).map(copy);
      } else if (key === "pattern" && typeof value === "string") {
        result[key] = normalizedPatterns.get(value) ?? value;
      } else {
        result[key] = structuredClone(value);
      }
    }
    const properties = result.properties as Record<string, Schema> | undefined;
    if (properties && Object.hasOwn(properties, "__proto__")) {
      const patterns = (result.patternProperties ?? {}) as Record<string, Schema>;
      result.patternProperties = {
        ...patterns,
        "^__proto__$": Object.hasOwn(patterns, "^__proto__$")
          ? { allOf: [patterns["^__proto__$"], properties.__proto__] }
          : properties.__proto__,
      };
    }
    return result;
  }

  const result = copy(input) as JsonSchema;
  result.$schema = schemaDialect;
  if (Object.keys(definitions).length)
    result.$defs = Object.fromEntries(
      Object.keys(definitions)
        .sort()
        .map((name) => [name, definitions[name]]),
    );
  return result;
}

export function buildCatalog(document: OpenApiDocument): Operation[] {
  if (!/^3\.1\./.test(document.openapi))
    throw new Error("Unsupported OpenAPI version or schema dialect");
  if (
    document.jsonSchemaDialect &&
    document.jsonSchemaDialect !== schemaDialect
  )
    throw new Error("Unsupported schema dialect");
  const compiler = createSchemaCompiler();
  const operations: Operation[] = [];
  const names = new Set<string>();
  const methods = new Set([
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "head",
    "options",
    "trace",
  ]);

  for (const [route, path] of Object.entries(document.paths)) {
    for (const [method, raw] of Object.entries(path)) {
      if (
        method === "parameters" ||
        method === "summary" ||
        method === "description" ||
        method.startsWith("x-")
      )
        continue;
      if (!methods.has(method))
        throw new Error(`Unsupported path item: ${method}`);
      const operation = raw as ApiOperation;
      if (Object.hasOwn(excludedOperations, operation.operationId)) continue;
      if (
        !operation.operationId ||
        !/^[a-zA-Z0-9._-]+$/.test(operation.operationId)
      )
        throw new Error("Invalid operation ID");
      const name =
        "capy_" +
        operation.operationId
          .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
          .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
          .replace(/[.-]/g, "_")
          .toLowerCase();
      if (names.has(name)) throw new Error(`Tool name collision: ${name}`);
      names.add(name);
      if (operation.tags?.length !== 1)
        throw new Error(
          `Operation must have exactly one group: ${operation.operationId}`,
        );
      for (const response of Object.values(operation.responses ?? {})) {
        if (
          response.$ref ||
          Object.keys(response.content ?? {}).some(
            (mediaType) => mediaType !== "application/json",
          )
        )
          throw new Error("Unsupported non-JSON response");
      }

      const properties: Record<string, Schema> = {};
      const required: string[] = [];
      const parameters = new Map<string, Parameter>();
      for (const parameter of [
        ...(path.parameters ?? []),
        ...(operation.parameters ?? []),
      ]) {
        if (
          parameter.$ref ||
          !["path", "query"].includes(parameter.in) ||
          !parameter.schema ||
          parameter.content ||
          parameter.allowReserved
        )
          throw new Error("Unsupported parameter serialization");
        const query = parameter.in === "query";
        if (
          (parameter.style !== undefined &&
            parameter.style !== (query ? "form" : "simple")) ||
          (parameter.explode !== undefined && parameter.explode !== query) ||
          !parameterShape(document, parameter.schema, query ? "query" : "path")
        )
          throw new Error("Unsupported parameter serialization");
        if (!parameter.name || (!query && parameter.required !== true))
          throw new Error("Invalid path parameter");
        parameters.set(`${parameter.in}:${parameter.name}`, parameter);
      }
      const placeholders = new Set(
        [...route.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]),
      );
      const pathNames = new Set(
        [...parameters.values()]
          .filter((parameter) => parameter.in === "path")
          .map((parameter) => parameter.name),
      );
      if (
        placeholders.size !== pathNames.size ||
        [...placeholders].some((placeholder) => !pathNames.has(placeholder))
      )
        throw new Error("Route does not match declared path parameters");
      for (const location of ["path", "query"]) {
        const fields: Record<string, Schema> = Object.create(null);
        const requiredFields: string[] = [];
        for (const parameter of parameters.values()) {
          if (parameter.in !== location) continue;
          fields[parameter.name] = parameter.description
            ? {
                ...(parameter.schema as JsonSchema),
                description: parameter.description,
              }
            : parameter.schema!;
          if (parameter.required) requiredFields.push(parameter.name);
        }
        if (Object.keys(fields).length)
          properties[location] = objectSchema(fields, requiredFields);
        if (requiredFields.length) required.push(location);
      }
      if (operation.requestBody) {
        const body = operation.requestBody;
        if (
          body.$ref ||
          !body.content ||
          Object.keys(body.content).length !== 1 ||
          body.content["application/json"]?.schema === undefined
        )
          throw new Error("Unsupported non-JSON request body");
        properties.body = body.content["application/json"].schema!;
        if (body.required) required.push("body");
      }
      const inputSchema = selfContained(
        document,
        objectSchema(properties, required),
      );
      compiler.compile(inputSchema);

      const descriptions = [operation.summary, operation.description].filter(
        Boolean,
      );
      if (parameters.size)
        descriptions.push(
          "Parameters: " +
            [...parameters.values()]
              .map(
                (parameter) =>
                  `${parameter.in}.${parameter.name}${parameter.required ? " (required)" : " (optional)"}${parameter.description ? `: ${parameter.description}` : ""}`,
              )
              .join("; ") +
            ".",
        );
      if (properties.body)
        descriptions.push(
          `Pass the JSON request as body${operation.requestBody?.required ? " (required)" : " (optional)"}; see the input schema for fields and constraints.`,
        );
      const group = operation.tags[0];
      if (group === "captains")
        descriptions.push(
          "Captains use their thread ID with the message tools to send and read messages.",
        );
      if (group === "issues")
        descriptions.push(
          "Look up issue codes with issues.list; obtain state and label IDs from the corresponding issues.states and issues.labels list tools.",
        );
      if (group === "messages")
        descriptions.push(
          "Use the Captain's thread ID to message a Captain. Creation request IDs must be reused for retries; reuse messages.send body.clientKey for the same send to avoid duplicate messages.",
        );
      if (method === "post")
        descriptions.push(
          "When a creation request has a requestId, reuse that creation request ID for retries.",
        );
      const readOnly = method === "get";
      operations.push({
        name,
        operationId: operation.operationId,
        group,
        method: method.toUpperCase(),
        route,
        description: descriptions.join("\n\n"),
        inputSchema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
          idempotentHint: readOnly,
          openWorldHint: true,
        },
      });
    }
  }
  return operations.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}
