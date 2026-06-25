import { describe, expect, it } from 'vitest';
import { readDeliveryFailureBodyPrefix } from '../../../utils/federation/deliveryFailureBody';

describe('readDeliveryFailureBodyPrefix', () => {
  it('does not read oversized bodies when content-length exceeds the cap', async () => {
    const res = {
      headers: new Headers({ 'content-length': '4096' }),
      get body(): ReadableStream<Uint8Array> {
        throw new Error('body should not be accessed for oversized responses');
      },
    } as Response;

    const prefix = await readDeliveryFailureBodyPrefix(res, 16);

    expect(prefix).toBe('<body omitted: content-length 4096 exceeds 16 bytes>');
  });

  it('streams only a bounded prefix when content-length is absent', async () => {
    const cancelCalls: unknown[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz'));
      },
      cancel(reason) {
        cancelCalls.push(reason);
      },
    });

    const res = new Response(body, { status: 500 });

    const prefix = await readDeliveryFailureBodyPrefix(res, 10);

    expect(prefix).toBe('abcdefghij…<truncated>');
    expect(cancelCalls).toHaveLength(1);
  });
});
