import { hmacSha256, hexToBytes } from "./crypto.js";

function rotateLeft(value, count) {
  return ((value << count) | (value >>> (32 - count))) >>> 0;
}

export class Xoshiro128StarStar {
  constructor(seedBytes) {
    if (!(seedBytes instanceof Uint8Array) || seedBytes.byteLength < 16) {
      throw new Error("xoshiro128** requires at least 16 seed bytes");
    }
    const view = new DataView(seedBytes.buffer, seedBytes.byteOffset, seedBytes.byteLength);
    this.state = [
      view.getUint32(0, true),
      view.getUint32(4, true),
      view.getUint32(8, true),
      view.getUint32(12, true),
    ];
    if (this.state.every((value) => value === 0)) this.state[0] = 0x9e3779b9;
  }

  nextUint32() {
    const state = this.state;
    const result = Math.imul(rotateLeft(Math.imul(state[1], 5) >>> 0, 7), 9) >>> 0;
    const temporary = (state[1] << 9) >>> 0;
    state[2] ^= state[0];
    state[3] ^= state[1];
    state[1] ^= state[2];
    state[0] ^= state[3];
    state[2] ^= temporary;
    state[3] = rotateLeft(state[3], 11);
    state[0] >>>= 0;
    state[1] >>>= 0;
    state[2] >>>= 0;
    return result;
  }

  integer(maxExclusive) {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x100000000) {
      throw new Error("Invalid random integer bound");
    }
    const range = 0x100000000;
    const acceptanceLimit = Math.floor(range / maxExclusive) * maxExclusive;
    let value;
    do {
      value = this.nextUint32();
    } while (value >= acceptanceLimit);
    return value % maxExclusive;
  }
}

export async function scopedRng(rootSeedHex, domain) {
  const domainSeed = await hmacSha256(hexToBytes(rootSeedHex), domain);
  return new Xoshiro128StarStar(domainSeed);
}

export async function scopedShuffle(items, rootSeedHex, domain) {
  const output = items.slice();
  const rng = await scopedRng(rootSeedHex, domain);
  for (let index = output.length - 1; index > 0; index -= 1) {
    const selected = rng.integer(index + 1);
    [output[index], output[selected]] = [output[selected], output[index]];
  }
  return output;
}

export function maxRun(values) {
  let longest = 0;
  let current = 0;
  let previous = Symbol("initial");
  for (const value of values) {
    current = value === previous ? current + 1 : 1;
    if (current > longest) longest = current;
    previous = value;
  }
  return longest;
}

export function permutations(values) {
  if (values.length <= 1) return [values.slice()];
  const output = [];
  values.forEach((value, index) => {
    const rest = values.slice(0, index).concat(values.slice(index + 1));
    permutations(rest).forEach((suffix) => output.push([value, ...suffix]));
  });
  return output;
}

export async function constrainedShuffle(items, rootSeedHex, domain, predicate, maxAttempts = 128) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = await scopedShuffle(items, rootSeedHex, `${domain}/attempt/${attempt}`);
    if (predicate(candidate)) return candidate;
  }
  throw new Error(`Unable to satisfy randomization constraint: ${domain}`);
}
