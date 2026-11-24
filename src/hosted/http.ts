export class BodyLimitError extends Error {}

export async function boundedBody(message: Request | Response, byteLimit: number, signal: AbortSignal) {
  if (!message.body) return new Uint8Array();
  const reader = message.body.getReader();
  const stop = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", stop, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(message.headers.get("Content-Length")) > byteLimit) throw new BodyLimitError();
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > byteLimit) throw new BodyLimitError();
      chunks.push(chunk.value);
    }
  } catch (error) {
    stop();
    throw error;
  } finally {
    signal.removeEventListener("abort", stop);
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    result.set(chunk, at);
    at += chunk.byteLength;
  }
  return result;
}
