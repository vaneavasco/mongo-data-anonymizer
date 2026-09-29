import type { Randomizer } from '@faker-js/faker';

/**
 * A small, fast PRNG (sfc32) for faker. The anonymizer re-seeds faker for
 * every value; faker's default Mersenne Twister takes ~25 µs to re-seed,
 * which dominated anonymization time. sfc32 takes its four 32-bit words of
 * state straight from the seed (the HMAC digest), so re-seeding is nearly free.
 */
export function sfc32Randomizer(): Randomizer {
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 1;

  const next = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };

  return {
    next,
    seed(seed: number | number[]) {
      const words = Array.isArray(seed) ? seed : [seed];
      [a = 0, b = 0, c = 0, d = 1] = words.map((word) => word | 0);
      // Mix the state so that similar seeds don't give similar first values.
      for (let i = 0; i < 12; i++) next();
    },
  };
}
