import assert from "node:assert/strict";
import test from "node:test";

import {
  adcUnitForGpio,
  formatBucketRange,
  formatMicros,
  isFaultReset,
  rssiQuality,
  scanHealthView,
  scanRateLow,
} from "../src/lib/scanHealth.ts";

// What a v1.5.F answered on the bench (5x7 layout, ADC2 rows GPIO13/14).
const V15F_SCAN_HEALTH = {
  scan_active: true,
  requested_target_fps: 60,
  point_count: 35,
  produced_frames: 63825,
  actual_scan_fps: 60,
  last_scan_duration_us: 2210,
  max_scan_duration_us: 4630,
  budget_us: 16666,
  overrun_frames: 0,
  udp_sent_frames: 63800,
  udp_send_failures: 2,
  last_udp_send_us: 410,
  queue_enabled: true,
  queue_capacity_frames: 4,
  queue_occupied_frames: 0,
  queue_dropped_frames: 0,
  queue_max_occupied_frames: 2,
  start_lateness: { samples: 1000, late: 12, gaps: 1, max_us: 5300, recent_max_us: 800, hist: [988, 9, 2, 1], bounds_us: [500, 2000, 5000] },
  adc_read_errors: [0, 3],
  adc_cal_digi: [998, 985],
};

test("ADC units follow the ESP32-S3 split: GPIO1-10 ADC1, 11-20 ADC2", () => {
  assert.equal(adcUnitForGpio(10), 1);
  assert.equal(adcUnitForGpio(11), 2);
  assert.equal(adcUnitForGpio(14), 2);
});

test("ADC calibration points and errors are split per unit with the layout's rows", () => {
  const view = scanHealthView(V15F_SCAN_HEALTH, [3, 4, 10, 13, 14]);
  assert.deepEqual(view.adc, [
    { unit: 1, calDigi: 998, readErrors: 0, gpios: [3, 4, 10] },
    { unit: 2, calDigi: 985, readErrors: 3, gpios: [13, 14] },
  ]);
});

test("firmware without ADC reporting reads as not reported, not as zero errors", () => {
  const { adc_read_errors: _errors, adc_cal_digi: _digi, ...older } = V15F_SCAN_HEALTH;
  assert.equal(scanHealthView(older, [3]).adc, null);
  assert.equal(scanHealthView({}).actualFps, null);
});

test("start-lateness buckets carry their bounds and shares", () => {
  const { lateness } = scanHealthView(V15F_SCAN_HEALTH);
  assert.equal(lateness.lateShare, 0.012);
  assert.deepEqual(
    lateness.buckets.map((bucket) => formatBucketRange(bucket)),
    ["< 500 µs", "500 µs – 2.0 ms", "2.0 ms – 5.0 ms", "≥ 5.0 ms"],
  );
  assert.equal(lateness.buckets[0].share, 0.988);
});

test("timings switch from µs to ms at 1000", () => {
  assert.equal(formatMicros(850), "850 µs");
  assert.equal(formatMicros(16666), "16.7 ms");
  assert.equal(formatMicros(null), "-");
});

test("RSSI quality; 0 dBm is a disconnected radio, not a perfect one", () => {
  assert.equal(rssiQuality(-50), "excellent");
  assert.equal(rssiQuality(-70), "fair");
  assert.equal(rssiQuality(-82), "weak");
  assert.equal(rssiQuality(0), null);
  assert.equal(rssiQuality(undefined), null);
});

test("a scan more than 5% under target is flagged only while scanning", () => {
  assert.equal(scanRateLow(scanHealthView({ ...V15F_SCAN_HEALTH, actual_scan_fps: 55 })), true);
  assert.equal(scanRateLow(scanHealthView({ ...V15F_SCAN_HEALTH, actual_scan_fps: 58 })), false);
  assert.equal(scanRateLow(scanHealthView({ ...V15F_SCAN_HEALTH, actual_scan_fps: 0, scan_active: false })), false);
});

test("fault resets are told apart from ordinary ones", () => {
  assert.equal(isFaultReset("panic"), true);
  assert.equal(isFaultReset("brownout"), true);
  assert.equal(isFaultReset("poweron"), false);
  assert.equal(isFaultReset("software"), false);
});
