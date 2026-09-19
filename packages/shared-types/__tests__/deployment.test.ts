import { describe, expect, it } from 'bun:test';
import {
  canParticipateInDeployment, frontendDeploymentEnvironment, managedMentionDeploymentSchema,
  mcpDeploymentIdentity, publicDeploymentInfo, readManagedDeployment, withManagedDeploymentEnvironment,
} from '../src/deployment';
import example from './fixtures/managed-deployment.json';

const alpha = managedMentionDeploymentSchema.parse(example);
const beta = managedMentionDeploymentSchema.parse({
  ...example, tenantId: '22222222-2222-4222-8222-222222222222',
  publicBaseUrl: 'https://social.beta.example', apiBaseUrl: 'https://api.beta.example',
  mcpBaseUrl: 'https://mcp.beta.example', shellBaseUrl: 'https://shell.beta.example',
  adminOxyAccountIds: ['admin-beta'], signup: { policy: 'approval', allowedOxyAccountIds: ['member-beta'] },
});
const environment = (deployment: unknown) => ({ MENTION_DEPLOYMENT_CONFIG: JSON.stringify(deployment) });

describe('dedicated deployment configuration', () => {
  it('preserves the ordinary public deployment when no manifest is present', () => {
    const source = { NODE_ENV: 'test', MENTION_API_URL: 'https://api.mention.earth' };
    expect(readManagedDeployment(source)).toBeUndefined();
    expect(withManagedDeploymentEnvironment(source)).toBe(source);
    expect(mcpDeploymentIdentity({})).toEqual({
      appId: 'mention', audience: 'mention-api', resource: 'https://mcp.mention.earth', allowLegacyTokens: true,
    });
  });

  it('resolves two domains independently without global or request-header state', () => {
    for (const deployment of [alpha, beta]) {
      const resolved = withManagedDeploymentEnvironment(environment(deployment));
      expect(resolved.MENTION_API_URL).toBe(deployment.apiBaseUrl);
      expect(resolved.MENTION_PUBLIC_API_URL).toBe(deployment.apiBaseUrl);
      expect(resolved.MENTION_WEB_ORIGIN).toBe(deployment.publicBaseUrl);
      expect(resolved.FRONTEND_URL).toBe(deployment.publicBaseUrl);
      expect(resolved.ACTOR_DOMAIN).toBe(new URL(deployment.publicBaseUrl).hostname);
      expect(resolved.FEDERATION_DOMAIN).toBe(resolved.ACTOR_DOMAIN);
      expect(resolved.MENTION_MCP_PUBLIC_URL).toBe(deployment.mcpBaseUrl);
      expect(resolved.WEB_SHELL_ORIGIN).toBe(deployment.shellBaseUrl);
      expect(resolved.FEDERATION_ENABLED).toBe('true');
    }
  });

  it('rejects every conflicting canonical environment override', () => {
    const resolved = withManagedDeploymentEnvironment(environment(alpha));
    for (const key of Object.keys(resolved).filter((key) => key !== 'MENTION_DEPLOYMENT_CONFIG')) {
      expect(() => withManagedDeploymentEnvironment({ ...environment(alpha), [key]: 'wrong' })).toThrow(key);
    }
    expect(withManagedDeploymentEnvironment({ ...environment(alpha), FRONTEND_URL: `${alpha.publicBaseUrl}/` })
      .FRONTEND_URL).toBe(alpha.publicBaseUrl);
  });

  it.each(['http://social.alpha.example', 'https://user:secret@social.alpha.example',
    'https://social.alpha.example/path', 'https://social.alpha.example?x=1',
    'https://social.alpha.example#fragment', 'https://localhost', 'https://127.0.0.1',
    'https://social.alpha.example:8443'])('rejects unsafe canonical origin %s', (origin) => {
    expect(() => readManagedDeployment(environment({ ...example, publicBaseUrl: origin }))).toThrow();
  });

  it('rejects colliding hosts, tenant names instead of IDs, secrets and unsupported private/domain modes', () => {
    for (const invalid of [
      { ...example, apiBaseUrl: example.publicBaseUrl },
      { ...example, tenantId: 'Alpha Community' },
      { ...example, mode: 'private' },
      { ...example, signup: { policy: 'domain_restricted', domain: 'alpha.example' } },
      { ...example, databasePassword: 'never-print-this-secret' },
      { ...example, branding: { ...example.branding, apiKey: 'never-print-this-secret' } },
      { ...example, branding: { ...example.branding, logoUrl: 'never-print-this-secret' } },
    ]) {
      expect(() => readManagedDeployment(environment(invalid))).toThrow('Invalid MENTION_DEPLOYMENT_CONFIG');
      try { readManagedDeployment(environment(invalid)); } catch (error) {
        expect(String(error)).not.toContain('never-print-this-secret');
      }
    }
  });

  it('rejects blank, oversized and malformed JSON without echoing values', () => {
    for (const value of ['', ' ', '{"secret":"not-closed', 'x'.repeat(32769)]) {
      expect(() => readManagedDeployment({ MENTION_DEPLOYMENT_CONFIG: value })).toThrow();
    }
  });

  it('does not accept branding injection through URL or color properties', () => {
    expect(managedMentionDeploymentSchema.safeParse({ ...example,
      branding: { ...example.branding, logoUrl: 'javascript:alert(1)' },
    }).success).toBe(false);
    expect(managedMentionDeploymentSchema.safeParse({ ...example,
      branding: { ...example.branding, accentColor: 'red; background:url(https://attacker.example)' },
    }).success).toBe(false);
  });
});

describe('deployment admission and exposure', () => {
  it('admits only the effective account invited/approved for that deployment or its administrator', () => {
    expect(canParticipateInDeployment(alpha, 'member-alpha')).toBe(true);
    expect(canParticipateInDeployment(alpha, 'admin-alpha')).toBe(true);
    expect(canParticipateInDeployment(alpha, 'member-beta')).toBe(false);
    expect(canParticipateInDeployment(beta, 'member-alpha')).toBe(false);
    expect(canParticipateInDeployment(beta, 'member-beta')).toBe(true);
    expect(canParticipateInDeployment({ ...alpha, signup: { policy: 'open' } }, 'any-oxy-account')).toBe(true);
  });

  it('exposes branding, canonical identities and source without control-plane details', () => {
    const serialized = JSON.stringify(publicDeploymentInfo(alpha));
    for (const privateValue of ['admin-alpha', 'member-alpha', alpha.shellBaseUrl, alpha.region, 'allowedOxyAccountIds']) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(publicDeploymentInfo(alpha).software).toMatchObject({
      name: 'Mention', attribution: 'Mention by Oxy', revision: alpha.release.revision,
      sourceUrl: alpha.release.sourceUrl,
    });
  });

  it('generates frontend inputs without copying server-only configuration', () => {
    const frontend = frontendDeploymentEnvironment(alpha);
    expect(Object.keys(frontend).every((key) => key.startsWith('EXPO_PUBLIC_'))).toBe(true);
    expect(frontend.EXPO_PUBLIC_API_URL).toBe(alpha.apiBaseUrl);
    expect(frontend.EXPO_PUBLIC_API_URL_SOCKET).toBe('wss://api.alpha.example');
    expect(frontend.EXPO_PUBLIC_OXY_AUTH_REDIRECT_URI).toBe(alpha.publicBaseUrl);
    expect(frontend.EXPO_PUBLIC_INSTANCE_NAME).toBe(alpha.branding.name);
    expect(JSON.stringify(frontend)).not.toContain('admin-alpha');
    expect(JSON.stringify(frontend)).not.toContain('member-alpha');
  });

  it('assigns distinct MCP application, resource and audience and refuses legacy auth for both tenants', () => {
    const first = mcpDeploymentIdentity(environment(alpha));
    const second = mcpDeploymentIdentity(environment(beta));
    expect(first.appId).not.toBe(second.appId);
    expect(first.appId).not.toBe('mention');
    expect(first.audience).not.toBe(second.audience);
    expect(first.audience).not.toBe('mention-api');
    expect(first.resource).toBe(alpha.mcpBaseUrl);
    expect(second.resource).toBe(beta.mcpBaseUrl);
    expect(first.allowLegacyTokens).toBe(false);
    expect(second.allowLegacyTokens).toBe(false);
  });
});
