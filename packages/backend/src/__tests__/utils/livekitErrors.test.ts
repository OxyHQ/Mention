import { describe, expect, it } from 'vitest';
import {
  getLiveKitErrorMetadata,
  isLiveKitAlreadyExistsError,
  mapLiveKitIngressError,
  shouldRetryIngressAfterDeletingExisting,
} from '../../utils/livekitErrors';

describe('livekitErrors', () => {
  it('extracts LiveKit/Twirp error metadata', () => {
    const error = Object.assign(new Error('ingress not connected (redis required)'), {
      status: 500,
      code: 'internal',
    });

    expect(getLiveKitErrorMetadata(error)).toMatchObject({
      name: 'Error',
      message: 'ingress not connected (redis required)',
      status: 500,
      code: 'internal',
    });
  });

  it('maps LiveKit service failures to a stream service error', () => {
    const mapped = mapLiveKitIngressError({
      message: 'ingress not connected (redis required)',
      status: 500,
      code: 'internal',
    });

    expect(mapped).toMatchObject({
      statusCode: 502,
      code: 'STREAM_SERVICE_ERROR',
    });
  });

  it('maps invalid source failures to a client-safe source rejection', () => {
    const mapped = mapLiveKitIngressError({
      message: 'invalid url',
      status: 400,
      code: 'invalid_argument',
    });

    expect(mapped).toMatchObject({
      statusCode: 400,
      code: 'STREAM_SOURCE_REJECTED',
    });
  });

  it('maps missing room errors to room-not-ready instead of bad source', () => {
    const mapped = mapLiveKitIngressError({
      message: 'room does not exist',
      status: 404,
      code: 'not_found',
    });

    expect(mapped).toMatchObject({
      statusCode: 503,
      code: 'STREAM_ROOM_NOT_READY',
    });
  });

  it('detects ingress conflicts that should retry after deleting the existing ingress', () => {
    expect(isLiveKitAlreadyExistsError({ status: 409, message: 'already exists' })).toBe(true);
    expect(shouldRetryIngressAfterDeletingExisting({ message: 'participant identity already in use' })).toBe(true);
  });
});
