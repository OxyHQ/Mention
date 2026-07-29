import React, { useCallback, useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useLatchedState } from '../useLatchedState';

/**
 * The property under test: a handler captured BEFORE a burst of writes still
 * reads the newest value when it finally runs.
 *
 * That is the shape of the real bug — typing `cat` quickly and pressing Enter on
 * the final keystroke, where the submit handler the input is holding was built
 * before that keystroke committed. A test that writes ONE character and submits
 * passes whether or not the bug exists, so every case here writes several
 * characters and invokes a handler captured before all of them.
 */

/** Runs a hook and exposes a submit handler memoized the way a screen's would be. */
function renderProbe(useValueSource: (initial: string) => {
    value: string;
    setValue: (next: string) => void;
    read: () => string;
}) {
    const captured: { setValue: (next: string) => void; submit: () => string } = {
        setValue: () => undefined,
        submit: () => '',
    };

    function Probe() {
        const { value, setValue, read } = useValueSource('');
        // Memoized on the value, exactly like a screen's submit callback.
        const submit = useCallback(() => read(), [read, value]);
        captured.setValue = setValue;
        captured.submit = submit;
        return null;
    }

    // The initial render MUST be flushed here: an unflushed render leaves the
    // captured handles at their no-op defaults, which makes every assertion below
    // pass vacuously (the control test caught exactly that).
    act(() => {
        TestRenderer.create(<Probe />);
    });
    if (captured.submit() !== '') throw new Error('probe did not render');
    return captured;
}

/** The real hook. */
function useLatched(initial: string) {
    const [value, setValue, getLatest] = useLatchedState(initial);
    return { value, setValue, read: getLatest };
}

/** A plain-useState control, which is the code that HAS the bug. */
function usePlain(initial: string) {
    const [value, setValue] = useState(initial);
    return { value, setValue, read: () => value };
}

describe('useLatchedState', () => {
    it('a handler captured before a burst of writes still reads the newest value', () => {
        const probe = renderProbe(useLatched);
        const submitFromFirstRender = probe.submit;

        act(() => {
            probe.setValue('c');
            probe.setValue('ca');
            probe.setValue('cat');
        });

        expect(submitFromFirstRender()).toBe('cat');
    });

    it('reads the newest value even when the write and the submit share one batch', () => {
        const probe = renderProbe(useLatched);
        let submitted = '';

        act(() => {
            // The final keystroke and the Enter that submits it, with no render in
            // between — the exact interleave that produced the upstream bug.
            probe.setValue('cat');
            submitted = probe.submit();
        });

        expect(submitted).toBe('cat');
    });

    it('still re-renders with the value, so the UI stays a function of state', () => {
        const probe = renderProbe(useLatched);
        act(() => probe.setValue('cat'));
        // A fresh render produced a fresh handler, which also sees the value.
        expect(probe.submit()).toBe('cat');
    });

    // The control. If this ever passes, the tests above have stopped being able
    // to detect the bug and the ones above are worthless.
    it('CONTROL: plain useState reproduces the stale read these tests guard against', () => {
        const probe = renderProbe(usePlain);
        const submitFromFirstRender = probe.submit;

        act(() => {
            probe.setValue('c');
            probe.setValue('ca');
            probe.setValue('cat');
        });

        expect(submitFromFirstRender()).toBe('');
        expect(submitFromFirstRender()).not.toBe('cat');
    });
});
