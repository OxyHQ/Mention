// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { RequestHandler } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import {
  canParticipateInDeployment,
  type ManagedMentionDeployment,
} from '@mention/shared-types/deployment';

/** Identity is already resolved by Oxy/MCP; never accept an account from the body. */
export function createDeploymentAdmission(
  deployment: ManagedMentionDeployment,
  allowPublicReads: boolean,
): RequestHandler {
  return (request, response, next) => {
    if (allowPublicReads && ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
    const accountId = (request as OxyAuthRequest).user?.id;
    if (!accountId) {
      response.status(401).json({ error: 'deployment_authentication_required' });
      return;
    }
    if (!canParticipateInDeployment(deployment, accountId)) {
      response
        .status(403)
        .json({ error: 'deployment_membership_required', signupPolicy: deployment.signup.policy });
      return;
    }
    next();
  };
}
