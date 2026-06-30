import type { IncomingMessage } from 'node:http';

/**
 * Read a Node `IncomingMessage` stream into an `ArrayBuffer`, enforcing a hard
 * byte cap. If the body exceeds `maxBytes` the stream is destroyed and an error
 * is thrown, so a hostile remote cannot make us buffer an unbounded response.
 *
 * Protocol-agnostic and shared across connectors: it is used both for bounded
 * JSON reads (e.g. WebFinger) and for bounded image reads (e.g. mirroring a
 * remote profile banner to Oxy).
 */
export async function readBoundedResponseBody(response: IncomingMessage, maxBytes: number): Promise<ArrayBuffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxBytes) {
        response.destroy(new Error('remote response exceeds size limit'));
        throw new Error('remote response exceeds size limit');
      }
      chunks.push(buffer);
    }
  } finally {
    if (!response.destroyed) response.destroy();
  }

  const body = Buffer.concat(chunks, totalBytes);
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
}
