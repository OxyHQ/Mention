import express, { type RequestHandler } from 'express';
import type { OxyServices } from '@oxyhq/core';
import postsRouter, { publicPostsRouter } from './routes/posts';
import intentMediaRoutes from './routes/intentMedia';
import healthRoutes from './routes/health.routes';
import { legacyApiRootReadiness } from './routes/legacyRoot.routes';
import notificationsRouter from './routes/notifications';
import listsRoutes from './routes/lists';
import hashtagsRoutes from './routes/hashtags';
import searchRoutes from './routes/search';
import feedRoutes from './routes/feed.routes';
import pollsRoutes from './routes/polls';
import customFeedsRoutes from './routes/customFeeds.routes';
import labelerRoutes from './routes/labeler.routes';
import statisticsRoutes, { publicStatisticsRouter } from './routes/statistics.routes';
import profileSettingsRoutes from './routes/profileSettings';
import profileDesignRoutes from './routes/profileDesign';
import profileMediaRoutes from './routes/profileMedia';
import subscriptionsRoutes from './routes/subscriptions';
import pokesRoutes from './routes/pokes';
import starterPacksRoutes from './routes/starterPacks';
import gifsRoutes from './routes/gifs';
import articlesRoutes from './routes/articles';
import muteRoutes from './routes/mute.routes';
import muteWordsRoutes from './routes/muteWords.routes';
import reportsRoutes from './routes/reports.routes';
import trendingRoutes from './routes/trending.routes';
import topicsRoutes from './routes/topics.routes';
import entityFollowRoutes from './routes/entity-follow.routes';
import mediaRoutes from './routes/media';
import recommendationsRoutes from './routes/recommendations';
import mtnNodesRoutes from './routes/mtn-nodes.routes';
import webShellRoutes from './routes/webShell.routes';
import internalMetricsRoutes from './routes/internalMetrics.routes';
import webTelemetryRoutes from './routes/webTelemetry.routes';
import {
  apexFrontendProxy,
  isApexHost,
  isApexWebPlaneRequest,
} from './middleware/apexFrontendProxy';
import { createMcpOAuthRoutes } from './mcp/routes/mcpOAuth.routes';
import mcpConnectionsRoutes from './mcp/routes/mcpConnections.routes';
import mcpBundlesRoutes from './mcp/routes/mcpBundles.routes';
import {
  createOptionalMcpAuth,
  createRequireMcpOrOxyAuth,
} from './mcp/middleware/mcpAuth';
import {
  webfingerRouter,
  actorRouter,
  apRateLimiter,
} from './connectors/activitypub/routes/engine.routes';
import federationContentRoutes from './connectors/activitypub/routes/ap.routes';
import federationApiRoutes from './connectors/connectors.routes';
import atprotoBridgeRoutes, {
  bridgeMetaRouter as atprotoBridgeMetaRoutes,
  wellKnownBridgeRouter,
} from './connectors/atproto/bridge/routes';

export interface AppRoutes {
  health: RequestHandler;
  internalMetrics: RequestHandler;
  webTelemetry: RequestHandler;
  legacyRoot: RequestHandler;
  webfinger: RequestHandler;
  apRateLimiter: RequestHandler;
  actor: RequestHandler;
  federationContent: RequestHandler;
  atprotoBridge: RequestHandler;
  atprotoBridgeMeta: RequestHandler;
  wellKnownBridge: RequestHandler;
  media: RequestHandler;
  mcpOAuth: RequestHandler;
  webShell: RequestHandler;
  apexProxy: RequestHandler;
  publicApi: RequestHandler;
  requireAuth: RequestHandler;
  authenticatedApi: RequestHandler;
}

export interface CreateAppRoutesDependencies {
  oxy: OxyServices;
  optionalAuth: RequestHandler;
}

/** Compose route groups without creating an HTTP or Socket.IO server. */
export function createAppRoutes({
  oxy,
  optionalAuth,
}: CreateAppRoutesDependencies): AppRoutes {
  const publicApi = express.Router();
  publicApi.use(createOptionalMcpAuth());
  publicApi.use('/hashtags', hashtagsRoutes);
  publicApi.use('/feed', optionalAuth, feedRoutes);
  publicApi.use('/posts', optionalAuth, publicPostsRouter);
  publicApi.use('/profile/design', profileDesignRoutes);
  publicApi.use('/articles', articlesRoutes);
  publicApi.use('/trending', trendingRoutes);
  publicApi.use('/topics', topicsRoutes);
  publicApi.use('/federation', optionalAuth, federationApiRoutes);
  publicApi.use('/feeds', optionalAuth, customFeedsRoutes);
  publicApi.use('/recommendations', optionalAuth, recommendationsRoutes);
  publicApi.use('/starter-packs', optionalAuth, starterPacksRoutes);
  publicApi.use('/mtn/nodes', optionalAuth, mtnNodesRoutes);
  publicApi.use('/statistics', optionalAuth, publicStatisticsRouter);

  const authenticatedApi = express.Router();
  authenticatedApi.use('/posts/intent-media', intentMediaRoutes);
  authenticatedApi.use('/posts', postsRouter);
  authenticatedApi.use('/lists', listsRoutes);
  authenticatedApi.use('/notifications', notificationsRouter);
  authenticatedApi.use('/statistics', statisticsRoutes);
  authenticatedApi.use('/search', searchRoutes);
  authenticatedApi.use('/labelers', labelerRoutes);
  authenticatedApi.use('/polls', pollsRoutes);
  authenticatedApi.use('/profile/media', profileMediaRoutes);
  authenticatedApi.use('/profile', profileSettingsRoutes);
  authenticatedApi.use('/subscriptions', subscriptionsRoutes);
  authenticatedApi.use('/gifs', gifsRoutes);
  authenticatedApi.use('/mute', muteRoutes);
  authenticatedApi.use('/mute-words', muteWordsRoutes);
  authenticatedApi.use('/reports', reportsRoutes);
  authenticatedApi.use('/pokes', pokesRoutes);
  authenticatedApi.use('/entity-follows', entityFollowRoutes);
  authenticatedApi.use('/mcp/connections', mcpConnectionsRoutes);
  authenticatedApi.use('/mcp/bundles', mcpBundlesRoutes);

  return {
    health: healthRoutes,
    internalMetrics: internalMetricsRoutes,
    webTelemetry: webTelemetryRoutes,
    legacyRoot: legacyApiRootReadiness,
    webfinger: webfingerRouter,
    apRateLimiter,
    actor: actorRouter,
    federationContent: federationContentRoutes,
    atprotoBridge: atprotoBridgeRoutes,
    atprotoBridgeMeta: atprotoBridgeMetaRoutes,
    wellKnownBridge: wellKnownBridgeRouter,
    media: mediaRoutes,
    mcpOAuth: createMcpOAuthRoutes(oxy),
    webShell: webShellRoutes,
    apexProxy: apexFrontendProxy,
    publicApi,
    requireAuth: createRequireMcpOrOxyAuth(oxy),
    authenticatedApi,
  };
}

export const appRoutePredicates = {
  isApexHost,
  isApexWebPlaneRequest,
};
