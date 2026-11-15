// settings.js — export/import of the reproducible render settings.
//
// The exported JSON carries everything needed to reproduce a frame from the
// same data set: camera, step, mode, window, transfer function, image size,
// opacity reference, plus a fingerprint of the volume so a mismatched file
// is reported instead of silently drawing something else.

import {
  normalizeTransferFunction, presetView, orbitView, clamp, vnorm,
  DEFAULT_TF, DEFAULT_WINDOW, DEFAULT_REF_MM, STEP_MIN, STEP_MAX,
  IMAGE_MIN, IMAGE_MAX, VIEW_NAMES, fnv1aHex,
} from './core.js';

export const SETTINGS_SCHEMA = 'voxel-ray-workbench/settings/1';

/** Deterministic fingerprint of the decoded data + its geometry. */
export function volumeFingerprint(volume) {
  const parts = [
    volume.dims.join(','),
    volume.spacing.join(','),
    volume.dataType,
  ];
  return {
    dimensions: volume.dims.slice(),
    spacing: volume.spacing.slice(),
    dataType: volume.dataType,
    voxelCount: volume.voxelCount,
    valuesFnv1a: fnv1aHex(new Uint8Array(volume.values.buffer, volume.values.byteOffset, volume.values.byteLength)),
    geometryKey: parts.join('|'),
  };
}

/** Build the exported settings object from the live state. */
export function makeSettings(state) {
  const { volume, view, mode, step, tf, window: win, imageSize, refMm, sourceName } = state;
  // imageSize may be a single integer (square frame) or a [w, h] pair.
  const size = Array.isArray(imageSize) ? imageSize.slice() : [imageSize, imageSize];
  return {
    schema: SETTINGS_SCHEMA,
    units: 'mm',
    exportedAt: new Date().toISOString(),
    data: {
      sourceName: sourceName || null,
      dimensions: volume.dims.slice(),
      spacing: volume.spacing.slice(),
      voxelType: volume.dataType,
      extentMm: volume.ext.slice(),
      fingerprint: volumeFingerprint(volume),
    },
    view: {
      dir: view.dir.map(round6),
      up: view.up.map(round6),
      zoom: round6(view.zoom),
      pan: (view.pan || [0, 0]).map(round6),
      preset: view.preset || null,
    },
    mode,
    step,
    imageSize: size,
    window: win.slice(),
    transferFunction: tf.map((s) => ({ value: s.value, rgb: s.rgb.map(round6), alpha: round6(s.alpha) })),
    opacityReferenceMm: refMm,
    conventions: {
      units: 'mm',
      layout: 'x-fastest',
      voxelCentres: '(index + 0.5) * spacing',
      alphaPerMm: '1 - (1 - alpha)^(segmentLength / opacityReferenceMm)',
      output: 'straight alpha, sRGB colour',
    },
  };
}

function round6(x) { return Math.round(Number(x) * 1e6) / 1e6; }

/**
 * Validate an imported settings object against a loaded volume.
 * Returns { ok, errors, warnings, settings } with `settings` normalised.
 */
export function parseSettings(input, volume) {
  const errors = [];
  const warnings = [];
  const fail = () => ({ ok: false, errors, warnings, settings: null });

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    errors.push('设置文件必须是 JSON 对象');
    return fail();
  }
  if (input.schema !== undefined && input.schema !== SETTINGS_SCHEMA) {
    warnings.push(`设置文件 schema=${JSON.stringify(input.schema)}，按当前版本读取`);
  }

  // --- data fingerprint (only checked when a data block is present)
  if (input.data && typeof input.data === 'object' && volume) {
    const fp = input.data.fingerprint;
    if (fp && typeof fp === 'object') {
      const cur = volumeFingerprint(volume);
      if (Array.isArray(fp.dimensions) && fp.dimensions.join(',') !== cur.dimensions.join(',')) {
        errors.push(`设置对应的数据尺寸为 ${fp.dimensions.join('×')}，当前为 ${cur.dimensions.join('×')}`);
      }
      if (fp.valuesFnv1a && fp.valuesFnv1a !== cur.valuesFnv1a) {
        warnings.push('设置文件的数据指纹与当前数据不同（可能是同一尺寸的另一份数据）');
      }
    }
  }

  // --- camera
  let view = null;
  const v = input.view;
  if (typeof v === 'string') {
    // Shorthand used by the sample settings: a named axis preset.
    if (VIEW_NAMES.includes(v)) {
      view = presetView(v);
    } else {
      errors.push(`view=${JSON.stringify(v)} 不是轴向预设（${VIEW_NAMES.join(' / ')}）`);
    }
  } else if (!v || typeof v !== 'object') {
    errors.push('缺少 view 相机设置');
  } else {
    const dir = Array.isArray(v.dir) && v.dir.length === 3 ? v.dir.map(Number) : null;
    const up = Array.isArray(v.up) && v.up.length === 3 ? v.up.map(Number) : null;
    if (!dir || !dir.every(Number.isFinite) || Math.hypot(...dir) < 1e-9) {
      errors.push('view.dir 必须是长度非零的三维数值');
    } else if (!up || !up.every(Number.isFinite) || Math.hypot(...up) < 1e-9) {
      errors.push('view.up 必须是长度非零的三维数值');
    } else {
      const d = vnorm(dir);
      let u = vnorm(up);
      // orthogonalise up against dir so a hand-edited file still loads
      const k = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
      const ortho = [u[0] - d[0] * k, u[1] - d[1] * k, u[2] - d[2] * k];
      if (Math.hypot(...ortho) < 1e-9) {
        errors.push('view.up 与 view.dir 平行，无法确定视图朝向');
      } else {
        u = vnorm(ortho);
        if (Math.abs(k) > 1e-6) warnings.push('view.up 已对 view.dir 正交化');
        const zoom = Number(v.zoom);
        const pan = Array.isArray(v.pan) && v.pan.length === 2 && v.pan.every((p) => Number.isFinite(Number(p)))
          ? v.pan.map(Number)
          : [0, 0];
        view = {
          dir: d,
          up: u,
          zoom: Number.isFinite(zoom) && zoom > 0 ? clamp(zoom, 0.05, 50) : 1,
          pan,
          preset: typeof v.preset === 'string' && VIEW_NAMES.includes(v.preset) ? v.preset : null,
        };
        if (!Number.isFinite(zoom) || zoom <= 0) warnings.push('view.zoom 无效，已重置为 1');
      }
    }
  }

  // --- mode
  let mode = input.mode;
  if (mode !== 'composite' && mode !== 'mip') {
    errors.push(`mode=${JSON.stringify(input.mode)} 无效（须为 "composite" 或 "mip"）`);
    mode = 'composite';
  }

  // --- step
  const step = Number(input.step);
  if (!Number.isFinite(step) || step <= 0) {
    errors.push(`step=${JSON.stringify(input.step)} 无效`);
  } else if (step < STEP_MIN || step > STEP_MAX) {
    errors.push(`step=${step} 超出允许范围 ${STEP_MIN}..${STEP_MAX} mm`);
  }

  // --- image size: a single integer means a square frame
  let size = null;
  if (Number.isInteger(input.imageSize) && input.imageSize >= IMAGE_MIN && input.imageSize <= IMAGE_MAX) {
    size = [input.imageSize, input.imageSize];
  } else if (Array.isArray(input.imageSize) && input.imageSize.length === 2) {
    const pair = input.imageSize.map(Number);
    if (pair.every((n) => Number.isInteger(n) && n >= IMAGE_MIN && n <= IMAGE_MAX)) size = pair;
  }
  if (!size) {
    errors.push(`imageSize=${JSON.stringify(input.imageSize)} 无效（须为 ${IMAGE_MIN}..${IMAGE_MAX} 的整数，或两个整数）`);
  }

  // --- window: a bare number means [0, v]
  let win = null;
  if (Number.isFinite(Number(input.window)) && typeof input.window === 'number') {
    win = [0, Number(input.window)];
  } else if (Array.isArray(input.window) && input.window.length === 2) {
    win = input.window.map(Number);
  }
  if (!win || !win.every(Number.isFinite) || !(win[1] > win[0])) {
    errors.push(`window=${JSON.stringify(input.window)} 无效（须为两个有限数值且上界大于下界）`);
    win = null;
  }

  // --- transfer function
  const tfRes = normalizeTransferFunction(input.transferFunction);
  for (const e of tfRes.errors) errors.push(e);
  for (const w of tfRes.warnings) warnings.push(w);

  // --- opacity reference
  const ref = input.opacityReferenceMm === undefined ? DEFAULT_REF_MM : Number(input.opacityReferenceMm);
  if (!Number.isFinite(ref) || ref <= 0) errors.push(`opacityReferenceMm=${JSON.stringify(input.opacityReferenceMm)} 无效`);

  if (errors.length > 0) return fail();

  return {
    ok: true,
    errors: [],
    warnings,
    settings: {
      view,
      mode,
      step,
      imageSize: size,
      window: win,
      transferFunction: tfRes.tf,
      opacityReferenceMm: ref,
    },
  };
}

/** Human-readable one-line summary for the status bar. */
export function describeSettings(s) {
  const tfCount = s.transferFunction.length;
  return `${s.mode === 'mip' ? '最大值投影' : '前向合成'} · 步长 ${s.step} mm · ${s.imageSize.join('×')} · 窗 ${s.window.join('–')} · ${tfCount} 个传递函数点`;
}

export { VIEW_NAMES, presetView, orbitView, DEFAULT_TF, DEFAULT_WINDOW, DEFAULT_REF_MM };
