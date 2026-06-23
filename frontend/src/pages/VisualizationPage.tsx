import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { api, type DeviceEntry, type ProfileListEntry, type VisualizationEntry } from "../lib/api";
import { normalizeDevice } from "../lib/device";
import { fitProfileRect, profilePointToScreen, profilePointToWorld, type FittedProfileRect } from "../lib/profileLayout";
import { useI18n } from "../i18n";
import { useWsState } from "../lib/wsClient";

const COP_OFFSET = 250;
const VIEW_STORAGE_KEY = "newhorizons.visualization.views.v1";
const DEFAULT_RANGE = { min: 300, max: 1000 };
const SURFACE_INTERPOLATION_STEPS = 3;
const VISUAL_SURFACE_MAX_INTERPOLATED_POINTS = 1800;
const kVisualizationStaleMs = 1500;

type VisualizationRendererMode = "3d" | "2d";

type VisualizationView = {
  id: string;
  deviceUid: string;
  rendererMode: VisualizationRendererMode;
  profileName: string | null;
  selected: boolean;
  rowMirror: boolean;
  colMirror: boolean;
  dotSize: number;
};

type ProfileSensor = {
  index?: unknown;
  x?: unknown;
  y?: unknown;
  label?: unknown;
  enabled?: unknown;
};

type ProfileData = {
  name?: string;
  matrix?: {
    rows?: unknown;
    cols?: unknown;
  };
  activeRows?: unknown[];
  activeCols?: unknown[];
  sensors?: ProfileSensor[];
  background?: {
    imageData?: string;
    aspectRatio?: number;
  };
  display?: {
    mode?: unknown;
    pressureMin?: unknown;
    pressureMax?: unknown;
  };
};

type DisplayPoint = {
  index: number;
  value: number;
  xRatio: number;
  yRatio: number;
  label: string;
};

type MatrixView = {
  rows: number;
  cols: number;
  values: number[][];
  rawValues: number[][] | null;
  points: DisplayPoint[];
  usesProfileSensors: boolean;
};

type CalibrationSummary = {
  level: number;
  complete: boolean;
  source: string;
  captured_points: number;
  total_points: number;
};

type CalibrationStateSummary = {
  enabled: boolean;
  complete: boolean;
  tare_complete: boolean;
  levels_complete: boolean;
  legacy_missing_tare: boolean;
  max_level: number;
  levels: CalibrationSummary[];
};

const EMPTY_CALIBRATION_STATE: CalibrationStateSummary = {
  enabled: false,
  complete: false,
  tare_complete: false,
  levels_complete: false,
  legacy_missing_tare: false,
  max_level: 0,
  levels: [],
};

function normalizeUid(value: string | undefined | null) {
  return String(value ?? "").replace(/[^a-fA-F0-9]/g, "").toUpperCase();
}

function createViewId(deviceUid: string) {
  return `view-${normalizeUid(deviceUid)}-${Date.now().toString(16)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function asFiniteNumber(value: unknown, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function recordValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function safeDisplayName(device: DeviceEntry | undefined, fallbackUid: string) {
  return device?.display_name || device?.nickname || device?.device_name || fallbackUid;
}

function visualizationBadgeState(device: DeviceEntry | undefined, item: VisualizationEntry | undefined, nowMs: number) {
  const normalized = device ? normalizeDevice(device) : null;
  if (normalized?.isOffline) return "offline";
  if (item) {
    const receivedAt = Number(item.received_at_ms ?? 0);
    return receivedAt > 0 && nowMs - receivedAt > 500 ? "waiting" : "live";
  }
  if (normalized) return "waiting";
  return "offline";
}

function inferMatrixShape(values: number[], rowsHint?: number, colsHint?: number) {
  const rows = Number(rowsHint);
  const cols = Number(colsHint);
  if (Number.isFinite(rows) && Number.isFinite(cols) && rows > 0 && cols > 0) {
    return { rows: Math.floor(rows), cols: Math.floor(cols) };
  }
  const side = Math.max(1, Math.ceil(Math.sqrt(values.length)));
  return { rows: Math.ceil(values.length / side), cols: side };
}

function sameNumberMap(left: Record<string, number>, right: Record<string, number>) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index += 1) {
    if (leftKeys[index] !== rightKeys[index]) return false;
    if (left[leftKeys[index]] !== right[rightKeys[index]]) return false;
  }
  return true;
}

function profileMatrixShape(profile: ProfileData | null | undefined) {
  const rows = asFiniteNumber(profile?.matrix?.rows, 0);
  const cols = asFiniteNumber(profile?.matrix?.cols, 0);
  if (rows > 0 && cols > 0) {
    return { rows: Math.floor(rows), cols: Math.floor(cols) };
  }
  return null;
}

function valueRatio(value: number, range: { min: number; max: number }) {
  const span = Math.max(range.max - range.min, 1);
  return clamp((value - range.min) / span, 0, 1);
}

function rangeForProfile(profile: ProfileData | null | undefined, fallback: { min: number; max: number }) {
  const min = asFiniteNumber(profile?.display?.pressureMin, fallback.min);
  const max = asFiniteNumber(profile?.display?.pressureMax, fallback.max);
  return { min, max: Math.max(max, min + 1) };
}

function calibrationSource(value: unknown) {
  const direct = recordValue(value);
  const nested = recordValue(direct.calibration);
  if (Object.keys(nested).length > 0) {
    return nested;
  }
  const hasTopLevelKeys = ["enabled", "complete", "levels", "draft_levels"].some((key) => key in direct);
  return hasTopLevelKeys ? direct : {};
}

function parseCalibrationSummaryList(value: unknown): CalibrationSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => recordValue(item))
    .filter((item) => Object.keys(item).length > 0)
    .map((item) => ({
      level: asFiniteNumber(item.level, 0),
      complete: item.complete === true,
      source: stringValue(item.source, "saved"),
      captured_points: Math.floor(asFiniteNumber(item.captured_points, 0)),
      total_points: Math.floor(asFiniteNumber(item.total_points, 0)),
    }));
}

function parseCalibrationState(value: unknown): CalibrationStateSummary {
  const source = calibrationSource(value);
  const metadata = recordValue(source.metadata);
  const levels = parseCalibrationSummaryList(source.levels);
  const maxLevelFromLevels = levels.reduce((current, item) => Math.max(current, item.level), 0);
  return {
    enabled: source.enabled === true,
    complete: source.complete === true,
    tare_complete: source.tare_complete === true,
    levels_complete: source.levels_complete === true,
    legacy_missing_tare: source.legacy_missing_tare === true,
    max_level: Math.max(asFiniteNumber(metadata.max_level, 0), maxLevelFromLevels),
    levels,
  };
}

function calibrationStateForDevice(device: DeviceEntry | undefined) {
  if (!device) return EMPTY_CALIBRATION_STATE;
  const status = recordValue(device.last_status);
  const fromStatus = parseCalibrationState(status.calibration);
  if (fromStatus.complete || fromStatus.enabled || fromStatus.levels.length > 0) {
    return fromStatus;
  }
  const lastResult = recordValue(device.last_result);
  if (stringValue(lastResult.command, "") === "calibration_status") {
    return parseCalibrationState(lastResult);
  }
  return EMPTY_CALIBRATION_STATE;
}

function calibrationLevelsForDevice(device: DeviceEntry | undefined) {
  return calibrationStateForDevice(device).levels
    .filter((item) => item.complete && item.source === "saved")
    .map((item) => item.level)
    .sort((left, right) => left - right);
}

function calibrationDisplayRange(calibrationState: CalibrationStateSummary, fallback: { min: number; max: number }) {
  const maxLevel = Math.max(1, calibrationState.max_level);
  if (!Number.isFinite(maxLevel) || maxLevel <= 0) {
    return fallback;
  }
  return { min: 0, max: Math.max(maxLevel, 1) };
}

function cssColorForValue(value: number, range: { min: number; max: number }) {
  const ratio = valueRatio(value, range);
  const hue = 154 - ratio * 108;
  const lightness = 78 - ratio * 30;
  return `hsl(${hue}deg 58% ${lightness}%)`;
}

function threeColorForValue(value: number, range: { min: number; max: number }) {
  const ratio = valueRatio(value, range);
  const color = new THREE.Color();
  color.setHSL(0.42 - ratio * 0.32, 0.74, 0.62 - ratio * 0.16);
  return color;
}

function reusableFloat32AttributeArray(geometry: THREE.BufferGeometry, name: string, length: number) {
  const existing = geometry.getAttribute(name) as THREE.BufferAttribute | undefined;
  if (existing && existing.array instanceof Float32Array && existing.array.length === length) {
    return existing.array;
  }
  return new Float32Array(length);
}

function reusableIndexArray(geometry: THREE.BufferGeometry, length: number) {
  const existing = geometry.index;
  if (existing && existing.array instanceof Uint16Array && existing.array.length === length) {
    return existing.array;
  }
  return new Uint16Array(length);
}

function buildPointGeometry(
  matrix: MatrixView,
  range: { min: number; max: number },
  width: number,
  depth: number,
  scale: number,
  geometry?: THREE.BufferGeometry,
  profilePlane?: { planeWidth: number; planeHeight: number } | null,
) {
  const positions = geometry ? reusableFloat32AttributeArray(geometry, "position", matrix.points.length * 3) : new Float32Array(matrix.points.length * 3);
  const colors = geometry ? reusableFloat32AttributeArray(geometry, "color", matrix.points.length * 3) : new Float32Array(matrix.points.length * 3);
  matrix.points.forEach((point, index) => {
    const pressureRatio = valueRatio(point.value, range);
    if (matrix.usesProfileSensors && profilePlane) {
      const { worldX, worldZ } = profilePointToWorld(point.xRatio, point.yRatio, profilePlane.planeWidth, profilePlane.planeHeight);
      positions[index * 3] = worldX;
      positions[index * 3 + 2] = worldZ;
    } else {
      positions[index * 3] = (point.xRatio - 0.5) * width;
      positions[index * 3 + 2] = (point.yRatio - 0.5) * depth;
    }
    positions[index * 3 + 1] = pressureRatio * scale * 0.38;
    const color = threeColorForValue(point.value, range);
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  });
  return { positions, colors };
}

function setGeometryAttribute(geometry: THREE.BufferGeometry, name: string, array: Float32Array, itemSize: number) {
  const existing = geometry.getAttribute(name) as THREE.BufferAttribute | undefined;
  if (existing && existing.array === array) {
    existing.needsUpdate = true;
    return;
  }
  if (existing && existing.array.length === array.length) {
    (existing.array as Float32Array).set(array);
    existing.needsUpdate = true;
    return;
  }
  geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
}

function setGeometryIndex(geometry: THREE.BufferGeometry, indices: Uint16Array) {
  const existing = geometry.index;
  if (existing && existing.array === indices) {
    existing.needsUpdate = true;
    return;
  }
  if (existing && existing.array.length === indices.length) {
    (existing.array as Uint16Array).set(indices);
    existing.needsUpdate = true;
    return;
  }
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
}

function lerp(a: number, b: number, amount: number) {
  return a + (b - a) * amount;
}

function interpolatedMatrixValue(values: number[][], sourceRow: number, sourceCol: number) {
  const maxRow = Math.max(values.length - 1, 0);
  const maxCol = Math.max((values[0]?.length ?? 1) - 1, 0);
  const row0 = clamp(Math.floor(sourceRow), 0, maxRow);
  const col0 = clamp(Math.floor(sourceCol), 0, maxCol);
  const row1 = Math.min(row0 + 1, maxRow);
  const col1 = Math.min(col0 + 1, maxCol);
  const rowRatio = clamp(sourceRow - row0, 0, 1);
  const colRatio = clamp(sourceCol - col0, 0, 1);
  const top = lerp(asFiniteNumber(values[row0]?.[col0], 0), asFiniteNumber(values[row0]?.[col1], 0), colRatio);
  const bottom = lerp(asFiniteNumber(values[row1]?.[col0], 0), asFiniteNumber(values[row1]?.[col1], 0), colRatio);
  return lerp(top, bottom, rowRatio);
}

function surfaceInterpolationSteps(matrix: MatrixView) {
  for (let steps = SURFACE_INTERPOLATION_STEPS; steps > 1; steps -= 1) {
    const surfaceRows = (matrix.rows - 1) * steps + 1;
    const surfaceCols = (matrix.cols - 1) * steps + 1;
    if (surfaceRows * surfaceCols <= VISUAL_SURFACE_MAX_INTERPOLATED_POINTS) {
      return steps;
    }
  }
  return 1;
}

function buildSurfaceGeometry(matrix: MatrixView, range: { min: number; max: number }, width: number, depth: number, scale: number, geometry?: THREE.BufferGeometry) {
  if (matrix.usesProfileSensors || matrix.rows < 2 || matrix.cols < 2 || matrix.values.length === 0) return null;
  const steps = surfaceInterpolationSteps(matrix);
  const surfaceRows = (matrix.rows - 1) * steps + 1;
  const surfaceCols = (matrix.cols - 1) * steps + 1;
  const positions = geometry ? reusableFloat32AttributeArray(geometry, "position", surfaceRows * surfaceCols * 3) : new Float32Array(surfaceRows * surfaceCols * 3);
  const colors = geometry ? reusableFloat32AttributeArray(geometry, "color", surfaceRows * surfaceCols * 3) : new Float32Array(surfaceRows * surfaceCols * 3);

  for (let row = 0; row < surfaceRows; row += 1) {
    const sourceRow = row / steps;
    const yRatio = surfaceRows <= 1 ? 0.5 : row / (surfaceRows - 1);
    for (let col = 0; col < surfaceCols; col += 1) {
      const sourceCol = col / steps;
      const xRatio = surfaceCols <= 1 ? 0.5 : col / (surfaceCols - 1);
      const value = interpolatedMatrixValue(matrix.values, sourceRow, sourceCol);
      const pressureRatio = valueRatio(value, range);
      const index = row * surfaceCols + col;
      positions[index * 3] = (xRatio - 0.5) * width;
      positions[index * 3 + 1] = pressureRatio * scale * 0.38;
      positions[index * 3 + 2] = (yRatio - 0.5) * depth;
      const color = threeColorForValue(value, range);
      colors[index * 3] = color.r;
      colors[index * 3 + 1] = color.g;
      colors[index * 3 + 2] = color.b;
    }
  }

  const indices = geometry ? reusableIndexArray(geometry, (surfaceRows - 1) * (surfaceCols - 1) * 6) : new Uint16Array((surfaceRows - 1) * (surfaceCols - 1) * 6);
  let cursor = 0;
  for (let row = 0; row < surfaceRows - 1; row += 1) {
    for (let col = 0; col < surfaceCols - 1; col += 1) {
      const topLeft = row * surfaceCols + col;
      const topRight = topLeft + 1;
      const bottomLeft = (row + 1) * surfaceCols + col;
      const bottomRight = bottomLeft + 1;
      indices[cursor] = topLeft;
      indices[cursor + 1] = bottomLeft;
      indices[cursor + 2] = topRight;
      indices[cursor + 3] = topRight;
      indices[cursor + 4] = bottomLeft;
      indices[cursor + 5] = bottomRight;
      cursor += 6;
    }
  }

  return { positions, colors, indices };
}

function resetSurfaceCamera(current: {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
}, scale: number) {
  current.camera.position.set(scale * 0.8, scale * 0.75, scale * 1.15);
  current.camera.lookAt(0, 0, 0);
  current.controls.target.set(0, 0, 0);
  current.controls.minDistance = Math.max(scale * 0.25, 0.8);
  current.controls.maxDistance = Math.max(scale * 5, 8);
  current.controls.update();
}

function formatVector(values: number[] | null | undefined) {
  return (values ?? [0, 0, 0])
    .slice(0, 3)
    .map((value) => Number(value).toFixed(2))
    .join(", ");
}

function buildMatrixView(
  item: VisualizationEntry | undefined,
  device: DeviceEntry | undefined,
  profile: ProfileData | null | undefined,
  rowMirror: boolean,
  colMirror: boolean,
): MatrixView {
  const source = item?.p ?? [];
  const deviceRows = asFiniteNumber(device?.matrix_shape?.rows, 0);
  const deviceCols = asFiniteNumber(device?.matrix_shape?.cols, 0);
  let shape: { rows: number; cols: number } | null = null;
  if (deviceRows > 0 && deviceCols > 0) {
    shape = { rows: Math.floor(deviceRows), cols: Math.floor(deviceCols) };
  }
  if (!shape) {
    shape = profileMatrixShape(profile);
  }
  if (!shape) {
    shape = inferMatrixShape(source, deviceRows, deviceCols);
  }
  const rows = Math.max(1, shape.rows);
  const cols = Math.max(1, shape.cols);
  const sensors = Array.isArray(profile?.sensors) ? profile.sensors : [];
  const enabledSensors = sensors
    .filter((sensor) => sensor && sensor.enabled !== false)
    .map((sensor) => {
      const index = Math.floor(asFiniteNumber(sensor.index, -1));
      if (index < 0 || index >= source.length) return null;
      const x = clamp(asFiniteNumber(sensor.x, (index % cols) / Math.max(cols - 1, 1)), 0, 1);
      const y = clamp(asFiniteNumber(sensor.y, Math.floor(index / cols) / Math.max(rows - 1, 1)), 0, 1);
      return {
        index,
        value: asFiniteNumber(source[index], 0),
        xRatio: colMirror ? 1 - x : x,
        yRatio: rowMirror ? 1 - y : y,
        label: String(sensor.label ?? `P${index}`),
      };
    })
    .filter((sensor): sensor is DisplayPoint => Boolean(sensor));

  if (enabledSensors.length > 0) {
    return {
      rows,
      cols,
      values: [],
      rawValues: null,
      points: enabledSensors,
      usesProfileSensors: true,
    };
  }

  const values = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: cols }, (_, col) => {
      const sourceRow = rowMirror ? rows - 1 - row : row;
      const sourceCol = colMirror ? cols - 1 - col : col;
      const sourceIndex = sourceRow * cols + sourceCol;
      return asFiniteNumber(source[sourceIndex], 0);
    }),
  );

  const rawSource = item?.raw_adc;
  const rawValues = Array.isArray(rawSource) && rawSource.length === source.length
    ? Array.from({ length: rows }, (_, row) =>
        Array.from({ length: cols }, (_, col) => {
          const sourceRow = rowMirror ? rows - 1 - row : row;
          const sourceCol = colMirror ? cols - 1 - col : col;
          const sourceIndex = sourceRow * cols + sourceCol;
          return asFiniteNumber(rawSource[sourceIndex], 0);
        }),
      )
    : null;

  const points = values.flatMap((row, rowIndex) =>
    row.map((value, colIndex) => ({
      index: rowIndex * cols + colIndex,
      value,
      xRatio: cols <= 1 ? 0.5 : colIndex / (cols - 1),
      yRatio: rows <= 1 ? 0.5 : rowIndex / (rows - 1),
      label: `P${rowIndex * cols + colIndex}`,
    })),
  );

  return { rows, cols, values, rawValues, points, usesProfileSensors: false };
}

function computeCop(points: DisplayPoint[], rows: number, cols: number) {
  let weightedX = 0;
  let weightedY = 0;
  let total = 0;
  points.forEach((point) => {
    const adjusted = point.value - COP_OFFSET;
    if (!Number.isFinite(adjusted) || adjusted <= 0) return;
    weightedX += point.xRatio * adjusted;
    weightedY += point.yRatio * adjusted;
    total += adjusted;
  });
  if (total <= 0) {
    return { x: 0, y: 0, xRatio: 0.5, yRatio: 0.5, hasData: false };
  }
  const xRatio = weightedX / total;
  const yRatio = weightedY / total;
  return {
    x: xRatio * Math.max(cols - 1, 1),
    y: yRatio * Math.max(rows - 1, 1),
    xRatio: clamp(xRatio, 0, 1),
    yRatio: clamp(yRatio, 0, 1),
    hasData: true,
  };
}

function profilePlaneDimensions(matrix: MatrixView, profile: ProfileData | null | undefined) {
  const gridWidth = Math.max(matrix.cols - 1, 1);
  const gridHeight = Math.max(matrix.rows - 1, 1);
  if (!matrix.usesProfileSensors) {
    return { planeWidth: gridWidth, planeHeight: gridHeight };
  }
  const safeAspectRatio = Math.max(0.01, asFiniteNumber(profile?.background?.aspectRatio, gridWidth / Math.max(gridHeight, 1)));
  const planeHeight = Math.max(gridHeight, 1);
  return { planeWidth: planeHeight * safeAspectRatio, planeHeight };
}

function loadStoredViews(): VisualizationView[] {
  try {
    const raw = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item): VisualizationView | null => {
        const deviceUid = normalizeUid(item?.deviceUid);
        if (!deviceUid) return null;
        return {
          id: String(item.id || createViewId(deviceUid)),
          deviceUid,
          rendererMode: item.rendererMode === "2d" ? "2d" : "3d",
          profileName: item.profileName ? String(item.profileName) : null,
          selected: Boolean(item.selected),
          rowMirror: Boolean(item.rowMirror),
          colMirror: Boolean(item.colMirror),
          dotSize: clamp(asFiniteNumber(item.dotSize, 1), 0.5, 4),
        };
      })
      .filter((item): item is VisualizationView => Boolean(item));
  } catch {
    return [];
  }
}

function PressureHeatmap2D({
  matrix,
  range,
  profile,
  dotSize,
}: {
  matrix: MatrixView;
  range: { min: number; max: number };
  profile: ProfileData | null | undefined;
  dotSize: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const profileMapRef = useRef<HTMLDivElement | null>(null);
  const matrixRef = useRef(matrix);
  const rangeRef = useRef(range);
  const drawRef = useRef<() => void>(() => {});
  const [profileMapBounds, setProfileMapBounds] = useState({ width: 0, height: 0 });

  useEffect(() => {
    matrixRef.current = matrix;
    rangeRef.current = range;
    drawRef.current();
  }, [matrix, range]);

  useEffect(() => {
    if (!matrix.usesProfileSensors) return undefined;
    const container = profileMapRef.current;
    if (!container) return undefined;

    const updateBounds = () => {
      setProfileMapBounds({
        width: Math.max(container.clientWidth, 0),
        height: Math.max(container.clientHeight, 0),
      });
    };

    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateBounds) : null;
    resizeObserver?.observe(container);
    updateBounds();
    return () => resizeObserver?.disconnect();
  }, [matrix.usesProfileSensors]);

  useEffect(() => {
    if (matrix.usesProfileSensors) return undefined;
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return undefined;

    const draw = () => {
      const currentMatrix = matrixRef.current;
      const currentRange = rangeRef.current;
      const cssWidth = Math.max(parent.clientWidth, 1);
      const cssHeight = Math.max(220, Math.min(520, cssWidth * (currentMatrix.rows / Math.max(currentMatrix.cols, 1))));
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
      canvas.width = Math.max(1, Math.floor(cssWidth * ratio));
      canvas.height = Math.max(1, Math.floor(cssHeight * ratio));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, cssWidth, cssHeight);
      context.fillStyle = "#101317";
      context.fillRect(0, 0, cssWidth, cssHeight);
      const gap = 2;
      const cellWidth = Math.max(1, (cssWidth - gap * (currentMatrix.cols + 1)) / Math.max(currentMatrix.cols, 1));
      const cellHeight = Math.max(1, (cssHeight - gap * (currentMatrix.rows + 1)) / Math.max(currentMatrix.rows, 1));
      const showText = cellWidth >= 34 && cellHeight >= 22;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.font = `${Math.max(9, Math.min(12, cellWidth * 0.28))}px system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
      const rawGrid = currentMatrix.rawValues;
      const showRaw = showText && rawGrid !== null && cellHeight >= 30;
      for (let row = 0; row < currentMatrix.rows; row += 1) {
        for (let col = 0; col < currentMatrix.cols; col += 1) {
          const value = asFiniteNumber(currentMatrix.values[row]?.[col], 0);
          const x = gap + col * (cellWidth + gap);
          const y = gap + row * (cellHeight + gap);
          context.fillStyle = cssColorForValue(value, currentRange);
          context.beginPath();
          context.roundRect(x, y, cellWidth, cellHeight, Math.min(6, cellWidth * 0.18, cellHeight * 0.18));
          context.fill();
          if (showText) {
            context.fillStyle = "#101317";
            if (showRaw) {
              const rawValue = asFiniteNumber(rawGrid[row]?.[col], 0);
              context.fillText(value.toFixed(1), x + cellWidth / 2, y + cellHeight / 2 - cellHeight * 0.16);
              context.fillText(`raw ${rawValue.toFixed(0)}`, x + cellWidth / 2, y + cellHeight / 2 + cellHeight * 0.2);
            } else {
              context.fillText(value.toFixed(1), x + cellWidth / 2, y + cellHeight / 2);
            }
          }
        }
      }
    };

    drawRef.current = draw;
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(draw) : null;
    resizeObserver?.observe(parent);
    draw();
    return () => {
      resizeObserver?.disconnect();
      drawRef.current = () => {};
    };
  }, [matrix.usesProfileSensors]);

  const hasProfileBackground = Boolean(profile?.background?.imageData);
  const profileRect = useMemo<FittedProfileRect>(() => {
    if (hasProfileBackground) {
      return fitProfileRect(
        profileMapBounds.width,
        profileMapBounds.height,
        Math.max(0.01, asFiniteNumber(profile?.background?.aspectRatio, 1)),
      );
    }
    return {
      containerWidth: profileMapBounds.width,
      containerHeight: profileMapBounds.height,
      drawWidth: profileMapBounds.width,
      drawHeight: profileMapBounds.height,
      offsetX: 0,
      offsetY: 0,
      aspectRatio: profileMapBounds.width > 0 && profileMapBounds.height > 0 ? profileMapBounds.width / profileMapBounds.height : 1,
    };
  }, [hasProfileBackground, profile?.background?.aspectRatio, profileMapBounds.height, profileMapBounds.width]);

  if (matrix.usesProfileSensors) {
    return (
      <div className="profile-dot-map" ref={profileMapRef}>
        {hasProfileBackground ? (
          <img
            className="profile-dot-map-image"
            src={profile?.background?.imageData}
            alt=""
            draggable={false}
            style={{
              width: `${profileRect.drawWidth}px`,
              height: `${profileRect.drawHeight}px`,
              left: `${profileRect.offsetX}px`,
              top: `${profileRect.offsetY}px`,
            }}
          />
        ) : null}
        <div className="profile-dot-map-overlay">
          {matrix.points.map((point) => {
            const screenPoint = profilePointToScreen(point.xRatio, point.yRatio, profileRect);
            return (
              <div
                key={`${point.index}-${point.label}`}
                className="profile-dot"
                style={{
                  left: `${screenPoint.left}px`,
                  top: `${screenPoint.top}px`,
                  width: `${34 * dotSize}px`,
                  height: `${34 * dotSize}px`,
                  background: cssColorForValue(point.value, range),
                }}
                title={`${point.label}: ${point.value.toFixed(1)}`}
              >
                <span>{point.value.toFixed(0)}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="visualization-heatmap-canvas-wrap">
      <canvas ref={canvasRef} className="visualization-heatmap-canvas" />
    </div>
  );
}

function PressureSurface3D({
  matrix,
  range,
  profile,
  dotSize,
  onUnavailable,
}: {
  matrix: MatrixView;
  range: { min: number; max: number };
  profile: ProfileData | null | undefined;
  dotSize: number;
  onUnavailable: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onUnavailableRef = useRef(onUnavailable);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    surface: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
    backgroundMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    backgroundTexture: THREE.Texture | null;
    backgroundSource: string;
    frame: number;
    resizeObserver: ResizeObserver | null;
    cameraSignature: string;
  } | null>(null);

  useEffect(() => {
    onUnavailableRef.current = onUnavailable;
  }, [onUnavailable]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    try {
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setClearColor(0x101317, 1);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.domElement.className = "pressure-surface-canvas";
      container.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableZoom = true;
      controls.enablePan = true;
      controls.enableDamping = true;
      controls.dampingFactor = 0.12;
      controls.rotateSpeed = 0.7;
      controls.zoomSpeed = 0.9;
      controls.panSpeed = 0.6;
      controls.screenSpacePanning = true;
      controls.target.set(0, 0, 0);

      const backgroundMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
      );
      backgroundMesh.rotation.x = -Math.PI / 2;
      backgroundMesh.position.y = -0.04;
      backgroundMesh.visible = false;
      scene.add(backgroundMesh);

      const surfaceGeometry = new THREE.BufferGeometry();
      const surfaceMaterial = new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
      });
      const surface = new THREE.Mesh(surfaceGeometry, surfaceMaterial);
      surface.frustumCulled = false;
      scene.add(surface);

      const geometry = new THREE.BufferGeometry();
      const material = new THREE.PointsMaterial({
        size: 0.18,
        vertexColors: true,
        sizeAttenuation: true,
      });
      const points = new THREE.Points(geometry, material);
      points.frustumCulled = false;
      scene.add(points);
      scene.add(new THREE.AmbientLight(0xffffff, 0.9));
      const keyLight = new THREE.DirectionalLight(0xffffff, 0.65);
      keyLight.position.set(3, 6, 4);
      scene.add(keyLight);

      const grid = new THREE.GridHelper(12, 12, 0x2c3437, 0x20282b);
      grid.position.y = -0.02;
      scene.add(grid);

      const applySize = () => {
        const width = Math.max(container.clientWidth, 1);
        const height = Math.max(container.clientHeight, 1);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(applySize) : null;
      resizeObserver?.observe(container);
      applySize();

      const animate = () => {
        controls.update();
        renderer.render(scene, camera);
        const current = sceneRef.current;
        if (current) current.frame = window.requestAnimationFrame(animate);
      };

      sceneRef.current = {
        renderer,
        scene,
        camera,
        controls,
        surface,
        points,
        backgroundMesh,
        backgroundTexture: null,
        backgroundSource: "",
        frame: 0,
        resizeObserver,
        cameraSignature: "",
      };
      animate();
    } catch {
      onUnavailableRef.current();
    }

    return () => {
      const current = sceneRef.current;
      sceneRef.current = null;
      if (!current) return;
      window.cancelAnimationFrame(current.frame);
      current.resizeObserver?.disconnect();
      current.controls.dispose();
      current.surface.geometry.dispose();
      current.surface.material.dispose();
      current.points.geometry.dispose();
      current.points.material.dispose();
      current.backgroundMesh.geometry.dispose();
      current.backgroundMesh.material.dispose();
      current.backgroundTexture?.dispose();
      current.renderer.dispose();
      current.renderer.domElement.remove();
    };
  }, []);

  useEffect(() => {
    const current = sceneRef.current;
    if (!current) return;
    const { planeWidth, planeHeight } = profilePlaneDimensions(matrix, profile);
    const scale = Math.max(planeWidth, planeHeight, 1);
    const { positions, colors } = buildPointGeometry(
      matrix,
      range,
      planeWidth,
      planeHeight,
      scale,
      current.points.geometry,
      matrix.usesProfileSensors ? { planeWidth, planeHeight } : null,
    );
    setGeometryAttribute(current.points.geometry, "position", positions, 3);
    setGeometryAttribute(current.points.geometry, "color", colors, 3);
    current.points.material.size = 0.18 * dotSize;
    const surfaceData = buildSurfaceGeometry(matrix, range, planeWidth, planeHeight, scale, current.surface.geometry);
    current.surface.visible = Boolean(surfaceData);
    if (surfaceData) {
      setGeometryAttribute(current.surface.geometry, "position", surfaceData.positions, 3);
      setGeometryAttribute(current.surface.geometry, "color", surfaceData.colors, 3);
      setGeometryIndex(current.surface.geometry, surfaceData.indices);
    } else {
      current.surface.geometry.deleteAttribute("position");
      current.surface.geometry.deleteAttribute("color");
      current.surface.geometry.setIndex(null);
    }
    const backgroundSource = String(profile?.background?.imageData ?? "");
    const backgroundMaterial = current.backgroundMesh.material;
    current.backgroundMesh.scale.set(planeWidth, planeHeight, 1);
    current.backgroundMesh.visible = Boolean(backgroundSource);
    if (current.backgroundSource !== backgroundSource) {
      current.backgroundTexture?.dispose();
      current.backgroundTexture = null;
      current.backgroundSource = backgroundSource;
      if (backgroundSource) {
        const backgroundTexture = new THREE.TextureLoader().load(backgroundSource);
        backgroundTexture.colorSpace = THREE.SRGBColorSpace;
        current.backgroundTexture = backgroundTexture;
        backgroundMaterial.map = backgroundTexture;
      } else {
        backgroundMaterial.map = null;
      }
      backgroundMaterial.needsUpdate = true;
    }
    const cameraSignature = `${matrix.rows}x${matrix.cols}:${matrix.usesProfileSensors ? "profile" : "grid"}:${planeWidth.toFixed(3)}:${planeHeight.toFixed(3)}:${backgroundSource ? 1 : 0}`;
    if (current.cameraSignature !== cameraSignature) {
      current.cameraSignature = cameraSignature;
      resetSurfaceCamera(current, scale);
    }
  }, [dotSize, matrix, profile, range]);

  return <div className="pressure-surface" ref={containerRef} />;
}

export function VisualizationPage() {
  const { t } = useI18n();
  const { devices, visualizations, recording, status, errorMessage, subscribeVisualization, unsubscribeVisualization, setRecording } = useWsState();
  const [views, setViews] = useState<VisualizationView[]>(() => loadStoredViews());
  const [items, setItems] = useState<VisualizationEntry[]>([]);
  const [profiles, setProfiles] = useState<ProfileListEntry[]>([]);
  const [profileCache, setProfileCache] = useState<Record<string, ProfileData>>({});
  const [profileError, setProfileError] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [showCop, setShowCop] = useState(true);
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [deviceFpsByDevice, setDeviceFpsByDevice] = useState<Record<string, number>>({});
  const [renderFpsByDevice, setRenderFpsByDevice] = useState<Record<string, number>>({});
  const [uiError, setUiError] = useState("");
  const [clockTick, setClockTick] = useState(0);
  const latestRef = useRef<VisualizationEntry[]>([]);
  const frameRef = useRef(0);
  const renderLoopFrameRef = useRef(0);
  const deviceFrameStatsRef = useRef<Record<string, { lastTick: number; fps: number }>>({});
  const renderFrameStatsRef = useRef<Record<string, { lastTick: number; fps: number }>>({});
  const activeRenderDeviceKeys = useMemo(
    () => Array.from(new Set(views.map((view) => normalizeUid(view.deviceUid)).filter(Boolean))).sort(),
    [views],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
      setClockTick(now);
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  const devicesByUid = useMemo(() => {
    const next = new Map<string, DeviceEntry>();
    devices.forEach((device) => {
      next.set(normalizeUid(device.device_uid), device);
    });
    return next;
  }, [devices]);

  const itemsByUid = useMemo(() => {
    const next = new Map<string, VisualizationEntry>();
    items.forEach((item) => {
      next.set(normalizeUid(item.dn), item);
    });
    return next;
  }, [items]);

  const viewDeviceKey = useMemo(() => {
    return Array.from(new Set(views.map((view) => normalizeUid(view.deviceUid)).filter(Boolean))).sort().join("|");
  }, [views]);

  useEffect(() => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(views));
  }, [views]);

  useEffect(() => {
    const deviceUids = viewDeviceKey ? viewDeviceKey.split("|") : [];
    deviceUids.forEach((deviceUid) => subscribeVisualization(deviceUid));
    return () => {
      deviceUids.forEach((deviceUid) => unsubscribeVisualization(deviceUid));
    };
  }, [viewDeviceKey, subscribeVisualization, unsubscribeVisualization]);

  useEffect(() => {
    setDeviceFpsByDevice((current) => {
      const nextFps = { ...current };
      let hasFpsChange = false;
      for (const item of visualizations) {
        const deviceUid = normalizeUid(item.dn);
        const backendFps = Number(item.device_udp_fps ?? Number.NaN);
        const tick = Number(item.received_at_ms ?? 0);
        if (!deviceUid || !Number.isFinite(backendFps) || tick <= 0) continue;
        const nextValue = Math.max(0, backendFps);
        const previous = deviceFrameStatsRef.current[deviceUid];
        if (!previous || tick >= previous.lastTick || previous.fps !== nextValue) {
          deviceFrameStatsRef.current[deviceUid] = { lastTick: tick, fps: nextValue };
          nextFps[deviceUid] = nextValue;
          hasFpsChange = true;
        }
      }
      return hasFpsChange ? nextFps : current;
    });
    latestRef.current = visualizations;
    if (frameRef.current) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      const nextItems = latestRef.current;
      setItems(nextItems);
    });
    return () => {
      if (frameRef.current) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
    };
  }, [visualizations]);

  useEffect(() => {
    if (renderLoopFrameRef.current) {
      window.cancelAnimationFrame(renderLoopFrameRef.current);
      renderLoopFrameRef.current = 0;
    }
    if (activeRenderDeviceKeys.length === 0) {
      renderFrameStatsRef.current = {};
      setRenderFpsByDevice({});
      return undefined;
    }
    let cancelled = false;
    const renderLoop = (now: number) => {
      if (cancelled) return;
      activeRenderDeviceKeys.forEach((deviceUid) => {
        const previous = renderFrameStatsRef.current[deviceUid];
        if (previous && now > previous.lastTick) {
          const instantaneous = 1000 / Math.max(now - previous.lastTick, 1);
          const smoothed = previous.fps > 0 ? previous.fps * 0.72 + instantaneous * 0.28 : instantaneous;
          renderFrameStatsRef.current[deviceUid] = { lastTick: now, fps: smoothed };
        } else if (!previous) {
          renderFrameStatsRef.current[deviceUid] = { lastTick: now, fps: 0 };
        }
      });
      renderLoopFrameRef.current = window.requestAnimationFrame(renderLoop);
    };
    renderLoopFrameRef.current = window.requestAnimationFrame(renderLoop);
    return () => {
      cancelled = true;
      if (renderLoopFrameRef.current) {
        window.cancelAnimationFrame(renderLoopFrameRef.current);
        renderLoopFrameRef.current = 0;
      }
    };
  }, [activeRenderDeviceKeys]);

  useEffect(() => {
    if (clockTick <= 0) return;
    const now = clockTick;
    setDeviceFpsByDevice((current) => {
      const nextFps = { ...current };
      let hasFpsChange = false;
      Object.entries(deviceFrameStatsRef.current).forEach(([deviceUid, previous]) => {
        if (now - previous.lastTick > kVisualizationStaleMs && nextFps[deviceUid] !== 0) {
          deviceFrameStatsRef.current[deviceUid] = { ...previous, fps: 0 };
          nextFps[deviceUid] = 0;
          hasFpsChange = true;
        }
      });
      return hasFpsChange ? nextFps : current;
    });
    const nextRenderFps: Record<string, number> = {};
    activeRenderDeviceKeys.forEach((deviceUid) => {
      const previous = renderFrameStatsRef.current[deviceUid];
      if (!previous) {
        nextRenderFps[deviceUid] = 0;
        return;
      }
      if (now - previous.lastTick > kVisualizationStaleMs) {
        renderFrameStatsRef.current[deviceUid] = { ...previous, fps: 0 };
        nextRenderFps[deviceUid] = 0;
        return;
      }
      nextRenderFps[deviceUid] = previous.fps;
    });
    setRenderFpsByDevice((current) => sameNumberMap(current, nextRenderFps) ? current : nextRenderFps);
  }, [activeRenderDeviceKeys, clockTick]);

  const loadProfiles = useCallback(async () => {
    try {
      setProfileError("");
      const response = await api.profiles();
      setProfiles(response.items);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "profile_load_failed");
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    const missingProfileNames = Array.from(
      new Set(
        views
          .map((view) => view.profileName)
          .filter((profileName): profileName is string => typeof profileName === "string" && profileName.length > 0)
          .filter((profileName) => !profileCache[profileName]),
      ),
    );
    missingProfileNames.forEach((profileName) => {
      api
        .profile(profileName)
        .then((data) => {
          setProfileCache((current) => ({ ...current, [profileName]: data as ProfileData }));
        })
        .catch((error) => {
          setProfileError(error instanceof Error ? error.message : "profile_load_failed");
        });
    });
  }, [profileCache, views]);

  async function loadProfile(name: string) {
    if (!name || profileCache[name]) return profileCache[name] ?? null;
    const data = await api.profile(name);
    const profile = data as ProfileData;
    setProfileCache((current) => ({ ...current, [name]: profile }));
    return profile;
  }

  function updateView(id: string, patch: Partial<VisualizationView>) {
    setViews((current) => current.map((view) => (view.id === id ? { ...view, ...patch } : view)));
  }

  function addDeviceView(deviceUid: string) {
    const normalized = normalizeUid(deviceUid);
    if (!normalized) return;
    setViews((current) => {
      if (current.some((view) => normalizeUid(view.deviceUid) === normalized)) return current;
      return [
        ...current,
        {
          id: createViewId(normalized),
          deviceUid: normalized,
          rendererMode: "3d",
          profileName: null,
          selected: false,
          rowMirror: false,
          colMirror: false,
          dotSize: 1,
        },
      ];
    });
    setAddOpen(false);
  }

  function removeView(id: string) {
    setViews((current) => current.filter((view) => view.id !== id));
  }

  async function handleProfileChange(view: VisualizationView, profileName: string) {
    try {
      setProfileError("");
      if (!profileName) {
        updateView(view.id, { profileName: null });
        return;
      }
      const profile = await loadProfile(profileName);
      const profileMode = profile?.display?.mode;
      const rendererMode: VisualizationRendererMode =
        profileMode === "2d" || profileMode === "3d" ? profileMode : view.rendererMode;
      updateView(view.id, { profileName, rendererMode });
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "profile_load_failed");
    }
  }

  function handleRecording(deviceUid: string, enabled: boolean) {
    try {
      setUiError("");
      setRecording(deviceUid, enabled);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : "recording_failed");
    }
  }

  function handleSelectedRecording(enabled: boolean) {
    views
      .filter((view) => view.selected)
      .forEach((view) => handleRecording(view.deviceUid, enabled));
  }

  const selectedCount = views.filter((view) => view.selected).length;
  const addedDevices = new Set(views.map((view) => normalizeUid(view.deviceUid)));

  return (
    <>
      <section className="page-header">
        <div>
          <h2>{t("visualization")}</h2>
          <p className="page-copy">{t("wsStatus")}: {status}</p>
        </div>
      </section>
      {errorMessage || uiError || profileError ? <p className="notice error">{errorMessage || uiError || profileError}</p> : null}

      <section className="visualization-toolbar panel">
        <div className="visualization-toolbar-title">Pressure Heatmap</div>
        <button className="button primary" type="button" onClick={() => setAddOpen(true)}>
          {t("addDeviceView")}
        </button>
        <button className="button danger" type="button" disabled={selectedCount === 0} onClick={() => handleSelectedRecording(true)}>
          {t("recSelected")}
        </button>
        <button className="button" type="button" disabled={selectedCount === 0} onClick={() => handleSelectedRecording(false)}>
          {t("stopSelected")}
        </button>
        <label className="switch-row">
          <input type="checkbox" checked={showCop} onChange={(event) => setShowCop(event.target.checked)} />
          <span>{t("showCop")}</span>
        </label>
        <div className="range-controls">
          <span>{t("range")}</span>
          <label>
            {t("min")}
            <input
              type="number"
              value={range.min}
              onChange={(event) => setRange((current) => ({ ...current, min: Number(event.target.value) }))}
              onBlur={() => setRange((current) => ({ ...current, max: Math.max(current.max, current.min + 1) }))}
            />
          </label>
          <label>
            {t("max")}
            <input
              type="number"
              value={range.max}
              onChange={(event) => setRange((current) => ({ ...current, max: Number(event.target.value) }))}
              onBlur={() => setRange((current) => ({ ...current, max: Math.max(current.max, current.min + 1) }))}
            />
          </label>
          <button className="button" type="button" onClick={() => setRange(DEFAULT_RANGE)}>
            {t("reset")}
          </button>
        </div>
      </section>

      <section className="visualization-card-grid">
        {views.length === 0 ? (
          <div className="panel span-12 visualization-empty-state">
            <h3>{t("noDeviceViews")}</h3>
            <p>{t("noDeviceViewsCopy")}</p>
            <button className="button primary" type="button" onClick={() => setAddOpen(true)}>
              {t("addDeviceView")}
            </button>
          </div>
        ) : null}
        {views.map((view) => {
          const deviceUid = normalizeUid(view.deviceUid);
          const device = devicesByUid.get(deviceUid);
          const item = itemsByUid.get(deviceUid);
          const profile = view.profileName ? profileCache[view.profileName] : null;
          const cardRange = rangeForProfile(profile, range);
          const calibrationState = calibrationStateForDevice(device);
          const hasEnabledCalibration = calibrationState.enabled;
          const hasCalibrationLevels = calibrationLevelsForDevice(device).length > 0;
          const activeRange = hasEnabledCalibration ? calibrationDisplayRange(calibrationState, cardRange) : cardRange;
          const matrix = buildMatrixView(item, device, profile, view.rowMirror, view.colMirror);
          const dotSize = clamp(asFiniteNumber(view.dotSize, 1), 0.5, 4);
          const cop = computeCop(matrix.points, matrix.rows, matrix.cols);
          const values = matrix.points.map((point) => point.value);
          const maxPressure = values.length ? Math.max(...values) : 0;
          const isRecording = Boolean(recording[deviceUid] ?? device?.recording_enabled);
          const normalizedDevice = device ? normalizeDevice(device) : null;
          const title = normalizedDevice?.displayName || safeDisplayName(device, deviceUid);
          const badgeState = visualizationBadgeState(device, item, clockTick);
          const badgeLabel = badgeState === "live" ? t("live") : badgeState === "waiting" ? t("waitingForData") : t("offline");
          return (
            <article key={view.id} className="panel visualization-device-card">
              <div className="visualization-card-header">
                <label className="visualization-select-row">
                  <input
                    type="checkbox"
                    checked={view.selected}
                    onChange={(event) => updateView(view.id, { selected: event.target.checked })}
                  />
                  <span>{title}</span>
                </label>
                <div className="actions compact-actions">
                  <div className={`status-pill ${badgeState}`}>{badgeLabel}</div>
                  <button
                    className={`button ${isRecording ? "danger" : "primary"}`}
                    type="button"
                    onClick={() => handleRecording(deviceUid, !isRecording)}
                  >
                    {isRecording ? t("stopRecording") : t("record")}
                  </button>
                  <button className="button danger" type="button" onClick={() => removeView(view.id)} aria-label={t("delete")}>
                    ×
                  </button>
                </div>
              </div>

              <div className="device-uid">{deviceUid}</div>
              <div className="visualization-card-controls">
                <div className="field compact-field">
                  <label>{t("matrixShape")}</label>
                  <div className="readonly-field">{matrix.rows} × {matrix.cols}</div>
                </div>
                <div className="field compact-field">
                  <label>{t("profiles")}</label>
                  <div className="profile-select-row">
                    <select
                      value={view.profileName ?? ""}
                      onChange={(event) => void handleProfileChange(view, event.target.value)}
                    >
                      <option value="">{t("profileNoneStandard")}</option>
                      {profiles.map((profileItem) => (
                        <option key={profileItem.name} value={profileItem.name}>
                          {profileItem.displayName || profileItem.name}
                        </option>
                      ))}
                    </select>
                    <button className="button" type="button" onClick={() => void loadProfiles()}>
                      ↻
                    </button>
                  </div>
                </div>
                <div className="segmented-control renderer-toggle">
                  <button
                    className={view.rendererMode === "3d" ? "active" : ""}
                    type="button"
                    onClick={() => updateView(view.id, { rendererMode: "3d" })}
                  >
                    {t("surface3d")}
                  </button>
                  <button
                    className={view.rendererMode === "2d" ? "active" : ""}
                    type="button"
                    onClick={() => updateView(view.id, { rendererMode: "2d" })}
                  >
                    {t("heatmap2d")}
                  </button>
                </div>
                {profile ? (
                  <div className="field compact-field profile-dot-size-field">
                    <label>{t("dotSize")}: {dotSize.toFixed(2)}×</label>
                    <input
                      type="range"
                      min="0.5"
                      max="4"
                      step="0.25"
                      value={dotSize}
                      onChange={(event) => updateView(view.id, { dotSize: Number(event.target.value) || 1 })}
                    />
                  </div>
                ) : null}
                <div className="mirror-controls">
                  <label className="switch-row">
                    <input
                      type="checkbox"
                      checked={view.rowMirror}
                      onChange={(event) => updateView(view.id, { rowMirror: event.target.checked })}
                    />
                    <span>{t("rowMirror")}</span>
                  </label>
                  <label className="switch-row">
                    <input
                      type="checkbox"
                      checked={view.colMirror}
                      onChange={(event) => updateView(view.id, { colMirror: event.target.checked })}
                    />
                    <span>{t("colMirror")}</span>
                  </label>
                </div>
                {hasEnabledCalibration ? <p className="service-muted">{t("calibratedRangeHint")}</p> : null}
                {!hasEnabledCalibration && hasCalibrationLevels ? <p className="service-muted">{t("calibrationAvailableOnDevice")}</p> : null}
              </div>

              <div className="visualization-overview-grid compact-visualization-metrics">
                <div className="metric visualization-metric">
                  <div className="metric-label">{t("samples")}</div>
                  <div className="metric-value">{item?.sn ?? "-"}</div>
                </div>
                <div className="metric visualization-metric">
                  <div className="metric-label">Device FPS</div>
                  <div className="metric-value">{(deviceFpsByDevice[deviceUid] ?? 0).toFixed(1)}</div>
                </div>
                <div className="metric visualization-metric">
                  <div className="metric-label">Render FPS</div>
                  <div className="metric-value">{(renderFpsByDevice[deviceUid] ?? 0).toFixed(1)}</div>
                </div>
                <div className="metric visualization-metric">
                  <div className="metric-label">{hasEnabledCalibration ? t("maxCalibratedLevel") : "Max P"}</div>
                  <div className="metric-value">{maxPressure.toFixed(2)}</div>
                </div>
                <div className="metric visualization-metric visualization-vector-metric">
                  <div className="metric-label">Gyro</div>
                  <div className="metric-value small-value">{formatVector(item?.gyro ?? item?.imu?.gyro)}</div>
                </div>
                <div className="metric visualization-metric visualization-vector-metric">
                  <div className="metric-label">Acc</div>
                  <div className="metric-value small-value">{formatVector(item?.acc ?? item?.imu?.acc)}</div>
                </div>
                {showCop ? (
                  <div className={`cop-mini-card ${cop.hasData ? "has-data" : ""}`}>
                    <div className="metric-label">COP</div>
                    <div className="cop-mini-board">
                      <div className="cop-mini-placeholder">--</div>
                      <div
                        className="cop-mini-dot"
                        style={{
                          left: `${cop.xRatio * 100}%`,
                          top: `${cop.yRatio * 100}%`,
                        }}
                      />
                    </div>
                    <div className="cop-mini-values">
                      <span>X {cop.hasData ? cop.x.toFixed(2) : "--"}</span>
                      <span>Y {cop.hasData ? cop.y.toFixed(2) : "--"}</span>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="visualization-renderer-frame">
                {!item ? (
                  <div className="visualization-no-frame">{t("noData")}</div>
                ) : view.rendererMode === "3d" ? (
                  <PressureSurface3D
                    matrix={matrix}
                    range={activeRange}
                    profile={profile}
                    dotSize={dotSize}
                    onUnavailable={() => {
                      updateView(view.id, { rendererMode: "2d" });
                      setUiError(t("webglUnavailable"));
                    }}
                  />
                ) : (
                  <PressureHeatmap2D matrix={matrix} range={activeRange} profile={profile} dotSize={dotSize} />
                )}
              </div>
            </article>
          );
        })}
      </section>

      {addOpen ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setAddOpen(false)}>
          <div className="modal-panel add-device-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3>{t("addDeviceView")}</h3>
                <p>{t("addDeviceViewCopy")}</p>
              </div>
              <button className="button" type="button" onClick={() => setAddOpen(false)}>
                {t("cancel")}
              </button>
            </div>
            <div className="device-grid">
              {devices.length === 0 ? <div className="panel span-12">{t("noDevicesDiscovered")}</div> : null}
              {devices.map((device) => {
                const deviceUid = normalizeUid(device.device_uid);
                const exists = addedDevices.has(deviceUid);
                return (
                  <button
                    key={deviceUid}
                    className="device-card add-device-card"
                    type="button"
                    disabled={exists}
                    onClick={() => addDeviceView(deviceUid)}
                  >
                    <div className="device-card-header">
                      <h3>{safeDisplayName(device, deviceUid)}</h3>
                      <span className={`device-badge ${device.mode ?? ""}`}>{device.mode ?? "-"}</span>
                    </div>
                    <div className="device-uid">{deviceUid}</div>
                    <div className="device-meta-grid">
                      <span>{t("matrixShape")}: {device.matrix_shape ? `${device.matrix_shape.rows} × ${device.matrix_shape.cols}` : "-"}</span>
                      <span>{t("transport")}: {device.transport_mode ?? "-"}</span>
                      <span>{t("lastSeen")}: {device.last_seen_at ?? "-"}</span>
                      <span>{exists ? t("deviceAlreadyAdded") : t("addDeviceView")}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
