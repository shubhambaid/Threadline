import { clientMain } from "./client.js";

/** The browser code, embedded as the source of `clientMain`, with `</script` made harmless. */
const CLIENT_SOURCE = `(${clientMain.toString()})();`.replace(/<\/(script)/gi, "<\\/$1");

const STYLES = String.raw`
:root {
  color-scheme: light dark;
  --bg: #f4f5f7;
  --panel: #ffffff;
  --panel-2: #f9fafb;
  --border: #e3e6eb;
  --border-strong: #cfd4dc;
  --text: #111827;
  --muted: #6b7280;
  --accent: #4f46e5;
  --accent-soft: #eef0ff;
  --task: #2563eb;
  --task-soft: #e8f0fe;
  --checkpoint: #7c3aed;
  --decision: #0f766e;
  --knowledge: #b45309;
  --pass: #15803d;
  --fail: #dc2626;
  --warn: #d97706;
  --warn-soft: #fef3c7;
  --error: #dc2626;
  --error-soft: #fee2e2;
  --ok: #15803d;
  --ok-soft: #dcfce7;
  --info: #0369a1;
  --info-soft: #e0f2fe;
  --disputed: #9333ea;
  --disputed-soft: #f3e8ff;
  --inferred: #8b5cf6;
  --edge: #9aa3b2;
  --lane-even: #fbfbfc;
  --lane-odd: #f5f6f8;
  --shadow: 0 1px 2px rgb(16 24 40 / 6%), 0 1px 3px rgb(16 24 40 / 8%);
  --radius: 10px;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --panel: #151b23;
    --panel-2: #10151c;
    --border: #262e39;
    --border-strong: #353f4c;
    --text: #e6e9ee;
    --muted: #9aa4b2;
    --accent: #8b93ff;
    --accent-soft: #232544;
    --task: #60a5fa;
    --task-soft: #16263d;
    --checkpoint: #a78bfa;
    --decision: #2dd4bf;
    --knowledge: #f59e0b;
    --pass: #4ade80;
    --fail: #f87171;
    --warn: #fbbf24;
    --warn-soft: #3a2e10;
    --error: #f87171;
    --error-soft: #3b1717;
    --ok: #4ade80;
    --ok-soft: #12301d;
    --info: #7dd3fc;
    --info-soft: #102a3a;
    --disputed: #c084fc;
    --disputed-soft: #2c1a3e;
    --inferred: #a78bfa;
    --edge: #5b6574;
    --lane-even: #121820;
    --lane-odd: #0f141b;
    --shadow: none;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--text);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
}
button, input, select { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.mono, code, pre { font-family: var(--mono); font-size: 12px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.nowrap { white-space: nowrap; }
.app { display: grid; grid-template-rows: auto minmax(0, 1fr); height: 100vh; }
.topbar {
  display: flex; align-items: center; gap: 16px; padding: 10px 18px;
  background: var(--panel); border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 8px; }
.logo {
  width: 18px; height: 18px; border-radius: 5px; transform: rotate(45deg) scale(.78);
  background: linear-gradient(135deg, var(--accent), var(--checkpoint));
}
.brand-name { font-weight: 650; letter-spacing: -.01em; font-size: 15px; }
.project { color: var(--muted); padding-left: 10px; border-left: 1px solid var(--border); }
.repo { display: flex; align-items: center; gap: 8px; }
.spacer { flex: 1; }
.health-summary {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--panel-2); cursor: pointer;
}
.health-summary:hover { border-color: var(--border-strong); }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-left: 4px; }
.dot:first-child { margin-left: 0; }
.dot-error { background: var(--error); }
.dot-warn { background: var(--warn); }
.dot-quiet { background: var(--border-strong); }
.live { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
.live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.live-off { background: var(--error); box-shadow: 0 0 0 3px var(--error-soft); }
.readonly {
  font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
  border: 1px solid var(--border); padding: 2px 8px; border-radius: 6px;
}
.body { display: grid; grid-template-columns: 250px minmax(0, 1fr) 372px; min-height: 0; }
.filters {
  overflow: auto; padding: 14px 14px 24px; background: var(--panel);
  border-right: 1px solid var(--border);
}
.filters section { margin-top: 16px; }
.filters h2, .inspector h3, .health-group h3, .briefing-section h3 {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em;
  color: var(--muted); margin: 0 0 8px;
}
.search {
  width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--panel-2);
}
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--panel-2); cursor: pointer; color: var(--muted);
}
.chip-on { color: var(--text); border-color: var(--border-strong); background: var(--panel); box-shadow: var(--shadow); }
.chip-count { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.sessions { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.session-row { display: grid; grid-template-columns: auto auto 1fr auto; align-items: center; gap: 8px; padding: 4px 2px; cursor: pointer; }
.session-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; flex: none; }
.fields { display: grid; gap: 10px; }
.fields.two { grid-template-columns: 1fr 1fr; }
.field { display: grid; gap: 4px; min-width: 0; }
.field-label { font-size: 11px; color: var(--muted); }
.field select, .field input {
  width: 100%; min-width: 0; padding: 6px 8px; border-radius: 7px; border: 1px solid var(--border); background: var(--panel-2);
}
.toggle { display: flex; align-items: center; gap: 8px; padding: 3px 0; cursor: pointer; }
.link-button { margin-top: 18px; background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; }
.main { display: grid; grid-template-rows: auto minmax(0, 1fr); min-width: 0; min-height: 0; }
.tabs { display: flex; gap: 2px; padding: 8px 16px 0; background: var(--bg); border-bottom: 1px solid var(--border); }
.tab {
  padding: 8px 14px; border: 0; background: none; cursor: pointer; color: var(--muted);
  border-bottom: 2px solid transparent; margin-bottom: -1px; display: inline-flex; gap: 6px; align-items: center;
}
.tab-on { color: var(--text); border-bottom-color: var(--accent); font-weight: 560; }
.tab-count { background: var(--warn-soft); color: var(--warn); border-radius: 999px; padding: 0 7px; font-size: 11px; }
.panel { overflow: auto; padding: 16px; min-height: 0; }
.empty {
  max-width: 460px; margin: 60px auto; text-align: center; padding: 28px;
  border: 1px dashed var(--border-strong); border-radius: var(--radius); background: var(--panel);
}
.empty h3 { margin: 0 0 6px; font-size: 15px; }
.empty p { color: var(--muted); margin: 0 0 14px; }
.button {
  padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border-strong); background: var(--panel);
  cursor: pointer;
}
.button:disabled { opacity: .5; cursor: default; }
.button-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.banner { margin: 0 0 12px; padding: 8px 12px; border-radius: 8px; background: var(--info-soft); color: var(--info); }
.banner-error { background: var(--error-soft); color: var(--error); }
.banner-warn { background: var(--warn-soft); color: var(--warn); }
.graph-view { display: grid; gap: 10px; }
.graph-scroll {
  overflow: auto; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: var(--shadow);
}
.graph { display: block; }
.lane-tasks { fill: var(--panel-2); }
.lane-even { fill: var(--lane-even); }
.lane-odd { fill: var(--lane-odd); }
.lane-detail { fill: var(--panel-2); }
.lane-title { font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; fill: var(--muted); }
.lane-label { cursor: pointer; }
.lane-card { fill: var(--panel); stroke: var(--border); }
.lane-label:hover .lane-card, .lane-label.is-selected .lane-card { stroke: var(--accent); }
.lane-agent { font-size: 12.5px; font-weight: 600; fill: var(--text); }
.lane-session { font-size: 11px; fill: var(--muted); font-family: var(--mono); }
.gridline { stroke: var(--border); stroke-dasharray: 2 4; opacity: .7; }
.axis-line { stroke: var(--border-strong); }
.axis-dot { fill: var(--border-strong); }
.axis-day { font-size: 11px; font-weight: 600; fill: var(--text); }
.axis-time { font-size: 10.5px; fill: var(--muted); }
.node { cursor: pointer; }
.node:focus { outline: none; }
.node:focus-visible .shape, .node:focus-visible .bar { stroke: var(--accent); stroke-width: 3; }
.shape { stroke: var(--panel); stroke-width: 2; }
.shape-checkpoint { fill: var(--checkpoint); }
.shape-decision { fill: var(--decision); }
.shape-knowledge { fill: var(--knowledge); }
.receipt-pass { fill: var(--pass); }
.receipt-fail, .receipt-error, .receipt-unknown { fill: var(--fail); }
.receipt-glyph, .withheld-glyph { font-size: 11px; font-weight: 700; fill: #fff; pointer-events: none; }
.withheld .shape { fill: var(--error-soft); stroke: var(--error); stroke-dasharray: 3 2; }
.withheld-glyph { fill: var(--error); }
.shape-commit { fill: var(--muted); stroke: none; }
.shape-file { fill: var(--panel); stroke: var(--muted); stroke-width: 1.2; }
.bar { fill: var(--task-soft); stroke: var(--task); stroke-width: 1.3; }
.bar-done, .bar-abandoned { fill: var(--panel-2); stroke: var(--border-strong); }
.bar-paused, .bar-blocked { stroke-dasharray: 5 3; }
.bar-label { font-size: 12px; font-weight: 560; fill: var(--text); pointer-events: none; }
.task-bar.attention .bar { stroke: var(--warn); }
.task-bar.is-selected .bar { stroke: var(--accent); stroke-width: 2.5; }
.edge { fill: none; stroke: var(--edge); stroke-width: 1.4; }
.edge-inferred { stroke: var(--inferred); stroke-dasharray: 5 4; opacity: .75; }
.edge-delivered { stroke: var(--muted); stroke-dasharray: 1 4; stroke-linecap: round; stroke-width: 2; }
.edge-handoff { stroke-width: 2; opacity: .95; }
.edge-on { stroke: var(--accent); stroke-width: 2.4; opacity: 1; }
.edge-checkpoint-for { opacity: .55; }
.arrow-explicit { fill: var(--edge); }
.arrow-inferred { fill: var(--inferred); }
.arrow-selected { fill: var(--accent); }
.ring { fill: none; stroke-width: 2.2; }
.ring-stale { stroke: var(--warn); stroke-dasharray: 4 3; }
.ring-disputed { stroke: var(--disputed); stroke-dasharray: 2 3; }
.ring-error { stroke: var(--error); }
.ring-selected { stroke: var(--accent); stroke-width: 2.6; }
.human-dot { fill: var(--info); stroke: var(--panel); stroke-width: 1.5; }
.dim { opacity: .38; }
.legend { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; color: var(--muted); padding: 0 4px; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.legend-sep { width: 1px; height: 14px; background: var(--border-strong); }
.footnote { margin: 0; color: var(--muted); font-size: 12px; padding: 0 4px; }
.table-scroll { overflow: auto; }
table { border-collapse: collapse; width: 100%; }
.records, .anchor { background: var(--panel); }
.records { border: 1px solid var(--border); border-radius: var(--radius); }
.records th, .records td, .anchor th, .anchor td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
.records th { background: var(--panel-2); position: sticky; top: 0; }
.sort { background: none; border: 0; padding: 0; cursor: pointer; font-weight: 600; color: var(--muted); }
.row-on td { background: var(--accent-soft); }
.summary-cell { min-width: 260px; }
.pager { display: flex; align-items: center; gap: 10px; justify-content: flex-end; padding: 10px 0; }
.record-link {
  background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer;
  font-family: var(--mono); font-size: 12px; text-align: left; word-break: break-all;
}
.record-link:hover { text-decoration: underline; }
.badge {
  display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; font-size: 11.5px;
  border: 1px solid transparent; white-space: nowrap; background: var(--panel-2); color: var(--muted);
  border-color: var(--border);
}
.badge-ok { background: var(--ok-soft); color: var(--ok); border-color: transparent; }
.badge-warn { background: var(--warn-soft); color: var(--warn); border-color: transparent; }
.badge-error { background: var(--error-soft); color: var(--error); border-color: transparent; }
.badge-info { background: var(--info-soft); color: var(--info); border-color: transparent; }
.badge-disputed { background: var(--disputed-soft); color: var(--disputed); border-color: transparent; }
.badge-explicit { background: var(--panel-2); color: var(--text); }
.badge-inferred { background: var(--disputed-soft); color: var(--inferred); border-color: transparent; }
.kind { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
.kind-task { color: var(--task); }
.kind-checkpoint { color: var(--checkpoint); }
.kind-decision { color: var(--decision); }
.kind-knowledge { color: var(--knowledge); }
.kind-receipt { color: var(--pass); }
.kind-session, .kind-commit, .kind-file { color: var(--muted); }
.timeline { display: grid; gap: 18px; max-width: 880px; }
.day h3 { margin: 0 0 8px; font-size: 13px; }
.day ol { list-style: none; margin: 0; padding: 0; border-left: 2px solid var(--border); margin-left: 52px; }
.event { display: grid; grid-template-columns: 52px 14px 1fr; margin-left: -54px; padding: 6px 0; }
.event-time { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12px; padding-top: 1px; }
.event-marker { width: 10px; height: 10px; border-radius: 50%; background: var(--panel); border: 2px solid var(--border-strong); margin: 4px 0 0 -4px; }
.event-checkpoint .event-marker { border-color: var(--checkpoint); }
.event-decision .event-marker { border-color: var(--decision); }
.event-knowledge .event-marker { border-color: var(--knowledge); }
.event-check .event-marker { border-color: var(--pass); }
.event-inferred .event-marker { border-style: dashed; border-color: var(--inferred); }
.event-body { padding-left: 8px; }
.event-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 3px; color: var(--muted); font-size: 12px; }
.who { display: inline-flex; align-items: center; gap: 5px; }
.health { display: grid; gap: 16px; max-width: 980px; }
.health-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.health-card {
  display: grid; gap: 2px; padding: 12px; border-radius: var(--radius); background: var(--panel);
  border: 1px solid var(--border); color: var(--muted);
}
.health-card.has-items { color: var(--text); border-color: var(--border-strong); }
.health-count { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
.health-group ul, .findings { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.finding {
  display: grid; grid-template-columns: 70px 1fr; gap: 10px; padding: 10px 12px; border-radius: var(--radius);
  background: var(--panel); border: 1px solid var(--border);
}
.severity { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
.severity-error { color: var(--error); }
.severity-warning { color: var(--warn); }
.severity-info { color: var(--info); }
.finding-hint { color: var(--muted); margin-top: 3px; }
.finding-meta { display: flex; gap: 12px; margin-top: 4px; color: var(--muted); font-size: 12px; flex-wrap: wrap; }
.briefing { display: grid; gap: 14px; max-width: 980px; }
.briefing-controls { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; }
.briefing-controls .field { min-width: 240px; }
.note { margin: 0; padding: 8px 12px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--border); }
.budget { display: grid; gap: 8px; }
.budget-bar { display: flex; height: 12px; border-radius: 6px; overflow: hidden; background: var(--panel-2); border: 1px solid var(--border); }
.seg-frame { background: var(--border-strong); }
.seg-required { background: var(--task); }
.seg-optional { background: var(--decision); }
.seg-pointers { background: var(--warn); }
.budget-legend { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; color: var(--muted); font-size: 12px; }
.budget-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; }
.briefing-section ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.briefing-item { display: grid; grid-template-columns: 62px 1fr; gap: 10px; padding: 8px 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; }
.level { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
.level-tag-full { color: var(--ok); }
.level-tag-short { color: var(--info); }
.level-tag-pointer { color: var(--warn); }
.briefing-text { white-space: pre-wrap; word-break: break-word; }
.inspector {
  overflow: auto; padding: 16px 18px 28px; background: var(--panel); border-left: 1px solid var(--border);
}
.inspector section { margin-top: 18px; }
.inspector-hint h2 { font-size: 15px; margin: 4px 0 8px; }
.inspector-hint p { margin: 0 0 10px; }
.inspector-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.badges { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.icon-button {
  width: 28px; height: 28px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel-2);
  cursor: pointer; font-size: 16px; line-height: 1;
}
.inspector-title { font-size: 15px; line-height: 1.35; margin: 10px 0 2px; display: flex; gap: 8px; align-items: center; }
.facts { margin: 12px 0 0; display: grid; gap: 9px; }
.fact { display: grid; grid-template-columns: 104px 1fr; gap: 10px; }
.fact dt { color: var(--muted); }
.fact dd { margin: 0; word-break: break-word; }
.plain { margin: 0; padding-left: 16px; display: grid; gap: 3px; }
.relations { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.relation { display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: start; }
.relation-label { color: var(--muted); }
.source {
  margin: 8px 0 0; padding: 10px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--border);
  overflow: auto; max-height: 280px; white-space: pre-wrap; word-break: break-word;
}
details summary { cursor: pointer; color: var(--accent); }
.anchor th { color: var(--muted); font-weight: 600; font-size: 11.5px; }
.inspector .anchor th, .inspector .anchor td { padding: 6px 5px; font-size: 12px; }
.inspector .anchor td.mono { word-break: break-all; }
@media (max-width: 1180px) {
  .body { grid-template-columns: 230px minmax(0, 1fr); }
  .inspector { display: none; }
  .inspector.is-open {
    display: block; position: fixed; right: 0; top: 0; bottom: 0; width: min(420px, 100%);
    box-shadow: -8px 0 24px rgb(0 0 0 / 18%); z-index: 5;
  }
}
@media (max-width: 760px) {
  .body { grid-template-columns: 1fr; }
  .filters { border-right: 0; border-bottom: 1px solid var(--border); max-height: 40vh; }
  .topbar { flex-wrap: wrap; }
}
`;

/**
 * The dashboard page. It loads nothing from the network: styles and script are inline and
 * allowed only by the per-response nonce in the Content-Security-Policy header.
 */
export function renderPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Aletheic dashboard</title>
<style nonce="${nonce}">${STYLES}</style>
</head>
<body>
<div id="app" class="app"></div>
<noscript>The Aletheic dashboard needs JavaScript. The same information is available from <code>alethic status</code>, <code>alethic doctor</code>, and <code>alethic dashboard --snapshot -</code>.</noscript>
<script nonce="${nonce}">${CLIENT_SOURCE}</script>
</body>
</html>
`;
}
