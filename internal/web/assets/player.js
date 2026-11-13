// 播放页逻辑：拉取签名 master -> hls.js 播放 -> 自动/手动选档 -> 显示当前实际档位 -> 签名过期自动续签
(function () {
  "use strict";

  var video = document.getElementById("video");
  var levelSelect = document.getElementById("level-select");
  var currentLevelEl = document.getElementById("current-level");
  var messageEl = document.getElementById("player-message");
  var titleEl = document.getElementById("video-title");

  // 从 /play/?v=xxx 解析视频 ID
  var videoID = new URLSearchParams(window.location.search).get("v");
  if (!videoID) {
    showMessage("缺少视频 ID 参数，请从管理页进入播放。");
    return;
  }

  var hls = null;
  var manualMode = false; // 是否手动选档（用于区分"自动（720p）"与"手动 720p"的展示）
  var renewing = false;   // 续签流程互斥，避免并发重复 loadSource

  // 先取标题等基础信息
  fetch("/api/videos/" + encodeURIComponent(videoID))
    .then(function (r) {
      if (!r.ok) throw new Error("视频不存在或已删除");
      return r.json();
    })
    .then(function (data) {
      titleEl.textContent = data.video.title;
    })
    .catch(function (err) {
      titleEl.textContent = "培训视频";
      showMessage(err.message);
    });

  // 拉取带签名的 master playlist 地址
  function fetchPlayURL() {
    return fetch("/api/videos/" + encodeURIComponent(videoID) + "/play-url")
      .then(function (r) {
        if (!r.ok) return r.json().then(function (b) { throw new Error(b.error || "获取播放地址失败"); });
        return r.json();
      })
      .then(function (data) { return data.url; });
  }

  function showMessage(msg) {
    messageEl.textContent = msg || "";
  }

  // 档位名称：优先用分辨率高度，缺失时退回码率
  function levelName(level) {
    if (level.height) return level.height + "p";
    if (level.bitrate) return Math.round(level.bitrate / 1000) + "kbps";
    return "未知档位";
  }

  // 初始化播放器
  function startPlayer(url) {
    // 优先 hls.js：需求要求用它做 ABR 自动切换、手动选档与当前档显示，
    // 且 Chromium 内核即便 canPlayType 返回 maybe，原生 HLS 支持也不完整。
    // 仅当浏览器不支持 MSE（如 iOS Safari）时，才回退到原生 HLS。
    if (window.Hls && Hls.isSupported()) {
      startWithHlsJs(url);
      return;
    }
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      currentLevelEl.textContent = "当前播放：原生 HLS（清晰度由浏览器控制）";
      levelSelect.disabled = true;
      video.play().catch(function () { /* 自动播放被拦截时用户可手动点播放 */ });
      return;
    }
    showMessage("当前浏览器既不支持 MSE 也不支持原生 HLS，请换用新版 Edge/Chrome。");
  }

  // 使用 hls.js 启动：ABR、手动选档、当前档显示、签名过期续签都在这里实现
  function startWithHlsJs(url) {
    if (hls) {
      hls.destroy(); // 续签场景：销毁旧实例再重建
    }
    hls = new Hls({
      // 内网场景放宽分片加载超时，弱网外地同事更友好
      fragLoadingMaxRetry: 6,
      manifestLoadingMaxRetry: 4,
      levelLoadingMaxRetry: 4,
    });

    hls.loadSource(url);
    hls.attachMedia(video);

    // manifest 解析完成后填充清晰度下拉
    hls.on(Hls.Events.MANIFEST_PARSED, function (_evt, data) {
      // 保留"自动"选项，清空旧的具体档位
      levelSelect.options.length = 1;
      data.levels.forEach(function (level, idx) {
        var opt = document.createElement("option");
        opt.value = String(idx);
        opt.textContent = levelName(level);
        levelSelect.appendChild(opt);
      });
      levelSelect.value = "-1";
      manualMode = false;
      levelSelect.disabled = false;
      video.play().catch(function () { /* 自动播放被拦截时用户手动点播放 */ });
    });

    // 实际档位切换（ABR 自动切换或手动切换都会触发），据此显示当前真正在播的档位
    hls.on(Hls.Events.LEVEL_SWITCHED, function (_evt, data) {
      var level = hls.levels[data.level];
      var name = level ? levelName(level) : "未知";
      currentLevelEl.textContent = "当前播放：" + (manualMode ? "手动 " : "自动（") +
        name + (manualMode ? "" : "）");
    });

    // 致命错误处理：403/410（签名过期/篡改）时自动续签续播，其余错误尝试内置恢复
    hls.on(Hls.Events.ERROR, function (_evt, data) {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR &&
          data.response && (data.response.code === 403 || data.response.code === 410)) {
        renewAndResume();
        return;
      }
      // 其他网络错误先尝试 hls.js 内置恢复
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        showMessage("网络异常，尝试恢复播放……");
        hls.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        showMessage("播放发生致命错误，请刷新页面重试。");
      }
    });
  }

  // 签名过期后重新拉取 master 并恢复播放（尽量保持当前播放进度与选档模式）
  function renewAndResume() {
    if (renewing) return;
    renewing = true;
    showMessage("播放链接已过期，正在自动续签……");
    var resumePos = video.currentTime;
    fetchPlayURL()
      .then(function (url) {
        startPlayer(url);
        // 等 manifest 解析后跳回原进度并恢复选档模式
        hls.on(Hls.Events.MANIFEST_PARSED, function once() {
          hls.off(Hls.Events.MANIFEST_PARSED, once);
          if (resumePos > 0) {
            video.currentTime = resumePos;
          }
          if (manualMode && parseInt(levelSelect.value, 10) >= 0) {
            hls.currentLevel = parseInt(levelSelect.value, 10);
          }
          showMessage("");
          renewing = false;
        });
      })
      .catch(function (err) {
        renewing = false;
        showMessage("续签失败：" + err.message);
      });
  }

  // 手动选档：-1 交回 ABR 自动，>=0 锁定具体档位
  levelSelect.addEventListener("change", function () {
    if (!hls) return;
    var idx = parseInt(levelSelect.value, 10);
    if (idx < 0) {
      hls.currentLevel = -1; // hls.js 约定：-1 表示自动 ABR
      manualMode = false;
    } else {
      hls.currentLevel = idx;
      manualMode = true;
    }
  });

  // 启动：拉签名地址后开始播放
  fetchPlayURL()
    .then(startPlayer)
    .catch(function (err) {
      showMessage(err.message);
    });
})();
