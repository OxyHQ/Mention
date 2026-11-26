/**
 * The real `User` entity and `storeUsers` of `@oxy.so/services` (Services 15:
 * the people the SDK reads, in the account's `@oxy.so/bloom-data` store), for
 * tests that mock `@oxy.so/services/ui/client` and still exercise Mention's
 * actor cache against the SDK's own merge:
 *
 *   jest.mock('@oxy.so/services/ui/client', () => ({
 *     ...require('@/test-support/oxyUsers').oxyUsers,
 *     useAuth: () => ...,
 *   }));
 *
 * Loaded by file path: the package exports only its entry points, and the
 * entry would load the whole SDK.
 */
const path = require('node:path');

const user = require(
  path.join(__dirname, '../../../node_modules/@oxy.so/services/lib/commonjs/ui/data/user.js'),
);

module.exports = {
  oxyUsers: { User: user.User, storeUsers: user.storeUsers },
  User: user.User,
  storeUsers: user.storeUsers,
};
