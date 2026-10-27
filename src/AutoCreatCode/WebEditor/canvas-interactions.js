(() => {
  'use strict';
  const host = typeof window !== 'undefined' ? window : globalThis;
  const clone = value => JSON.parse(JSON.stringify(value));
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const NS = 'http://www.w3.org/2000/svg';
  const GRID_STEP = 20;

  function appendOrthogonal(points, from, to, orientation) {
    const elbow = orientation === 'h' ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
    if (Math.abs(elbow.x - from.x) + Math.abs(elbow.y - from.y) > 0.01) points.push(elbow);
    if (Math.abs(to.x - elbow.x) + Math.abs(to.y - elbow.y) > 0.01) points.push(to);
  }

  function tailFromVertical(points, x, y) {
    for (let index = 0; index < points.length - 1; index++) {
      const from = points[index], to = points[index + 1];
      if (Math.abs(from.x - x) > .1 || Math.abs(to.x - x) > .1
        || y < Math.min(from.y, to.y) - .1 || y > Math.max(from.y, to.y) + .1) continue;
      const tail = [{ x, y }];
      if (Math.hypot(to.x - x, to.y - y) > .1) tail.push({ x: to.x, y: to.y });
      points.slice(index + 2).forEach(point => {
        const previous = tail[tail.length - 1];
        if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) > .1)
          tail.push({ x: point.x, y: point.y });
      });
      return tail;
    }
    return null;
  }

  function directJoinOnRoute(points, x, preferredY) {
    const targetLead = points[points.length - 2];
    const makeJoin = (first, last) => {
      const top = Math.min(points[first].y, points[last].y), bottom = Math.max(points[first].y, points[last].y);
      if (bottom - top <= 1) return null;
      const defaultJoin = (top + bottom) / 2;
      const joinY = bottom - top > 16 && Number.isFinite(Number(preferredY))
        ? clamp(Number(preferredY), top + 8, bottom - 8) : defaultJoin;
      const tail = tailFromVertical(points, x, joinY);
      return tail ? { x, y: joinY, top, bottom, tail } : null;
    };
    for (let index = points.length - 3; index >= 1; index--) {
      const from = points[index], to = points[index + 1];
      if (Math.abs(from.x - x) > .1 || Math.abs(to.x - x) > .1
        || Math.abs(to.y - targetLead.y) > .1 || Math.abs(to.y - from.y) < 1) continue;
      let first = index;
      while (first > 1) {
        const previous = points[first - 1], current = points[first];
        if (Math.abs(previous.x - x) > .1 || Math.abs(current.x - x) > .1) break;
        first--;
      }
      return makeJoin(first, index + 1);
    }
    const end = points[points.length - 1];
    return Math.abs(targetLead.x - x) < .1 && Math.abs(end.x - x) < .1
      && Math.abs(end.y - targetLead.y) > 1
      ? makeJoin(points.length - 2, points.length - 1) : null;
  }

  function nodeSize(node) {
    const base = ({ Start: [160, 60], End: [160, 60], Condition: [224, 144], Wait: [224, 94] })[node.NodeType] || [224, 94];
    return { width: clamp(Number(node.CanvasWidth) || base[0], 120, 1600), height: clamp(Number(node.CanvasHeight) || base[1], 56, 1200) };
  }

  function anchor(node, point, side, ratio = .5) {
    const size = nodeSize(node);
    ratio = clamp(ratio == null || !Number.isFinite(Number(ratio)) ? .5 : Number(ratio), 0, 1);
    if (node.NodeType === 'Condition') {
      const inset = Math.abs(ratio - .5);
      return ({ n: { x: point.x + size.width * ratio, y: point.y + size.height * inset },
        s: { x: point.x + size.width * ratio, y: point.y + size.height * (1 - inset) },
        w: { x: point.x + size.width * inset, y: point.y + size.height * ratio },
        e: { x: point.x + size.width * (1 - inset), y: point.y + size.height * ratio } })[side];
    }
    return ({ n: { x: point.x + size.width * ratio, y: point.y },
      s: { x: point.x + size.width * ratio, y: point.y + size.height },
      w: { x: point.x, y: point.y + size.height * ratio },
      e: { x: point.x + size.width, y: point.y + size.height * ratio } })[side] || { x: point.x, y: point.y };
  }

  function sideLaneX(nodes, positions, from, to, side, padding = 72) {
    const top = Math.min(positions[from.NodeId].y, positions[to.NodeId].y) - 28;
    const bottom = Math.max(positions[from.NodeId].y + nodeSize(from).height, positions[to.NodeId].y + nodeSize(to).height) + 28;
    const bounds = nodes.filter(node => positions[node.NodeId]
      && positions[node.NodeId].y + nodeSize(node).height >= top && positions[node.NodeId].y <= bottom)
      .map(node => ({ left: positions[node.NodeId].x, right: positions[node.NodeId].x + nodeSize(node).width }));
    return side === 'left'
      ? Math.max(GRID_STEP, Math.floor((Math.min(...bounds.map(bound => bound.left)) - padding) / GRID_STEP) * GRID_STEP)
      : Math.ceil((Math.max(...bounds.map(bound => bound.right)) + padding) / GRID_STEP) * GRID_STEP;
  }

  function blocksVerticalRoute(nodes, positions, from, to, x, top, bottom) {
    return nodes.some(node => {
      if (node === from || node === to || !positions[node.NodeId]) return false;
      const point = positions[node.NodeId], size = nodeSize(node);
      return x > point.x && x < point.x + size.width
        && point.y < bottom && point.y + size.height > top;
    });
  }

  function sideBranchLead(nodes, positions, lead, laneX, side, sourcePort) {
    const left = Math.min(lead.x, laneX), right = Math.max(lead.x, laneX);
    let y = lead.y;
    for (let attempt = 0; attempt <= nodes.length; attempt++) {
      const blockers = nodes.filter(node => {
        const point = positions[node.NodeId];
        if (!point) return false;
        const size = nodeSize(node);
        return point.x < right && point.x + size.width > left && y > point.y && y < point.y + size.height;
      });
      if (!blockers.length) break;
      const above = sourcePort === 'n' || (sourcePort !== 's' && side === 'left');
      y = above ? Math.min(...blockers.map(node => positions[node.NodeId].y)) - 28
        : Math.max(...blockers.map(node => positions[node.NodeId].y + nodeSize(node).height)) + 28;
    }
    return { x: lead.x, y };
  }

  function routePoints(edge, nodes, layout) {
    const from = nodes.find(node => node.NodeId === edge.FromNodeId);
    const to = nodes.find(node => node.NodeId === edge.ToNodeId);
    if (!from || !to || !layout[from.NodeId] || !layout[to.NodeId]) return [];
    const sourcePort = edge.CanvasSourcePort || 's';
    const targetPort = edge.CanvasTargetPort || 'n';
    const start = anchor(from, layout[from.NodeId], sourcePort, edge.CanvasSourceRatio);
    const end = anchor(to, layout[to.NodeId], targetPort, edge.CanvasTargetRatio);
    const normals = { n: [0, -28], s: [0, 28], w: [-28, 0], e: [28, 0] };
    const sv = normals[sourcePort] || normals.s, tv = normals[targetPort] || normals.n;
    const a = { x: start.x + sv[0], y: start.y + sv[1] };
    const b = { x: end.x + tv[0], y: end.y + tv[1] };
    const horizontal = sourcePort === 'e' || sourcePort === 'w';
    const self = from === to;
    if (Array.isArray(edge.CanvasWaypoints) && edge.CanvasWaypoints.length) {
      const points = [start, a];
      let previous = a;
      edge.CanvasWaypoints.forEach(waypoint => {
        const point = { x: Number(waypoint.x), y: Number(waypoint.y) };
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
        appendOrthogonal(points, previous, point, waypoint.orientation || 'v');
        previous = point;
      });
      appendOrthogonal(points, previous, b, edge.CanvasRouteOrientation || (horizontal ? 'h' : 'v'));
      points.push(end);
      return points;
    }
    // A dragged bend is an explicit waypoint. Keep each segment orthogonal,
    // including straight vertical/horizontal edges which need a lateral detour.
    if (Number.isFinite(edge.CanvasBendX) && Number.isFinite(edge.CanvasBendY)) {
      const x = edge.CanvasBendX, y = edge.CanvasBendY;
      return horizontal
        ? [start, a, { x, y: a.y }, { x, y }, { x: b.x, y }, b, end]
        : [start, a, { x: a.x, y }, { x, y }, { x, y: b.y }, b, end];
    }
    if (self && horizontal && Number.isFinite(edge.CanvasBendY)) {
      return [start, a, { x: a.x, y: edge.CanvasBendY }, { x: b.x, y: edge.CanvasBendY }, b, end];
    }
    const returning = self || layout[to.NodeId].y < layout[from.NodeId].y;
    const sideBranch = horizontal && targetPort === 'n' && b.y > a.y;
    const blocked = targetPort === 'n' && b.y > a.y
      && blocksVerticalRoute(nodes, layout, from, to, a.x, a.y, b.y);
    // Explicit waypoints above remain authoritative. Automatic return routes
    // go left; forward side branches and jumps bypass the process column right.
    if (returning || sideBranch || blocked || Number.isFinite(edge.CanvasBendX)) {
      const side = Number.isFinite(edge.CanvasBendX)
        ? edge.CanvasBendX < layout[from.NodeId].x ? 'left' : 'right' : returning ? 'left' : 'right';
      const laneX = Number.isFinite(edge.CanvasBendX) ? edge.CanvasBendX : sideLaneX(nodes, layout, from, to, side);
      const points = [start, a];
      const branch = sideBranchLead(nodes, layout, a, laneX, side, sourcePort);
      appendOrthogonal(points, a, branch, 'v');
      appendOrthogonal(points, branch, { x: laneX, y: branch.y }, 'h');
      appendOrthogonal(points, points[points.length - 1], { x: laneX, y: b.y }, 'v');
      appendOrthogonal(points, points[points.length - 1], b, 'h');
      appendOrthogonal(points, points[points.length - 1], end, 'v');
      return points;
    }
    const mid = horizontal
      ? (Number.isFinite(edge.CanvasBendX) ? edge.CanvasBendX : (a.x + b.x) / 2)
      : (Number.isFinite(edge.CanvasBendY) ? edge.CanvasBendY : (a.y + b.y) / 2);
    if ((!horizontal && Math.abs(a.x - b.x) < .1) || (horizontal && Math.abs(a.y - b.y) < .1))
      return [start, a, b, end];
    return horizontal
      ? [start, a, { x: mid, y: a.y }, { x: mid, y: b.y }, b, end]
      : [start, a, { x: a.x, y: mid }, { x: b.x, y: mid }, b, end];
  }

  function transitionRoutes(graph, positions) {
    const nodes = graph && graph.Nodes || [], transitions = graph && graph.Transitions || [];
    const routes = transitions.map((edge, index) => ({ edge, index, points: routePoints(edge, nodes, positions), labelPoint: null, mergeKey: null, mergeLaneX: null }));
    const groups = new Map();
    transitions.forEach((edge, index) => {
      if (edge.FromNodeId === edge.ToNodeId) return;
      const sourcePosition = positions[edge.FromNodeId], targetPosition = positions[edge.ToNodeId];
      const direction = sourcePosition && targetPosition && sourcePosition.y > targetPosition.y ? 'return' : 'forward';
      const key = JSON.stringify([String(edge.ToNodeId), edge.CanvasTargetPort || 'n', direction]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(index);
    });
    groups.forEach((indexes, mergeKey) => {
      let group = indexes.map(index => ({ index, edge: transitions[index] }));
      if (group.length < 2 || new Set(group.map(item => item.edge.FromNodeId)).size < 2) return;
      const target = nodes.find(node => node.NodeId === group[0].edge.ToNodeId);
      const targetPosition = target && positions[target.NodeId];
      if (!target || !targetPosition) return;
      const targetSize = nodeSize(target), targetCenterX = targetPosition.x + targetSize.width / 2;
      const targetPort = group[0].edge.CanvasTargetPort || 'n';
      // Keep the closest vertically aligned process edge as the direct path
      // into the target. Side branches can merge into the open final segment
      // without forcing this main connection to loop out and back.
      const direct = group.filter(item => {
        const source = nodes.find(node => node.NodeId === item.edge.FromNodeId), position = positions[item.edge.FromNodeId];
        if (!source || !position || targetPort !== 'n' || (item.edge.CanvasSourcePort || 's') !== 's'
          || (item.edge.CanvasTargetPort || 'n') !== targetPort
          || Number.isFinite(item.edge.CanvasBendX)
          || (item.edge.CanvasSourceRatio != null && Math.abs(Number(item.edge.CanvasSourceRatio) - .5) > .01)
          || (item.edge.CanvasTargetRatio != null && Math.abs(Number(item.edge.CanvasTargetRatio) - .5) > .01)) return false;
        const size = nodeSize(source), sourceCenterX = position.x + size.width / 2;
        return Math.abs(sourceCenterX - targetCenterX) < 1 && position.y + size.height <= targetPosition.y
          && !blocksVerticalRoute(nodes, positions, source, target, sourceCenterX, position.y + size.height, targetPosition.y);
      }).sort((left, right) => {
        const leftNode = nodes.find(node => node.NodeId === left.edge.FromNodeId), rightNode = nodes.find(node => node.NodeId === right.edge.FromNodeId);
        return positions[rightNode.NodeId].y + nodeSize(rightNode).height
          - positions[leftNode.NodeId].y - nodeSize(leftNode).height;
      })[0] || null;
      let directJoin = null, hasDirectMain = false;
      if (direct) {
        const directPoints = routePoints(direct.edge, nodes, positions);
        const sourceLead = directPoints[1], targetLead = directPoints[directPoints.length - 2];
        if (sourceLead && targetLead && Math.abs(sourceLead.x - targetCenterX) < .1
          && Math.abs(targetLead.x - targetCenterX) < .1)
          directJoin = directJoinOnRoute(directPoints, targetCenterX, group.map(item => item.edge.CanvasMergeJoinY)
            .find(value => value != null && Number.isFinite(Number(value))));
        if (!directJoin || !directJoin.tail) directJoin = null;
        routes[direct.index] = { ...routes[direct.index], points: directPoints };
        hasDirectMain = true;
        group = group.filter(item => item.index !== direct.index);
      }
      if (group.length < (hasDirectMain ? 1 : 2)) return;
      const sourcePorts = group.map(item => item.edge.CanvasSourcePort || 's');
      if (sourcePorts.some(port => !['n', 's', 'e', 'w'].includes(port))) return;
      // Keep the shared side lane outside the nodes. When a direct aligned
      // main route exists, side branches join its open final segment instead
      // of sending every incoming wire around the target and back.
      const returning = group.every(item => positions[item.edge.FromNodeId]
        && positions[item.edge.FromNodeId].y > targetPosition.y);
      const laneSide = returning ? 'left' : 'right';
      const targetRatio = .5;
      const targetAnchor = anchor(target, targetPosition, targetPort, targetRatio);
      const targetNormal = ({ n: [0, -28], s: [0, 28], w: [-28, 0], e: [28, 0] })[targetPort];
      const targetLead = { x: targetAnchor.x + targetNormal[0], y: targetAnchor.y + targetNormal[1] };
      const sources = group.map(({ edge }) => {
        const node = nodes.find(item => item.NodeId === edge.FromNodeId), position = positions[edge.FromNodeId];
        if (!node || !position) return null;
        const port = edge.CanvasSourcePort || 's', start = anchor(node, position, port, edge.CanvasSourceRatio);
        const normal = ({ n: [0, -28], s: [0, 28], w: [-28, 0], e: [28, 0] })[port];
        const lead = { x: start.x + normal[0], y: start.y + normal[1] };
        return { node, position, port, start, lead, prefix: [start, lead], join: lead };
      });
      if (sources.some(source => !source)) return;
      const top = Math.min(targetLead.y, ...sources.map(source => source.join.y));
      const bottom = Math.max(targetLead.y, ...sources.map(source => source.join.y));
      const relevant = nodes.filter(node => {
        const position = positions[node.NodeId];
        if (!position) return false;
        const size = nodeSize(node);
        return position.y + size.height >= top && position.y <= bottom;
      });
      const bounds = relevant.map(node => {
        const position = positions[node.NodeId], size = nodeSize(node);
        return { left: position.x, right: position.x + size.width };
      });
      sources.forEach(source => {
        const size = nodeSize(source.node);
        bounds.push({ left: source.position.x, right: source.position.x + size.width });
      });
      bounds.push({ left: targetPosition.x, right: targetPosition.x + targetSize.width });
      const labelWidth = Math.max(...group.map(item => Math.max(36, String(item.edge.Outcome || '*').length * 10)));
      const lanePadding = Math.max(72, labelWidth + 48);
      const calculatedLane = laneSide === 'right'
        ? Math.ceil((Math.max(...bounds.map(bound => bound.right)) + lanePadding) / GRID_STEP) * GRID_STEP
        : Math.max(GRID_STEP, Math.floor((Math.min(...bounds.map(bound => bound.left)) - lanePadding) / GRID_STEP) * GRID_STEP);
      const storedLane = group.map(item => item.edge.CanvasMergeLaneX)
        .find(value => value != null && Number.isFinite(Number(value)));
      const lane = storedLane == null ? calculatedLane : Number(storedLane);
      group.forEach(({ index, edge }, groupIndex) => {
        const source = sources[groupIndex], end = anchor(target, targetPosition, targetPort, targetRatio);
        const points = source.prefix.slice();
        const branchWaypoints = Array.isArray(edge.CanvasMergeWaypoints) ? edge.CanvasMergeWaypoints
          : Array.isArray(edge.CanvasWaypoints) ? edge.CanvasWaypoints : [];
        let branchPoint = source.join;
        if (!branchWaypoints.length && !Number.isFinite(edge.CanvasMergeBranchY)) {
          branchPoint = sideBranchLead(nodes, positions, source.lead, lane, laneSide, source.port);
          appendOrthogonal(points, source.lead, branchPoint, 'v');
        }
        branchWaypoints.forEach(waypoint => {
          const point = { x: Number(waypoint.x), y: Number(waypoint.y) };
          if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
          appendOrthogonal(points, branchPoint, point, waypoint.orientation || 'v');
          branchPoint = point;
        });
        const branchY = branchWaypoints.length
          ? branchPoint.y
          : Number.isFinite(edge.CanvasMergeBranchY) ? edge.CanvasMergeBranchY : branchPoint.y;
        appendOrthogonal(points, branchPoint, { x: lane, y: branchY }, Math.abs(branchPoint.y - branchY) < .01 ? 'h' : 'v');
        if (directJoin) {
          appendOrthogonal(points, points[points.length - 1], { x: lane, y: directJoin.y }, 'v');
          appendOrthogonal(points, points[points.length - 1], directJoin, 'h');
          directJoin.tail.slice(1).forEach(point => appendOrthogonal(points, points[points.length - 1], point, 'v'));
        } else {
          appendOrthogonal(points, points[points.length - 1], { x: lane, y: targetLead.y }, 'v');
          appendOrthogonal(points, points[points.length - 1], targetLead, 'h');
          appendOrthogonal(points, points[points.length - 1], end, 'v');
        }
        routes[index] = { edge, index, points, labelPoint: { x: (source.join.x + lane) / 2, y: branchY }, mergeKey, mergeLaneX: lane,
          mergeTrunkX: directJoin ? directJoin.x : null,
          mergeJoinRange: directJoin ? [directJoin.top, directJoin.bottom] : null };
      });
    });
    return routes;
  }

  function bridgeCrossings(routes) {
    const segments = [];
    routes.forEach(route => (route.points || []).slice(1).forEach((point, segmentIndex) => {
      const start = route.points[segmentIndex], end = point;
      if (Math.abs(start.x - end.x) < .01 && Math.abs(start.y - end.y) >= .01)
        segments.push({ route, start, end, orientation: 'v' });
      else if (Math.abs(start.y - end.y) < .01 && Math.abs(start.x - end.x) >= .01)
        segments.push({ route, start, end, orientation: 'h' });
    }));
    const crossings = new Map(), epsilon = 1;
    for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
      const first = segments[i], second = segments[j];
      if (first.route.index === second.route.index || first.orientation === second.orientation) continue;
      const horizontal = first.orientation === 'h' ? first : second;
      const vertical = first.orientation === 'v' ? first : second;
      const x = vertical.start.x, y = horizontal.start.y;
      const within = (value, a, b) => value > Math.min(a, b) + epsilon && value < Math.max(a, b) - epsilon;
      if (!within(x, horizontal.start.x, horizontal.end.x) || !within(y, vertical.start.y, vertical.end.y)) continue;
      if (first.route.mergeKey && first.route.mergeKey === second.route.mergeKey) continue;
      const obscuresLabel = [first.route.labelPoint, second.route.labelPoint].some(label => label
        && Math.abs(label.x - x) < 30 && Math.abs(label.y - y) < 20);
      if (obscuresLabel) continue;
      const key = `${Math.round(x * 10) / 10}:${Math.round(y * 10) / 10}`;
      // Draw the later flow edge as the wire that jumps over the earlier one.
      crossings.set(key, { x, y, orientation: second.index >= first.index ? second.orientation : first.orientation,
        index: Math.max(first.route.index, second.route.index) });
    }
    return [...crossings.values()];
  }

  function outcomesFor(method, node) {
    if (node && node.NodeType === 'Start') return ['Succeeded'];
    if (method && method.ReturnType === 'bool') return ['true', 'false'];
    const pending = new Set((method && method.PendingStatusCodes || []).map(String));
    const declared = method && Array.isArray(method.Outcomes) && method.Outcomes.length
      ? method.Outcomes : method && method.ResultStatusCodes || [];
    const outcomes = declared.map(String).filter(code => !pending.has(code));
    if (method && method.ReturnType === 'int') {
      return ['0', ...new Set(outcomes.filter(code => code !== '0'))];
    }
    return outcomes.length ? outcomes : ['*'];
  }

  function synchronizeEntryNode(flow, preferredNodeId = '') {
    if (!flow || !Array.isArray(flow.Nodes)) return false;
    const starts = flow.Nodes.filter(node => node && node.NodeType === 'Start'
      && typeof node.NodeId === 'string' && node.NodeId);
    const next = starts.find(node => node.NodeId === preferredNodeId)
      || starts.find(node => node.NodeId === flow.EntryNodeId)
      || (starts.length === 1 ? starts[0] : null);
    const entryNodeId = next ? next.NodeId : '';
    const changed = flow.EntryNodeId !== entryNodeId;
    flow.EntryNodeId = entryNodeId;
    return changed;
  }

  function outcomeRatio(method, node, outcomes, code) {
    if (node && node.NodeType === 'Condition') return .5;
    const index = outcomes.indexOf(code);
    if (!method || method.ReturnType !== 'int' || !outcomes.includes('0'))
      return (index + 1) / (outcomes.length + 1);
    if (code === '0') return .5;
    const alternatives = outcomes.filter(outcome => outcome !== '0');
    const alternativeIndex = alternatives.indexOf(code);
    const leftCount = Math.ceil(alternatives.length / 2), rightCount = Math.floor(alternatives.length / 2);
    const sideIndex = Math.floor(alternativeIndex / 2) + 1;
    return alternativeIndex % 2 === 0
      ? .5 - sideIndex * .5 / (leftCount + 1)
      : .5 + sideIndex * .5 / (rightCount + 1);
  }

  // Longest-path ranks for a DAG. DFS back-edges are retained as return loops,
  // but excluded from rank propagation so a loop cannot move the whole graph.
  function downwardRanks(nodes, transitions, entryNodeId) {
    const ids = new Set(nodes.map(node => node.NodeId)), colors = new Map(), back = new Set();
    const outgoing = new Map(nodes.map(node => [node.NodeId, []]));
    transitions.forEach((edge, index) => { if (ids.has(edge.FromNodeId) && ids.has(edge.ToNodeId)) outgoing.get(edge.FromNodeId).push({ edge, index }); });
    function visit(id) {
      colors.set(id, 1);
      outgoing.get(id).forEach(({ edge, index }) => {
        if (colors.get(edge.ToNodeId) === 1) back.add(index);
        else if (!colors.has(edge.ToNodeId)) visit(edge.ToNodeId);
      });
      colors.set(id, 2);
    }
    if (ids.has(entryNodeId)) visit(entryNodeId);
    nodes.forEach(node => { if (!colors.has(node.NodeId)) visit(node.NodeId); });
    const indegree = new Map(nodes.map(node => [node.NodeId, 0])), ranks = new Map(nodes.map(node => [node.NodeId, 0]));
    transitions.forEach((edge, index) => { if (!back.has(index) && ids.has(edge.FromNodeId) && ids.has(edge.ToNodeId)) indegree.set(edge.ToNodeId, indegree.get(edge.ToNodeId) + 1); });
    const ready = nodes.map(node => node.NodeId).filter(id => indegree.get(id) === 0);
    for (let i = 0; i < ready.length; i++) {
      const id = ready[i];
      outgoing.get(id).forEach(({ edge, index }) => {
        if (back.has(index)) return;
        ranks.set(edge.ToNodeId, Math.max(ranks.get(edge.ToNodeId), ranks.get(id) + 1));
        indegree.set(edge.ToNodeId, indegree.get(edge.ToNodeId) - 1);
        if (indegree.get(edge.ToNodeId) === 0) ready.push(edge.ToNodeId);
      });
    }
    return ranks;
  }

  function arrangeDownward(graph, positions, methodFor = () => null) {
    if (!graph || !graph.Nodes.length) return;
    const nodes = graph.Nodes, transitions = graph.Transitions;
    const nodeById = new Map(nodes.map(node => [node.NodeId, node]));
    const root = nodes.find(node => node.NodeType === 'Start')
      || nodeById.get(graph.EntryNodeId) || nodes[0];
    const ranks = downwardRanks(nodes, transitions, root.NodeId);
    const outgoing = id => transitions.filter(edge => edge.FromNodeId === id && nodeById.has(edge.ToNodeId)
      && ranks.get(edge.ToNodeId) > ranks.get(id))
      .sort((a, b) => Number(a.Priority || 0) - Number(b.Priority || 0));
    const primaryEdge = (node, edges) => {
      if (!edges.length) return null;
      const alarmCodes = new Set((methodFor(node)?.AlarmStatusCodes || []).map(code => String(code).toLowerCase()));
      const ordinary = edge => nodeById.get(edge.ToNodeId).NodeType !== 'Alarm'
        && !alarmCodes.has(String(edge.Outcome).toLowerCase());
      for (const outcome of ['0', 'true', 'succeeded', 'success']) {
        const preferred = edges.find(edge => String(edge.Outcome).toLowerCase() === outcome && ordinary(edge));
        if (preferred) return preferred;
      }
      return edges.find(edge => ordinary(edge) && !['false', 'failed', 'failure'].includes(String(edge.Outcome).toLowerCase()))
        || edges.find(ordinary) || edges[0];
    };
    const continuations = new Map(nodes.map(node => [node.NodeId, primaryEdge(node, outgoing(node.NodeId))]));
    const primary = new Set();
    let id = root.NodeId;
    while (id && !primary.has(id)) {
      primary.add(id);
      id = continuations.get(id)?.ToNodeId;
    }
    const maxNodeWidth = Math.max(224, ...nodes.map(node => nodeSize(node).width));
    const columnWidth = maxNodeWidth + 130;
    const lanes = new Map([...primary].map(nodeId => [nodeId, 0]));
    let nextLane = 1;
    const orderedByRank = [...nodes].sort((left, right) => ranks.get(left.NodeId) - ranks.get(right.NodeId)
      || nodes.indexOf(left) - nodes.indexOf(right));
    orderedByRank.forEach(node => {
      if (!lanes.has(node.NodeId)) lanes.set(node.NodeId, nextLane++);
      const lane = lanes.get(node.NodeId), continuation = continuations.get(node.NodeId);
      outgoing(node.NodeId).forEach(edge => {
        if (!lanes.has(edge.ToNodeId)) lanes.set(edge.ToNodeId, edge === continuation ? lane : nextLane++);
      });
    });
    const rowHeights = new Map(), rowY = new Map();
    nodes.forEach(node => rowHeights.set(ranks.get(node.NodeId), Math.max(rowHeights.get(ranks.get(node.NodeId)) || 0, nodeSize(node).height)));
    let y = 60;
    [...rowHeights.keys()].sort((a, b) => a - b).forEach(rank => { rowY.set(rank, y); y += rowHeights.get(rank) + 100; });
    const mainCenterX = 180 + maxNodeWidth / 2;
    nodes.forEach(node => {
      positions[node.NodeId] = {
        x: Math.round(mainCenterX + (lanes.get(node.NodeId) || 0) * columnWidth - nodeSize(node).width / 2),
        y: rowY.get(ranks.get(node.NodeId)),
      };
    });
    const geometry = ['CanvasBendX', 'CanvasBendY', 'CanvasRouteOrientation', 'CanvasMergeLaneX', 'CanvasMergeJoinY',
      'CanvasMergeBranchY', 'CanvasWaypoints', 'CanvasMergeWaypoints', 'CanvasMergeLaneAnchors'];
    transitions.forEach(edge => {
      geometry.forEach(key => { delete edge[key]; });
      const source = nodeById.get(edge.FromNodeId), target = nodeById.get(edge.ToNodeId);
      if (!source || !target) return;
      const from = positions[source.NodeId], to = positions[target.NodeId];
      const self = source === target, returning = self || to.y < from.y;
      const sourceCenter = from.x + nodeSize(source).width / 2, targetCenter = to.x + nodeSize(target).width / 2;
      const main = !returning && continuations.get(source.NodeId) === edge && Math.abs(sourceCenter - targetCenter) < 1
        && !blocksVerticalRoute(nodes, positions, source, target, sourceCenter, from.y + nodeSize(source).height, to.y);
      // Outcome/Priority describe execution; ports and bends only describe layout.
      const centeredZero = String(edge.Outcome) === '0' && source.NodeType !== 'Condition';
      edge.CanvasSourcePort = main || centeredZero ? 's' : returning ? 'w' : 'e';
      edge.CanvasSourceRatio = .5;
      edge.CanvasTargetPort = returning && !self ? 's' : 'n';
      edge.CanvasTargetRatio = .5;
      if (!main) edge.CanvasBendX = sideLaneX(nodes, positions, source, target, returning ? 'left' : 'right',
        Math.max(72, String(edge.Outcome || '*').length * 10 + 48));
    });
  }

  function create(adapter) {
    const viewport = document.getElementById('canvasViewport');
    const canvas = document.getElementById('flowCanvas');
    const nodesRoot = document.getElementById('flowNodes');
    const edgeRoot = document.getElementById('flowEdges');
    const guideRoot = document.createElementNS(NS, 'svg');
    guideRoot.setAttribute('class', 'alignment-guides');
    guideRoot.setAttribute('aria-hidden', 'true');
    canvas.appendChild(guideRoot);
    const stage = document.createElement('div');
    stage.className = 'canvas-stage';
    canvas.parentNode.insertBefore(stage, canvas);
    stage.appendChild(canvas);
    // The empty-state stays at viewport scale, even before any graph is loaded.
    const empty = document.getElementById('canvasEmpty');
    if (empty) viewport.appendChild(empty);
    const ui = { zoom: 1, tool: 'select', selected: new Set(), edge: null, hoverEdge: null, hoverShared: false, hoverPointer: null, drag: null, space: false, lastNodeClick: null,
      connection: null, undo: [], redo: [], clipboard: null, key: '', extent: { width: 1600, height: 1200 } };
    const flow = () => adapter.getFlow();
    const layout = () => adapter.getLayout();
    const q = id => document.getElementById(id);
    const snapEnabled = () => Boolean(q('snapToggle')?.checked);
    const snap = value => snapEnabled() ? Math.round(value / GRID_STEP) * GRID_STEP : Math.round(value);
    // Snap node centers to the grid so differently sized shapes can share a flow line.
    const snapNodeAxis = (position, size) => snapEnabled()
      ? snap(position + size / 2) - size / 2
      : snap(position);
    const pointFromClient = (x, y) => {
      const rect = canvas.getBoundingClientRect();
      return { x: (x - rect.left) / ui.zoom, y: (y - rect.top) / ui.zoom };
    };
    const centerPoint = () => pointFromClient(viewport.getBoundingClientRect().left + viewport.clientWidth / 2,
      viewport.getBoundingClientRect().top + viewport.clientHeight / 2);
    const status = text => adapter.status(text);

    function snapshot() { return { flow: clone(flow()), layout: clone(layout()) }; }
    function historyButtons() {
      if (q('undoButton')) q('undoButton').disabled = !ui.undo.length;
      if (q('redoButton')) q('redoButton').disabled = !ui.redo.length;
    }
    function recordBefore() {
      if (!flow()) return;
      const value = snapshot();
      if (!ui.undo.length || JSON.stringify(ui.undo[ui.undo.length - 1]) !== JSON.stringify(value)) {
        ui.undo.push(value);
        if (ui.undo.length > 60) ui.undo.shift();
      }
      ui.redo = [];
      historyButtons();
    }
    function reset() {
      ui.undo = []; ui.redo = []; ui.selected.clear(); ui.edge = null; ui.hoverEdge = null; ui.hoverShared = false; ui.hoverPointer = null; ui.drag = null; ui.connection = null; ui.key = '';
      historyButtons();
    }
    function refresh() { adapter.persist(); adapter.refresh(); historyButtons(); }
    function change(fn) { if (!flow()) return; recordBefore(); fn(); refresh(); }
    function restore(value) {
      adapter.restore(clone(value)); ui.selected.clear(); ui.edge = null;
      adapter.setSelected(null); refresh();
    }
    function undo() { if (!ui.undo.length) return; ui.redo.push(snapshot()); restore(ui.undo.pop()); status('已撤销'); }
    function redo() { if (!ui.redo.length) return; ui.undo.push(snapshot()); restore(ui.redo.pop()); status('已重做'); }
    function notifySelection() {
      adapter.setSelected(ui.selected.size ? [...ui.selected].pop() : null);
      render(); adapter.selectionChanged();
    }
    function selectNode(id, toggle) {
      ui.edge = null;
      if (toggle) { if (ui.selected.has(id)) ui.selected.delete(id); else ui.selected.add(id); }
      else if (!ui.selected.has(id) || ui.selected.size === 0) ui.selected = new Set([id]);
      notifySelection();
    }
    function selectNodeById(id) { if (flow() && flow().Nodes.some(node => node.NodeId === id)) selectNode(id, false); }
    function selectEdgeByIndex(index) {
      if (!flow() || !flow().Transitions[index]) return;
      ui.selected.clear(); ui.edge = index; adapter.setSelected(null); render(); adapter.selectionChanged();
    }
    function setTool(tool) {
      if (tool !== ui.tool) ui.connection = null;
      ui.tool = tool; ui.drag = null; viewport.dataset.tool = tool;
      [['selectToolButton', 'select'], ['panToolButton', 'pan'], ['connectToolButton', 'connect']].forEach(([id, name]) => {
        if (q(id)) { q(id).classList.toggle('active', tool === name); q(id).setAttribute('aria-pressed', String(tool === name)); }
      });
      document.querySelectorAll('[data-shape]').forEach(button => button.classList.toggle('active', tool === `shape:${button.dataset.shape}`));
      if (tool.startsWith('shape:')) status('在画布点击放置图形；按 Esc 返回选择工具');
      else if (tool === 'connect') status('从节点开始布线；空白处单击放锚点，按空格翻转方向，单击目标完成');
    }
    function updateScale() {
      canvas.style.transform = `scale(${ui.zoom})`;
      stage.style.width = `${Math.max(viewport.clientWidth, ui.extent.width * ui.zoom)}px`;
      stage.style.height = `${Math.max(viewport.clientHeight, ui.extent.height * ui.zoom)}px`;
      if (q('zoomValue')) q('zoomValue').textContent = `${Math.round(ui.zoom * 100)}%`;
    }
    function zoomTo(next, clientX, clientY) {
      const rect = viewport.getBoundingClientRect();
      const x = clientX == null ? viewport.clientWidth / 2 : clientX - rect.left;
      const y = clientY == null ? viewport.clientHeight / 2 : clientY - rect.top;
      const world = { x: (viewport.scrollLeft + x) / ui.zoom, y: (viewport.scrollTop + y) / ui.zoom };
      ui.zoom = clamp(next, .2, 2.5); updateScale();
      viewport.scrollLeft = world.x * ui.zoom - x; viewport.scrollTop = world.y * ui.zoom - y;
    }
    function fit() {
      const f = flow(); if (!f || !f.Nodes.length) return;
      const bounds = f.Nodes.reduce((b, node) => {
        const p = layout()[node.NodeId], size = nodeSize(node);
        return { x: Math.min(b.x, p.x), y: Math.min(b.y, p.y), right: Math.max(b.right, p.x + size.width), bottom: Math.max(b.bottom, p.y + size.height) };
      }, { x: Infinity, y: Infinity, right: 0, bottom: 0 });
      transitionRoutes(f, layout()).forEach(route => route.points.forEach(point => {
        bounds.x = Math.min(bounds.x, point.x); bounds.y = Math.min(bounds.y, point.y);
        bounds.right = Math.max(bounds.right, point.x); bounds.bottom = Math.max(bounds.bottom, point.y);
      }));
      ui.zoom = clamp(Math.min((viewport.clientWidth - 100) / (bounds.right - bounds.x),
        (viewport.clientHeight - 100) / (bounds.bottom - bounds.y), 1.25), .2, 2);
      updateScale(); viewport.scrollLeft = Math.max(0, bounds.x * ui.zoom - 50); viewport.scrollTop = Math.max(0, bounds.y * ui.zoom - 50);
      status('已适应视图；节点位置保持原坐标');
    }
    function arrange() {
      const f = flow(); if (!f || !f.Nodes.length) return;
      recordBefore();
      arrangeDownward(f, layout(), node => adapter.methodFor(node));
      // Persist and redraw from the coordinates just calculated without reloading
      // the layout in the middle of this arrange pass.
      adapter.persist();
      render();
      fit(); status(`已从开始节点向下整理并重新梳理线路；保留 ${f.Transitions.length} 条已连接分支`);
    }

    function svg(tag, attributes, parent = edgeRoot) {
      const element = document.createElementNS(NS, tag);
      Object.entries(attributes || {}).forEach(([key, value]) => element.setAttribute(key, String(value)));
      parent.appendChild(element); return element;
    }
    function path(points) { return points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' '); }
    function midpoint(points) {
      let total = 0; const lengths = [];
      for (let i = 1; i < points.length; i++) { const n = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y); lengths.push(n); total += n; }
      let left = total / 2;
      for (let i = 0; i < lengths.length; i++) {
        if (left <= lengths[i]) { const t = lengths[i] ? left / lengths[i] : 0; return { x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t }; }
        left -= lengths[i];
      }
      return points[0];
    }
  function sharedTrunkRange(routes, mergeKey, laneX, pointer) {
    const group = routes.filter(route => route.mergeKey === mergeKey);
    if (!group.length) return null;
    const candidates = [...new Set([laneX, ...group.map(route => route.mergeTrunkX)])]
      .filter(Number.isFinite);
    const ranges = [];
    for (const x of candidates) {
      const spans = group.map(route => {
        const verticals = (route.points || []).slice(1).map((point, index) => {
          const previous = route.points[index];
          return Math.abs(previous.x - x) < .1 && Math.abs(point.x - x) < .1
            && Math.abs(previous.y - point.y) > 1
            ? { top: Math.min(previous.y, point.y), bottom: Math.max(previous.y, point.y) } : null;
        }).filter(Boolean).sort((a, b) => a.top - b.top);
        const merged = [];
        verticals.forEach(span => {
          const last = merged[merged.length - 1];
          if (last && span.top <= last.bottom + 1) last.bottom = Math.max(last.bottom, span.bottom);
          else merged.push({ ...span });
        });
        return merged.sort((a, b) => (b.bottom - b.top) - (a.bottom - a.top))[0] || null;
      });
      if (spans.some(span => !span)) continue;
      const range = { top: Math.max(...spans.map(span => span.top)), bottom: Math.min(...spans.map(span => span.bottom)), x };
      if (range.bottom - range.top > 12) ranges.push(range);
    }
    return ranges.sort((left, right) => pointer
      ? Math.abs(left.x - pointer.x) - Math.abs(right.x - pointer.x)
      : Number(right.x === laneX) - Number(left.x === laneX))[0] || null;
  }
  function isMergeJoinSegment(route, segmentIndex) {
    if (!route || route.mergeTrunkX == null || !route.points[segmentIndex] || !route.points[segmentIndex + 1]) return false;
    const from = route.points[segmentIndex], to = route.points[segmentIndex + 1];
    return Math.abs(from.y - to.y) < .1
      && ((Math.abs(from.x - route.mergeLaneX) < .1 && Math.abs(to.x - route.mergeTrunkX) < .1)
        || (Math.abs(to.x - route.mergeLaneX) < .1 && Math.abs(from.x - route.mergeTrunkX) < .1));
  }
  function routeOrientation(from, to, fallback = 'v') {
    if (Math.abs(from.y - to.y) < .1) return 'h';
    if (Math.abs(from.x - to.x) < .1) return 'v';
    return fallback;
  }
    function verticalAlignmentState(edge, graph, outgoingCount, incomingCount) {
      if ((edge.CanvasSourcePort || 's') !== 's' || (edge.CanvasTargetPort || 'n') !== 'n'
        || Number.isFinite(edge.CanvasBendX) || Number.isFinite(edge.CanvasBendY)
        || (Array.isArray(edge.CanvasWaypoints) && edge.CanvasWaypoints.length)) return null;
      const sourceRatio = edge.CanvasSourceRatio == null ? .5 : Number(edge.CanvasSourceRatio);
      const targetRatio = edge.CanvasTargetRatio == null ? .5 : Number(edge.CanvasTargetRatio);
      if (!Number.isFinite(sourceRatio) || !Number.isFinite(targetRatio)
        || Math.abs(sourceRatio - .5) > .01 || Math.abs(targetRatio - .5) > .01) return null;
      // A fork or join has its own layout: only color an unbranched vertical run.
      if (outgoingCount.get(edge.FromNodeId) !== 1 || incomingCount.get(edge.ToNodeId) !== 1) return null;
      const from = graph.Nodes.find(node => node.NodeId === edge.FromNodeId);
      const to = graph.Nodes.find(node => node.NodeId === edge.ToNodeId);
      const fromPosition = layout()[edge.FromNodeId], toPosition = layout()[edge.ToNodeId];
      if (!from || !to || !fromPosition || !toPosition) return null;
      const fromSize = nodeSize(from), toSize = nodeSize(to);
      if (toPosition.y < fromPosition.y + fromSize.height) return null;
      const gap = Math.abs(fromPosition.x + fromSize.width / 2 - toPosition.x - toSize.width / 2);
      // Far-apart columns are side branches even when their ports face down/up.
      if (gap > Math.min(fromSize.width, toSize.width) / 2) return null;
      return gap <= 1 ? 'aligned' : 'offset';
    }
    function updateEdgeHover(index, pointer) {
      const graph = flow();
      if (!graph || !Number.isInteger(index) || !graph.Transitions[index]) {
        if (ui.hoverEdge == null && !ui.hoverPointer) return;
        ui.hoverEdge = null; ui.hoverShared = false; ui.hoverPointer = null;
        renderEdgeHover(transitionRoutes(graph || { Nodes: [], Transitions: [] }, layout()), graph);
        return;
      }
      const routes = transitionRoutes(graph, layout()), route = routes[index];
      const tolerance = 8 / ui.zoom;
      const mergeRoute = route && (route.mergeKey ? route : routes.find(item => item.edge.ToNodeId === route.edge.ToNodeId
        && (item.edge.CanvasTargetPort || 'n') === (route.edge.CanvasTargetPort || 'n') && item.mergeKey));
      const sharedRange = mergeRoute ? sharedTrunkRange(routes, mergeRoute.mergeKey, mergeRoute.mergeLaneX, pointer) : null;
      const shared = Boolean(sharedRange && pointer
        && Math.abs(pointer.x - sharedRange.x) < tolerance
        && pointer.y >= sharedRange.top - tolerance && pointer.y <= sharedRange.bottom + tolerance);
      const pointerMoved = !ui.hoverPointer || !pointer || Math.hypot(pointer.x - ui.hoverPointer.x, pointer.y - ui.hoverPointer.y) >= 1;
      if (ui.hoverEdge === index && ui.hoverShared === shared && !pointerMoved) return;
      ui.hoverEdge = index; ui.hoverShared = shared;
      ui.hoverPointer = pointer ? { x: pointer.x, y: pointer.y } : null;
      renderEdgeHover(routes, graph);
    }
    function renderEdgeHover(routes, graph) {
      edgeRoot.querySelectorAll('.flow-transition.hovered').forEach(element => element.classList.remove('hovered'));
      edgeRoot.querySelector('.edge-hover-info')?.remove();
      if (ui.hoverEdge == null || !graph) return;
      const route = routes[ui.hoverEdge];
      if (!route || !route.points.length) return;
      const grouped = ui.hoverShared
        ? routes.filter(item => item.edge.ToNodeId === route.edge.ToNodeId
          && (item.edge.CanvasTargetPort || 'n') === (route.edge.CanvasTargetPort || 'n'))
        : [route];
      grouped.forEach(item => edgeRoot.querySelector(`[data-edge-index="${item.index}"]`)?.classList.add('hovered'));
      const nodes = new Map(graph.Nodes.map(node => [node.NodeId, node]));
      const entries = grouped.map(item => {
        const from = nodes.get(item.edge.FromNodeId), to = nodes.get(item.edge.ToNodeId);
        return `${from && (from.DisplayName || from.NodeId) || item.edge.FromNodeId} → ${String(item.edge.Outcome || '*')} → ${to && (to.DisplayName || to.NodeId) || item.edge.ToNodeId}`;
      });
      const lines = grouped.length > 1 ? [`汇入 ${nodes.get(route.edge.ToNodeId)?.DisplayName || route.edge.ToNodeId}`, ...entries] : entries;
      const width = clamp(Math.max(...lines.map(line => [...line].length * 8 + 20)), 150, 440);
      const height = lines.length * 19 + 12;
      const mergeRoute = route.mergeKey ? route : routes.find(item => item.edge.ToNodeId === route.edge.ToNodeId
        && (item.edge.CanvasTargetPort || 'n') === (route.edge.CanvasTargetPort || 'n') && item.mergeKey);
      const sharedRange = ui.hoverShared && mergeRoute
        ? sharedTrunkRange(routes, mergeRoute.mergeKey, mergeRoute.mergeLaneX, ui.hoverPointer) : null;
      const position = ui.hoverPointer || (sharedRange
        ? { x: sharedRange.x, y: (sharedRange.top + sharedRange.bottom) / 2 }
        : route.labelPoint || midpoint(route.points));
      const maxX = Math.max(8, ui.extent.width - width - 8), maxY = Math.max(8, ui.extent.height - height - 8);
      const x = clamp(position.x + 14, 8, maxX);
      const above = position.y - height - 14;
      const y = clamp(above >= 8 ? above : position.y + 14, 8, maxY);
      const info = svg('g', { class: 'edge-hover-info', 'pointer-events': 'none', 'aria-hidden': 'true' });
      svg('rect', { x, y, width, height, rx: 5 }, info);
      const text = svg('text', { x: x + width / 2, y: y + 19, 'text-anchor': 'middle' }, info);
      lines.forEach((line, lineIndex) => {
        const span = svg('tspan', { x: x + width / 2, dy: lineIndex ? 19 : 0 }, text);
        span.textContent = line;
      });
    }
    function connectionTargetAt(point, target) {
      if (!point || !target || target.closest('.flow-node,button,input,select,textarea,.data-edge,.data-edge-label')) return null;
      const graph = flow(); if (!graph) return null;
      const routes = transitionRoutes(graph, layout());
      const hinted = target && target.closest('[data-edge-index]');
      const hintedIndex = hinted ? Number(hinted.dataset.edgeIndex) : null;
      const radius = 12 / ui.zoom;
      let nearest = null;
      routes.forEach(route => {
        const segment = nearestRouteSegment(route.points, point);
        if (!segment || segment.distance > radius) return;
        const preferred = route.index === hintedIndex;
        if (!nearest || segment.distance < nearest.distance - .5
          || (preferred && !nearest.preferred))
          nearest = { route, point: segment.point, distance: segment.distance, preferred };
      });
      if (!nearest) return null;
      return { index: nearest.route.index, targetId: nearest.route.edge.ToNodeId,
        point: nearest.point, outcome: String(nearest.route.edge.Outcome || '*') };
    }
    function setConnectionTarget(connection, target) {
      const previous = connection.mergeTarget;
      if ((!previous && !target) || (previous && target && previous.targetId === target.targetId)) {
        connection.mergeTarget = target; return;
      }
      edgeRoot.querySelectorAll('.flow-transition.merge-target').forEach(element => element.classList.remove('merge-target'));
      connection.mergeTarget = target;
      const graph = flow();
      if (target && graph) graph.Transitions.forEach((edge, index) => {
        if (edge.ToNodeId === target.targetId)
          edgeRoot.querySelector(`[data-edge-index="${index}"]`)?.classList.add('merge-target');
      });
    }
    function updateConnectionPreview(connection, point, target) {
      connection.cursor = point;
      setConnectionTarget(connection, connectionTargetAt(point, target));
      drawConnectionPreview(connection);
    }
    function renderEdges() {
      const f = flow(); if (!f) { edgeRoot.innerHTML = ''; return; }
      edgeRoot.innerHTML = '<defs><marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 Z"/></marker><marker id="flow-arrow-aligned" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 Z"/></marker><marker id="flow-arrow-offset" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 Z"/></marker></defs>';
      const routes = transitionRoutes(f, layout());
      const outgoingCount = new Map(), incomingCount = new Map();
      f.Transitions.forEach(edge => {
        outgoingCount.set(edge.FromNodeId, (outgoingCount.get(edge.FromNodeId) || 0) + 1);
        incomingCount.set(edge.ToNodeId, (incomingCount.get(edge.ToNodeId) || 0) + 1);
      });
      f.Transitions.forEach((edge, index) => {
        const route = routes[index], points = route && route.points; if (!points || !points.length) return;
        const alignment = verticalAlignmentState(edge, f, outgoingCount, incomingCount);
        const group = svg('g', { class: `flow-transition${ui.edge === index ? ' selected' : ''}${alignment ? ` alignment-${alignment}` : ''}${ui.connection?.mergeTarget?.targetId === edge.ToNodeId ? ' merge-target' : ''}`, 'data-edge-index': index });
        svg('path', { d: path(points), class: 'edge-hit' }, group);
        svg('path', { d: path(points), class: 'control-edge', 'marker-end': `url(#flow-arrow${alignment ? `-${alignment}` : ''})` }, group);
        const mid = route.labelPoint || midpoint(points), label = String(edge.Outcome || '*');
        const sourceNode = f.Nodes.find(node => node.NodeId === edge.FromNodeId);
        const sideOutcomePort = sourceNode && sourceNode.NodeType !== 'Condition'
          && ['e', 'w'].includes(edge.CanvasSourcePort || 's')
          && outcomesFor(adapter.methodFor(sourceNode), sourceNode).map(String).includes(label);
        if (!sideOutcomePort) {
          svg('rect', { x: mid.x - Math.max(18, label.length * 5), y: mid.y - 13, width: Math.max(36, label.length * 10), height: 26, rx: 4, class: 'edge-label-bg' }, group);
          svg('text', { x: mid.x, y: mid.y + 5, 'text-anchor': 'middle', class: 'edge-label' }, group).textContent = label;
        }
        if (ui.edge === index) {
          const self = edge.FromNodeId === edge.ToNodeId;
          const horizontal = self ? !['e', 'w'].includes(edge.CanvasSourcePort || 's') : ['e', 'w'].includes(edge.CanvasSourcePort || 's');
          const manual = !self && Number.isFinite(edge.CanvasBendX) && Number.isFinite(edge.CanvasBendY);
          const hasWaypoints = Array.isArray(edge.CanvasWaypoints) && edge.CanvasWaypoints.length > 0;
          const targetNode = f.Nodes.find(node => node.NodeId === edge.ToNodeId);
          const left = Math.min(layout()[sourceNode.NodeId].x, layout()[targetNode.NodeId].x);
          const right = Math.max(layout()[sourceNode.NodeId].x + nodeSize(sourceNode).width, layout()[targetNode.NodeId].x + nodeSize(targetNode).width);
          const sideSegment = !Number.isFinite(edge.CanvasBendY) && !hasWaypoints ? points.slice(1).map((to, i) => ({ from: points[i], to }))
            .filter(segment => Math.abs(segment.from.x - segment.to.x) < .1
              && Math.abs(segment.to.y - segment.from.y) > 1
              && (segment.from.x < left || segment.from.x > right))
            .sort((a, b) => Math.abs(b.to.y - b.from.y) - Math.abs(a.to.y - a.from.y))[0] : null;
          const bend = sideSegment ? { x: sideSegment.from.x, y: (sideSegment.from.y + sideSegment.to.y) / 2 }
            : manual ? { x: edge.CanvasBendX, y: edge.CanvasBendY }
            : points.length > 3 && horizontal ? { x: points[2].x, y: (points[2].y + points[3].y) / 2 }
              : points.length > 3 ? { x: (points[2].x + points[3].x) / 2, y: points[2].y }
                : midpoint(points);
          if (!hasWaypoints && !route.mergeKey && (manual || self || points.length > 4))
            svg('rect', { x: bend.x - 5, y: bend.y - 5, width: 10, height: 10, class: 'edge-bend-handle', 'data-axis': sideSegment ? 'x' : self ? horizontal ? 'x' : 'y' : 'both' }, group);
          (edge.CanvasWaypoints || []).forEach((waypoint, waypointIndex) => svg('rect', {
            x: waypoint.x - 5, y: waypoint.y - 5, width: 10, height: 10,
            class: 'edge-bend-handle edge-waypoint-handle', 'data-waypoint-index': waypointIndex,
          }, group));
          (edge.CanvasMergeWaypoints || []).forEach((waypoint, waypointIndex) => svg('rect', {
            x: waypoint.x - 5, y: waypoint.y - 5, width: 10, height: 10,
            class: 'edge-bend-handle edge-waypoint-handle', 'data-merge-waypoint-index': waypointIndex,
          }, group));
          (edge.CanvasMergeLaneAnchors || []).forEach((waypoint, waypointIndex) => svg('rect', {
            x: route.mergeLaneX - 5, y: waypoint.y - 5, width: 10, height: 10,
            class: 'edge-bend-handle edge-waypoint-handle edge-merge-anchor', 'data-merge-lane-anchor-index': waypointIndex,
          }, group));
          const sharedRange = route.mergeKey ? sharedTrunkRange(routes, route.mergeKey, route.mergeLaneX) : null;
          const lastEditableSegment = route.mergeKey ? points.length - 4 : points.length - 3;
          for (let segmentIndex = 1; segmentIndex <= lastEditableSegment; segmentIndex++) {
            const from = points[segmentIndex], to = points[segmentIndex + 1];
            const dx = Math.abs(to.x - from.x), dy = Math.abs(to.y - from.y);
            if (dx + dy < 8 || (dx > .1 && dy > .1)) continue;
            const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
            const shared = Boolean(sharedRange && dx < .1 && Math.abs(middle.x - route.mergeLaneX) < .1
              && middle.y >= sharedRange.top - 1 && middle.y <= sharedRange.bottom + 1);
            const mergeJoin = isMergeJoinSegment(route, segmentIndex);
            svg('rect', { x: middle.x - 5, y: middle.y - 5, width: 10, height: 10,
              class: `edge-segment-handle${shared || mergeJoin ? ' shared' : ''}`, 'data-segment-index': segmentIndex,
              'data-shared-segment': shared ? 'true' : 'false', 'data-merge-join': mergeJoin ? 'true' : 'false' }, group);
          }
          [points[0], points[points.length - 1]].forEach((p, i) => svg('circle', { cx: p.x, cy: p.y, r: 6, class: 'edge-end-handle', 'data-end': i === 0 ? 'from' : 'to' }, group));
        }
      });
      f.Nodes.forEach(target => (target.Parameters || []).filter(p => p.SourceNodeId && p.SourceParameterName).forEach(parameter => {
        const source = f.Nodes.find(node => node.NodeId === parameter.SourceNodeId);
        if (!source || !layout()[source.NodeId] || !layout()[target.NodeId]) return;
        const a = anchor(source, layout()[source.NodeId], 'e', .7), b = anchor(target, layout()[target.NodeId], 'w', .7);
        const midX = (a.x + b.x) / 2;
        svg('path', { d: path([a, { x: midX, y: a.y }, { x: midX, y: b.y }, b]), class: 'data-edge' });
        svg('text', { x: midX + 8, y: (a.y + b.y) / 2 - 5, class: 'data-edge-label' }).textContent = `${parameter.SourceParameterName} → ${parameter.Name}`;
      }));
      bridgeCrossings(routes).forEach(bridge => {
        const bridgeRoute = routes[bridge.index];
        const alignment = bridgeRoute && verticalAlignmentState(bridgeRoute.edge, f, outgoingCount, incomingCount);
        const group = svg('g', { class: `edge-bridge${alignment ? ` alignment-${alignment}` : ''}${ui.edge === bridge.index ? ' selected' : ''}`, 'aria-hidden': 'true' });
        const gap = bridge.orientation === 'h'
          ? `M ${bridge.x} ${bridge.y - 8} L ${bridge.x} ${bridge.y + 8}`
          : `M ${bridge.x - 8} ${bridge.y} L ${bridge.x + 8} ${bridge.y}`;
        const arch = bridge.orientation === 'h'
          ? `M ${bridge.x - 9} ${bridge.y} L ${bridge.x - 5} ${bridge.y} Q ${bridge.x} ${bridge.y - 9} ${bridge.x + 5} ${bridge.y} L ${bridge.x + 9} ${bridge.y}`
          : `M ${bridge.x} ${bridge.y - 9} L ${bridge.x} ${bridge.y - 5} Q ${bridge.x + 9} ${bridge.y} ${bridge.x} ${bridge.y + 5} L ${bridge.x} ${bridge.y + 9}`;
        svg('path', { d: gap, class: 'edge-bridge-gap' }, group);
        svg('path', { d: arch, class: 'edge-bridge-arc' }, group);
      });
      renderEdgeHover(routes, f);
      if (ui.connection) drawConnectionPreview(ui.connection);
    }

    function nearestRouteSegment(points, point) {
      let best = null;
      for (let index = 0; index < points.length - 1; index++) {
        const a = points[index], b = points[index + 1], dx = b.x - a.x, dy = b.y - a.y;
        const lengthSquared = dx * dx + dy * dy;
        if (lengthSquared < .01) continue;
        const ratio = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared, 0, 1);
        const projected = { x: a.x + ratio * dx, y: a.y + ratio * dy };
        const distance = Math.hypot(point.x - projected.x, point.y - projected.y);
        if (!best || distance < best.distance) best = { index, point: projected, distance,
          orientation: Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v' };
      }
      return best;
    }
    function normalizedRouteBody(start, body, end) {
      if (!start || !end) return (body || []).map(point => ({ x: point.x, y: point.y }));
      const reduced = [{ x: start.x, y: start.y }];
      [...(body || []), end].forEach(point => {
        const next = { x: Number(point.x), y: Number(point.y) };
        if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) return;
        const previous = reduced[reduced.length - 1];
        if (Math.abs(previous.x - next.x) < .1 && Math.abs(previous.y - next.y) < .1) return;
        while (reduced.length > 1) {
          const before = reduced[reduced.length - 2], last = reduced[reduced.length - 1];
          const sameColumn = Math.abs(before.x - last.x) < .1 && Math.abs(last.x - next.x) < .1;
          const sameRow = Math.abs(before.y - last.y) < .1 && Math.abs(last.y - next.y) < .1;
          if (!sameColumn && !sameRow) break;
          reduced.pop();
        }
        reduced.push(next);
      });
      return reduced.slice(1, -1);
    }
    function saveRoutePoints(edge, points, firstOrientation) {
      const waypoints = [];
      const start = points[1] || points[0], targetLead = points[points.length - 2];
      const body = normalizedRouteBody(start, points.slice(2, -2), targetLead);
      let previous = start;
      body.forEach((point, index) => {
        const fallback = index === 0 ? firstOrientation || 'v' : 'v';
        const orientation = routeOrientation(previous, point, fallback);
        waypoints.push({ x: point.x, y: point.y, orientation });
        previous = point;
      });
      if (waypoints.length) edge.CanvasWaypoints = waypoints;
      else delete edge.CanvasWaypoints;
      if (targetLead && previous) edge.CanvasRouteOrientation = routeOrientation(previous, targetLead, firstOrientation || 'v');
      else delete edge.CanvasRouteOrientation;
      delete edge.CanvasBendX; delete edge.CanvasBendY; delete edge.CanvasMergeJoinY;
      delete edge.CanvasMergeWaypoints; delete edge.CanvasMergeBranchY;
    }
    function saveMergedBranchPoints(edge, points, laneX, firstOrientation) {
      const laneEntry = points.findIndex((point, index) => index >= 2 && Math.abs(point.x - laneX) < .1
        && Math.abs(points[index - 1].x - laneX) >= .1);
      const lanePoint = laneEntry >= 0 ? points[laneEntry] : null;
      const body = normalizedRouteBody(points[1] || points[0],
        laneEntry < 0 ? points.slice(2, -2) : points.slice(2, laneEntry),
        lanePoint || points[points.length - 2]);
      const waypoints = [];
      let previous = points[1] || points[0];
      body.forEach((point, index) => {
        const orientation = routeOrientation(previous, point, index === 0 ? firstOrientation || 'v' : 'v');
        waypoints.push({ x: point.x, y: point.y, orientation });
        previous = point;
      });
      if (waypoints.length) edge.CanvasMergeWaypoints = waypoints;
      else delete edge.CanvasMergeWaypoints;
      if (waypoints.length) edge.CanvasMergeBranchY = waypoints[waypoints.length - 1].y;
      else if (lanePoint) edge.CanvasMergeBranchY = lanePoint.y;
      delete edge.CanvasWaypoints; delete edge.CanvasBendX; delete edge.CanvasBendY;
    }
    function makeSegmentDrag(index, segmentIndex, pointer, isShared = false) {
      const route = transitionRoutes(flow(), layout())[index];
      const lastEditableSegment = route && (route.mergeKey ? route.points.length - 4 : route.points.length - 3);
      if (!route || segmentIndex < 1 || segmentIndex > lastEditableSegment) return null;
      const from = route.points[segmentIndex], to = route.points[segmentIndex + 1];
      const dx = Math.abs(to.x - from.x), dy = Math.abs(to.y - from.y);
      if (dx + dy < 1 || (dx > .1 && dy > .1)) return null;
      const axis = dx > .1 ? 'y' : 'x';
      const sharedRange = route.mergeKey ? sharedTrunkRange(transitionRoutes(flow(), layout()), route.mergeKey, route.mergeLaneX) : null;
      const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      return { type: 'segment', index, segmentIndex, axis, orientation: axis === 'y' ? 'h' : 'v',
        shared: Boolean(route.mergeKey && (isShared || (sharedRange && axis === 'x'
          && Math.abs(middle.x - route.mergeLaneX) < .1
          && middle.y >= sharedRange.top - 1 && middle.y <= sharedRange.bottom + 1))),
        mergeJoin: Boolean(route.mergeKey && isMergeJoinSegment(route, segmentIndex)),
        laneX: route.mergeLaneX, mergeKey: route.mergeKey, x: pointer.x, y: pointer.y,
        mergeJoinRange: route.mergeJoinRange,
        coordinate: axis === 'y' ? from.y : from.x, points: clone(route.points), before: snapshot(), routeSnapshot: true, moved: false };
    }
    function beginWaypointDrag(type, index, waypointIndex, pointer) {
      return { type, index, waypointIndex, x: pointer.x, y: pointer.y, before: snapshot(), routeSnapshot: true, moved: false };
    }
    function cancelRouteDrag(drag) {
      if (!drag || !drag.routeSnapshot || !drag.moved) return false;
      restore(drag.before);
      ui.edge = drag.index;
      adapter.setSelected(null);
      render(); adapter.selectionChanged();
      return true;
    }

    function snappedDragDelta(drag, dx, dy) {
      const primary = flow().Nodes.find(node => node.NodeId === drag.id)
        || flow().Nodes.find(node => drag.origins[node.NodeId]);
      if (!primary) return { x: 0, y: 0 };
      const origin = drag.origins[primary.NodeId], size = nodeSize(primary);
      return {
        x: snapNodeAxis(origin.x + dx, size.width) - (origin.x + dx),
        y: snapNodeAxis(origin.y + dy, size.height) - (origin.y + dy)
      };
    }

    function clearAlignmentGuides() {
      guideRoot.replaceChildren();
      nodesRoot.querySelectorAll('.flow-node.aligning,.flow-node.alignment-offset').forEach(node => node.classList.remove('aligning', 'alignment-offset'));
    }

    function updateAlignmentGuides(drag, dx, dy) {
      clearAlignmentGuides();
      const movedIds = new Set(Object.keys(drag.origins));
      const fixedNodes = flow().Nodes.filter(node => !movedIds.has(node.NodeId));
      if (!fixedNodes.length) return { dx: 0, dy: 0 };
      // A grid-snapped node can be up to half a cell from an arbitrary alignment target.
      const threshold = snapEnabled() ? Math.max(7 / ui.zoom, GRID_STEP / 2) : 7 / ui.zoom;
      const best = { x: null, y: null };
      const movingNodes = flow().Nodes.filter(node => movedIds.has(node.NodeId));
      const linkedIds = new Set(flow().Transitions.flatMap(edge => movedIds.has(edge.FromNodeId) ? [edge.ToNodeId]
        : movedIds.has(edge.ToNodeId) ? [edge.FromNodeId] : []));
      const snappedDelta = snappedDragDelta(drag, dx, dy);
      const features = (position, size, axis) => axis === 'x'
        ? [position.x, position.x + size.width / 2, position.x + size.width]
        : [position.y, position.y + size.height / 2, position.y + size.height];
      movingNodes.forEach(moving => {
        const origin = drag.origins[moving.NodeId];
        const movingPosition = { x: origin.x + dx + snappedDelta.x, y: origin.y + dy + snappedDelta.y };
        const movingSize = nodeSize(moving);
        fixedNodes.forEach(fixed => {
          const fixedPosition = layout()[fixed.NodeId];
          const fixedSize = nodeSize(fixed);
          const isConnected = flow().Transitions.some(edge =>
            (edge.FromNodeId === moving.NodeId && edge.ToNodeId === fixed.NodeId)
            || (edge.ToNodeId === moving.NodeId && edge.FromNodeId === fixed.NodeId));
          ['x', 'y'].forEach(axis => {
            const a = features(movingPosition, movingSize, axis);
            const b = features(fixedPosition, fixedSize, axis);
            a.forEach((coordinate, index) => {
              const delta = b[index] - coordinate;
              const priority = index === 1 && isConnected ? 0 : 1;
              if (Math.abs(delta) > threshold || (best[axis]
                && (priority > best[axis].priority
                  || priority === best[axis].priority && Math.abs(delta) >= Math.abs(best[axis].delta)))) return;
              const spanStart = axis === 'x' ? Math.min(movingPosition.y, fixedPosition.y) : Math.min(movingPosition.x, fixedPosition.x);
              const spanEnd = axis === 'x'
                ? Math.max(movingPosition.y + movingSize.height, fixedPosition.y + fixedSize.height)
                : Math.max(movingPosition.x + movingSize.width, fixedPosition.x + fixedSize.width);
              best[axis] = { delta, priority, target: b[index], start: Math.max(0, spanStart - 24), end: spanEnd + 24, fixedId: fixed.NodeId, movingId: moving.NodeId };
            });
          });
        });
      });
      const matches = new Set();
      guideRoot.setAttribute('width', ui.extent.width); guideRoot.setAttribute('height', ui.extent.height);
      guideRoot.setAttribute('viewBox', `0 0 ${ui.extent.width} ${ui.extent.height}`);
      ['x', 'y'].forEach(axis => {
        const match = best[axis];
        if (!match) return;
        matches.add(match.fixedId); matches.add(match.movingId);
        if (axis === 'x') {
          svg('line', { x1: match.target, x2: match.target, y1: match.start, y2: match.end, class: 'alignment-guide alignment-guide-vertical' }, guideRoot);
        } else {
          svg('line', { x1: match.start, x2: match.end, y1: match.target, y2: match.target, class: 'alignment-guide alignment-guide-horizontal' }, guideRoot);
        }
      });
      matches.forEach(id => nodesRoot.querySelector(`[data-node-id="${CSS.escape(id)}"]`)?.classList.add('aligning'));
      // Show the center alignment of the dragged node against its closest connected
      // stationary node. A nearby unrelated edge must not make this relation green.
      const moving = movingNodes.find(node => node.NodeId === drag.id) || movingNodes[0];
      const movingOrigin = drag.origins[moving.NodeId];
      const movingSize = nodeSize(moving);
      const movingPosition = { x: movingOrigin.x + dx + snappedDelta.x + (best.x?.delta || 0),
        y: movingOrigin.y + dy + snappedDelta.y + (best.y?.delta || 0) };
      const movingCenter = { x: movingPosition.x + movingSize.width / 2, y: movingPosition.y + movingSize.height / 2 };
      const connectedIds = new Set(flow().Transitions.flatMap(edge => edge.FromNodeId === moving.NodeId ? [edge.ToNodeId]
        : edge.ToNodeId === moving.NodeId ? [edge.FromNodeId] : []));
      const reference = fixedNodes.filter(node => layout()[node.NodeId]).map(node => {
        const position = layout()[node.NodeId], size = nodeSize(node);
        const center = { x: position.x + size.width / 2, y: position.y + size.height / 2 };
        return { node, position, size, center,
          distance: Math.hypot(center.x - movingCenter.x, center.y - movingCenter.y) };
      }).sort((a, b) => Number(connectedIds.has(b.node.NodeId)) - Number(connectedIds.has(a.node.NodeId))
        || a.distance - b.distance)[0];
      if (reference) {
        const aligned = Math.abs(reference.center.x - movingCenter.x) < 0.01;
        const top = Math.max(0, Math.min(reference.position.y, movingPosition.y) - 24);
        const bottom = Math.max(reference.position.y + reference.size.height, movingPosition.y + movingSize.height) + 24;
        if (aligned) {
          svg('line', { x1: reference.center.x, x2: reference.center.x, y1: top, y2: bottom,
            class: 'alignment-guide alignment-guide-center' }, guideRoot);
          [moving.NodeId, reference.node.NodeId].forEach(id =>
            nodesRoot.querySelector(`[data-node-id="${CSS.escape(id)}"]`)?.classList.add('aligning'));
        } else {
          const gapY = movingPosition.y - 15;
          svg('line', { x1: reference.center.x, x2: reference.center.x, y1: top, y2: bottom,
            class: 'alignment-offset-guide' }, guideRoot);
          svg('line', { x1: reference.center.x, x2: movingCenter.x, y1: gapY, y2: gapY,
            class: 'alignment-offset-guide alignment-offset-gap' }, guideRoot);
          nodesRoot.querySelector(`[data-node-id="${CSS.escape(moving.NodeId)}"]`)?.classList.add('alignment-offset');
        }
      }
      return { dx: best.x?.delta || 0, dy: best.y?.delta || 0 };
    }

    function render() {
      clearAlignmentGuides();
      const f = flow();
      if (!f) { nodesRoot.innerHTML = ''; edgeRoot.innerHTML = ''; return; }
      const key = `${f.FlowId}::${f.StationId}`;
      if (ui.key !== key) { reset(); ui.key = key; ui.zoom = 1; viewport.scrollLeft = 0; viewport.scrollTop = 0; }
      const selected = adapter.getSelected();
      if (selected && !ui.selected.has(selected)) { ui.selected = new Set([selected]); ui.edge = null; }
      ui.selected = new Set([...ui.selected].filter(id => f.Nodes.some(node => node.NodeId === id)));
      const extent = f.Nodes.reduce((b, node) => {
        const p = layout()[node.NodeId] || { x: 60, y: 60 }, size = nodeSize(node);
        return { width: Math.max(b.width, p.x + size.width + 250), height: Math.max(b.height, p.y + size.height + 300) };
      }, { width: 1200, height: 900 });
      f.Transitions.forEach(edge => {
        extent.width = Math.max(extent.width, (Number(edge.CanvasBendX) || 0) + 150);
        extent.height = Math.max(extent.height, (Number(edge.CanvasBendY) || 0) + 150);
        if (Number.isFinite(Number(edge.CanvasMergeLaneX))) extent.width = Math.max(extent.width, Number(edge.CanvasMergeLaneX) + 150);
        if (Number.isFinite(Number(edge.CanvasMergeBranchY))) extent.height = Math.max(extent.height, Number(edge.CanvasMergeBranchY) + 150);
        [...(edge.CanvasWaypoints || []), ...(edge.CanvasMergeWaypoints || [])].forEach(point => {
          const x = Number(point.x), y = Number(point.y);
          if (Number.isFinite(x)) extent.width = Math.max(extent.width, x + 150);
          if (Number.isFinite(y)) extent.height = Math.max(extent.height, y + 150);
        });
        (edge.CanvasMergeLaneAnchors || []).forEach(point => {
          if (Number.isFinite(Number(point.y))) extent.height = Math.max(extent.height, Number(point.y) + 150);
        });
      });
      ui.extent = extent;
      const routes = transitionRoutes(f, layout());
      canvas.style.width = `${extent.width}px`; canvas.style.height = `${extent.height}px`;
      edgeRoot.setAttribute('width', extent.width); edgeRoot.setAttribute('height', extent.height);
      edgeRoot.setAttribute('viewBox', `0 0 ${extent.width} ${extent.height}`);
      nodesRoot.innerHTML = f.Nodes.map(node => {
        const p = layout()[node.NodeId], size = nodeSize(node), method = adapter.methodFor(node);
        const control = ['Start', 'End'].includes(node.NodeType);
        const outcomes = node.NodeType === 'End' ? [] : outcomesFor(method, node);
        const glyph = ({ Start: '开始', End: '结束', Condition: '?', Wait: '等待', Alarm: '!' })[node.NodeType] || 'ƒ';
        return `<div class="flow-node kind-${esc((node.NodeType || 'Action').toLowerCase())}${ui.selected.has(node.NodeId) ? ' selected' : ''}${!control && !method ? ' unbound' : ''}" data-node-id="${esc(node.NodeId)}" style="left:${p.x}px;top:${p.y}px;width:${size.width}px;height:${size.height}px" tabindex="-1" role="group" aria-label="${esc(node.DisplayName || node.NodeId)}">
          <div class="node-surface"></div><div class="node-content"><span class="node-type-mark">${glyph}</span><strong class="node-title">${esc(node.DisplayName || node.NodeId)}</strong><span class="node-method" title="${esc(node.MethodId)}">${esc(method ? method.ReturnType || 'int' : control ? node.NodeId : '未绑定方法')}</span></div>
          ${['n', 'e', 's', 'w'].map(side => `<button class="node-port port-${side}" data-port="${side}" title="拖动连线" aria-label="${esc(node.NodeId)} ${side} 连接点"></button>`).join('')}
          ${outcomes.length ? `<div class="node-outcomes">${outcomes.map((code, i) => {
            const connectedRoute = routes.find(route => route.edge.FromNodeId === node.NodeId && String(route.edge.Outcome) === String(code));
            const sideRoute = connectedRoute && ['e', 'w'].includes(connectedRoute.edge.CanvasSourcePort || 's') ? connectedRoute : null;
            const ratio = outcomeRatio(method, node, outcomes, code);
            const labelPoint = sideRoute && (sideRoute.labelPoint || midpoint(sideRoute.points));
            const sourcePort = connectedRoute ? connectedRoute.edge.CanvasSourcePort || 's' : node.NodeType === 'Condition' && i > 0 ? 'e' : 's';
            const sourceRatio = connectedRoute ? connectedRoute.edge.CanvasSourceRatio == null ? .5 : Number(connectedRoute.edge.CanvasSourceRatio)
              : node.NodeType === 'Condition' ? .5 : ratio;
            const conditionAnchor = node.NodeType === 'Condition' && connectedRoute ? anchor(node, p, sourcePort, sourceRatio) : null;
            const badgeOffset = ({ n: [0, -16], s: [0, 16], w: [-24, 0], e: [24, 0] })[sourcePort] || [0, 16];
            const position = node.NodeType === 'Condition' ? conditionAnchor
              ? ` style="left:${conditionAnchor.x - p.x + badgeOffset[0]}px;top:${conditionAnchor.y - p.y + badgeOffset[1]}px;transform:translate(-50%,-50%)"` : '' : sideRoute
              ? ` style="left:${labelPoint.x - p.x}px;top:${labelPoint.y - p.y - size.height - 5}px;transform:translate(-50%,-50%)"`
              : ` style="left:${ratio * 100}%;transform:translateX(-50%)"`;
            return `<button class="outcome-port${node.NodeType === 'Condition' ? i === 0 ? ' condition-true' : ' condition-false' : ''}${(method && method.AlarmStatusCodes || []).map(String).includes(code) || code === 'false' ? ' alternate' : ''}" data-port="${sourcePort}" data-outcome="${esc(code)}" data-ratio="${sourceRatio}"${position} title="拖动连接 ${esc(code)} 分支">${esc(code)}</button>`;
          }).join('')}</div>` : ''}
          <span class="node-resize-handle" title="拖动调整大小"></span></div>`;
      }).join('');
      renderEdges(); updateScale(); historyButtons();
    }

    function nearestPort(node, p) {
      const pos = layout()[node.NodeId], size = nodeSize(node);
      const values = [{ side: 'n', d: Math.abs(p.y - pos.y) }, { side: 's', d: Math.abs(p.y - pos.y - size.height) },
        { side: 'w', d: Math.abs(p.x - pos.x) }, { side: 'e', d: Math.abs(p.x - pos.x - size.width) }];
      return values.sort((a, b) => a.d - b.d)[0].side;
    }
    function connect(sourceId, targetId, options = {}) {
      const f = flow(), source = f.Nodes.find(n => n.NodeId === sourceId), target = f.Nodes.find(n => n.NodeId === targetId);
      if (!source || !target || source.NodeType === 'End' || target.NodeType === 'Start') { status('开始节点没有输入，结束节点没有输出'); return false; }
      const valid = outcomesFor(adapter.methodFor(source), source);
      const used = new Set(f.Transitions.filter(edge => edge.FromNodeId === sourceId).map(edge => edge.Outcome));
      const outcome = options.outcome || valid.find(code => !used.has(code));
      if (!outcome || !valid.includes(outcome)) { status('该方法的出口已连接；可选择现有连线修改终点'); return false; }
      if (used.has(outcome)) { status(`分支 ${outcome} 已连接；请重连原分支或修改标签`); return false; }
      if (sourceId === targetId && options.targetPort === options.sourcePort) options.targetPort = ({ s: 'n', n: 's', w: 'e', e: 'w' })[options.sourcePort];
      const edge = { FromNodeId: sourceId, ToNodeId: targetId, Outcome: outcome,
        Priority: f.Transitions.filter(edge => edge.FromNodeId === sourceId).length + 1,
        CanvasSourcePort: options.sourcePort || 's', CanvasTargetPort: options.targetPort || 'n',
        CanvasSourceRatio: options.ratio == null ? .5 : options.ratio };
      if (options.waypoints && options.waypoints.length) {
        edge.CanvasWaypoints = options.waypoints.map(point => ({ x: point.x, y: point.y, orientation: point.orientation }));
        edge.CanvasRouteOrientation = options.routeOrientation || 'v';
      }
      change(() => f.Transitions.push(edge));
      status(`已连接 ${sourceId} → ${targetId}，返回 ${outcome}`);
      return true;
    }
    function deleteSelection() {
      if (!flow() || (ui.edge == null && !ui.selected.size)) return;
      change(() => {
        if (ui.edge != null) { flow().Transitions.splice(ui.edge, 1); ui.edge = null; }
        else {
          const ids = new Set(ui.selected);
          flow().Nodes = flow().Nodes.filter(node => !ids.has(node.NodeId));
          flow().Transitions = flow().Transitions.filter(edge => !ids.has(edge.FromNodeId) && !ids.has(edge.ToNodeId));
          flow().Nodes.forEach(node => (node.Parameters || []).forEach(parameter => { if (ids.has(parameter.SourceNodeId)) { delete parameter.SourceNodeId; delete parameter.SourceParameterName; parameter.Value = ''; } }));
          ids.forEach(id => delete layout()[id]);
          synchronizeEntryNode(flow());
          ui.selected.clear(); adapter.setSelected(null);
        }
      });
    }
    function copy() {
      if (!flow() || !ui.selected.size) return;
      const ids = ui.selected;
      ui.clipboard = { nodes: clone(flow().Nodes.filter(node => ids.has(node.NodeId))),
        edges: clone(flow().Transitions.filter(edge => ids.has(edge.FromNodeId) && ids.has(edge.ToNodeId))),
        layout: clone(Object.fromEntries([...ids].map(id => [id, layout()[id]]))) };
      status(`已复制 ${ids.size} 个节点`);
    }
    function paste() {
      if (!flow() || !ui.clipboard) return;
      change(() => {
        const map = new Map(); ui.selected.clear();
        ui.clipboard.nodes.forEach(original => {
          let id, index = flow().Nodes.length + 1;
          do { id = `N${String(index++).padStart(3, '0')}`; } while (flow().Nodes.some(node => node.NodeId === id));
          map.set(original.NodeId, id); const node = clone(original); node.NodeId = id;
          const p = ui.clipboard.layout[original.NodeId]; layout()[id] = { x: p.x + 40, y: p.y + 40 };
          if (node.NodeType === 'Start') {
            if (flow().Nodes.some(n => n.NodeType === 'Start')) { node.NodeType = 'Action'; node.DisplayName += ' 副本'; }
            else flow().EntryNodeId = id;
          }
          flow().Nodes.push(node); ui.selected.add(id);
        });
        flow().Nodes.filter(node => ui.selected.has(node.NodeId)).forEach(node => (node.Parameters || []).forEach(parameter => { if (map.has(parameter.SourceNodeId)) parameter.SourceNodeId = map.get(parameter.SourceNodeId); }));
        ui.clipboard.edges.forEach(original => {
          const edge = clone(original); edge.FromNodeId = map.get(original.FromNodeId); edge.ToNodeId = map.get(original.ToNodeId);
          if (Number.isFinite(edge.CanvasBendX)) edge.CanvasBendX += 40;
          if (Number.isFinite(edge.CanvasBendY)) edge.CanvasBendY += 40;
          (edge.CanvasWaypoints || []).forEach(point => { point.x += 40; point.y += 40; });
          if (Number.isFinite(edge.CanvasMergeLaneX)) edge.CanvasMergeLaneX += 40;
          if (Number.isFinite(edge.CanvasMergeBranchY)) edge.CanvasMergeBranchY += 40;
          (edge.CanvasMergeWaypoints || []).forEach(point => { point.x += 40; point.y += 40; });
          (edge.CanvasMergeLaneAnchors || []).forEach(point => { point.y += 40; });
          flow().Transitions.push(edge);
        });
        synchronizeEntryNode(flow());
        adapter.setSelected([...ui.selected].pop()); ui.edge = null;
      });
    }
    function cut() {
      if (!flow() || !ui.selected.size) return;
      copy();
      deleteSelection();
      status(`已剪切 ${ui.clipboard.nodes.length} 个节点`);
    }
    function editText(value, x, y, apply) {
      document.querySelectorAll('.canvas-inline-edit').forEach(input => input.remove());
      const input = document.createElement('input'); input.className = 'canvas-inline-edit'; input.value = value;
      input.style.left = `${clamp(x - 80, 10, window.innerWidth - 230)}px`; input.style.top = `${clamp(y - 18, 10, window.innerHeight - 60)}px`;
      document.body.appendChild(input); input.focus(); input.select(); let done = false;
      const finish = save => { if (done) return; done = true; if (save && input.value.trim() && input.value.trim() !== value) change(() => apply(input.value.trim())); input.remove(); };
      input.addEventListener('keydown', event => { if (event.key === 'Enter') finish(true); else if (event.key === 'Escape') finish(false); event.stopPropagation(); });
      input.addEventListener('blur', () => finish(true));
    }
    function preview(start, end) {
      edgeRoot.querySelector('.connection-preview')?.remove();
      svg('path', { class: 'connection-preview', d: path([start, { x: start.x, y: (start.y + end.y) / 2 }, { x: end.x, y: (start.y + end.y) / 2 }, end]) });
    }
    function drawConnectionPreview(connection) {
      const source = flow()?.Nodes.find(node => node.NodeId === connection.source);
      if (!source || !layout()[source.NodeId]) return;
      const sourcePort = connection.port || 's';
      const start = anchor(source, layout()[source.NodeId], sourcePort, connection.ratio);
      const normals = { n: [0, -28], s: [0, 28], w: [-28, 0], e: [28, 0] };
      const normal = normals[sourcePort] || normals.s;
      const first = { x: start.x + normal[0], y: start.y + normal[1] };
      const points = [start, first];
      let previous = first;
      (connection.anchors || []).forEach(waypoint => {
        const point = { x: waypoint.x, y: waypoint.y };
        appendOrthogonal(points, previous, point, waypoint.orientation || 'v');
        previous = point;
      });
      const cursor = connection.mergeTarget?.point || connection.cursor || previous;
      appendOrthogonal(points, previous, cursor, connection.orientation || 'v');
      edgeRoot.querySelector('.connection-preview')?.remove();
      edgeRoot.querySelector('.connection-merge-point')?.remove();
      edgeRoot.querySelector('.connection-target-info')?.remove();
      svg('path', { class: `connection-preview${connection.mergeTarget ? ' merge-targeted' : ''}`, d: path(points) });
      if (connection.mergeTarget) {
        const mergePoint = connection.mergeTarget.point;
        svg('circle', { class: 'connection-merge-point', cx: mergePoint.x, cy: mergePoint.y, r: 6 });
        const graph = flow();
        const targetNode = graph?.Nodes.find(node => node.NodeId === connection.mergeTarget.targetId);
        const targetName = targetNode && (targetNode.DisplayName || targetNode.NodeId) || connection.mergeTarget.targetId;
        const incoming = (graph?.Transitions || []).filter(edge => edge.ToNodeId === connection.mergeTarget.targetId);
        const entries = incoming.slice(0, 4).map(edge => {
          const sourceNode = graph.Nodes.find(node => node.NodeId === edge.FromNodeId);
          return `${sourceNode && (sourceNode.DisplayName || sourceNode.NodeId) || edge.FromNodeId} · ${String(edge.Outcome || '*')}`;
        });
        if (incoming.length > entries.length) entries.push(`以及另外 ${incoming.length - entries.length} 条`);
        const lines = [`松开以汇入：${targetName}`, ...entries];
        const width = clamp(Math.max(...lines.map(line => [...line].length * 8 + 20)), 180, 420);
        const height = lines.length * 19 + 12;
        const position = connection.cursor || mergePoint;
        const x = clamp(position.x + 14, 8, Math.max(8, ui.extent.width - width - 8));
        const above = position.y - height - 14;
        const y = clamp(above >= 8 ? above : position.y + 14, 8, Math.max(8, ui.extent.height - height - 8));
        const info = svg('g', { class: 'connection-target-info', 'pointer-events': 'none', 'aria-hidden': 'true' });
        svg('rect', { x, y, width, height, rx: 5 }, info);
        const text = svg('text', { x: x + width / 2, y: y + 19, 'text-anchor': 'middle' }, info);
        lines.forEach((line, lineIndex) => {
          const span = svg('tspan', { x: x + width / 2, dy: lineIndex ? 19 : 0 }, text);
          span.textContent = line;
        });
      }
    }
    function pointerDown(event) {
      if (!flow() || event.button > 1 || event.target.closest('input,select,textarea')) return;
      const p = pointFromClient(event.clientX, event.clientY), nodeEl = event.target.closest('.flow-node'), edgeEl = event.target.closest('[data-edge-index]');
      if (!nodeEl) ui.lastNodeClick = null;
      if (event.button === 1 || ui.space || ui.tool === 'pan') {
        event.preventDefault(); ui.drag = { type: 'pan', x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }; viewport.classList.add('panning'); return;
      }
      if (ui.connection) {
        if (event.target.closest('button') && !nodeEl) return;
        event.preventDefault();
        ui.drag = { type: 'connect-waypoint', start: p };
        updateConnectionPreview(ui.connection, p, event.target);
        return;
      }
      if (nodeEl) {
        event.preventDefault(); const id = nodeEl.dataset.nodeId, node = flow().Nodes.find(item => item.NodeId === id), port = event.target.closest('[data-port]');
        if (!node) return;
        if (port || ui.tool === 'connect') {
          ui.lastNodeClick = null;
          if (node.NodeType === 'End') return;
          updateEdgeHover(null);
          ui.connection = { source: id, port: port ? port.dataset.port : 's', ratio: Number(port && port.dataset.ratio) || .5,
            outcome: port && port.dataset.outcome, anchors: [], orientation: port && ['e', 'w'].includes(port.dataset.port) ? 'h' : 'v', cursor: p, mergeTarget: null };
          ui.drag = { type: 'connect', start: p };
          drawConnectionPreview(ui.connection); return;
        }
        const now = performance.now();
        const previousClick = ui.lastNodeClick;
        const isDoubleClick = previousClick && previousClick.id === id && now - previousClick.time <= 500
          && Math.hypot(event.clientX - previousClick.x, event.clientY - previousClick.y) <= 8;
        ui.lastNodeClick = isDoubleClick ? null : { id, time: now, x: event.clientX, y: event.clientY };
        if (isDoubleClick) {
          ui.drag = null;
          if (adapter.onNodeDoubleClick && adapter.onNodeDoubleClick(node, event)) return;
          if (!['Start', 'End'].includes(node.NodeType)) editText(node.DisplayName, event.clientX, event.clientY, value => { node.DisplayName = value; });
          return;
        }
        const resize = event.target.closest('.node-resize-handle');
        selectNode(id, event.ctrlKey || event.metaKey || event.shiftKey);
        if (!ui.selected.size) return;
        ui.drag = { type: resize ? 'resize' : 'nodes', id, x: p.x, y: p.y,
          origins: clone(Object.fromEntries([...ui.selected].map(key => [key, layout()[key]]))), size: nodeSize(node), moved: false };
        return;
      }
      if (edgeEl) {
        event.preventDefault();
        const index = Number(edgeEl.dataset.edgeIndex), wasSelected = ui.edge === index;
        ui.edge = index; ui.selected.clear(); adapter.setSelected(null);
        const waypoint = event.target.closest('[data-waypoint-index]');
        const mergeWaypoint = event.target.closest('[data-merge-waypoint-index]');
        const laneAnchor = event.target.closest('[data-merge-lane-anchor-index]');
        const bend = event.target.closest('.edge-bend-handle'), end = event.target.closest('.edge-end-handle');
        const segment = event.target.closest('.edge-segment-handle');
        if (waypoint) ui.drag = beginWaypointDrag('waypoint', index, Number(waypoint.dataset.waypointIndex), p);
        else if (mergeWaypoint) ui.drag = beginWaypointDrag('merge-waypoint', index, Number(mergeWaypoint.dataset.mergeWaypointIndex), p);
        else if (laneAnchor) ui.drag = beginWaypointDrag('merge-lane-anchor', index, Number(laneAnchor.dataset.mergeLaneAnchorIndex), p);
        else if (bend) ui.drag = { type: 'bend', index, axis: bend.dataset.axis, before: snapshot(), routeSnapshot: true, moved: false };
        if (end) {
          const edge = flow().Transitions[index], points = routePoints(edge, flow().Nodes, layout());
          ui.drag = { type: 'reconnect', index, end: end.dataset.end, start: end.dataset.end === 'from' ? points[points.length - 1] : points[0] };
        } else if (segment) {
          ui.drag = makeSegmentDrag(index, Number(segment.dataset.segmentIndex), p, segment.dataset.sharedSegment === 'true');
        } else if (!ui.drag && wasSelected && event.target.closest('.edge-hit')) {
          const route = transitionRoutes(flow(), layout())[index], nearest = route && nearestRouteSegment(route.points, p);
          if (nearest) ui.drag = makeSegmentDrag(index, nearest.index, p);
        }
        render(); adapter.selectionChanged(); return;
      }
      if (event.target.closest('button')) return;
      event.preventDefault();
      if (ui.tool.startsWith('shape:')) { adapter.addShape(ui.tool.slice(6), { x: Math.max(20, snap(p.x - 110)), y: Math.max(20, snap(p.y - 40)) }); setTool('select'); return; }
      ui.drag = { type: 'marquee', start: p, end: p, previous: event.shiftKey ? new Set(ui.selected) : new Set() };
      if (!event.shiftKey) { ui.selected.clear(); ui.edge = null; adapter.setSelected(null); render(); adapter.selectionChanged(); }
    }
    function pointerMove(event) {
      const p = pointFromClient(event.clientX, event.clientY);
      const d = ui.drag;
      if (!d) {
        if (ui.connection) {
          const target = event.target instanceof Element ? event.target : null;
          updateConnectionPreview(ui.connection, p, target && viewport.contains(target) ? target : null);
        }
        else {
          const target = event.target instanceof Element ? event.target : null;
          if (!target || !viewport.contains(target)) { updateEdgeHover(null); return; }
          const edge = target && target.closest('[data-edge-index]');
          let index = edge ? Number(edge.dataset.edgeIndex) : null;
          // The SVG hit path is intentionally generous, but transformed SVGs
          // and overlapping labels can still leave small gaps in pointer hit
          // testing. Pick the nearest workflow route within a screen-space
          // radius so hovering beside a wire still reveals its connection.
          if (index == null && target && !target.closest('.flow-node,button,input,select,textarea')) {
            let nearest = null;
            const radius = 12 / ui.zoom;
            transitionRoutes(flow(), layout()).forEach(route => {
              const segment = nearestRouteSegment(route.points, p);
              if (segment && segment.distance <= radius && (!nearest || segment.distance < nearest.distance))
                nearest = { index: route.index, distance: segment.distance };
            });
            index = nearest ? nearest.index : null;
          }
          updateEdgeHover(index, index == null ? null : p);
        }
        return;
      }
      if (d.type === 'pan') { viewport.scrollLeft = d.left - event.clientX + d.x; viewport.scrollTop = d.top - event.clientY + d.y; return; }
      if (d.type === 'connect' || d.type === 'connect-waypoint') {
        if (ui.connection) updateConnectionPreview(ui.connection, p, event.target instanceof Element ? event.target : null);
        return;
      }
      if (d.type === 'reconnect') { preview(d.start, p); return; }
      if (d.type === 'marquee') {
        d.end = p;
        let box = canvas.querySelector('.selection-marquee'); if (!box) { box = document.createElement('div'); box.className = 'selection-marquee'; canvas.appendChild(box); }
        Object.assign(box.style, { left: `${Math.min(p.x, d.start.x)}px`, top: `${Math.min(p.y, d.start.y)}px`, width: `${Math.abs(p.x - d.start.x)}px`, height: `${Math.abs(p.y - d.start.y)}px` }); return;
      }
      if (!d.moved && d.type !== 'bend' && Math.abs(p.x - d.x) + Math.abs(p.y - d.y) < 3) return;
      if (!d.moved) { recordBefore(); d.moved = true; }
      if (d.type === 'segment') {
        const edge = flow().Transitions[d.index], route = transitionRoutes(flow(), layout())[d.index];
        if (!edge || !route) return;
        const points = clone(d.points), index = d.segmentIndex;
        let coordinate = Math.max(20, snap(d.coordinate + (d.axis === 'y' ? p.y - d.y : p.x - d.x)));
        if (d.mergeJoin && d.mergeJoinRange && d.axis === 'y') {
          const lower = d.mergeJoinRange[0] + 8, upper = d.mergeJoinRange[1] - 8;
          if (upper >= lower) coordinate = clamp(coordinate, lower, upper);
        }
        if (!route.mergeKey && index === 1 && points.length === 4) {
          const sourceLead = points[1], targetLead = points[2];
          if (d.axis === 'x') points.splice(2, 0,
            { x: coordinate, y: sourceLead.y }, { x: coordinate, y: targetLead.y });
          else points.splice(2, 0,
            { x: sourceLead.x, y: coordinate }, { x: targetLead.x, y: coordinate });
          saveRoutePoints(edge, points, d.orientation);
          renderEdges(); return;
        }
        const moveIndex = pointIndex => { points[pointIndex][d.axis] = coordinate; };
        if (index === 1) moveIndex(index + 1);
        else if (index === points.length - 3) moveIndex(index);
        else { moveIndex(index); moveIndex(index + 1); }
        if (d.mergeJoin && route.mergeKey) {
          transitionRoutes(flow(), layout()).filter(item => item.mergeKey === d.mergeKey)
            .forEach(item => { item.edge.CanvasMergeJoinY = coordinate; });
        } else if (d.shared && route.mergeKey) {
          transitionRoutes(flow(), layout()).filter(item => item.mergeKey === d.mergeKey)
            .forEach(item => { item.edge.CanvasMergeLaneX = coordinate; });
        } else if (route.mergeKey) saveMergedBranchPoints(edge, points, d.laneX, d.orientation);
        else saveRoutePoints(edge, points, d.orientation);
        renderEdges(); return;
      }
      if (d.type === 'bend') {
        const edge = flow().Transitions[d.index];
        if (d.axis === 'both' || d.axis === 'x') edge.CanvasBendX = Math.max(20, snap(p.x));
        if (d.axis === 'both' || d.axis === 'y') edge.CanvasBendY = Math.max(20, snap(p.y));
        renderEdges(); return;
      }
      if (d.type === 'waypoint') {
        const edge = flow().Transitions[d.index], waypoint = edge && edge.CanvasWaypoints && edge.CanvasWaypoints[d.waypointIndex];
        if (waypoint) { waypoint.x = Math.max(20, snap(p.x)); waypoint.y = Math.max(20, snap(p.y)); }
        renderEdges(); return;
      }
      if (d.type === 'merge-waypoint') {
        const edge = flow().Transitions[d.index], waypoint = edge && edge.CanvasMergeWaypoints && edge.CanvasMergeWaypoints[d.waypointIndex];
        if (waypoint) { waypoint.x = Math.max(20, snap(p.x)); waypoint.y = Math.max(20, snap(p.y)); }
        renderEdges(); return;
      }
      if (d.type === 'merge-lane-anchor') {
        const edge = flow().Transitions[d.index], route = transitionRoutes(flow(), layout())[d.index];
        const waypoint = edge && edge.CanvasMergeLaneAnchors && edge.CanvasMergeLaneAnchors[d.waypointIndex];
        if (route && waypoint) {
          const lane = Math.max(20, snap(p.x));
          transitionRoutes(flow(), layout()).filter(item => item.mergeKey === route.mergeKey)
            .forEach(item => { item.edge.CanvasMergeLaneX = lane; });
          waypoint.y = Math.max(20, snap(p.y));
        }
        renderEdges(); return;
      }
      if (d.type === 'resize') {
        const node = flow().Nodes.find(n => n.NodeId === d.id);
        node.CanvasWidth = clamp(snap(d.size.width + p.x - d.x), 120, 1600); node.CanvasHeight = clamp(snap(d.size.height + p.y - d.y), 56, 1200);
        const el = nodesRoot.querySelector(`[data-node-id="${CSS.escape(d.id)}"]`); el.style.width = `${node.CanvasWidth}px`; el.style.height = `${node.CanvasHeight}px`;
      } else {
        let dx = p.x - d.x, dy = p.y - d.y;
        const minX = Math.min(...Object.values(d.origins).map(v => v.x)), minY = Math.min(...Object.values(d.origins).map(v => v.y));
        dx = Math.max(20 - minX, dx); dy = Math.max(20 - minY, dy);
        const alignment = updateAlignmentGuides(d, dx, dy);
        const snappedDelta = snappedDragDelta(d, dx, dy);
        Object.entries(d.origins).forEach(([id, origin]) => {
          const point = layout()[id]; point.x = origin.x + dx + snappedDelta.x + alignment.dx; point.y = origin.y + dy + snappedDelta.y + alignment.dy;
          const el = nodesRoot.querySelector(`[data-node-id="${CSS.escape(id)}"]`); if (el) { el.style.left = `${point.x}px`; el.style.top = `${point.y}px`; }
        });
      }
      renderEdges();
    }
    function pointerUp(event) {
      const d = ui.drag; if (!d) return;
      ui.drag = null; viewport.classList.remove('panning'); canvas.querySelector('.selection-marquee')?.remove();
      edgeRoot.querySelector('.connection-preview')?.remove(); edgeRoot.querySelector('.connection-merge-point')?.remove();
      edgeRoot.querySelector('.connection-target-info')?.remove(); clearAlignmentGuides();
      if (event.type === 'pointercancel') {
        if (d.type === 'connect' || d.type === 'connect-waypoint') ui.connection = null;
        else cancelRouteDrag(d);
        render(); return;
      }
      const p = pointFromClient(event.clientX, event.clientY);
      if (d.type === 'connect' || d.type === 'connect-waypoint') {
        const hitTarget = document.elementFromPoint(event.clientX, event.clientY);
        const targetEl = hitTarget?.closest('.flow-node');
        const connection = ui.connection;
        if (targetEl && connection) {
          const id = targetEl.dataset.nodeId, target = flow().Nodes.find(node => node.NodeId === id);
          const port = nearestPort(target, p);
          ui.connection = null;
          const connected = connect(connection.source, id, {
            sourcePort: connection.port, targetPort: port, ratio: connection.ratio, outcome: connection.outcome,
            waypoints: connection.anchors, routeOrientation: connection.orientation,
          });
          if (!connected) ui.connection = connection;
          render();
          return;
        }
        if (connection) {
          const mergeTarget = connectionTargetAt(p, hitTarget);
          setConnectionTarget(connection, mergeTarget);
          if (mergeTarget) {
            const mergeEdge = flow().Transitions[mergeTarget.index];
            const targetId = mergeEdge && mergeEdge.ToNodeId;
            if (targetId) {
              ui.connection = null;
              const connected = connect(connection.source, targetId, {
                sourcePort: connection.port, targetPort: 'n', ratio: connection.ratio, outcome: connection.outcome,
                waypoints: connection.anchors, routeOrientation: connection.orientation,
              });
              if (!connected) ui.connection = connection;
              else status(`已汇入 ${flow().Nodes.find(node => node.NodeId === targetId)?.DisplayName || targetId}`);
              render();
              return;
            }
          }
          const waypoint = { x: Math.max(20, snap(p.x)), y: Math.max(20, snap(p.y)), orientation: connection.orientation };
          const previous = connection.anchors[connection.anchors.length - 1];
          if (!previous || Math.abs(previous.x - waypoint.x) + Math.abs(previous.y - waypoint.y) > 1) connection.anchors.push(waypoint);
          connection.cursor = p;
          renderEdges();
          status(`已放置锚点；继续单击画布，按空格翻转方向，单击目标节点完成连线`);
          return;
        }
        render();
        return;
      }
      if (d.type === 'reconnect') {
        const targetEl = document.elementFromPoint(event.clientX, event.clientY)?.closest('.flow-node');
        if (!targetEl) { render(); return; }
        const id = targetEl.dataset.nodeId, target = flow().Nodes.find(node => node.NodeId === id), port = nearestPort(target, p);
        const edge = flow().Transitions[d.index];
        if ((d.end === 'from' && target.NodeType === 'End') || (d.end === 'to' && target.NodeType === 'Start')) return;
        const used = new Set(flow().Transitions.filter((item, index) => index !== d.index && item.FromNodeId === id).map(item => item.Outcome));
        const outcomes = outcomesFor(adapter.methodFor(target), target);
        const droppedOutcome = document.elementFromPoint(event.clientX, event.clientY)?.closest('.outcome-port[data-outcome]')?.dataset.outcome;
        const conditionOutcome = target.NodeType === 'Condition'
          ? port === 'e' ? outcomes[1] : port === 's' ? outcomes[0] : ''
          : '';
        const requestedOutcome = d.end === 'from' ? droppedOutcome || conditionOutcome : '';
        if (requestedOutcome && used.has(requestedOutcome)) {
          status(`分支 ${requestedOutcome} 已连接`); render(); return;
        }
        const nextOutcome = requestedOutcome || (outcomes.includes(edge.Outcome) && !used.has(edge.Outcome)
          ? edge.Outcome : outcomes.find(code => !used.has(code)));
        if (d.end === 'from' && !nextOutcome) { status('新起点的出口已全部连接'); render(); return; }
        change(() => { if (d.end === 'from') { edge.FromNodeId = id; edge.CanvasSourcePort = port; edge.Outcome = nextOutcome; }
          else { edge.ToNodeId = id; edge.CanvasTargetPort = port; } });
      } else if (d.type === 'marquee') {
        const left = Math.min(d.start.x, p.x), top = Math.min(d.start.y, p.y), right = Math.max(d.start.x, p.x), bottom = Math.max(d.start.y, p.y);
        ui.selected = d.previous;
        flow().Nodes.forEach(node => { const pos = layout()[node.NodeId], size = nodeSize(node); if (pos.x < right && pos.y < bottom && pos.x + size.width > left && pos.y + size.height > top) ui.selected.add(node.NodeId); });
        notifySelection();
      } else if (d.moved) refresh();
    }
    viewport.addEventListener('pointerdown', pointerDown);
    viewport.addEventListener('pointerleave', () => updateEdgeHover(null));
    document.addEventListener('pointermove', pointerMove);
    document.addEventListener('pointerup', pointerUp);
    document.addEventListener('pointercancel', pointerUp);
    viewport.addEventListener('dblclick', event => {
      const edgeEl = event.target.closest('[data-edge-index]');
      if (edgeEl) {
        const index = Number(edgeEl.dataset.edgeIndex), edge = flow().Transitions[index];
        if (event.target.closest('.edge-label,.edge-label-bg')) {
          editText(edge.Outcome, event.clientX, event.clientY, value => { edge.Outcome = value; });
          return;
        }
        const route = transitionRoutes(flow(), layout())[index], nearest = route && nearestRouteSegment(route.points, pointFromClient(event.clientX, event.clientY));
        if (!nearest || nearest.index < 1 || nearest.index > route.points.length - 4) return;
        const a = route.points[nearest.index], b = route.points[nearest.index + 1];
        const waypoint = nearest.orientation === 'h'
          ? { x: snap(nearest.point.x), y: a.y }
          : { x: a.x, y: snap(nearest.point.y) };
        const sharedRange = route.mergeKey ? sharedTrunkRange(transitionRoutes(flow(), layout()), route.mergeKey, route.mergeLaneX) : null;
        const onShared = Boolean(sharedRange && nearest.orientation === 'v'
          && Math.abs(a.x - route.mergeLaneX) < .1
          && waypoint.y >= sharedRange.top && waypoint.y <= sharedRange.bottom);
        change(() => {
          if (onShared) {
            edge.CanvasMergeLaneAnchors = edge.CanvasMergeLaneAnchors || [];
            edge.CanvasMergeLaneAnchors.push({ y: waypoint.y });
          } else if (route.mergeKey) {
            const points = clone(route.points);
            points.splice(nearest.index + 1, 0, waypoint);
            saveMergedBranchPoints(edge, points, route.mergeLaneX, nearest.orientation);
          } else {
            const points = clone(route.points);
            points.splice(nearest.index + 1, 0, waypoint);
            saveRoutePoints(edge, points, nearest.orientation);
          }
        });
        ui.edge = index; adapter.setSelected(null); render(); adapter.selectionChanged();
      }
    });
    viewport.addEventListener('wheel', event => { if (!flow()) return; event.preventDefault(); zoomTo(ui.zoom * Math.exp(-event.deltaY * .0012), event.clientX, event.clientY); }, { passive: false });
    document.addEventListener('keydown', event => {
      // Monaco uses a .native-edit-context element instead of a textarea. Treat the
      // whole editor as an input so canvas shortcuts (notably V) never eat typed text.
      if (event.target.closest('input,select,textarea,[contenteditable="true"],.monaco-editor,.native-edit-context')) return;
      const key = event.key.toLowerCase(), command = event.ctrlKey || event.metaKey;
      if (event.code === 'Space') {
        event.preventDefault();
        if (ui.connection) {
          if (!event.repeat) {
            ui.connection.orientation = ui.connection.orientation === 'h' ? 'v' : 'h';
            drawConnectionPreview(ui.connection);
            status(`已翻转布线方向：${ui.connection.orientation === 'h' ? '先横向' : '先纵向'}`);
          }
          return;
        }
        ui.space = true; viewport.classList.add('space-pan'); return;
      }
      const actions = command ? { z: event.shiftKey ? redo : undo, y: redo, x: cut, c: copy, v: paste, d: () => { copy(); paste(); }, a: () => { if (flow()) { ui.selected = new Set(flow().Nodes.map(n => n.NodeId)); ui.edge = null; notifySelection(); } } }
        : { delete: deleteSelection, backspace: deleteSelection, escape: () => { if (ui.drag?.routeSnapshot) cancelRouteDrag(ui.drag); ui.drag = null; ui.connection = null; ui.selected.clear(); ui.edge = null; adapter.setSelected(null); setTool('select'); render(); adapter.selectionChanged(); }, v: () => setTool('select'), h: () => setTool('pan'), c: () => setTool('connect'), '1': fit, '+': () => zoomTo(ui.zoom * 1.2), '=': () => zoomTo(ui.zoom * 1.2), '-': () => zoomTo(ui.zoom / 1.2) };
      if (actions[key]) { event.preventDefault(); actions[key](); return; }
      if (key.startsWith('arrow') && ui.selected.size) {
        event.preventDefault(); const delta = event.shiftKey ? 20 : 2;
        change(() => ui.selected.forEach(id => { const p = layout()[id]; p.x = Math.max(20, p.x + (key === 'arrowright' ? delta : key === 'arrowleft' ? -delta : 0)); p.y = Math.max(20, p.y + (key === 'arrowdown' ? delta : key === 'arrowup' ? -delta : 0)); }));
      }
    });
    document.addEventListener('keyup', event => { if (event.code === 'Space') { ui.space = false; viewport.classList.remove('space-pan'); } });
    window.addEventListener('blur', () => { if (ui.drag?.routeSnapshot) cancelRouteDrag(ui.drag); ui.space = false; ui.drag = null; ui.connection = null; viewport.classList.remove('space-pan', 'panning'); clearAlignmentGuides(); renderEdges(); });
    [['selectToolButton', () => setTool('select')], ['panToolButton', () => setTool('pan')], ['connectToolButton', () => setTool('connect')],
      ['undoButton', undo], ['redoButton', redo], ['deleteSelectionButton', deleteSelection], ['copySelectionButton', copy], ['pasteSelectionButton', paste],
      ['zoomInButton', () => zoomTo(ui.zoom * 1.2)], ['zoomOutButton', () => zoomTo(ui.zoom / 1.2)], ['fitButton', fit], ['arrangeButton', arrange]].forEach(([id, action]) => q(id)?.addEventListener('click', action));
    q('gridToggle')?.addEventListener('change', event => viewport.classList.toggle('no-grid', !event.target.checked));
    return { render, renderEdges, recordBefore, reset, fit, arrange, setTool, undo, redo, copy, paste, deleteSelection, pointFromClient, centerPoint,
      selectNodeById, selectEdgeByIndex,
      selectedEdge: () => ui.edge == null || !flow() ? null : { edge: flow().Transitions[ui.edge], index: ui.edge },
      clearEdgeSelection: () => { ui.edge = null; }, selectedIds: () => new Set(ui.selected) };
  }
  const api = { create, nodeSize, routePoints, transitionRoutes, anchor, outcomesFor, downwardRanks, arrangeDownward, synchronizeEntryNode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  host.EquipmentFlowCanvas = api;
})();
