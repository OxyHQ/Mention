import { __webTelemetryForTests } from '@/lib/webTelemetry.web';

describe('web telemetry cardinality guards', () => {
  it('removes identifiers from route labels', () => {
    expect(__webTelemetryForTests.routeBucket('/p/507f1f77bcf86cd799439011'))
      .toBe('/post');
    expect(__webTelemetryForTests.routeBucket('/@alice@remote.example'))
      .toBe('/profile');
    expect(__webTelemetryForTests.routeBucket('/unknown/private-value'))
      .toBe('/other');
  });

  it('maps browser-specific history restores to the bounded vocabulary', () => {
    expect(__webTelemetryForTests.normalizeNavigation('back-forward-cache'))
      .toBe('back-forward');
    expect(__webTelemetryForTests.normalizeNavigation('unexpected'))
      .toBe('other');
  });
});
