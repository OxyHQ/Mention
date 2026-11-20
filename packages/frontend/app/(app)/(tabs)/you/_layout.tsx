/**
 * This page's own stack: on iOS, the navigation controller its header is the
 * system navigation bar of; on Android it is the predictive-back stack and on
 * the web the route in place. It holds the page alone: everything opened from
 * it is pushed over the tabs, in the app's stack.
 */
import { layout, Stack } from '@oxy.so/bloom-language/router';

export default layout(() => Stack());
