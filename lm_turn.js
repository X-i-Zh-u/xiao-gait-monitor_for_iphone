// Legacy fixed-4-km/h implementation retained only for historical comparison.
// index.html now loads lm_turn_model.js + lm_turn_speed.js instead of this file.
(function (root) {
  "use strict";

  // Frozen 4 km/h straight templates exported by straight_4kmh_template.csv.
  // Canonical channel order: medial heel, medial forefoot, lateral forefoot, lateral heel.
  // Each row: polarity, onset threshold V, return threshold V, onset %, peak %.
  const templates = [
    [
      [1, 0.0016654242686132527, 0.0012490682014599395, 25, 37],
      [1, 0.007087417263818612, 0.003543708631909306, 56, 75],
      [1, 0.0065454415412262434, 0.0032727207706131217, 39, 73],
      [1, 0.0022499210667382336, 0.0011249605333691168, 16.5, 34],
    ],
    [
      [1, 0.0026913154742086412, 0.0013456577371043206, 20, 34],
      [1, 0.00482597251659897, 0.002412986258299485, 50, 73],
      [1, 0.003211198066092813, 0.0016055990330464064, 52, 73],
      [1, 0.002250637051803611, 0.0011253185259018055, 18, 31],
    ],
  ];
  const rawIndices = [[0, 1, 2, 3], [3, 2, 1, 0]];
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const phaseDifference = (phase, reference) => ((phase - reference + 50) % 100 + 100) % 100 - 50;

  function firstHeld(values, times, start, threshold, above) {
    // Match the desktop classifier: each qualified sample covers its preceding dt.
    let onset = -1, held = 0;
    for (let i = start; i < values.length; i++) {
      const qualifies = above ? values[i] >= threshold : values[i] <= threshold;
      if (!qualifies) { onset = -1; held = 0; continue; }
      if (onset < 0) onset = i;
      held += Math.max(0, i ? times[i] - times[i - 1] : 0.02);
      if (held >= 0.04 - 1e-9) return [onset, i];
    }
    return null;
  }

  function primaryEvent(values, times, template) {
    let start = 0, best = null;
    while (start < values.length) {
      const onset = firstHeld(values, times, start, template[1], true);
      if (!onset) break;
      const returned = firstHeld(values, times, onset[1] + 1, template[2], false);
      const end = returned ? returned[0] : values.length - 1;
      let peak = onset[0];
      for (let i = peak + 1; i <= end; i++) if (values[i] > values[peak]) peak = i;
      if (!best || values[peak] > best.height) {
        best = {height: values[peak], onset: onset[0], peak, returnMissing: !returned};
      }
      if (!returned) break;
      start = returned[1] + 1;
    }
    return best;
  }

  function invalid(reason, start = null, end = null, count = 0) {
    return {state: "INVALID", reason, score: null, onsetScore: null, peakScore: null,
      validChannels: count, start, end, duration: null};
  }

  class Detector {
    constructor(side) { this.side = side; this.reset(); }
    reset() {
      this.lastFrame = this.lastAdcUs = this.lastImuUs = null;
      this.adcElapsedS = 0; this.quiet = []; this.gyroBias = null;
      this.cycleCount = 0; this.resultAtMs = null;
      this.resetCycle(); this.latest = invalid("等待静止校准");
    }
    resetCycle() {
      this.gyroFiltered = this.previousSignal = this.olderSignal = null;
      this.previousRecord = this.lastAnchorS = null; this.records = [];
    }
    invalidate(reason) { this.resetCycle(); this.latest = invalid(reason); return this.latest; }

    classify(records, start, end) {
      const duration = end - start;
      if (duration < 0.75 || duration > 1.8 || records.length < 10) return invalid("候选周期长度无效", start, end);
      const phases = records.map(record => 100 * (record.plot_s - start) / duration);
      const quiet = phases.map((phase, index) => phase <= 10 || phase >= 90 ? index : -1).filter(index => index >= 0);
      if (quiet.length < 2) return invalid("周期基线数据不足", start, end);
      const holdTimes = records.map(record => record.adcElapsedS);
      const onsetDiffs = [], peakDiffs = [];
      let returnMissingCount = 0;
      for (let channel = 0; channel < 4; channel++) {
        const raw = records.map(record => record.voltage[rawIndices[this.side][channel]]);
        const baseline = median(quiet.map(index => raw[index]));
        const filtered = [raw[0]];
        for (let i = 1; i < raw.length; i++) {
          const alpha = 1 - Math.exp(-records[i].adcDtS / 0.05);
          filtered.push(filtered[i - 1] + alpha * (raw[i] - filtered[i - 1]));
        }
        const template = templates[this.side][channel];
        const directed = filtered.map(value => template[0] * (value - baseline));
        const event = primaryEvent(directed, holdTimes, template);
        if (!event) continue;
        returnMissingCount += Number(event.returnMissing);
        onsetDiffs.push(Math.abs(phaseDifference(phases[event.onset], template[3])));
        peakDiffs.push(Math.abs(phaseDifference(phases[event.peak], template[4])));
      }
      const count = onsetDiffs.length;
      if (count < 2) return invalid("有效LM通道不足2个", start, end, count);
      const onsetScore = median(onsetDiffs), peakScore = median(peakDiffs);
      const score = Math.max(onsetScore, peakScore);
      const state = score >= 5 ? "TURN" : score <= 3.25 ? "STRAIGHT_CANDIDATE" : "UNCERTAIN";
      return {state, reason: "", score, onsetScore, peakScore, validChannels: count,
        returnMissingCount, start, end, duration};
    }

    process(sample) {
      const frameStep = this.lastFrame === null ? null : (sample.frame - this.lastFrame) >>> 0;
      const adcDt = this.lastAdcUs === null ? null : ((sample.adc_us - this.lastAdcUs) >>> 0) / 1e6;
      const imuDt = this.lastImuUs === null ? null : ((sample.imu_us - this.lastImuUs) >>> 0) / 1e6;
      this.lastFrame = sample.frame; this.lastAdcUs = sample.adc_us; this.lastImuUs = sample.imu_us;
      if (adcDt !== null && adcDt > 0) this.adcElapsedS += adcDt;
      if (frameStep !== null && (frameStep !== 1 || !(adcDt > 0 && adcDt <= 0.06) || !(imuDt > 0 && imuDt <= 0.06))) {
        this.quiet = [];
        if (frameStep >= 0x80000000) { this.gyroBias = null; return this.invalidate("设备帧号回退，等待重新静止校准"); }
        return this.invalidate("缺帧或时间间隔异常，等待新周期");
      }

      const t = sample.plot_s, gyro = sample.angular_rate, acceleration = sample.acceleration;
      const gyroNorm = Math.hypot(...gyro), accelNorm = Math.hypot(...acceleration);
      if (this.gyroBias === null) {
        if (gyroNorm <= 10 && Math.abs(accelNorm - 1) <= 0.1) {
          this.quiet.push({t, gyroY: gyro[1]});
          if (t - this.quiet[0].t >= 0.39) {
            this.gyroBias = median(this.quiet.map(record => record.gyroY));
            this.quiet = []; this.latest = invalid("等待完整候选周期");
          }
        } else this.quiet = [];
        return null;
      }

      const record = {plot_s: t, voltage: sample.voltage, adcDtS: adcDt || 0.02, adcElapsedS: this.adcElapsedS};
      this.records.push(record);
      if (this.records.length > 130) this.records.shift();
      const corrected = gyro[1] - this.gyroBias;
      if (this.gyroFiltered === null) this.gyroFiltered = corrected;
      else this.gyroFiltered += (1 - Math.exp(-imuDt / 0.05)) * (corrected - this.gyroFiltered);
      const signal = -this.gyroFiltered;
      const anchor = this.olderSignal !== null && this.previousSignal !== null &&
        this.previousSignal >= this.olderSignal && this.previousSignal > signal &&
        this.previousSignal >= 20 &&
        (this.lastAnchorS === null || this.previousRecord.plot_s - this.lastAnchorS >= 0.70);
      let result = null;
      if (anchor) {
        const anchorTime = this.previousRecord.plot_s;
        if (this.lastAnchorS !== null) {
          const cycle = this.records.filter(item => item.plot_s >= this.lastAnchorS && item.plot_s < anchorTime);
          result = this.classify(cycle, this.lastAnchorS, anchorTime);
          this.latest = result; this.cycleCount++;
        }
        this.lastAnchorS = anchorTime;
        this.records = this.records.filter(item => item.plot_s >= anchorTime);
      }
      this.olderSignal = this.previousSignal; this.previousSignal = signal; this.previousRecord = record;
      return result;
    }
  }

  root.GaitLMTurn = {create: side => new Detector(side)};
})(typeof window !== "undefined" ? window : globalThis);
