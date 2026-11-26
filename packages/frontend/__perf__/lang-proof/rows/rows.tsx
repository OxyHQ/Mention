/**
 * DEV ONLY: PostItem's rows in their two forms (`../README.md`, "Rows"):
 *
 * - `ts`: the TypeScript row as it shipped (`./variants/`), drawn as PostItem drew
 *   it: a React component inside `Embed(<Row … />)`, or, for the lane chip, the
 *   embedded-language view called as a node;
 * - `bloom`: the `.bloom` row (`bloomc migrate`, `components/Post/*.bloom`), a view
 *   called as a node, as PostItem now draws it.
 *
 * Each returns the language child PostItem puts in its tree.
 */
import { Embed, type Child } from '@oxy.so/bloom-language';
import { createElement } from 'react';

import BloomContentWarning from '@/components/Post/ContentWarning.bloom';
import BloomPostCommunityRow from '@/components/Post/PostCommunityRow.bloom';
import BloomPostCorrectionNotice from '@/components/Post/PostCorrectionNotice.bloom';
import BloomPostLaneChip from '@/components/Post/PostLaneChip.bloom';
import rowStates from './states.json';
import TsContentWarning from './variants/ContentWarning';
import TsPostCommunityRow from './variants/PostCommunityRow';
import TsPostCorrectionNotice from './variants/PostCorrectionNotice';
import TsPostLaneChip from './variants/PostLaneChip';

export type RowForm = 'ts' | 'bloom';
export const ROW_FORMS: RowForm[] = ['ts', 'bloom'];
export type RowName =
  | 'ContentWarning'
  | 'PostCommunityRow'
  | 'PostCorrectionNotice'
  | 'PostLaneChip';
export interface RowState {
  row: RowName;
  state: string;
  props: Record<string, unknown>;
}
export const ROW_STATES = rowStates.states as RowState[];

/** Props a row is handed: the JSON fixture plus its handler. */
export function rowProps(
  state: RowState,
  onToggle: () => void = () => undefined,
): Record<string, unknown> {
  return state.row === 'ContentWarning' ? { ...state.props, onToggle } : state.props;
}

type Props = Record<string, unknown>;

// A TS row typed `href: Href | null` is the `.bloom` row's `href: Href?`:
// PostItem passes `communityHref ?? undefined`, and so does this.
const BLOOM: Record<RowName, (props: Props) => Child> = {
  ContentWarning: (p) => BloomContentWarning(p as never),
  PostCommunityRow: (p) => BloomPostCommunityRow({ ...p, href: p.href ?? undefined } as never),
  PostCorrectionNotice: (p) => BloomPostCorrectionNotice(p as never),
  PostLaneChip: (p) => BloomPostLaneChip(p as never),
};

// As PostItem drew them: the components inside `Embed`, the lane chip (already a
// view in the embedded language) as a node.
const TS: Record<RowName, (props: Props) => Child> = {
  ContentWarning: (p) => Embed(createElement(TsContentWarning, p as never)),
  PostCommunityRow: (p) => Embed(createElement(TsPostCommunityRow, p as never)),
  PostCorrectionNotice: (p) => Embed(createElement(TsPostCorrectionNotice, p as never)),
  PostLaneChip: (p) => TsPostLaneChip(p as never),
};

// The JSON fixtures are typed loosely (`never` takes each row's own props).

/** The language child PostItem draws for `row` in `form`. */
export function drawRow(form: RowForm, row: RowName, props: Props): Child {
  return (form === 'bloom' ? BLOOM : TS)[row](props);
}
