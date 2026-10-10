import { describe, expect, test } from 'bun:test';
import {
  MENTION_TOOL_POLICIES,
  mentionCapabilityRequirementsForRequest,
} from '../src/mcpCapabilities';

describe('Mention MCP capability routes', () => {
  test('matches literal and parameterized domain invocations', () => {
    expect(mentionCapabilityRequirementsForRequest('post', '/posts/abc/like')).toEqual([
      {
        toolName: 'like-post',
        requiredCapabilities: ['social.interact'],
      },
    ]);
    expect(mentionCapabilityRequirementsForRequest('GET', '/notifications/unread-count')).toEqual([
      {
        toolName: 'get-unread-count',
        requiredCapabilities: ['social.notifications.read'],
      },
    ]);
  });

  test('authorizes lane management apart from publishing', () => {
    expect(mentionCapabilityRequirementsForRequest('GET', '/lanes/mine')).toEqual([
      { toolName: 'list-lanes', requiredCapabilities: ['social.lanes.read'] },
    ]);
    expect(mentionCapabilityRequirementsForRequest('PATCH', '/lanes/lane-1')).toEqual([
      { toolName: 'update-lane', requiredCapabilities: ['social.lanes.manage'] },
    ]);
    expect(mentionCapabilityRequirementsForRequest('PATCH', '/posts/post-1/lane')).toEqual([
      { toolName: 'move-post-to-lane', requiredCapabilities: ['social.posts.update'] },
    ]);
    expect(mentionCapabilityRequirementsForRequest('DELETE', '/lanes/lane-1')).toEqual([
      { toolName: 'delete-lane', requiredCapabilities: ['social.lanes.manage'] },
    ]);
    // Muting ANOTHER publisher's lane is a reader preference, not lane management.
    expect(mentionCapabilityRequirementsForRequest('POST', '/lanes/lane-1/mute')).toEqual([
      { toolName: 'mute-lane', requiredCapabilities: ['social.mutes.manage'] },
    ]);
  });

  test('every reversible action has its inverse on the same capability', () => {
    const pairs: Array<[string, string, string, string]> = [
      ['POST', '/feed/boost', 'DELETE', '/feed/post-1/boost'],
      ['POST', '/mute', 'DELETE', '/mute/user-1'],
      ['POST', '/mute-words', 'DELETE', '/mute-words/word-1'],
      ['POST', '/lanes/lane-1/mute', 'DELETE', '/lanes/lane-1/mute'],
      ['POST', '/lists/list-1/members', 'DELETE', '/lists/list-1/members'],
      ['POST', '/subscriptions/user-1', 'DELETE', '/subscriptions/user-1'],
      ['POST', '/pokes/user-1', 'DELETE', '/pokes/user-1'],
      ['POST', '/entity-follows', 'DELETE', '/entity-follows'],
    ];
    for (const [doMethod, doPath, undoMethod, undoPath] of pairs) {
      const [forward] = mentionCapabilityRequirementsForRequest(doMethod, doPath);
      const [inverse] = mentionCapabilityRequirementsForRequest(undoMethod, undoPath);
      expect(forward).toBeDefined();
      expect(inverse).toBeDefined();
      expect(inverse?.requiredCapabilities).toEqual(forward?.requiredCapabilities);
    }
  });

  test('pinning and the other post settings share one route and one capability', () => {
    expect(mentionCapabilityRequirementsForRequest('PATCH', '/posts/post-1/settings')).toEqual([
      { toolName: 'pin-post', requiredCapabilities: ['social.posts.update'] },
      { toolName: 'unpin-post', requiredCapabilities: ['social.posts.update'] },
      { toolName: 'update-post-settings', requiredCapabilities: ['social.posts.update'] },
    ]);
  });

  test('returns every valid requirement when tools deliberately share a route', () => {
    expect(mentionCapabilityRequirementsForRequest('GET', '/feed/item/post-1')).toEqual([
      { toolName: 'get-feed-item', requiredCapabilities: ['social.read'] },
      { toolName: 'get-post', requiredCapabilities: ['social.posts.read'] },
    ]);
  });

  test('does not widen unknown methods, suffixes or routes', () => {
    expect(mentionCapabilityRequirementsForRequest('POST', '/notifications/unread-count')).toEqual(
      [],
    );
    expect(
      mentionCapabilityRequirementsForRequest('GET', '/notifications/unread-count/extra'),
    ).toEqual([]);
    expect(mentionCapabilityRequirementsForRequest('GET', '/admin')).toEqual([]);
  });

  test('keeps all 97 tool policies in the one shared registry', () => {
    expect(Object.keys(MENTION_TOOL_POLICIES)).toHaveLength(97);
  });
});
