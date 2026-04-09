import { describe, it, expect } from 'vitest';
import { ChronoCursor } from '../mtn/feed/CursorBuilder';

describe('ChronoCursor', () => {
  it('builds and parses id-only cursor', () => {
    const id = '65fdc8c8c8c8c8c8c8c8c8c8';
    const cursor = ChronoCursor.build(id);
    const parsed = ChronoCursor.parse(cursor);
    expect(parsed?.id.toString()).toBe(id);
    expect(parsed?.ts).toBeUndefined();
  });

  it('builds and parses id+timestamp cursor', () => {
    const id = '65fdc8c8c8c8c8c8c8c8c8c8';
    const ts = new Date('2024-01-01T00:00:00Z');
    const cursor = ChronoCursor.build(id, ts);
    const parsed = ChronoCursor.parse(cursor);
    expect(parsed?.id.toString()).toBe(id);
    expect(parsed?.ts).toBe(ts.getTime());
  });

  it('applies $lt filters for id-only cursor', () => {
    const match: Record<string, unknown> = {};
    const id = '65fdc8c8c8c8c8c8c8c8c8c8';
    ChronoCursor.applyToQuery(match, id);
    expect(match._id).toEqual({ $lt: expect.any(Object) });
  });

  it('applies $or filters for ts + id cursor', () => {
    const match: Record<string, unknown> = {};
    const id = '65fdc8c8c8c8c8c8c8c8c8c8';
    const ts = new Date('2024-01-01T00:00:00Z');
    const cursor = ChronoCursor.build(id, ts);
    ChronoCursor.applyToQuery(match, cursor);
    expect(match.$or).toBeTruthy();
  });
});
