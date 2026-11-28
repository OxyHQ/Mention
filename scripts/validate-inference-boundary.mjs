#!/usr/bin/env bun

/**
 * Mention is an inference CONSUMER. Provider credentials, endpoints and SDKs
 * belong to Kaana. Mention reaches `https://kaana.ai` only through
 * `@kaana.ai/sdk`, which owns the origin, from the one client in
 * `packages/backend/src/utils/kaana.ts` (Kaana ADR 0002).
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = process.env.INFERENCE_BOUNDARY_ROOT
  ? resolve(process.env.INFERENCE_BOUNDARY_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kaanaClientFile = 'packages/backend/src/utils/kaana.ts';
const fixtureMode = process.env.INFERENCE_BOUNDARY_FIXTURE === '1';

const productionSourceRoots = ['packages/backend/src/', 'packages/frontend/', 'packages/mcp/'];
const sourceExtension = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const nonProductionSource =
  /(?:^|\/)(?:__tests__|__mocks__|tests?|fixtures?|dist|coverage)(?:\/|$)|\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$|(?:^|\/)test-[^/]*\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

const providerCredentialNames = [
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_AI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'ELEVENLABS_API_KEY',
  'COHERE_API_KEY',
  'REPLICATE_API_TOKEN',
  'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'TOGETHER_API_KEY',
  'TOGETHER_AI_API_KEY',
  'FIREWORKS_API_KEY',
  'PERPLEXITY_API_KEY',
  'DEEPINFRA_API_KEY',
  'NOVITA_API_KEY',
  'ZAI_API_KEY',
  'NVIDIA_API_KEY',
  'AI21_API_KEY',
  'VOYAGE_API_KEY',
  'HUGGINGFACE_API_KEY',
  'HUGGINGFACEHUB_API_TOKEN',
  'HF_TOKEN',
  'FAL_KEY',
  'ASSEMBLYAI_API_KEY',
  'DEEPGRAM_API_KEY',
];
const providerCredentialPattern = new RegExp(`(?:${providerCredentialNames.join('|')})\\b`);

const providerPackages = new Set([
  'openai',
  '@openai/agents',
  '@anthropic-ai/sdk',
  'groq-sdk',
  '@cerebras/cerebras_cloud_sdk',
  '@openrouter/ai-sdk-provider',
  '@google/generative-ai',
  '@google/genai',
  'elevenlabs',
  '@elevenlabs/elevenlabs-js',
  'cohere-ai',
  'replicate',
  '@mistralai/mistralai',
  'together-ai',
  '@huggingface/inference',
  '@fal-ai/client',
  '@aws-sdk/client-bedrock-runtime',
  'ai21',
  'voyageai',
  ...[
    'openai',
    'azure',
    'anthropic',
    'groq',
    'cerebras',
    'xai',
    'google',
    'google-vertex',
    'cohere',
    'replicate',
    'mistral',
    'deepseek',
    'togetherai',
    'fireworks',
    'perplexity',
    'deepinfra',
    'amazon-bedrock',
  ].map((name) => `@ai-sdk/${name}`),
]);
const escapedProviderPackages = [...providerPackages]
  .sort((left, right) => right.length - left.length)
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const providerImportPattern = new RegExp(
  `(?:\\bfrom\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s*(?:\\(\\s*)?)["'](?:${escapedProviderPackages.join('|')})(?:\\/[^"']*)?["']`,
);

const listed = Bun.spawnSync({
  cmd: ['git', 'ls-files', '--cached', '--others', '--exclude-standard'],
  cwd: repositoryRoot,
  stdout: 'pipe',
  stderr: 'pipe',
});
if (listed.exitCode !== 0) {
  throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
}

const trackedFiles = listed.stdout
  .toString()
  .split('\n')
  .filter((file) => existsSync(resolve(repositoryRoot, file)));
const sourceFiles = trackedFiles
  .filter((file) => productionSourceRoots.some((root) => file.startsWith(root)))
  .filter((file) => sourceExtension.test(file) && !nonProductionSource.test(file));

const failures = [];
if (sourceFiles.length < (fixtureMode ? 1 : 1_100)) {
  failures.push(`production source listing is unexpectedly small (${sourceFiles.length} files)`);
}
if (!fixtureMode) {
  for (const [root, minimum] of [
    ['packages/backend/src/', 450],
    ['packages/frontend/', 600],
    ['packages/mcp/', 25],
  ]) {
    const count = sourceFiles.filter((file) => file.startsWith(root)).length;
    if (count < minimum)
      failures.push(`${root} production source listing is unexpectedly small (${count} files)`);
  }
}

const forbiddenSourcePatterns = [
  [providerCredentialPattern, 'provider credential environment variable'],
  [/\bALIA_API_(?:KEY|URL)\b/, 'retired Alia provider gateway variable'],
  [/\bOXY_SERVICE_TOKEN\b/, 'retired static Oxy service-token fallback'],
  [
    /\b(?:RELAY_BASE_URL|ALIA_RELAY_CLIENT_ENABLED|KAANA_BASE_URL|KAANA_EDGE_SIGNING_KEY_ID|KAANA_EDGE_SIGNING_PRIVATE_KEY)\b/,
    'direct or retired data-plane configuration',
  ],
  // The SDK owns the origin; a literal here is a second way in.
  [
    /(?:https?|wss?):\/\/(?:kaana\.ai|relay\.oxy\.so)(?=[:/\s'"`]|$)/i,
    'direct Kaana/Relay data-plane endpoint',
  ],
  [/['"]@oxy\.so\/core\/inference['"]|\bOxyInferenceClient\b/, 'retired Oxy inference client'],
  [/['"]@kaana\.ai\/contracts\/internal['"]/, 'Oxy-Kaana internal contract import'],
  [
    /(?:api\.openai\.com|api\.anthropic\.com|api\.groq\.com|api\.cerebras\.ai|openrouter\.ai\/api|api\.x\.ai|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|api\.elevenlabs\.io|api\.cohere\.ai|api\.replicate\.com|api\.mistral\.ai|api\.deepseek\.com|api\.together\.xyz|api\.fireworks\.ai|api\.perplexity\.ai|api\.deepinfra\.com|api\.novita\.ai|api\.z\.ai|integrate\.api\.nvidia\.com|api-inference\.huggingface\.co|bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com|api\.fal\.ai)/i,
    'direct provider endpoint',
  ],
  [providerImportPattern, 'direct provider SDK import'],
  [/(?:from\s+|require\()['"][^'"]*\/utils\/alia['"]/, 'retired Alia inference utility import'],
  [/\bOXY_INFERENCE_ROUTING_PROFILE(?:_ID)?\b/, 'retired routing-profile selector'],
  [/\broutingProfile\s*:/, 'routing-profile slug request field'],
];

/**
 * Exact non-inference origins that resemble a provider endpoint. Claude's MCP
 * client origin is a browser/OAuth caller, not an Anthropic model endpoint.
 * Removing one exact array element keeps the direct-endpoint rule armed for a
 * second occurrence (for example, a fetch added elsewhere in the same file).
 */
function withoutReviewedNonInferenceOrigins(file, text) {
  if (file === 'packages/mcp/lib/config.ts') {
    return text.replace(/^\s*["']https:\/\/api\.anthropic\.com["'],\s*$/m, '');
  }
  return text;
}

for (const file of sourceFiles) {
  const text = withoutReviewedNonInferenceOrigins(
    file,
    await readFile(resolve(repositoryRoot, file), 'utf8'),
  );
  for (const [pattern, label] of forbiddenSourcePatterns) {
    if (pattern.test(text)) failures.push(`${file}: ${label}`);
  }
  if (file !== kaanaClientFile && /\bnew\s+(?:\w+\.)?Kaana\s*\(/.test(text)) {
    failures.push(`${file}: a second Kaana client (use kaanaClient() from ${kaanaClientFile})`);
  }
}

for (const relativePath of [
  'packages/backend/package.json',
  'packages/frontend/package.json',
  'packages/mcp/package.json',
]) {
  const manifestPath = resolve(repositoryRoot, relativePath);
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const packages = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  };
  const forbiddenPackages = Object.keys(packages).filter((name) => providerPackages.has(name));
  for (const name of forbiddenPackages)
    failures.push(`${relativePath}: direct provider dependency ${name}`);
}

for (const relativePath of [
  'packages/backend/.env.example',
  'packages/backend/Dockerfile',
  'packages/frontend/.env.example',
  'packages/frontend/Dockerfile',
  'packages/mcp/.env.example',
  'packages/mcp/Dockerfile',
]) {
  const path = resolve(repositoryRoot, relativePath);
  if (!existsSync(path)) continue;
  const text = await readFile(path, 'utf8');
  for (const [pattern, label] of forbiddenSourcePatterns) {
    if (pattern.test(text)) failures.push(`${relativePath}: ${label}`);
  }
}

/**
 * A space-separated workflow list, read by VALUE, not by line.
 *
 * The lists outgrew one line, and YAML has two ways to write the same string.
 * Matching the rest of the line found nothing the moment a list became a
 * folded block — so the gate reported that a retired credential had stopped
 * being removed, while the workflow removed it exactly as before. A gate that
 * fails on formatting teaches people to reformat, which is the opposite of
 * what this one is for.
 */
function listValue(workflow, key) {
  const line = workflow.match(new RegExp(`^\\s*${key}:\\s*(.*)$`, 'm'));
  const value = line?.[1]?.trim().startsWith('>')
    ? workflow
        .slice(workflow.indexOf(line[0]) + line[0].length)
        .split('\n')
        // A folded block ends at the first line indented no further than the key.
        .slice(1)
        .reduce(
          (lines, next) => {
            if (lines.done || (next.trim() !== '' && !/^\s{2,}\S/.test(next))) {
              return { ...lines, done: true };
            }
            return { ...lines, values: [...lines.values, next.trim()] };
          },
          { values: [], done: false },
        )
        .values.join(' ')
    : (line?.[1] ?? '');
  return value.split(/\s+/).filter(Boolean);
}

const workflowPath = resolve(repositoryRoot, '.github/workflows/deploy-aws.yml');
if (existsSync(workflowPath)) {
  const workflow = await readFile(workflowPath, 'utf8');
  if (/secrets\.ALIA_API_KEY/.test(workflow)) {
    failures.push(
      '.github/workflows/deploy-aws.yml: still reads the retired ALIA_API_KEY GitHub secret',
    );
  }
  const removals = listValue(workflow, 'TASK_SECRET_REMOVALS');
  /**
   * The Oxy service key pair is retired too, and its removal is now a standing
   * absence assertion rather than an option.
   *
   * Every revision is rendered from the RUNNING one, so this list is the only
   * thing that keeps a name off it. Once `/oxy/mention/OXY_SERVICE_API_KEY` and
   * `_SECRET` are deleted from SSM, a revision that still names them cannot
   * start at all — ECS fails the task while resolving its secrets — so dropping
   * them from here would turn the next deploy into an outage, not a no-op.
   */
  for (const retiredSecret of [
    'ALIA_API_KEY',
    'OXY_SERVICE_TOKEN',
    'OXY_SERVICE_API_KEY',
    'OXY_SERVICE_API_SECRET',
  ]) {
    if (!removals.includes(retiredSecret)) {
      failures.push(
        `.github/workflows/deploy-aws.yml: must re-assert removal of ${retiredSecret} from every ECS task revision`,
      );
    }
  }
  /**
   * And the condition that removal waited for stays written down beside it.
   *
   * For nine hours the pair was treated as retired before it was. Mention could
   * attest its ECS task role and mint a real service token without it, but the
   * token did not carry the same AUTHORITY: the workload mint then dropped every
   * privileged scope, and Mention's credential named `federation:write`,
   * `signals:write` and `catalogs:write`. The pair came off at task revision 384
   * and the federation worker failed every ~6 minutes until revision 389 put it
   * back — 313 `Missing required scope: federation:write` against zero in the
   * preceding 36 hours.
   *
   * oxy#1350 let a BINDING name scopes, the role was re-bound with all nine on
   * 2026-09-20, and the marker records the date. It is required while the
   * removal is, so the record cannot be deleted without the reason.
   */
  const scopesBound = workflow.match(/workload-scopes-bound:\s*(\d{4}-\d{2}-\d{2})/);
  for (const credentialPart of ['OXY_SERVICE_API_KEY', 'OXY_SERVICE_API_SECRET']) {
    if (removals.includes(credentialPart) && !scopesBound) {
      failures.push(
        `.github/workflows/deploy-aws.yml: removing ${credentialPart} costs Mention every privileged scope its credential names. ` +
          'Bind those scopes to the task role first, then record it here as `# workload-scopes-bound: YYYY-MM-DD`.',
      );
    }
  }
  // The retired selector named Oxy's fixed `kaana-v1` profile, which kaana.ai
  // cannot serve. The render derives from the RUNNING task definition, so the
  // name stays in the standing removals and never re-enters the overrides.
  const taskEnvOverrides = workflow.match(/TASK_ENV_OVERRIDES_JSON:\s*>-\s*\n([\s\S]*?\})/)?.[1];
  if (taskEnvOverrides?.includes('OXY_INFERENCE_ROUTING_PROFILE')) {
    failures.push(
      '.github/workflows/deploy-aws.yml: still injects the retired routing-profile selector',
    );
  }
  if (!listValue(workflow, 'TASK_ENV_REMOVALS').includes('OXY_INFERENCE_ROUTING_PROFILE_ID')) {
    failures.push(
      '.github/workflows/deploy-aws.yml: must re-assert removal of OXY_INFERENCE_ROUTING_PROFILE_ID from every ECS task revision',
    );
  }
}

if (failures.length > 0) {
  console.error(
    `Inference boundary validation failed:\n\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
  );
  process.exit(1);
}

console.log(
  `Validated Mention's Oxy/Kaana inference boundary across ${sourceFiles.length} backend/frontend/MCP production source files.`,
);
