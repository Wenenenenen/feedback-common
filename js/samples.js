/*
 * samples.js — 内置样例，数据来源为样例包 resource-goap-planner-cases.zip，
 * 其 许可.txt 声明：合成素材与格式约定按 CC0-1.0 提供。
 */
(function (global) {
  'use strict';

  const samples = {
    demo: {
      initial: {
        facts: { access: true, tool: false, done: false },
        resources: { ore: 0 },
      },
      caps: { ore: 3 },
      goal: { facts: { done: true }, min: {}, max: {} },
      actions: [
        { id: 'gather', cost: 1, duration_ms: 100, pre: {}, min: {}, max: {}, add: [], remove: [], delta: { ore: 1 } },
        { id: 'craft', cost: 2, duration_ms: 100, pre: { access: true, tool: false }, min: { ore: 2 }, max: {}, add: ['tool'], remove: [], delta: { ore: -2 } },
        { id: 'buy', cost: 6, duration_ms: 100, pre: { tool: false }, min: {}, max: {}, add: ['tool'], remove: [], delta: {} },
        { id: 'deliver', cost: 1, duration_ms: 50, pre: { tool: true, done: false }, min: {}, max: {}, add: ['done'], remove: ['tool'], delta: {} },
      ],
      budget: 10000,
      events: [
        { t: 150, set_facts: { access: false }, set_resources: {} },
      ],
    },
    tie: {
      initial: { facts: { done: false }, resources: {} },
      caps: {},
      goal: { facts: { done: true } },
      actions: [
        { id: 'z', cost: 2, duration_ms: 10, pre: {}, min: {}, max: {}, add: ['done'], remove: [], delta: {} },
        { id: 'a', cost: 2, duration_ms: 10, pre: {}, min: {}, max: {}, add: ['done'], remove: [], delta: {} },
      ],
      budget: 20,
      events: [],
    },
    unreachable: {
      initial: {
        facts: { access: true, tool: false, done: false },
        resources: { ore: 0 },
      },
      caps: { ore: 3 },
      goal: { facts: { done: true }, min: {}, max: {} },
      actions: [
        { id: 'gather', cost: 1, duration_ms: 100, pre: {}, min: {}, max: {}, add: [], remove: [], delta: { ore: 1 } },
      ],
      budget: 10000,
      events: [],
    },
  };

  global.GOAPSamples = samples;
})(typeof globalThis !== 'undefined' ? globalThis : this);
