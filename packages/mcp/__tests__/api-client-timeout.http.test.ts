import { expect, test } from 'bun:test';
import { createServer } from 'node:http';

for (const method of ['get', 'post']) {
  for (const status of [200, 400]) {
    test(`${method} bounds a stalled HTTP ${status} body and releases its connections`, async () => {
      let requests = 0;
      let closedResponses = 0;
      const server = createServer((_request, response) => {
        requests++;
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.flushHeaders();
        response.write('{');
        // Complete eventually so the broken implementation fails with a result,
        // rather than leaving a test process waiting forever.
        const finish = setTimeout(() => response.end('"ok":true}'), 1_000);
        response.on('close', () => {
          clearTimeout(finish);
          closedResponses++;
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing test server port');
      const clientUrl = new URL('../lib/api-client.ts', import.meta.url).href;
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          '--eval',
          `import { api } from ${JSON.stringify(clientUrl)};
          try { process.stdout.write(JSON.stringify(await api.${method}('/stall'))); }
          catch (error) { process.stdout.write(JSON.stringify(error)); }`,
        ],
        env: {
          ...process.env,
          MENTION_API_URL: `http://127.0.0.1:${address.port}`,
          MENTION_API_TIMEOUT_MS: '100',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      try {
        const [output, errors, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(errors).toBe('');
        expect(exitCode).toBe(0);
        expect(JSON.parse(output)).toMatchObject({
          status: 504,
          message: 'Mention API timed out after 100ms.',
        });
        expect(requests).toBe(method === 'get' ? 2 : 1);
        expect(closedResponses).toBe(requests);
      } finally {
        if (child.exitCode === null) {
          child.kill();
          await child.exited;
        }
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
}
