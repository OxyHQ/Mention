import { z } from 'zod';

export const EventDetails = z.object({
  name: z.string().trim().min(1).max(200),
  date: z.iso.datetime({ offset: true }),
  location: z.string().trim().max(200).optional(),
  description: z.string().trim().max(500).optional(),
  capacity: z.number().int().min(1).max(1000000).nullable(),
});
export const EventEdit = EventDetails.extend({ revision: z.number().int().min(0) }).strict();
export const EventRegistration = z.object({ public: z.boolean().default(false) }).strict();
export const EventState = EventDetails.extend({
  postId: z.string(),
  cancelled: z.boolean(),
  revision: z.number().int(),
  attendingCount: z.number().int(),
  viewerAttendance: z.object({ public: z.boolean() }).nullable(),
  canManage: z.boolean(),
});
export const EventAttendee = z.object({
  oxyUserId: z.string(),
  public: z.boolean(),
  displayName: z.string().optional(),
});
export const EventAttendees = z.object({
  items: z.array(EventAttendee),
  nextCursor: z.string().nullable(),
});
export type EventState = z.infer<typeof EventState>;
export type EventEdit = z.infer<typeof EventEdit>;
export const EventCancel = z.object({ revision: z.number().int().min(0) }).strict();
export const EventErrorResponse = z.object({
  error: z.object({
    code: z.enum([
      'bad_request',
      'unauthorized',
      'not_found',
      'conflict',
      'validation_failed',
      'service_unavailable',
      'internal_error',
    ]),
    message: z.string(),
  }),
});

/** Machine-readable contract for the native-event HTTP surface. */
export function eventOpenApi() {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const operation = (
    name: string,
    request: string | null,
    response: string | null,
    method: string,
  ) => ({
    operationId: name,
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ...(name === 'listEventAttendees'
        ? [
            {
              name: 'scope',
              in: 'query',
              schema: { type: 'string', enum: ['public', 'organizers'], default: 'public' },
            },
            { name: 'cursor', in: 'query', schema: { type: 'string', maxLength: 2048 } },
          ]
        : []),
    ],
    security: method === 'get' ? [{}, { oxySession: [] }] : [{ oxySession: [] }],
    ...(request
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref(request) } },
          },
        }
      : {}),
    responses: {
      [response ? '200' : '204']: {
        description: 'Success',
        ...(response ? { content: { 'application/json': { schema: ref(response) } } } : {}),
      },
      ...Object.fromEntries(
        [400, 401, 404, 409, 422, 500, 503].map((code) => [
          code,
          {
            description: 'Refused',
            content: { 'application/json': { schema: ref('EventErrorResponse') } },
          },
        ]),
      ),
    },
  });
  const schemas = {
    EventState,
    EventEdit,
    EventRegistration,
    EventCancel,
    EventAttendees,
    EventErrorResponse,
  };
  return {
    openapi: '3.1.0',
    info: { title: 'Mention native events', version: '1.0.0' },
    paths: {
      '/posts/{id}/event': {
        get: operation('getEvent', null, 'EventState', 'get'),
        put: operation('editEvent', 'EventEdit', 'EventState', 'put'),
      },
      '/posts/{id}/event/attendance': {
        put: operation('registerForEvent', 'EventRegistration', 'EventState', 'put'),
        delete: operation('withdrawFromEvent', null, null, 'delete'),
      },
      '/posts/{id}/event/cancel': {
        post: operation('cancelEvent', 'EventCancel', 'EventState', 'post'),
      },
      '/posts/{id}/event/attendees': {
        get: operation('listEventAttendees', null, 'EventAttendees', 'get'),
      },
    },
    components: {
      securitySchemes: { oxySession: { type: 'http', scheme: 'bearer' } },
      schemas: Object.fromEntries(
        Object.entries(schemas).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
      ),
    },
  };
}
