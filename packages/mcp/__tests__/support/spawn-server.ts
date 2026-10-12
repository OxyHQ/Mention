import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface SpawnedMcpServer {
  readonly baseUrl: string;
  readonly child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  stop(): Promise<void>;
}

/** Start `server-http.ts` as its own process — one "ECS task" — on a free port. */
export async function spawnMcpServer(env: Record<string, string>): Promise<SpawnedMcpServer> {
  const child = Bun.spawn({
    cmd: [process.execPath, 'server-http.ts'],
    cwd: packageRoot,
    env: {
      ...process.env,
      MCP_PORT: '0',
      MENTION_MCP_PUBLIC_URL: 'http://127.0.0.1',
      OXY_API_URL: 'https://api.oxy.test',
      OXY_SERVICE_API_KEY: 'service-key',
      OXY_SERVICE_API_SECRET: 'service-secret',
      ...env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Drained into memory so a full stderr pipe can never stall the server.
  void new Response(child.stderr).text().catch(() => '');
  try {
    const port = await readListeningPort(child.stdout);
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      child,
      stop: async () => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await child.exited;
        }
      },
    };
  } catch (error) {
    child.kill('SIGKILL');
    await child.exited;
    throw error;
  }
}

export async function readListeningPort(stdout: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = '';
  const deadline = Date.now() + 10_000;

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        delay(remaining).then(() => {
          throw new Error(`MCP server did not start. Output: ${output}`);
        }),
      ]);
      if (result.done) {
        throw new Error(`MCP server exited before listening. Output: ${output}`);
      }
      output += decoder.decode(result.value, { stream: true });
      const match = /Listening on :(\d+)/.exec(output);
      if (match) return Number(match[1]);
    }
  } finally {
    // Keep draining in the background so a chatty server never blocks on a
    // full stdout pipe once the test stops reading.
    void (async () => {
      try {
        while (!(await reader.read()).done) {
          /* discard */
        }
      } catch {
        /* the process was killed */
      }
    })();
  }

  throw new Error(`MCP server did not report a listening port. Output: ${output}`);
}

export async function waitForExit(
  child: Bun.Subprocess<'ignore' | 'pipe', 'ignore' | 'pipe', 'inherit' | 'pipe'>,
): Promise<number> {
  return Promise.race([
    child.exited,
    delay(10_000).then(() => {
      child.kill('SIGKILL');
      throw new Error('MCP server did not terminate after SIGTERM');
    }),
  ]);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
