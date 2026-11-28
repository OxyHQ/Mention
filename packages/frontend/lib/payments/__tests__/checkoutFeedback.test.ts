import { createCheckoutFeedback } from '../checkoutFeedback';

it('plays once per attempt, accepts retries, and never replays a muted result', async () => {
  const play = jest.fn();
  const remove = jest.fn();
  const create = jest.fn(() => ({ play, remove }));
  const feedback = createCheckoutFeedback({ configure: async () => {}, create });
  await feedback.play('failure', 1, true);
  await feedback.play('failure', 1, true);
  expect(play).toHaveBeenCalledTimes(1);
  await feedback.play('success', 2, false);
  await feedback.play('success', 2, true);
  expect(play).toHaveBeenCalledTimes(1);
  await feedback.play('success', 3, true);
  expect(create.mock.calls).toEqual([['failure'], ['success']]);
  expect(play).toHaveBeenCalledTimes(2);
  feedback.stop();
  expect(remove).toHaveBeenCalledTimes(2);
});

it('closing or muting while audio configuration is pending prevents late playback', async () => {
  let resolve: () => void = () => {};
  const create = jest.fn(() => ({ play: jest.fn(), remove: jest.fn() }));
  const feedback = createCheckoutFeedback({
    configure: () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
    create,
  });
  const pending = feedback.play('success', 1, true);
  feedback.stop();
  resolve();
  await pending;
  expect(create).not.toHaveBeenCalled();
});

it('audio failures cannot reject or change the checkout outcome', async () => {
  const feedback = createCheckoutFeedback({
    configure: async () => {
      throw new Error('Audio unavailable');
    },
    create: () => {
      throw new Error('must not create');
    },
  });
  await expect(feedback.play('success', 1, true)).resolves.toBeUndefined();
  const remove = jest.fn();
  const brokenPlayer = createCheckoutFeedback({
    configure: async () => {},
    create: () => ({
      play: () => {
        throw new Error('Playback blocked');
      },
      remove,
    }),
  });
  await expect(brokenPlayer.play('failure', 1, true)).resolves.toBeUndefined();
  expect(remove).toHaveBeenCalledTimes(1);
});
