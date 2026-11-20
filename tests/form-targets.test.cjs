'use strict';
// S07：表单字段 → UI 根图 widget 映射（子图同号节点不串写；共享子图不单独编辑）。
const test = require('node:test');
const assert = require('node:assert/strict');
const {mapFormTargets} = require('../shared/form-targets.cjs');

const ui = {
  nodes: [{id: 3, type: 'KSampler'}, {id: 10, type: 'sg-a'}, {id: 11, type: 'sg-b'}, {id: 12, type: 'sg-b'}],
  definitions: {subgraphs: [{id: 'sg-a', nodes: [{id: 3, type: 'CLIPTextEncode'}]}, {id: 'sg-b', nodes: [{id: 3, type: 'KSampler'}]}]},
};
test('S07：根图与子图同号节点分别映射；共享子图与类型变化标出', () => {
  const r = mapFormTargets([
    {nodeId: '3', nodeType: 'KSampler', fieldName: 'steps'},
    {nodeId: '10:3', nodeType: 'CLIPTextEncode', fieldName: 'text'},
    {nodeId: '11:3', nodeType: 'KSampler', fieldName: 'steps'},
    {nodeId: '10:3', nodeType: 'KSampler', fieldName: 'steps'},
    {nodeId: '99', fieldName: 'x'},
  ], ui);
  assert.deepEqual(r[0].target, {graphId: null, nodeId: 3, widgetName: 'steps'});
  assert.deepEqual(r[1].target, {graphId: 'sg-a', nodeId: 3, widgetName: 'text'});
  assert.equal(r[2].status, 'shared');
  assert.equal(r[3].status, 'type');
  assert.equal(r[4].status, 'missing');
});
