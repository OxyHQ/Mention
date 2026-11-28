// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { OxyServices } from '@oxy.so/core';
import { OXY_BASE_URL } from '@/config';

/**
 * Shared OxyServices instance for use throughout the app.
 * This is the same instance that's passed to OxyProvider in AppProviders.
 *
 * Session restore is device-first and owned entirely by OxyProvider's cold boot:
 * local `{deviceId, deviceSecret}` mint, then silent OAuth (`prompt=none`) when
 * no credential exists on web. Only `baseURL` is configured here.
 */
export const oxyServices = new OxyServices({ baseURL: OXY_BASE_URL });
