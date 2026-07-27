export const ADMIN_MUTATION_CONFIRMATION_ENV = 'CONFIRM_ADMIN_MUTATION';

type ScriptEnvironment = Readonly<Record<string, string | undefined>>;

interface AdminMutationGuardOptions {
  scriptName: string;
  dryRun: boolean;
  environment?: ScriptEnvironment;
}

/**
 * Refuse an administrative script's mutating mode in every environment unless
 * the operator confirms the exact script name. This deliberately does not trust
 * NODE_ENV: a production URI can be paired with the wrong environment label.
 * Read-only previews remain usable without a token.
 */
export function assertAdminMutationAllowed({
  scriptName,
  dryRun,
  environment = process.env,
}: AdminMutationGuardOptions): void {
  if (dryRun) return;

  const confirmation = environment[ADMIN_MUTATION_CONFIRMATION_ENV]?.trim();
  if (confirmation === scriptName) return;

  throw new Error(
    `[${scriptName}] refusing a mutating administrative run. ` +
      `Run the script in dry-run/inspect mode first, then set ` +
      `${ADMIN_MUTATION_CONFIRMATION_ENV}=${scriptName} for the reviewed live run.`,
  );
}
