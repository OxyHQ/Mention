import { Router, Request, Response } from 'express';
import type { OxyServices } from '@oxyhq/core';
import type { OxyAuthRequest } from '@oxyhq/core/server';
import crypto from 'crypto';
import { McpAuthCode } from '../models/McpAuthCode';
import { McpConnection } from '../models/McpConnection';
import { McpRegisteredClient } from '../models/McpRegisteredClient';
import { getMcpClientAsync, isAllowedRedirectUri } from '../config/mcpClients';
import {
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  MCP_AUTH_CODE_TTL_SECONDS,
  MCP_CONSENT_PATH,
  MCP_DEFAULT_SCOPES,
  MCP_FRONTEND_ORIGIN,
  MCP_ISSUER,
  MCP_RESOURCE_URL,
  MCP_SUPPORTED_SCOPES,
} from '../config/constants';
import {
  generateAuthCode,
  generateJti,
  generateRefreshToken,
  hashToken,
  signAccessToken,
  verifyPkceS256,
} from '../services/mcpTokenService';
import { revokeJti } from '../services/mcpRevocationService';
import { verifyLinkToken } from '../services/mcpBundleService';
import { logger } from '../../utils/logger';

/**
 * MCP OAuth 2.0 endpoints (authorization-code + PKCE S256, plus refresh_token).
 *
 * Mounted PUBLICLY at the app root, BEFORE the authenticated router — the
 * discovery document and the authorize/token endpoints must be reachable
 * without an existing session. `POST /mcp/oauth/approve` is the one exception:
 * it is guarded by `oxy.auth()` inline because it acts on behalf of the
 * signed-in user (it turns their consent into an authorization code).
 */

/** Only S256 PKCE is accepted (plain is disallowed). */
const PKCE_METHOD = 'S256';

/** First string value of a query/body field that may arrive as string | string[]. */
function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** Normalize a requested scope string to the supported, non-empty set. */
function resolveScopes(requested: string | undefined): string[] {
  const parsed = (requested ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => MCP_SUPPORTED_SCOPES.includes(s));
  const deduped = Array.from(new Set(parsed));
  return deduped.length > 0 ? deduped : [...MCP_DEFAULT_SCOPES];
}

export function createMcpOAuthRoutes(oxy: OxyServices): Router {
  const router = Router();

  // --- Discovery (RFC 8414) ---
  router.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    res.json({
      issuer: MCP_ISSUER,
      authorization_endpoint: `${MCP_ISSUER}/mcp/oauth/authorize`,
      token_endpoint: `${MCP_ISSUER}/mcp/oauth/token`,
      // RFC 7591 dynamic client registration — Claude refuses to connect
      // against a fixed client_id and requires this endpoint to be advertised.
      registration_endpoint: `${MCP_ISSUER}/mcp/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: [PKCE_METHOD],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: MCP_SUPPORTED_SCOPES,
    });
  });

  // --- Protected-resource metadata (RFC 9728) — helps MCP clients discover the AS ---
  router.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.json({
      // MUST byte-for-byte equal the URL the user enters into their client
      // (no trailing slash) — Claude rejects a mismatched resource identifier.
      resource: MCP_RESOURCE_URL,
      authorization_servers: [MCP_ISSUER],
      scopes_supported: MCP_SUPPORTED_SCOPES,
      bearer_methods_supported: ['header'],
    });
  });

  // --- Public preview for add-account link flow (no auth) ---
  router.get('/mcp/bundles/link/preview', async (req: Request, res: Response) => {
    try {
      const token = firstString(req.query.token);
      if (!token) {
        return res.status(400).json({ message: 'token is required' });
      }
      const parsed = verifyLinkToken(token);
      if (!parsed) {
        return res.status(400).json({ message: 'Invalid or expired link token' });
      }
      const primary = await McpConnection.findOne({
        bundleId: parsed.bundleId,
        isBundlePrimary: true,
        revokedAt: null,
      }).lean();
      const client = primary ? await getMcpClientAsync(primary.clientId) : null;
      return res.json({
        clientLabel: client?.label ?? primary?.clientLabel ?? parsed.clientId,
        bundleId: parsed.bundleId,
      });
    } catch (error) {
      logger.error('[McpOAuth] link preview failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(500).json({ message: 'Error previewing link' });
    }
  });

  // --- Dynamic client registration (RFC 7591) ---
  // Public clients only: no secret is issued, token_endpoint_auth_method is
  // `none`, and PKCE + the exact redirect_uri allowlist below carry the
  // security. redirect_uris MUST be HTTPS.
  router.post('/mcp/oauth/register', async (req: Request, res: Response) => {
    try {
      const rawRedirects = req.body?.redirect_uris;
      const redirectUris = Array.isArray(rawRedirects)
        ? rawRedirects.filter((uri): uri is string => typeof uri === 'string' && uri.length > 0)
        : [];

      if (redirectUris.length === 0) {
        return res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description: 'At least one redirect_uri is required',
        });
      }

      const allHttps = redirectUris.every((uri) => {
        try {
          return new URL(uri).protocol === 'https:';
        } catch {
          return false;
        }
      });
      if (!allHttps) {
        return res.status(400).json({
          error: 'invalid_redirect_uri',
          error_description: 'All redirect_uris must be valid HTTPS URLs',
        });
      }

      const requestedName = firstString(req.body?.client_name);
      const clientId = `mcp-dcr-${crypto.randomUUID()}`;
      const label = requestedName && requestedName.length <= 200 ? requestedName : 'MCP Client';

      await McpRegisteredClient.create({ clientId, redirectUris, label });

      // RFC 7591 client information response for a public client.
      return res.status(201).json({
        client_id: clientId,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: label,
      });
    } catch (error) {
      logger.error('[McpOAuth] register failed', { error: error instanceof Error ? error.message : String(error) });
      return res.status(500).json({ error: 'server_error' });
    }
  });

  // --- Authorization endpoint: bounce the user to the frontend consent screen ---
  router.get('/mcp/oauth/authorize', async (req: Request, res: Response) => {
    const responseType = firstString(req.query.response_type);
    const clientId = firstString(req.query.client_id);
    const redirectUri = firstString(req.query.redirect_uri);
    const codeChallenge = firstString(req.query.code_challenge);
    const codeChallengeMethod = firstString(req.query.code_challenge_method);
    const scope = firstString(req.query.scope);
    const state = firstString(req.query.state);

    if (responseType !== 'code') {
      return res.status(400).json({ error: 'unsupported_response_type' });
    }
    if (!(await getMcpClientAsync(clientId))) {
      return res.status(400).json({ error: 'invalid_client', message: 'Unknown client_id' });
    }
    if (!(await isAllowedRedirectUri(clientId, redirectUri))) {
      return res.status(400).json({ error: 'invalid_request', message: 'redirect_uri not allowed for this client' });
    }
    if (!codeChallenge || codeChallengeMethod !== PKCE_METHOD) {
      return res.status(400).json({ error: 'invalid_request', message: 'PKCE S256 code_challenge is required' });
    }

    const consent = new URL(`${MCP_FRONTEND_ORIGIN}${MCP_CONSENT_PATH}`);
    consent.searchParams.set('response_type', 'code');
    consent.searchParams.set('client_id', clientId as string);
    consent.searchParams.set('redirect_uri', redirectUri as string);
    consent.searchParams.set('code_challenge', codeChallenge);
    consent.searchParams.set('code_challenge_method', PKCE_METHOD);
    consent.searchParams.set('scope', resolveScopes(scope).join(' '));
    if (state) consent.searchParams.set('state', state);

    return res.redirect(302, consent.toString());
  });

  // --- Approval endpoint (Oxy auth): user consent -> authorization code ---
  router.post('/mcp/oauth/approve', oxy.auth(), async (req: OxyAuthRequest, res: Response) => {
    try {
      const oxyUserId = req.user?.id;
      if (!oxyUserId) {
        return res.status(401).json({ error: 'unauthorized' });
      }

      const clientId = firstString(req.body?.client_id);
      const redirectUri = firstString(req.body?.redirect_uri);
      const codeChallenge = firstString(req.body?.code_challenge);
      const codeChallengeMethod = firstString(req.body?.code_challenge_method);
      const scope = firstString(req.body?.scope);
      const state = firstString(req.body?.state);

      if (!(await getMcpClientAsync(clientId))) {
        return res.status(400).json({ error: 'invalid_client', message: 'Unknown client_id' });
      }
      if (!(await isAllowedRedirectUri(clientId, redirectUri))) {
        return res.status(400).json({ error: 'invalid_request', message: 'redirect_uri not allowed for this client' });
      }
      if (!codeChallenge || codeChallengeMethod !== PKCE_METHOD) {
        return res.status(400).json({ error: 'invalid_request', message: 'PKCE S256 code_challenge is required' });
      }

      const scopes = resolveScopes(scope);
      const code = generateAuthCode();
      await McpAuthCode.create({
        code,
        clientId,
        oxyUserId,
        redirectUri,
        codeChallenge,
        scopes,
        expiresAt: new Date(Date.now() + MCP_AUTH_CODE_TTL_SECONDS * 1000),
      });

      const redirect = new URL(redirectUri as string);
      redirect.searchParams.set('code', code);
      if (state) redirect.searchParams.set('state', state);

      return res.json({ redirectUrl: redirect.toString() });
    } catch (error) {
      logger.error('[McpOAuth] approve failed', { error: error instanceof Error ? error.message : String(error) });
      return res.status(500).json({ error: 'server_error' });
    }
  });

  // --- Token endpoint: authorization_code + refresh_token grants ---
  router.post('/mcp/oauth/token', async (req: Request, res: Response) => {
    try {
      const grantType = firstString(req.body?.grant_type);
      if (grantType === 'authorization_code') {
        return await handleAuthorizationCodeGrant(req, res);
      }
      if (grantType === 'refresh_token') {
        return await handleRefreshTokenGrant(req, res);
      }
      return res.status(400).json({ error: 'unsupported_grant_type' });
    } catch (error) {
      logger.error('[McpOAuth] token failed', { error: error instanceof Error ? error.message : String(error) });
      return res.status(500).json({ error: 'server_error' });
    }
  });

  return router;
}

/** authorization_code grant: redeem a code (PKCE-verified) for a token pair. */
async function handleAuthorizationCodeGrant(req: Request, res: Response): Promise<Response> {
  const code = firstString(req.body?.code);
  const clientId = firstString(req.body?.client_id);
  const redirectUri = firstString(req.body?.redirect_uri);
  const codeVerifier = firstString(req.body?.code_verifier);

  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return res.status(400).json({ error: 'invalid_request', message: 'Missing required parameters' });
  }
  const client = await getMcpClientAsync(clientId);
  if (!client) {
    return res.status(400).json({ error: 'invalid_client' });
  }

  const authCode = await McpAuthCode.findOne({ code });
  if (!authCode || authCode.usedAt || authCode.expiresAt.getTime() < Date.now()) {
    return res.status(400).json({ error: 'invalid_grant', message: 'Authorization code is invalid or expired' });
  }
  if (authCode.clientId !== clientId || authCode.redirectUri !== redirectUri) {
    return res.status(400).json({ error: 'invalid_grant', message: 'Client or redirect_uri mismatch' });
  }
  if (!verifyPkceS256(codeVerifier, authCode.codeChallenge)) {
    return res.status(400).json({ error: 'invalid_grant', message: 'PKCE verification failed' });
  }

  // Single-use: atomically stamp usedAt; if another request won the race, reject.
  const claimed = await McpAuthCode.findOneAndUpdate(
    { _id: authCode._id, usedAt: null },
    { usedAt: new Date() },
    { new: true },
  );
  if (!claimed) {
    return res.status(400).json({ error: 'invalid_grant', message: 'Authorization code already used' });
  }

  const jti = generateJti();
  const refresh = generateRefreshToken();
  const bundleId = crypto.randomUUID();
  await McpConnection.create({
    oxyUserId: authCode.oxyUserId,
    clientId,
    clientLabel: client.label,
    scopes: authCode.scopes,
    bundleId,
    isBundlePrimary: true,
    refreshTokenHash: refresh.hash,
    jti,
    lastUsedAt: new Date(),
  });

  const { setActiveAccount } = await import('../services/mcpBundleService');
  await setActiveAccount(bundleId, authCode.oxyUserId);

  const accessToken = signAccessToken({
    oxyUserId: authCode.oxyUserId,
    clientId,
    scopes: authCode.scopes,
    jti,
  });

  return res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: MCP_ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh.token,
    scope: authCode.scopes.join(' '),
  });
}

/** refresh_token grant: rotate the refresh token + mint a fresh access token. */
async function handleRefreshTokenGrant(req: Request, res: Response): Promise<Response> {
  const refreshToken = firstString(req.body?.refresh_token);
  const clientId = firstString(req.body?.client_id);

  if (!refreshToken || !clientId) {
    return res.status(400).json({ error: 'invalid_request', message: 'Missing required parameters' });
  }
  if (!(await getMcpClientAsync(clientId))) {
    return res.status(400).json({ error: 'invalid_client' });
  }

  const connection = await McpConnection.findOne({ refreshTokenHash: hashToken(refreshToken) });
  if (!connection || connection.revokedAt || connection.clientId !== clientId) {
    return res.status(400).json({ error: 'invalid_grant', message: 'Refresh token is invalid or revoked' });
  }

  // Rotate: revoke the outgoing token family, then mint a new family.
  await revokeJti(connection.jti);

  const newJti = generateJti();
  const newRefresh = generateRefreshToken();
  connection.jti = newJti;
  connection.refreshTokenHash = newRefresh.hash;
  connection.lastUsedAt = new Date();
  await connection.save();

  const accessToken = signAccessToken({
    oxyUserId: connection.oxyUserId,
    clientId,
    scopes: connection.scopes,
    jti: newJti,
  });

  return res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: MCP_ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: newRefresh.token,
    scope: connection.scopes.join(' '),
  });
}
