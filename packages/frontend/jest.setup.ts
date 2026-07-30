// The SDK logger defaults to `debug` whenever `__DEV__` is true, which jest-expo
// sets. Install the app's own transport policy instead so a test run shows the
// same (scrubbed, `info`-and-above) output the app itself produces.
import { configureAppLogging } from '@/lib/logging';

configureAppLogging();
