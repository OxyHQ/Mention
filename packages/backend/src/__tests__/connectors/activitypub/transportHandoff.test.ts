import { describe, expect, it } from 'vitest';
import { belongsToTransport } from '../../../connectors/activitypub/transportHandoff';
import { mirrorPostTime } from '../../../utils/federation/mirrorTransports';

const H = new Date('2026-03-01T12:00:00.000Z');
const before = new Date(H.getTime() - 1);

describe('the transport handoff', () => {
  it('gives every post written before the handoff to the keyless transport, and the rest to the keyed one', () => {
    const post = (keyed: boolean, time: Date, isReply = false) => ({ keyed, time, isReply });
    const handoff = { at: H };
    // Before H: the keyless copy is kept, the keyed copy is not — never both.
    expect(belongsToTransport(post(false, before), handoff)).toBe(true);
    expect(belongsToTransport(post(true, before), handoff)).toBe(false);
    // From H on: the keyed copy only.
    expect(belongsToTransport(post(false, H), handoff)).toBe(false);
    expect(belongsToTransport(post(true, H), handoff)).toBe(true);
    // Replies are the keyed transport's whatever their time; the keyless one carries none.
    expect(belongsToTransport(post(true, before, true), handoff)).toBe(true);
    expect(belongsToTransport(post(false, before, true), handoff)).toBe(false);
    // No keyless history when the keyed follow was accepted: the keyed transport takes all.
    expect(belongsToTransport(post(false, before), { at: null })).toBe(false);
    expect(belongsToTransport(post(true, before), { at: null })).toBe(true);
    // No keyed subscription yet: both are sources.
    expect(belongsToTransport(post(false, H), undefined)).toBe(true);
  });

  it('reads a keyed post time off its id', () => {
    // 2^22 → one millisecond after the snowflake epoch.
    expect(mirrorPostTime('https://bird.makeup/users/someone/statuses/4194304')?.getTime()).toBe(
      1288834974658,
    );
    expect(mirrorPostTime('https://mastox.eu/users/someone/statuses/4194304')).toBeUndefined();
  });
});
