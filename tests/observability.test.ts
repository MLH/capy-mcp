import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

it("keeps safe Worker logs while withholding credential-bearing automatic telemetry", () => {
  const config = unstable_readConfig({ config: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)) });
  expect(config.observability).toMatchObject({
    enabled: true,
    redact_query_string: true,
    logs: { enabled: true, invocation_logs: false },
    traces: { enabled: false },
  });
  expect(config.logpush).toBe(false);
});
