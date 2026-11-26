// Comparing audio in the tests. assert.deepStrictEqual on two channels of a
// hundred thousand samples is right when it passes and takes minutes to
// print its difference when it fails, which turns a failed test into a
// timeout. These stop at the first sample that differs and say which.
import assert from "node:assert/strict";

/**
 * Two typed arrays hold the same values, bit for bit: Object.is tells -0
 * from 0, and takes NaN as equal to NaN.
 */
export function sameSamples(actual, expected, label = "samples") {
  assert.ok(ArrayBuffer.isView(actual), `${label}: not a typed array`);
  assert.equal(actual.constructor, expected.constructor, `${label}: the array type`);
  assert.equal(actual.length, expected.length, `${label}: the length`);
  for (let n = 0; n < actual.length; n += 1) {
    if (!Object.is(actual[n], expected[n])) {
      assert.fail(`${label}: sample ${n} is ${actual[n]}, expected ${expected[n]}`);
    }
  }
}

/** Two lists of channels hold the same samples, bit for bit. */
export function sameChannels(actual, expected, label = "channels") {
  assert.ok(Array.isArray(actual), `${label}: not a list of channels`);
  assert.equal(actual.length, expected.length, `${label}: the channel count`);
  actual.forEach((channel, c) => sameSamples(channel, expected[c], `${label}, channel ${c}`));
}

/** Whether two lists of channels differ in any sample (or in shape). */
export function channelsDiffer(a, b) {
  if (a.length !== b.length) return true;
  return a.some((channel, c) => channel.length !== b[c].length || channel.some((sample, n) => !Object.is(sample, b[c][n])));
}
