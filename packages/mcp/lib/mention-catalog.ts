import type { AppCapabilityCatalog } from "@oxyhq/contracts";
import { registerAccountTools } from "../tools/accounts.js";
import { registerFeedTools } from "../tools/feed.js";
import { registerHashtagsTools } from "../tools/hashtags.js";
import { registerInteractionsTools } from "../tools/interactions.js";
import { registerListsTools } from "../tools/lists.js";
import { registerMediaTools } from "../tools/media.js";
import { registerNotificationsTools } from "../tools/notifications.js";
import { registerPollsTools } from "../tools/polls.js";
import { registerPostsTools } from "../tools/posts.js";
import { registerProfileTools } from "../tools/profile.js";
import { registerSearchTools } from "../tools/search.js";
import { registerSocialTools } from "../tools/social.js";
import { registerStarterPackTools } from "../tools/starter-packs.js";
import { MENTION_TOOL_POLICIES } from "./tool-policies.js";
import { MentionToolRegistry } from "./tool-registry.js";

function buildRegistry(): MentionToolRegistry {
  const registry = new MentionToolRegistry(MENTION_TOOL_POLICIES);
  registerPostsTools(registry);
  registerFeedTools(registry);
  registerInteractionsTools(registry);
  registerSearchTools(registry);
  registerListsTools(registry);
  registerNotificationsTools(registry);
  registerPollsTools(registry);
  registerHashtagsTools(registry);
  registerProfileTools(registry);
  registerSocialTools(registry);
  registerStarterPackTools(registry);
  registerAccountTools(registry);
  registerMediaTools(registry);
  registry.assertComplete();
  return registry;
}

export const MENTION_TOOL_REGISTRY = buildRegistry();
export const MENTION_CAPABILITY_CATALOG: AppCapabilityCatalog =
  MENTION_TOOL_REGISTRY.capabilityCatalog();
