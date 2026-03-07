import mongoose from 'mongoose';
import { Labeler, ILabeler, ILabelDefinition } from '../models/Labeler';
import { ContentLabel } from '../models/ContentLabel';
import UserSettings from '../models/UserSettings';
import { logger } from '../utils/logger';

export interface CreateLabelerData {
  name: string;
  description?: string;
  creatorId: string;
  isOfficial?: boolean;
  labelDefinitions?: ILabelDefinition[];
}

export interface ApplyLabelData {
  labelerId: string;
  targetType: 'post' | 'user';
  targetId: string;
  labelSlug: string;
  createdBy: string;
  reason?: string;
}

export class LabelService {
  /**
   * Create a new labeler
   */
  static async createLabeler(data: CreateLabelerData): Promise<ILabeler> {
    const labeler = await Labeler.create({
      name: data.name,
      description: data.description,
      creatorId: data.creatorId,
      isOfficial: data.isOfficial ?? false,
      labelDefinitions: data.labelDefinitions ?? [],
    });
    logger.info('[LabelService] Created labeler', { labelerId: String(labeler._id), creatorId: data.creatorId });
    return labeler;
  }

  /**
   * List labelers with optional search on name/description
   */
  static async getLabelers(filters?: { search?: string }): Promise<ILabeler[]> {
    const query: Record<string, unknown> = {};

    if (filters?.search && filters.search.trim()) {
      const escaped = filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = new RegExp(escaped, 'i');
      query.$or = [
        { name: searchRegex },
        { description: searchRegex },
      ];
    }

    return Labeler.find(query).sort({ subscriberCount: -1, createdAt: -1 }).lean() as unknown as ILabeler[];
  }

  /**
   * Get a single labeler by id
   */
  static async getLabelerById(id: string): Promise<ILabeler | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    return Labeler.findById(id).lean() as unknown as ILabeler | null;
  }

  /**
   * Subscribe a user to a labeler — adds to UserSettings and increments subscriberCount
   */
  static async subscribeToLabeler(userId: string, labelerId: string): Promise<void> {
    if (!mongoose.Types.ObjectId.isValid(labelerId)) {
      throw new Error('Invalid labeler id');
    }

    const labeler = await Labeler.findById(labelerId);
    if (!labeler) throw new Error('Labeler not found');

    // Add labelerId to user's subscribedLabelers (avoid duplicates)
    const settings = await UserSettings.findOneAndUpdate(
      { oxyUserId: userId },
      {
        $addToSet: { 'privacy.labelPreferences.subscribedLabelers': labelerId },
      },
      { upsert: true, new: true }
    );

    // Only increment if the labeler wasn't already in the list before this update
    // We detect a new subscription by checking if the result contains the id
    const subscribedList: string[] = settings?.privacy?.labelPreferences?.subscribedLabelers ?? [];
    const wasAlreadySubscribed = subscribedList.filter(id => id === labelerId).length > 1;
    if (!wasAlreadySubscribed) {
      await Labeler.findByIdAndUpdate(labelerId, { $inc: { subscriberCount: 1 } });
    }

    logger.info('[LabelService] User subscribed to labeler', { userId, labelerId });
  }

  /**
   * Unsubscribe a user from a labeler — removes from UserSettings and decrements subscriberCount
   */
  static async unsubscribeFromLabeler(userId: string, labelerId: string): Promise<void> {
    if (!mongoose.Types.ObjectId.isValid(labelerId)) {
      throw new Error('Invalid labeler id');
    }

    const settings = await UserSettings.findOne({ oxyUserId: userId });
    const subscribedList: string[] = settings?.privacy?.labelPreferences?.subscribedLabelers ?? [];
    const wasSubscribed = subscribedList.includes(labelerId);

    if (!wasSubscribed) {
      logger.info('[LabelService] User was not subscribed to labeler', { userId, labelerId });
      return;
    }

    await UserSettings.findOneAndUpdate(
      { oxyUserId: userId },
      { $pull: { 'privacy.labelPreferences.subscribedLabelers': labelerId } }
    );

    await Labeler.findByIdAndUpdate(labelerId, { $inc: { subscriberCount: -1 } });

    logger.info('[LabelService] User unsubscribed from labeler', { userId, labelerId });
  }

  /**
   * Apply a label to a piece of content — validates labelSlug exists in labeler definitions
   */
  static async applyLabel(data: ApplyLabelData) {
    if (!mongoose.Types.ObjectId.isValid(data.labelerId)) {
      throw new Error('Invalid labeler id');
    }

    const labeler = await Labeler.findById(data.labelerId);
    if (!labeler) throw new Error('Labeler not found');

    const definitionExists = labeler.labelDefinitions.some(
      (def: ILabelDefinition) => def.slug === data.labelSlug
    );
    if (!definitionExists) {
      throw new Error(`Label slug '${data.labelSlug}' does not exist in this labeler`);
    }

    const label = await ContentLabel.create({
      labelerId: new mongoose.Types.ObjectId(data.labelerId),
      targetType: data.targetType,
      targetId: data.targetId,
      labelSlug: data.labelSlug,
      createdBy: data.createdBy,
      reason: data.reason,
    });

    logger.info('[LabelService] Applied label', {
      labelId: String(label._id),
      labelerId: data.labelerId,
      targetType: data.targetType,
      targetId: data.targetId,
      labelSlug: data.labelSlug,
    });

    return label;
  }

  /**
   * Remove a content label — only the original creator may remove it
   */
  static async removeLabel(id: string, userId: string): Promise<boolean> {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new Error('Invalid label id');

    const label = await ContentLabel.findById(id);
    if (!label) throw new Error('Label not found');
    if (label.createdBy !== userId) throw new Error('Not authorised to remove this label');

    await label.deleteOne();
    logger.info('[LabelService] Removed label', { labelId: id, userId });
    return true;
  }

  /**
   * Get all labels applied to a specific piece of content, populated with labeler name
   */
  static async getLabelsForContent(targetType: 'post' | 'user', targetId: string) {
    const labels = await ContentLabel.find({ targetType, targetId })
      .populate<{ labelerId: Pick<ILabeler, 'name'> }>('labelerId', 'name')
      .lean();
    return labels;
  }

  /**
   * Get the user's subscribed labelers and their label action preferences
   */
  static async getUserEffectiveLabels(userId: string) {
    const settings = await UserSettings.findOne({ oxyUserId: userId }).lean();
    const labelPreferences = settings?.privacy?.labelPreferences;

    const subscribedLabelerIds: string[] = labelPreferences?.subscribedLabelers ?? [];
    const labelActions = labelPreferences?.labelActions ?? [];

    let labelers: ILabeler[] = [];
    if (subscribedLabelerIds.length > 0) {
      const validIds = subscribedLabelerIds.filter(id => mongoose.Types.ObjectId.isValid(id));
      labelers = await Labeler.find({ _id: { $in: validIds } }).lean() as unknown as ILabeler[];
    }

    return { labelers, labelActions };
  }
}

export default LabelService;
