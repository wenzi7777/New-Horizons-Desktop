export type FittedProfileRect = {
  containerWidth: number;
  containerHeight: number;
  drawWidth: number;
  drawHeight: number;
  offsetX: number;
  offsetY: number;
  aspectRatio: number;
};

function clampRatio(value: number) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

export function fitProfileRect(containerWidth: number, containerHeight: number, aspectRatio: number): FittedProfileRect {
  const safeWidth = Math.max(0, containerWidth);
  const safeHeight = Math.max(0, containerHeight);
  const safeAspectRatio = Math.max(0.01, aspectRatio || 1);

  if (safeWidth <= 0 || safeHeight <= 0) {
    return {
      containerWidth: safeWidth,
      containerHeight: safeHeight,
      drawWidth: 0,
      drawHeight: 0,
      offsetX: 0,
      offsetY: 0,
      aspectRatio: safeAspectRatio,
    };
  }

  const containerRatio = safeWidth / safeHeight;
  const drawWidth = containerRatio > safeAspectRatio ? safeHeight * safeAspectRatio : safeWidth;
  const drawHeight = drawWidth / safeAspectRatio;
  const offsetX = (safeWidth - drawWidth) / 2;
  const offsetY = (safeHeight - drawHeight) / 2;

  return {
    containerWidth: safeWidth,
    containerHeight: safeHeight,
    drawWidth,
    drawHeight,
    offsetX,
    offsetY,
    aspectRatio: safeAspectRatio,
  };
}

export function profilePointToScreen(xRatio: number, yRatio: number, rect: FittedProfileRect) {
  const safeX = clampRatio(xRatio);
  const safeY = clampRatio(yRatio);
  return {
    left: rect.offsetX + safeX * rect.drawWidth,
    top: rect.offsetY + safeY * rect.drawHeight,
  };
}

export function profilePointToWorld(xRatio: number, yRatio: number, planeWidth: number, planeHeight: number) {
  const safeX = clampRatio(xRatio);
  const safeY = clampRatio(yRatio);
  const worldX = (safeX - 0.5) * planeWidth;
  const worldZ = (safeY - 0.5) * planeHeight;
  return { worldX, worldZ };
}
