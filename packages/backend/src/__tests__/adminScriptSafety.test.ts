import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_MUTATION_CONFIRMATION_ENV,
  assertAdminMutationAllowed,
} from '../scripts/lib/adminScriptSafety';

const SCRIPT_NAME = 'purgeGoneFederatedActors';
const READ_ONLY_SCRIPTS = new Set(['evalFeedQuality.ts']);

describe('assertAdminMutationAllowed', () => {
  it('allows a dry run without confirmation', () => {
    expect(() =>
      assertAdminMutationAllowed({
        scriptName: SCRIPT_NAME,
        dryRun: true,
        environment: { NODE_ENV: 'production' },
      }),
    ).not.toThrow();
  });

  it('rejects mutation even when NODE_ENV is missing or incorrect', () => {
    expect(() =>
      assertAdminMutationAllowed({
        scriptName: SCRIPT_NAME,
        dryRun: false,
        environment: { NODE_ENV: 'development' },
      }),
    ).toThrow(`CONFIRM_ADMIN_MUTATION=${SCRIPT_NAME}`);

    expect(() =>
      assertAdminMutationAllowed({
        scriptName: SCRIPT_NAME,
        dryRun: false,
        environment: {},
      }),
    ).toThrow('refusing a mutating administrative run');
  });

  it('rejects a mutation without exact confirmation', () => {
    expect(() =>
      assertAdminMutationAllowed({
        scriptName: SCRIPT_NAME,
        dryRun: false,
        environment: { NODE_ENV: 'production' },
      }),
    ).toThrow(`CONFIRM_ADMIN_MUTATION=${SCRIPT_NAME}`);

    expect(() =>
      assertAdminMutationAllowed({
        scriptName: SCRIPT_NAME,
        dryRun: false,
        environment: {
          NODE_ENV: 'production',
          [ADMIN_MUTATION_CONFIRMATION_ENV]: 'anotherScript',
        },
      }),
    ).toThrow('refusing a mutating administrative run');
  });

  it('allows a mutation only for the exact reviewed script', () => {
    expect(() =>
      assertAdminMutationAllowed({
        scriptName: SCRIPT_NAME,
        dryRun: false,
        environment: {
          NODE_ENV: 'production',
          [ADMIN_MUTATION_CONFIRMATION_ENV]: SCRIPT_NAME,
        },
      }),
    ).not.toThrow();
  });

  it('guards every mutating top-level administrative script', () => {
    const scriptsDirectory = path.resolve(__dirname, '../scripts');
    const unguarded = readdirSync(scriptsDirectory)
      .filter((name) => name.endsWith('.ts') && !READ_ONLY_SCRIPTS.has(name))
      .filter((name) => {
        const source = readFileSync(path.join(scriptsDirectory, name), 'utf8');
        return !source.includes('assertAdminMutationAllowed({');
      });

    expect(unguarded).toEqual([]);
  });
});
