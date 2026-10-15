import type { Experience } from '@clarity.surf/sdk/experience';
import { experienceMonthLabel, experienceMonths, groupExperience } from '../experiencePresentation';

const role = (
  id: string,
  employerOxyAccountId: string,
  startDate: string,
  endDate: string | null,
  canonicalId?: string,
): Experience => ({
  id,
  oxyUserId: 'person',
  title: 'Designer',
  employerOxyAccountId: canonicalId ?? employerOxyAccountId,
  startDate,
  endDate,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
});

describe('professional experience chronology', () => {
  it('reproduces the reference with a return to Apple kept separate from the earlier tenure', () => {
    const entries = [
      role('first', 'Apple', '2005-10', '2013-10'),
      role('current', 'Apple', '2022-10', null),
      role('second', 'Apple', '2013-10', '2021-06'),
      role('airbnb', 'Airbnb', '2021-06', '2022-10'),
    ];
    const groups = groupExperience(entries);
    expect(groups.map((group) => group.entries.map((entry) => entry.id))).toEqual([
      ['current'],
      ['airbnb'],
      ['second', 'first'],
    ]);
    expect(experienceMonths(groups[2].startDate, groups[2].endDate)).toBe(189);
    expect(entries[0].id).toBe('first');
  });

  it('does not join similarly named companies with different canonical identities', () => {
    expect(
      groupExperience([
        role('a', 'Acme', '2021-01', null, 'org-a'),
        role('b', 'Acme', '2020-01', '2021-01', 'org-b'),
      ]),
    ).toHaveLength(2);
  });

  it('groups renamed canonical companies while keeping employment gaps as separate tenures', () => {
    expect(
      groupExperience([
        role('a', 'New name', '2021-01', null, 'org'),
        role('b', 'Old name', '2020-01', '2020-12', 'org'),
      ]),
    ).toHaveLength(1);
    expect(
      groupExperience([
        role('a', 'Acme', '2021-01', null),
        role('b', 'Acme', '2018-01', '2019-01'),
      ]),
    ).toHaveLength(2);
  });

  it('counts calendar months inclusively without adding overlapping roles twice', () => {
    expect(experienceMonths('2022-10', null, new Date('2026-10-15T00:00:00Z'))).toBe(49);
    expect(experienceMonths('2022-10', '2022-10')).toBe(1);
    const [group] = groupExperience([
      role('a', 'Acme', '2021-01', '2022-01'),
      role('b', 'Acme', '2020-01', '2021-06'),
    ]);
    expect(experienceMonths(group.startDate, group.endDate)).toBe(25);
  });

  it('caps accrued tenure at the current month for a planned end date', () => {
    expect(experienceMonths('2022-10', '2027-10', new Date('2026-10-15T00:00:00Z'))).toBe(49);
  });

  it('formats the entered month in UTC and the selected language', () => {
    expect(experienceMonthLabel('2022-10', 'en')).toBe('Oct 2022');
    expect(experienceMonthLabel('2022-10', 'es')).toContain('oct');
  });
});

it('keeps ongoing work first and preserves the earliest start when roles overlap', () => {
  const [group] = groupExperience([
    role('current', 'org', '2010-01', null),
    role('overlap', 'org', '2020-01', '2021-01'),
  ]);
  expect(group.entries.map((entry) => entry.id)).toEqual(['current', 'overlap']);
  expect(group.startDate).toBe('2010-01');
});
