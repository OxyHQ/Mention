import { Router, Response } from 'express';
import multer from 'multer';
import Series, { RecurrenceType } from '../models/Series';
import Room, { RoomStatus, RoomType, OwnerType, SpeakerPermission } from '../models/Room';
import House, { HouseMemberRole } from '../models/House';
import { AuthRequest } from '../types/auth';
import { logger } from '../utils/logger';
import { processImage } from '../utils/imageProcessor';
import { uploadObject, deleteObject, getAgoraSeriesCoverKey } from '../utils/spaces';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = Router();

/**
 * Create a series
 * POST /api/series
 *
 * If houseId is provided, the user must be HOST or higher in that house.
 * Otherwise, the series belongs to the user's profile.
 */
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const {
      title,
      description,
      coverImage,
      houseId,
      recurrence,
      roomTemplate,
    } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return res.status(400).json({ message: 'Title is required' });
    }

    if (!recurrence || typeof recurrence !== 'object') {
      return res.status(400).json({ message: 'Recurrence schedule is required' });
    }

    if (!roomTemplate || typeof roomTemplate !== 'object') {
      return res.status(400).json({ message: 'Room template is required' });
    }

    // Validate recurrence
    if (!recurrence.type || !Object.values(RecurrenceType).includes(recurrence.type)) {
      return res.status(400).json({ message: 'Invalid recurrence type' });
    }

    if (!recurrence.time || typeof recurrence.time !== 'string' || !/^\d{2}:\d{2}$/.test(recurrence.time)) {
      return res.status(400).json({ message: 'Recurrence time is required in HH:mm format' });
    }

    if (!recurrence.timezone || typeof recurrence.timezone !== 'string') {
      return res.status(400).json({ message: 'Recurrence timezone is required' });
    }

    // Validate roomTemplate
    if (!roomTemplate.titlePattern || typeof roomTemplate.titlePattern !== 'string') {
      return res.status(400).json({ message: 'Room template titlePattern is required' });
    }

    // If houseId provided, validate house membership
    if (houseId && typeof houseId === 'string') {
      const house = await House.findById(houseId);
      if (!house) {
        return res.status(404).json({ message: 'House not found' });
      }

      if (!house.hasRole(userId, HouseMemberRole.HOST)) {
        return res.status(403).json({ message: 'You must be a host or higher in this house to create series' });
      }
    }

    // Resolve room template type
    const templateType: RoomType = roomTemplate.type && Object.values(RoomType).includes(roomTemplate.type)
      ? roomTemplate.type
      : RoomType.TALK;

    const templateSpeakerPermission: SpeakerPermission =
      roomTemplate.speakerPermission && Object.values(SpeakerPermission).includes(roomTemplate.speakerPermission)
        ? roomTemplate.speakerPermission
        : SpeakerPermission.INVITED;

    const series = new Series({
      title: title.trim(),
      description: description ? String(description).trim() : undefined,
      coverImage: coverImage ? String(coverImage).trim() : undefined,
      houseId: houseId || undefined,
      createdBy: userId,
      recurrence: {
        type: recurrence.type,
        dayOfWeek: typeof recurrence.dayOfWeek === 'number' ? recurrence.dayOfWeek : undefined,
        dayOfMonth: typeof recurrence.dayOfMonth === 'number' ? recurrence.dayOfMonth : undefined,
        time: recurrence.time,
        timezone: recurrence.timezone,
      },
      roomTemplate: {
        titlePattern: roomTemplate.titlePattern.trim(),
        type: templateType,
        description: roomTemplate.description ? String(roomTemplate.description).trim() : undefined,
        maxParticipants: roomTemplate.maxParticipants && typeof roomTemplate.maxParticipants === 'number'
          ? Math.min(Math.max(roomTemplate.maxParticipants, 1), 10000)
          : 100,
        speakerPermission: templateSpeakerPermission,
        tags: Array.isArray(roomTemplate.tags)
          ? roomTemplate.tags.map((t: unknown) => String(t).trim()).filter(Boolean)
          : [],
      },
      episodes: [],
      nextEpisodeNumber: 1,
      isActive: true,
    });

    await series.save();

    logger.info(`Series created: ${series._id} by ${userId}${houseId ? ` (house=${houseId})` : ''}`);

    res.status(201).json({
      message: 'Series created successfully',
      series,
    });
  } catch (error) {
    logger.error('Error creating series:', { userId: req.user?.id, error });
    res.status(500).json({
      message: 'Error creating series',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get series details
 * GET /api/series/:id
 */
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const series = await Series.findById(id).lean();

    if (!series) {
      return res.status(404).json({ message: 'Series not found' });
    }

    res.json({ series });
  } catch (error) {
    logger.error('Error fetching series:', { userId: req.user?.id, seriesId: req.params.id, error });
    res.status(500).json({
      message: 'Error fetching series',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Update series (creator or house admin+)
 * PATCH /api/series/:id
 */
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { title, description, coverImage, recurrence, roomTemplate, isActive } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const series = await Series.findById(id);

    if (!series) {
      return res.status(404).json({ message: 'Series not found' });
    }

    // Permission check: creator or house admin+
    let hasPermission = series.createdBy === userId;

    if (!hasPermission && series.houseId) {
      const house = await House.findById(series.houseId);
      if (house && house.hasRole(userId, HouseMemberRole.ADMIN)) {
        hasPermission = true;
      }
    }

    if (!hasPermission) {
      return res.status(403).json({ message: 'You do not have permission to update this series' });
    }

    // Apply updates
    if (title !== undefined && typeof title === 'string' && title.trim().length > 0) {
      series.title = title.trim();
    }
    if (description !== undefined) {
      series.description = description ? String(description).trim() : undefined;
    }
    if (coverImage !== undefined) {
      series.coverImage = coverImage ? String(coverImage).trim() : undefined;
    }
    if (typeof isActive === 'boolean') {
      series.isActive = isActive;
    }

    // Update recurrence if provided
    if (recurrence && typeof recurrence === 'object') {
      if (recurrence.type && Object.values(RecurrenceType).includes(recurrence.type)) {
        series.recurrence.type = recurrence.type;
      }
      if (typeof recurrence.dayOfWeek === 'number') {
        series.recurrence.dayOfWeek = recurrence.dayOfWeek;
      }
      if (typeof recurrence.dayOfMonth === 'number') {
        series.recurrence.dayOfMonth = recurrence.dayOfMonth;
      }
      if (recurrence.time && typeof recurrence.time === 'string' && /^\d{2}:\d{2}$/.test(recurrence.time)) {
        series.recurrence.time = recurrence.time;
      }
      if (recurrence.timezone && typeof recurrence.timezone === 'string') {
        series.recurrence.timezone = recurrence.timezone;
      }
    }

    // Update roomTemplate if provided
    if (roomTemplate && typeof roomTemplate === 'object') {
      if (roomTemplate.titlePattern && typeof roomTemplate.titlePattern === 'string') {
        series.roomTemplate.titlePattern = roomTemplate.titlePattern.trim();
      }
      if (roomTemplate.type && Object.values(RoomType).includes(roomTemplate.type)) {
        series.roomTemplate.type = roomTemplate.type;
      }
      if (roomTemplate.description !== undefined) {
        series.roomTemplate.description = roomTemplate.description
          ? String(roomTemplate.description).trim()
          : undefined;
      }
      if (roomTemplate.maxParticipants && typeof roomTemplate.maxParticipants === 'number') {
        series.roomTemplate.maxParticipants = Math.min(Math.max(roomTemplate.maxParticipants, 1), 10000);
      }
      if (roomTemplate.speakerPermission && Object.values(SpeakerPermission).includes(roomTemplate.speakerPermission)) {
        series.roomTemplate.speakerPermission = roomTemplate.speakerPermission;
      }
      if (roomTemplate.tags !== undefined && Array.isArray(roomTemplate.tags)) {
        series.roomTemplate.tags = roomTemplate.tags.map((t: unknown) => String(t).trim()).filter(Boolean);
      }
    }

    await series.save();

    logger.info(`Series updated: ${id} by ${userId}`);

    res.json({
      message: 'Series updated successfully',
      series,
    });
  } catch (error) {
    logger.error('Error updating series:', { userId: req.user?.id, seriesId: req.params.id, error });
    res.status(500).json({
      message: 'Error updating series',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Delete series (creator or house admin+)
 * DELETE /api/series/:id
 */
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const series = await Series.findById(id);

    if (!series) {
      return res.status(404).json({ message: 'Series not found' });
    }

    // Permission check: creator or house admin+
    let hasPermission = series.createdBy === userId;

    if (!hasPermission && series.houseId) {
      const house = await House.findById(series.houseId);
      if (house && house.hasRole(userId, HouseMemberRole.ADMIN)) {
        hasPermission = true;
      }
    }

    if (!hasPermission) {
      return res.status(403).json({ message: 'You do not have permission to delete this series' });
    }

    await Series.findByIdAndDelete(id);

    logger.info(`Series deleted: ${id} by ${userId}`);

    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting series:', { userId: req.user?.id, seriesId: req.params.id, error });
    res.status(500).json({
      message: 'Error deleting series',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Generate the next episode room from the series template
 * POST /api/series/:id/generate-episode
 */
router.post('/:id/generate-episode', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;
    const { scheduledStart } = req.body;

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const series = await Series.findById(id);

    if (!series) {
      return res.status(404).json({ message: 'Series not found' });
    }

    if (!series.isActive) {
      return res.status(400).json({ message: 'Series is not active' });
    }

    // Permission check: creator or house admin+
    let hasPermission = series.createdBy === userId;

    if (!hasPermission && series.houseId) {
      const house = await House.findById(series.houseId);
      if (house && house.hasRole(userId, HouseMemberRole.ADMIN)) {
        hasPermission = true;
      }
    }

    if (!hasPermission) {
      return res.status(403).json({ message: 'You do not have permission to generate episodes for this series' });
    }

    // Resolve the scheduled start date
    let scheduledStartDate: Date;
    if (scheduledStart) {
      scheduledStartDate = new Date(scheduledStart);
      if (isNaN(scheduledStartDate.getTime())) {
        return res.status(400).json({ message: 'Invalid scheduledStart date' });
      }
    } else {
      // Default: schedule for now
      scheduledStartDate = new Date();
    }

    const episodeNumber = series.nextEpisodeNumber;

    // Generate the title from the pattern (replace {n} with episode number)
    const title = series.roomTemplate.titlePattern.replace(/\{n\}/g, String(episodeNumber));

    // Determine ownerType and houseId
    const ownerType = series.houseId ? OwnerType.HOUSE : OwnerType.PROFILE;

    // Create the room from the template
    const room = new Room({
      title,
      description: series.roomTemplate.description,
      host: userId,
      type: series.roomTemplate.type,
      ownerType,
      houseId: series.houseId || undefined,
      status: RoomStatus.SCHEDULED,
      participants: [],
      speakers: [userId],
      maxParticipants: series.roomTemplate.maxParticipants,
      scheduledStart: scheduledStartDate,
      tags: series.roomTemplate.tags,
      speakerPermission: series.roomTemplate.speakerPermission,
      seriesId: series._id.toString(),
      stats: {
        peakListeners: 0,
        totalJoined: 0,
      },
    });

    await room.save();

    // Record the episode in the series
    series.episodes.push({
      roomId: room._id.toString(),
      scheduledStart: scheduledStartDate,
      episodeNumber,
    });
    series.nextEpisodeNumber = episodeNumber + 1;
    await series.save();

    logger.info(`Episode ${episodeNumber} generated for series ${id}: room ${room._id}`);

    res.status(201).json({
      message: 'Episode generated successfully',
      room,
      episodeNumber,
    });
  } catch (error) {
    logger.error('Error generating episode:', { userId: req.user?.id, seriesId: req.params.id, error });
    res.status(500).json({
      message: 'Error generating episode',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ---------------------------------------------------------------------------
// Series cover upload
// ---------------------------------------------------------------------------

/**
 * Upload series cover image
 * POST /api/series/:id/cover
 */
router.post('/:id/cover', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    const { id } = req.params;

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    if (!req.file) return res.status(400).json({ message: 'No file provided' });

    const series = await Series.findById(id);
    if (!series) return res.status(404).json({ message: 'Series not found' });

    let hasPermission = series.createdBy === userId;
    if (!hasPermission && series.houseId) {
      const house = await House.findById(series.houseId);
      if (house && house.hasRole(userId, HouseMemberRole.ADMIN)) hasPermission = true;
    }
    if (!hasPermission) return res.status(403).json({ message: 'You do not have permission to update this series' });

    const { buffer, contentType } = await processImage(req.file.buffer, 'cover');
    const objectKey = getAgoraSeriesCoverKey(id as string);

    if (series.coverImage?.startsWith('https://cloud.mention.earth/')) {
      const oldKey = series.coverImage.replace('https://cloud.mention.earth/', '');
      deleteObject(oldKey).catch(() => {});
    }

    const cdnUrl = await uploadObject(objectKey, buffer, contentType, 'public-read');
    series.coverImage = cdnUrl;
    await series.save();

    res.json({ coverImage: cdnUrl });
  } catch (error) {
    logger.error('Error uploading series cover:', { seriesId: req.params.id, error });
    res.status(500).json({ message: 'Error uploading cover', error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export default router;
