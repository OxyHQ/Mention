/**
 * The five root pages — camera, Home, Videos, the composer, Notifications and
 * the profile — declared in `MentionNavigation`. In the Bloom language, the
 * tabs group's navigator: the system tab bar on iOS, Bloom's tab pager on
 * Android (swiped between) and the web (routed in place).
 */
import { layout, TabView } from '@oxy.so/bloom-language/router';

export default layout(() => TabView());
