"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const webRoot = path.resolve(__dirname, "..");
const root = path.resolve(webRoot, "..", "..", "..");
for (const name of ["lm_turn_model.js", "lm_turn_speed.js", "lm_turn_bilateral.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(webRoot, name), "utf8"), {filename: name});
}
function csv(file) {
  const lines = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").trimEnd().split(/\r?\n/);
  const columns = lines.shift().split(",");
  return lines.map(line => {
    const values = line.split(",");
    return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  });
}
const trials = {
  Level2: "跑步机2.0kmh直行200m_20261007_082311.csv",
  Level4: "跑步机4.0kmh直行400m_20261007_081548.csv",
  Incline3: "跑步机4.0kmh坡度3直行400m_20261007_083202.csv",
  Clockwise: "顺时针行走_20261007_084152.csv",
  CounterClockwise: "逆时针行走_20261007_084414.csv",
};
const references = csv(path.join(root, "matlab", "bilateral_fusion_results", "causal_bilateral_replay_events.csv"));
const numbers = ["turn_probability", "paired_cycle_count", "cycle_start_s", "cycle_end_s",
  "left_cycle_end_s", "right_cycle_end_s", "midpoint_difference_s", "overlap_fraction",
  "imu_speed_proxy_kmh", "single_max_probability", "single_mean_probability", "direction_probability"];
const maximumDifference = Object.fromEntries(numbers.map(key => [key, 0]));
let checked = 0;
for (const [trial, filename] of Object.entries(trials)) {
  const feet = [GaitLMTurn.create(0), GaitLMTurn.create(1)];
  const bilateral = GaitLMBilateralTurn.create();
  const expected = references.filter(row => row.trial === trial);
  let eventIndex = 0, now = -Infinity;
  csv(path.join(root, "实验数据", filename)).forEach((row, sampleIndex) => {
    const side = row.shoe === "L" ? 0 : 1;
    const sample = {frame: Number(row.frame), adc_us: Number(row.adc_us), imu_us: Number(row.imu_us),
      plot_s: Number(row.plot_s), voltage: [0, 1, 2, 3].map(i => Number(row[`voltage_${i}`])),
      acceleration: ["x", "y", "z"].map(a => Number(row[`accel_${a}`])),
      angular_rate: ["x", "y", "z"].map(a => Number(row[`gyro_${a}`]))};
    now = Math.max(now, sample.plot_s, row.received_s ? Number(row.received_s) : sample.plot_s);
    const cycle = feet[side].process(sample);
    if (!cycle) return;
    let actual;
    if (cycle.end === null) {
      bilateral.invalidate(side, cycle.reason);
      actual = bilateral.snapshot(now);
    } else actual = bilateral.process(side, cycle, now);
    const target = expected[eventIndex++];
    assert.ok(target, `${trial}: missing reference event ${eventIndex}`);
    assert.equal(Number(target.sample_index), sampleIndex, `${trial}/${eventIndex}: arrival sample differs`);
    for (const key of ["state", "source", "direction"]) {
      assert.equal(actual[key], target[key], `${trial}/${eventIndex}: ${key} differs`);
    }
    for (const key of numbers) {
      const value = target[key] === "" ? null : Number(target[key]);
      if (value === null && actual[key] === null) continue;
      assert.ok(Number.isFinite(actual[key]) && Number.isFinite(value), `${trial}/${eventIndex}: ${key} missing mismatch`);
      const difference = Math.abs(actual[key] - value);
      maximumDifference[key] = Math.max(maximumDifference[key], difference);
      assert.ok(difference <= 1e-7 * Math.max(1, Math.abs(value)),
        `${trial}/${eventIndex}: ${key} differs ${actual[key]} vs ${value}`);
    }
    checked++;
  });
  assert.equal(eventIndex, expected.length, `${trial}: event count differs`);
  console.log(`${trial}: ${eventIndex} causal classification events match Python`);
}
console.log(`Maximum numerical differences: ${JSON.stringify(maximumDifference)}`);
console.log(`PASS: ${checked} arrival-ordered browser/Python events agree on turn, direction, fallback and pairing.`);
