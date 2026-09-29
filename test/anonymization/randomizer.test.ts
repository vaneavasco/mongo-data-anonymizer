import { Faker, base, en } from '@faker-js/faker';
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

  it('re-seeds much faster than the default Mersenne Twister of faker', () => {
    // The anonymizer re-seeds for every value, so this is what makes it fast.
    const seeds = Array.from({ length: 20_000 }, (_, i) => [
      i,
      i * 7,
      i * 13,
      i * 31,
    ]);
    const time = (faker: Faker) => {
      const started = performance.now();
      for (const seed of seeds) {
        faker.seed(seed);
        faker.number.int();
      }
      return performance.now() - started;
    };

    const fast = new Faker({
      locale: [en, base],
      randomizer: sfc32Randomizer(),
    });
    const slow = new Faker({ locale: [en, base] });
    time(fast);
    time(slow);

    expect(time(fast) * 3).toBeLessThan(time(slow));
  });
});
