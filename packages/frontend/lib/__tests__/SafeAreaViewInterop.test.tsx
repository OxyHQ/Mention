import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SafeAreaView } from '../SafeAreaViewInterop.native';

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

describe('SafeAreaViewInterop (native)', () => {
  it('renders its children through the className interop wrapper', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <SafeAreaProvider initialMetrics={METRICS}>
          <SafeAreaView className="flex-1" edges={['top']}>
            <Text>screen</Text>
          </SafeAreaView>
        </SafeAreaProvider>,
      );
    });
    expect(renderer.root.findByType(Text).props.children).toBe('screen');
  });
});
