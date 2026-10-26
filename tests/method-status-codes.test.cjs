const test = require('node:test');
const assert = require('node:assert/strict');
const statuses = require('../src/AutoCreatCode/WebEditor/method-status-codes.js');

test('normalizes unique integer statuses and always retains zero', () => {
  assert.deepEqual(statuses.normalizeResultStatusCodes('9, 1, 0, 1'), [0, 1, 9]);
  assert.deepEqual(statuses.normalizeResultStatusCodes('9, 1'), [0, 1, 9]);
});

test('adds a new state without duplicates and keeps zero locked', () => {
  assert.deepEqual(statuses.addResultStatusCode([0, 1], '9'), [0, 1, 9]);
  assert.deepEqual(statuses.addResultStatusCode([0, 1], '1'), [0, 1]);
  assert.deepEqual(statuses.removeResultStatusCode([0, 1], 0), [0, 1]);
});

test('rejects malformed or non-integer status values', () => {
  assert.throws(() => statuses.normalizeResultStatusCodes('0, ready'), /整数/);
});

test('blocks removing a status used by any node bound to the method', () => {
  const method = { MethodId: 'Move', SchemaVersion: 1, ResultStatusCodes: [0, 1, 9] };
  const workspace = { Flows: [{ Nodes: [{ NodeId: 'N3', MethodId: 'Move', MethodSchemaVersion: 1 }],
    Transitions: [{ FromNodeId: 'N3', Outcome: '9', ToNodeId: 'alarm' }] }] };
  assert.throws(() => statuses.validateResultStatusCodesChange(method, [0, 1], workspace), /N3.*9/);
});

test('keeps status codes used for pending or alarm classifications', () => {
  const method = { MethodId: 'Move', SchemaVersion: 1, ResultStatusCodes: [0, 1, 9], AlarmStatusCodes: [9] };
  assert.throws(() => statuses.validateResultStatusCodesChange(method, [0, 1], { Flows: [] }), /9.*报警/);
});

test('keeps a status used as a node-level pending code', () => {
  const method = { MethodId: 'Move', SchemaVersion: 1, ResultStatusCodes: [0, 1, 9] };
  const workspace = { Flows: [{ StationId: 'Task1', Nodes: [
    { NodeId: 'N3', MethodId: 'Move', MethodSchemaVersion: 1, PendingStatusCode: 1 },
  ], Transitions: [] }] };
  assert.throws(() => statuses.validateResultStatusCodesChange(method, [0, 9], workspace), /N3.*等待状态码.*1/);
});

test('allows removing an unused status and ignores wildcard transitions', () => {
  const method = { MethodId: 'Move', SchemaVersion: 1, ResultStatusCodes: [0, 1, 9] };
  const workspace = { Flows: [{ Nodes: [{ NodeId: 'N3', MethodId: 'Move', MethodSchemaVersion: 1 }],
    Transitions: [{ FromNodeId: 'N3', Outcome: '*', ToNodeId: 'end' }] }] };
  assert.deepEqual(statuses.validateResultStatusCodesChange(method, [1], workspace), [0, 1]);
});

