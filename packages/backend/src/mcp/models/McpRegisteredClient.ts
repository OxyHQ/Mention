import mongoose, { Document, Schema } from 'mongoose';

/**
 * A dynamically-registered MCP OAuth client (RFC 7591).
 *
 * Some MCP clients (notably Claude) require the authorization server to expose
 * a `registration_endpoint` and will NOT connect against a fixed, pre-shared
 * `client_id`. `POST /mcp/oauth/register` mints one of these documents: a
 * public client (no secret, `token_endpoint_auth_method: none`) whose
 * `redirectUris` are validated to be HTTPS at registration time and then
 * enforced byte-for-byte (alongside PKCE) at authorize/token time — exactly the
 * same allowlist guarantee the statically-configured clients get.
 */
export interface IMcpRegisteredClient extends Document {
  clientId: string;
  redirectUris: string[];
  label: string;
  createdAt: Date;
}

const McpRegisteredClientSchema = new Schema<IMcpRegisteredClient>({
  clientId: { type: String, required: true, unique: true },
  redirectUris: { type: [String], required: true, default: [] },
  label: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

export const McpRegisteredClient = mongoose.model<IMcpRegisteredClient>(
  'McpRegisteredClient',
  McpRegisteredClientSchema,
);

export default McpRegisteredClient;
