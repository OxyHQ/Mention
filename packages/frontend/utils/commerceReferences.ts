// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { formatMercariaRef, parseMercariaRef } from '@mercaria.co/sdk/refs';
import { MAX_COMMERCE_ATTACHMENTS, type CommerceReference } from '@mention/shared-types/commerce';

export { formatMercariaRef as commerceReferenceKey };
/** Old drafts can contain unknown fields; retain valid identities only, never provider facts. */
export function readCommerceReferences(value: unknown): CommerceReference[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, CommerceReference>();
  for (const item of value) {
    const ref = parseMercariaRef(item);
    if (ref?.kind === 'product' || ref?.kind === 'collection')
      unique.set(formatMercariaRef(ref), ref);
    if (unique.size === MAX_COMMERCE_ATTACHMENTS) break;
  }
  return [...unique.values()];
}
