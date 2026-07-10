import mongoose, { Document, Schema } from 'mongoose';

/**
 * A long-lived authorization grant between an MCP client (e.g. Claude, ChatGPT)
 * and a Mention user, established through the MCP OAuth flow
 * (`src/mcp/routes/mcpOAuth.routes.ts`).
 *
 * ONE document = one active connection = one refresh-token family. The
 * refresh token itself is never stored — only its SHA-256 hash
 * (`refreshTokenHash`). `jti` is the current token-family id embedded in the
 * access tokens minted for this connection; it rotates on every refresh and is
 * added to the Redis revocation blocklist (`mcp:revoked:<jti>`) when the
 * connection is revoked or rotated, so previously-issued access tokens stop
 * validating in `middleware/mcpAuth.ts` before their natural expiry.
 */
export interface IMcpConnection extends Document {
  oxyUserId: string;
  clientId: string;
  clientLabel: string;
  scopes: string[];
  /** Shared id for all accounts linked to the same MCP client connector. */
  bundleId: string;
  /** True only for the account whose OAuth grant Claude holds and refreshes. */
  isBundlePrimary: boolean;
  /** Active account for the bundle (stored on the primary connection row). */
  activeOxyUserId?: string | null;
  refreshTokenHash: string;
  jti: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

const McpConnectionSchema = new Schema<IMcpConnection>({
  oxyUserId: { type: String, required: true, index: true },
  clientId: { type: String, required: true },
  clientLabel: { type: String, required: true },
  scopes: { type: [String], default: [] },
  bundleId: { type: String, index: true },
  isBundlePrimary: { type: Boolean, default: false },
  activeOxyUserId: { type: String, default: null },
  // SHA-256 hex digest of the active refresh token. Unique so a refresh lookup
  // resolves exactly one connection; sparse is unnecessary (always present).
  refreshTokenHash: { type: String, required: true, unique: true },
  // Current token-family id (rotates on refresh); mirrored into access-token `jti`.
  jti: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
});

// A user's connection list is the common query; filter out revoked in the route.
McpConnectionSchema.index({ oxyUserId: 1, revokedAt: 1 });
McpConnectionSchema.index({ bundleId: 1, revokedAt: 1 });
McpConnectionSchema.index(
  { bundleId: 1, oxyUserId: 1 },
  { unique: true, partialFilterExpression: { revokedAt: null } },
);

export const McpConnection = mongoose.model<IMcpConnection>('McpConnection', McpConnectionSchema);

export default McpConnection;
