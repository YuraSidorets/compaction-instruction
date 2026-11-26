// The one seeded random source of the task generator (contract: no clock time and no platform random source).
// mulberry32: a small 32-bit generator. Same seed, same sequence, on every platform.

export function createRng(seed) {
  let a = seed >>> 0;
  function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const rng = {
    /** Float in [0, 1). */
    float: next,
    /** Integer in [lo, hi], both inclusive. */
    int(lo, hi) {
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    chance(p) {
      return next() < p;
    },
    pick(list) {
      if (list.length === 0) throw new Error("rng.pick on an empty list");
      return list[Math.floor(next() * list.length)];
    },
    /** A new shuffled array (Fisher-Yates). */
    shuffle(list) {
      const out = list.slice();
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    /** n distinct items of list, in shuffled order. */
    sample(list, n) {
      if (n > list.length) throw new Error(`rng.sample: ${n} > ${list.length}`);
      return rng.shuffle(list).slice(0, n);
    },
    /** A different item of list than `not`. */
    pickOther(list, not) {
      const rest = list.filter((x) => x !== not);
      return rng.pick(rest);
    },
  };
  return rng;
}
