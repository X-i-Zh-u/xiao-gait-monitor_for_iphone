"use strict";

const protocol = window.GaitProtocol;
const colors = ["#3f6f91", "#4b8b82", "#c2843d", "#9a6378"];
const historyLimit = 1000;
const reconnectDelayMs = 1800;
const groups = [
  {key: "voltage", title: "传感器电压", unit: "V", channels: ["CH0 / RS0", "CH1 / RS1", "CH2 / RS2", "CH3 / RS3"], digits: 5, baseRange: [-0.05, 1.70]},
  {key: "acceleration", title: "三轴加速度", unit: "g", channels: ["X", "Y", "Z"], digits: 3, baseRange: [-1.2, 1.2]},
  {key: "angular_rate", title: "三轴角速度", unit: "°/s", channels: ["X", "Y", "Z"], digits: 2, baseRange: [-10, 10]},
];

const $ = id => document.getElementById(id);
let receiveOriginMs = null;

function newShoe(side) {
  return {
    side,
    name: side === 0 ? "GAIT-L" : "GAIT-R",
    device: null,
    characteristic: null,
    notificationHandler: null,
    status: "disconnected",
    error: "",
    manualDisconnect: false,
    connecting: false,
    reconnectTimer: null,
    history: [],
    receivedCount: 0,
    missingFrames: 0,
    duplicateFrames: 0,
    lastFrame: null,
    lastReceivedMs: null,
    firstReceivedMs: null,
    connectedAtMs: null,
    recent: [],
    plotOriginFrame: null,
    plotOriginS: null,
  };
}

const shoes = [newShoe(0), newShoe(1)];

function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
}

function makeShoeChartMarkup(side) {
  const label = side === 0 ? "左鞋" : "右鞋";
  return `
    <article class="shoe-chart-block stale" id="chart-shoe-${side}">
      <div class="shoe-chart-heading">
        <div class="shoe-chart-title"><span class="side-letter ${side === 0 ? "left" : "right"}">${side === 0 ? "L" : "R"}</span><strong>${label}</strong><small>GAIT-${side === 0 ? "L" : "R"}</small></div>
        <span class="shoe-chart-status" id="chart-status-${side}">等待连接</span>
      </div>
      ${groups.map(group => `
        <section class="chart-card">
          <div class="chart-card-header"><h3>${group.title} <span class="unit">${group.unit}</span></h3><div class="chart-legend">${group.channels.map((channel, index) => `<span class="legend-item"><i class="legend-line" style="--series:${colors[index]}"></i>${channel}</span>`).join("")}</div></div>
          <canvas class="plot" id="plot-${side}-${group.key}" aria-label="${label}${group.title}最近10秒曲线"></canvas>
        </section>
      `).join("")}
    </article>`;
}

function makeShoeLiveMarkup(side) {
  const label = side === 0 ? "左鞋" : "右鞋";
  return `
    <article class="live-panel stale" id="shoe-${side}">
      <div class="live-heading">
        <div><span class="side-letter ${side === 0 ? "left" : "right"}">${side === 0 ? "L" : "R"}</span><div><strong>${label}</strong><small>GAIT-${side === 0 ? "L" : "R"}</small></div></div>
        <span class="badge" id="stream-badge-${side}">无数据</span>
      </div>
      <div class="live-summary">
        <div class="summary-item"><span>Sampling Rate</span><strong id="rate-${side}">—</strong></div>
        <div class="summary-item"><span>BLE Status</span><strong id="ble-${side}">Disconnected</strong></div>
        <div class="summary-item"><span>Frame</span><strong id="frame-${side}">—</strong></div>
        <div class="summary-item"><span>Battery</span><strong>未提供</strong></div>
        <div class="summary-item"><span>Average Rate</span><strong id="average-${side}">—</strong></div>
        <div class="summary-item"><span>Last Data</span><strong id="age-${side}">—</strong></div>
        <div class="summary-item"><span>Received</span><strong id="count-${side}">0</strong></div>
        <div class="summary-item"><span>Missing / Loss</span><strong><span id="missing-${side}">0</span> / <span id="loss-${side}">0.000%</span></strong></div>
      </div>
      ${groups.map(group => `
        <section class="live-group">
          <div class="live-group-title"><strong>${group.title}</strong><span>${group.unit}</span></div>
          <div class="live-values ${group.channels.length === 4 ? "four" : ""}">
            ${group.channels.map((channel, index) => `<div class="reading"><div class="reading-label"><span class="swatch" style="--series:${colors[index]}"></span>${channel}</div><div class="reading-value" id="value-${side}-${group.key}-${index}">—</div></div>`).join("")}
          </div>
        </section>
      `).join("")}
      <div class="device-error" id="error-${side}" hidden></div>
    </article>`;
}

$("chart-area").innerHTML = makeShoeChartMarkup(0) + makeShoeChartMarkup(1);
$("live-panels").innerHTML = makeShoeLiveMarkup(0) + makeShoeLiveMarkup(1);

function statusText(status) {
  return {
    disconnected: "未连接",
    selecting: "选择设备中",
    connecting: "连接中",
    waiting: "等待数据",
    streaming: "接收中",
    reconnecting: "重新连接中",
    error: "连接失败",
  }[status] || status;
}

function refreshHeaderStatus() {
  const connected = shoes.filter(shoe => Boolean(shoe.device && shoe.device.gatt && shoe.device.gatt.connected)).length;
  const streaming = shoes.filter(shoe => shoe.status === "streaming").length;
  $("top-connection").textContent = `${connected} / 2`;
  $("top-connection-dot").className = "status-dot " + (connected === 2 ? "success" : connected === 1 ? "warning" : "neutral");
  $("top-sampling").textContent = streaming === 2 ? "50 Hz" : streaming === 1 ? "单侧" : "等待";
  $("top-sampling-dot").className = "status-dot " + (streaming === 2 ? "success" : streaming === 1 ? "warning" : "neutral");
  $("top-recording").textContent = recorder.error ? "异常" : recorder.active ? "记录中" : recorder.file ? "待导出" : "未记录";
  $("top-recording-dot").className = "status-dot " + (recorder.error ? "error" : recorder.active ? "success" : recorder.file ? "warning" : "neutral");
}

function refreshControls() {
  shoes.forEach(shoe => {
    const connected = Boolean(shoe.device && shoe.device.gatt && shoe.device.gatt.connected);
    const busy = shoe.status === "selecting" || shoe.connecting;
    $("connect-" + shoe.side).disabled = busy || connected;
    $("connect-" + shoe.side).textContent = shoe.device ? "重新连接" : "选择并连接";
    $("disconnect-" + shoe.side).disabled = !connected;
    const badge = $("badge-" + shoe.side);
    badge.textContent = statusText(shoe.status);
    badge.className = "badge" + (shoe.status === "streaming" ? " live" : shoe.status === "error" ? " problem" : "");
  });
  $("record-start").disabled = recorder.active || !shoes.some(shoe => shoe.status === "streaming");
  $("record-stop").disabled = !recorder.active;
  refreshHeaderStatus();
}

function bluetoothErrorMessage(error) {
  if (!error) return "未知蓝牙错误";
  if (error.name === "NotFoundError") return "没有选择设备，或没有发现对应的鞋子";
  if (error.name === "SecurityError") return "网页没有蓝牙权限；请确认使用Bluefy并通过HTTPS打开";
  if (error.name === "NetworkError") return "BLE连接或服务访问失败";
  return error.message || error.name || "蓝牙操作失败";
}

async function connectKnownShoe(shoe) {
  if (!shoe.device || shoe.connecting) return;
  clearTimeout(shoe.reconnectTimer);
  shoe.connecting = true;
  shoe.status = shoe.status === "disconnected" ? "connecting" : "reconnecting";
  shoe.error = "";
  refreshControls();
  refreshShoe(shoe);
  try {
    const server = shoe.device.gatt.connected ? shoe.device.gatt : await shoe.device.gatt.connect();
    const service = await server.getPrimaryService(protocol.SERVICE_UUID);
    const characteristic = await service.getCharacteristic(protocol.DATA_UUID);
    if (!shoe.notificationHandler) shoe.notificationHandler = event => receiveNotification(shoe, event);
    if (shoe.characteristic) {
      shoe.characteristic.removeEventListener("characteristicvaluechanged", shoe.notificationHandler);
    }
    characteristic.removeEventListener("characteristicvaluechanged", shoe.notificationHandler);
    characteristic.addEventListener("characteristicvaluechanged", shoe.notificationHandler);
    await characteristic.startNotifications();
    shoe.characteristic = characteristic;
    shoe.status = "waiting";
    shoe.connectedAtMs = performance.now();
    shoe.error = "";
    notice(`${shoe.name} 已连接并订阅通知，正在等待数据。`);
  } catch (error) {
    shoe.status = "error";
    shoe.error = bluetoothErrorMessage(error);
    if (!shoe.manualDisconnect) scheduleReconnect(shoe);
  } finally {
    shoe.connecting = false;
    refreshControls();
    refreshShoe(shoe);
  }
}

async function chooseAndConnect(side) {
  const shoe = shoes[side];
  if (!navigator.bluetooth) {
    notice("当前浏览器没有Web Bluetooth接口。请使用iPhone上的Bluefy打开本HTTPS页面。", true);
    return;
  }
  if (shoe.device) {
    shoe.manualDisconnect = false;
    await connectKnownShoe(shoe);
    return;
  }
  shoe.status = "selecting";
  shoe.error = "";
  refreshControls();
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{name: shoe.name, services: [protocol.SERVICE_UUID]}],
      optionalServices: [protocol.SERVICE_UUID],
    });
    shoe.device = device;
    shoe.manualDisconnect = false;
    device.addEventListener("gattserverdisconnected", () => disconnected(shoe));
    await connectKnownShoe(shoe);
  } catch (error) {
    shoe.status = "disconnected";
    shoe.error = bluetoothErrorMessage(error);
    notice(`${shoe.name}：${shoe.error}`, true);
  } finally {
    refreshControls();
    refreshShoe(shoe);
  }
}

function disconnected(shoe) {
  if (shoe.characteristic && shoe.notificationHandler) {
    shoe.characteristic.removeEventListener("characteristicvaluechanged", shoe.notificationHandler);
  }
  shoe.characteristic = null;
  shoe.connectedAtMs = null;
  shoe.status = "disconnected";
  refreshControls();
  refreshShoe(shoe);
  if (!shoe.manualDisconnect) {
    notice(`${shoe.name} 已断开，网页将尝试重新连接。`, true);
    scheduleReconnect(shoe);
  }
}

function scheduleReconnect(shoe) {
  clearTimeout(shoe.reconnectTimer);
  if (shoe.manualDisconnect || !shoe.device) return;
  shoe.reconnectTimer = setTimeout(async () => {
    await connectKnownShoe(shoe);
    if (!shoe.manualDisconnect && (!shoe.device.gatt || !shoe.device.gatt.connected)) scheduleReconnect(shoe);
  }, reconnectDelayMs);
}

async function disconnectShoe(side) {
  const shoe = shoes[side];
  shoe.manualDisconnect = true;
  clearTimeout(shoe.reconnectTimer);
  try {
    if (shoe.characteristic) await shoe.characteristic.stopNotifications();
  } catch (_) {
    // The connection may already be gone; the GATT disconnect below completes the requested action.
  }
  if (shoe.characteristic && shoe.notificationHandler) {
    shoe.characteristic.removeEventListener("characteristicvaluechanged", shoe.notificationHandler);
  }
  if (shoe.device && shoe.device.gatt.connected) shoe.device.gatt.disconnect();
  shoe.characteristic = null;
  shoe.connectedAtMs = null;
  shoe.status = "disconnected";
  shoe.error = "";
  refreshControls();
  refreshShoe(shoe);
  notice(`${shoe.name} 已断开。再次点击“重新连接”可继续使用已选择的设备。`);
}

function millisecondsToNanosecondsString(milliseconds) {
  let whole = Math.floor(milliseconds);
  let fraction = Math.round((milliseconds - whole) * 1000000);
  if (fraction >= 1000000) { whole += 1; fraction -= 1000000; }
  return String(whole) + String(fraction).padStart(6, "0");
}

function receiveNotification(shoe, event) {
  const receivedPerformanceMs = performance.now();
  const receivedUnixMs = Date.now();
  let samples;
  try {
    samples = protocol.decodeNotification(event.target.value, shoe.side);
  } catch (error) {
    shoe.status = "error";
    shoe.error = error.message;
    refreshControls();
    refreshShoe(shoe);
    return;
  }

  if (receiveOriginMs === null) receiveOriginMs = receivedPerformanceMs;
  const receivedS = (receivedPerformanceMs - receiveOriginMs) / 1000;
  const monotonicNs = millisecondsToNanosecondsString(receivedPerformanceMs);
  const unixNs = String(receivedUnixMs) + "000000";

  if (shoe.plotOriginFrame === null) {
    shoe.plotOriginFrame = samples[samples.length - 1].frame;
    shoe.plotOriginS = receivedS;
  }

  for (const sample of samples) {
    if (shoe.lastFrame !== null) {
      const delta = protocol.signedDelta(sample.frame, shoe.lastFrame);
      if (delta > 1) shoe.missingFrames += delta - 1;
      else if (delta === 0) shoe.duplicateFrames += 1;
      else if (delta < 0) {
        shoe.plotOriginFrame = samples[samples.length - 1].frame;
        shoe.plotOriginS = receivedS;
      }
    }
    shoe.lastFrame = sample.frame;
    sample.received_s = receivedS;
    sample.received_monotonic_ns = monotonicNs;
    sample.received_unix_ns = unixNs;
    sample.received_time_iso = new Date(receivedUnixMs).toISOString();
    sample.plot_s = shoe.plotOriginS + protocol.signedDelta(sample.frame, shoe.plotOriginFrame) / protocol.SAMPLE_RATE_HZ;
    shoe.history.push(sample);
    if (shoe.history.length > historyLimit) shoe.history.shift();
    shoe.receivedCount += 1;
    recorder.record(sample);
  }

  shoe.status = "streaming";
  shoe.error = "";
  shoe.lastReceivedMs = receivedPerformanceMs;
  if (shoe.firstReceivedMs === null) shoe.firstReceivedMs = receivedPerformanceMs;
  shoe.recent.push({time: receivedPerformanceMs, count: shoe.receivedCount});
  while (shoe.recent.length > 1 && receivedPerformanceMs - shoe.recent[0].time > 2000) shoe.recent.shift();
  refreshControls();
}

function receiveRate(shoe) {
  if (shoe.recent.length < 2) return null;
  const first = shoe.recent[0];
  const last = shoe.recent[shoe.recent.length - 1];
  const seconds = (last.time - first.time) / 1000;
  return seconds > 0 ? (last.count - first.count) / seconds : null;
}

function refreshShoe(shoe) {
  const side = shoe.side;
  const last = shoe.history[shoe.history.length - 1];
  const live = shoe.status === "streaming" && shoe.lastReceivedMs !== null && performance.now() - shoe.lastReceivedMs < 1000;
  const waitingTooLong = shoe.status === "waiting" && shoe.connectedAtMs !== null && performance.now() - shoe.connectedAtMs > 4000;
  $("shoe-" + side).classList.toggle("stale", !live);
  $("chart-shoe-" + side).classList.toggle("stale", !live);
  const streamBadge = $("stream-badge-" + side);
  streamBadge.textContent = live ? "实时" : shoe.status === "waiting" ? "等待通知" : "无新数据";
  streamBadge.className = "badge" + (live ? " live" : shoe.error || waitingTooLong ? " problem" : "");
  const error = $("error-" + side);
  const displayError = shoe.error || (waitingTooLong ? "已经订阅但尚未收到数据；当前固件要求ATT MTU至少115，请同时查看鞋端串口诊断。" : "");
  error.textContent = displayError;
  error.hidden = !displayError;
  $("chart-status-" + side).textContent = live ? "LIVE · 50 Hz" : statusText(shoe.status);
  $("ble-" + side).textContent = shoe.device && shoe.device.gatt && shoe.device.gatt.connected ? "Connected" : "Disconnected";
  $("frame-" + side).textContent = last ? String(last.frame) : "—";
  const currentRate = receiveRate(shoe);
  $("rate-" + side).textContent = currentRate === null ? "—" : `${currentRate.toFixed(1)} Hz`;
  const elapsed = shoe.firstReceivedMs === null || shoe.lastReceivedMs === null ? 0 : (shoe.lastReceivedMs - shoe.firstReceivedMs) / 1000;
  $("average-" + side).textContent = elapsed > 0 ? `${((shoe.receivedCount - 1) / elapsed).toFixed(2)} Hz` : "—";
  $("count-" + side).textContent = String(shoe.receivedCount);
  $("missing-" + side).textContent = String(shoe.missingFrames);
  const expected = Math.max(0, shoe.receivedCount - 1) + shoe.missingFrames;
  $("loss-" + side).textContent = `${(expected ? 100 * shoe.missingFrames / expected : 0).toFixed(3)}%`;
  $("age-" + side).textContent = shoe.lastReceivedMs === null ? "—" : `${((performance.now() - shoe.lastReceivedMs) / 1000).toFixed(1)} s前`;
  for (const group of groups) group.channels.forEach((_, channel) => {
    $("value-" + side + "-" + group.key + "-" + channel).textContent = last ? last[group.key][channel].toFixed(group.digits) : "—";
  });
}

function drawPlot(shoe, group) {
  const canvas = $("plot-" + shoe.side + "-" + group.key);
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const ratio = window.devicePixelRatio || 1;
  const width = bounds.width;
  const height = bounds.height;
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const left = 38, top = 8, right = width - 10, bottom = height - 22;
  const last = shoe.history[shoe.history.length - 1];
  const end = last ? Math.max(10, last.plot_s) : 10;
  const start = end - 10;
  const samples = shoe.history.filter(sample => sample.plot_s >= start && sample.plot_s <= end);
  let min = group.baseRange[0], max = group.baseRange[1];
  for (const sample of samples) for (const value of sample[group.key]) { min = Math.min(min, value); max = Math.max(max, value); }
  const padding = Math.max((max - min) * 0.05, 0.0001);
  min -= padding; max += padding;
  const x = value => left + (value - start) / 10 * (right - left);
  const y = value => bottom - (value - min) / (max - min) * (bottom - top);

  context.font = '9px -apple-system, "PingFang SC", sans-serif';
  context.fillStyle = "#8798a2";
  for (let index = 0; index <= 3; index += 1) {
    const value = min + (max - min) * index / 3;
    const py = y(value);
    context.strokeStyle = "#eef1f3";
    context.lineWidth = 1;
    context.beginPath(); context.moveTo(left, py); context.lineTo(right, py); context.stroke();
    context.textAlign = "right";
    context.fillText(Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1), left - 6, py + 3);
  }
  for (let index = 0; index <= 5; index += 1) {
    const value = start + index * 2;
    context.textAlign = "center";
    context.fillText(`${value.toFixed(1)}s`, x(value), height - 5);
  }
  if (!samples.length) {
    context.textAlign = "center";
    context.fillStyle = "#98a7af";
    context.fillText("等待传感器数据", (left + right) / 2, (top + bottom) / 2);
    return;
  }

  context.save();
  context.beginPath(); context.rect(left, top, right - left, bottom - top); context.clip();
  group.channels.forEach((_, channel) => {
    context.beginPath();
    context.strokeStyle = colors[channel];
    context.lineWidth = 1.7;
    context.lineCap = "round";
    context.lineJoin = "round";
    let previous = null;
    for (const sample of samples) {
      const px = x(sample.plot_s), py = y(sample[group.key][channel]);
      if (!previous || sample.plot_s <= previous.plot_s || sample.plot_s - previous.plot_s > 0.25) context.moveTo(px, py);
      else context.lineTo(px, py);
      previous = sample;
    }
    context.stroke();
  });
  context.restore();
}

function render() {
  shoes.forEach(shoe => {
    refreshShoe(shoe);
    groups.forEach(group => drawPlot(shoe, group));
  });
  updateRecordingUi();
}

class CsvRecorder {
  constructor() {
    this.active = false;
    this.rows = 0;
    this.session = "";
    this.error = "";
    this.pending = [];
    this.chunkIndex = 0;
    this.writeChain = Promise.resolve();
    this.dbPromise = null;
    this.downloadUrl = "";
    this.file = null;
    this.startedAtMs = null;
    this.elapsedMs = 0;
  }

  openDatabase() {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("gait-web-ble", 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("chunks", {keyPath: "key"});
        store.createIndex("session", "session", {unique: false});
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开浏览器数据存储"));
    });
    return this.dbPromise;
  }

  async clearChunks() {
    const database = await this.openDatabase();
    await new Promise((resolve, reject) => {
      const request = database.transaction("chunks", "readwrite").objectStore("chunks").clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error("无法清理旧记录"));
    });
  }

  async start() {
    await this.clearChunks();
    if (this.downloadUrl) URL.revokeObjectURL(this.downloadUrl);
    this.downloadUrl = "";
    this.file = null;
    this.startedAtMs = performance.now();
    this.elapsedMs = 0;
    this.active = true;
    this.rows = 0;
    this.error = "";
    this.pending = [];
    this.chunkIndex = 0;
    this.writeChain = Promise.resolve();
    const now = new Date();
    this.session = "gait_" + now.toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
    $("record-save").hidden = true;
  }

  record(sample) {
    if (!this.active) return;
    const row = [
      this.session, sample.side === 0 ? "L" : "R", sample.frame, sample.received_time_iso,
      sample.received_unix_ns, sample.received_monotonic_ns, sample.received_s, sample.plot_s,
      sample.adc_us, sample.imu_us,
      ...sample.voltage, ...sample.acceleration, ...sample.angular_rate,
    ].join(",") + "\n";
    this.pending.push(row);
    this.rows += 1;
    if (this.pending.length >= 200) this.flush();
  }

  flush() {
    if (!this.pending.length) return;
    const text = this.pending.join("");
    this.pending = [];
    const index = this.chunkIndex++;
    this.writeChain = this.writeChain.then(async () => {
      const database = await this.openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("chunks", "readwrite");
        const request = transaction.objectStore("chunks").put({
          key: `${this.session}:${String(index).padStart(8, "0")}`,
          session: this.session,
          index,
          text,
        });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error || new Error("写入记录失败"));
      });
    }).catch(error => {
      this.active = false;
      this.error = error.message || "记录失败";
    });
  }

  async stop() {
    if (!this.active) return;
    this.active = false;
    this.elapsedMs = this.startedAtMs === null ? 0 : performance.now() - this.startedAtMs;
    this.flush();
    await this.writeChain;
    if (this.error) throw new Error(this.error);
    const database = await this.openDatabase();
    const chunks = await new Promise((resolve, reject) => {
      const index = database.transaction("chunks", "readonly").objectStore("chunks").index("session");
      const request = index.getAll(IDBKeyRange.only(this.session));
      request.onsuccess = () => resolve(request.result.sort((a, b) => a.index - b.index));
      request.onerror = () => reject(request.error || new Error("读取记录失败"));
    });
    const header = "session,shoe,frame,received_time_iso,received_unix_ns,received_monotonic_ns,received_s,plot_s,adc_us,imu_us,voltage_0,voltage_1,voltage_2,voltage_3,accel_x,accel_y,accel_z,gyro_x,gyro_y,gyro_z\n";
    const parts = ["\ufeff", header, ...chunks.map(chunk => chunk.text)];
    const fileName = this.session + ".csv";
    const blob = new Blob(parts, {type: "text/csv;charset=utf-8"});
    this.file = typeof File === "function"
      ? new File(parts, fileName, {type: "text/csv", lastModified: Date.now()})
      : blob;
    if (this.downloadUrl) URL.revokeObjectURL(this.downloadUrl);
    this.downloadUrl = URL.createObjectURL(blob);
    $("record-save").hidden = false;
  }

  saveOrShare() {
    if (!this.file) throw new Error("尚未生成CSV文件");
    const fileName = this.session + ".csv";
    if (typeof File === "function" && this.file instanceof File &&
        typeof navigator.share === "function" &&
        typeof navigator.canShare === "function" &&
        navigator.canShare({files: [this.file]})) {
      navigator.share({title: "GAIT步态数据", files: [this.file]}).then(() => {
        notice("系统分享操作已经完成。若选择了“存储到文件”，请到文件App中确认CSV。 ");
      }).catch(error => {
        if (error && error.name === "AbortError") notice("已经取消保存或分享。CSV仍保留在当前页面中。 ");
        else notice(`无法打开系统分享面板：${error.message || error}`, true);
      });
      return "share";
    }

    const link = document.createElement("a");
    link.href = this.downloadUrl;
    link.download = fileName;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    return "download";
  }
}

const recorder = new CsvRecorder();

function updateRecordingUi() {
  const dot = $("record-dot");
  dot.className = "record-dot" + (recorder.error ? " problem" : recorder.active ? " on" : recorder.downloadUrl ? " ready" : "");
  if (recorder.error) {
    $("record-title").textContent = "记录失败";
    $("record-detail").textContent = recorder.error;
  } else if (recorder.active) {
    $("record-title").textContent = `正在记录 · ${recorder.rows} 行`;
    $("record-detail").textContent = "数据正分块写入iPhone浏览器存储";
  } else if (recorder.file) {
    $("record-title").textContent = `CSV已生成 · ${recorder.rows} 行`;
    $("record-detail").textContent = "点击“保存/分享CSV”，再选择“存储到文件”";
  } else {
    $("record-title").textContent = "尚未开始记录";
    $("record-detail").textContent = "连接鞋子后可记录并导出一个双鞋CSV文件";
  }
  const elapsedMs = recorder.active && recorder.startedAtMs !== null
    ? performance.now() - recorder.startedAtMs : recorder.elapsedMs;
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  $("recording-time").textContent = `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
  refreshControls();
}

for (let side = 0; side < 2; side += 1) {
  $("connect-" + side).addEventListener("click", () => chooseAndConnect(side));
  $("disconnect-" + side).addEventListener("click", () => disconnectShoe(side));
}

$("record-start").addEventListener("click", async () => {
  try {
    await recorder.start();
    notice("已经开始记录；随后收到的左右鞋样本会写入同一个CSV。请保持页面位于前台。 ");
  } catch (error) {
    recorder.error = error.message || "无法开始记录";
    notice(recorder.error, true);
  }
  updateRecordingUi();
});

$("record-stop").addEventListener("click", async () => {
  try {
    await recorder.stop();
    notice(`记录完成，共 ${recorder.rows} 行。请点击“保存/分享CSV”。`);
  } catch (error) {
    recorder.error = error.message || "无法生成CSV";
    notice(recorder.error, true);
  }
  updateRecordingUi();
});

$("record-save").addEventListener("click", () => {
  try {
    const method = recorder.saveOrShare();
    if (method === "share") notice("系统分享面板正在打开，请选择“存储到文件”。");
    else notice("浏览器已启动兼容下载；请检查Bluefy下载记录或iPhone文件。 ");
  } catch (error) {
    notice(error.message || "无法保存CSV", true);
  }
});

if (navigator.bluetooth) {
  $("browser-state").textContent = "Web Bluetooth 可用";
} else {
  $("browser-state").textContent = "当前浏览器不支持蓝牙";
  $("browser-state").classList.add("problem");
  notice("当前浏览器不支持Web Bluetooth。请使用Bluefy并通过HTTPS打开本页面。", true);
}

window.addEventListener("resize", render);
window.addEventListener("pagehide", () => {
  if (recorder.active) recorder.flush();
});
setInterval(render, 100);
refreshControls();
render();
