/**
 * The composer's attachment thumbnail, and the kind that picks it.
 *
 * A GIF from the picker is a looping muted mp4 (`/gifs/use` returns the mp4's
 * file id). Thumbnailed by an `Image`, it showed an empty box after "GIF
 * attached" — an image element cannot decode an mp4.
 */

import React from 'react';
import { Image } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { ComposeMediaPreview } from '../ComposeMediaPreview';
import { toComposerMediaType } from '@/utils/composeUtils';

jest.mock('@/components/Compose/VideoPreview', () => {
  const { createElement } = jest.requireActual<typeof import('react')>('react');
  const { View: MockView } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    VideoPreview: (props: { src: string }) => createElement(MockView, { testID: 'video-preview', ...props }),
  };
});

function render(type: 'image' | 'video' | 'gif') {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <ComposeMediaPreview type={type} uri="https://cloud.oxy.so/file-1" imageStyle={{ width: 10 }} />,
    );
  });
  if (!renderer) throw new Error('preview did not render');
  return renderer.root;
}

describe('ComposeMediaPreview', () => {
  it('plays a picker GIF as a video, like the feed does', () => {
    const root = render('gif');

    expect(root.findByProps({ testID: 'video-preview' }).props.src).toBe('https://cloud.oxy.so/file-1');
    expect(root.findAllByType(Image)).toHaveLength(0);
  });

  it('plays a video as a video', () => {
    expect(render('video').findAllByProps({ testID: 'video-preview' })).not.toHaveLength(0);
  });

  it('shows an image as an image', () => {
    const root = render('image');

    expect(root.findByType(Image).props.source).toEqual({ uri: 'https://cloud.oxy.so/file-1' });
    expect(root.findAllByProps({ testID: 'video-preview' })).toHaveLength(0);
  });
});

describe('toComposerMediaType', () => {
  it('gives `gif` only to a caller that says so — the picker\'s mp4', () => {
    expect(toComposerMediaType('gif')).toBe('gif');
    expect(toComposerMediaType('GIF')).toBe('gif');
  });

  it('keeps an uploaded image/gif file an image, which an Image animates and a video cannot play', () => {
    expect(toComposerMediaType('image', 'image/gif')).toBe('image');
    expect(toComposerMediaType(undefined, 'image/gif')).toBe('image');
  });

  it('types videos by kind or mime and everything else as an image', () => {
    expect(toComposerMediaType('video')).toBe('video');
    expect(toComposerMediaType('image', 'video/quicktime')).toBe('video');
    expect(toComposerMediaType(undefined, undefined)).toBe('image');
  });
});
