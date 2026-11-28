// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Global type augmentations for the Mention backend.
 *
 * Runtime services are exposed through explicit seams in `src/runtime`; this
 * file only augments framework-owned request types.
 */

declare global {
  namespace Express {
    /**
     * Raw request body captured by the `express.json` `verify` hook in
     * `app.ts`. Preserved as the exact UTF-8 payload string so ActivityPub
     * inbound handlers can verify HTTP signatures and `Digest` headers against
     * the unparsed bytes. `undefined` when the request had no body.
     */
    interface Request {
      rawBody?: string;
    }
  }
}

export {};
