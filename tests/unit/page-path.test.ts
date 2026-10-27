import { describe, expect, it } from 'vitest';
import { pathOf } from '@blissnova/api/services/serving';

describe('pathOf', () => {
  it('keeps only the path, dropping host, query string and fragment', () => {
    expect(pathOf('https://news.example.org/a/b?email=x@y.z&utm=1#c')).toBe('/a/b');
    expect(pathOf('https://news.example.org')).toBe('/');
  });
  it('caps long paths and falls back to / for bad input', () => {
    expect(pathOf(`https://x.example/${'a'.repeat(500)}`)).toHaveLength(300);
    expect(pathOf('not a url')).toBe('/');
  });
});
