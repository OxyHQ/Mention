import { config } from '../config';
import { canAuthenticateAsService } from '../runtime/serviceIdentity';
import { kaanaClient } from './kaana';
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

/**
 * Every Mention text feature (translation, summaries, topics, classification)
 * asks for the `instant` power level: Kaana picks the model of that reviewed
 * class, Oxy's grant decides who pays.
 */
export const MENTION_TEXT_POWER_LEVEL = 'instant';

/**
 * Oxy's grant for Mention's text lane refuses a request that does not bound its
 * output at or below this, so every request carries an explicit ceiling.
 */
export const MENTION_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_OUTPUT_TOKENS = 1024;

/**
 * "Has an identity Oxy accepts", not "has a key pair": in ECS the task role
 * proves what this process is and there is no pair to have (oxy ADR 0026).
 */
export function isInferenceEnabled(): boolean {
  return canAuthenticateAsService();
}

/** Send a non-streaming request to Kaana and return its text output. */
export async function inferenceChat(
  messages: InferenceChatMessage[],
  options: InferenceChatOptions,
): Promise<string> {
  if (!isInferenceEnabled()) {
    throw new Error('Kaana inference requires a complete Oxy service identity');
  }

  const response = await (await kaanaClient()).responses.create(
    {
      model: MENTION_TEXT_POWER_LEVEL,
      input: messages.map((message) => ({
        role: message.role,
        content: [{ type: 'text', text: message.content }],
      })),
      labels: { product: 'mention', feature: options.feature },
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      maxOutputTokens: Math.min(
        options.maxTokens ?? DEFAULT_OUTPUT_TOKENS,
        MENTION_MAX_OUTPUT_TOKENS,
      ),
    },
    {
      timeoutMs: config.inference.timeoutMs,
      ...(options.delegatedUserId === undefined
        ? {}
        : { onBehalfOfUserId: options.delegatedUserId }),
    },
  );
  return response.output
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content)
    .flatMap((part) => (part.type === 'text' || part.type === 'refusal' ? [part.text] : []))
    .join('');
}

/** Send a request and parse its text output as JSON. */
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
    throw new Error('Kaana inference returned invalid JSON');
  }
}
