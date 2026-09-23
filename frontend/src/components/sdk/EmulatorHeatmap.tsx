import { useEffect, useRef, useState } from "react";

import { cssColorForValue, type PressureRange } from "../../lib/pressureColor";
import type { Frame, Region } from "../../sdk/lib/index.mjs";

type Props = {
  frame: Frame | null;
  rows: number;
  cols: number;
  range: PressureRange;
  /** The app's regions, drawn in device coordinates -- row 0 at the top. */
  regions: Record<string, Region>;
  ariaLabel: string;
};

const GAP = 2;
const REGION_COLOURS = ["#0a84ff", "#ff9f0a", "#bf5af2", "#30b0c7", "#ff375f", "#64d2ff"];

/**
 * The matrix as the flow graph sees it: cell (r, c) is value r * cols + c,
 * with no mirroring or profile layout, so a region drawn here covers exactly
 * the cells its sum() adds up.
 */
export function EmulatorHeatmap({ frame, rows, cols, range, regions, ariaLabel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<{ row: number; col: number } | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const parent = canvasRef.current?.parentElement;
    if (!parent) return undefined;
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => setWidth(parent.clientWidth)) : null;
    observer?.observe(parent);
    setWidth(parent.clientWidth);
    return () => observer?.disconnect();
  }, []);

  const cssWidth = Math.max(width, 1);
  const cell = Math.max(4, (cssWidth - GAP * (cols + 1)) / Math.max(cols, 1));
  const cssHeight = GAP + rows * (cell + GAP);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(cssWidth * ratio));
    canvas.height = Math.max(1, Math.floor(cssHeight * ratio));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);
    context.fillStyle = "#101317";
    context.fillRect(0, 0, cssWidth, cssHeight);

    const values = frame?.values;
    const showText = cell >= 30;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `${Math.max(9, Math.min(11, cell * 0.28))}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif`;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const value = values ? Number(values[row * cols + col] ?? 0) : 0;
        const x = GAP + col * (cell + GAP);
        const y = GAP + row * (cell + GAP);
        context.fillStyle = values ? cssColorForValue(value, range) : "#2c2c2e";
        context.beginPath();
        context.roundRect(x, y, cell, cell, Math.min(4, cell * 0.18));
        context.fill();
        if (showText && values) {
          context.fillStyle = "#101317";
          context.fillText(value.toFixed(0), x + cell / 2, y + cell / 2);
        }
      }
    }

    Object.entries(regions).forEach(([name, region], index) => {
      const colour = REGION_COLOURS[index % REGION_COLOURS.length];
      const r1 = Math.min(region.r1, rows - 1);
      const c1 = Math.min(region.c1, cols - 1);
      if (region.r0 > r1 || region.c0 > c1) return;
      const x = GAP / 2 + region.c0 * (cell + GAP);
      const y = GAP / 2 + region.r0 * (cell + GAP);
      const w = (c1 - region.c0 + 1) * (cell + GAP);
      const h = (r1 - region.r0 + 1) * (cell + GAP);
      context.strokeStyle = colour;
      context.lineWidth = 2;
      context.setLineDash([5, 3]);
      context.strokeRect(x + 1, y + 1, w - 2, h - 2);
      context.setLineDash([]);
      context.font = "600 11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
      const labelWidth = context.measureText(name).width + 10;
      context.fillStyle = colour;
      context.fillRect(x + 1, y + 1, labelWidth, 16);
      context.fillStyle = "#ffffff";
      context.textAlign = "left";
      context.fillText(name, x + 6, y + 9);
      context.textAlign = "center";
    });
  }, [frame, rows, cols, range, regions, cell, cssWidth, cssHeight]);

  const hoverValue = hover && frame ? Number(frame.values[hover.row * cols + hover.col] ?? 0) : null;

  return (
    <div className="sdk-heatmap">
      <canvas
        ref={canvasRef}
        style={{ width: `${cssWidth}px`, height: `${cssHeight}px` }}
        role="img"
        aria-label={ariaLabel}
        onMouseMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const col = Math.floor((event.clientX - bounds.left - GAP / 2) / (cell + GAP));
          const row = Math.floor((event.clientY - bounds.top - GAP / 2) / (cell + GAP));
          setHover(row >= 0 && row < rows && col >= 0 && col < cols ? { row, col } : null);
        }}
        onMouseLeave={() => setHover(null)}
      />
      <div className="sdk-heatmap-caption sdk-mono">
        {hover ? `row ${hover.row}, col ${hover.col} · #${hover.row * cols + hover.col}${hoverValue !== null ? ` = ${hoverValue.toFixed(1)}` : ""}` : `${rows} × ${cols}`}
      </div>
    </div>
  );
}
