export const DELIVERY_FAILURE_LOG_BODY_BYTES = 2048;

export async function readDeliveryFailureBodyPrefix(
  res: Response,
  maxBytes = DELIVERY_FAILURE_LOG_BODY_BYTES,
): Promise<string> {
  const contentLength = Number(res.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return `<body omitted: content-length ${contentLength} exceeds ${maxBytes} bytes>`;
  }

  if (!res.body) return '';

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = maxBytes - bytesRead;
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        bytesRead += remaining;
        truncated = true;
        break;
      }

      chunks.push(value);
      bytesRead += value.byteLength;
    }

    if (bytesRead >= maxBytes) truncated = true;
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const prefix = new TextDecoder().decode(concatUint8Arrays(chunks, bytesRead));
  return truncated ? `${prefix}…<truncated>` : prefix;
}

function concatUint8Arrays(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
