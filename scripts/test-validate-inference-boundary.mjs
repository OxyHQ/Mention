#!/usr/bin/env bun

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validator = resolve(repositoryRoot, 'scripts/validate-inference-boundary.mjs');

const cleanFiles = {
  'packages/backend/package.json': JSON.stringify({ dependencies: { '@oxyhq/core': '^23.2.0' } }),
  'packages/backend/src/edge.ts': "import { OxyInferenceClient } from '@oxyhq/core';\nexport { OxyInferenceClient };\n",
  // Alia is the intentional chat/agent boundary, not a provider SDK.
  'packages/frontend/app/ai.tsx': "import { AliaChatScreen } from '@alia.onl/sdk';\nexport { AliaChatScreen };\n",
  // Claude's MCP client origin is OAuth/browser infrastructure, not inference.
  'packages/mcp/lib/config.ts': 'export const allowedOrigins = [\n  "https://api.anthropic.com",\n];\n',
  'packages/backend/.env.example': 'OXY_INFERENCE_ROUTING_PROFILE_ID=01a06477-94f5-74f0-bc25-4c5c13b93ccd\n',
  '.github/workflows/deploy-aws.yml': [
    'env:',
    '  TASK_ENV_OVERRIDES_JSON: >-',
    '    {"OXY_INFERENCE_ROUTING_PROFILE_ID":"01a06477-94f5-74f0-bc25-4c5c13b93ccd"}',
    '  TASK_SECRET_REMOVALS: ALIA_API_KEY OXY_SERVICE_TOKEN',
    '',
  ].join('\n'),
};

let caseCount = 0;
async function runCase(name, additions, expectedFailure) {
  caseCount += 1;
  const root = await mkdtemp(join(tmpdir(), 'mention-inference-boundary-'));
  try {
    const files = { ...cleanFiles, ...additions };
    for (const [relativePath, contents] of Object.entries(files)) {
      const path = join(root, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    }
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root });
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root });
    const run = Bun.spawnSync({
      cmd: ['bun', validator],
      cwd: repositoryRoot,
      env: { ...process.env, INFERENCE_BOUNDARY_ROOT: root, INFERENCE_BOUNDARY_FIXTURE: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    if (expectedFailure) {
      if (run.exitCode === 0 || !output.includes(expectedFailure)) {
        throw new Error(`${name}: expected failure containing ${expectedFailure}\n${output}`);
      }
    } else if (run.exitCode !== 0) {
      throw new Error(`${name}: expected success\n${output}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await runCase('clean Oxy edge and Alia agent consumers', {}, null);
await runCase('provider names in docs and tests are not production-code false positives', {
  'docs/inference-fixture.md': 'OPENAI_API_KEY=https://kaana.ai and import OpenAI from "openai"\n',
  'packages/backend/src/__tests__/provider.test.ts': 'const key = process.env.GEMINI_API_KEY;\n',
  'packages/frontend/__tests__/provider.test.ts': 'const key = process.env.ELEVENLABS_API_KEY;\n',
  'packages/mcp/__tests__/provider.test.ts': 'const key = process.env.REPLICATE_API_TOKEN;\n',
}, null);

for (const envName of [
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
]) {
  await runCase(`provider credential ${envName}`, {
    'packages/backend/src/provider-env.ts': `export const credential = process.env.${envName};\n`,
  }, 'provider credential environment variable');
}

for (const providerPackage of [
  'openai',
  '@openai/agents',
  '@anthropic-ai/sdk',
  'groq-sdk',
  '@cerebras/cerebras_cloud_sdk',
  '@openrouter/ai-sdk-provider',
  '@ai-sdk/xai',
  '@google/genai',
  '@elevenlabs/elevenlabs-js',
  'cohere-ai',
  'replicate',
  '@mistralai/mistralai',
  'together-ai',
  '@ai-sdk/fireworks',
  '@ai-sdk/perplexity',
  '@aws-sdk/client-bedrock-runtime',
]) {
  await runCase(`provider SDK ${providerPackage}`, {
    'packages/backend/src/provider-sdk.ts': `import Provider from '${providerPackage}';\nexport { Provider };\n`,
  }, 'direct provider SDK import');
}

await runCase('side-effect provider SDK import', {
  'packages/frontend/app/provider-side-effect.ts': "import 'openai/shims/node';\n",
}, 'direct provider SDK import');
await runCase('spaced provider SDK require', {
  'packages/mcp/lib/provider-require.cjs': "const sdk = require ( '@anthropic-ai/sdk' );\nmodule.exports = sdk;\n",
}, 'direct provider SDK import');
await runCase('spaced dynamic provider SDK import', {
  'packages/backend/src/provider-dynamic.ts': "export const sdk = import ( '@google/genai' );\n",
}, 'direct provider SDK import');

for (const endpoint of [
  'https://api.openai.com/v1',
  'https://api.anthropic.com/v1',
  'https://api.groq.com/openai/v1',
  'https://api.cerebras.ai/v1',
  'https://openrouter.ai/api/v1',
  'https://api.x.ai/v1',
  'https://generativelanguage.googleapis.com/v1',
  'https://api.elevenlabs.io/v1',
  'https://api.cohere.ai/v1',
  'https://api.replicate.com/v1',
  'https://api.mistral.ai/v1',
  'https://api.deepseek.com/v1',
  'https://api.together.xyz/v1',
  'https://api.fireworks.ai/inference/v1',
  'https://api.perplexity.ai',
  'https://api.deepinfra.com/v1',
  'https://api.novita.ai/v3',
  'https://api.z.ai/v1',
  'https://integrate.api.nvidia.com/v1',
  'https://api-inference.huggingface.co/models/example',
  'https://bedrock-runtime.us-west-2.amazonaws.com',
  'https://api.fal.ai/v1',
]) {
  await runCase(`direct provider endpoint ${endpoint}`, {
    'packages/backend/src/provider-endpoint.ts': `export const endpoint = '${endpoint}';\n`,
  }, 'direct provider endpoint');
}

await runCase('frontend direct Kaana endpoint', {
  'packages/frontend/app/direct-kaana.ts': "export const url = 'https://kaana.ai/internal/v1/inference';\n",
}, 'direct Kaana/Relay data-plane endpoint');
await runCase('MCP direct legacy Relay endpoint', {
  'packages/mcp/lib/direct-relay.ts': "export const url = 'https://relay.oxy.so/v1/chat/completions';\n",
}, 'direct Kaana/Relay data-plane endpoint');
await runCase('MCP provider credential', {
  'packages/mcp/lib/provider.ts': 'export const key = process.env.ELEVENLABS_API_KEY;\n',
}, 'provider credential environment variable');
await runCase('frontend provider SDK dependency', {
  'packages/frontend/package.json': JSON.stringify({ dependencies: { '@ai-sdk/google': '^3.0.0' } }),
}, 'direct provider dependency @ai-sdk/google');
await runCase('direct Kaana signing configuration', {
  'packages/backend/src/direct-kaana.ts': 'export const baseUrl = process.env.KAANA_BASE_URL;\n',
}, 'direct or retired data-plane configuration');
await runCase('legacy gateway', {
  'packages/backend/src/legacy.ts': 'export const url = process.env.ALIA_API_URL;\n',
}, 'retired Alia provider gateway variable');
await runCase('static Oxy service token', {
  'packages/backend/src/legacy-token.ts': 'export const token = process.env.OXY_SERVICE_TOKEN;\n',
}, 'retired static Oxy service-token fallback');
await runCase('routing-profile slug selector', {
  'packages/backend/src/legacy-routing.ts': "export const request = { routingProfile: 'mention-default' };\n",
}, 'routing-profile slug request field');
await runCase('retired routing-profile environment variable', {
  'packages/backend/.env.example': 'OXY_INFERENCE_ROUTING_PROFILE=mention-default\n',
}, 'retired mutable routing-profile selector');
await runCase('wrong routing-profile ID', {
  'packages/backend/.env.example': 'OXY_INFERENCE_ROUTING_PROFILE_ID=other-profile-id\n',
}, 'must pin Mention\'s exact opaque routing-profile ID');
await runCase('lost retirement assertion', {
  '.github/workflows/deploy-aws.yml': [
    'env:',
    '  TASK_ENV_OVERRIDES_JSON: >-',
    '    {"OXY_INFERENCE_ROUTING_PROFILE_ID":"01a06477-94f5-74f0-bc25-4c5c13b93ccd"}',
    '',
  ].join('\n'),
}, 'must re-assert removal of ALIA_API_KEY');

console.log(`Inference boundary mutation tests passed (${caseCount} cases).`);
