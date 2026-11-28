/**
 * The backend suite never leaves the machine: every TCP connection that is not
 * loopback, and every DNS lookup of a name that is not, is refused at once.
 *
 * ## Why
 *
 * Tests that reached `api.oxy.so` passed on GitHub-hosted runners and timed out
 * at Vitest's 5s default on the self-hosted pool, whose outbound connections are
 * bursty and slow. None of them asserted on the network; they got there by
 * accident. A fixture without `users.lookupMany` sent hydration to the REAL
 * runtime client's per-id `users.get` fallback, and hydration's community-notes
 * read went to CrowdSource through the real workload transport, whose first act
 * is a POST to Oxy's workload challenge (bounded at 15s, not 5). A test whose
 * duration is the network's latency is not a test of the code, so the network is
 * taken away rather than waited for.
 *
 * ## How
 *
 * Refused, not hung: a socket is destroyed on the next turn of the loop with
 * `ECONNREFUSED`, and a lookup answers `ENOTFOUND`, so a fail-soft caller sees
 * an ordinary failure in microseconds instead of a handshake with the internet.
 *
 * Loud, not silent: every refusal is ALSO recorded, and the `afterEach` that
 * {@link installNetworkGuard} registers fails the test that was running with the
 * target it tried to reach. Without that, a fail-soft path (most Oxy reads
 * degrade to "absent") would swallow the refusal, and the next accidental
 * network dependency would stay invisible until the slow pool found it again.
 * The fix for a failure here is a mock at the boundary the test owns.
 *
 * Postgres (`127.0.0.1`), the in-process HTTP servers the suites start
 * (`httpTestServers.ts`) and Unix sockets are loopback and pass. A file that
 * `vi.mock`s `node:dns/promises` gets its mock, which this does not touch.
 *
 * This module must not import anything under `src/`: `__tests__/setup.ts`
 * imports it before the per-file database isolation has run, and reaching
 * `src/config` from here would freeze the wrong `DATABASE_URL` (see setup.ts).
 */
import dns from 'node:dns';
import net from 'node:net';
import { afterEach, expect } from 'vitest';

/** The process-wide state; a worker evaluates setup.ts once per test FILE. */
const STATE = Symbol.for('mention.backend.networkGuard');

interface GuardState {
  /** Targets refused since the last check. */
  refused: string[];
}

/** Whether `host` names this machine. Hostnames are never resolved to decide. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined || host === '') return true; // net's default host
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const lower = bare.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  if (net.isIPv4(lower)) return lower.startsWith('127.') || lower === '0.0.0.0';
  if (net.isIPv6(lower)) {
    if (lower === '::1' || lower === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    return mapped !== null && isLoopbackHost(mapped[1]);
  }
  return false;
}

type ConnectTarget = { path?: string | null; host?: string; port?: number | string };

/** `Socket#connect`'s overloads, reduced to where it is going. */
function connectTarget(args: unknown[]): ConnectTarget {
  // Node's own callers (net.connect, tls.connect, http.Agent, undici) pass the
  // normalized `[options, callback]` pair.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === 'object') return first as ConnectTarget;
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { path: first };
  return { port: first as number, host: typeof args[1] === 'string' ? args[1] : undefined };
}

function refusal(code: 'ECONNREFUSED' | 'ENOTFOUND', target: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `${code} ${target}: refused by the backend test network guard ` +
      '(src/__tests__/helpers/networkGuard.ts). Mock this call instead of reaching the network.',
  );
  error.code = code;
  error.syscall = code === 'ECONNREFUSED' ? 'connect' : 'getaddrinfo';
  return error;
}

function patch(state: GuardState): void {
  // Every TCP and TLS client in the process goes through this one method:
  // `fetch` (undici), `http(s).request`, and the AWS SDK's metadata probes.
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(
    this: net.Socket,
    ...args: unknown[]
  ): net.Socket {
    const target = connectTarget(args);
    // A Unix socket names a `path`; `http.Agent` passes `path: null` for TCP.
    if (typeof target.path !== 'string' && !isLoopbackHost(target.host)) {
      const label = `${target.host}:${String(target.port)}`;
      state.refused.push(label);
      const error = refusal('ECONNREFUSED', label);
      // Exactly what a real refusal looks like to the caller: the socket is
      // CONNECTING (so `http.request` queues its headers rather than failing
      // with ERR_SOCKET_CLOSED), and the error arrives on a later turn of the
      // loop (so listeners `http.request` attaches on its own nextTick hear it).
      (this as { connecting: boolean }).connecting = true;
      setImmediate(() => this.destroy(error));
      return this;
    }
    return (originalConnect as (...connectArgs: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  // Direct lookups (SSRF guards resolve before they connect). An IP literal is
  // answered without the resolver, so only a NAME is refused here.
  const refusesName = (host: unknown): host is string =>
    typeof host === 'string' && net.isIP(host) === 0 && !isLoopbackHost(host);

  const originalLookup = dns.lookup;
  (dns as { lookup: unknown }).lookup = function guardedLookup(host: unknown, ...rest: unknown[]) {
    if (refusesName(host)) {
      state.refused.push(`dns:${host}`);
      const callback = rest[rest.length - 1];
      const error = refusal('ENOTFOUND', host);
      if (typeof callback === 'function') process.nextTick(() => callback(error));
      return undefined;
    }
    return (originalLookup as (...lookupArgs: unknown[]) => unknown).call(dns, host, ...rest);
  };

  const originalPromisesLookup = dns.promises.lookup;
  (dns.promises as { lookup: unknown }).lookup = function guardedPromisesLookup(
    host: unknown,
    ...rest: unknown[]
  ) {
    if (refusesName(host)) {
      state.refused.push(`dns:${host}`);
      return Promise.reject(refusal('ENOTFOUND', host));
    }
    return (originalPromisesLookup as (...lookupArgs: unknown[]) => unknown).call(
      dns.promises,
      host,
      ...rest,
    );
  };
}

/**
 * Take (and clear) the refusals recorded since the last check, so the guard's
 * own suite can provoke one without failing itself.
 */
export function takeRefusals(): string[] {
  const holder = globalThis as typeof globalThis & { [STATE]?: GuardState };
  return holder[STATE]?.refused.splice(0) ?? [];
}

/**
 * An origin on this machine that nothing listens on, for a test that builds a
 * REAL client (and so cannot be handed a double) but must not reach the service
 * it names: every request it makes is refused by the kernel at once. The port is
 * bound and released, so it was free a moment ago rather than guessed. `https`
 * because clients that carry a credential refuse any other scheme, and nothing
 * listening means no handshake is ever attempted.
 */
export async function closedLoopbackOrigin(): Promise<string> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `https://127.0.0.1:${port}`;
}

/**
 * Install the guard (once per process) and register this FILE's per-test check.
 */
export function installNetworkGuard(): void {
  const holder = globalThis as typeof globalThis & { [STATE]?: GuardState };
  let state = holder[STATE];
  if (state === undefined) {
    state = { refused: [] };
    holder[STATE] = state;
    patch(state);
  }
  const guard = state;
  // A refusal left over from the file this worker ran before belongs to that
  // file's teardown, not to this file's first test.
  guard.refused.length = 0;

  afterEach(() => {
    const refused = guard.refused.splice(0);
    if (refused.length === 0) return;
    throw new Error(
      `${expect.getState().currentTestName ?? 'This test'} tried to reach the network ` +
        `(${[...new Set(refused)].join(', ')}). The backend suite is hermetic: mock the ` +
        'client at the boundary this test owns (see src/__tests__/helpers/networkGuard.ts).',
    );
  });
}
