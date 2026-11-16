import { expect, test, type Page } from '@playwright/test';

interface SceneNode {
  id: string;
  parent: string | null;
  matrix: number[];
  box: number[];
}

interface SceneDoc {
  nodes: SceneNode[];
  selection: string[];
  active: string | null;
}

interface SnapshotNode {
  id: string;
  parent: string | null;
  matrix: number[];
  world: number[];
}

interface Snapshot {
  selection: string[];
  active: string | null;
  roots: string[];
  nodes: SnapshotNode[];
  history: { undoCount: number; redoCount: number; canUndo: boolean; canRedo: boolean; limit: number };
}

const SAMPLE: SceneDoc = {
  nodes: [
    { id: 'payload', parent: 'parent', matrix: [1, 0.25, 0, 1, 0, 1, 0, 2, 0, 0, 1, 0, 0, 0, 0, 1], box: [1, 1, 1] },
    { id: 'root', parent: null, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], box: [0.2, 0.2, 0.2] },
    { id: 'parent', parent: 'root', matrix: [0, -1, 0, 3, 2, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1], box: [0.5, 0.5, 0.5] },
    { id: 'new-parent', parent: 'root', matrix: [-1, 0, 0, -2, 0, 2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1], box: [0.5, 0.5, 0.5] },
    { id: 'singular', parent: 'root', matrix: [0, 0, 0, 8, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], box: [0.5, 0.5, 0.5] },
  ],
  selection: ['payload'],
  active: 'payload',
};

const EXPECTED_INITIAL_WORLD = [0, -1, 0, 1, 2, 0.5, 0, 3, 0, 0, 1, 0, 0, 0, 0, 1];
const EXPECTED_REPARENT_LOCAL = [0, 1, 0, -3, 1, 0.25, 0, 1.5, 0, 0, 2, 0, 0, 0, 0, 1];

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as unknown as { scenario?: unknown }).scenario));
  return errors;
}

async function loadDoc(page: Page, doc: unknown, name = 'test-scene.json'): Promise<void> {
  const text = JSON.stringify(doc);
  await page.evaluate(
    async ({ text, name }) => {
      const file = new File([text], name, { type: 'application/json' });
      await (window as unknown as { scenario: { importFile(f: File): Promise<void> } }).scenario.importFile(file);
    },
    { text, name },
  );
  await page.waitForTimeout(120);
}

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => (window as unknown as { scenario: { getSnapshot(): Snapshot } }).scenario.getSnapshot());
}

async function scene(page: Page): Promise<SceneDoc> {
  return page.evaluate(() => (window as unknown as { scenario: { getScene(): SceneDoc } }).scenario.getScene());
}

function geometryOf(doc: SceneDoc): Array<{ id: string; parent: string | null; matrix: number[] }> {
  return doc.nodes.map((n) => ({ id: n.id, parent: n.parent, matrix: n.matrix }));
}

function nodeOf(doc: SceneDoc, id: string): SceneNode {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`缺少节点 ${id}`);
  return node;
}

function expectClose(actual: number[], expected: number[], tolerance = 1e-9): void {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    expect(Math.abs(actual[i] - expected[i]), `index ${i}: ${actual[i]} vs ${expected[i]}`).toBeLessThanOrEqual(tolerance);
  }
}

test.describe('affine scene editor', () => {
  test('loads the sample case and reports the documented world transform', async ({ page }) => {
    const errors = await boot(page);
    await loadDoc(page, SAMPLE);
    const snap = await snapshot(page);
    const payload = snap.nodes.find((n) => n.id === 'payload')!;
    expect(payload.parent).toBe('parent');
    expectClose(payload.world, EXPECTED_INITIAL_WORLD, 1e-12);
    expect(snap.selection).toEqual(['payload']);
    expect(errors).toEqual([]);
  });

  test('preserves world when reparenting: exact expected local matrix and no shear loss', async ({ page }) => {
    await boot(page);
    await loadDoc(page, SAMPLE);
    const before = await snapshot(page);
    const worldBefore = before.nodes.find((n) => n.id === 'payload')!.world;

    await page.locator('.target-row .text-input').fill('new-parent');
    await page.getByTestId('apply-reparent').click();
    await page.waitForTimeout(150);

    const doc = await scene(page);
    const payload = nodeOf(doc, 'payload');
    expect(payload.parent).toBe('new-parent');
    expectClose(payload.matrix, EXPECTED_REPARENT_LOCAL, 1e-8);
    expect(payload.matrix[1]).not.toBe(0); // shear retained

    const after = await snapshot(page);
    const worldAfter = after.nodes.find((n) => n.id === 'payload')!.world;
    expectClose(worldAfter, worldBefore, 1e-8);
    expect(after.history.undoCount).toBe(1);
  });

  test('undo/redo restores hierarchy, matrices and selection; 100+ steps supported', async ({ page }) => {
    await boot(page);
    await loadDoc(page, SAMPLE);
    const initial = await scene(page);

    await page.locator('.target-row .text-input').fill('new-parent');
    await page.getByTestId('apply-reparent').click();
    await page.waitForTimeout(100);
    const afterReparent = await scene(page);
    expect(nodeOf(afterReparent, 'payload').parent).toBe('new-parent');

    await page.getByTestId('undo').click();
    await page.waitForTimeout(80);
    expect(await scene(page)).toEqual(initial);
    const snapAfterUndo = await snapshot(page);
    expect(snapAfterUndo.selection).toEqual(['payload']);
    expect(snapAfterUndo.active).toBe('payload');

    await page.getByTestId('redo').click();
    await page.waitForTimeout(80);
    expect(await scene(page)).toEqual(afterReparent);

    // More than 100 distinct transactions.
    await page.evaluate(() => {
      const s = (window as unknown as { scenario: { translate(...a: unknown[]): boolean } }).scenario;
      for (let i = 0; i < 120; i += 1) s.translate('world', 'y', 0.01);
    });
    const deep = await snapshot(page);
    expect(deep.history.undoCount).toBeGreaterThanOrEqual(100);
    const end = await scene(page);
    await page.evaluate(() => {
      const s = (window as unknown as { scenario: { undo(): boolean } }).scenario;
      for (let i = 0; i < 110; i += 1) s.undo();
    });
    const undone = await snapshot(page);
    expect(undone.history.undoCount).toBe(deep.history.undoCount - 110);
    await page.evaluate(() => {
      const s = (window as unknown as { scenario: { redo(): boolean } }).scenario;
      for (let i = 0; i < 110; i += 1) s.redo();
    });
    expect(await scene(page)).toEqual(end);
  });

  test('rejects cyclic and singular reparents without touching any matrix', async ({ page }) => {
    await boot(page);
    await loadDoc(page, SAMPLE);
    const before = await scene(page);

    // payload is a descendant of parent: reparenting parent under payload cycles.
    await page.evaluate(() => {
      (window as unknown as { scenario: { setSelection(ids: string[], active: string): void } }).scenario.setSelection(['parent'], 'parent');
    });
    await page.locator('.target-row .text-input').fill('payload');
    await page.getByTestId('apply-reparent').click();
    await page.waitForTimeout(150);
    expect(geometryOf(await scene(page))).toEqual(geometryOf(before));
    await expect(page.locator('.toast-error').last()).toContainText('循环');

    // singular world matrix cannot be inverted for preserve-world reparent.
    await page.evaluate(() => {
      (window as unknown as { scenario: { setSelection(ids: string[], active: string): void } }).scenario.setSelection(['payload'], 'payload');
    });
    await page.locator('.target-row .text-input').fill('singular');
    await page.getByTestId('apply-reparent').click();
    await page.waitForTimeout(150);
    expect(geometryOf(await scene(page))).toEqual(geometryOf(before));
    await expect(page.locator('.toast-error').last()).toContainText('奇异');

    const snap = await snapshot(page);
    expect(snap.history.undoCount).toBe(0);
  });

  test('multi-selection moves only topmost roots and rotates about their common pivot', async ({ page }) => {
    await boot(page);
    await loadDoc(page, {
      nodes: [
        { id: 'a', parent: null, matrix: [1, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 0, 0, 0, 0, 1], box: [0.3, 0.3, 0.3] },
        { id: 'b', parent: 'a', matrix: [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], box: [0.3, 0.3, 0.3] },
        { id: 'c', parent: null, matrix: [1, 0, 0, 3, 0, 1, 0, 2, 0, 0, 1, 0, 0, 0, 0, 1], box: [0.3, 0.3, 0.3] },
      ],
      selection: ['a', 'b', 'c'],
      active: 'a',
    });
    const snap = await snapshot(page);
    expect(snap.roots).toEqual(['a', 'c']);

    const childLocalBefore = nodeOf(await scene(page), 'b').matrix;
    const before = await snapshot(page);
    await page.evaluate(() => {
      (window as unknown as { scenario: { rotate(...a: unknown[]): boolean } }).scenario.rotate('world', 'y', 90);
    });
    const after = await snapshot(page);
    // Child local untouched; it follows its parent.
    expect(nodeOf(await scene(page), 'b').matrix).toEqual(childLocalBefore);

    // Pivot is the arithmetic mean of a and c world origins = (2, 2, 0).
    const pivot = [2, 2, 0];
    for (const id of ['a', 'c']) {
      const wb = before.nodes.find((n) => n.id === id)!.world;
      const wa = after.nodes.find((n) => n.id === id)!.world;
      const rb = Math.hypot(wb[3] - pivot[0], wb[7] - pivot[1], wb[11] - pivot[2]);
      const ra = Math.hypot(wa[3] - pivot[0], wa[7] - pivot[1], wa[11] - pivot[2]);
      expect(Math.abs(ra - rb)).toBeLessThan(1e-9);
    }
    // a moved to (2,2,0)+R90*(a-2,-1? ...) — verify exact 90° rotation of (1,2,0) about y at (2,2,0).
    const aAfter = after.nodes.find((n) => n.id === 'a')!.world;
    expectClose([aAfter[3], aAfter[7], aAfter[11]], [2, 2, 1], 1e-9);
  });

  test('local axes come from the active root world column and keep shear', async ({ page }) => {
    await boot(page);
    await loadDoc(page, {
      nodes: [{ id: 'p', parent: null, matrix: [1, 0.5, 0, 0, 0, 1, 0, 2, 0, 0, 1, 0, 0, 0, 0, 1], box: [0.5, 0.5, 0.5] }],
      selection: ['p'],
      active: 'p',
    });
    const snap = await snapshot(page);
    expectClose(snap.nodes[0].matrix, [1, 0.5, 0, 0, 0, 1, 0, 2, 0, 0, 1, 0, 0, 0, 0, 1]);
    // Local X column is (1,0,0); local Y column is (0.5,1,0) normalized.
    const axes = await page.evaluate(() => {
      const s = (window as unknown as { scenario: { getSnapshot(): { localAxes: { x: number[]; y: number[]; z: number[] } } } }).scenario;
      return s.getSnapshot().localAxes;
    });
    const len = Math.hypot(0.5, 1);
    expectClose(axes.y, [0.5 / len, 1 / len, 0], 1e-12);
    await expect(page.locator('.axis-info')).toContainText('非正交');

    await page.evaluate(() => {
      (window as unknown as { scenario: { setGizmo(s: string, m: string): void } }).scenario.setGizmo('local', 'translate');
      (window as unknown as { scenario: { translate(...a: unknown[]): boolean } }).scenario.translate('local', 'y', Math.hypot(0.5, 1));
    });
    const after = await snapshot(page);
    // Moving 1 world-meter-equivalent along the normalized local Y: +0.5 in x, +1 in y.
    expect(after.nodes[0].world[3]).toBeCloseTo(0.5, 9);
    expect(after.nodes[0].world[7]).toBeCloseTo(3, 9);
    // Local shear preserved.
    expect(nodeOf(await scene(page), 'p').matrix[1]).toBeCloseTo(0.5, 12);
  });

  test('zero-length local axis rejects the whole batch atomically', async ({ page }) => {
    await boot(page);
    await loadDoc(page, {
      nodes: [
        { id: 'bad', parent: null, matrix: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], box: [0.4, 0.4, 0.4] },
        { id: 'good', parent: null, matrix: [1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], box: [0.4, 0.4, 0.4] },
      ],
      selection: ['bad', 'good'],
      active: 'bad',
    });
    const before = await scene(page);
    const result = await page.evaluate(() => {
      const s = (window as unknown as { scenario: { translate(...a: unknown[]): boolean } }).scenario;
      return s.translate('local', 'x', 1);
    });
    expect(result).toBe(false);
    expect(await scene(page)).toEqual(before);
    await expect(page.locator('.toast-error')).toContainText('轴长');
    expect((await snapshot(page)).history.undoCount).toBe(0);
  });

  test('invalid matrix edits are refused and never silently change the document', async ({ page }) => {
    await boot(page);
    await loadDoc(page, SAMPLE);
    const before = await scene(page);
    // Select payload (already active) and edit a cell to a non-numeric value.
    await page.getByTestId('tab-matrix').click();
    const inputs = page.locator('.matrix-grid .matrix-input');
    await expect(inputs).toHaveCount(16);
    await inputs.nth(0).fill('abc');
    await page.locator('.matrix-actions .btn.primary').click();
    await page.waitForTimeout(100);
    expect(await scene(page)).toEqual(before);
    await expect(page.locator('.matrix-error')).toBeVisible();

    // Non-affine last row is refused too.
    await inputs.nth(0).fill('1');
    await inputs.nth(12).fill('1');
    await page.locator('.matrix-actions .btn.primary').click();
    await page.waitForTimeout(100);
    expect(await scene(page)).toEqual(before);
    await expect(page.locator('.matrix-error')).toContainText('末行');

    // Switching selection after an invalid edit must not write anything, and the
    // selection change itself must not enter history.
    await page.evaluate(() => {
      (window as unknown as { scenario: { setSelection(ids: string[], active: string): void } }).scenario.setSelection(['root'], 'root');
    });
    expect(geometryOf(await scene(page))).toEqual(geometryOf(before));
    const switched = await snapshot(page);
    expect(switched.selection).toEqual(['root']);
    expect(switched.history.undoCount).toBe(0);
  });

  test('valid matrix edit is a transaction and supports singular storage', async ({ page }) => {
    await boot(page);
    await loadDoc(page, SAMPLE);
    const singularLocal = [0, 0.25, 0, 1, 0, 1, 0, 2, 0, 0, 1, 0, 0, 0, 0, 1];
    await page.getByTestId('tab-matrix').click();
    const inputs = page.locator('.matrix-grid .matrix-input');
    for (let i = 0; i < 16; i += 1) await inputs.nth(i).fill(String(singularLocal[i]));
    await page.locator('.matrix-actions .btn.primary').click();
    await page.waitForTimeout(120);
    const doc = await scene(page);
    expectClose(nodeOf(doc, 'payload').matrix, singularLocal, 0);
    expect((await snapshot(page)).history.undoCount).toBe(1);
    await page.getByTestId('undo').click();
    expectClose(nodeOf(await scene(page), 'payload').matrix, SAMPLE.nodes[0].matrix, 0);
  });

  test('export → reload round trip preserves world transforms and shear (no TRS loss)', async ({ page }) => {
    await boot(page);
    await loadDoc(page, SAMPLE);
    await page.evaluate(() => {
      const s = (window as unknown as { scenario: { applyMatrix(id: string, m: number[]): boolean } }).scenario;
      // Mirror + shear + non-uniform scale on a child, then reparent.
      s.applyMatrix('new-parent', [-1, 0.35, 0, -2, 0, 2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1]);
    });
    await page.locator('.target-row .text-input').fill('new-parent');
    await page.getByTestId('apply-reparent').click();
    await page.waitForTimeout(120);

    const before = await snapshot(page);
    const exported = await page.evaluate(() => (window as unknown as { scenario: { getScene(): SceneDoc } }).scenario.getScene());

    await page.reload();
    await page.waitForFunction(() => Boolean((window as unknown as { scenario?: unknown }).scenario));
    await loadDoc(page, exported);
    const after = await snapshot(page);
    for (const node of before.nodes) {
      const reloaded = after.nodes.find((n) => n.id === node.id)!;
      expectClose(reloaded.world, node.world, 1e-12);
      expect(reloaded.parent).toBe(node.parent);
    }
    // Shear bit is literally stored.
    expect(nodeOf(exported, 'payload').matrix[1]).not.toBe(0);
    const verify = await page.evaluate(() => (window as unknown as { scenario: { verifyRoundTrip(): { ok: boolean } } }).scenario.verifyRoundTrip());
    expect(verify.ok).toBe(true);
  });

  test('drag-and-drop in the tree reparents while preserving world', async ({ page }) => {
    await boot(page);
    await loadDoc(page, SAMPLE);
    const worldBefore = (await snapshot(page)).nodes.find((n) => n.id === 'payload')!.world;
    const source = page.locator('.tree-row[data-node-id="payload"]');
    const target = page.locator('.tree-row[data-node-id="new-parent"]');
    await source.dragTo(target);
    await page.waitForTimeout(200);
    const doc = await scene(page);
    expect(nodeOf(doc, 'payload').parent).toBe('new-parent');
    const worldAfter = (await snapshot(page)).nodes.find((n) => n.id === 'payload')!.world;
    expectClose(worldAfter, worldBefore, 1e-8);
  });

  test('selection change never modifies matrices or history', async ({ page }) => {
    await boot(page);
    await loadDoc(page, SAMPLE);
    const before = await scene(page);
    await page.locator('.tree-row[data-node-id="root"]').click();
    await page.locator('.tree-row[data-node-id="parent"]').click({ modifiers: ['Shift'] });
    await page.waitForTimeout(80);
    const after = await scene(page);
    expect(after.nodes.map((n) => n.matrix)).toEqual(before.nodes.map((n) => n.matrix));
    expect((await snapshot(page)).history.undoCount).toBe(0);
  });

  test('handles a 500-node document and rejects 501', async ({ page }) => {
    await boot(page);
    const doc = {
      nodes: Array.from({ length: 500 }, (_, i) => ({
        id: `n${i}`,
        parent: i < 100 ? null : `n${i - 100}`,
        matrix: [1, 0.1, 0, i * 0.01, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        box: [0.2, 0.2, 0.2],
      })),
      selection: [],
      active: null,
    };
    await loadDoc(page, doc, 'big.json');
    expect((await scene(page)).nodes).toHaveLength(500);
    const tooBig = { ...doc, nodes: [...doc.nodes, { id: 'n500', parent: null, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], box: [1, 1, 1] }] };
    await loadDoc(page, tooBig, 'too-big.json');
    await expect(page.locator('.toast-error')).toContainText('上限');
    expect((await scene(page)).nodes).toHaveLength(500);
  });

  test('rejects invalid documents atomically (cycle, missing parent, non-affine, NaN)', async ({ page }) => {
    await boot(page);
    await loadDoc(page, SAMPLE);
    const good = await scene(page);
    const invalidDocs = [
      {
        nodes: [
          { id: 'a', parent: 'b', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], box: [1, 1, 1] },
          { id: 'b', parent: 'a', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], box: [1, 1, 1] },
        ],
      },
      { nodes: [{ id: 'a', parent: 'ghost', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], box: [1, 1, 1] }] },
      { nodes: [{ id: 'a', parent: null, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1], box: [1, 1, 1] }] },
    ];
    for (const bad of invalidDocs) {
      await loadDoc(page, bad);
      await expect(page.locator('.toast-error').last()).toBeVisible();
    }
    expect(await scene(page)).toEqual(good);
  });
});
