#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(
  process.argv[2] ?? fileURLToPath(new URL('../packages/frontend', import.meta.url)),
);
const projectRequire = createRequire(join(projectRoot, 'package.json'));
const servicesManifest = projectRequire.resolve('@oxy.so/services/package.json');
const services = JSON.parse(readFileSync(servicesManifest, 'utf8'));
const autolinking = projectRequire.resolve('expo-modules-autolinking/package.json');
const cli = join(dirname(autolinking), 'bin/expo-modules-autolinking.js');
const output = execFileSync(
  process.execPath,
  [cli, 'resolve', '--platform', 'android', '--project-root', projectRoot, '--json'],
  { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
);
const result = JSON.parse(output);
const matches = result.modules.filter((entry) => entry.packageName === '@oxy.so/services');
if (matches.length !== 1 || matches[0].packageVersion !== services.version) {
  throw new Error('Android autolinking must resolve exactly the installed Oxy Services version.');
}
const projects = matches[0].projects.filter((project) =>
  project.modules.some(
    (module) => module.classifier === 'so.oxy.devicesession.OxyDeviceSessionModule',
  ),
);
if (projects.length !== 1) {
  throw new Error('Android autolinking must include exactly one OxyDeviceSessionModule.');
}
const nativeDir = join(dirname(servicesManifest), 'android');
if (realpathSync(projects[0].sourceDir) !== realpathSync(nativeDir)) {
  throw new Error('OxyDeviceSessionModule must come from the installed Oxy Services package.');
}
for (const source of ['OxyDeviceSessionModule.kt', 'SharedDeviceSessionSweep.kt']) {
  if (!existsSync(join(nativeDir, 'src/main/java/so/oxy/devicesession', source))) {
    throw new Error(`Installed Oxy Services is missing Android source ${source}.`);
  }
}
console.log(
  `Android autolinking includes OxyDeviceSessionModule from Oxy Services ${services.version}.`,
);
