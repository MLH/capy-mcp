import { afterEach, describe, expect, it, vi } from "vitest";
import { callCapy } from "../src/client.js";
import { selectOperations } from "../src/catalog.js";

const operation = (id: string) => selectOperations().find((item) => item.operationId === id)!;
const apiKey = "test-api-key-never-echo";
const secret = "private request text";
const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), init);

afterEach(() => vi.useRealTimers());

describe("Capy client requests", () => {
  it("encodes IDs without injecting route, query, or fragment segments", async () => {
    let requested = "";
    await callCapy(operation("threads.get"), { path: { threadId: "a/b ?#%\\c" } }, {
      apiKey,
      fetch: async (url) => { requested = String(url); return json({}); },
    });
    expect(requested).toBe("https://api.capy.ai/api/v1/threads/a%2Fb%20%3F%23%25%5Cc");
  });

  it("encodes repeated query values and preserves zero, false, and empty strings", async () => {
    let requested = "";
    await callCapy(operation("issues.list"), { query: { stateIds: ["a b", "c&d"], limit: 0, hasPullRequest: false, search: "", cursor: "1:24" } }, {
      apiKey,
      fetch: async (url) => { requested = String(url); return json({}); },
    });
    expect(requested).toBe("https://api.capy.ai/api/v1/issues?stateIds=a+b&stateIds=c%26d&limit=0&hasPullRequest=false&search=&cursor=1%3A24");
  });

  it("preserves the JSON body and separates trusted headers from arguments", async () => {
    let init: RequestInit | undefined;
    const body = { dueAt: null, enabled: false, count: 0, title: "", nested: { key: secret }, apiKey: "not-a-header" };
    await callCapy(operation("issues.update"), { path: { code: "CAP-1" }, body }, {
      apiKey,
      fetch: async (_url, options) => { init = options; return json({}); },
    });
    expect(JSON.parse(String(init?.body))).toEqual(body);
    expect(init?.method).toBe("PATCH");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${apiKey}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect([...headers.keys()].sort()).toEqual(["accept", "authorization", "content-type"]);
    expect(init?.redirect).toBe("manual");
  });

  it.each([".", "..", ""])('rejects unsafe path value "%s" before fetch', async (threadId) => {
    let calls = 0;
    const result = callCapy(operation("threads.get"), { path: { threadId } }, {
      apiKey, fetch: async () => { calls++; return json({}); },
    });
    await expect(result).rejects.toMatchObject({ code: "unsafe_path" });
    expect(calls).toBe(0);
  });

  it("encodes percent-encoded dot segments as literal ID data", async () => {
    let requested = "";
    await callCapy(operation("threads.get"), { path: { threadId: "%2e%2e" } }, {
      apiKey, fetch: async (url) => { requested = String(url); return json({}); },
    });
    expect(requested).toBe("https://api.capy.ai/api/v1/threads/%252e%252e");
  });

  it("rejects an invalid Unicode path value with a sanitized error", async () => {
    await expect(callCapy(operation("threads.get"), { path: { threadId: "\ud800" } }, {
      apiKey, fetch: async () => json({}),
    })).rejects.toMatchObject({ code: "unsafe_path" });
  });

  it.each(["https://evil.example/steal", "//evil.example/steal"])('never sends credentials outside the fixed origin for route "%s"', async (route) => {
    let calls = 0;
    await expect(callCapy({ ...operation("issues.list"), route }, {}, {
      apiKey, fetch: async () => { calls++; return json({}); },
    })).rejects.toMatchObject({ code: "unsafe_path" });
    expect(calls).toBe(0);
  });

  it("returns pagination untouched without fetching another page", async () => {
    let calls = 0;
    const page = { issues: [{ code: "CAP-1" }], nextCursor: "1:24", hasMore: true };
    const result = await callCapy(operation("issues.list"), {}, { apiKey, fetch: async () => { calls++; return json(page); } });
    expect(result).toEqual(page);
    expect(calls).toBe(1);
  });

  it("normalizes the explicitly bodyless threads.leave HTTP 200 success to null", async () => {
    await expect(callCapy(operation("threads.leave"), { path: { threadId: "jam_1" } }, {
      apiKey, fetch: async () => new Response(null, { status: 200 }),
    })).resolves.toBeNull();
  });

  it("keeps an empty success from a JSON-declaring operation as invalid JSON", async () => {
    await expect(callCapy(operation("issues.list"), {}, {
      apiKey, fetch: async () => new Response(null, { status: 200 }),
    })).rejects.toMatchObject({ code: "invalid_json", status: 200 });
  });

  it("does not normalize an empty threads.leave failure to success", async () => {
    await expect(callCapy(operation("threads.leave"), { path: { threadId: "jam_1" } }, {
      apiKey, fetch: async () => new Response(null, { status: 403 }),
    })).rejects.toMatchObject({ code: "http_error", status: 403 });
  });

  it("does not normalize a nonempty malformed threads.leave success", async () => {
    await expect(callCapy(operation("threads.leave"), { path: { threadId: "jam_1" } }, {
      apiKey, fetch: async () => new Response("not JSON", { status: 200 }),
    })).rejects.toMatchObject({ code: "invalid_json", status: 200 });
  });

  it.each([301, 302, 303, 307, 308])("refuses redirect status %s without following it", async (status) => {
    let calls = 0;
    await expect(callCapy(operation("issues.list"), {}, {
      apiKey, fetch: async (_url, init) => {
        calls++;
        expect(init?.redirect).toBe("manual");
        return new Response(null, { status, headers: { location: "https://evil.example" } });
      },
    })).rejects.toMatchObject({ code: "redirect", status });
    expect(calls).toBe(1);
  });
});

describe("Capy client failures", () => {
  it("returns only safe structured API metadata, never echoed prose", async () => {
    const error = await callCapy(operation("issues.create"), { body: { title: secret } }, {
      apiKey, fetch: async () => json({ _tag: "capy/InvalidRequest", message: `${apiKey} ${secret}`, body: { secret } }, { status: 400 }),
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "http_error", status: 400, tag: "capy/InvalidRequest" });
    expect(String(error)).not.toContain(apiKey);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(apiKey);
  });

  it("exposes numeric 429 retry guidance without retrying a mutation", async () => {
    let calls = 0;
    const error = await callCapy(operation("captains.create"), { body: {} }, {
      apiKey, fetch: async () => { calls++; return json({ _tag: "capy/RateLimited", retryAfterSeconds: 12 }, { status: 429, headers: { "retry-after": "15" } }); },
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "http_error", status: 429, tag: "capy/RateLimited", retryAfterSeconds: 15 });
    expect(calls).toBe(1);
  });

  it("uses the structured retry delay when the header is absent", async () => {
    await expect(callCapy(operation("issues.list"), {}, {
      apiKey, fetch: async () => json({ _tag: "capy/RateLimited", retryAfterSeconds: 12 }, { status: 429 }),
    })).rejects.toMatchObject({ retryAfterSeconds: 12 });
  });

  it.each([
    ["Wed, 04 Nov 2026 23:59:00 GMT", 60],
    ["Wed, 04 Nov 2026 23:57:00 GMT", 0],
    ["Thu, 04 Nov 2026 23:59:00 GMT", 12],
    ["Mon, 30 Feb 2026 23:59:00 GMT", 12],
    ["2026-11-04T23:59:00Z", 12],
    ["Wed, 04 Nov 2026 23:59:00 GMT private data", 12],
    ["not a date", 12],
  ])("sanitizes HTTP-date retry guidance %s without retrying a mutation", async (header, seconds) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T23:58:00.250Z"));
    let calls = 0;
    const error = await callCapy(operation("captains.create"), { body: {} }, {
      apiKey, fetch: async () => {
        calls++;
        return json({ retryAfterSeconds: 12 }, { status: 429, headers: { "retry-after": header } });
      },
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "http_error", status: 429, retryAfterSeconds: seconds });
    expect(JSON.stringify(error)).not.toContain(header);
    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves HTTP status and retry guidance when an upstream error is not JSON", async () => {
    const error = await callCapy(operation("issues.list"), {}, {
      apiKey, fetch: async () => new Response(`${apiKey} ${secret}`, { status: 429, headers: { "retry-after": "10" } }),
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "http_error", status: 429, retryAfterSeconds: 10 });
    expect(String(error)).not.toContain(apiKey);
    expect(String(error)).not.toContain(secret);
  });

  it("drops untrusted tags and retry metadata rather than echoing request data", async () => {
    const error = await callCapy(operation("issues.list"), {}, {
      apiKey, fetch: async () => json({ _tag: apiKey, retryAfterSeconds: secret }, { status: 429, headers: { "retry-after": secret } }),
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "http_error", status: 429 });
    expect(error).not.toHaveProperty("tag");
    expect(error).not.toHaveProperty("retryAfterSeconds");
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(apiKey);
  });

  it("sanitizes invalid JSON and does not include parser exception text", async () => {
    const error = await callCapy(operation("issues.list"), {}, { apiKey, fetch: async () => new Response(`${apiKey} ${secret}`) }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "invalid_json" });
    expect(String(error)).not.toContain(apiKey);
    expect(String(error)).not.toContain(secret);
  });

  it("sanitizes network exceptions and never retries", async () => {
    let calls = 0;
    const error = await callCapy(operation("captains.create"), { body: { brief: secret } }, {
      apiKey, fetch: async () => { calls++; throw new Error(`${apiKey} ${secret}`); },
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "network_error" });
    expect(String(error)).not.toContain(apiKey);
    expect(String(error)).not.toContain(secret);
    expect(calls).toBe(1);
  });

  it("rejects pre-cancellation without sending a request or leaking its reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error(secret));
    let calls = 0;
    const error = await callCapy(operation("issues.list"), {}, {
      apiKey, signal: controller.signal, fetch: async () => { calls++; return json({}); },
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "cancelled" });
    expect(String(error)).not.toContain(secret);
    expect(calls).toBe(0);
  });

  it.each(["headers", "body"])('cancels stalled %s and propagates the abort signal', async (phase) => {
    const controller = new AbortController();
    let signal: AbortSignal | null | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const pending = callCapy(operation("issues.list"), {}, {
      apiKey, signal: controller.signal,
      fetch: async (_url, init) => {
        signal = init?.signal;
        started();
        return phase === "headers" ? new Promise<Response>(() => {}) : new Response(new ReadableStream());
      },
    }).catch((error: unknown) => error);
    await ready;
    controller.abort(new Error(secret));
    const error = await pending;
    expect(error).toMatchObject({ code: "cancelled" });
    expect(signal?.aborted).toBe(true);
    expect(String(error)).not.toContain(secret);
  });

  it.each(["headers", "body"])('applies the 30-second deadline to stalled %s', async (phase) => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const pending = callCapy(operation("issues.list"), {}, {
      apiKey, fetch: async (_url, init) => {
        signal = init?.signal;
        return phase === "headers" ? new Promise<Response>(() => {}) : new Response(new ReadableStream());
      },
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ code: "timeout" });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one deadline across headers and response body", async () => {
    vi.useFakeTimers();
    const pending = callCapy(operation("issues.list"), {}, {
      apiKey, fetch: () => new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response(new ReadableStream())), 20_000);
      }),
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ code: "timeout" });
  });

  it("rejects oversized chunked bytes explicitly and cancels the reader", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(600_000)); controller.enqueue(new Uint8Array(600_000)); },
      cancel() { cancelled = true; },
    });
    await expect(callCapy(operation("issues.list"), {}, { apiKey, fetch: async () => new Response(stream) })).rejects.toMatchObject({ code: "response_too_large" });
    expect(cancelled).toBe(true);
  });

  it("accepts a JSON response exactly at the 1 MiB byte boundary", async () => {
    const value = "a".repeat(1_048_574);
    await expect(callCapy(operation("issues.list"), {}, { apiKey, fetch: async () => json(value) })).resolves.toBe(value);
  });

  it("refuses an oversized declared body without waiting for its bytes", async () => {
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } });
    await expect(callCapy(operation("issues.list"), {}, {
      apiKey, fetch: async () => new Response(stream, { headers: { "content-length": "1048577" } }),
    })).rejects.toMatchObject({ code: "response_too_large" });
    expect(cancelled).toBe(true);
  });

  it("does not trust an understated content length", async () => {
    await expect(callCapy(operation("issues.list"), {}, {
      apiKey, fetch: async () => json("a".repeat(1_048_576), { headers: { "content-length": "1" } }),
    })).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("clears the deadline after success rather than aborting a completed request", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    await callCapy(operation("issues.list"), {}, {
      apiKey, fetch: async (_url, init) => { signal = init?.signal; return json({}); },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes the abort listener even when cancelled fetch never settles", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | null | undefined;
    let remove: ReturnType<typeof vi.spyOn> | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const pending = callCapy(operation("issues.list"), {}, {
      apiKey, signal: controller.signal,
      fetch: async (_url, init) => {
        signal = init?.signal;
        remove = vi.spyOn(signal!, "removeEventListener");
        started();
        return new Promise<Response>(() => {});
      },
    });
    await ready;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    remove?.mockRestore();
  });
});
