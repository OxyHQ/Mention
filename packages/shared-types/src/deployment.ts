import { z } from 'zod';
import { MENTION_CAPABILITY_AUDIENCE, MENTION_MCP_RESOURCE } from './mcpCapabilities';

/** Server-only input. Never put this document in an EXPO_PUBLIC variable. */
export type DeploymentEnvironment = Readonly<Record<string, string | undefined>>;

const httpsUrl = z.string().url().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}, 'must be an HTTPS URL without credentials or a fragment');
const httpsOrigin = httpsUrl.refine((value) => {
  try {
    const url = new URL(value);
    return url.pathname === '/' && !url.search && !url.port
      && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname);
  } catch {
    return false;
  }
}, 'must be a public HTTPS DNS origin without a path, query or port')
  .transform((value) => new URL(value).origin);
const accountId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const accountIds = z.array(accountId).max(1000);

/** Only public federation is supported; private instances need a separate ACL review. */
export const managedMentionDeploymentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  tenantId: z.string().uuid(),
  mode: z.literal('public_federated'),
  publicBaseUrl: httpsOrigin,
  apiBaseUrl: httpsOrigin,
  mcpBaseUrl: httpsOrigin,
  shellBaseUrl: httpsOrigin,
  region: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  adminOxyAccountIds: accountIds.min(1),
  signup: z.discriminatedUnion('policy', [
    z.strictObject({ policy: z.literal('open') }),
    z.strictObject({ policy: z.enum(['invite', 'approval']), allowedOxyAccountIds: accountIds }),
  ]),
  branding: z.strictObject({
    name: z.string().trim().min(1).max(80),
    about: z.string().trim().max(1000),
    logoUrl: httpsUrl.optional(),
    iconUrl: httpsUrl.optional(),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    termsUrl: httpsUrl,
    contactUrl: httpsUrl,
  }),
  release: z.strictObject({
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    sourceUrl: httpsUrl,
    channel: z.enum(['stable', 'delayed', 'preview']),
  }),
}).superRefine((deployment, context) => {
  const origins = [deployment.publicBaseUrl, deployment.apiBaseUrl,
    deployment.mcpBaseUrl, deployment.shellBaseUrl];
  if (new Set(origins).size !== origins.length) {
    context.addIssue({ code: 'custom', message: 'web, API, MCP and shell must use distinct origins' });
  }
});

export type ManagedMentionDeployment = z.infer<typeof managedMentionDeploymentSchema>;

export function readManagedDeployment(environment: DeploymentEnvironment): ManagedMentionDeployment | undefined {
  const serialized = environment.MENTION_DEPLOYMENT_CONFIG;
  if (serialized === undefined) return undefined;
  if (!serialized.trim() || serialized.length > 32768) {
    throw new Error('Invalid MENTION_DEPLOYMENT_CONFIG: expected a nonempty JSON document up to 32 KiB');
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('Invalid MENTION_DEPLOYMENT_CONFIG: malformed JSON');
  }
  const result = managedMentionDeploymentSchema.safeParse(value);
  if (!result.success) {
    // Do not reflect input values (including accidentally pasted secrets) into logs.
    const paths = result.error.issues.map((issue) => issue.path.join('.') || 'document');
    throw new Error(`Invalid MENTION_DEPLOYMENT_CONFIG at ${[...new Set(paths)].join(', ')}`);
  }
  return result.data;
}

/** One manifest drives all existing backend and MCP configuration readers. */
export function withManagedDeploymentEnvironment(environment: DeploymentEnvironment): DeploymentEnvironment {
  const deployment = readManagedDeployment(environment);
  if (!deployment) return environment;
  const canonical: Record<string, string> = {
    FRONTEND_URL: deployment.publicBaseUrl,
    MENTION_FRONTEND_ORIGIN: deployment.publicBaseUrl,
    MENTION_WEB_ORIGIN: deployment.publicBaseUrl,
    MENTION_PUBLIC_API_URL: deployment.apiBaseUrl,
    MENTION_API_ORIGIN: deployment.apiBaseUrl,
    MENTION_API_URL: deployment.apiBaseUrl,
    MENTION_MCP_PUBLIC_URL: deployment.mcpBaseUrl,
    MENTION_LEGACY_OAUTH_ISSUER: deployment.apiBaseUrl,
    WEB_SHELL_ORIGIN: deployment.shellBaseUrl,
    FEDERATION_DOMAIN: new URL(deployment.publicBaseUrl).hostname,
    ACTOR_DOMAIN: new URL(deployment.publicBaseUrl).hostname,
    FEDERATION_ENABLED: 'true',
  };
  for (const [key, value] of Object.entries(canonical)) {
    const configured = environment[key];
    if (configured !== undefined && configured.replace(/\/+$/, '') !== value) {
      throw new Error(`${key} conflicts with MENTION_DEPLOYMENT_CONFIG`);
    }
  }
  return { ...environment, ...canonical };
}

export function canParticipateInDeployment(
  deployment: ManagedMentionDeployment,
  effectiveOxyAccountId: string,
): boolean {
  return deployment.signup.policy === 'open'
    || deployment.adminOxyAccountIds.includes(effectiveOxyAccountId)
    || deployment.signup.allowedOxyAccountIds.includes(effectiveOxyAccountId);
}

/** Explicit projection: no administrators, invitations, shell URL or region. */
export function publicDeploymentInfo(deployment: ManagedMentionDeployment) {
  return {
    schemaVersion: deployment.schemaVersion,
    tenantId: deployment.tenantId,
    mode: deployment.mode,
    publicBaseUrl: deployment.publicBaseUrl,
    apiBaseUrl: deployment.apiBaseUrl,
    federationDomain: new URL(deployment.publicBaseUrl).hostname,
    mcpBaseUrl: deployment.mcpBaseUrl,
    signupPolicy: deployment.signup.policy,
    branding: { ...deployment.branding },
    software: {
      name: 'Mention',
      version: deployment.release.version,
      revision: deployment.release.revision,
      sourceUrl: deployment.release.sourceUrl,
      attribution: 'Mention by Oxy',
      attributionUrl: 'https://oxy.so',
    },
  };
}

export type PublicDeploymentInfo = ReturnType<typeof publicDeploymentInfo>;

export interface McpDeploymentIdentity {
  appId: string;
  audience: string;
  resource: string;
  allowLegacyTokens: boolean;
}

/** Each managed tenant must register this application/resource with central Oxy. */
export function mcpDeploymentIdentity(environment: DeploymentEnvironment): McpDeploymentIdentity {
  const deployment = readManagedDeployment(environment);
  const resolved = withManagedDeploymentEnvironment(environment);
  if (!deployment) {
    return {
      appId: 'mention',
      audience: MENTION_CAPABILITY_AUDIENCE,
      resource: (resolved.MENTION_MCP_PUBLIC_URL ?? MENTION_MCP_RESOURCE).replace(/\/+$/, ''),
      allowLegacyTokens: true,
    };
  }
  const appId = `mention-${deployment.tenantId}`;
  return {
    appId,
    audience: `${appId}-api`,
    resource: deployment.mcpBaseUrl,
    allowLegacyTokens: false,
  };
}

/** Safe build input. Deliberately does not inherit server environment variables. */
export function frontendDeploymentEnvironment(deployment: ManagedMentionDeployment): Record<string, string> {
  return {
    EXPO_PUBLIC_API_URL: deployment.apiBaseUrl,
    EXPO_PUBLIC_API_URL_SOCKET: deployment.apiBaseUrl.replace(/^https:/, 'wss:'),
    EXPO_PUBLIC_WEB_BASE_URL: deployment.publicBaseUrl,
    EXPO_PUBLIC_OXY_AUTH_REDIRECT_URI: deployment.publicBaseUrl,
    EXPO_PUBLIC_INSTANCE_NAME: deployment.branding.name,
    EXPO_PUBLIC_INSTANCE_LOGO_URL: deployment.branding.logoUrl ?? '',
    EXPO_PUBLIC_INSTANCE_ABOUT: deployment.branding.about,
    EXPO_PUBLIC_INSTANCE_ACCENT_COLOR: deployment.branding.accentColor,
    EXPO_PUBLIC_INSTANCE_SOURCE_URL: deployment.release.sourceUrl,
    EXPO_PUBLIC_INSTANCE_REVISION: deployment.release.revision,
  };
}
