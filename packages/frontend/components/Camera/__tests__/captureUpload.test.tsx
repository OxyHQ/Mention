import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { AssetUploadOptions } from '@oxy.so/core';
import { useCaptureUpload } from '../useCaptureUpload';

const mockUpload = jest.fn();
jest.mock('@/lib/oxyServices', () => ({
  oxyServices: { assets: { upload: (...args: unknown[]) => mockUpload(...args) } },
}));
jest.mock('@oxy.so/core/logger', () => ({ logger: { warn: jest.fn() } }));

const capture = { uri: 'file:///capture.mp4', kind: 'video' as const, mimeType: 'video/mp4' };
let current: ReturnType<typeof useCaptureUpload>;
let renderer: ReactTestRenderer;
let options: AssetUploadOptions;
let finish: (value: unknown) => void;
function Harness({ active = true }: { active?: boolean }) {
  current = useCaptureUpload(active);
  return null;
}
beforeEach(() => {
  mockUpload.mockImplementation((_capture, nextOptions) => {
    options = nextOptions;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  act(() => {
    renderer = create(<Harness />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
});

test('reports preparation, transfer and verification without declaring success early', async () => {
  let pending: ReturnType<typeof current.upload>;
  act(() => {
    pending = current.upload(capture);
  });
  expect(options.visibility).toBe('private');
  for (const phase of ['hash', 'upload', 'verify'] as const) {
    act(() => options.onStageProgress?.({ phase, loaded: 50, total: 100 }));
    expect(current.progress?.phase).toBe(phase);
    expect(current.busy).toBe(true);
  }
  await act(async () => {
    finish({ file: { id: 'private-file' } });
    await pending;
  });
  expect(current.busy).toBe(false);
  expect(current.progress).toBeNull();
  act(() => options.onStageProgress?.({ phase: 'upload', loaded: 100, total: 100 }));
  expect(current.progress).toBeNull();
});

test.each(['blur', 'reset', 'unmount'])(
  '%s aborts transport and ignores a late successful result',
  async (action) => {
    let pending: ReturnType<typeof current.upload>;
    act(() => {
      pending = current.upload(capture);
    });
    const signal = options.signal;
    act(() => {
      if (action === 'blur') renderer.update(<Harness active={false} />);
      else if (action === 'reset') current.reset();
      else renderer.unmount();
    });
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      options.onStageProgress?.({ phase: 'upload', loaded: 100, total: 100 });
      finish({ file: { id: 'late-file' } });
      expect(await pending).toBeNull();
    });
  },
);
