"use strict";

// Synthetic states check display/CSV plumbing only, not sensor performance.
const {chromium} = require(process.argv[2]);
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const {pathToFileURL} = require("node:url");

(async () => {
  const webRoot = path.resolve(__dirname, "..");
  const root = path.resolve(webRoot, "..", "..", "..");
  const artifacts = path.join(root, "matlab", "bilateral_fusion_results", "runtime_ui");
  fs.mkdirSync(artifacts, {recursive: true});
  const browser = await chromium.launch({headless: true,
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1100}});
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(pathToFileURL(path.join(webRoot, "index.html")).href);
    assert.equal(await page.locator("#turn-fused-state").innerText(), "尚未开始");
    await page.evaluate(() => {
      turnEnabled = true;
      bilateralTurn.reset();
      drawTurn();
    });
    assert.equal(await page.locator("#turn-fused-state").innerText(), "数据无效");
    await page.evaluate(() => {
      const now = performance.now();
      receiveOriginMs = now - 2200;
      for (const shoe of shoes) { shoe.status = "streaming"; shoe.lastReceivedMs = now; }
      setInterval(() => {
        receiveOriginMs = performance.now() - 2200;
        for (const shoe of shoes) shoe.lastReceivedMs = performance.now();
        for (const detector of turnDetectors) detector.resultAtMs = performance.now();
      }, 100);
      // Constant synthetic TURN + CCW probabilities isolate renderer behavior.
      const base = GaitLMTurnModel.bilateralClassifier;
      const constant = probability => [Math.log(probability / (1 - probability)), ...Array(base.weights.length - 1).fill(0)];
      bilateralTurn.model = {...base, weights: constant(.9),
        direction_classifier: {...base.direction_classifier, enabled: true, weights: constant(.85)}};
      const cycle = (start, end) => ({state: "TURN", start, end, turnProbability: .8,
        validChannels: 4, imuSpeedProxyKmh: 3, speedProxyOutOfDistribution: false,
        duration: end - start, templateSpeedKmh: 3, score: 8, onsetScore: 8,
        peakScore: 6, returnMissingCount: 0, reason: "",
        onsetDifferencesByChannel: {}, peakDifferencesByChannel: {}});
      for (const [side, detector] of turnDetectors.entries()) {
        detector.gyroBias = 0; detector.cycleCount = 1; detector.resultAtMs = now;
        detector.latest = cycle(side * .6, 1.2 + side * .6);
      }
      bilateralTurn.process(0, cycle(0, 1.2), 1.2);
      bilateralTurn.process(1, cycle(.6, 1.8), 1.8);
      drawTurn();
    });
    assert.equal(await page.locator("#turn-fused-state").innerText(), "转弯 · 逆时针");
    assert.equal(await page.locator("#turn-fused-probability").innerText(), "90.0%");
    assert.equal(await page.locator("#turn-fused-direction-probability").innerText(), "85.0%");
    assert.equal(await page.locator("#turn-fused-source").innerText(), "双脚融合");
    await page.locator(".turn-panel").screenshot({path: path.join(artifacts, "bilateral_turn_desktop.png")});
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator(".turn-panel").screenshot({path: path.join(artifacts, "bilateral_turn_mobile.png")});
    const csvRow = await page.evaluate(() => {
      recorder.active = true;
      recorder.session = "synthetic_ui_check";
      recorder.pending = [];
      recorder.record({side: 0, frame: 1, received_time_iso: "2026-10-09T00:00:00Z",
        received_unix_ns: "1", received_monotonic_ns: "1", received_s: 0,
        plot_s: 0, adc_us: 1, imu_us: 1, voltage: [0, 0, 0, 0],
        acceleration: [0, 0, 1], angular_rate: [0, 0, 0],
        bilateral_turn: bilateralTurn.snapshot(2.2)});
      recorder.active = false;
      return recorder.pending[0].trim().split(",");
    });
    assert.equal(csvRow.length, 28);
    assert.equal(csvRow[22], "TURN");
    assert.ok(Math.abs(Number(csvRow[23]) - .9) < 1e-12);
    assert.equal(csvRow[24], "BILATERAL_MODEL");
    assert.equal(csvRow[25], "COUNTERCLOCKWISE");
    assert.ok(Math.abs(Number(csvRow[26]) - .85) < 1e-12);
    assert.equal(csvRow[27], "1");
    await page.evaluate(() => {
      bilateralTurn.invalidate(1, "鞋子已断开");
      shoes[1].status = "disconnected";
      drawTurn();
    });
    assert.equal(await page.locator("#turn-fused-source").innerText(), "仅左脚");
    assert.equal(await page.locator("#turn-fused-state").innerText(), "转弯 · 方向待定");
    assert.deepEqual(errors, []);
    console.log("PASS: disabled/calibrating/turn+direction/fallback states, 28-column CSV, mobile layout, no page errors.");
    console.log("Screenshots contain synthetic QA states, not measured performance.");
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
