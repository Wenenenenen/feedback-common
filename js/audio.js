/*!
 * Sample-accurate-ish playback for the reel. The AudioBuffer is filled from the
 * exact same interleaved Int16 samples that go into the exported WAV, so what
 * is auditioned as the selection is the exported selection slice.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PDQAudio = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function Player() {
    this.ctx = null;
    this.source = null;
    this.gain = null;
    this.playing = false;
    this.onEnded = null;
    this.onTime = null;
    this._raf = 0;
    this._startedAt = 0;
    this._offset = 0;
    this._duration = 0;
  }

  Player.prototype._ensureCtx = function () {
    if (!this.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      // Ask for 48 kHz; if unavailable the platform/resampler handles it.
      try { this.ctx = new AC({ sampleRate: 48000 }); }
      catch (e) { this.ctx = new AC(); }
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0.9;
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  };

  // interleaved: Int16Array frames*channels for the desired [f0,f1) slice.
  Player.prototype.playInterleaved = function (interleaved, channels, sampleRate) {
    var ctx = this._ensureCtx();
    this.stop();
    sampleRate = sampleRate || 48000;
    var frames = interleaved.length / channels;
    var buf = ctx.createBuffer(channels, frames, sampleRate);
    for (var c = 0; c < channels; c++) {
      var data = buf.getChannelData(c);
      for (var f = 0; f < frames; f++) data[f] = interleaved[f * channels + c] / 32768;
    }
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    var self = this;
    src.onended = function () {
      if (self.source === src) {
        self.playing = false;
        self._stopRaf();
        if (self.onEnded) self.onEnded();
      }
    };
    src.start(0);
    this.source = src;
    this.playing = true;
    this._duration = frames / sampleRate;
    this._startedAt = ctx.currentTime;
    this._offset = 0;
    this._tick();
  };

  Player.prototype._tick = function () {
    var self = this;
    function loop() {
      if (!self.playing || !self.ctx) return;
      var t = self._offset + (self.ctx.currentTime - self._startedAt);
      if (self.onTime) self.onTime(Math.min(t, self._duration));
      self._raf = requestAnimationFrame(loop);
    }
    this._raf = requestAnimationFrame(loop);
  };
  Player.prototype._stopRaf = function () { if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; };

  Player.prototype.stop = function () {
    this._stopRaf();
    if (this.source) {
      try { this.source.onended = null; this.source.stop(); } catch (e) { /* already stopped */ }
      try { this.source.disconnect(); } catch (e) {}
      this.source = null;
    }
    this.playing = false;
  };

  return { Player: Player };
});
