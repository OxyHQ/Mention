// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { requestContext } from './context.js';

const AUTH_REQUIRED_MESSAGE =
  'Authentication required. Connect your Mention account in the MCP client to authorize this action.';

export function getMcpToken(): string {
  return requestContext.getStore()?.userToken ?? '';
}

export function authRequiredResponse() {
  return {
    content: [{ type: 'text' as const, text: AUTH_REQUIRED_MESSAGE }],
    isError: true as const,
  };
}

export function withAuthGuard<T extends unknown[]>(
  handler: (
    ...args: T
  ) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>,
) {
  return async (...args: T) => {
    const token = getMcpToken();
    if (!token) {
      return authRequiredResponse();
    }
    return handler(...args);
  };
}
