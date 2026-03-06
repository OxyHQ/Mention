import Recording, { RecordingStatus } from '../models/Recording';
import { deleteRecordingFromSpaces } from '../utils/spaces';
import { stopRoomRecording } from '../utils/livekit';
import Room from '../models/Room';
import { logger } from '../utils/logger';

export class RecordingCleanupService {
  private interval: NodeJS.Timeout | null = null;
  private isRunning = false;

  private readonly INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
  private readonly BATCH_SIZE = 50;

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Recover orphaned recordings on startup (server may have restarted during active recording)
    setTimeout(() => {
      this.recoverOrphanedRecordings().catch(err =>
        logger.error('Error recovering orphaned recordings:', err)
      );
    }, 30 * 1000); // 30 seconds after startup

    // Run cleanup after 1 minute
    setTimeout(() => {
      this.cleanup().catch(err =>
        logger.error('Error in recording cleanup:', err)
      );
    }, 60 * 1000);

    this.interval = setInterval(() => {
      this.cleanup().catch(err =>
        logger.error('Error in recording cleanup:', err)
      );
    }, this.INTERVAL_MS);

    logger.info('Recording cleanup service started');
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    logger.info('Recording cleanup service stopped');
  }

  /**
   * Find recordings stuck in 'recording' status (orphaned from server restart)
   * and stop them or mark them as failed.
   */
  private async recoverOrphanedRecordings(): Promise<void> {
    const orphaned = await Recording.find({
      status: RecordingStatus.RECORDING,
    }).lean();

    if (orphaned.length === 0) return;

    logger.info(`Found ${orphaned.length} orphaned recordings, recovering...`);

    for (const rec of orphaned) {
      try {
        // Try to stop the egress (may have already stopped)
        try {
          await stopRoomRecording(rec.egressId);
        } catch {
          // Egress may already be stopped
        }

        // Mark as ready (optimistic) or failed
        await Recording.findByIdAndUpdate(rec._id, {
          status: RecordingStatus.READY,
          stoppedAt: new Date(),
          durationMs: new Date().getTime() - new Date(rec.startedAt).getTime(),
        });

        // Clear room's recordingEgressId
        await Room.findByIdAndUpdate(rec.roomId, { recordingEgressId: null });

        logger.info(`Recovered orphaned recording ${rec._id} for room ${rec.roomId}`);
      } catch (error) {
        logger.error(`Failed to recover orphaned recording ${rec._id}:`, error);
        await Recording.findByIdAndUpdate(rec._id, {
          status: RecordingStatus.FAILED,
        });
      }
    }
  }

  private async cleanup(): Promise<void> {
    const now = new Date();

    // Delete expired recordings
    const expired = await Recording.find({
      expiresAt: { $lte: now },
      status: { $in: [RecordingStatus.READY, RecordingStatus.PROCESSING] },
    })
      .limit(this.BATCH_SIZE)
      .lean();

    if (expired.length === 0) {
      logger.debug('No expired recordings to clean up');
    } else {
      logger.info(`Cleaning up ${expired.length} expired recordings`);

      let deleted = 0;
      let failed = 0;

      for (const recording of expired) {
        try {
          await deleteRecordingFromSpaces(recording.objectKey);
          await Recording.findByIdAndUpdate(recording._id, {
            status: RecordingStatus.DELETED,
          });
          deleted++;
        } catch (error) {
          logger.error(`Failed to clean up recording ${recording._id}:`, error);
          failed++;
        }
      }

      logger.info(`Recording cleanup complete: ${deleted} deleted, ${failed} failed`);
    }

    // Clean up failed recordings older than 24 hours
    const failedCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const failedResult = await Recording.deleteMany({
      status: RecordingStatus.FAILED,
      createdAt: { $lte: failedCutoff },
    });
    if (failedResult.deletedCount > 0) {
      logger.info(`Cleaned up ${failedResult.deletedCount} failed recordings`);
    }
  }
}

export const recordingCleanupService = new RecordingCleanupService();
