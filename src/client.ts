import type { Operation } from "./catalog.js";

export interface ToolArguments {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

type ErrorCode = "unsafe_path" | "redirect" | "http_error" | "invalid_json" | "response_too_large" | "timeout" | "cancelled" | "network_error";

export class CapyError extends Error {
  declare readonly status?: number;
  declare readonly tag?: string;
  declare readonly retryAfterSeconds?: number;

  constructor(
    readonly code: ErrorCode,
    readonly metadata: { status?: number; tag?: string; retryAfterSeconds?: number } = {},
  ) {
    super(`Capy request failed: ${code}`);
    Object.assign(this, metadata);
  }

  toJSON() {
    return { code: this.code, ...this.metadata };
  }
}

const errorTags = new Set([
  "capy/AutomationNotFound", "capy/Unauthorized", "capy/Forbidden", "capy/RateLimited",
  "capy/InvalidRequest", "capy/ProjectNotFound", "ModelSelection.Rejected",
  "capy/PaidFeatureUnavailable", "capy/ThreadNotFound", "capy/Conflict",
  "capy/ThreadOrganizationNotFound", "capy/IssueNotFound", "capy/FileNotFound",
  "capy/SubagentNotFound", "capy/TaskNotFound", "capy/DeviceAccessDenied",
  "capy/EditNotAllowed", "capy/StreamUnavailable", "capy/ReviewRefused",
  "capy/ReviewRoundNotFound", "capy/UsageUnavailable", "capy/BillingAuthorityUnavailable",
]);

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new CapyError("cancelled"));
    };
    if (signal.aborted) {
      promise.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function callCapy(
  operation: Operation,
  args: ToolArguments,
  options: { apiKey: string; signal?: AbortSignal; fetch?: typeof fetch },
): Promise<unknown> {
  const route = operation.route.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = args.path?.[name];
    if (typeof value !== "string" || value === "" || value === "." || value === "..") {
      throw new CapyError("unsafe_path");
    }
    try {
      return encodeURIComponent(value);
    } catch {
      throw new CapyError("unsafe_path");
    }
  });
  const url = new URL(route, "https://api.capy.ai");
  if (url.origin !== "https://api.capy.ai") throw new CapyError("unsafe_path");
  for (const [name, value] of Object.entries(args.query ?? {})) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(name, String(item));
    }
  }

  const deadline = new AbortController();
  const signal = deadline.signal;
  const cancel = () => deadline.abort();
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => deadline.abort(), 30_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  try {
    if (signal.aborted) throw new CapyError("cancelled");
    response = await abortable((options.fetch ?? fetch)(url, {
      method: operation.method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: "application/json",
        ...(args.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
      redirect: "manual",
      signal,
    }), signal);
    if (response.status >= 300 && response.status < 400) {
      throw new CapyError("redirect", { status: response.status });
    }
    if (Number(response.headers.get("content-length")) > 1_048_576) {
      throw new CapyError("response_too_large", { status: response.status });
    }

    reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) throw new CapyError("response_too_large", { status: response.status });
      chunks.push(value);
    }
    if (size === 0 && response.status === 200 && operation.operationId === "threads.leave") return null;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      if (response.ok) throw new CapyError("invalid_json", { status: response.status });
    }
    if (!response.ok) {
      const metadata: { status: number; tag?: string; retryAfterSeconds?: number } = { status: response.status };
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const error = data as Record<string, unknown>;
        if (typeof error._tag === "string" && errorTags.has(error._tag)) metadata.tag = error._tag;
        if (typeof error.retryAfterSeconds === "number" && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds >= 0) {
          metadata.retryAfterSeconds = error.retryAfterSeconds;
        }
      }
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter !== null && /^\d+$/.test(retryAfter) && Number.isSafeInteger(Number(retryAfter))) {
        metadata.retryAfterSeconds = Number(retryAfter);
      } else if (retryAfter !== null && /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter)) {
        const date = new Date(retryAfter);
        const seconds = Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1_000));
        if (date.toUTCString() === retryAfter && Number.isSafeInteger(seconds)) {
          metadata.retryAfterSeconds = seconds;
        }
      }
      throw new CapyError("http_error", metadata);
    }
    return data;
  } catch (error) {
    if (signal.aborted) throw new CapyError(options.signal?.aborted ? "cancelled" : "timeout");
    if (error instanceof CapyError) throw error;
    throw new CapyError("network_error");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    if (reader) {
      void reader.cancel().catch(() => {});
    } else if (response?.body) {
      void response.body.cancel().catch(() => {});
    }
  }
}
