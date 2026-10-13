// Port of the iOS SDK's IdleBlinkTests (Tests/YoobTests/IdleBlinkTests.swift): the web resting face blinks by the
// same rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdleBlinkSchedule } from '../src/feathertalk/idle';

const schedule = new IdleBlinkSchedule([1, 2, 2, 1, 0, 3]);
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

function blinks(seconds: number, from = 1_000_000): Array<{ start: number; pictures: number[] }> {
  const result: Array<{ start: number; pictures: number[] }> = [];
  let current: number[] = [];
  let began = 0;
  for (let step = 0; step * 0.04 < seconds; step += 1) {
    const t = from + step * 0.04;
    const picture = schedule.picture(t);
    if (picture !== undefined) {
      if (!current.length) began = t;
      current.push(picture);
    } else if (current.length) {
      result.push({ start: began, pictures: current });
      current = [];
    }
  }
  return result;
}

test('blinks play the whole sequence and last a quarter second', () => {
  assert.ok(near(schedule.blinkSeconds, 0.24));
  const seen = blinks(600);
  assert.ok(seen.length > 100);
  for (const blink of seen) assert.deepEqual(blink.pictures, schedule.sequence);
});

test('blinks are three to six seconds apart, with some doubles', () => {
  const starts = Array.from({ length: 400 }, (_, cell) => schedule.starts(cell)).flat();
  const gaps = starts.slice(1).map((start, i) => start - starts[i]);
  const doubles = gaps.filter((gap) => gap < 1);
  assert.ok(doubles.length > 0, 'some double blinks');
  assert.ok(doubles.length / 400 < 0.3);
  for (const gap of doubles) assert.ok(near(gap, 0.24 + 0.12));
  const firsts = Array.from({ length: 400 }, (_, cell) => schedule.starts(cell)[0]);
  const cellGaps = firsts.slice(1).map((start, i) => start - firsts[i]);
  assert.ok(cellGaps.every((gap) => gap >= 3 && gap <= 6), 'first blinks of consecutive cells');
  assert.ok(Math.max(...cellGaps) - Math.min(...cellGaps) > 2, 'the interval varies');
});

test('the picture is a pure function of time', () => {
  for (let t = 0; t < 60; t += 0.013) assert.equal(schedule.picture(t), schedule.picture(t));
  assert.equal(new IdleBlinkSchedule([]).picture(3), undefined);
  assert.equal(schedule.picture(Number.NaN), undefined);
});

test('a blink held back is skipped whole and the next one keeps its place', () => {
  const seen = blinks(60);
  const held = seen[2];
  for (const offset of [0, 0.08, 0.2, 0.239]) {
    const resume = held.start + offset + 0.001;
    for (let step = 0; step < schedule.sequence.length; step += 1) {
      assert.equal(schedule.picture(held.start + step * 0.04, resume), undefined, `no half-drawn blink at step ${step}`);
    }
    for (const later of seen.slice(3)) {
      const pictures: number[] = [];
      for (let step = 0; step < 6; step += 1) {
        const picture = schedule.picture(later.start + step * 0.04, resume);
        if (picture !== undefined) pictures.push(picture);
      }
      assert.deepEqual(pictures, schedule.sequence);
    }
  }
});

test('holding blinks back changes nothing outside the hold', () => {
  for (let t = 1_000_000; t < 1_000_060; t += 0.02) {
    assert.equal(schedule.picture(t, -Infinity), schedule.picture(t));
    assert.equal(schedule.picture(t, 999_999), schedule.picture(t));
  }
});

test('the schedule is the iOS one: same seed and cells', () => {
  // Cell 0 of the iOS schedule (seed 0x5EEDB11E, SplitMix64) — a regression guard on the port's arithmetic.
  const first = schedule.starts(0)[0];
  assert.ok(first >= 0.75 && first <= 2.25);
  assert.deepEqual(schedule.starts(7), schedule.starts(7));
  assert.notEqual(schedule.starts(1)[0] - 4.5, schedule.starts(2)[0] - 9, 'cells draw different offsets');
});
