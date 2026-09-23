(function (root) {
  "use strict";

  const SERVICE_UUID = "c4a00001-8e22-4c04-a001-528400000001";
  const DATA_UUID = "c4a00002-8e22-4c04-a001-528400000001";
  const PROTOCOL_VERSION = 3;
  const SAMPLE_SIZE = 56;
  const NOTIFICATION_SIZE = 112;
  const SAMPLE_RATE_HZ = 50;

  function asDataView(value) {
    if (value instanceof DataView) return value;
    if (value instanceof ArrayBuffer) return new DataView(value);
    if (ArrayBuffer.isView(value)) {
      return new DataView(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new TypeError("通知数据类型无效");
  }

  function decodeSample(view, offset, expectedSide) {
    const version = view.getUint8(offset);
    const side = view.getUint8(offset + 1);
    const rate = view.getUint16(offset + 2, true);
    if (version !== PROTOCOL_VERSION) {
      throw new Error(`协议版本为 ${version}，网页需要版本 ${PROTOCOL_VERSION}`);
    }
    if (side !== expectedSide) throw new Error("数据包中的左右鞋标识与所选设备不一致");
    if (rate !== SAMPLE_RATE_HZ) throw new Error(`采样率字段为 ${rate} Hz，应为 ${SAMPLE_RATE_HZ} Hz`);

    const values = [];
    for (let index = 0; index < 10; index += 1) {
      const value = view.getFloat32(offset + 16 + index * 4, true);
      if (!Number.isFinite(value)) throw new Error("数据包包含无效浮点数");
      values.push(value);
    }
    return {
      version,
      side,
      rate,
      frame: view.getUint32(offset + 4, true),
      adc_us: view.getUint32(offset + 8, true),
      imu_us: view.getUint32(offset + 12, true),
      voltage: values.slice(0, 4),
      acceleration: values.slice(4, 7),
      angular_rate: values.slice(7, 10),
    };
  }

  function decodeNotification(value, expectedSide) {
    const view = asDataView(value);
    if (view.byteLength !== NOTIFICATION_SIZE) {
      throw new Error(`通知长度为 ${view.byteLength} 字节，应为 ${NOTIFICATION_SIZE} 字节`);
    }
    return [
      decodeSample(view, 0, expectedSide),
      decodeSample(view, SAMPLE_SIZE, expectedSide),
    ];
  }

  function signedDelta(current, previous) {
    const unsigned = (current - previous) >>> 0;
    return unsigned <= 0x7fffffff ? unsigned : unsigned - 0x100000000;
  }

  root.GaitProtocol = {
    SERVICE_UUID,
    DATA_UUID,
    PROTOCOL_VERSION,
    SAMPLE_SIZE,
    NOTIFICATION_SIZE,
    SAMPLE_RATE_HZ,
    decodeNotification,
    signedDelta,
  };
})(typeof window !== "undefined" ? window : globalThis);
