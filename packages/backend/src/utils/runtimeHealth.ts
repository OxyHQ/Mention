export type RuntimePhase = 'starting' | 'ready' | 'shutting_down';

interface RuntimeHealthState {
  phase: RuntimePhase;
  migrationsComplete: boolean;
  reason?: string;
}

const state: RuntimeHealthState = {
  phase: 'starting',
  migrationsComplete: false,
};

export function markMigrationsComplete(): void {
  state.migrationsComplete = true;
}

export function markRuntimeReady(): void {
  if (!state.migrationsComplete) {
    throw new Error('Cannot mark runtime ready before migrations complete');
  }
  state.phase = 'ready';
  state.reason = undefined;
}

export function markRuntimeNotReady(reason: string): void {
  state.phase = 'starting';
  state.reason = reason;
}

export function markRuntimeShuttingDown(): void {
  state.phase = 'shutting_down';
  state.reason = 'shutdown';
}

export function getRuntimeHealthState(): Readonly<RuntimeHealthState> {
  return { ...state };
}

/** Test-only reset kept explicit so health-route tests cannot leak global state. */
export function resetRuntimeHealthState(): void {
  state.phase = 'starting';
  state.migrationsComplete = false;
  state.reason = undefined;
}
