/** Built-in demo scene, mirroring the bundled samples in spirit but richer. */
export function loadSampleScene(): unknown {
  return {
    nodes: [
      { id: 'root', parent: null, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], box: [0.2, 0.2, 0.2] },
      {
        id: 'parent',
        parent: 'root',
        matrix: [0, -1, 0, 3, 2, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1],
        box: [0.5, 0.5, 0.5],
      },
      {
        id: 'payload',
        parent: 'parent',
        matrix: [1, 0.25, 0, 1, 0, 1, 0, 2, 0, 0, 1, 0, 0, 0, 0, 1],
        box: [1, 1, 1],
      },
      {
        id: 'new-parent',
        parent: 'root',
        matrix: [-1, 0, 0, -2, 0, 2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1],
        box: [0.5, 0.5, 0.5],
      },
      {
        id: 'singular',
        parent: 'root',
        matrix: [0, 0, 0, 8, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        box: [0.5, 0.5, 0.5],
      },
      {
        id: 'mirrored-display',
        parent: 'new-parent',
        matrix: [-0.6, 0, 0, 0.9, 0, 0.6, 0, 0.2, 0, 0, 0.6, 0, 0, 0, 0, 1],
        box: [0.7, 0.35, 0.9],
      },
      {
        id: 'sheared-pillar',
        parent: 'root',
        matrix: [0.55, 0.32, 0, -2.4, 0, 1.25, 0, 0, 0.18, 0, 0.55, 2.2, 0, 0, 0, 1],
        box: [0.4, 1.6, 0.4],
      },
    ],
    selection: ['payload'],
    active: 'payload',
  };
}
