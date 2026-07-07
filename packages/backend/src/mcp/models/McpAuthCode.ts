import mongoose, { Document, Schema } from 'mongoose';

/**
 * A short-lived OAuth 2.0 authorization code issued by `POST /mcp/oauth/approve`
 * (after the user consents while authenticated with Oxy) and redeemed exactly
 * once at `POST /mcp/oauth/token` with the matching PKCE `code_verifier`.
 *
 * Codes are single-use (`usedAt` is stamped on redemption) and expire quickly
 * (`expiresAt`, TTL-indexed so Mongo reaps stale codes automatically). The
 * stored `codeChallenge` is the PKCE S256 challenge; the token endpoint verifies
 * `base64url(sha256(code_verifier)) === codeChallenge`.
 */
export interface IMcpAuthCode extends Document {
  code: string;
  clientId: string;
  oxyUserId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

const McpAuthCodeSchema = new Schema<IMcpAuthCode>({
  code: { type: String, required: true, unique: true },
  clientId: { type: String, required: true },
  oxyUserId: { type: String, required: true },
  redirectUri: { type: String, required: true },
  // PKCE S256 challenge (base64url). Only S256 is accepted by the token endpoint.
  codeChallenge: { type: String, required: true },
  scopes: { type: [String], default: [] },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

// TTL index: Mongo deletes codes at `expiresAt` (belt-and-braces alongside the
// explicit expiry check in the token endpoint).
McpAuthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const McpAuthCode = mongoose.model<IMcpAuthCode>('McpAuthCode', McpAuthCodeSchema);

export default McpAuthCode;
