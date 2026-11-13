'use strict';
// R19：批量原子规划。
const test = require('node:test');
const assert = require('node:assert/strict');
const {planBatch} = require('../shared/batch-plan.cjs');
const bindings = {steps: {type: 'int', min: 1, max: 150, label: '步数'}, cfg: {type: 'float', min: 0, max: 30}, sampler: {type: 'enum', options: ['euler', 'dpmpp_2m']}};

test('R19：提示词×seed×参数 完整展开', () => {
  const r = planBatch({prompts: ['a', 'b'], seeds: [1, 2], variations: {steps: [20, '30'], sampler: ['euler', 'dpmpp_2m']}}, bindings);
  assert.ok(r.ok); assert.equal(r.total, 16); assert.equal(r.items.length, 16);
  assert.deepEqual(r.items[1], {prompt: 'a', seed: 1, values: {steps: 20, sampler: 'dpmpp_2m'}});
  assert.equal(r.items.filter(i => i.values.steps === 30).length, 8);
});
test('R19：后项无效 → 整体拒绝，不返回部分计划', () => {
  const r = planBatch({seeds: [1], variations: {steps: [20, 30, NaN, 200], cfg: [7.5, 'x'], sampler: ['bad']}}, bindings);
  assert.equal(r.ok, false); assert.equal(r.items, undefined);
  assert.deepEqual(r.errors.map(e => e.field + (e.index ?? '')), ['steps2', 'steps3', 'cfg1', 'sampler0']);
  assert.equal(planBatch({variations: {steps: [1.5]}}, bindings).ok, false);
});
test('R19：空列表、映射失效、超限、非法 seed/数量', () => {
  assert.equal(planBatch({prompts: []}).ok, false);
  assert.equal(planBatch({variations: {steps: []}}, bindings).ok, false);
  assert.match(planBatch({variations: {gone: [1]}}, bindings).errors[0].message, /映射已失效/);
  const big = planBatch({count: 11, variations: {steps: Array.from({length: 10}, (_, i) => i + 1)}}, bindings);
  assert.equal(big.ok, false); assert.equal(big.total, 110);
  assert.equal(planBatch({seeds: [-1]}).ok, false);
  assert.equal(planBatch({count: 0}).ok, false);
  assert.deepEqual(planBatch({count: 3, seedStart: 5}).items.map(i => i.seed), [5, 6, 7]);
});
