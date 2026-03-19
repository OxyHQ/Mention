import mongoose from 'mongoose';
import { logger } from './logger';

/**
 * Lazy connection to the Oxy database for cross-database operations.
 * Uses the same MONGODB_URI cluster but targets the oxy-{env} database.
 */
let oxyConnection: mongoose.Connection | null = null;

function getOxyDbName(): string {
  const env = process.env.NODE_ENV || 'development';
  const envMap: Record<string, string> = { production: 'prod', development: 'dev' };
  return `oxy-${envMap[env] || env}`;
}

function getOxyConnection(): mongoose.Connection {
  if (oxyConnection && oxyConnection.readyState === 1) {
    return oxyConnection;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');

  oxyConnection = mongoose.createConnection(uri, { dbName: getOxyDbName() });
  oxyConnection.on('error', (err) => {
    logger.warn('Oxy DB connection error:', err);
  });

  return oxyConnection;
}

/**
 * Upsert a federated actor as an Oxy User document.
 * Keyed by federation.actorUri for idempotent upserts.
 */
export async function upsertFederatedOxyUser(actor: {
  actorUri: string;
  domain: string;
  username: string;
  displayName?: string;
  avatar?: string;
  bio?: string;
  actorId: string;
}): Promise<string | null> {
  try {
    const conn = getOxyConnection();
    const usersCollection = conn.collection('users');

    const result = await usersCollection.findOneAndUpdate(
      { 'federation.actorUri': actor.actorUri },
      {
        $set: {
          type: 'federated',
          username: actor.username,
          'name.first': actor.displayName || actor.username,
          avatar: actor.avatar,
          bio: actor.bio,
          description: actor.bio,
          'federation.actorUri': actor.actorUri,
          'federation.domain': actor.domain,
          'federation.actorId': actor.actorId,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
          privacySettings: {
            isPrivateAccount: false,
            hideOnlineStatus: false,
            hideLastSeen: false,
            profileVisibility: true,
            loginAlerts: false,
            blockScreenshots: false,
            login: false,
            biometricLogin: false,
            showActivity: true,
            allowTagging: true,
            allowMentions: true,
            hideReadReceipts: false,
            allowDirectMessages: false,
            dataSharing: false,
            locationSharing: false,
            analyticsSharing: false,
            sensitiveContent: false,
            autoFilter: false,
            muteKeywords: false,
          },
          following: [],
          followers: [],
          _count: { followers: 0, following: 0 },
        },
      },
      { upsert: true, returnDocument: 'after' }
    );

    const oxyUserId = result?._id?.toString();
    if (oxyUserId) {
      logger.debug(`Upserted federated Oxy user: ${actor.username} (${oxyUserId})`);
    }
    return oxyUserId || null;
  } catch (err) {
    logger.warn('Failed to upsert federated Oxy user:', err);
    return null;
  }
}
