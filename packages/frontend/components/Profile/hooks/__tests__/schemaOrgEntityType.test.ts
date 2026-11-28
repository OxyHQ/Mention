// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { schemaOrgEntityType } from '@/lib/profileSchemaOrg';

describe('schemaOrgEntityType', () => {
  it('describes a personal account as a Person', () => {
    expect(schemaOrgEntityType('personal')).toBe('Person');
    expect(schemaOrgEntityType(undefined)).toBe('Person');
  });

  it('describes every other kind as an Organization, as the server does', () => {
    expect(schemaOrgEntityType('bot')).toBe('Organization');
    expect(schemaOrgEntityType('channel')).toBe('Organization');
    expect(schemaOrgEntityType('community')).toBe('Organization');
  });
});
