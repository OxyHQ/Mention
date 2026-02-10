import { Router, Response } from 'express';
import Recording, { RecordingStatus, RecordingAccess } from '../models/Recording';
import { AuthRequest } from '../types/auth';
import { logger } from '../utils/logger';
import { getRecordingPresignedUrl, deleteRecordingFromSpaces } from '../utils/spaces';

const router = Router();

/**
 * Get a single recording with presigned playback URL
 * GET /api/recordings/:recordingId
 */
router.get('/:recordingId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { recordingId } = req.params;

    const recording = await Recording.findById(recordingId).lean();
    if (!recording || recording.status === RecordingStatus.DELETED) {
      return res.status(404).json({ message: 'Recording not found' });
    }

    if (recording.status !== RecordingStatus.READY) {
      return res.status(400).json({ message: `Recording is not ready (status: ${recording.status})` });
    }

    // Access check
    const isHost = userId === recording.host;
    if (!isHost && recording.access === RecordingAccess.PARTICIPANTS) {
      if (!userId || !recording.participantIds.includes(userId)) {
        return res.status(403).json({ message: 'This recording is only available to participants' });
      }
    }

    const playbackUrl = await getRecordingPresignedUrl(recording.objectKey);

    res.json({
      recording,
      playbackUrl,
    });
  } catch (error) {
    logger.error('Error fetching recording:', { userId: req.user?.id, recordingId: req.params.recordingId, error });
    res.status(500).json({
      message: 'Error fetching recording',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Update recording access level (host only)
 * PATCH /api/recordings/:recordingId
 */
router.patch('/:recordingId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { recordingId } = req.params;
    const { access } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const recording = await Recording.findById(recordingId);
    if (!recording || recording.status === RecordingStatus.DELETED) {
      return res.status(404).json({ message: 'Recording not found' });
    }

    if (recording.host !== userId) {
      return res.status(403).json({ message: 'Only the host can update recording settings' });
    }

    if (access && Object.values(RecordingAccess).includes(access)) {
      recording.access = access;
    } else {
      return res.status(400).json({ message: 'Invalid access value. Must be "public" or "participants".' });
    }

    await recording.save();

    logger.info(`Recording ${recordingId} access updated to ${access} by ${userId}`);

    res.json({ recording });
  } catch (error) {
    logger.error('Error updating recording:', { userId: req.user?.id, recordingId: req.params.recordingId, error });
    res.status(500).json({
      message: 'Error updating recording',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Delete a recording (host only)
 * DELETE /api/recordings/:recordingId
 */
router.delete('/:recordingId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { recordingId } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const recording = await Recording.findById(recordingId);
    if (!recording || recording.status === RecordingStatus.DELETED) {
      return res.status(404).json({ message: 'Recording not found' });
    }

    if (recording.host !== userId) {
      return res.status(403).json({ message: 'Only the host can delete recordings' });
    }

    // Delete file from Spaces
    try {
      await deleteRecordingFromSpaces(recording.objectKey);
    } catch (err) {
      logger.warn(`Failed to delete recording file from Spaces (may already be gone):`, err);
    }

    recording.status = RecordingStatus.DELETED;
    await recording.save();

    logger.info(`Recording ${recordingId} deleted by ${userId}`);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting recording:', { userId: req.user?.id, recordingId: req.params.recordingId, error });
    res.status(500).json({
      message: 'Error deleting recording',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
