import {
  OxyInferenceClient,
  type OxyInferenceResponse,
  type OxyResponsesRequest,
} from '@oxyhq/core';
import type { InferenceMessage } from '@oxyhq/contracts';
import { config, getOxyServiceCredentials } from '../config';
import { getServiceOxyClient } from './oxyHelpers';
import { logger } from './logger';

export interface InferenceChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface InferenceChatOptions {
  feature: string;
  delegatedUserId?: string;
  temperature?: number;
  maxTokens?: number;
}

let inferenceClient: OxyInferenceClient | undefined;

function client(): OxyInferenceClient {
  inferenceClient ??= new OxyInferenceClient({
    baseURL: config.oxyApiUrl,
    credential: () => getServiceOxyClient().getServiceToken(),
  });
  return inferenceClient;
}

/**
 * Mention is an Oxy-edge caller, never a provider client. The exact opaque
 * routing-profile primary key is the product-owned target; Oxy resolves its
 * permitted concrete routes and signs `authorizedRoutes` before Kaana sees the
 * request. Mention never selects by a mutable slug, display name or ordering.
 */
export function isInferenceEnabled(): boolean {
  const credentials = getOxyServiceCredentials();
  const hasServiceIdentity = Boolean(credentials.apiKey && credentials.apiSecret);
  return Boolean(config.inference.routingProfileId && hasServiceIdentity);
}

function textFromResponse(response: OxyInferenceResponse): string {
  return response.output
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content)
    .filter((part) => part.type === 'text' || part.type === 'refusal')
    .map((part) => part.text)
    .join('');
}

/** Send a non-streaming inference request through Oxy's authenticated edge. */
export async function inferenceChat(
  messages: InferenceChatMessage[],
  options: InferenceChatOptions,
): Promise<string> {
  const routingProfileId = config.inference.routingProfileId;
  if (!isInferenceEnabled() || !routingProfileId) {
    throw new Error(
      'Oxy inference requires OXY_INFERENCE_ROUTING_PROFILE_ID and a complete Oxy service identity',
    );
  }

  const input: InferenceMessage[] = messages.map((message) => ({
    role: message.role,
    content: [{ type: 'text', text: message.content }],
  }));
  const request: OxyResponsesRequest = {
    routingProfileId,
    input,
    labels: { product: 'mention', feature: options.feature },
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { maxOutputTokens: options.maxTokens }),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.inference.timeoutMs);
  try {
    return textFromResponse(await client().respond(request, {
      signal: controller.signal,
      ...(options.delegatedUserId === undefined
        ? {}
        : { delegatedUserId: options.delegatedUserId }),
    }));
  } finally {
    clearTimeout(timeout);
  }
}

/** Send an edge request and parse its text output as JSON. */
export async function inferenceJSON<T>(
  messages: InferenceChatMessage[],
  options: InferenceChatOptions,
): Promise<T> {
  const raw = await inferenceChat(messages, options);

  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    if (firstNewline !== -1) cleaned = cleaned.slice(firstNewline + 1);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3).trim();
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    logger.error('[Inference] Failed to parse JSON response:', {
      status: 'rejected',
      code: 'invalid_json',
      responseBytes: Buffer.byteLength(raw, 'utf8'),
    });
    throw new Error('Oxy inference returned invalid JSON');
  }
}

/** Test/lifecycle hook; production keeps one connectionless client. */
export function clearInferenceClient(): void {
  inferenceClient = undefined;
}
