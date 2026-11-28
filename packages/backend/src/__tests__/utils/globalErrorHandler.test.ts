import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import express, { type ErrorRequestHandler, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from 'bun:test';
import { logger } from '../../utils/logger';
import { createError, globalErrorHandler } from '../../utils/error';

/**
 * A body-parser failure is the client's, not the server's. Production logged
 * every upload a client abandoned mid-body (`raw-body`'s `request.aborted`) as
 * an error-level "Unhandled error in request handler" and then answered it with
 * a 500 nobody could receive; an oversized or malformed body got the same 500.
 * These run the real `express.json` in front of the handler so the errors are
 * the ones the parser actually throws.
 */
function createParsingApp(onHandled?: (res: Response) => void) {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.post('/echo', (req, res) => {
    res.json(req.body);
  });
  app.get('/api-error', () => {
    throw createError(404, 'Post not found', 'NOT_FOUND');
  });
  app.get('/boom', () => {
    throw new Error('connection refused by db-1.internal');
  });
  const handler: ErrorRequestHandler = (err, req, res, next) => {
    globalErrorHandler(err, req, res, next);
    onHandled?.(res);
  };
  app.use(handler);
  return app;
}

describe('globalErrorHandler', () => {
  beforeEach(() => {
    // `logger` is a mock from bunSetup.ts; its calls carry over between tests.
    jest.clearAllMocks();
  });

  it('answers malformed JSON with a 400, without logging an error', async () => {
    const res = await request(createParsingApp())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"text": "secret draft",');

    expect(res.status).toBe(400);
    // The parser's own message would quote the body back; the client gets the
    // status text instead.
    expect(res.body).toEqual({
      success: false,
      error: { message: 'Bad Request', code: 'BAD_REQUEST' },
    });
    expect(JSON.stringify(res.body)).not.toContain('secret draft');
    expect(logger.info).toHaveBeenCalledWith(
      'Rejected an unreadable request body',
      expect.objectContaining({ status: 400, type: 'entity.parse.failed' }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('answers an oversized body with a 413', async () => {
    const res = await request(createParsingApp())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ text: 'x'.repeat(2048) }));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      success: false,
      error: { message: 'Payload Too Large', code: 'PAYLOAD_TOO_LARGE' },
    });
    expect(logger.info).toHaveBeenCalledWith(
      'Rejected an unreadable request body',
      expect.objectContaining({ status: 413, type: 'entity.too.large' }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a client that hangs up mid-body at debug and writes nothing back', async () => {
    let handled!: (res: Response) => void;
    const handledResponse = new Promise<Response>((resolve) => {
      handled = resolve;
    });
    const server = createParsingApp(handled).listen(0);
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const { port } = server.address() as AddressInfo;

      // Promise 100 bytes, send a few, and close the connection: `raw-body`
      // rejects with `request.aborted`.
      const socket = connect(port, '127.0.0.1');
      await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
      socket.write(
        'POST /echo HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"text":',
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      socket.destroy();

      const res = await handledResponse;
      expect(res.headersSent).toBe(false);
      expect(logger.debug).toHaveBeenCalledWith(
        'Client aborted the request before its body was read',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('still answers an ApiError with its own status and code', async () => {
    const res = await request(createParsingApp()).get('/api-error');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: { message: 'Post not found', code: 'NOT_FOUND' },
    });
  });

  it('still logs a server fault as an error and hides it behind a 500', async () => {
    const res = await request(createParsingApp()).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: { message: 'Internal server error', code: 'INTERNAL_ERROR' },
    });
    expect(logger.error).toHaveBeenCalledWith(
      'Unhandled error in request handler',
      expect.objectContaining({ error: 'connection refused by db-1.internal' }),
    );
  });
});
