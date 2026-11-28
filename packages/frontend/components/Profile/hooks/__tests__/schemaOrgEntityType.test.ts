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
