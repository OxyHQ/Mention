/**
 * Job locations are Clarity places, never free text.
 *
 * A client names a place by its GeoNames id (picked from
 * `GET /jobs/places/search`) or names a country alone; everything else about
 * the location — its country, region and city — is read back from Clarity's
 * gazetteer HERE, at write time, so a stored location can never disagree with
 * the place it claims to be. This is also what makes the Clarity ingest
 * payload valid by construction: `clarityJobsAdapter.ts` sends the same place
 * id as `jobLocation.sameAs`, and Clarity checks it against the same table.
 */

import type { Place, PlaceKind } from '@clarity.surf/sdk' with { 'resolution-mode': 'import' };
import {
  isCountryCode,
  type CountryCode,
  type MentionJobLocation,
  type MentionJobLocationInput,
  type MentionJobPlace,
} from '@mention/shared-types';
import { getClarityClient } from '../utils/clarityClient';
import { logger } from '../utils/logger';

/** Most results the autocomplete route returns; Clarity allows 50, a picker needs a handful. */
export const JOB_PLACE_SEARCH_MAX_LIMIT = 20;
export const JOB_PLACE_SEARCH_DEFAULT_LIMIT = 10;

/** A field-level problem with a job write, in the shape the 400 body carries. */
export interface JobFieldIssue {
  path: string;
  message: string;
}

/** The client named a place Clarity does not have (or not a usable one) — a 400. */
export class JobLocationError extends Error {
  readonly issues: JobFieldIssue[];
  constructor(issue: JobFieldIssue) {
    super(issue.message);
    this.name = 'JobLocationError';
    this.issues = [issue];
  }
}

/** Clarity's gazetteer could not be reached — a 503, never a silent write of an unverified place. */
export class JobPlacesUnavailableError extends Error {
  constructor(message = 'Place lookup is unavailable right now') {
    super(message);
    this.name = 'JobPlacesUnavailableError';
  }
}

/**
 * The SDK loads through a dynamic `import()` (see `utils/clarityClient.ts`), so
 * its `ClarityError` class is not statically importable from this CommonJS
 * module; its public fields are the contract instead.
 */
export interface ClarityErrorLike {
  name: 'ClarityError';
  code: string;
  status: number;
  message: string;
  details?: Record<string, unknown>;
}

export function isClarityError(error: unknown): error is ClarityErrorLike {
  return (
    error instanceof Error &&
    error.name === 'ClarityError' &&
    typeof (error as Partial<ClarityErrorLike>).status === 'number' &&
    typeof (error as Partial<ClarityErrorLike>).code === 'string'
  );
}

/** Derive Mention's stored location from a Clarity place. */
export function locationFromPlace(place: Place): MentionJobLocation {
  if (!isCountryCode(place.countryCode)) {
    throw new JobLocationError({ path: 'location.placeId', message: `Place ${place.id} has no recognized country` });
  }
  return place.kind === 'region'
    ? { placeId: place.id, countryCode: place.countryCode, region: place.name }
    : {
        placeId: place.id,
        countryCode: place.countryCode,
        region: place.admin1Name || undefined,
        city: place.name,
      };
}

/** A Clarity place as the location picker receives it. */
export function toMentionJobPlace(place: Place): MentionJobPlace {
  return {
    id: place.id,
    kind: place.kind,
    name: place.name,
    countryCode: place.countryCode,
    region: place.kind === 'city' ? place.admin1Name || undefined : undefined,
  };
}

/**
 * Resolve a client's location input to the location Mention stores. A country
 * alone is taken as given (the request schema already checked it against
 * `COUNTRY_CODES`); a place id is looked up in Clarity.
 *
 * @throws {JobLocationError} the place does not exist.
 * @throws {JobPlacesUnavailableError} Clarity could not answer.
 */
export async function resolveJobLocation(input: MentionJobLocationInput): Promise<MentionJobLocation> {
  if (input.placeId === undefined) {
    return { countryCode: input.countryCode as CountryCode };
  }
  const placeId = input.placeId;
  let place: Place;
  try {
    const client = await getClarityClient();
    place = await client.places.get(placeId);
  } catch (error) {
    if (isClarityError(error) && (error.status === 404 || error.status === 400)) {
      throw new JobLocationError({
        path: 'location.placeId',
        message: `No place with id ${placeId}. Pick one from /jobs/places/search.`,
      });
    }
    logger.warn('[JobPlaces] Place lookup failed', {
      placeId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    throw new JobPlacesUnavailableError();
  }
  return locationFromPlace(place);
}

export interface JobPlaceSearchParams {
  q: string;
  countryCode?: CountryCode;
  kind?: PlaceKind;
  limit: number;
}

/**
 * `clarity.places.search`, trimmed to what a picker needs.
 *
 * @throws {JobPlacesUnavailableError} Clarity could not answer.
 */
export async function searchJobPlaces(params: JobPlaceSearchParams): Promise<MentionJobPlace[]> {
  try {
    const client = await getClarityClient();
    const response = await client.places.search({
      q: params.q,
      countryCode: params.countryCode,
      kind: params.kind,
      limit: Math.min(params.limit, JOB_PLACE_SEARCH_MAX_LIMIT),
    });
    return response.data.slice(0, JOB_PLACE_SEARCH_MAX_LIMIT).map(toMentionJobPlace);
  } catch (error) {
    logger.warn('[JobPlaces] Place search failed', {
      reason: error instanceof Error ? error.message : 'unknown',
      status: isClarityError(error) ? error.status : undefined,
    });
    throw new JobPlacesUnavailableError('Place search is unavailable right now');
  }
}
