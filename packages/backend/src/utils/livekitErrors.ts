export interface LiveKitErrorMetadata {
  name?: string;
  message?: string;
  status?: number;
  code?: string;
}

export interface MappedLiveKitIngressError {
  statusCode: number;
  code: string;
  message: string;
  liveKit: LiveKitErrorMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function getLiveKitErrorMetadata(error: unknown): LiveKitErrorMetadata {
  if (!isRecord(error)) {
    return {
      message: error instanceof Error ? error.message : undefined,
    };
  }

  const asError = error instanceof Error ? error : undefined;
  return {
    name: stringFrom(error.name) ?? asError?.name,
    message: stringFrom(error.message) ?? asError?.message,
    status: numberFrom(error.status),
    code: stringFrom(error.code),
  };
}

export function isLiveKitAlreadyExistsError(error: unknown): boolean {
  const { status, code, message } = getLiveKitErrorMetadata(error);
  const normalizedCode = code?.toLowerCase().replace(/[_\s-]/g, '');
  const normalizedMessage = message?.toLowerCase() ?? '';

  return (
    status === 409 ||
    normalizedCode === 'alreadyexists' ||
    normalizedMessage.includes('already exists') ||
    normalizedMessage.includes('already in use')
  );
}

export function shouldRetryIngressAfterDeletingExisting(error: unknown): boolean {
  if (isLiveKitAlreadyExistsError(error)) {
    return true;
  }

  const { message } = getLiveKitErrorMetadata(error);
  const normalizedMessage = message?.toLowerCase() ?? '';
  return (
    normalizedMessage.includes('participant identity') &&
    (normalizedMessage.includes('exists') || normalizedMessage.includes('in use'))
  );
}

export function mapLiveKitIngressError(error: unknown): MappedLiveKitIngressError {
  const liveKit = getLiveKitErrorMetadata(error);
  const code = liveKit.code?.toLowerCase();
  const message = liveKit.message?.toLowerCase() ?? '';

  if (liveKit.status === 401 || liveKit.status === 403) {
    return {
      statusCode: 503,
      code: 'STREAM_SERVICE_AUTH_FAILED',
      message: 'Live streaming service is not ready. Please try again in a moment.',
      liveKit,
    };
  }

  if (
    liveKit.status === 400 ||
    code === 'invalid_argument' ||
    code === 'failed_precondition' ||
    message.includes('invalid url') ||
    message.includes('unsupported') ||
    message.includes('could not fetch') ||
    message.includes('not a valid') ||
    message.includes('source')
  ) {
    return {
      statusCode: 400,
      code: 'STREAM_SOURCE_REJECTED',
      message: 'LiveKit could not start from that URL. Use a direct HLS (.m3u8), Icecast, or media file URL.',
      liveKit,
    };
  }

  if (liveKit.status === 404 && message.includes('room')) {
    return {
      statusCode: 503,
      code: 'STREAM_ROOM_NOT_READY',
      message: 'Live room media transport is not ready. Please try again in a moment.',
      liveKit,
    };
  }

  if (liveKit.status && liveKit.status >= 400 && liveKit.status < 500) {
    return {
      statusCode: 400,
      code: 'STREAM_SOURCE_REJECTED',
      message: 'LiveKit could not start from that URL. Use a direct HLS (.m3u8), Icecast, or media file URL.',
      liveKit,
    };
  }

  if (liveKit.status && liveKit.status >= 500) {
    return {
      statusCode: 502,
      code: 'STREAM_SERVICE_ERROR',
      message: 'Live streaming service failed to start the stream. Please try again in a moment.',
      liveKit,
    };
  }

  return {
    statusCode: 503,
    code: 'STREAM_SERVICE_UNAVAILABLE',
    message: 'Live streaming service is unavailable. Please try again in a moment.',
    liveKit,
  };
}
