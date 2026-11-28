import { DATA_EXPORT_TIMEOUT_MS, fetchDataExport } from '../dataExportService';

const mockPost = jest.fn();
jest.mock('@/utils/api', () => ({
  authenticatedClient: { post: (...args: unknown[]) => mockPost(...args) },
}));

const complete = '{"type":"meta","data":{}}\n{"type":"settings","data":null}\n';

it('returns a complete export, allowing it longer than an ordinary read', async () => {
  mockPost.mockResolvedValueOnce({ data: complete });
  await expect(fetchDataExport()).resolves.toBe(complete);
  expect(mockPost).toHaveBeenCalledWith('/profile/export', undefined, {
    timeout: DATA_EXPORT_TIMEOUT_MS,
  });
});

it.each([
  ['cut off before the settings record', '{"type":"meta","data":{}}\n{"type":"post","data":{}}\n'],
  ['empty', ''],
  ['not text', null],
])('rejects a body that is %s', async (_label, data) => {
  mockPost.mockResolvedValueOnce({ data });
  await expect(fetchDataExport()).rejects.toThrow('incomplete');
});
