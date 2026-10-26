# 方法输出状态码编辑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users add, edit, and remove `int` method result codes from both the method editor and a bound node while keeping every node and the exported C# metadata consistent.

**Architecture:** Add a small pure helper for status-code normalization and deletion safety, plus a C# catalog operation that rewrites status metadata without changing method bodies or unrelated attributes. Reuse the same status list UI in the method editor and node inspector; both update the shared method definition. A new status becomes an output port, and the existing transition editor maps it to a target.

**Tech Stack:** Browser JavaScript, DOM templates in `editor.js`, CSS in `editor.css`, the existing C# tokenizer/parser in `csharp-catalog.js`, and Node's built-in test runner.

---

## File map

- Create `src/AutoCreatCode/WebEditor/method-status-codes.js`: pure integer-list normalization and validation that prevents removing a status still used by a bound node.
- Modify `src/AutoCreatCode/WebEditor/index.html`: load the helper and replace the method editor's raw status input with the shared editable list container.
- Modify `src/AutoCreatCode/WebEditor/editor.js`: render and wire the shared editor in the method library dialog and node inspector; persist changes to the shared method, update source metadata, refresh all users, and retain the existing missing-transition checks.
- Modify `src/AutoCreatCode/WebEditor/editor.css`: style status chips, add control, and the required `0` item.
- Modify `src/AutoCreatCode/WebEditor/csharp-catalog.js`: update `FlowStatusCodes` or the status argument on `FlowMethod` in a method source while preserving other attributes and the body.
- Create `tests/method-status-codes.test.cjs`: exercise normalization, the required `0`, and shared-use deletion protection.
- Create `tests/csharp-catalog-status-codes.test.cjs`: exercise metadata update and parse round-trip while checking unrelated attributes and method body remain unchanged.
- Modify `CHANGELOG.md`: record this feature under the current unreleased section.
- Synchronize the verified web-editor files to the canonical `WebEditor` folder and publish the source change on GitHub `main`, matching the established browser-first workflow.

## Task 1: Add tested status-code contract helpers

**Files:**
- Create: `tests/method-status-codes.test.cjs`
- Create: `src/AutoCreatCode/WebEditor/method-status-codes.js`

- [x] **Step 1: Write the failing tests**

```js
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

test('allows removing an unused status and ignores wildcard transitions', () => {
  const method = { MethodId: 'Move', SchemaVersion: 1, ResultStatusCodes: [0, 1, 9] };
  const workspace = { Flows: [{ Nodes: [{ NodeId: 'N3', MethodId: 'Move', MethodSchemaVersion: 1 }],
    Transitions: [{ FromNodeId: 'N3', Outcome: '*', ToNodeId: 'end' }] }] };
  assert.deepEqual(statuses.validateResultStatusCodesChange(method, [1], workspace), [0, 1]);
});
```

- [x] **Step 2: Run the new test and confirm it fails because the helper module is not present**

Run: `node tests/method-status-codes.test.cjs`

Expected: module-not-found failure for `method-status-codes.js`.

- [x] **Step 3: Implement only the helper API used by the tests**

```js
function normalizeResultStatusCodes(input) {
  const tokens = Array.isArray(input) ? input : String(input ?? '').split(/[\s,，;；]+/u).filter(Boolean);
  const values = tokens.map(value => {
    const token = String(value).trim();
    if (!/^-?\d+$/u.test(token)) throw new Error('int 返回状态码必须是整数。');
    const number = Number(token);
    if (!Number.isSafeInteger(number)) throw new Error('int 返回状态码超出整数范围。');
    return number;
  });
  return [...new Set([0, ...values])].sort((left, right) => left - right);
}

function validateResultStatusCodesChange(method, values, workspace) {
  const next = normalizeResultStatusCodes(values);
  const removed = new Set((method.ResultStatusCodes || []).map(Number).filter(value => !next.includes(value)).map(String));
  for (const [label, codes] of [['等待', method.PendingStatusCodes], ['报警', method.AlarmStatusCodes]]) {
    for (const code of codes || []) if (removed.has(String(code))) throw new Error(`${code} 是${label}状态码，不能删除。`);
  }
  for (const flow of workspace.Flows || []) for (const node of flow.Nodes || []) {
    if ((method.TaskId && method.TaskId !== flow.StationId) || (method.StationId && method.StationId !== flow.StationId)) continue;
    if (node.MethodId !== method.MethodId || Number(node.MethodSchemaVersion || 0) !== Number(method.SchemaVersion || 0)) continue;
    const hasScope = Object.prototype.hasOwnProperty.call(node, 'MethodMachineName')
      || Object.prototype.hasOwnProperty.call(node, 'MethodStationId');
    if (hasScope && (String(node.MethodMachineName || '') !== String(method.MachineName || '')
      || String(node.MethodStationId || '') !== String(method.StationId || ''))) continue;
    for (const edge of (flow.Transitions || []).filter(item => item.FromNodeId === node.NodeId)) {
      if (removed.has(String(edge.Outcome))) throw new Error(`${node.NodeId} 的输出分支 ${edge.Outcome} 仍在使用，先处理该连线。`);
    }
  }
  return next;
}

function addResultStatusCode(values, value) {
  return normalizeResultStatusCodes([...normalizeResultStatusCodes(values), value]);
}

function removeResultStatusCode(values, value) {
  const code = Number(value);
  if (!Number.isSafeInteger(code) || code === 0) return normalizeResultStatusCodes(values);
  return normalizeResultStatusCodes(values).filter(item => item !== code);
}

const api = { normalizeResultStatusCodes, validateResultStatusCodesChange, addResultStatusCode, removeResultStatusCode };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.EquipmentFlowMethodStatuses = api;
```

- [x] **Step 4: Run the new test to verify the helper passes**

Run: `node tests/method-status-codes.test.cjs`

Expected: all normalization, required-zero, and deletion-guard tests pass.

## Task 2: Keep C# method metadata consistent

**Files:**
- Create: `tests/csharp-catalog-status-codes.test.cjs`
- Modify: `src/AutoCreatCode/WebEditor/csharp-catalog.js`

- [x] **Step 1: Write tests for standalone and combined metadata attributes**

Add this test file:

```js
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
```

- [x] **Step 2: Run the test and confirm the missing updater API fails**

Run: `node tests/csharp-catalog-status-codes.test.cjs`

Expected: TypeError because `updateResultStatusCodes` is not exported yet.

- [x] **Step 3: Implement `updateResultStatusCodes(source, methodName, codes)` in `csharp-catalog.js`**

Make `updateResultStatusCodes(source, methodName, codes)` accept both a complete C# file and the method-only `SourceCode` used by the editor. If `parseSource(source)` finds no class method, wrap the fragment in `public partial class __StatusEditor {\n...\n}` and track the prefix length so the wrapper can be removed from the returned text. Require exactly one matching method; throw `未找到方法 ...` or `方法 ... 不唯一` otherwise. Rewrite its `AttributeSource` using `tokenize`, `createPairs`, and `splitTopLevel`, so parentheses, braces, commas inside arrays, strings, and other attributes remain balanced. For each `[FlowStatusCodes(...)]`, replace the argument span with `codes.join(', ')`. For `FlowMethod`, replace an existing `StatusCodes = ...` or `ResultStatusCodes = ...` expression with `new int[] { ${codes.join(', ')} }`. Apply span replacements from right to left. If neither form exists, prepend `[FlowStatusCodes(${codes.join(', ')})]` to the method declaration. Reparse the returned source (wrapping the fragment again when needed) and require its `ResultStatusCodes` to equal `codes`; otherwise throw `无法同步方法返回状态码元数据。` Export the helper through the existing `api` object and CommonJS.

- [x] **Step 4: Run the metadata tests and verify parse round-trip**

Run: `node tests/csharp-catalog-status-codes.test.cjs`

Expected: all metadata rewrite tests pass and `parseSource` returns the new status list.

## Task 3: Add the reusable status editor to the method library

**Files:**
- Modify: `src/AutoCreatCode/WebEditor/index.html`
- Modify: `src/AutoCreatCode/WebEditor/editor.js`
- Modify: `src/AutoCreatCode/WebEditor/editor.css`

- [x] **Step 1: Add the status editor markup and styling**

Replace the method editor field with:

```html
<div class="field method-status-field" id="methodStatusField">
  <span>int 返回状态码</span>
  <div id="methodStatusEditor" class="status-code-editor" data-status-editor="method"></div>
  <input id="methodStatusCodesInput" type="hidden" value="0, 1">
</div>
```

The shared renderer outputs chips with `data-remove-status="<code>"` for removable states and a `0` chip without a remove button, followed by an integer input and `添加状态` button. Node rendering places the same renderer below method binding help. Keep the method field visible only for `int`; keep the node field out of unbound, bool, and other return type inspectors. Add `.status-code-list`, `.status-code-chip`, `.status-code-required`, and `.status-code-add` styles beside the existing method form and inspector styles.

Add `<script src="method-status-codes.js"></script>` after `method-library.js` and before `editor.js` in `index.html`.

- [x] **Step 2: Wire method editor list state and save validation**

Initialize chips from `method.ResultStatusCodes` in `openMethodDialog`; after every add/remove, write the comma-separated list to `#methodStatusCodesInput` so `methodDialogSnapshot` and the existing unsaved-change prompt remain accurate. On save, call `validateResultStatusCodesChange(method, parsedCodes, state.workspace)`, assign the returned list to `ResultStatusCodes` and stringified `Outcomes`, and preserve the existing `PendingStatusCodes` / `AlarmStatusCodes` arrays. Before assigning `SourceCode`, call `EquipmentFlowCSharpCatalog.updateResultStatusCodes(sourceCode, name, statuses)`, then reparse it with `parseMethodCodeEditor` so `AttributeSource` and `BodyText` match the saved source.

- [x] **Step 3: Verify method library editing and serialization**

Use the browser UI to edit `0, 1, 9` to `0, 1, 2`, save the method, and confirm the method card and exported method-library manifest show `0, 1, 2`. Reparse the updated method `.cs` source with `EquipmentFlowCSharpCatalog.parseSource` and confirm the same values.

## Task 4: Edit the shared status contract from a flow node

**Files:**
- Modify: `src/AutoCreatCode/WebEditor/editor.js`
- Modify: `src/AutoCreatCode/WebEditor/editor.css`

- [x] **Step 1: Render editable statuses for bound `int` methods**

Replace the read-only status help text in `renderInspector` with the shared chip editor for `int` methods. Keep the explanatory text for `bool` and non-integer return types. Do not show status editing on unbound or non-executable nodes.

- [x] **Step 2: Apply node edits to the same method object**

On add/remove, read the hidden canonical list, call `validateResultStatusCodesChange(method, parsedCodes, state.workspace)`, and pass the returned list to the shared method-status update routine. That routine assigns `ResultStatusCodes` and `Outcomes`, updates the selected method's `SourceCode` / `AttributeSource` through the catalog helper, then calls `renderAll`, `updateWorkspaceHeader`, and `persistProjectDraft`. Do not change any existing Transition's outcome, target, priority, or route geometry. On validation failure, keep the prior list and show the helper's message with `setStatus(message, 'error')`.

- [x] **Step 3: Verify other method users and route creation**

In the browser, bind the same method to two nodes. Add status `2` from one node and verify both nodes and the method card show `0, 1, 2`. Add its output branch on the edited node and verify the new port, selected default target, and canvas line appear. Confirm the other node's missing branch is reported until mapped.

## Task 5: Verify editing guards, document, and synchronize source

**Files:**
- Modify: `CHANGELOG.md`
- Synchronize modified web-editor files to `D:\codex\00_项目开发\BZProject_V6X-0810Test-2\5_Tasks\00_ProcessData\EquipmentFlow\WebEditor`
- Publish changed source and documentation to GitHub repository `RicardoQuan/AutoCreatCode`, branch `main`.

- [x] **Step 1: Verify deletion guards and zero behavior**

In the browser, attempt to remove `0` and confirm it remains locked. Attempt to remove `9` while a matching bound node has a `9` Transition and confirm a message appears with the node ID and state, with all data unchanged. Remove or remap the edge, then remove `9` and confirm the change succeeds.

- [x] **Step 2: Run the two focused test files**

Run: `node tests/method-status-codes.test.cjs`; expected: all normalization and deletion guard cases pass.

Run: `node tests/csharp-catalog-status-codes.test.cjs`; expected: all C# metadata round-trip cases pass.

- [x] **Step 3: Check JavaScript syntax**

Run: `node --check src/AutoCreatCode/WebEditor/method-status-codes.js` and `node --check src/AutoCreatCode/WebEditor/editor.js` and `node --check src/AutoCreatCode/WebEditor/csharp-catalog.js`.

Expected: each command exits with code 0 and prints no diagnostics.

- [x] **Step 4: Document the feature**

Add an unreleased changelog entry describing editable shared integer result codes, required `0`, C# metadata synchronization, and guarded removal of connected states.

- [x] **Step 5: Synchronize canonical files and publish source**

Confirm each canonical target exists and its current hash matches the staged baseline before copying. Copy only modified `WebEditor` files, compare hashes after copying, and publish the matching changed source, tests, spec, plan, and changelog to GitHub `main`. Do not create a new installer release for this source-only update.

## Self-review against the spec

- The method dialog and node inspector both edit the same `ResultStatusCodes` via Tasks 3 and 4.
- `0`, `bool true/false`, addition, duplicate/invalid input, and method/node pending and alarm classification preservation are covered in Tasks 1 and 3.
- Shared-node effects and branch deletion safety are covered in Tasks 1, 4, and 5.
- C# metadata persistence and round-trip are covered in Task 2 and browser checks in Task 3.
- Existing transitions and route geometry are explicitly preserved in Task 4.
- In an isolated Edge page, adding status `4` from the second bound node updated the method card and both nodes; removing connected status `4` was blocked with the node and outcome named. The user's open project was not changed.
- Changelog, canonical source synchronization, and GitHub publication are included in Task 5.

