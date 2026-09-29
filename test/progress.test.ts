import { describe, expect, it } from 'vitest';
import { describeProgress, formatDuration } from '../src/progress.ts';

describe('describeProgress', () => {
  it('shows counts, percentage, rate and ETA', () => {
    expect(describeProgress(12_000, 36_000, 2_000)).toBe(
      '12,000/36,000 (33%), 6,000 docs/s, ETA 4s',
    );
  });

  it('leaves out the total when it is unknown or already passed', () => {
    expect(describeProgress(500, 0, 1_000)).toBe('500 documents, 500 docs/s');
    expect(describeProgress(600, 500, 1_000)).toBe('600 documents, 600 docs/s');
  });
});

describe('formatDuration', () => {
  it.each([
    [4_400, '4s'],
    [95_000, '1m35s'],
    [3_725_000, '1h02m'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
