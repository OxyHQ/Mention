import { OxyServices } from "@oxyhq/core";
import { appCapabilityCatalogSchema } from "@oxyhq/contracts";
import { MENTION_CAPABILITY_CATALOG } from "./lib/mention-catalog.js";

const OXY_API_URL = (process.env.OXY_API_URL ?? "https://api.oxy.so").replace(/\/$/, "");

function requiredEnvironment(name: "OXY_SERVICE_API_KEY" | "OXY_SERVICE_API_SECRET"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to register Mention's capability catalog`);
  return value;
}

async function main(): Promise<void> {
  const catalog = appCapabilityCatalogSchema.parse(MENTION_CAPABILITY_CATALOG);
  const oxy = new OxyServices({ baseURL: OXY_API_URL });
  oxy.configureServiceAuth(
    requiredEnvironment("OXY_SERVICE_API_KEY"),
    requiredEnvironment("OXY_SERVICE_API_SECRET"),
  );
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
    throw new Error(`Mention capability catalog registration failed (${response.status})`);
  }
  const body = await response.json() as { registration?: { digest?: string } };
  const digest = body.registration?.digest;
  if (!digest) throw new Error("Mention capability catalog registration returned no digest");
  process.stdout.write(`Registered Mention capability catalog ${catalog.version} (${digest})\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
