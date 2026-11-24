import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { inject } from "vitest";

declare module "vitest" {
  interface ProvidedContext {
    hostedMigrations: D1Migration[];
  }
}

export async function resetHostedDb() {
  await applyD1Migrations(env.DB, inject("hostedMigrations"));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM login_transactions"),
    env.DB.prepare("DELETE FROM accounts"),
  ]);
}
