import { OxyServices } from "@oxy.so/core";
import { appCapabilityCatalogSchema } from "@oxy.so/contracts";
import { MENTION_CAPABILITY_CATALOG } from "./lib/mention-catalog.js";

/**
 * Describe whatever this script failed on, in one line an operator can act on.
 *
 * `String(error)` was what it used to print, and the Oxy SDK rejects with a
 * PLAIN OBJECT (`{ message, code, status }`) rather than an `Error` — so every
 * failure reached the deploy log as the literal text `[object Object]`, and the
 * post-deploy reconciliation that rolls the MCP service back was undiagnosable
 * from its own output. The status is the part that matters: a 429 is the shared
 * Oxy rate budget and a 401/403 is the service credential, and they need
 * opposite responses.
 */
export function describeRegistrationFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error !== "object" || error === null) return String(error);

  const fields = error as { message?: unknown; code?: unknown; status?: unknown; statusCode?: unknown };
  const status = typeof fields.status === "number"
    ? fields.status
    : (typeof fields.statusCode === "number" ? fields.statusCode : undefined);
  const parts = [
    typeof fields.message === "string" && fields.message.length > 0 ? fields.message : undefined,
    status !== undefined ? `status=${status}` : undefined,
    typeof fields.code === "string" && fields.code.length > 0 ? `code=${fields.code}` : undefined,
  ].filter((part): part is string => part !== undefined);

  // Never fall back to `[object Object]`: a shape nobody anticipated is still
  // worth its JSON, bounded so a large payload cannot flood the deploy log.
  if (parts.length === 0) {
    try {
      return JSON.stringify(error)?.slice(0, 500) ?? "unknown failure";
    } catch {
      return "unknown failure (unserializable)";
    }
  }
  return parts.join(" ");
}

const OXY_API_URL = (process.env.OXY_API_URL ?? "https://api.oxy.so").replace(/\/$/, "");

/**
 * The service credential, if this process was given one.
 *
 * It runs as a post-deploy task inside the cluster, where the task role attests
 * and no secret is needed (oxy ADR 0026) — so demanding the pair would make the
 * catalog registration the one thing that still required it, and the deploy
 * would fail after a successful rollout with a message about a variable nobody
 * intends to set again.
 */
function serviceCredentialPair(): { apiKey: string; apiSecret: string } | null {
  const apiKey = process.env.OXY_SERVICE_API_KEY?.trim();
  const apiSecret = process.env.OXY_SERVICE_API_SECRET?.trim();
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

async function main(): Promise<void> {
  const catalog = appCapabilityCatalogSchema.parse(MENTION_CAPABILITY_CATALOG);
  const oxy = new OxyServices({ baseURL: OXY_API_URL });
  const credential = serviceCredentialPair();
  // Only when there is one: with none, `getServiceToken()` attests the task
  // role, which is how this runs in the cluster.
  if (credential) oxy.configureServiceAuth(credential.apiKey, credential.apiSecret);
  const serviceToken = await oxy.getServiceToken();
  const response = await fetch(`${OXY_API_URL}/capabilities/catalogs/register`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${serviceToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ catalog, deployedAt: new Date().toISOString() }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    // The body names WHICH rejection this is (a scope the credential lacks, a
    // catalog the API refused to parse); bounded so it cannot flood the log.
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(
      `Mention capability catalog registration failed (status=${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  const body = await response.json() as { registration?: { digest?: string } };
  const digest = body.registration?.digest;
  if (!digest) throw new Error("Mention capability catalog registration returned no digest");
  process.stdout.write(`Registered Mention capability catalog ${catalog.version} (${digest})\n`);
}

/**
 * Only when this file IS the program. Importing it (the failure-description unit
 * test does) must not register a catalog or, worse, exit non-zero because the
 * importer has no service credential in its environment.
 */
if (import.meta.main) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Mention capability catalog registration failed: ${describeRegistrationFailure(error)}\n`);
    process.exitCode = 1;
  });
}
