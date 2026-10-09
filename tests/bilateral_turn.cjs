"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const webRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(webRoot, "..", "..", "..");
vm.runInThisContext(fs.readFileSync(path.join(webRoot, "lm_turn_bilateral.js"), "utf8"),
  {filename: "lm_turn_bilateral.js"});
const realModel = JSON.parse(fs.readFileSync(path.join(projectRoot, "matlab", "bilateral_fusion_results", "bilateral_model.json"), "utf8"));
const channels = ["medial_heel", "medial_forefoot", "lateral_forefoot", "lateral_heel"];
let checked = 0;

function check(name, test) {
  test(); checked++;
  console.log(`PASS: ${name}`);
}

function close(actual, expected, tolerance = 1e-12) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${actual} differs from ${expected}`);
}

function cycle(start, end, probability = 0.8, extra = {}) {
  return {state: "TURN", start, end, duration: 999, turnProbability: probability,
    onsetDifferencesByChannel: [1, 2, 3, 4], peakDifferencesByChannel: [5, 6, 7, 8],
    validChannels: 4, imuSpeedProxyKmh: 4, speedProxyOutOfDistribution: false, ...extra};
}

function constantModel(probability, extra = {}) {
  return {...realModel, weights: [Math.log(probability / (1 - probability)),
    ...Array(realModel.feature_names.length * 2).fill(0)], thresholds: {turn: 0.6, straight: 0.4},
    freshness_s: 3, ...extra};
}

function expectedFeatures(left, right) {
  const features = [];
  for (const kind of ["onset", "peak"]) {
    for (let index = 0; index < 4; index++) {
      const l = left[`${kind}DifferencesByChannel`][index], r = right[`${kind}DifferencesByChannel`][index];
      const missing = l === null || r === null || !Number.isFinite(l) || !Number.isFinite(r);
      features.push(missing ? NaN : (l + r) / 2, missing ? NaN : r - l);
    }
  }
  const ls = left.imuSpeedProxyKmh, rs = right.imuSpeedProxyKmh;
  const speedMissing = ls === null || rs === null || !Number.isFinite(ls) || !Number.isFinite(rs);
  const ld = left.end - left.start, rd = right.end - right.start;
  features.push(speedMissing ? NaN : (ls + rs) / 2,
    speedMissing ? NaN : Math.abs(rs - ls), (ld + rd) / 2, (rd - ld) / (rd + ld),
    Math.min(left.validChannels, right.validChannels) / 4,
    Number(left.speedProxyOutOfDistribution == null || right.speedProxyOutOfDistribution == null ||
      left.speedProxyOutOfDistribution || right.speedProxyOutOfDistribution));
  return features;
}

function expectedProbability(model, features) {
  let score = model.weights[0];
  features.forEach((feature, index) => {
    const missing = !Number.isFinite(feature), value = missing ? model.feature_medians[index] : feature;
    score += (value - model.feature_centers[index]) / model.feature_scales[index] * model.weights[index + 1];
    score += Number(missing) * model.weights[index + 1 + features.length];
  });
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, score))));
}

check("real model probabilities match independently built signed 22-feature vectors", () => {
  const engine = GaitLMBilateralTurn.create(realModel);
  const left = cycle(1, 2.2, 0.9), right = cycle(1.5, 2.7, 0.7, {
    onsetDifferencesByChannel: [-3, 5, 6, -2], peakDifferencesByChannel: [9, -5, 0, 10],
    imuSpeedProxyKmh: 3.2, validChannels: 3,
  });
  assert.equal(engine.process("L", left, 2.2).source, "LEFT_ONLY");
  const result = engine.process("R", right, 2.7);
  assert.equal(result.source, "BILATERAL_MODEL");
  close(result.turn_probability, expectedProbability(realModel, expectedFeatures(left, right)));
  close(result.midpoint_difference_s, 0.5);
  close(result.overlap_fraction, 0.7 / 1.2);
  close(result.imu_speed_proxy_kmh, 3.6);
  close(result.single_max_probability, 0.9);
  close(result.single_mean_probability, 0.8);
  assert.equal(result.cycle_start_s, 1);
  assert.equal(result.cycle_end_s, 2.7);
});

check("missing residuals use fitted medians and missing-indicator weights", () => {
  const engine = GaitLMBilateralTurn.create(realModel);
  const left = cycle(0, 1.2, 0.7, {onsetDifferencesByChannel: [null, 2, 3, 4],
    peakDifferencesByChannel: [null, 6, 7, 8], speedProxyOutOfDistribution: null});
  const right = cycle(0.5, 1.8, 0.8, {imuSpeedProxyKmh: null});
  engine.process(0, left, 1.2);
  const result = engine.process(1, right, 1.8);
  close(result.turn_probability, expectedProbability(realModel, expectedFeatures(left, right)));
  assert.equal(result.imu_speed_proxy_kmh, null);
});

check("snake_case desktop cycle fields match camelCase browser cycle fields", () => {
  const left = cycle(1, 2.2), right = cycle(1.5, 2.7);
  function snake(source) {
    const target = {state: source.state, cycle_start_s: source.start, cycle_end_s: source.end,
      turn_probability: source.turnProbability, valid_channel_count: source.validChannels,
      imu_speed_proxy_kmh: source.imuSpeedProxyKmh,
      speed_proxy_out_of_distribution: source.speedProxyOutOfDistribution};
    for (const kind of ["onset", "peak"]) channels.forEach((channel, index) => {
      target[`${kind}_delta_${channel}_percent`] = source[`${kind}DifferencesByChannel`][index];
    });
    return target;
  }
  const a = GaitLMBilateralTurn.create(realModel), b = GaitLMBilateralTurn.create(realModel);
  a.process("LEFT", left, 2.2); b.process("LEFT", snake(left), 2.2);
  assert.deepEqual(a.process("RIGHT", right, 2.7), b.process("RIGHT", snake(right), 2.7));
});

check("nested monitor residual dictionaries and string distribution flags preserve model parity", () => {
  const left = cycle(1, 2.2), right = cycle(1.5, 2.7);
  function monitor(source) {
    const result = {state: source.state, cycle_start_s: source.start, cycle_end_s: source.end,
      turn_probability: source.turnProbability, valid_channel_count: source.validChannels,
      imu_speed_proxy_kmh: source.imuSpeedProxyKmh, speed_proxy_out_of_distribution: " False "};
    for (const kind of ["onset", "peak"]) result[`${kind}_differences_by_channel`] =
      Object.fromEntries(channels.map((channel, index) => [channel, source[`${kind}DifferencesByChannel`][index]]));
    return result;
  }
  const a = GaitLMBilateralTurn.create(realModel), b = GaitLMBilateralTurn.create(realModel);
  a.process("L", left, 2.2); b.process("L", monitor(left), 2.2);
  assert.deepEqual(a.process("R", right, 2.7), b.process("R", monitor(right), 2.7));
  for (const flag of [null, NaN, "nan", "true", "yes", ""]) {
    const expected = GaitLMBilateralTurn.create(realModel), actual = GaitLMBilateralTurn.create(realModel);
    expected.process("L", {...left, speedProxyOutOfDistribution: true}, 2.2);
    actual.process("L", {...left, speedProxyOutOfDistribution: flag}, 2.2);
    assert.deepEqual(actual.process("R", right, 2.7), expected.process("R", right, 2.7));
  }
  for (const flag of [false, 0, "false", "0", "no"]) {
    const engine = GaitLMBilateralTurn.create(realModel);
    engine.process("L", {...left, speedProxyOutOfDistribution: flag}, 2.2);
    close(engine.process("R", right, 2.7).turn_probability,
      expectedProbability(realModel, expectedFeatures(left, right)));
  }
});

check("pairing is causal and consumes each cycle once", () => {
  const engine = GaitLMBilateralTurn.create(constantModel(0.8));
  assert.equal(engine.process("L", cycle(0, 1), 1).paired_cycle_count, 0);
  assert.equal(engine.process("R", cycle(0.4, 1.4), 1.4).paired_cycle_count, 1);
  const output = engine.process("R", cycle(1, 2), 2);
  assert.equal(output.paired_cycle_count, 1);
  assert.equal(output.source, "RIGHT_ONLY");
  assert.equal(engine.process("L", cycle(1.4, 2.4), 2.4).paired_cycle_count, 2);
});

check("nearest eligible queued cycle is chosen with overlap enforced", () => {
  const engine = GaitLMBilateralTurn.create(constantModel(0.8));
  engine.process("L", cycle(0, 1.2), 1.2);
  engine.process("L", cycle(1.1, 2.3), 2.3);
  const output = engine.process("R", cycle(0.8, 2), 2.3);
  assert.equal(output.left_cycle_end_s, 2.3);
  assert.equal(output.paired_cycle_count, 1);
  const noOverlap = GaitLMBilateralTurn.create(constantModel(0.8));
  noOverlap.process("L", cycle(0, 0.5), 0.5);
  const single = noOverlap.process("R", cycle(0.6, 1.1), 1.1);
  assert.equal(single.source, "RIGHT_ONLY");
  assert.equal(single.paired_cycle_count, 0);
});

check("duplicate, delayed, future and malformed endpoints preserve the accepted result", () => {
  const engine = GaitLMBilateralTurn.create(constantModel(0.8));
  const accepted = engine.process("L", cycle(0, 1.2, 0.9), 1.2);
  for (const input of [cycle(0, 1.2, 0.1), cycle(0, 1.1, 0.1), cycle(1, 2, 0.1),
    cycle(2, 1.2, 0.1), cycle(NaN, 1.3, 0.1)]) {
    assert.deepEqual(engine.process("L", input, 1.2), accepted);
  }
});

check("no pair or single prediction survives the freshness timeout", () => {
  const engine = GaitLMBilateralTurn.create(constantModel(0.8));
  engine.process("L", cycle(0, 1), 1);
  assert.equal(engine.snapshot(4.01).state, "INVALID");
  assert.equal(engine.snapshot(1).state, "INVALID");
  assert.equal(engine.process("R", cycle(0.4, 1.4), 4.01).source, "RIGHT_ONLY");
  assert.equal(engine.snapshot(4.41).state, "INVALID");
});

check("pair expires when either constituent is stale and falls back to the fresh foot", () => {
  const engine = GaitLMBilateralTurn.create(constantModel(0.8));
  engine.process("L", cycle(0, 1), 1);
  engine.process("R", cycle(0.6, 1.6, 0.3), 1.6);
  const fallback = engine.snapshot(4.2);
  assert.equal(fallback.source, "RIGHT_ONLY");
  assert.equal(fallback.state, "STRAIGHT_CANDIDATE");
  assert.equal(fallback.direction, "UNKNOWN");
});

check("an invalid foot preserves a fresh other foot and permits device restart", () => {
  const engine = GaitLMBilateralTurn.create(constantModel(0.8));
  engine.process("L", cycle(0, 1), 1);
  engine.process("R", cycle(0.4, 1.4, 0.3), 1.4);
  assert.equal(engine.process("L", {state: "INVALID", reason: "DISCONNECTED"}, 1.5).source, "RIGHT_ONLY");
  engine.process("L", cycle(0, 1.1), 1.5);
  assert.equal(engine.process("R", cycle(0.6, 1.6, 0.3), 1.6).source, "BILATERAL_MODEL");
  engine.invalidate("L");
  assert.equal(engine.invalidate("R").state, "INVALID");
});

check("fewer than two usable LM channels invalidates that foot and preserves the other", () => {
  const engine = GaitLMBilateralTurn.create(constantModel(0.8));
  engine.process("R", cycle(0.4, 1.4, 0.3), 1.4);
  const result = engine.process("L", cycle(0.5, 1.5, 0.9, {validChannels: 1}), 1.5);
  assert.equal(result.source, "RIGHT_ONLY");
  assert.equal(result.state, "STRAIGHT_CANDIDATE");
  assert.equal(result.paired_cycle_count, 0);
});

check("a late older pair cannot overwrite a more recent single result", () => {
  const engine = GaitLMBilateralTurn.create(constantModel(0.8));
  engine.process("R", cycle(7, 8.5, 0.9), 8.5);
  engine.process("R", cycle(9.5, 11, 0.2), 11);
  const result = engine.process("L", cycle(7.25, 8.75, 0.9), 11);
  assert.equal(result.paired_cycle_count, 1);
  assert.equal(result.source, "RIGHT_ONLY");
  assert.equal(result.cycle_end_s, 11);
  assert.equal(result.state, "STRAIGHT_CANDIDATE");
});

check("direction requires both-valid TURN and an explicitly enabled direction classifier", () => {
  for (const [directionProbability, expected] of [[0.8, "COUNTERCLOCKWISE"], [0.2, "CLOCKWISE"], [0.5, "UNKNOWN"]]) {
    const direction = constantModel(directionProbability, {enabled: true, thresholds: {positive: 0.6, negative: 0.4}});
    const engine = GaitLMBilateralTurn.create(constantModel(0.8, {direction_classifier: direction}));
    assert.equal(engine.process("L", cycle(0, 1), 1).direction, "UNKNOWN");
    const result = engine.process("R", cycle(0.4, 1.4), 1.4);
    assert.equal(result.direction, expected);
    close(result.direction_probability, directionProbability);
  }
  for (const [turnProbability, enabled] of [[0.2, true], [0.8, false]]) {
    const engine = GaitLMBilateralTurn.create(constantModel(turnProbability, {
      direction_classifier: constantModel(0.8, {enabled}),
    }));
    engine.process("L", cycle(0, 1), 1);
    const result = engine.process("R", cycle(0.4, 1.4), 1.4);
    assert.equal(result.direction, "UNKNOWN");
    assert.equal(result.direction_probability, null);
  }
});

check("unavailable bilateral models retain valid single-foot output", () => {
  const engine = GaitLMBilateralTurn.create({});
  engine.process("L", cycle(0, 1, 0.8), 1);
  const result = engine.process("R", cycle(0.4, 1.4, 0.3), 1.4);
  assert.equal(result.source, "RIGHT_ONLY");
  assert.equal(result.state, "STRAIGHT_CANDIDATE");
});

check("reset clears accepted watermarks, queue matches and pair counts", () => {
  const engine = GaitLMBilateralTurn.create(constantModel(0.8));
  engine.process("L", cycle(0, 1), 1);
  engine.process("R", cycle(0.4, 1.4), 1.4);
  engine.reset();
  assert.equal(engine.snapshot().state, "INVALID");
  assert.equal(engine.process("L", cycle(0, 1), 1).paired_cycle_count, 0);
});

check("all offline both-valid pairs reproduce fitted probabilities without future samples", () => {
  const filename = path.join(projectRoot, "matlab", "bilateral_fusion_results", "bilateral_paired_cycles.csv");
  const lines = fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, "").trimEnd().split(/\r?\n/);
  const names = lines.shift().split(",");
  let compared = 0;
  for (const line of lines) {
    const cells = line.split(","), row = Object.fromEntries(names.map((name, index) => [name, cells[index]]));
    if (row.both_valid.toLowerCase() !== "true") continue;
    function fromRow(prefix) {
      const result = {state: row[`${prefix}_state`], start: Number(row[`${prefix}_cycle_start_s`]),
        end: Number(row[`${prefix}_cycle_end_s`]), turnProbability: Number(row[`${prefix}_turn_probability`]),
        imuSpeedProxyKmh: Number(row[`${prefix}_imu_speed_proxy_kmh`]),
        validChannels: Number(row[`${prefix}_valid_channel_count`]),
        speedProxyOutOfDistribution: row[`${prefix}_speed_proxy_out_of_distribution`].toLowerCase() === "true"};
      for (const kind of ["onset", "peak"]) result[`${kind}DifferencesByChannel`] = channels.map(channel => {
        const cell = row[`${prefix}_${kind}_delta_${channel}_percent`];
        return cell === "" ? null : Number(cell);
      });
      return result;
    }
    const left = fromRow("left"), right = fromRow("right"), engine = GaitLMBilateralTurn.create(realModel);
    const firstSide = left.end <= right.end ? "L" : "R";
    engine.process(firstSide, firstSide === "L" ? left : right, Math.min(left.end, right.end));
    const result = engine.process(firstSide === "L" ? "R" : "L", firstSide === "L" ? right : left,
      Math.max(left.end, right.end));
    assert.equal(result.source, "BILATERAL_MODEL");
    close(result.turn_probability, Number(row.probability_bilateral), 1e-10);
    compared++;
  }
  assert.ok(compared > 500, `Only ${compared} pairs were tested`);
  console.log(`Validated ${compared} fitted offline pair probabilities.`);
});

console.log(`PASS: ${checked} bilateral browser safety and numerical parity checks.`);
