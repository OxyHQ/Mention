/**
 * Home's own stack: on iOS, the navigation controller of the Home tab; on
 * Android, inside Bloom's pager, and on the web, the page in place. It holds
 * Home alone: everything opened from it is pushed over the tabs, in the app's
 * stack. A group, so Home's URL stays `/`; its tab is `(home)`.
 */
import { layout, Stack } from '@oxy.so/bloom-language/router';

export default layout(() => Stack());
