// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { fileURLToPath } from 'node:url';
import {
  frontendDeploymentEnvironment,
  readManagedDeployment,
} from '../packages/shared-types/src/deployment';

const deployment = readManagedDeployment(process.env);
if (!deployment) throw new Error('MENTION_DEPLOYMENT_CONFIG is required');
const command = process.argv[2];
const publicEnvironment = frontendDeploymentEnvironment(deployment);
if (command === '--print-env') {
  process.stdout.write(`${JSON.stringify(publicEnvironment, null, 2)}\n`);
} else if (command === '--build') {
  if (!process.env.EXPO_PUBLIC_OXY_CLIENT_ID) {
    throw new Error(
      'EXPO_PUBLIC_OXY_CLIENT_ID must identify the registered tenant OAuth application',
    );
  }
  // Do not pass database, cloud, service credentials or the server manifest to Expo.
  const environment: Record<string, string> = { NODE_ENV: 'production' };
  const buildKeys = new Set(['PATH', 'HOME', 'TMPDIR', 'CI', 'SOURCE_DATE_EPOCH']);
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (buildKeys.has(key) || key.startsWith('EXPO_PUBLIC_'))) {
      environment[key] = value;
    }
  }
  const result = Bun.spawnSync(['bun', 'run', 'build:frontend'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...environment, ...publicEnvironment },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exitCode = result.exitCode;
} else {
  throw new Error('Usage: bun scripts/managed-frontend.ts --print-env | --build');
}
