export function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error("Request cancelled"));
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export class BodyTooLarge extends Error {}

export async function readBoundedBody(
  { headers, body }: Request | Response, maxBytes: number, signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(headers.get("content-length")) > maxBytes) {
    if (body) await withinDeadline(body.cancel(), signal).catch(() => {});
    throw new BodyTooLarge();
  }
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await withinDeadline(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new BodyTooLarge();
      chunks.push(value);
    }
  } catch (error) {
    await withinDeadline(reader.cancel(), signal).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
