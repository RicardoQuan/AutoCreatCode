# 向下整理线路修正计划

> **For agentic workers:** Execute the approved routing rules in this session; use an independent reviewer for the final diff.

**Goal:** 返回走左、主流程居中向下、跳转走右，保留所有连接与状态。

**Architecture:** 提取不依赖 DOM 的布局入口，沿用现有路线存储字段。修正自动侧边路线、汇流直连选择以及布尔状态与端口的耦合。

**Tech Stack:** JavaScript、Node 内置 node:test、现有 HTML/SVG 画布。

## 实施与检查

- [x] 在 `tests/canvas-routing.test.cjs` 复现自循环向右、回边穿节点、跳转穿过中心节点及主链误选回边。运行 `node tests/canvas-routing.test.cjs` 确认失败（直接运行避免受限环境中的子进程隔离）。
- [x] 修改 `src/AutoCreatCode/WebEditor/canvas-interactions.js`：提取 `arrangeDownward(graph, positions, methodFor)`；使用有效前向的 `0 / true / Succeeded` 作为首选后继；重建三类路线；只让前向中心主流程参与直连。
- [x] 修改 `src/AutoCreatCode/WebEditor/editor.js`：已有明确布尔状态不再被几何端口覆盖；画布出口按钮跟随实际端口。
- [x] 运行 12 项路线回归和 JavaScript 语法检查；用隔离的本地浏览器项目验证标图场景、真实拖动与布尔分支保存重开。
- [x] 同步原始 WebEditor 与发布项目的已修改源码；独立审查后更新 GitHub 源码。

## 验证结果

- `node tests/canvas-routing.test.cjs`：12 项通过，包含三类线路、汇流、多列、不同高度、重复整理和手动折点。
- `node --check`：两个修改过的 JavaScript 文件通过。
- Edge 使用隔离的本地示例项目：7 节点、9 条连接；按钮点击整理后 `1` 在左、`0` 中间直下、`false/9` 在右侧汇流。
- 真实鼠标拖动左侧回环干线后路线保持连通、正交；再次整理可清除旧折点。
- 将 `true` 分支布在右端口、`false` 分支布在下端口，保存重开仍保持原状态和目标。
- 独立代码审查完成，所发现的横段穿同层节点、底部出口避障穿自身、回环拖动轴问题均已修正并复核。
