import React from 'react';
import TestRenderer, { type ReactTestRenderer, act } from 'react-test-renderer';

import { useJobAttachmentManager, type JobAttachmentData } from '../useJobAttachmentManager';

const SAMPLE: JobAttachmentData = {
  mentionJobId: 'job-1',
  title: 'Widget Engineer',
  employerName: 'Acme',
  employerOxyUserId: 'employer-1',
  status: 'published',
  canonicalUrl: 'https://mention.earth/jobs/widget-engineer',
};

/**
 * No hook-testing library in this package (no `renderHook` anywhere in the
 * tree) — a minimal harness component exposing the hook's return value onto a
 * ref is the lightest way to exercise it directly, mirroring how a real
 * composer screen consumes it.
 */
function useHarness() {
  const manager = useJobAttachmentManager();
  harnessRef.current = manager;
  return manager;
}

let harnessRef: { current: ReturnType<typeof useJobAttachmentManager> | null } = { current: null };

function Harness() {
  useHarness();
  return null;
}

function mount(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Harness />);
  });
  return renderer;
}

beforeEach(() => {
  harnessRef = { current: null };
});

describe('useJobAttachmentManager', () => {
  it('starts with no job attached', () => {
    mount();
    expect(harnessRef.current!.job).toBeNull();
    expect(harnessRef.current!.hasContent()).toBe(false);
  });

  it('saveJob attaches a job and hasContent reflects it', () => {
    mount();
    act(() => {
      harnessRef.current!.saveJob(SAMPLE);
    });
    expect(harnessRef.current!.job).toEqual(SAMPLE);
    expect(harnessRef.current!.hasContent()).toBe(true);
  });

  it('removeJob and clearJob both detach the current job', () => {
    mount();
    act(() => {
      harnessRef.current!.saveJob(SAMPLE);
    });
    act(() => {
      harnessRef.current!.removeJob();
    });
    expect(harnessRef.current!.job).toBeNull();

    act(() => {
      harnessRef.current!.saveJob(SAMPLE);
    });
    act(() => {
      harnessRef.current!.clearJob();
    });
    expect(harnessRef.current!.job).toBeNull();
  });

  it('setJob accepts a job or null directly, same as the draft-restore call site uses it', () => {
    mount();
    act(() => {
      harnessRef.current!.setJob(SAMPLE);
    });
    expect(harnessRef.current!.job).toEqual(SAMPLE);

    act(() => {
      harnessRef.current!.setJob(null);
    });
    expect(harnessRef.current!.job).toBeNull();
  });

  it('hasContent is false for a job with a falsy mentionJobId', () => {
    mount();
    act(() => {
      harnessRef.current!.saveJob({ ...SAMPLE, mentionJobId: '' });
    });
    expect(harnessRef.current!.hasContent()).toBe(false);
  });
});
