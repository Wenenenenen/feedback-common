/*
 * Material sources: wrap a ZIP archive or a dropped folder so the rest of
 * the app can locate project.json and read frame images by name, whether
 * the archive is flat or has everything nested under one top-level folder.
 */
(function (global) {
  'use strict';
  var VCC = global.VCC = global.VCC || {};

  function normalizePath(p) {
    return p.replace(/\\/g, '/').replace(/^\.?\//, '');
  }

  function ZipSource(zip) {
    this.kind = 'zip';
    this.zip = zip;
    this.files = new Map();
    var self = this;
    var names = zip.list();
    var projectEntry = names.find(function (nm) { return /(^|\/)project\.json$/i.test(nm); });
    if (!projectEntry) throw new Error('素材包里没有 project.json');
    this.prefix = projectEntry.slice(0, projectEntry.length - 'project.json'.length);
    names.forEach(function (nm) {
      self.files.set(nm, nm);
    });
    this.projectPath = projectEntry;
  }

  ZipSource.prototype.resolve = function (name) {
    var norm = normalizePath(name);
    var candidates = [this.prefix + norm, norm];
    for (var i = 0; i < candidates.length; i++) {
      if (this.files.has(candidates[i])) return candidates[i];
    }
    // fall back to a basename match anywhere in the archive
    var base = norm.split('/').pop();
    var hit = null;
    this.files.forEach(function (v, k) { if (!hit && k.split('/').pop() === base) hit = k; });
    return hit;
  };

  ZipSource.prototype.readFile = function (name) {
    var path = this.resolve(name);
    if (!path) return Promise.reject(new Error('素材包内缺少图片 ' + name));
    return this.zip.read(path).then(function (bytes) {
      var copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      return new Blob([copy.buffer]);
    });
  };

  ZipSource.prototype.readProject = function () {
    var self = this;
    return this.zip.read(this.projectPath).then(function (bytes) {
      return JSON.parse(new TextDecoder('utf-8').decode(bytes));
    });
  };

  // Folder source (webkitdirectory or drop). File.webkitRelativePath keeps
  // the folder structure, so the same prefix logic applies.
  function FolderSource(fileList) {
    this.kind = 'folder';
    this.files = new Map();
    var projectEntry = null;
    var self = this;
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var rel = normalizePath(f.webkitRelativePath || f.name);
      self.files.set(rel, f);
      if (!projectEntry && /(^|\/)project\.json$/i.test(rel)) projectEntry = rel;
    }
    if (!projectEntry) throw new Error('文件夹里没有 project.json');
    this.prefix = projectEntry.slice(0, projectEntry.length - 'project.json'.length);
    this.projectPath = projectEntry;
  }

  FolderSource.prototype.resolve = function (name) {
    var norm = normalizePath(name);
    var candidates = [this.prefix + norm, norm];
    for (var i = 0; i < candidates.length; i++) if (this.files.has(candidates[i])) return candidates[i];
    var base = norm.split('/').pop();
    var hit = null;
    this.files.forEach(function (v, k) { if (!hit && k.split('/').pop() === base) hit = k; });
    return hit;
  };

  FolderSource.prototype.readFile = function (name) {
    var path = this.resolve(name);
    if (!path) return Promise.reject(new Error('文件夹内缺少图片 ' + name));
    return Promise.resolve(this.files.get(path));
  };

  FolderSource.prototype.readProject = function () {
    var f = this.files.get(this.projectPath);
    return f.text().then(function (t) { return JSON.parse(t); });
  };

  function sourceFromZipBuffer(arrayBuffer) {
    return new ZipSource(new VCC.ZipArchive(arrayBuffer));
  }

  VCC.ZipSource = ZipSource;
  VCC.FolderSource = FolderSource;
  VCC.sourceFromZipBuffer = sourceFromZipBuffer;
})(typeof self !== 'undefined' ? self : window);
