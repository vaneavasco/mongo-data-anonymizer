import { describe, expect, it } from 'vitest';
import { sfc32Randomizer } from '../../src/anonymization/randomizer.ts';

describe('sfc32Randomizer', () => {
  it('repeats the same sequence for the same seed', () => {
    const a = sfc32Randomizer();
    const b = sfc32Randomizer();
    a.seed([1, 2, 3, 4]);
    b.seed([1, 2, 3, 4]);

    const first = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(first);
  });

  it('gives different sequences for seeds that differ in one bit', () => {
    const a = sfc32Randomizer();
    const b = sfc32Randomizer();
    a.seed([1, 2, 3, 4]);
    b.seed([1, 2, 3, 5]);

    expect(a.next()).not.toBe(b.next());
  });

  it('returns values in [0, 1) spread evenly', () => {
    const random = sfc32Randomizer();
    random.seed(42);
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 100_000; i++) {
      const value = random.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      buckets[Math.floor(value * 10)]! += 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(9_000);
      expect(count).toBeLessThan(11_000);
    }
  });
});
