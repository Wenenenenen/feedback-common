import type { Edge, ParameterizeResult } from '../core/types.js';

export interface MeshInput {
  vertices: [number, number, number][];
  faces: [number, number, number][];
  seams: Edge[];
}

export interface ViewFlags {
  wire: boolean;
  chartColor: boolean;
  boundary: boolean;
  split: boolean;
  residual: boolean;
  uvGrid: boolean;
  uvResidual: boolean;
}

export interface Selection {
  face: number | null;
  cutVertex: number | null;
  chart: number | null;
  faces: number[];
}

export type StoreEvent = 'input' | 'seams' | 'result' | 'view' | 'selection' | 'status';
export type StatusKind = 'idle' | 'ok' | 'error' | 'busy';

type Listener = (event: StoreEvent) => void;

const defaultFlags = (): ViewFlags => ({
  wire: false,
  chartColor: true,
  boundary: false,
  split: false,
  residual: false,
  uvGrid: true,
  uvResidual: false,
});

export const normaliseEdge = (a: number, b: number): Edge => (a < b ? [a, b] : [b, a]);

export class Store {
  input: MeshInput | null = null;
  sourceName = '';
  seams: Edge[] = [];
  result: ParameterizeResult | null = null;
  flags: ViewFlags = defaultFlags();
  selection: Selection = { face: null, cutVertex: null, chart: null, faces: [] };
  hover: { face: number | null; edge: Edge | null } = { face: null, edge: null };
  status: { kind: StatusKind; text: string; timing: string } = {
    kind: 'idle',
    text: '就绪',
    timing: '',
  };
  hoveredSeam: Edge | null = null;
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: StoreEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  setInput(input: MeshInput, sourceName: string): void {
    this.input = input;
    this.sourceName = sourceName;
    this.seams = input.seams.map(([a, b]) => normaliseEdge(a, b));
    this.result = null;
    this.selection = { face: null, cutVertex: null, chart: null, faces: [] };
    this.hover = { face: null, edge: null };
    this.emit('input');
  }

  setSeams(seams: Edge[]): void {
    const seen = new Set<string>();
    const next: Edge[] = [];
    for (const [rawA, rawB] of seams) {
      if (rawA === rawB) continue;
      const [a, b] = normaliseEdge(rawA, rawB);
      const key = `${a}:${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push([a, b]);
    }
    this.seams = next;
    this.emit('seams');
  }

  setResult(result: ParameterizeResult): void {
    this.result = result;
    this.emit('result');
  }

  setFlags(patch: Partial<ViewFlags>): void {
    this.flags = { ...this.flags, ...patch };
    this.emit('view');
  }

  select(patch: Partial<Selection>): void {
    this.selection = { ...this.selection, ...patch };
    this.emit('selection');
  }

  setStatus(kind: StatusKind, text: string, timing = ''): void {
    this.status = { kind, text, timing };
    this.emit('status');
  }
}

export const store = new Store();
