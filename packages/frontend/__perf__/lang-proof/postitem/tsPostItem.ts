/**
 * DEV ONLY: the TypeScript PostItem (`variants/PostItem.tsx`, the file `bloom migrate`
 * replaced) behind PostItem.bloom's interface, for the PostItem proof (`../README.md`,
 * "PostItem"). `toElement(PostItem({ … }), key)` draws `<TsPostItem … key />`, the element
 * the TS importers drew, with nothing around it. `jest.postitem-ts.config.js` maps
 * `PostItem.bloom` here.
 */
import { Node } from '@oxy.so/bloom-language';
import type { ComponentType } from 'react';

import TsPostItem from './variants/PostItem';

const component = TsPostItem as unknown as ComponentType<object>;

export function PostItem(props: object): Node {
  return new Node('view', { component, props }, []);
}
