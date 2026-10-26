const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../src/AutoCreatCode/WebEditor/csharp-catalog.js');

function onlyMethod(source) {
  const wrapped = `public partial class TestMethods {\n${source}\n}`;
  return catalog.parseSource(wrapped, 'Methods.cs').classes.flatMap(item => item.methods)
    .find(item => item.MethodName === 'Move');
}

test('updates FlowStatusCodes while preserving other attributes and the body', () => {
  const source = '[Obsolete]\n[FlowMethodId("Move")]\n[FlowStatusCodes(0, 1, 9)]\npublic int Move() { return 9; }';
  const updated = catalog.updateResultStatusCodes(source, 'Move', [0, 2]);
  assert.deepEqual(onlyMethod(updated).ResultStatusCodes, [0, 2]);
  assert.match(updated, /\[Obsolete\]/u);
  assert.match(updated, /return 9;/u);
});

test('updates status arrays inside a FlowMethod attribute', () => {
  const source = '[FlowMethod("Move", StatusCodes = new int[] { 0, 1, 9 })]\npublic int Move() { return 9; }';
  const updated = catalog.updateResultStatusCodes(source, 'Move', [0, 2]);
  assert.deepEqual(onlyMethod(updated).ResultStatusCodes, [0, 2]);
  assert.match(updated, /StatusCodes\s*=\s*new int\[\]\s*\{\s*0,\s*2\s*\}/u);
  assert.match(updated, /return 9;/u);
});

test('adds FlowStatusCodes when a method has no status metadata yet', () => {
  const source = '/// <summary>Move.</summary>\npublic int Move() { return 0; }';
  const updated = catalog.updateResultStatusCodes(source, 'Move', [0, 2]);
  assert.deepEqual(onlyMethod(updated).ResultStatusCodes, [0, 2]);
  assert.match(updated, /\[FlowStatusCodes\(0, 2\)\]/u);
  assert.match(updated, /<summary>Move\.<\/summary>/u);
  assert.match(updated, /return 0;/u);
});

