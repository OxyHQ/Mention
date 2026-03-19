import { config } from '../config';
import { logger } from './logger';

/** Whether Alia AI features are available (API key is configured). */
export const isAliaEnabled = (): boolean => Boolean(config.alia.apiKey);

interface AliaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface AliaChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

interface AliaChatResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
  }>;
}

/**
 * Send a chat completion request to the Alia API.
 * Returns the assistant's text response.
 */
export async function aliaChat(
  messages: AliaChatMessage[],
  options: AliaChatOptions = {},
): Promise<string> {
  const { model = config.alia.model, temperature, maxTokens } = options;

  if (!config.alia.apiKey) {
    throw new Error('ALIA_API_KEY environment variable is not set');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.alia.timeoutMs);

  try {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };
    if (temperature !== undefined) body.temperature = temperature;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;

    const response = await fetch(`${config.alia.apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.alia.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`Alia API error ${response.status}: ${errorBody.slice(0, 200)}`);
    }

    const data: AliaChatResponse = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (typeof content !== 'string') {
      throw new Error('Alia API returned unexpected response structure');
    }

    return content;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Send a chat completion request and parse the response as JSON.
 * Strips markdown code fences if present (common LLM behavior).
 */
export async function aliaJSON<T>(
  messages: AliaChatMessage[],
  options: AliaChatOptions = {},
): Promise<T> {
  const raw = await aliaChat(messages, options);

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    if (firstNewline !== -1) {
      cleaned = cleaned.slice(firstNewline + 1);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3).trim();
    }
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch (parseError) {
    logger.error('[Alia] Failed to parse JSON response:', { raw: raw.slice(0, 500), parseError });
    throw new Error('Alia API returned invalid JSON');
  }
}
