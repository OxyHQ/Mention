import { describe, expect, it } from 'bun:test';
import { handleKey, stripHandlePrefix } from '../src/handle';

describe('handle helpers', () => {
  it('strips every leading @ and whitespace, keeping case and any @host suffix', () => {
    expect(stripHandlePrefix(' @@Alice ')).toBe('Alice');
    expect(stripHandlePrefix('@alice@x.com')).toBe('alice@x.com');
    expect(stripHandlePrefix('alice')).toBe('alice');
  });

  it('compares handles case-insensitively', () => {
    expect(handleKey('@Alice')).toBe(handleKey('alice'));
  });
});
