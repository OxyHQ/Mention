import { describe, expect, it } from 'vitest';
import { stripInternalStreamFields } from '../../routes/rooms.routes';

describe('room response sanitization', () => {
  it('removes internal stream credentials from public room payloads', () => {
    const room = {
      _id: 'room-1',
      title: 'Live room',
      host: 'host-1',
      activeIngressId: 'ingress-1',
      activeStreamUrl: 'https://example.com/source.m3u8',
      rtmpUrl: 'rtmp://livekit.example/live',
      rtmpStreamKey: 'LK_sensitive_stream_key',
      streamTitle: 'Public stream title',
    };

    expect(stripInternalStreamFields(room)).toEqual({
      _id: 'room-1',
      title: 'Live room',
      host: 'host-1',
      streamTitle: 'Public stream title',
    });
  });
});
