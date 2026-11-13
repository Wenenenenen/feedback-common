// 管理页逻辑：上传（带进度）、视频列表轮询、失败重试、删除
(function () {
  "use strict";

  var POLL_INTERVAL = 1500; // 与后端轮询节奏保持一致
  var pollTimer = null;

  var form = document.getElementById("upload-form");
  var fileInput = document.getElementById("file-input");
  var fileName = document.getElementById("file-name");
  var titleInput = document.getElementById("title-input");
  var uploadBtn = document.getElementById("upload-btn");
  var uploadProgressWrap = document.getElementById("upload-progress-wrap");
  var uploadProgress = document.getElementById("upload-progress");
  var uploadProgressText = document.getElementById("upload-progress-text");
  var uploadError = document.getElementById("upload-error");
  var listEl = document.getElementById("video-list");
  var refreshBtn = document.getElementById("refresh-btn");

  // 选择文件后展示文件名
  fileInput.addEventListener("change", function () {
    fileName.textContent = fileInput.files.length ? fileInput.files[0].name : "选择视频文件（mp4/mov/mkv/ts/flv）";
  });

  // 上传提交：用 XHR 以便拿到 upload.progress 事件
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    uploadError.textContent = "";
    if (!fileInput.files.length) {
      uploadError.textContent = "请先选择视频文件";
      return;
    }
    var fd = new FormData();
    fd.append("file", fileInput.files[0]);
    if (titleInput.value.trim()) {
      fd.append("title", titleInput.value.trim());
    }

    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/videos");
    uploadBtn.disabled = true;
    uploadProgressWrap.classList.remove("hidden");
    setUploadProgress(0);

    xhr.upload.addEventListener("progress", function (ev) {
      if (ev.lengthComputable) {
        setUploadProgress(Math.round((ev.loaded / ev.total) * 100));
      }
    });
    xhr.addEventListener("load", function () {
      uploadBtn.disabled = false;
      if (xhr.status >= 200 && xhr.status < 300) {
        form.reset();
        fileName.textContent = "选择视频文件（mp4/mov/mkv/ts/flv）";
        uploadProgressWrap.classList.add("hidden");
        refreshList(); // 立刻刷新，不必等下一个轮询周期
      } else {
        uploadError.textContent = parseError(xhr);
      }
    });
    xhr.addEventListener("error", function () {
      uploadBtn.disabled = false;
      uploadError.textContent = "网络错误，上传失败";
    });
    xhr.send(fd);
  });

  refreshBtn.addEventListener("click", refreshList);

  function setUploadProgress(pct) {
    uploadProgress.style.width = pct + "%";
    uploadProgressText.textContent = pct + "%";
  }

  function parseError(xhr) {
    try {
      var body = JSON.parse(xhr.responseText);
      return body.error || ("请求失败：" + xhr.status);
    } catch (e) {
      return "请求失败：" + xhr.status;
    }
  }

  // 拉取并渲染视频列表
  function refreshList() {
    fetch("/api/videos")
      .then(function (resp) {
        if (!resp.ok) throw new Error("列表加载失败 " + resp.status);
        return resp.json();
      })
      .then(function (data) {
        render(data.videos || []);
      })
      .catch(function (err) {
        listEl.innerHTML = '<p class="error-text">' + escapeHTML(err.message) + "</p>";
      });
  }

  function render(videos) {
    if (!videos.length) {
      listEl.innerHTML = '<p class="hint">还没有视频，上传第一个试试吧。</p>';
      return;
    }
    var html = videos.map(function (v) {
      var ladder = parseLadder(v.ladder_json);
      var tags = ladder.map(function (r) {
        return '<span class="ladder-tag">' + r.height + "p</span>";
      }).join("");
      var meta = [
        v.width + "×" + v.height,
        formatDuration(v.duration_ms),
        formatBitrate(v.src_total_br),
        formatTime(v.created_at),
      ].join("");
      var statusText = statusLabel(v.status);
      var body =
        '<div class="video-item" data-id="' + v.id + '">' +
        '<div class="video-title">' + escapeHTML(v.title) + "</div>" +
        '<div class="video-meta"><span>' + meta + "</span></div>" +
        '<div><span class="status-badge status-' + v.status + '">' + statusText + "</span></div>" +
        (tags ? '<div class="ladder-tags">' + tags + "</div>" : "") +
        renderJobProgress(v) +
        renderError(v) +
        '<div class="video-actions">' +
        (v.status === "ready"
          ? '<a href="/play/?v=' + encodeURIComponent(v.id) + '" target="_blank">播放</a>'
          : "") +
        (v.status === "failed"
          ? '<button type="button" class="btn-secondary act-retry">重试转码</button>'
          : "") +
        '<button type="button" class="btn-secondary btn-danger act-delete">删除</button>' +
        "</div></div>";
      return body;
    }).join("");
    listEl.innerHTML = html;

    // 绑定卡片内按钮事件
    listEl.querySelectorAll(".video-item").forEach(function (card) {
      var id = card.getAttribute("data-id");
      var retryBtn = card.querySelector(".act-retry");
      var deleteBtn = card.querySelector(".act-delete");
      if (retryBtn) {
        retryBtn.addEventListener("click", function () { retry(id, retryBtn); });
      }
      if (deleteBtn) {
        deleteBtn.addEventListener("click", function () { remove(id, deleteBtn); });
      }
    });
  }

  // 转码中展示任务进度条，其余状态不展示
  function renderJobProgress(v) {
    if (v.status !== "transcoding" && v.job_status !== "processing") {
      return "";
    }
    var pct = Math.max(0, Math.min(99, parseInt(v.job_progress, 10) || 0));
    return (
      '<div class="progress-wrap">' +
      '<div class="progress-bar"><div class="progress-inner" style="width:' + pct + '%"></div></div>' +
      "<span>" + pct + "%</span></div>"
    );
  }

  function renderError(v) {
    var msg = v.job_error || v.error || "";
    if (!msg || v.status === "ready") return "";
    return '<div class="job-error">' + escapeHTML(msg) + "</div>";
  }

  function retry(id, btn) {
    btn.disabled = true;
    fetch("/api/videos/" + encodeURIComponent(id) + "/retry", { method: "POST" })
      .then(function (resp) {
        if (!resp.ok) return resp.json().then(function (b) { throw new Error(b.error); });
        refreshList();
      })
      .catch(function (err) {
        alert("重试失败：" + err.message);
        btn.disabled = false;
      });
  }

  function remove(id, btn) {
    if (!window.confirm("确认删除该视频？源文件与转码产物都会被清理，且不可恢复。")) return;
    btn.disabled = true;
    fetch("/api/videos/" + encodeURIComponent(id), { method: "DELETE" })
      .then(function (resp) {
        if (!resp.ok) return resp.json().then(function (b) { throw new Error(b.error); });
        refreshList();
      })
      .catch(function (err) {
        alert("删除失败：" + err.message);
        btn.disabled = false;
      });
  }

  function parseLadder(raw) {
    try { return JSON.parse(raw || "[]"); } catch (e) { return []; }
  }

  function statusLabel(status) {
    return {
      uploaded: "排队中",
      transcoding: "转码中",
      ready: "可播放",
      failed: "转码失败",
    }[status] || status;
  }

  function formatDuration(ms) {
    if (!ms) return "时长未知";
    var sec = Math.round(ms / 1000);
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return "时长 " + m + ":" + (s < 10 ? "0" : "") + s;
  }

  function formatBitrate(bps) {
    if (!bps) return "码率未知";
    return "码率 " + (bps / 1_000_000).toFixed(2) + " Mbps";
  }

  function formatTime(unix) {
    if (!unix) return "";
    var d = new Date(unix * 1000);
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  // 防 XSS：所有来自后端的文本插入 HTML 前转义
  function escapeHTML(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // 启动定时轮询，页面隐藏时浏览器会自动降频，无需额外处理
  refreshList();
  pollTimer = setInterval(refreshList, POLL_INTERVAL);
})();
