/* 验证页逻辑：加载待查 WAV + 口令 → 盲验 → 展示编号、信号位置与逐项证据；不足报未检出。 */
(function () {
  'use strict';
  var WM = globalThis.WM, App = globalThis.App, $ = App.$;
  var state = { wav: null, fileName: '' };

  var fileInput = $('#fileInput'), drop = $('#drop'), dropText = $('#dropText');
  var passInput = $('#passphrase'), passHint = $('#passHint'), runBtn = $('#runBtn');
  var resultBox = $('#resultBox'), metaBox = $('#metaBox');

  App.bindDrop(drop, fileInput, function (file) {
    App.readFileArrayBuffer(file).then(function (buf) {
      try {
        var wav = App.decodeWav(buf);
        if (wav.sampleRate !== WM.FS) throw new Error('采样率必须是 16000 Hz，当前为 ' + wav.sampleRate + ' Hz');
        state.wav = wav; state.fileName = file.name;
        drop.classList.add('has');
        dropText.innerHTML = '已选择：<strong id="dropFileName"></strong>';
        $('#dropFileName').textContent = file.name;
        renderMeta(wav);
        resultBox.innerHTML = '<p class="muted">填入口令后点击「开始盲验」。验证页不需要原始音频，也不需要编号。</p>';
        App.toast('待查 WAV 载入成功');
      } catch (e) { App.toast(e.message, true); }
    }).catch(function () { App.toast('文件读取失败', true); });
  });

  function renderMeta(wav) {
    metaBox.innerHTML = '';
    [
      ['采样率', wav.sampleRate + ' Hz'],
      ['声道', wav.channels === 2 ? '立体声（将下混检测）' : '单声道'],
      ['位深', wav.bitsPerSample + '-bit PCM'],
      ['时长', (wav.length / wav.sampleRate).toFixed(2) + ' s']
    ].forEach(function (kv) {
      metaBox.appendChild(App.el('div', { class: 'cell' }, [
        App.el('div', { class: 'k', text: kv[0] }),
        App.el('div', { class: 'v', text: kv[1], style: 'font-size:13px;' })
      ]));
    });
  }

  runBtn.addEventListener('click', function () {
    if (!state.wav) { App.toast('请先选择待查 WAV', true); return; }
    if (!passInput.value) {
      passInput.classList.add('invalid'); passHint.classList.add('err');
      passHint.textContent = '验证必须提供嵌入时使用的口令'; return;
    }
    passInput.classList.remove('invalid'); passHint.classList.remove('err');
    runBtn.disabled = true; runBtn.innerHTML = '<span class="spin"></span> 正在同步与校验…';
    setTimeout(function () {
      try {
        var rep = WM.verify(state.wav, passInput.value);
        renderReport(rep);
      } catch (e) {
        resultBox.innerHTML = '';
        resultBox.appendChild(App.el('div', { class: 'badge bad', text: '无法检测：' + e.message }));
      } finally {
        runBtn.disabled = false; runBtn.textContent = '开始盲验';
      }
    }, 30);
  });

  function row(check) {
    return App.el('tr', {}, [
      App.el('td', {}, [App.el('span', { class: check.pass ? 'pass-dot' : 'fail-dot', text: check.pass ? '✓ 通过' : '✗ 未过' })]),
      App.el('td', { text: check.name }),
      App.el('td', { class: 'num', text: check.value }),
      App.el('td', { class: 'num muted', text: String(check.threshold) })
    ]);
  }

  function renderReport(rep) {
    resultBox.innerHTML = '';
    if (rep.detected) {
      var head = App.el('div', {}, [
        App.el('span', { class: 'badge good', text: '● 检出水印，校验通过' })
      ]);
      resultBox.appendChild(head);
      resultBox.appendChild(App.el('div', { class: 'id-big', text: rep.idHex }));
      resultBox.appendChild(App.el('div', { class: 'hint', text: '8 位十六进制素材编号' }));

      var kv = App.el('div', { class: 'kv', style: 'margin:18px 0 6px;' }, [
        App.el('div', { class: 'k', text: '信号首次同步位置' }),
        App.el('div', { class: 'v', text: App.fmtSec(rep.position.firstSyncSec) + '（片段内偏移 ' + rep.position.firstSyncSample + ' 样本）' }),
        App.el('div', { class: 'k', text: '水印信号覆盖跨度' }),
        App.el('div', { class: 'v', text: App.fmtSec(rep.position.spanSec) }),
        App.el('div', { class: 'k', text: '参与积累的完整块' }),
        App.el('div', { class: 'v', text: rep.blocksCovered + ' 块（每块 63 符号 ≈ 1.008 s）' }),
        App.el('div', { class: 'k', text: '各块起始时间' }),
        App.el('div', { class: 'v', text: rep.position.blockStartSec.map(function (s) { return s.toFixed(3); }).join(' s, ') + ' s' })
      ]);
      resultBox.appendChild(kv);

      var table = App.el('table', { class: 'checks' }, [
        App.el('thead', {}, App.el('tr', {}, [
          App.el('th', { text: '结果' }), App.el('th', { text: '证据项' }),
          App.el('th', { text: '实测值' }), App.el('th', { text: '门限/期望' })
        ]))
      ]);
      var tb = App.el('tbody');
      rep.checks.forEach(function (c) { tb.appendChild(row(c)); });
      table.appendChild(tb);
      resultBox.appendChild(table);
      resultBox.appendChild(App.el('p', { class: 'hint', style: 'margin-top:12px;' }, []));
      resultBox.lastChild.innerHTML = '通过校验意味着：同步锁定、信号强度显著高于裸宿主、覆盖足够块、' +
        '且 32 位编号附带的 16 位口令派生 CRC 完全一致。';
    } else {
      var reasons = {
        'no-signal': '未检出可靠水印信号：信号强度未超过裸宿主底噪门限',
        'no-sync': '未检出：找不到满足门限的同步峰',
        'crc-failed': '检出疑似信号但载荷校验未通过，编号不可采信',
        'insufficient-evidence': '证据不足：同步或判决裕量未达门限',
        'too-short': '片段过短，不足以容纳一个完整水印块'
      };
      resultBox.appendChild(App.el('span', { class: 'badge bad', text: '● 未检出' }));
      resultBox.appendChild(App.el('p', { style: 'margin:14px 0 6px;font-size:15px;', text: reasons[rep.reason] || '证据不足，报告未检出' }));

      if (rep.checks && rep.checks.length) {
        var table2 = App.el('table', { class: 'checks' }, [
          App.el('thead', {}, App.el('tr', {}, [
            App.el('th', { text: '结果' }), App.el('th', { text: '证据项' }),
            App.el('th', { text: '实测值' }), App.el('th', { text: '门限/期望' })
          ]))
        ]);
        var tb2 = App.el('tbody');
        rep.checks.forEach(function (c) { tb2.appendChild(row(c)); });
        table2.appendChild(tb2);
        resultBox.appendChild(table2);
      }
      if (rep.diagnostics) {
        var d = rep.diagnostics;
        resultBox.appendChild(App.el('div', { class: 'card', style: 'margin-top:14px;background:var(--panel-2);box-shadow:none;' }, [
          App.el('div', { class: 'hint err', style: 'margin-bottom:8px;', text: d.note }),
          App.el('div', { class: 'kv' }, [
            App.el('div', { class: 'k', text: '候选编号（未采信）' }),
            App.el('div', { class: 'v', text: d.candidateHex }),
            App.el('div', { class: 'k', text: '候选校验和' }),
            App.el('div', { class: 'v', text: d.candidateCheck }),
            App.el('div', { class: 'k', text: '口令派生期望校验和' }),
            App.el('div', { class: 'v', text: d.expectedCheck })
          ])
        ]));
      }
      resultBox.appendChild(App.el('p', { class: 'hint', style: 'margin-top:12px;' },
        '提示：确认口令正确、片段长度 ≥6 秒、未经过有损压缩或重采样（本方案面向 16kHz/16bit PCM）。'));
    }
  }
})();
