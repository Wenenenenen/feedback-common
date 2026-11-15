// 应用状态、校验、配置序列化。所有异步流程携带 revision，过期结果不得回写。
(function (global) {
  'use strict';

  function deepClone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function createState() {
    return {
      revision: 0,                 // 每次已提交变更递增
      surface: [256, 128],
      feather: 24,
      imageName: '',
      image: null,                 // HTMLImageElement | ImageBitmap
      imageSize: null,            // [w, h]
      imageToken: 0,              // 图像异步加载代际
      projectors: [],
      notice: { type: '', text: '' }
    };
  }

  function bump(state) {
    state.revision += 1;
    return state.revision;
  }

  function setNotice(state, type, text) {
    state.notice = { type, text };
  }

  // 尝试替换某投影的四角；非法时保留原有效校正，返回是否成功
  function tryUpdateQuad(state, index, candidate) {
    const v = Geo.validateQuad(candidate);
    const proj = state.projectors[index];
    if (!v.ok) {
      proj.pendingQuad = deepClone(candidate);
      proj.invalidReason = v.reason;
      return false;
    }
    proj.quad = deepClone(candidate);
    proj.pendingQuad = null;
    proj.invalidReason = '';
    bump(state);
    return true;
  }

  function setFeather(state, value) {
    if (!Number.isFinite(value) || value <= 0) return false;
    state.feather = value;
    bump(state);
    return true;
  }

  function setSurfaceSize(state, w, h) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return false;
    state.surface = [w, h];
    bump(state);
    return true;
  }

  function setProjectorSize(state, index, w, h) {
    const p = state.projectors[index];
    if (!p || !Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return false;
    p.size = [w, h];
    bump(state);
    return true;
  }

  function setProjectorId(state, index, id) {
    const trimmed = String(id).trim();
    if (!trimmed) return false;
    if (state.projectors.some((p, i) => i !== index && p.id === trimmed)) return false;
    state.projectors[index].id = trimmed;
    bump(state);
    return true;
  }

  // 由配置 JSON 构建状态（图像需另行载入）
  function stateFromConfig(cfg) {
    if (!cfg || !Array.isArray(cfg.surface) || cfg.surface.length !== 2 ||
        !Array.isArray(cfg.projectors) || cfg.projectors.length === 0) {
      throw new Error('配置格式无效：缺少 surface 或 projectors');
    }
    const state = createState();
    state.surface = [cfg.surface[0], cfg.surface[1]];
    state.feather = Number(cfg.feather) || 0;
    if (!(state.feather > 0)) throw new Error('feather 必须为正数');
    state.imageName = typeof cfg.image === 'string' ? cfg.image : '';
    state.projectors = cfg.projectors.map((p, i) => {
      if (!Array.isArray(p.quad) || p.quad.length !== 4 ||
          !Array.isArray(p.size) || p.size.length !== 2) {
        throw new Error('投影 ' + i + ' 配置不完整');
      }
      const quad = p.quad.map((q) => [Number(q[0]), Number(q[1])]);
      const v = Geo.validateQuad(quad);
      return {
        id: String(p.id != null ? p.id : 'projector-' + (i + 1)),
        size: [p.size[0], p.size[1]],
        quad,
        pendingQuad: null,
        invalidReason: v.ok ? '' : v.reason
      };
    });
    bump(state);
    return state;
  }

  function toConfig(state) {
    return {
      surface: [state.surface[0], state.surface[1]],
      image: state.imageName,
      feather: state.feather,
      projectors: state.projectors.map((p) => ({
        id: p.id,
        size: [p.size[0], p.size[1]],
        // 导出已提交的有效四角（pending 的非法值不导出）
        quad: deepClone(p.quad)
      }))
    };
  }

  global.AppState = {
    createState,
    bump,
    setNotice,
    tryUpdateQuad,
    setFeather,
    setSurfaceSize,
    setProjectorSize,
    setProjectorId,
    stateFromConfig,
    toConfig,
    deepClone
  };
})(typeof window !== 'undefined' ? window : globalThis);
