import path from 'node:path';
import type { storeUsers as StoreUsers, User as UserEntity } from '@oxy.so/services/ui/client';

/**
 * The Oxy SDK's real `User` entity and its `storeUsers` funnel, without the
 * SDK's UI barrel (`@oxy.so/services/ui/client`), which loads native modules
 * jest has no runtime for. Posts refer to `User` (`data/posts`), so a test that
 * stubs the barrel spreads this into its stub to keep people working:
 *
 *   jest.mock('@oxy.so/services/ui/client', () => ({
 *     ...jest.requireActual('@/test-support/oxyUsers'),
 *     useAuth: () => ...,
 *   }));
 *
 * Read from the SDK's own build of the module, so the merge rules under test
 * are the shipped ones.
 */
const userModule: { User: typeof UserEntity; storeUsers: typeof StoreUsers } = require(
  path.join(require.resolve('@oxy.so/services/package.json'), '../lib/commonjs/ui/data/user.js'),
);

export const User: typeof UserEntity = userModule.User;
export const storeUsers: typeof StoreUsers = userModule.storeUsers;
