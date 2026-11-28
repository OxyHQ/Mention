import { saveTextFile } from '../saveTextFile';
import { saveTextFile as saveOnWeb } from '../saveTextFile.web';

const mockPick = jest.fn();
jest.mock('expo-file-system', () => ({
  Directory: { pickDirectoryAsync: () => mockPick() },
}));

it('writes the file into the chosen folder', async () => {
  const write = jest.fn();
  const createFile = jest.fn(() => ({ write }));
  mockPick.mockResolvedValueOnce({ createFile });
  await expect(saveTextFile('a.ndjson', 'body', 'text/plain')).resolves.toBe(true);
  expect(createFile).toHaveBeenCalledWith('a.ndjson', 'text/plain');
  expect(write).toHaveBeenCalledWith('body');
});

it('saves nothing when the folder picker is dismissed', async () => {
  mockPick.mockRejectedValueOnce(new Error('cancelled'));
  await expect(saveTextFile('a.ndjson', 'body', 'text/plain')).resolves.toBe(false);
});

it('hands the browser a named download on web', async () => {
  jest.useFakeTimers();
  const link = { href: '', download: '', click: jest.fn(), remove: jest.fn() };
  const previous = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => link, body: { appendChild: jest.fn() } },
  });
  const create = jest.fn(() => 'blob:export');
  const revoke = jest.fn();
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });

  await expect(saveOnWeb('a.ndjson', 'body', 'text/plain')).resolves.toBe(true);
  expect(link).toMatchObject({ href: 'blob:export', download: 'a.ndjson' });
  expect(link.click).toHaveBeenCalled();
  jest.runAllTimers();
  expect(revoke).toHaveBeenCalledWith('blob:export');

  Object.defineProperty(globalThis, 'document', { configurable: true, value: previous });
  jest.useRealTimers();
});
