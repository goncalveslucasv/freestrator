/** Affine matrix [a, b, c, d, e, f]: (x, y) -> (a·x + c·y + e, b·x + d·y + f). */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** A·B: applies B first, then A. */
export function mul(A: Mat, B: Mat): Mat {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

export function inv(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return [...IDENTITY];
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Applies only the linear part (for vectors). */
export function applyVec(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
}

export const translate = (tx: number, ty: number): Mat => [1, 0, 0, 1, tx, ty];
export const scale = (sx: number, sy = sx): Mat => [sx, 0, 0, sy, 0, 0];
export function rotate(rad: number): Mat {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}

/** Transform `m` about the point (cx, cy). */
export function about(m: Mat, cx: number, cy: number): Mat {
  return mul(translate(cx, cy), mul(m, translate(-cx, -cy)));
}

export const isIdentity = (m: Mat) =>
  m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;

const r = (n: number) => +n.toFixed(6);
export const toSvg = (m: Mat) => `matrix(${m.map(r).join(" ")})`;

/** Uniform scale factor of the matrix (geometric mean of the axes). */
export const matScale = (m: Mat) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

/** Rotation angle of the x axis, in degrees. */
export const matRotation = (m: Mat) => (Math.atan2(m[1], m[0]) * 180) / Math.PI;
