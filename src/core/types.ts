/** Row-major 4x4 affine matrix, acting on column vectors. */
export type Mat4 = number[];

export type Vec3 = [number, number, number];

export interface SceneNode {
  id: string;
  parent: string | null;
  /** Local transform, row-major 16 numbers. */
  matrix: Mat4;
  /** Local box dimensions, centered on the local origin. */
  box: Vec3;
}

export interface SceneState {
  /** Insertion order of the document; also used for stable display ordering. */
  nodes: Map<string, SceneNode>;
  order: string[];
  selection: string[];
  active: string | null;
}

export type Axis = 'x' | 'y' | 'z';
export type AxisSpace = 'world' | 'local';

export interface TranslateRequest {
  mode: 'translate';
  space: AxisSpace;
  axis: Axis;
  /** Metric distance. May be negative. */
  distance: number;
}

export interface RotateRequest {
  mode: 'rotate';
  space: AxisSpace;
  axis: Axis;
  /** Degrees, right-hand rule around the derived world-space axis. */
  degrees: number;
}

export type TransformRequest = TranslateRequest | RotateRequest;

export type ErrorCode =
  | 'invalid-document'
  | 'invalid-node'
  | 'invalid-matrix'
  | 'non-finite'
  | 'duplicate-id'
  | 'missing-parent'
  | 'cycle'
  | 'limit'
  | 'not-found'
  | 'empty-selection'
  | 'zero-axis'
  | 'singular-parent'
  | 'invalid-selection'
  | 'internal';

export class SceneError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'SceneError';
    this.code = code;
  }
}
