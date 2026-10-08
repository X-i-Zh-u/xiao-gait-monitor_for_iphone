"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const webRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(__dirname, "..", "..", "..", "..");
for (const name of ["lm_turn_model.js", "lm_turn_speed.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(webRoot, name), "utf8"), {filename: name});
}

function readCsv(file) {
  const lines = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").trimEnd().split(/\r?\n/);
  const header = lines[0].split(",");
  return lines.slice(1).map(line => {
    const values = line.split(",");
    return Object.fromEntries(header.map((name, index) => [name, values[index]]));
  });
}

function sampleFromRow(row) {
  return {
    frame: Number(row.frame),
    adc_us: Number(row.adc_us),
    imu_us: Number(row.imu_us),
    plot_s: Number(row.plot_s),
    voltage: [0, 1, 2, 3].map(index => Number(row[`voltage_${index}`])),
    acceleration: ["x", "y", "z"].map(axis => Number(row[`accel_${axis}`])),
    angular_rate: ["x", "y", "z"].map(axis => Number(row[`gyro_${axis}`])),
  };
}

const experiments = {
  Level2: "跑步机2.0kmh直行200m_20261007_082311.csv",
  Level4: "跑步机4.0kmh直行400m_20261007_081548.csv",
  Incline3: "跑步机4.0kmh坡度3直行400m_20261007_083202.csv",
  Clockwise: "顺时针行走_20261007_084152.csv",
  CounterClockwise: "逆时针行走_20261007_084414.csv",
};

const referenceRows = readCsv(path.join(
  projectRoot, "matlab", "speed_aware_lm_results", "mobile_replay_cycle_results.csv"
)).filter(row => row.model === "Speed-conditioned");

const numericPairs = [
  ["score", "lm_turn_score"],
  ["onsetScore", "onset_score"],
  ["peakScore", "peak_score"],
  ["turnProbability", "turn_probability"],
  ["start", "cycle_start_s"],
  ["end", "cycle_end_s"],
  ["duration", "cycle_duration_s"],
  ["imuSpeedProxyKmh", "imu_speed_proxy_kmh"],
  ["templateSpeedKmh", "template_speed_kmh"],
];

let checked = 0;
const maxNumericDifference = Object.fromEntries(numericPairs.map(([name]) => [name, 0]));
for (const [trial, filename] of Object.entries(experiments)) {
  const source = readCsv(path.join(projectRoot, "实验数据", filename));
  for (const [sideIndex, shoe] of ["L", "R"].entries()) {
    const detector = globalThis.GaitLMTurn.create(sideIndex);
    const actual = [];
    for (const row of source) {
      if (row.shoe !== shoe) continue;
      const result = detector.process(sampleFromRow(row));
      if (result) actual.push(result);
    }
    const expected = referenceRows.filter(row => row.trial === trial && row.shoe === shoe);
    if (actual.length !== expected.length) {
      throw new Error(`${trial}/${shoe}: cycle count ${actual.length} != ${expected.length}`);
    }
    actual.forEach((result, index) => {
      const target = expected[index];
      if (result.state !== target.state) {
        throw new Error(`${trial}/${shoe}/${index}: state ${result.state} != ${target.state}; ` +
          `actual=${JSON.stringify(result)}; expected=${JSON.stringify(target)}`);
      }
      for (const [actualName, expectedName] of numericPairs) {
        const actualValue = result[actualName];
        const expectedValue = target[expectedName] === "" ? null : Number(target[expectedName]);
        if (actualValue === null && expectedValue === null) continue;
        if (!Number.isFinite(actualValue) || !Number.isFinite(expectedValue)) {
          throw new Error(`${trial}/${shoe}/${index}: ${actualName} has inconsistent missing values`);
        }
        const difference = Math.abs(actualValue - expectedValue);
        maxNumericDifference[actualName] = Math.max(maxNumericDifference[actualName], difference);
        if (["start", "end", "duration", "imuSpeedProxyKmh", "templateSpeedKmh"].includes(actualName) &&
            difference > 1e-9 * Math.max(1, Math.abs(expectedValue))) {
          throw new Error(`${trial}/${shoe}/${index}: ${actualName} ${actualValue} != ${expectedValue}`);
        }
      }
    });
    checked += actual.length;
    const counts = Object.fromEntries(["STRAIGHT_CANDIDATE", "UNCERTAIN", "TURN", "INVALID"]
      .map(state => [state, actual.filter(result => result.state === state).length]));
    console.log(`${trial}/${shoe}: ${actual.length} cycles ${JSON.stringify(counts)}`);
  }
}

console.log(`Maximum numerical differences: ${JSON.stringify(maxNumericDifference)}`);
console.log(`PASS: ${checked} browser cycles match Python cycle boundaries, speed proxies and decisions.`);
