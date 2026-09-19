import { FOR_YOU_TUNING_MODULES, type ForYouFeedTuning } from '@mention/shared-types';
import { FOR_YOU_TUNING_DEFAULT_THRESHOLDS, resolveTuning, updateTuning } from '../forYouTuning';

describe('For You tuning', () => {
  it.each(FOR_YOU_TUNING_MODULES.map((spec) => [spec.moduleId, spec] as const))(
    '%s starts from the spec default and the default threshold when nothing is stored',
    (moduleId, spec) => {
      expect(resolveTuning({}, spec)).toEqual({
        enabled: spec.defaultEnabled,
        threshold: FOR_YOU_TUNING_DEFAULT_THRESHOLDS[moduleId],
      });
    },
  );

  it.each(FOR_YOU_TUNING_MODULES.map((spec) => [spec.moduleId, spec] as const))(
    '%s reads back exactly what was written, under its own threshold key',
    (_moduleId, spec) => {
      const written = updateTuning({}, spec, { enabled: !spec.defaultEnabled, threshold: 7 });
      // A toggle-only module stores no threshold, so it reads back none however
      // insistently one is offered — which is the property that keeps a stray
      // number from being persisted under a key its entry does not have.
      expect(resolveTuning(written, spec)).toEqual({
        enabled: !spec.defaultEnabled,
        threshold: spec.control === 'number-range' ? 7 : undefined,
      });
    },
  );

  it('replaces only the module it is given', () => {
    const [first, second] = FOR_YOU_TUNING_MODULES;
    const start: ForYouFeedTuning = updateTuning({}, second, { enabled: false, threshold: 2 });
    const next = updateTuning(start, first, { enabled: true, threshold: 9 });
    expect(resolveTuning(next, second)).toEqual({ enabled: false, threshold: 2 });
    expect(resolveTuning(next, first)).toEqual({ enabled: true, threshold: 9 });
  });
});
