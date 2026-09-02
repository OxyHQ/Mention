import { z } from "zod/v4";

const DEFAULT_API_URL = "https://api.mention.earth";
const DEFAULT_MCP_PUBLIC_URL = "https://mcp.mention.earth";
const DEFAULT_OXY_API_URL = "https://api.oxy.so";
const DEFAULT_LEGACY_OAUTH_ISSUER = "https://api.mention.earth";

const apiClientEnvSchema = z.object({
  MENTION_API_URL: z.string().url().default(DEFAULT_API_URL),
  MENTION_API_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

const httpEnvSchema = z.object({
  MCP_PORT: z.coerce.number().int().min(0).max(65_535).default(3_100),
  MCP_MAX_REQUEST_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024)
    .default(1_048_576),
  MCP_MAX_SESSIONS: z.coerce.number().int().positive().max(100_000).default(1_000),
  MCP_ALLOWED_ORIGINS: z.string().optional(),
  MENTION_MCP_PUBLIC_URL: z.string().url().default(DEFAULT_MCP_PUBLIC_URL),
  OXY_API_URL: z.string().url().default(DEFAULT_OXY_API_URL),
  OXY_SERVICE_API_KEY: z.string().trim().min(1),
  OXY_SERVICE_API_SECRET: z.string().trim().min(1),
  MENTION_LEGACY_OAUTH_ISSUER: z.string().url().default(DEFAULT_LEGACY_OAUTH_ISSUER),
  MENTION_MCP_JWT_SECRET: z.string().trim().min(1),
});

const DEFAULT_CORS_ORIGINS = [
  "https://claude.ai",
  "https://www.claude.ai",
  "https://api.anthropic.com",
] as const;

export interface ApiClientConfig {
  baseUrl: string;
  requestTimeoutMs: number;
}

export interface McpHttpConfig {
  port: number;
  maxRequestBodyBytes: number;
  maxSessions: number;
  publicUrl: string;
  oxyApiUrl: string;
  oxyServiceApiKey: string;
  oxyServiceApiSecret: string;
  legacyOauthIssuer: string;
  jwtSecret: string;
  allowedOrigins: ReadonlySet<string>;
}

export function loadApiClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): ApiClientConfig {
  const parsed = parseEnvironment(apiClientEnvSchema, env, "MCP API client");
  return {
    baseUrl: stripTrailingSlashes(parsed.MENTION_API_URL),
    requestTimeoutMs: parsed.MENTION_API_TIMEOUT_MS,
  };
}

export function loadMcpHttpConfig(
  env: NodeJS.ProcessEnv = process.env,
): McpHttpConfig {
  const parsed = parseEnvironment(httpEnvSchema, env, "MCP HTTP server");
  const configuredOrigins = (parsed.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map(normalizeOrigin);

  return {
    port: parsed.MCP_PORT,
    maxRequestBodyBytes: parsed.MCP_MAX_REQUEST_BODY_BYTES,
    maxSessions: parsed.MCP_MAX_SESSIONS,
    publicUrl: stripTrailingSlashes(parsed.MENTION_MCP_PUBLIC_URL),
    oxyApiUrl: stripTrailingSlashes(parsed.OXY_API_URL),
    oxyServiceApiKey: parsed.OXY_SERVICE_API_KEY,
    oxyServiceApiSecret: parsed.OXY_SERVICE_API_SECRET,
    legacyOauthIssuer: stripTrailingSlashes(parsed.MENTION_LEGACY_OAUTH_ISSUER),
    jwtSecret: parsed.MENTION_MCP_JWT_SECRET,
    allowedOrigins: new Set([...DEFAULT_CORS_ORIGINS, ...configuredOrigins]),
  };
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== value) {
    throw new Error(
      `Invalid MCP_ALLOWED_ORIGINS entry "${value}": expected an HTTP(S) origin without a path`,
    );
  }
  return url.origin;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseEnvironment<T extends z.ZodType>(
  schema: T,
  env: NodeJS.ProcessEnv,
  label: string,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid ${label} configuration: ${details}`);
}
