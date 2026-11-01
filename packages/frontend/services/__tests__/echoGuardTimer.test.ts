it('starts one unrefed cleanup interval only after a local action', () => {
  const unref = jest.fn();
  const setIntervalSpy = jest
    .spyOn(global, 'setInterval')
    .mockImplementation(() => ({ unref }) as unknown as ReturnType<typeof setInterval>);

  jest.isolateModules(() => {
    const { markLocalAction } = require('@/services/echoGuard');
    expect(setIntervalSpy).not.toHaveBeenCalled();
    markLocalAction('post-1', 'like');
    markLocalAction('post-2', 'save');
  });

  expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  expect(unref).toHaveBeenCalledTimes(1);
  setIntervalSpy.mockRestore();
});

it('suppresses immediate echoes, retains recent actions during cleanup, and stops when idle', () => {
  jest.useFakeTimers();
  jest.setSystemTime(10_000);
  try {
    jest.isolateModules(() => {
      const { markLocalAction, wasRecent } = require('@/services/echoGuard');
      expect(jest.getTimerCount()).toBe(0);
      markLocalAction('post-1', 'like');
      expect(wasRecent('post-1', 'like')).toBe(true);
      expect(wasRecent('post-1', 'save')).toBe(false);
      jest.advanceTimersByTime(500);
      expect(wasRecent('post-1', 'like')).toBe(false);

      jest.advanceTimersByTime(28_500);
      markLocalAction('post-2', 'save');
      jest.advanceTimersByTime(1_000);
      expect(wasRecent('post-1', 'like', 60_000)).toBe(false);
      expect(wasRecent('post-2', 'save', 60_000)).toBe(true);
      expect(jest.getTimerCount()).toBe(1);

      jest.advanceTimersByTime(30_000);
      expect(wasRecent('post-2', 'save', 60_000)).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
      markLocalAction('post-3', 'reply');
      expect(wasRecent('post-3', 'reply')).toBe(true);
      expect(jest.getTimerCount()).toBe(1);
    });
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});
