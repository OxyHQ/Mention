import type { AccountNode } from '@oxyhq/core';
import { operatesAccount, operatesAccountNode } from '../operatedAccounts';

/**
 * "Do I operate this account?" — the predicate the profile menu hides mute, block
 * and report on.
 *
 * It has to give the SAME answer the backend gives, because the backend refuses
 * the action and this only declines to offer it: if the two disagree, one of them
 * is drawing a button the other 400s. So the cases below are the two families
 * `services/publishAsAccount.ts` distinguishes, and each admission is paired with
 * the near-miss that must be refused — a member without `account:act_as` is the
 * one that tells "reads the permission" apart from "reads membership".
 */

const VIEWER_ORG = 'account-org';

function node(overrides: Partial<AccountNode> & Pick<AccountNode, 'accountId' | 'kind'>): AccountNode {
  return {
    parentAccountId: null,
    account: { id: overrides.accountId } as AccountNode['account'],
    relationship: 'member' as AccountNode['relationship'],
    callerMembership: null,
    ...overrides,
  } as AccountNode;
}

function membership(
  status: string,
  permissions: unknown,
): AccountNode['callerMembership'] {
  return {
    memberUserId: 'viewer',
    status,
    permissions,
  } as unknown as AccountNode['callerMembership'];
}

describe('operatesAccountNode — a channel', () => {
  it('is operated by any ACTIVE member, with no permission required', () => {
    // A channel can never be acted as, so membership is the strongest right
    // there is over it — matching what the backend admits.
    expect(
      operatesAccountNode(
        node({ accountId: 'c1', kind: 'channel', callerMembership: membership('active', []) }),
      ),
    ).toBe(true);
  });

  it('is NOT operated by a member whose membership is not active', () => {
    expect(
      operatesAccountNode(
        node({ accountId: 'c1', kind: 'channel', callerMembership: membership('invited', []) }),
      ),
    ).toBe(false);
  });
});

describe('operatesAccountNode — an act-as-eligible account', () => {
  it('is operated by an active member holding account:act_as', () => {
    expect(
      operatesAccountNode(
        node({
          accountId: VIEWER_ORG,
          kind: 'organization',
          callerMembership: membership('active', ['account:act_as']),
        }),
      ),
    ).toBe(true);
  });

  it('is NOT operated by an active member WITHOUT account:act_as', () => {
    // The case the whole two-family rule exists for. A `billing` or `viewer`
    // member is a member who deliberately may not speak as the account, so they
    // keep every affordance a stranger has — reporting it included.
    expect(
      operatesAccountNode(
        node({
          accountId: VIEWER_ORG,
          kind: 'organization',
          callerMembership: membership('active', ['billing:read']),
        }),
      ),
    ).toBe(false);
  });

  it('applies the same rule to a project and a bot, not just an organization', () => {
    for (const kind of ['project', 'bot'] as const) {
      expect(
        operatesAccountNode(
          node({ accountId: 'x', kind, callerMembership: membership('active', []) }),
        ),
      ).toBe(false);
      expect(
        operatesAccountNode(
          node({
            accountId: 'x',
            kind,
            callerMembership: membership('active', ['account:act_as']),
          }),
        ),
      ).toBe(true);
    }
  });

  it('refuses a permissions field that is not an array', () => {
    // `permissions` arrives over the wire. A malformed value is a refusal, never
    // an assumption — the same reading the backend gate takes.
    for (const permissions of ['account:act_as', { 'account:act_as': true }, null, undefined]) {
      expect(
        operatesAccountNode(
          node({
            accountId: VIEWER_ORG,
            kind: 'organization',
            callerMembership: membership('active', permissions),
          }),
        ),
      ).toBe(false);
    }
  });
});

describe('operatesAccountNode — an absent membership', () => {
  it('reads as NOT operated', () => {
    // `AccountNode` documents `null` as covering both "ownership is implicit" and
    // "no membership at all". The ambiguous value takes the direction that keeps
    // block and report available; a personal root is answered by comparing ids.
    expect(operatesAccountNode(node({ accountId: 'c1', kind: 'channel' }))).toBe(false);
    expect(operatesAccountNode(node({ accountId: 'p1', kind: 'personal' }))).toBe(false);
  });
});

describe('operatesAccount — looking one account up in the list', () => {
  const list: AccountNode[] = [
    node({ accountId: 'operated', kind: 'channel', callerMembership: membership('active', []) }),
    node({
      accountId: 'member-only',
      kind: 'organization',
      callerMembership: membership('active', ['billing:read']),
    }),
  ];

  it('finds an account the viewer operates', () => {
    expect(operatesAccount(list, 'operated')).toBe(true);
  });

  it('does NOT claim an account that is merely in the list', () => {
    // Presence in the account graph is not operating it. A predicate that only
    // matched `accountId` would pass every other case in this file and fail here.
    expect(operatesAccount(list, 'member-only')).toBe(false);
  });

  it('does not claim an account that is absent from the list', () => {
    expect(operatesAccount(list, 'a-stranger')).toBe(false);
  });

  it('answers NOT operated while the list is still loading, and if it failed', () => {
    // The load-bearing failure direction, as its own case. `undefined` is both
    // "loading" and "the request failed", and both must leave block and report on
    // screen — withholding a safety affordance from somebody who needs it is a
    // worse outcome than offering a pointless one to an operator, which the server
    // refuses anyway.
    expect(operatesAccount(undefined, 'operated')).toBe(false);
  });

  it('answers NOT operated for an empty list and a missing account id', () => {
    expect(operatesAccount([], 'operated')).toBe(false);
    expect(operatesAccount(list, undefined)).toBe(false);
    expect(operatesAccount(list, '')).toBe(false);
  });
});
