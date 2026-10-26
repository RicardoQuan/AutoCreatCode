const test = require('node:test');
const assert = require('node:assert/strict');
const canvas = require('../src/AutoCreatCode/WebEditor/canvas-interactions.js');

const node = (id, type = 'Action') => ({ NodeId: id, NodeType: type, DisplayName: id, MethodId: id });
const edge = (from, to, outcome = '*', extra = {}) => ({ FromNodeId: from, ToNodeId: to, Outcome: outcome, Priority: 1, ...extra });
const size = canvas.nodeSize;
const methodFor = item => ({ ReturnType: item.NodeType === 'Condition' ? 'bool' : item.NodeId === 'wait' ? 'int' : 'void',
  StatusCodes: item.NodeId === 'wait' ? ['1', '0', '9'] : [], AlarmStatusCodes: item.NodeId === 'wait' ? ['9'] : [] });
const centerX = (item, positions) => positions[item.NodeId].x + size(item).width / 2;

function assertClear(points, nodes, positions) {
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index];
    assert.ok(Math.abs(a.x - b.x) < .1 || Math.abs(a.y - b.y) < .1, 'every segment must be orthogonal');
    for (const item of nodes) {
      const p = positions[item.NodeId], dimensions = size(item);
      const overlaps = (left, right, min, max) => Math.min(Math.max(left, right), max) - Math.max(Math.min(left, right), min) > .1;
      const vertical = Math.abs(a.x - b.x) < .1 && a.x > p.x + .1 && a.x < p.x + dimensions.width - .1
        && overlaps(a.y, b.y, p.y + .1, p.y + dimensions.height - .1);
      const horizontal = Math.abs(a.y - b.y) < .1 && a.y > p.y + .1 && a.y < p.y + dimensions.height - .1
        && overlaps(a.x, b.x, p.x + .1, p.x + dimensions.width - .1);
      assert.equal(vertical || horizontal, false, `wire crosses node ${item.NodeId}`);
    }
  }
}

function assertSide(points, nodes, positions, side) {
  const limit = side === 'left' ? Math.min(...nodes.map(item => positions[item.NodeId].x))
    : Math.max(...nodes.map(item => positions[item.NodeId].x + size(item).width));
  assert.ok(points.some((point, index) => index && Math.abs(point.x - points[index - 1].x) < .1
    && Math.abs(point.y - points[index - 1].y) > 1
    && (side === 'left' ? point.x < limit : point.x > limit)), `expected a ${side} side lane`);
}

function fixture() {
  const nodes = [node('start', 'Start'), node('check', 'Condition'), node('wait'), node('get'), node('send'), node('alarm', 'Alarm'), node('end', 'End')];
  const transitions = [edge('start', 'check', 'Succeeded'), edge('check', 'wait', 'true'),
    edge('check', 'alarm', 'false', { CanvasSourcePort: 'e' }),
    edge('wait', 'wait', '1', { Priority: 1 }), edge('wait', 'get', '0', { Priority: 2, CanvasSourcePort: 'w', CanvasSourceRatio: .25 }),
    edge('wait', 'alarm', '9', { Priority: 3, CanvasSourcePort: 'w' }), edge('get', 'send'), edge('send', 'alarm'), edge('alarm', 'end')];
  return { graph: { EntryNodeId: 'wait', Nodes: nodes, Transitions: transitions }, positions: {} };
}

test('automatic self loops go left without passing through their node', () => {
  const nodes = [node('wait')], positions = { wait: { x: 220, y: 300 } };
  const points = canvas.routePoints(edge('wait', 'wait', '1'), nodes, positions);
  assertSide(points, nodes, positions, 'left');
  assertClear(points, nodes, positions);
});

test('upward returns use the left side and enter the earlier node pointing up', () => {
  const nodes = [node('upstream'), node('middle'), node('source')];
  const positions = { upstream: { x: 220, y: 100 }, middle: { x: 220, y: 300 }, source: { x: 220, y: 500 } };
  const points = canvas.routePoints(edge('source', 'upstream', '1', { CanvasTargetPort: 's' }), nodes, positions);
  assertSide(points, nodes, positions, 'left');
  assertClear(points, nodes, positions);
  assert.ok(points.at(-1).y < points.at(-2).y, 'return arrow must point upward');
});

test('a forward jump bypasses intervening process nodes on the right', () => {
  const nodes = [node('source'), node('middle'), node('target')];
  const positions = { source: { x: 220, y: 100 }, middle: { x: 220, y: 300 }, target: { x: 220, y: 500 } };
  const points = canvas.routePoints(edge('source', 'target', '9'), nodes, positions);
  assertSide(points, nodes, positions, 'right');
  assertClear(points, nodes, positions);
});

test('arranging the reported 1/0/9 case puts the loop left, main zero in the center, and jumps right', () => {
  const { graph, positions } = fixture();
  const transitions = graph.Transitions.slice(), semantics = transitions.map(({ FromNodeId, ToNodeId, Outcome, Priority }) => ({ FromNodeId, ToNodeId, Outcome, Priority }));
  canvas.arrangeDownward(graph, positions, methodFor);
  assert.deepEqual(graph.Transitions, transitions, 'all original transition objects remain present');
  assert.deepEqual(transitions.map(({ FromNodeId, ToNodeId, Outcome, Priority }) => ({ FromNodeId, ToNodeId, Outcome, Priority })), semantics);
  const routes = canvas.transitionRoutes(graph, positions);
  routes.forEach(route => assertClear(route.points, graph.Nodes, positions));
  const loop = routes.find(route => route.edge.FromNodeId === 'wait' && route.edge.Outcome === '1');
  assertSide(loop.points, graph.Nodes, positions, 'left');
  const main = routes.find(route => route.edge.FromNodeId === 'wait' && route.edge.Outcome === '0');
  const wait = graph.Nodes.find(item => item.NodeId === 'wait'), center = centerX(wait, positions);
  assert.equal(main.edge.CanvasSourcePort, 's');
  assert.equal(main.edge.CanvasSourceRatio, .5);
  assert.ok(main.points.every(point => Math.abs(point.x - center) < .1));
  assert.ok(main.points.every((point, index) => !index || point.y >= main.points[index - 1].y));
  for (const route of routes.filter(item => ['false', '9'].includes(item.edge.Outcome))) assertSide(route.points, graph.Nodes, positions, 'right');
});

test('main flow selection ignores a higher-priority return and prefers zero over another forward status', () => {
  const { graph, positions } = fixture();
  graph.Nodes.splice(4, 0, node('alternate'));
  graph.Transitions.push(edge('wait', 'alternate', '2', { Priority: 1 }), edge('alternate', 'alarm'));
  canvas.arrangeDownward(graph, positions, methodFor);
  const mainNodes = graph.Nodes.filter(item => ['start', 'check', 'wait', 'get', 'send', 'alarm', 'end'].includes(item.NodeId));
  const centers = mainNodes.map(item => centerX(item, positions));
  assert.ok(centers.every(value => value === centers[0]), 'the full success chain must share a centerline');
});

test('return branches to one upstream node merge on the left and never become a central direct edge', () => {
  const { graph, positions } = fixture();
  graph.Transitions.push(edge('get', 'wait', '1'), edge('send', 'wait', '1'));
  canvas.arrangeDownward(graph, positions, methodFor);
  const routes = canvas.transitionRoutes(graph, positions).filter(route => route.edge.ToNodeId === 'wait' && ['get', 'send'].includes(route.edge.FromNodeId));
  assert.equal(routes.length, 2);
  assert.ok(routes[0].mergeKey && routes[0].mergeKey === routes[1].mergeKey);
  assert.equal(routes[0].mergeLaneX, routes[1].mergeLaneX);
  routes.forEach(route => { assertSide(route.points, graph.Nodes, positions, 'left'); assertClear(route.points, graph.Nodes, positions); });
});

test('forward failure branches keep a common right trunk while the final process edge stays direct', () => {
  const { graph, positions } = fixture();
  canvas.arrangeDownward(graph, positions, methodFor);
  const routes = canvas.transitionRoutes(graph, positions);
  const failures = routes.filter(route => ['false', '9'].includes(route.edge.Outcome));
  assert.ok(failures[0].mergeKey && failures[0].mergeKey === failures[1].mergeKey);
  assert.equal(failures[0].mergeLaneX, failures[1].mergeLaneX);
  const final = routes.find(route => route.edge.FromNodeId === 'send');
  assert.ok(final.points.every(point => Math.abs(point.x - final.points[0].x) < .1));
});

test('arrange discards stale geometry, recenters targets, preserves explicit state values and is repeatable', () => {
  const { graph, positions } = fixture();
  for (const transition of graph.Transitions) Object.assign(transition, { CanvasTargetPort: 'e', CanvasTargetRatio: .1,
    CanvasWaypoints: [{ x: 1400, y: 1600 }], CanvasMergeWaypoints: [{ x: 1300, y: 1500 }], CanvasBendX: 1200, CanvasBendY: 1700, CanvasMergeLaneX: 1600 });
  canvas.arrangeDownward(graph, positions, methodFor);
  const first = JSON.stringify({ graph, positions });
  assert.ok(graph.Transitions.every(transition => !transition.CanvasWaypoints && !transition.CanvasMergeWaypoints && !Number.isFinite(transition.CanvasBendY)));
  canvas.arrangeDownward(graph, positions, methodFor);
  assert.equal(JSON.stringify({ graph, positions }), first);
  assert.equal(graph.Transitions.find(transition => transition.FromNodeId === 'check' && transition.ToNodeId === 'alarm').Outcome, 'false');
  canvas.transitionRoutes(graph, positions).forEach(route => assertClear(route.points, graph.Nodes, positions));
});

test('explicit manual waypoints continue to determine a route before arranging', () => {
  const nodes = [node('source'), node('target')], positions = { source: { x: 220, y: 100 }, target: { x: 220, y: 500 } };
  const points = canvas.routePoints(edge('source', 'target', '9', { CanvasWaypoints: [{ x: 800, y: 250, orientation: 'h' }] }), nodes, positions);
  assert.ok(points.some(point => point.x === 800 && point.y === 250));
});

test('side trunks bypass nodes in another column on the same row', () => {
  const nodes = [node('start', 'Start'), node('check', 'Condition'), node('a'), node('b'), node('c'), node('alarm', 'Alarm'), node('end', 'End')];
  const graph = { Nodes: nodes, Transitions: [edge('start', 'check', 'Succeeded'), edge('check', 'a', 'true'), edge('check', 'b', 'false'),
    edge('a', 'c', '0'), edge('a', 'alarm', '9'), edge('b', 'alarm'), edge('c', 'alarm'), edge('alarm', 'end')] };
  const positions = {};
  canvas.arrangeDownward(graph, positions, methodFor);
  assert.equal(positions.a.y, positions.b.y, 'fixture must place the branch beside the main node');
  canvas.transitionRoutes(graph, positions).forEach(route => assertClear(route.points, nodes, positions));
});

test('returning from a secondary column bypasses the other node in its row', () => {
  const nodes = [node('start', 'Start'), node('check', 'Condition'), node('a'), node('b'), node('alarm', 'Alarm'), node('end', 'End')];
  const graph = { Nodes: nodes, Transitions: [edge('start', 'check', 'Succeeded'), edge('check', 'a', 'true'), edge('check', 'b', 'false'),
    edge('a', 'alarm', '0'), edge('b', 'check', '1'), edge('b', 'alarm', '0'), edge('alarm', 'end')] };
  const positions = {};
  canvas.arrangeDownward(graph, positions, methodFor);
  assert.equal(positions.a.y, positions.b.y);
  canvas.transitionRoutes(graph, positions).forEach(route => assertClear(route.points, nodes, positions));
});

test('a centered zero return exits below its source before bypassing a taller neighbor', () => {
  const nodes = [node('start', 'Start'), node('check', 'Condition'), { ...node('tall'), CanvasHeight: 250 }, node('short'), node('alarm', 'Alarm'), node('end', 'End')];
  const graph = { Nodes: nodes, Transitions: [edge('start', 'check', 'Succeeded'), edge('check', 'tall', 'true'), edge('check', 'short', 'false'),
    edge('short', 'check', '0'), edge('short', 'alarm', '1'), edge('tall', 'alarm'), edge('alarm', 'end')] };
  const positions = {};
  canvas.arrangeDownward(graph, positions, methodFor);
  assert.equal(positions.tall.y, positions.short.y);
  const routes = canvas.transitionRoutes(graph, positions);
  const zero = routes.find(route => route.edge.FromNodeId === 'short' && route.edge.Outcome === '0');
  assert.equal(zero.edge.CanvasSourcePort, 's');
  assert.equal(zero.points[0].x, centerX(nodes.find(item => item.NodeId === 'short'), positions));
  routes.forEach(route => assertClear(route.points, nodes, positions));
});
