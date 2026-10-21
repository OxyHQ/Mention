/**
 * Keep an idle legacy SSE stream (`GET /sse`) open through the proxies in front
 * of this server.
 *
 * The AWS ALB closes a connection that carries no bytes for 60 s, and
 * Cloudflare one that carries none for 100 s. The SDK's `SSEServerTransport`
 * writes only when a message goes out, so a session whose client was simply
 * thinking died there and the client had to reconnect. An SSE comment line
 * (`: …`) is ignored by every EventSource parser, and the transport writes each
 * event in one `write` call, so a comment can never land inside an event.
 */
export const SSE_KEEP_ALIVE_INTERVAL_MS = 25_000;

export interface SseKeepAliveTarget {
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
  write(chunk: string): boolean;
  once(event: 'close', listener: () => void): unknown;
}

/** Write `: keep-alive` every `intervalMs` until the response closes. */
export function startSseKeepAlive(
  res: SseKeepAliveTarget,
  intervalMs: number = SSE_KEEP_ALIVE_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    res.write(': keep-alive\n\n');
  }, intervalMs);
  // A shutdown waits for the server to close, never for this timer.
  timer.unref?.();
  const stop = () => clearInterval(timer);
  res.once('close', stop);
  return stop;
}
