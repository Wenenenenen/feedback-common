/* 写入页逻辑：加载 WAV → 校验输入 → 嵌入水印 → 原/水印/差值三路试听与下载。 */
(function () {
  'use strict';
  var WM = globalThis.WM, App = globalThis.App, $ = App.$;
  var state = { wav: null, fileName: '', marked: null, result: null };

  var fileInput = $('#fileInput'), drop = $('#drop'), dropText = $('#dropText');
  var idInput = $('#assetId'), passInput = $('#passphrase'), alphaRange = $('#alpha'), alphaVal = $('#alphaVal');
  var idHint = $('#idHint'), passHint = $('#passHint'), runBtn = $('#runBtn'), metaBox = $('#metaBox');
  var players = $('#players'), dlWrap = $('#downloadWrap');

  alphaRange.addEventListener('input', function () {
    alphaVal.textContent = parseFloat(alphaRange.value).toFixed(3);
  });

  App.bindDrop(drop, fileInput, function (file) {
    App.readFileArrayBuffer(file).then(function (buf) {
      try {
        var wav = App.decodeWav(buf);
        if (wav.sampleRate !== WM.FS) throw new Error('采样率必须是 16000 Hz，当前为 ' + wav.sampleRate + ' Hz');
        state.wav = wav; state.fileName = file.name; state.marked = null;
        drop.classList.add('has');
        dropText.innerHTML = '已选择：<strong></strong>';
        $('#dropFileName').textContent = file.name;
        if (!dropText.querySelector('#dropFileName')) {
          dropText.innerHTML = '已选择：<strong id="dropFileName"></strong>';
          $('#dropFileName').textContent = file.name;
        }
        renderMeta(wav);
        resetOutputs();
        App.toast('WAV 载入成功');
      } catch (e) {
        App.toast(e.message, true);
      }
    }).catch(function () { App.toast('文件读取失败', true); });
  });

  function renderMeta(wav) {
    var dur = wav.length / wav.sampleRate;
    metaBox.innerHTML = '';
    [
      ['采样率', wav.sampleRate + ' Hz'],
      ['声道', wav.channels === 2 ? '立体声' : '单声道'],
      ['位深', wav.bitsPerSample + '-bit PCM'],
      ['时长', dur.toFixed(2) + ' s']
    ].forEach(function (kv) {
      metaBox.appendChild(App.el('div', { class: 'cell' }, [
        App.el('div', { class: 'k', text: kv[0] }),
        App.el('div', { class: 'v', text: kv[1] })
      ]));
    });
  }

  function resetOutputs() {
    players.innerHTML = '';
    dlWrap.innerHTML = '';
    state.marked = null; state.result = null;
  }

  function validate() {
    var ok = true;
    var id = idInput.value.trim();
    if (!App.validateHex8(id)) {
      idInput.classList.add('invalid'); idHint.classList.add('err');
      idHint.textContent = '请输入恰好 8 位十六进制字符（0-9，A-F）'; ok = false;
    } else { idInput.classList.remove('invalid'); idHint.classList.remove('err'); idHint.textContent = '示例：1A2B3C4D'; }
    if (!passInput.value) {
      passInput.classList.add('invalid'); passHint.classList.add('err');
      passHint.textContent = '口令用于派生扩频密钥与校验和，必填'; ok = false;
    } else { passInput.classList.remove('invalid'); passHint.classList.remove('err'); passHint.textContent = '同一口令才能在验证页读出编号'; }
    if (!state.wav) { App.toast('请先选择 WAV 文件', true); ok = false; }
    return ok;
  }

  runBtn.addEventListener('click', function () {
    if (!validate()) return;
    runBtn.disabled = true;
    runBtn.innerHTML = '<span class="spin"></span> 正在嵌入…';
    setTimeout(function () {
      try {
        var id = idInput.value.trim().toUpperCase();
        var alpha = parseFloat(alphaRange.value);
        var res = WM.embed(state.wav, id, passInput.value, { alpha: alpha });
        var markedWav = {
          sampleRate: state.wav.sampleRate, channels: state.wav.channels,
          length: state.wav.length, samples: res.samples
        };
        state.marked = markedWav; state.result = res;
        renderPlayers(id);
        runBtn.disabled = false; runBtn.textContent = '重新嵌入水印';
        App.toast('水印嵌入完成，可试听或下载');
      } catch (e) {
        runBtn.disabled = false; runBtn.textContent = '嵌入水印';
        App.toast(e.message, true);
      }
    }, 30);
  });

  function makePlayer(title, samples, sampleRate, note) {
    var buf = App.encodeWav(samples, sampleRate);
    var url = App.objectUrl(App.wavBlob(buf));
    var block = App.el('div', { class: 'player-block' }, [
      App.el('div', { class: 'cap' }, [
        App.el('span', { text: title }),
        note ? App.el('span', { class: 'muted', text: note }) : App.el('span')
      ]),
      App.el('audio', { controls: '', preload: 'none' })
    ]);
    block.querySelector('audio').src = url;
    return { node: block, buffer: buf, url: url };
  }

  function renderPlayers(id) {
    players.innerHTML = ''; dlWrap.innerHTML = '';
    var sr = state.wav.sampleRate;
    var p1 = makePlayer('① 原始音频', state.wav.samples, sr);
    var p2 = makePlayer('② 含水印音频（写入后）', state.marked.samples, sr,
      '编号 ' + id + ' · α=' + state.result.alpha.toFixed(3));
    var diff = App.differenceSamples(state.wav.samples, state.marked.samples);
    var gain = 12;
    var diffLoud = diff.map(function (ch) {
      var y = new Float32Array(ch.length);
      for (var i = 0; i < ch.length; i++) { var v = ch[i] * gain; y[i] = v > 1 ? 1 : (v < -1 ? -1 : v); }
      return y;
    });
    var p3 = makePlayer('③ 差异信号（已放大 ' + gain + '× 便于监听）', diffLoud, sr,
      '残差 RMS=' + App.rms(diff[0]).toFixed(5));

    [p1, p2, p3].forEach(function (p) { players.appendChild(p.node); });

    var outBuf = App.encodeWav(state.marked.samples, sr);
    var base = (state.fileName || 'audio').replace(/\.wav$/i, '');
    var dlName = base + '_wm_' + id + '.wav';
    var dlBtn = App.el('button', { class: 'primary', style: 'margin-top:14px;', text: '下载含水印 WAV（' + dlName + '）' });
    dlBtn.addEventListener('click', function () {
      var a = document.createElement('a');
      a.href = App.objectUrl(App.wavBlob(outBuf));
      a.download = dlName;
      a.click();
    });
    dlWrap.appendChild(dlBtn);

    var info = App.el('div', { class: 'hint', style: 'margin-top:10px;' }, []);
    info.innerHTML = '声道数、采样点数、采样率与原文件完全一致；仅修改样本幅度，未改任何 WAV 结构。';
    dlWrap.appendChild(info);
  }
})();
