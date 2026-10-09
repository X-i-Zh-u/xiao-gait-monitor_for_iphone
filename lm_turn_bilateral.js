// Completed-cycle bilateral turning model. All matching uses already received cycles.
(function (root) {
  "use strict";

  const EPSILON = 1e-9;
  const CHANNELS = ["medial_heel", "medial_forefoot", "lateral_forefoot", "lateral_heel"];
  const VALID_STATES = new Set(["TURN", "STRAIGHT_CANDIDATE", "UNCERTAIN"]);
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const number = value => value !== null && value !== undefined && value !== "" &&
    Number.isFinite(Number(value)) ? Number(value) : null;
  const first = (object, names) => {
    for (const name of names) if (object[name] !== undefined) return object[name];
    return null;
  };
  const sideName = side => side === 0 || side === "L" || side === "LEFT" ? "L" :
    side === 1 || side === "R" || side === "RIGHT" ? "R" : null;
  const isOutOfDistribution = value => {
    if (value === null || value === undefined || (typeof value === "number" && !finite(value))) return true;
    if (typeof value === "string") return !["false", "0", "no"].includes(value.trim().toLowerCase());
    return Boolean(value);
  };

  function normalizeCycle(input) {
    const start = number(first(input, ["cycle_start_s", "start"]));
    const end = number(first(input, ["cycle_end_s", "end"]));
    const cycle = {
      state: input.state, start, end,
      probability: number(first(input, ["turn_probability", "turnProbability"])),
      speed: number(first(input, ["imu_speed_proxy_kmh", "imuSpeedProxyKmh"])),
      validChannels: number(first(input, ["valid_channel_count", "validChannels"])),
      outOfDistribution: first(input, ["speed_proxy_out_of_distribution", "speedProxyOutOfDistribution"]),
      residuals: {},
    };
    for (const kind of ["onset", "peak"]) {
      const byChannel = input[`${kind}DifferencesByChannel`] || input[`${kind}_differences_by_channel`] || {};
      CHANNELS.forEach((channel, index) => {
        const key = `${kind}_delta_${channel}_percent`;
        const nested = Array.isArray(byChannel) ? byChannel[index] : byChannel[channel];
        const value = nested !== undefined ? nested : input[key];
        cycle.residuals[key] = number(value);
      });
    }
    return cycle;
  }

  function pairFeatures(left, right) {
    const features = {};
    for (const kind of ["onset", "peak"]) {
      for (const channel of CHANNELS) {
        const key = `${kind}_delta_${channel}_percent`;
        const l = left.residuals[key], r = right.residuals[key];
        features[`common_${key}`] = finite(l) && finite(r) ? (l + r) / 2 : null;
        features[`right_minus_left_${key}`] = finite(l) && finite(r) ? r - l : null;
      }
    }
    const leftDuration = left.end - left.start, rightDuration = right.end - right.start;
    features.speed_mean_kmh = finite(left.speed) && finite(right.speed) ? (left.speed + right.speed) / 2 : null;
    features.speed_abs_difference_kmh = finite(left.speed) && finite(right.speed) ? Math.abs(right.speed - left.speed) : null;
    features.duration_mean_s = (leftDuration + rightDuration) / 2;
    features.duration_asymmetry = (rightDuration - leftDuration) / (rightDuration + leftDuration);
    features.minimum_valid_channel_fraction = finite(left.validChannels) && finite(right.validChannels) ?
      Math.min(left.validChannels, right.validChannels) / 4 : null;
    // A missing distribution check is treated as out of distribution, matching training.
    features.either_speed_out_of_distribution = Number(
      isOutOfDistribution(left.outOfDistribution) || isOutOfDistribution(right.outOfDistribution));
    return features;
  }

  function predict(model, features) {
    if (!model || !Array.isArray(model.feature_names)) return null;
    const names = model.feature_names, count = names.length;
    if (!Array.isArray(model.weights) || model.weights.length !== 1 + 2 * count ||
        !Array.isArray(model.feature_medians) || model.feature_medians.length !== count ||
        !Array.isArray(model.feature_centers) || model.feature_centers.length !== count ||
        !Array.isArray(model.feature_scales) || model.feature_scales.length !== count) return null;
    let score = model.weights[0];
    if (!finite(score)) return null;
    for (let index = 0; index < count; index++) {
      const raw = features[names[index]], missing = !finite(raw);
      const value = missing ? model.feature_medians[index] : raw;
      const center = model.feature_centers[index], scale = model.feature_scales[index];
      const weight = model.weights[1 + index], missingWeight = model.weights[1 + count + index];
      if (![value, center, scale, weight, missingWeight].every(finite) || scale <= 0) return null;
      score += weight * (value - center) / scale + missingWeight * Number(missing);
    }
    score = Math.max(-30, Math.min(30, score));
    return 1 / (1 + Math.exp(-score));
  }

  function blank(reason, pairedCount) {
    return {
      state: "INVALID", turn_probability: null, source: "NONE", reason,
      paired_cycle_count: pairedCount, cycle_start_s: null, cycle_end_s: null,
      left_cycle_end_s: null, right_cycle_end_s: null, midpoint_difference_s: null,
      overlap_fraction: null, imu_speed_proxy_kmh: null,
      single_max_probability: null, single_mean_probability: null,
      direction: "UNKNOWN", direction_probability: null,
    };
  }

  class BilateralDetector {
    constructor(model) {
      this.model = model && model.bilateralClassifier ? model.bilateralClassifier :
        (model || (root.GaitLMTurnModel && root.GaitLMTurnModel.bilateralClassifier) || null);
      const config = this.model || {}, thresholds = config.thresholds || {}, pairing = config.pairing || {};
      this.turnThreshold = number(first(thresholds, ["turn"])) ??
        number(first(config, ["turn_display_threshold", "turn_threshold"])) ?? 0.6;
      this.straightThreshold = number(first(thresholds, ["straight"])) ??
        number(first(config, ["straight_display_threshold", "straight_threshold"])) ?? 0.4;
      this.freshness = number(config.freshness_s) ?? 3;
      this.maxMidpointDifference = number(pairing.maximum_midpoint_difference_s) ?? 0.9;
      this.minOverlap = number(pairing.minimum_overlap_fraction) ?? 0.15;
      this.reset();
    }

    reset() {
      this.queues = {L: [], R: []}; this.latest = {L: null, R: null};
      this.lastEnd = {L: null, R: null}; this.now = null;
      this.pairedCount = 0; this.current = null; this.currentPair = null;
      this.invalidReason = "WAITING_FOR_COMPLETED_CYCLE";
    }

    state(probability) {
      return probability >= this.turnThreshold ? "TURN" :
        probability <= this.straightThreshold ? "STRAIGHT_CANDIDATE" : "UNCERTAIN";
    }

    advance(now) {
      if (finite(now)) this.now = this.now === null ? now : Math.max(this.now, now);
      if (this.now === null) return;
      for (const side of ["L", "R"]) {
        this.queues[side] = this.queues[side].filter(cycle => this.fresh(cycle));
        if (this.latest[side] && !this.fresh(this.latest[side])) this.latest[side] = null;
      }
    }

    fresh(cycle) {
      return !!cycle && finite(this.now) && cycle.end <= this.now + EPSILON &&
        this.now - cycle.end <= this.freshness + EPSILON;
    }

    fallback() {
      let side = null;
      for (const candidate of ["L", "R"]) {
        if (this.fresh(this.latest[candidate]) &&
            (side === null || this.latest[candidate].end > this.latest[side].end + EPSILON)) side = candidate;
      }
      if (side === null) return null;
      const cycle = this.latest[side], output = blank("SINGLE_FOOT_FALLBACK", this.pairedCount);
      Object.assign(output, {
        state: this.state(cycle.probability), turn_probability: cycle.probability,
        source: side === "L" ? "LEFT_ONLY" : "RIGHT_ONLY",
        cycle_start_s: cycle.start, cycle_end_s: cycle.end,
        left_cycle_end_s: side === "L" ? cycle.end : null,
        right_cycle_end_s: side === "R" ? cycle.end : null,
        imu_speed_proxy_kmh: cycle.speed,
        single_max_probability: cycle.probability, single_mean_probability: cycle.probability,
      });
      return output;
    }

    snapshot(now = null) {
      this.advance(number(now));
      if (this.currentPair && (!this.fresh(this.currentPair.L) || !this.fresh(this.currentPair.R))) {
        this.current = null; this.currentPair = null;
      }
      if (this.current && !this.currentPair &&
          this.now - this.current.cycle_end_s > this.freshness + EPSILON) this.current = null;
      const fallback = this.fallback();
      if (!this.current || (fallback && fallback.cycle_end_s > this.current.cycle_end_s + EPSILON)) {
        this.current = fallback; this.currentPair = null;
      }
      if (!this.current) return blank(this.invalidReason || "STALE_OR_MISSING_CYCLE", this.pairedCount);
      return {...this.current, paired_cycle_count: this.pairedCount};
    }

    invalidate(side, reason = "FOOT_INVALID") {
      const name = sideName(side);
      if (name === null) return this.snapshot();
      this.queues[name] = []; this.latest[name] = null; this.lastEnd[name] = null;
      this.current = null; this.currentPair = null;
      this.invalidReason = reason || "FOOT_INVALID";
      return this.snapshot();
    }

    process(side, input, now) {
      const name = sideName(side), receivedNow = number(now);
      this.advance(receivedNow);
      if (name === null || !input || typeof input !== "object" || receivedNow === null) return this.snapshot();
      if (input.state === "INVALID") return this.invalidate(name, input.reason || "FOOT_INVALID");
      const cycle = normalizeCycle(input);
      if (!finite(cycle.start) || !finite(cycle.end) || cycle.end <= cycle.start ||
          cycle.end > receivedNow + EPSILON ||
          (this.lastEnd[name] !== null && cycle.end <= this.lastEnd[name] + EPSILON)) return this.snapshot();
      if (!VALID_STATES.has(cycle.state) || !finite(cycle.probability) ||
          cycle.probability < 0 || cycle.probability > 1 || !finite(cycle.validChannels) ||
          cycle.validChannels < 2) return this.invalidate(name, input.reason || "INVALID_CYCLE_RESULT");
      if (!this.fresh(cycle)) return this.snapshot();
      this.invalidReason = "STALE_OR_MISSING_CYCLE";
      this.lastEnd[name] = cycle.end; this.latest[name] = cycle;
      this.queues[name].push(cycle);
      if (this.queues[name].length > 8) this.queues[name].shift();

      const other = name === "L" ? "R" : "L";
      const midpoint = (cycle.start + cycle.end) / 2;
      const matches = this.queues[other].map((candidate, index) => {
        const difference = Math.abs((candidate.start + candidate.end) / 2 - midpoint);
        const overlap = Math.max(0, Math.min(cycle.end, candidate.end) - Math.max(cycle.start, candidate.start));
        const fraction = overlap / Math.min(cycle.end - cycle.start, candidate.end - candidate.start);
        return {candidate, index, difference, fraction};
      }).filter(match => match.difference <= this.maxMidpointDifference + EPSILON &&
        match.fraction >= this.minOverlap - EPSILON)
        .sort((a, b) => a.difference - b.difference || a.candidate.end - b.candidate.end);
      if (matches.length) {
        const match = matches[0], left = name === "L" ? cycle : match.candidate;
        const right = name === "R" ? cycle : match.candidate;
        const features = pairFeatures(left, right), probability = predict(this.model, features);
        if (probability !== null) {
          this.queues[name] = this.queues[name].filter(candidate => candidate !== cycle);
          this.queues[other].splice(match.index, 1);
          this.pairedCount++;
          const output = blank("", this.pairedCount);
          Object.assign(output, {
            state: this.state(probability), turn_probability: probability, source: "BILATERAL_MODEL",
            cycle_start_s: Math.min(left.start, right.start), cycle_end_s: Math.max(left.end, right.end),
            left_cycle_end_s: left.end, right_cycle_end_s: right.end,
            midpoint_difference_s: (right.start + right.end - left.start - left.end) / 2,
            overlap_fraction: match.fraction, imu_speed_proxy_kmh: features.speed_mean_kmh,
            single_max_probability: Math.max(left.probability, right.probability),
            single_mean_probability: (left.probability + right.probability) / 2,
          });
          const directionModel = this.model.direction_classifier;
          if (output.state === "TURN" && directionModel && directionModel.enabled === true) {
            const directionProbability = predict(directionModel, features);
            if (directionProbability !== null) {
              const thresholds = directionModel.thresholds || {};
              const positive = number(thresholds.positive) ?? number(first(directionModel,
                ["counterclockwise_threshold", "positive_display_threshold"])) ?? 0.6;
              const negative = number(thresholds.negative) ?? number(first(directionModel,
                ["clockwise_threshold", "negative_display_threshold"])) ?? 0.4;
              output.direction_probability = directionProbability;
              output.direction = directionProbability >= positive ? "COUNTERCLOCKWISE" :
                directionProbability <= negative ? "CLOCKWISE" : "UNKNOWN";
            }
          }
          if (!this.current || output.cycle_end_s >= this.current.cycle_end_s - EPSILON) {
            this.current = output; this.currentPair = {L: left, R: right};
          }
        }
      }
      return this.snapshot();
    }
  }

  root.GaitLMBilateralTurn = {create: model => new BilateralDetector(model)};
})(typeof window !== "undefined" ? window : globalThis);
