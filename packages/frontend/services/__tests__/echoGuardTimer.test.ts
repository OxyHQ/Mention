/**
 * The echo guard's housekeeping interval must not hold the event loop open.
 *
 * This is not hygiene for its own sake: a referenced `setInterval` on a
 * module-level singleton is why importing anything that reaches this module —
 * `postsStore`, and through it the whole socket layer — used to leave Jest
 * running forever after the suite had already passed. That failure mode reads
 * as "the import hangs", which is what sent the previous attempt at testing the
 * socket layer looking for a transform problem instead of a timer.
 */

it('unrefs its cleanup interval so a Node host can still exit', () => {
  const unref = jest.fn();
  const setIntervalSpy = jest
    .spyOn(global, 'setInterval')
    .mockImplementation(() => ({ unref }) as unknown as ReturnType<typeof setInterval>);

  jest.isolateModules(() => {
    require('@/services/echoGuard');
  });

  expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  expect(unref).toHaveBeenCalledTimes(1);

  setIntervalSpy.mockRestore();
});
