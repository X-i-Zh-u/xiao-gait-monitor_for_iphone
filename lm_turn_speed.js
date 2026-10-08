(function (root) {
  "use strict";

  const model = root.GaitLMTurnModel;
  if (!model) throw new Error("缺少 lm_turn_model.js，请先加载手机端转弯模型");

  const channels = model.channels;
  const templates = model.templates;
  const speedModel = model.speedModel;
  const turnClassifier = model.turnClassifier;
  const rawIndices = [[0, 1, 2, 3], [3, 2, 1, 0]];
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const circularDelta = (phase, reference) => ((phase - reference + 50) % 100 + 100) % 100 - 50;
  const finite = value => typeof value === "number" && Number.isFinite(value);

  function interpolatePhase(low, high, weight) {
    return ((low + weight * circularDelta(high, low)) % 100 + 100) % 100;
  }

  function interpolateTemplates(side, speedKmh) {
    const available = Object.keys(templates[String(side)]).map(Number).sort((a, b) => a - b);
    const clipped = Math.min(Math.max(speedKmh, available[0]), available[available.length - 1]);
    const lowSpeed = Math.max(...available.filter(speed => speed <= clipped));
    const highSpeed = Math.min(...available.filter(speed => speed >= clipped));
    const weight = highSpeed === lowSpeed ? 0 : (clipped - lowSpeed) / (highSpeed - lowSpeed);
    const output = {};
    for (const channel of channels) {
      const low = templates[String(side)][String(lowSpeed)][channel];
      const high = templates[String(side)][String(highSpeed)][channel];
      output[channel] = {
        polarity: low.polarity === high.polarity ? low.polarity : (weight < 0.5 ? low.polarity : high.polarity),
        on: low.on + weight * (high.on - low.on),
        off: low.off + weight * (high.off - low.off),
        onset: interpolatePhase(low.onset, high.onset, weight),
        peak: interpolatePhase(low.peak, high.peak, weight),
      };
    }
    return {template: output, clipped, lowSpeed, highSpeed, weight};
  }

  function estimateImuSpeed(side, duration, records) {
    if (!records.length || !(duration > 0)) return null;
    const accelerationCenter = [0, 1, 2].map(axis => median(records.map(record => record.acceleration[axis])));
    const accelDynamicRms = Math.sqrt(records.reduce((sum, record) => sum +
      record.acceleration.reduce((axisSum, value, axis) => axisSum + (value - accelerationCenter[axis]) ** 2, 0), 0) / records.length);
    const gyroYRms = Math.sqrt(records.reduce((sum, record) => sum + record.gyroYCorrected ** 2, 0) / records.length);
    const features = {
      stride_frequency_hz: 1 / duration,
      accel_dynamic_rms_g: accelDynamicRms,
      gyro_y_rms_deg_s: gyroYRms,
    };
    const foot = speedModel.feet[side === 0 ? "L" : "R"];
    const standardized = foot.feature_names.map((name, index) =>
      (features[name] - foot.feature_center[index]) / foot.feature_scale[index]);
    const axis = foot.centroid_4_kmh.map((value, index) => value - foot.centroid_2_kmh[index]);
    const projection = standardized.reduce((sum, value, index) =>
      sum + (value - foot.centroid_2_kmh[index]) * axis[index], 0) / foot.axis_denominator;
    const rawSpeed = speedModel.calibrated_speed_min_kmh + projection *
      (speedModel.calibrated_speed_max_kmh - speedModel.calibrated_speed_min_kmh);
    const fitted = foot.centroid_2_kmh.map((value, index) => value + projection * axis[index]);
    const orthogonalDistance = Math.sqrt(standardized.reduce((sum, value, index) =>
      sum + (value - fitted[index]) ** 2, 0));
    const margin = speedModel.extrapolation_margin_kmh || 0;
    return {
      imuSpeedProxyKmh: rawSpeed,
      speedAxisOrthogonalDistance: orthogonalDistance,
      speedProxyOutOfDistribution: orthogonalDistance > foot.orthogonal_distance_p95,
      speedProxyExtrapolated: rawSpeed < speedModel.calibrated_speed_min_kmh - margin ||
        rawSpeed > speedModel.calibrated_speed_max_kmh + margin,
      strideFrequencyHz: features.stride_frequency_hz,
      accelDynamicRmsG: features.accel_dynamic_rms_g,
      gyroYRmsDegS: features.gyro_y_rms_deg_s,
    };
  }

  function turnProbability(side, onsetByChannel, peakByChannel) {
    const raw = turnClassifier.feature_names.map(feature => {
      if (feature.startsWith("onset_delta_") && feature.endsWith("_percent")) {
        return onsetByChannel[feature.slice("onset_delta_".length, -"_percent".length)];
      }
      if (feature.startsWith("peak_delta_") && feature.endsWith("_percent")) {
        return peakByChannel[feature.slice("peak_delta_".length, -"_percent".length)];
      }
      throw new Error("速度条件 LM 分类器含未知特征");
    });
    const missing = raw.map(value => !finite(value));
    const standardized = raw.map((value, index) => {
      const imputed = missing[index] ? turnClassifier.feature_medians[index] : value;
      return (imputed - turnClassifier.feature_centers[index]) / turnClassifier.feature_scales[index];
    });
    const vector = [1, ...standardized, ...missing.map(Number), Number(side === 1)];
    let linear = vector.reduce((sum, value, index) => sum + value * turnClassifier.weights[index], 0);
    linear = Math.min(Math.max(linear, -30), 30);
    return 1 / (1 + Math.exp(-linear));
  }

  function firstHeld(values, times, start, threshold, above) {
    let onset = -1;
    let held = 0;
    const thresholdQuantized = Math.floor(threshold * 1e10 + 0.5);
    for (let index = start; index < values.length; index += 1) {
      const valueQuantized = Math.floor(values[index] * 1e10 + 0.5);
      const qualifies = above ? valueQuantized >= thresholdQuantized : valueQuantized <= thresholdQuantized;
      if (!qualifies) {
        onset = -1;
        held = 0;
        continue;
      }
      if (onset < 0) onset = index;
      held += Math.max(0, index ? times[index] - times[index - 1] : 0.02);
      if (held >= 0.04 - 1e-9) return [onset, index];
    }
    return null;
  }

  function primaryEvent(values, times, template) {
    let start = 0;
    let best = null;
    while (start < values.length) {
      const onset = firstHeld(values, times, start, template.on, true);
      if (!onset) break;
      const returned = firstHeld(values, times, onset[1] + 1, template.off, false);
      const end = returned ? returned[0] : values.length - 1;
      let peak = onset[0];
      for (let index = peak + 1; index <= end; index += 1) {
        if (values[index] > values[peak]) peak = index;
      }
      if (!best || values[peak] > best.height) {
        best = {height: values[peak], onset: onset[0], peak, returnMissing: !returned};
      }
      if (!returned) break;
      start = returned[1] + 1;
    }
    return best;
  }

  function invalid(reason, start = null, end = null, count = 0) {
    return {
      state: "INVALID", reason, score: null, onsetScore: null, peakScore: null,
      turnProbability: null, validChannels: count, returnMissingCount: 0,
      start, end, duration: null, imuSpeedProxyKmh: null, templateSpeedKmh: null,
      speedProxyExtrapolated: null, speedProxyOutOfDistribution: null,
      speedAxisOrthogonalDistance: null,
    };
  }

  class Detector {
    constructor(side) {
      this.side = side;
      this.reset();
    }

    reset() {
      this.lastFrame = this.lastAdcUs = this.lastImuUs = null;
      this.adcElapsedS = 0;
      this.quiet = [];
      this.gyroBias = null;
      this.cycleCount = 0;
      this.resultAtMs = null;
      this.resetCycle();
      this.latest = invalid("等待静止校准");
    }

    resetCycle() {
      this.gyroFiltered = this.previousSignal = this.olderSignal = null;
      this.previousRecord = this.lastAnchorS = null;
      this.records = [];
    }

    invalidate(reason) {
      this.resetCycle();
      this.latest = invalid(reason);
      return this.latest;
    }

    classify(records, start, end) {
      const duration = end - start;
      if (duration < 0.75 - 1e-9 || duration > 1.8 + 1e-9 || records.length < 10) {
        return invalid("候选周期长度无效", start, end);
      }
      const speed = estimateImuSpeed(this.side, duration, records);
      if (!speed) return invalid("IMU步速特征不足", start, end);
      const interpolated = interpolateTemplates(this.side, speed.imuSpeedProxyKmh);
      const phases = records.map(record => 100 * (record.plot_s - start) / duration);
      const quiet = phases.map((phase, index) => phase <= 10 + 1e-9 || phase >= 90 - 1e-9 ? index : -1)
        .filter(index => index >= 0);
      if (quiet.length < 2) return invalid("周期基线数据不足", start, end);

      const holdTimes = records.map(record => record.adcElapsedS);
      const onsetDiffs = [];
      const peakDiffs = [];
      const onsetByChannel = {};
      const peakByChannel = {};
      let returnMissingCount = 0;
      channels.forEach((channel, channelIndex) => {
        const raw = records.map(record =>
          Math.floor(record.voltage[rawIndices[this.side][channelIndex]] * 1e7 + 0.5) / 1e7);
        const baseline = median(quiet.map(index => raw[index]));
        const filtered = [raw[0]];
        for (let index = 1; index < raw.length; index += 1) {
          const alpha = 1 - Math.exp(-records[index].adcDtS / 0.05);
          filtered.push(filtered[index - 1] + alpha * (raw[index] - filtered[index - 1]));
        }
        const template = interpolated.template[channel];
        const directed = filtered.map(value => template.polarity * (value - baseline));
        const event = primaryEvent(directed, holdTimes, template);
        if (!event) return;
        returnMissingCount += Number(event.returnMissing);
        const onsetDifference = circularDelta(phases[event.onset], template.onset);
        const peakDifference = circularDelta(phases[event.peak], template.peak);
        onsetDiffs.push(Math.abs(onsetDifference));
        peakDiffs.push(Math.abs(peakDifference));
        onsetByChannel[channel] = onsetDifference;
        peakByChannel[channel] = peakDifference;
      });

      const count = onsetDiffs.length;
      if (count < 2) {
        return Object.assign(invalid("有效LM通道不足2个", start, end, count), speed, {
          templateSpeedKmh: interpolated.clipped,
          templateSpeedLowKmh: interpolated.lowSpeed,
          templateSpeedHighKmh: interpolated.highSpeed,
          templateSpeedWeight: interpolated.weight,
        });
      }
      const onsetScore = median(onsetDiffs);
      const peakScore = median(peakDiffs);
      const probability = turnProbability(this.side, onsetByChannel, peakByChannel);
      const state = probability >= turnClassifier.turn_display_threshold ? "TURN" :
        probability <= turnClassifier.straight_display_threshold ? "STRAIGHT_CANDIDATE" : "UNCERTAIN";
      return Object.assign({
        state, reason: "", score: Math.max(onsetScore, peakScore), onsetScore, peakScore,
        turnProbability: probability, onsetDifferencesByChannel: onsetByChannel,
        peakDifferencesByChannel: peakByChannel, validChannels: count,
        returnMissingCount, start, end, duration,
        templateSpeedKmh: interpolated.clipped,
        templateSpeedLowKmh: interpolated.lowSpeed,
        templateSpeedHighKmh: interpolated.highSpeed,
        templateSpeedWeight: interpolated.weight,
      }, speed);
    }

    process(sample) {
      const frameStep = this.lastFrame === null ? null : (sample.frame - this.lastFrame) >>> 0;
      const adcDt = this.lastAdcUs === null ? null : ((sample.adc_us - this.lastAdcUs) >>> 0) / 1e6;
      const imuDt = this.lastImuUs === null ? null : ((sample.imu_us - this.lastImuUs) >>> 0) / 1e6;
      this.lastFrame = sample.frame;
      this.lastAdcUs = sample.adc_us;
      this.lastImuUs = sample.imu_us;
      if (adcDt !== null && adcDt > 0) this.adcElapsedS += adcDt;
      if (frameStep !== null && (frameStep !== 1 || !(adcDt > 0 && adcDt <= 0.06) || !(imuDt > 0 && imuDt <= 0.06))) {
        this.quiet = [];
        if (frameStep >= 0x80000000) {
          this.gyroBias = null;
          return this.invalidate("设备帧号回退，等待重新静止校准");
        }
        return this.invalidate("缺帧或时间间隔异常，等待新周期");
      }

      const t = sample.plot_s;
      const gyro = sample.angular_rate;
      const acceleration = sample.acceleration;
      const gyroNorm = Math.hypot(...gyro);
      const accelNorm = Math.hypot(...acceleration);
      if (this.gyroBias === null) {
        if (gyroNorm <= 10 && Math.abs(accelNorm - 1) <= 0.1) {
          this.quiet.push({t, gyroY: gyro[1]});
          if (t - this.quiet[0].t >= 0.39) {
            this.gyroBias = median(this.quiet.map(record => record.gyroY));
            this.quiet = [];
            this.latest = invalid("等待完整候选周期");
          }
        } else this.quiet = [];
        return null;
      }

      const corrected = gyro[1] - this.gyroBias;
      const record = {
        plot_s: t, voltage: sample.voltage, acceleration,
        gyroYCorrected: corrected, adcDtS: adcDt || 0.02,
        adcElapsedS: this.adcElapsedS,
      };
      this.records.push(record);
      if (this.records.length > 130) this.records.shift();
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
          this.latest = result;
          this.cycleCount += 1;
        }
        this.lastAnchorS = anchorTime;
        this.records = this.records.filter(item => item.plot_s >= anchorTime);
      }
      this.olderSignal = this.previousSignal;
      this.previousSignal = signal;
      this.previousRecord = record;
      return result;
    }
  }

  root.GaitLMTurn = {
    create: side => new Detector(side),
    model,
    test: {interpolateTemplates, estimateImuSpeed, turnProbability},
  };
})(typeof window !== "undefined" ? window : globalThis);
