import { selectOperations } from "../catalog.js";
import { decodeBase64, type EncryptionConfig } from "./crypto.js";
import { isAdmissionString, isOidcSubject, MAX_ISSUER_LENGTH, type Identity } from "./store.js";

export interface HostedConfig {
  publicOrigin: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  subjects: ReadonlySet<string> | undefined;
  claim: { name: string; values: ReadonlySet<string> } | undefined;
  encryption: EncryptionConfig;
  groups: string | undefined;
  allowedOrigins: readonly string[];
}

function allowlist(value: string | undefined, valid: (item: unknown) => item is string): ReadonlySet<string> | undefined {
  if (value === undefined || value === "") return undefined;
  const entries: unknown = JSON.parse(value);
  if (!Array.isArray(entries) || !entries.every(valid)) throw new Error("Invalid allowlist");
  return new Set(entries);
}

export function parseHostedIdentityConfig(env: Env): Omit<HostedConfig, "groups" | "allowedOrigins"> {
  try {
    const origin = new URL(env.PUBLIC_ORIGIN);
    const issuer = new URL(env.OIDC_ISSUER);
    if (origin.protocol !== "https:" || origin.origin !== env.PUBLIC_ORIGIN ||
        issuer.protocol !== "https:" || issuer.username || issuer.password || /[?#]/.test(env.OIDC_ISSUER) ||
        (issuer.href !== env.OIDC_ISSUER && issuer.origin !== env.OIDC_ISSUER) ||
        env.OIDC_ISSUER.length > MAX_ISSUER_LENGTH) {
      throw new Error("Invalid hosted URL");
    }
    if (!env.OIDC_CLIENT_ID?.trim() || !env.OIDC_CLIENT_SECRET?.trim()) throw new Error("Missing OIDC client");

    const subjects = allowlist(env.OIDC_ALLOWED_SUBJECTS, isOidcSubject);
    const claimName = env.OIDC_ADMISSION_CLAIM || undefined;
    const claimValues = allowlist(env.OIDC_ALLOWED_CLAIM_VALUES, isAdmissionString);
    if (Boolean(claimName) !== Boolean(claimValues) || (!subjects && !claimValues) ||
        (claimName !== undefined && (!isAdmissionString(claimName) || claimName.trim() !== claimName))) {
      throw new Error("Invalid admission policy");
    }

    const key = decodeBase64(env.CREDENTIAL_ENCRYPTION_KEY, 32);
    const keyId = env.CREDENTIAL_ENCRYPTION_KEY_ID;
    if (key.length !== 32 || typeof keyId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) {
      throw new Error("Invalid encryption configuration");
    }

    if (typeof env.DB?.withSession !== "function" || typeof env.OAUTH_KV?.get !== "function" ||
        typeof env.AUTH_RATE_LIMITER?.limit !== "function" || typeof env.ACCOUNT_RATE_LIMITER?.limit !== "function") {
      throw new Error("Missing hosted binding");
    }
    return {
      publicOrigin: origin.origin,
      issuer: env.OIDC_ISSUER,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      subjects,
      claim: claimName && claimValues ? { name: claimName, values: claimValues } : undefined,
      encryption: { key, keyId },
    };
  } catch {
    throw new Error("Invalid hosted configuration");
  }
}

export function parseHostedConfig(env: Env): HostedConfig {
  const identity = parseHostedIdentityConfig(env);
  try {
    const groups = env.CAPY_TOOL_GROUPS;
    selectOperations(groups);
    const allowedOrigins = env.MCP_ALLOWED_ORIGINS ? env.MCP_ALLOWED_ORIGINS.split(",") : [];
    for (const value of allowedOrigins) {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol) || url.origin !== value) throw new Error("Invalid client origin");
    }
    return { ...identity, groups, allowedOrigins };
  } catch {
    throw new Error("Invalid hosted configuration");
  }
}

export function admit(identity: Identity, config: HostedConfig): boolean {
  const { subjects, claim } = config;
  if (identity.issuer !== config.issuer || !isOidcSubject(identity.subject) || (!subjects && !claim)) return false;
  if (subjects && !subjects.has(identity.subject)) return false;
  if (!claim) return true;
  if (!Object.hasOwn(identity.admissionClaims, claim.name)) return false;
  const value = identity.admissionClaims[claim.name];
  return typeof value === "string" && claim.values.has(value);
}
