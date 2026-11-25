// How the Visualization card lays a rows×cols stream out on screen: Transpose
// swaps the axes first, then Row / Col Mirror flip what is shown (top-bottom /
// left-right), so the mirrors always act on the picture you see. The three
// together give every one of the square's 8 symmetries (Transpose + Col Mirror
// = a quarter turn clockwise). Display only: recordings and P numbers keep
// the device's order. NH Studio / Pocket use the same rule
// (@nhgw/host visualization.ts transformGrid).

export type MatrixTransform = {
  rowMirror: boolean;
  colMirror: boolean;
  transpose: boolean;
};

export type DisplayGrid = {
  /** Rows and columns as drawn (swapped by Transpose). */
  rows: number;
  cols: number;
  /** indices[r][c]: the row-major stream index drawn at display cell (r, c). */
  indices: number[][];
};

export function displayIndexGrid(rows: number, cols: number, transform: MatrixTransform): DisplayGrid {
  const { rowMirror, colMirror, transpose } = transform;
  const dispRows = transpose ? cols : rows;
  const dispCols = transpose ? rows : cols;
  const indices = Array.from({ length: dispRows }, (_, r) =>
    Array.from({ length: dispCols }, (_, c) => {
      const rr = rowMirror ? dispRows - 1 - r : r;
      const cc = colMirror ? dispCols - 1 - c : c;
      const sourceRow = transpose ? cc : rr;
      const sourceCol = transpose ? rr : cc;
      return sourceRow * cols + sourceCol;
    }),
  );
  return { rows: dispRows, cols: dispCols, indices };
}

/**
 * The row (A..) and column (D..) pin labels for the drawn grid: with
 * Transpose the stream's columns become the drawn rows and vice versa.
 */
export function displayPinLabels(
  labels: { rows: readonly string[]; cols: readonly string[] },
  transform: MatrixTransform,
): { rows: string[]; cols: string[] } {
  const drawnRows = transform.transpose ? [...labels.cols] : [...labels.rows];
  const drawnCols = transform.transpose ? [...labels.rows] : [...labels.cols];
  return {
    rows: transform.rowMirror ? drawnRows.reverse() : drawnRows,
    cols: transform.colMirror ? drawnCols.reverse() : drawnCols,
  };
}
