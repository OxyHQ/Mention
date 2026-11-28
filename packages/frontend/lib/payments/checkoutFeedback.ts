export type CheckoutFeedbackResult = 'success' | 'failure';
export interface FeedbackPlayer {
  play(): void;
  remove(): void;
}

/** Feedback is best effort and never changes the checkout result. */
export function createCheckoutFeedback(dependencies: {
  configure(): Promise<void>;
  create(result: CheckoutFeedbackResult): FeedbackPlayer;
}) {
  let generation = 0;
  let player: FeedbackPlayer | undefined;
  let lastAttempt = -1;
  function stop() {
    generation += 1;
    try {
      player?.remove();
    } catch {
      // An already released native player needs no further cleanup.
    }
    player = undefined;
  }
  return {
    stop,
    async play(result: CheckoutFeedbackResult, attempt: number, enabled: boolean) {
      if (attempt <= lastAttempt) return;
      lastAttempt = attempt;
      stop();
      if (!enabled) return;
      const current = generation;
      try {
        await dependencies.configure();
        if (current !== generation) return;
        player = dependencies.create(result);
        player.play();
      } catch {
        stop();
      }
    },
  };
}
