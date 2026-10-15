import { eventAccessFor } from '../../services/eventRequestAccess';
import { resolveUserSummaries } from '../../services/PostHydrationService';
import type { Response } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { EventEdit, EventRegistration, EventCancel } from '@mention/contracts';
import {
  cancelEventAttendance,
  editEvent,
  EventError,
  getEventState,
  listEventAttendees,
  registerForEvent,
} from '../../services/EventAttendanceService';
import { logger } from '../../utils/logger';

const Cancel = EventCancel;

function handler(action: 'read' | 'register' | 'withdraw' | 'edit' | 'cancel' | 'attendees') {
  return async (req: OxyAuthRequest, res: Response) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      if (!['read', 'attendees'].includes(action) && !req.user?.id)
        throw new EventError(401, 'unauthorized', 'Sign in to continue');
      const postId = String(req.params.id);
      const access = eventAccessFor(req, postId);
      if (action === 'read') return res.json(await getEventState(postId, access));
      if (action === 'attendees') {
        if (
          Object.keys(req.query).some((k) => k !== 'scope' && k !== 'cursor') ||
          (req.query.scope !== undefined &&
            (typeof req.query.scope !== 'string' ||
              !['public', 'organizers'].includes(req.query.scope))) ||
          (req.query.cursor !== undefined &&
            (typeof req.query.cursor !== 'string' || req.query.cursor.length > 2048))
        ) {
          throw new EventError(400, 'bad_request', 'Invalid attendance query');
        }
        const result = await listEventAttendees(
          postId,
          access,
          req.query.scope === 'organizers',
          req.query.cursor as string | undefined,
        );
        const summaries = await resolveUserSummaries(result.items.map((item) => item.oxyUserId));
        return res.json({
          ...result,
          items: result.items.map((item) => {
            const profile = summaries.get(item.oxyUserId)?.user;
            return {
              ...item,
              displayName: profile?.name?.displayName || profile?.username || undefined,
            };
          }),
        });
      }
      if (action === 'withdraw') {
        await cancelEventAttendance(postId, access);
        return res.sendStatus(204);
      }
      const schema =
        action === 'register' ? EventRegistration : action === 'cancel' ? Cancel : EventEdit;
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) throw new EventError(422, 'validation_failed', 'Invalid event input');
      if (action === 'register')
        return res.json(
          await registerForEvent(postId, access, EventRegistration.parse(parsed.data).public),
        );
      if (action === 'cancel')
        return res.json(
          await editEvent(postId, access, { cancelled: true, ...Cancel.parse(parsed.data) }),
        );
      return res.json(await editEvent(postId, access, EventEdit.parse(parsed.data)));
    } catch (error) {
      if (error instanceof EventError)
        return res
          .status(error.status)
          .json({ error: { code: error.code, message: error.message } });
      logger.error('Event command failed', error);
      return res.status(500).json({
        error: { code: 'internal_error', message: 'Could not complete the event request' },
      });
    }
  };
}
export const readEvent = handler('read');
export const eventAttendees = handler('attendees');
export const registerEvent = handler('register');
export const withdrawEvent = handler('withdraw');
export const updateEvent = handler('edit');
export const cancelEvent = handler('cancel');
