import generated from "./generated/catalog.json" with { type: "json" };

export type JsonSchema = Record<string, unknown>;

export interface Operation {
  name: string;
  operationId: string;
  group: string;
  method: string;
  route: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

const operations: Operation[] = generated;
const availableGroups = new Set(operations.map((operation) => operation.group));

export function selectOperations(groups?: string): Operation[] {
  if (groups === undefined) return [...operations];
  const selected = new Set(groups.split(",").map((group) => group.trim()));
  if ([...selected].some((group) => !availableGroups.has(group))) {
    throw new Error("Invalid CAPY_TOOL_GROUPS configuration");
  }
  return operations.filter((operation) => selected.has(operation.group));
}
