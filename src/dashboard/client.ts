/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/**
 * The dashboard's browser code. It runs in the page, not in Node: `renderPage` embeds this
 * function's source, so it must stay self-contained (no imports, no variables from outside).
 * Every piece of record text is inserted with textContent, never as HTML.
 */
export function clientMain(): void {
  interface ModelNode {
    id: string;
    type: string;
    label: string;
    summary?: string;
    status?: string;
    confidence?: string;
    at?: string;
    session?: string;
    task?: string;
    branch?: string;
    file?: string;
    model?: string;
    freshness?: string;
    freshnessReason?: string;
    review?: string;
    trust?: string;
    human?: string;
    applicability?: string;
    applicabilityText?: string;
    result?: string;
    observed?: boolean;
    disputed?: boolean;
    owner?: string;
    ownerSession?: string;
    leaseExpired?: boolean;
    withheld?: boolean;
    codes?: string[];
    errors: number;
    warnings: number;
    detail?: boolean;
  }
  interface ModelEdge {
    id: string;
    from: string;
    to: string;
    type: string;
    basis: string;
    label: string;
    explanation: string;
    via?: { task: string; fromRecord: string; toRecord: string };
  }
  interface ModelSession {
    id: string;
    agent: string;
    session: string | null;
    label: string;
    records: number;
    first?: string;
    last?: string;
  }
  interface TimelineEvent {
    at: string;
    kind: string;
    text: string;
    record?: string;
    session?: string;
    basis: string;
  }
  interface HealthItem {
    severity: string;
    code: string;
    message: string;
    hint?: string;
    file?: string;
    record?: string;
    group: string;
  }
  interface Model {
    version: string;
    generatedAt: string;
    view: { kind: string; note: string };
    repository: {
      project: string | null;
      branch: string | null;
      head: string | null;
      headShort: string | null;
      dirty: boolean;
    };
    counts: Record<string, number>;
    sessions: ModelSession[];
    nodes: ModelNode[];
    edges: ModelEdge[];
    timeline: TimelineEvent[];
    health: { items: HealthItem[]; errors: number; warnings: number };
    delivery: { recorded: boolean; note: string };
  }
  interface Finding {
    severity: string;
    code: string;
    message: string;
    hint?: string;
  }
  interface AnchorRow {
    path: string;
    role: string;
    anchored: string | null;
    current: string | null;
    state: string;
  }
  interface Inspection {
    id: string;
    withheld: boolean;
    kind?: string;
    file?: string;
    files?: string[];
    codes?: string[];
    revision?: string;
    text?: string;
    data?: Record<string, unknown>;
    author?: string;
    trust?: string;
    staleness?: { status: string; reasons: string[]; notes: string[]; review?: string };
    receipt?: {
      applicability: string;
      observed: boolean;
      coverage?: string;
      ranDirty: boolean;
      text: string;
    };
    anchor?: { commit: string | null; rows: AnchorRow[] };
    findings: Finding[];
  }
  interface BriefingItem {
    key: string;
    level: string;
    text: string;
    record?: string;
    reasons?: string[];
    score?: number;
    freshness?: string;
  }
  interface BriefingResult {
    task: string;
    budget: number;
    tokens: number;
    overBudget: boolean;
    report: { budget: number; frame: number; required: number; optional: number; pointers: number };
    policy: string;
    sections: { key: string; title: string; items: BriefingItem[] }[];
    skipped: { id: string; reason: string }[];
    note: string;
  }
  type Child = Node | string | number | null | undefined | false;

  const RECORD_KINDS = ["task", "checkpoint", "decision", "knowledge", "receipt"];
  const KIND_LABEL: Record<string, string> = {
    task: "Task",
    checkpoint: "Checkpoint",
    decision: "Decision",
    knowledge: "Knowledge",
    receipt: "Check",
    session: "Session",
    commit: "Commit",
    file: "File",
  };
  const FRESHNESS_LABEL: Record<string, string> = {
    unchanged: "Unchanged",
    scope_changed: "Nearby files changed",
    uncertain: "Applicability unknown",
    needs_reverification: "Evidence changed",
    diverged: "Diverged",
    broken_evidence: "Evidence missing",
    unanchored: "Not anchored",
  };
  const ATTENTION_FRESHNESS = ["needs_reverification", "diverged", "broken_evidence", "uncertain"];
  const ATTENTION_APPLICABILITY = [
    "content-changed",
    "changed-during-run",
    "uncommitted",
    "unknown",
  ];
  const GROUP_LABEL: Record<string, string> = {
    validity: "Invalid or incomplete records",
    freshness: "Changed evidence",
    conflicts: "Conflicting decisions",
    claims: "Claims and ownership",
    checks: "Check applicability",
    trust: "Confirmations",
  };
  const PALETTE = [
    "#2563eb",
    "#c026d3",
    "#0d9488",
    "#ea580c",
    "#7c3aed",
    "#16a34a",
    "#0891b2",
    "#db2777",
  ];
  const GRAPH_LIMIT = 400;
  const PAGE_SIZE = 100;
  const SVG_NS = "http://www.w3.org/2000/svg";

  const state = {
    model: undefined as Model | undefined,
    error: "",
    tab: "graph",
    selected: undefined as string | undefined,
    query: "",
    kinds: new Set(RECORD_KINDS),
    hiddenSessions: new Set<string>(),
    task: "",
    attentionOnly: false,
    confidence: "",
    branch: "",
    from: "",
    to: "",
    showDetail: false,
    showInferred: true,
    sortKey: "at",
    sortDir: 1,
    page: 0,
    briefingTask: "",
    briefingBudget: 1000,
    briefing: undefined as BriefingResult | undefined,
    briefingError: "",
    inspection: undefined as Inspection | undefined,
  };
  const index = {
    nodes: new Map<string, ModelNode>(),
    sessions: new Map<string, ModelSession>(),
    edgesOf: new Map<string, ModelEdge[]>(),
  };

  // ---- DOM helpers ----------------------------------------------------------------------------

  function append(parent: Element, children: (Child | Child[])[]): void {
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      parent.append(typeof child === "string" || typeof child === "number" ? String(child) : child);
    }
  }

  function setAttributes(element: Element, props: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith("on") && typeof value === "function") {
        element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key === "class") {
        element.setAttribute("class", String(value));
      } else {
        element.setAttribute(key, value === true ? "" : String(value));
      }
    }
  }

  function h(tag: string, props: Record<string, unknown> = {}, ...children: (Child | Child[])[]) {
    const element = document.createElement(tag);
    setAttributes(element, props);
    append(element, children);
    return element;
  }

  function s(tag: string, props: Record<string, unknown> = {}, ...children: (Child | Child[])[]) {
    const element = document.createElementNS(SVG_NS, tag);
    setAttributes(element, props);
    append(element, children);
    return element;
  }

  function str(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  function list(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  function obj(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  function time(at: string | undefined): string {
    if (!at) return "—";
    return `${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
  }

  function clock(at: string | undefined): string {
    return at ? at.slice(11, 16) : "";
  }

  function agentColor(agent: string): string {
    let hash = 0;
    for (const char of agent) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return PALETTE[hash % PALETTE.length] ?? "#2563eb";
  }

  function badge(text: string, tone = "neutral", title?: string) {
    return h("span", { class: `badge badge-${tone}`, title }, text);
  }

  function kindBadge(type: string) {
    return h("span", { class: `kind kind-${type}` }, KIND_LABEL[type] ?? type);
  }

  // ---- Model access -----------------------------------------------------------------------------

  function isRecord(node: ModelNode): boolean {
    return RECORD_KINDS.includes(node.type);
  }

  function needsAttention(node: ModelNode): boolean {
    return (
      Boolean(node.withheld) ||
      Boolean(node.disputed) ||
      node.errors > 0 ||
      (node.freshness !== undefined && ATTENTION_FRESHNESS.includes(node.freshness)) ||
      (node.applicability !== undefined && ATTENTION_APPLICABILITY.includes(node.applicability)) ||
      node.trust === "outdated" ||
      node.trust === "unbound" ||
      Boolean(node.leaseExpired && node.status === "active")
    );
  }

  function linkedToTask(id: string, task: string): boolean {
    return (index.edgesOf.get(id) ?? []).some(
      (edge) => edge.basis === "explicit" && (edge.from === task || edge.to === task),
    );
  }

  function matches(node: ModelNode): boolean {
    if (!state.kinds.has(node.type)) return false;
    if (node.session && state.hiddenSessions.has(node.session)) return false;
    if (
      state.task &&
      node.id !== state.task &&
      node.task !== state.task &&
      !linkedToTask(node.id, state.task)
    ) {
      return false;
    }
    if (state.attentionOnly && !needsAttention(node)) return false;
    if (state.confidence && node.confidence !== state.confidence) return false;
    if (state.branch && node.branch !== state.branch) return false;
    if (state.from && (!node.at || node.at.slice(0, 10) < state.from)) return false;
    if (state.to && (!node.at || node.at.slice(0, 10) > state.to)) return false;
    if (state.query) {
      const query = state.query.toLowerCase();
      const fields = [node.id, node.label, node.summary ?? "", node.file ?? "", node.owner ?? ""];
      if (!fields.some((field) => field.toLowerCase().includes(query))) return false;
    }
    return true;
  }

  function visibleRecords(): ModelNode[] {
    return (state.model?.nodes ?? []).filter((node) => isRecord(node) && matches(node));
  }

  function byTime(a: ModelNode, b: ModelNode): number {
    const at = (a.at ?? "9999").localeCompare(b.at ?? "9999");
    return at || a.id.localeCompare(b.id);
  }

  function nodeName(id: string): string {
    const session = index.sessions.get(id);
    if (session) return session.label;
    return id;
  }

  // ---- Loading ----------------------------------------------------------------------------------

  async function fetchJson<T>(path: string): Promise<T> {
    const response = await fetch(path, { headers: { accept: "application/json" } });
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
  }

  async function load(): Promise<void> {
    try {
      const model = await fetchJson<Model>("api/ledger");
      state.model = model;
      state.error = "";
      index.nodes = new Map(model.nodes.map((node) => [node.id, node]));
      index.sessions = new Map(model.sessions.map((session) => [session.id, session]));
      index.edgesOf = new Map();
      for (const edge of model.edges) {
        for (const end of [edge.from, edge.to, edge.via?.fromRecord, edge.via?.toRecord]) {
          if (!end) continue;
          const edges = index.edgesOf.get(end) ?? [];
          edges.push(edge);
          index.edgesOf.set(end, edges);
        }
      }
      if (!state.briefingTask) {
        const tasks = model.nodes.filter((node) => node.type === "task");
        const open = tasks.find((node) => node.status !== "done" && node.status !== "abandoned");
        state.briefingTask = (open ?? tasks[0])?.id ?? "";
      }
      if (
        state.selected &&
        !index.nodes.has(state.selected) &&
        !index.sessions.has(state.selected)
      ) {
        state.selected = undefined;
      }
      if (state.selected) await inspect(state.selected, false);
    } catch (error) {
      state.error = (error as Error).message;
    }
    render();
  }

  async function poll(): Promise<void> {
    try {
      const { version } = await fetchJson<{ version: string }>("api/version");
      if (version !== state.model?.version) await load();
    } catch {
      state.error = "Cannot reach the dashboard server. Is `alethic dashboard` still running?";
      render();
    }
  }

  async function inspect(id: string, rerender = true): Promise<void> {
    const node = index.nodes.get(id);
    state.inspection = undefined;
    if (node && isRecord(node) && !node.withheld) {
      if (rerender) render();
      try {
        state.inspection = await fetchJson<Inspection>(`api/record?id=${encodeURIComponent(id)}`);
      } catch (error) {
        state.error = (error as Error).message;
      }
    }
    if (rerender) render();
  }

  function select(id: string | undefined): void {
    state.selected = id;
    if (id) void inspect(id);
    else render();
  }

  // ---- Rendering --------------------------------------------------------------------------------

  const app = document.getElementById("app") as HTMLElement;

  function render(): void {
    const active = document.activeElement;
    const focusId = active instanceof HTMLElement ? active.dataset.focus : undefined;
    const scroll = document.getElementById("graph-scroll");
    const scrollLeft = scroll?.scrollLeft;
    app.replaceChildren(
      renderHeader(),
      h("div", { class: "body" }, renderFilters(), renderMain(), renderInspector()),
    );
    if (focusId) {
      const target = app.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusId)}"]`);
      target?.focus();
      if (target instanceof HTMLInputElement && target.type === "search") {
        target.setSelectionRange(target.value.length, target.value.length);
      }
    }
    const nextScroll = document.getElementById("graph-scroll");
    if (nextScroll && scrollLeft !== undefined) nextScroll.scrollLeft = scrollLeft;
  }

  function renderHeader() {
    const model = state.model;
    return h(
      "header",
      { class: "topbar" },
      h(
        "div",
        { class: "brand" },
        h("span", { class: "logo", "aria-hidden": "true" }),
        h("span", { class: "brand-name" }, "Aletheic"),
        model?.repository.project
          ? h("span", { class: "project" }, model.repository.project)
          : null,
      ),
      model
        ? h(
            "div",
            { class: "repo" },
            h(
              "span",
              { class: "mono" },
              `${model.repository.branch ?? "detached HEAD"} @ ${model.repository.headShort ?? "no commits"}`,
            ),
            badge(
              model.repository.dirty ? "Uncommitted changes" : "Clean",
              model.repository.dirty ? "warn" : "ok",
            ),
            badge("Working tree", "neutral", model.view.note),
          )
        : null,
      h("div", { class: "spacer" }),
      model
        ? h(
            "button",
            {
              type: "button",
              class: "health-summary",
              onclick: () => setTab("health"),
              "aria-label": "Open health view",
            },
            h("span", { class: `dot ${model.health.errors > 0 ? "dot-error" : "dot-quiet"}` }),
            `${model.health.errors} ${model.health.errors === 1 ? "error" : "errors"}`,
            h("span", { class: `dot ${model.health.warnings > 0 ? "dot-warn" : "dot-quiet"}` }),
            `${model.health.warnings} ${model.health.warnings === 1 ? "warning" : "warnings"}`,
          )
        : null,
      h(
        "span",
        { class: "live", title: "Reloads when records, HEAD, or uncommitted changes change" },
        h("span", { class: `live-dot ${state.error ? "live-off" : ""}`, "aria-hidden": "true" }),
        state.error
          ? "Disconnected"
          : model
            ? `Updated ${clock(model.generatedAt)} UTC`
            : "Loading",
      ),
      h(
        "span",
        { class: "readonly", title: "The dashboard never writes records or runs commands" },
        "Read-only",
      ),
    );
  }

  function setTab(tab: string): void {
    state.tab = tab;
    render();
  }

  function chip(
    label: string,
    pressed: boolean,
    onclick: () => void,
    count?: number,
    color?: string,
  ) {
    return h(
      "button",
      {
        type: "button",
        class: `chip ${pressed ? "chip-on" : ""}`,
        "aria-pressed": String(pressed),
        onclick,
      },
      color ? h("span", { class: "swatch", "data-color": color }) : null,
      label,
      count !== undefined ? h("span", { class: "chip-count" }, String(count)) : null,
    );
  }

  function field(label: string, control: HTMLElement) {
    return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control);
  }

  function renderFilters() {
    const model = state.model;
    const aside = h("aside", { class: "filters", "aria-label": "Filters" });
    if (!model) return aside;
    const records = model.nodes.filter(isRecord);
    const search = h("input", {
      type: "search",
      class: "search",
      placeholder: "Search ids, summaries, files",
      value: state.query,
      "data-focus": "search",
      "aria-label": "Search records",
    }) as HTMLInputElement;
    search.addEventListener("input", () => {
      state.query = search.value;
      state.page = 0;
      render();
    });

    const kinds = h(
      "div",
      { class: "chips" },
      RECORD_KINDS.map((kind) =>
        chip(
          KIND_LABEL[kind] ?? kind,
          state.kinds.has(kind),
          () => {
            if (state.kinds.has(kind)) state.kinds.delete(kind);
            else state.kinds.add(kind);
            render();
          },
          records.filter((node) => node.type === kind).length,
        ),
      ),
    );

    const sessionList = h(
      "ul",
      { class: "sessions" },
      model.sessions.map((session) => {
        const box = h("input", {
          type: "checkbox",
          checked: !state.hiddenSessions.has(session.id),
          "data-focus": `session-${session.id}`,
        }) as HTMLInputElement;
        box.addEventListener("change", () => {
          if (box.checked) state.hiddenSessions.delete(session.id);
          else state.hiddenSessions.add(session.id);
          render();
        });
        return h(
          "li",
          {},
          h(
            "label",
            { class: "session-row" },
            box,
            h("span", { class: "agent-dot", "data-color": agentColor(session.agent) }),
            h(
              "span",
              { class: "session-name" },
              session.agent,
              h(
                "span",
                { class: "muted" },
                session.session ? ` ${session.session}` : " (no session id)",
              ),
            ),
            h("span", { class: "chip-count" }, String(session.records)),
          ),
        );
      }),
    );

    const taskSelect = h(
      "select",
      { "data-focus": "task-filter" },
      h("option", { value: "" }, "All tasks"),
      model.nodes
        .filter((node) => node.type === "task")
        .map((node) => h("option", { value: node.id, selected: state.task === node.id }, node.id)),
    ) as HTMLSelectElement;
    taskSelect.addEventListener("change", () => {
      state.task = taskSelect.value;
      render();
    });

    const confidence = h(
      "select",
      { "data-focus": "confidence-filter" },
      ["", "inferred", "agent-reported", "ci-reported", "human-confirmed"].map((value) =>
        h("option", { value, selected: state.confidence === value }, value || "Any trust level"),
      ),
    ) as HTMLSelectElement;
    confidence.addEventListener("change", () => {
      state.confidence = confidence.value;
      render();
    });

    const branches = [
      ...new Set(records.map((node) => node.branch).filter((b): b is string => Boolean(b))),
    ].sort();
    const branch = h(
      "select",
      { "data-focus": "branch-filter" },
      h("option", { value: "" }, "Any branch"),
      branches.map((value) => h("option", { value, selected: state.branch === value }, value)),
    ) as HTMLSelectElement;
    branch.addEventListener("change", () => {
      state.branch = branch.value;
      render();
    });

    const from = h("input", {
      type: "date",
      value: state.from,
      "data-focus": "from",
    }) as HTMLInputElement;
    from.addEventListener("change", () => {
      state.from = from.value;
      render();
    });
    const to = h("input", {
      type: "date",
      value: state.to,
      "data-focus": "to",
    }) as HTMLInputElement;
    to.addEventListener("change", () => {
      state.to = to.value;
      render();
    });

    const toggle = (
      label: string,
      checked: boolean,
      onchange: (value: boolean) => void,
      key: string,
    ) => {
      const box = h("input", { type: "checkbox", checked, "data-focus": key }) as HTMLInputElement;
      box.addEventListener("change", () => onchange(box.checked));
      return h("label", { class: "toggle" }, box, label);
    };

    append(aside, [
      search,
      h("section", {}, h("h2", {}, "Records"), kinds),
      h(
        "section",
        {},
        h("h2", {}, "Needs attention"),
        toggle(
          "Only records that need attention",
          state.attentionOnly,
          (value) => {
            state.attentionOnly = value;
            render();
          },
          "attention",
        ),
      ),
      h("section", {}, h("h2", {}, "Sessions"), sessionList),
      h(
        "section",
        { class: "fields" },
        field("Task", taskSelect),
        field("Trust", confidence),
        field("Branch", branch),
      ),
      h("section", { class: "fields two" }, field("From", from), field("To", to)),
      h(
        "section",
        {},
        h("h2", {}, "Graph"),
        toggle(
          "Inferred relationships",
          state.showInferred,
          (value) => {
            state.showInferred = value;
            render();
          },
          "inferred",
        ),
        toggle(
          "Commits and files",
          state.showDetail,
          (value) => {
            state.showDetail = value;
            render();
          },
          "detail",
        ),
      ),
      h(
        "button",
        {
          type: "button",
          class: "link-button",
          onclick: () => {
            state.query = "";
            state.kinds = new Set(RECORD_KINDS);
            state.hiddenSessions.clear();
            state.task = "";
            state.attentionOnly = false;
            state.confidence = "";
            state.branch = "";
            state.from = "";
            state.to = "";
            render();
          },
        },
        "Reset filters",
      ),
    ]);
    return aside;
  }

  function renderMain() {
    const tabs: [string, string][] = [
      ["graph", "Graph"],
      ["table", "Table"],
      ["timeline", "Timeline"],
      ["health", "Health"],
      ["briefing", "Briefing"],
    ];
    const main = h("main", { class: "main" });
    const tablist = h(
      "div",
      { class: "tabs", role: "tablist", "aria-label": "Views" },
      tabs.map(([key, label]) =>
        h(
          "button",
          {
            type: "button",
            role: "tab",
            id: `tab-${key}`,
            class: `tab ${state.tab === key ? "tab-on" : ""}`,
            "aria-selected": String(state.tab === key),
            "aria-controls": "panel",
            "data-focus": `tab-${key}`,
            onclick: () => setTab(key),
          },
          label,
          key === "health" &&
            state.model &&
            state.model.health.errors + state.model.health.warnings > 0
            ? h(
                "span",
                { class: "tab-count" },
                String(state.model.health.errors + state.model.health.warnings),
              )
            : null,
        ),
      ),
    );
    const panel = h("div", {
      class: "panel",
      id: "panel",
      role: "tabpanel",
      "aria-labelledby": `tab-${state.tab}`,
    });
    if (state.error && !state.model) {
      append(panel, [emptyState("Could not load the ledger", state.error)]);
    } else if (!state.model) {
      append(panel, [emptyState("Loading the ledger", "Reading records and Git state…")]);
    } else if (state.tab === "graph") {
      append(panel, [renderGraph()]);
    } else if (state.tab === "table") {
      append(panel, [renderTable()]);
    } else if (state.tab === "timeline") {
      append(panel, [renderTimeline()]);
    } else if (state.tab === "health") {
      append(panel, [renderHealth()]);
    } else {
      append(panel, [renderBriefing()]);
    }
    append(main, [tablist, panel]);
    return main;
  }

  function emptyState(title: string, detail: string, action?: HTMLElement) {
    return h("div", { class: "empty" }, h("h3", {}, title), h("p", {}, detail), action ?? null);
  }

  function resetButton() {
    return h(
      "button",
      {
        type: "button",
        class: "button",
        onclick: () => {
          state.query = "";
          state.kinds = new Set(RECORD_KINDS);
          state.hiddenSessions.clear();
          state.task = "";
          state.attentionOnly = false;
          state.confidence = "";
          state.branch = "";
          state.from = "";
          state.to = "";
          render();
        },
      },
      "Reset filters",
    );
  }

  // ---- Graph ------------------------------------------------------------------------------------

  function renderGraph() {
    const model = state.model as Model;
    const all = model.nodes.filter(isRecord);
    if (all.length === 0) {
      return emptyState(
        "No records yet",
        "Records appear here as agents run `alethic task start`, `alethic checkpoint create`, and the other write commands.",
      );
    }
    const ordered = visibleRecords().sort(byTime);
    if (ordered.length === 0) {
      return emptyState(
        "No records match these filters",
        "Widen the filters to see more of the ledger.",
        resetButton(),
      );
    }
    const truncated = ordered.length > GRAPH_LIMIT;
    const shown = truncated ? ordered.slice(-GRAPH_LIMIT) : ordered;
    const shownIds = new Set(shown.map((node) => node.id));

    const LEFT = 196;
    // Spread few records across the panel; many records scroll horizontally at the minimum width.
    const available =
      document.getElementById("panel")?.clientWidth ?? Math.max(600, window.innerWidth - 656);
    const COL = Math.max(
      46,
      Math.min(120, Math.floor((available - 34 - LEFT - 40) / shown.length)),
    );
    const TOP = 10;
    const TASKS = 66;
    const LANE = 64;
    const DETAIL = 50;
    const AXIS = 44;

    const tasks = shown.filter((node) => node.type === "task");
    const others = shown.filter((node) => node.type !== "task");
    const laneKeys: string[] = [];
    for (const node of others) {
      const key = node.withheld ? "lane:withheld" : (node.session ?? "lane:unattributed");
      if (!laneKeys.includes(key)) laneKeys.push(key);
    }
    laneKeys.sort((a, b) => {
      const sa = index.sessions.get(a);
      const sb = index.sessions.get(b);
      if (!sa) return 1;
      if (!sb) return -1;
      return sa.agent.localeCompare(sb.agent) || (sa.first ?? "").localeCompare(sb.first ?? "");
    });

    const column = new Map<string, number>();
    shown.forEach((node, i) => {
      column.set(node.id, i);
    });
    const colX = (i: number) => LEFT + i * COL + COL / 2;
    const laneY = (i: number) => TOP + TASKS + i * LANE + LANE / 2;
    const pos = new Map<string, { x: number; y: number; lane: number }>();
    for (const node of tasks)
      pos.set(node.id, { x: colX(column.get(node.id) ?? 0), y: TOP + TASKS / 2, lane: -1 });
    for (const node of others) {
      const lane = laneKeys.indexOf(
        node.withheld ? "lane:withheld" : (node.session ?? "lane:unattributed"),
      );
      pos.set(node.id, { x: colX(column.get(node.id) ?? 0), y: laneY(lane), lane });
    }

    const detailNodes: ModelNode[] = [];
    if (state.showDetail) {
      for (const edge of model.edges) {
        if (!shownIds.has(edge.from)) continue;
        const target = index.nodes.get(edge.to);
        if (!target?.detail || pos.has(target.id)) continue;
        const source = pos.get(edge.from);
        detailNodes.push(target);
        pos.set(target.id, {
          x: source?.x ?? LEFT,
          y: TOP + TASKS + laneKeys.length * LANE + DETAIL / 2,
          lane: laneKeys.length,
        });
      }
    }

    const width = LEFT + shown.length * COL + 40;
    const lanesBottom = TOP + TASKS + laneKeys.length * LANE + (state.showDetail ? DETAIL : 0);
    const height = lanesBottom + AXIS;
    const selected = state.selected;
    const related = new Set<string>();
    if (selected) {
      related.add(selected);
      for (const edge of index.edgesOf.get(selected) ?? []) {
        for (const end of [edge.from, edge.to, edge.via?.fromRecord, edge.via?.toRecord])
          if (end) related.add(end);
      }
    }
    const dim = (id: string) => (selected && !related.has(id) ? "dim" : "");

    const svgRoot = s("svg", {
      class: "graph",
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: "group",
      "aria-label": `Graph of ${shown.length} records in ${laneKeys.length} session lanes`,
    });

    const defs = s(
      "defs",
      {},
      ["explicit", "inferred", "selected"].map((kind) =>
        s(
          "marker",
          {
            id: `arrow-${kind}`,
            viewBox: "0 0 10 10",
            refX: "9",
            refY: "5",
            markerWidth: "7",
            markerHeight: "7",
            orient: "auto-start-reverse",
          },
          s("path", { d: "M 0 0 L 10 5 L 0 10 z", class: `arrow arrow-${kind}` }),
        ),
      ),
    );
    svgRoot.append(defs);

    // Lanes
    const lanes = s("g", { class: "lanes" });
    lanes.append(
      s("rect", { x: 0, y: TOP, width, height: TASKS, class: "lane lane-tasks" }),
      s("text", { x: 16, y: TOP + TASKS / 2 + 4, class: "lane-title" }, "Tasks"),
    );
    laneKeys.forEach((key, i) => {
      const top = TOP + TASKS + i * LANE;
      const session = index.sessions.get(key);
      lanes.append(
        s("rect", {
          x: 0,
          y: top,
          width,
          height: LANE,
          class: `lane ${i % 2 ? "lane-odd" : "lane-even"}`,
        }),
      );
      const label = s(
        "g",
        {
          class: `lane-label ${selected === key ? "is-selected" : ""}`,
          role: "button",
          tabindex: session ? "0" : undefined,
          "data-focus": `lane-${key}`,
          "aria-label": session
            ? `Session ${session.label}, ${session.records} records`
            : "Records without an author",
          onclick: () => session && select(key),
          onkeydown: (event: KeyboardEvent) => {
            if (session && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              select(key);
            }
          },
        },
        s("rect", {
          x: 8,
          y: top + 12,
          width: LEFT - 20,
          height: LANE - 24,
          rx: 9,
          class: "lane-card",
        }),
        s("circle", {
          cx: 24,
          cy: top + LANE / 2,
          r: 5,
          fill: session ? agentColor(session.agent) : "#9ca3af",
        }),
        s(
          "text",
          { x: 36, y: top + LANE / 2 - 3, class: "lane-agent" },
          session ? session.agent : key === "lane:withheld" ? "Withheld" : "Unattributed",
        ),
        s(
          "text",
          { x: 36, y: top + LANE / 2 + 12, class: "lane-session" },
          session
            ? session.session
              ? truncateText(session.session, 22)
              : "no session id"
            : "failed validation",
        ),
      );
      lanes.append(label);
    });
    if (state.showDetail) {
      const top = TOP + TASKS + laneKeys.length * LANE;
      lanes.append(
        s("rect", { x: 0, y: top, width, height: DETAIL, class: "lane lane-detail" }),
        s("text", { x: 16, y: top + DETAIL / 2 + 4, class: "lane-title" }, "Commits and files"),
      );
    }
    svgRoot.append(lanes);

    // Time axis
    const axis = s("g", { class: "axis" });
    axis.append(
      s("line", {
        x1: LEFT - 8,
        y1: lanesBottom + 14,
        x2: width - 16,
        y2: lanesBottom + 14,
        class: "axis-line",
      }),
    );
    let lastDay = "";
    shown.forEach((node, i) => {
      const x = colX(i);
      axis.append(s("line", { x1: x, y1: TOP, x2: x, y2: lanesBottom, class: "gridline" }));
      axis.append(s("circle", { cx: x, cy: lanesBottom + 14, r: 2.5, class: "axis-dot" }));
      const day = node.at?.slice(0, 10) ?? "";
      if (day && day !== lastDay) {
        axis.append(
          s(
            "text",
            { x, y: lanesBottom + 32, class: "axis-day", "text-anchor": "start" },
            `${day.slice(5)} ${clock(node.at)}`,
          ),
        );
        lastDay = day;
      } else if (i % 4 === 0 && node.at) {
        axis.append(
          s(
            "text",
            { x, y: lanesBottom + 32, class: "axis-time", "text-anchor": "middle" },
            clock(node.at),
          ),
        );
      }
    });
    svgRoot.append(axis);

    // Task bars
    const bars = s("g", { class: "task-bars" });
    for (const task of tasks) {
      const cols = [column.get(task.id) ?? 0];
      for (const edge of index.edgesOf.get(task.id) ?? []) {
        if (edge.basis !== "explicit") continue;
        const other = edge.from === task.id ? edge.to : edge.from;
        const c = column.get(other);
        if (c !== undefined && index.nodes.get(other)?.type !== "task") cols.push(c);
      }
      const start = colX(Math.min(...cols)) - 16;
      const end = colX(Math.max(...cols)) + 16;
      const y = TOP + TASKS / 2;
      const attention = needsAttention(task);
      const group = s(
        "g",
        {
          class: `node task-bar ${task.id === selected ? "is-selected" : ""} ${dim(task.id)} ${attention ? "attention" : ""}`,
          role: "button",
          tabindex: "0",
          "data-node": task.id,
          "data-focus": `node-${task.id}`,
          "aria-label": `Task ${task.id}: ${task.label}, ${task.status ?? ""}`,
          onclick: () => select(task.id),
          onkeydown: (event: KeyboardEvent) => onNodeKey(event, task.id),
        },
        s(
          "title",
          {},
          `${task.id}\n${task.label}\n${task.status ?? ""}${task.owner ? `, owner ${task.owner}` : ""}`,
        ),
        s("rect", {
          x: start,
          y: y - 15,
          width: Math.max(end - start, 32),
          height: 30,
          rx: 8,
          class: `bar bar-${task.status ?? "unknown"}`,
        }),
        s(
          "text",
          { x: start + 12, y: y + 4, class: "bar-label" },
          truncateText(`${task.label}`, Math.max(6, Math.floor((end - start - 24) / 6.4))),
        ),
      );
      bars.append(group);
    }
    svgRoot.append(bars);

    // Edges
    const edgeLayer = s("g", { class: "edges" });
    const relevantCount = model.edges.filter(
      (edge) => edge.type === "relevant-to" && shownIds.has(edge.from) && shownIds.has(edge.to),
    ).length;
    for (const edge of model.edges) {
      if (edge.type === "authored" || edge.type === "owns") continue;
      if (edge.basis === "inferred" && !state.showInferred) continue;
      let fromId = edge.from;
      let toId = edge.to;
      if (edge.type === "handoff") {
        if (!edge.via) continue;
        fromId = edge.via.fromRecord;
        toId = edge.via.toRecord;
      }
      const a = pos.get(fromId);
      const b = pos.get(toId);
      if (!a || !b) continue;
      const touchesSelected =
        selected !== undefined &&
        related.has(fromId) &&
        related.has(toId) &&
        (fromId === selected ||
          toId === selected ||
          edge.from === selected ||
          edge.to === selected);
      if (edge.type === "relevant-to" && relevantCount > 60 && !touchesSelected) continue;
      const toTaskBar = index.nodes.get(toId)?.type === "task";
      const y2 = toTaskBar ? b.y + 15 : b.y;
      const x2 = toTaskBar ? a.x : b.x;
      const dx = Math.max(26, Math.abs(x2 - a.x) / 2);
      const d = toTaskBar
        ? `M ${a.x} ${a.y} C ${a.x} ${(a.y + y2) / 2}, ${x2} ${(a.y + y2) / 2}, ${x2} ${y2}`
        : `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
      const highlighted = selected !== undefined && touchesSelected;
      const markerKind = highlighted
        ? "selected"
        : edge.basis === "inferred"
          ? "inferred"
          : "explicit";
      const arrow =
        edge.type === "handoff" ||
        edge.type === "links" ||
        edge.type === "supersedes" ||
        edge.type === "cites";
      edgeLayer.append(
        s(
          "path",
          {
            d,
            class: `edge edge-${edge.basis} edge-${edge.type} ${highlighted ? "edge-on" : selected ? "dim" : ""}`,
            "marker-end": arrow ? `url(#arrow-${markerKind})` : undefined,
          },
          s("title", {}, `${edge.label} (${edge.basis})\n${edge.explanation}`),
        ),
      );
    }
    svgRoot.append(edgeLayer);

    // Nodes
    const nodeLayer = s("g", { class: "nodes" });
    for (const node of [...others, ...detailNodes]) {
      const p = pos.get(node.id);
      if (!p) continue;
      nodeLayer.append(renderNode(node, p.x, p.y, dim(node.id)));
    }
    svgRoot.append(nodeLayer);

    const legend = h(
      "div",
      { class: "legend", "aria-label": "Legend" },
      legendShape("task", "Task"),
      legendShape("checkpoint", "Checkpoint"),
      legendShape("decision", "Decision"),
      legendShape("knowledge", "Knowledge"),
      legendShape("receipt", "Check"),
      h("span", { class: "legend-sep" }),
      legendLine("explicit", "Recorded link"),
      legendLine("inferred", "Inferred (paths or order of work)"),
      legendLine("delivered", "Delivered briefing (none recorded)"),
      h("span", { class: "legend-sep" }),
      legendRing("stale", "Evidence changed or unknown"),
      legendRing("disputed", "Disputed"),
      legendRing("error", "Invalid or withheld"),
    );

    return h(
      "div",
      { class: "graph-view" },
      truncated
        ? h(
            "p",
            { class: "banner" },
            `Showing the latest ${GRAPH_LIMIT} of ${ordered.length} matching records. Narrow the filters, or use the Table view for all of them.`,
          )
        : null,
      h("div", { class: "graph-scroll", id: "graph-scroll" }, svgRoot),
      legend,
      h("p", { class: "footnote" }, model.delivery.note),
    );
  }

  function truncateText(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
  }

  function nodeState(node: ModelNode): string {
    if (node.withheld || node.errors > 0) return "error";
    if (node.disputed) return "disputed";
    if (node.freshness && ATTENTION_FRESHNESS.includes(node.freshness)) return "stale";
    if (node.applicability && ATTENTION_APPLICABILITY.includes(node.applicability)) return "stale";
    if (node.trust === "outdated" || node.trust === "unbound") return "stale";
    return "";
  }

  function renderNode(node: ModelNode, x: number, y: number, dimmed: string) {
    const stateClass = nodeState(node);
    const shape = (() => {
      switch (node.type) {
        case "checkpoint":
          return s("polygon", {
            points: `${x},${y - 11} ${x + 11},${y} ${x},${y + 11} ${x - 11},${y}`,
            class: "shape shape-checkpoint",
          });
        case "decision":
          return s("rect", {
            x: x - 9,
            y: y - 9,
            width: 18,
            height: 18,
            rx: 4,
            class: "shape shape-decision",
          });
        case "knowledge":
          return s("circle", { cx: x, cy: y, r: 10, class: "shape shape-knowledge" });
        case "receipt":
          return s(
            "g",
            {},
            s("rect", {
              x: x - 14,
              y: y - 9,
              width: 28,
              height: 18,
              rx: 9,
              class: `shape shape-receipt receipt-${node.result ?? "unknown"}`,
            }),
            s(
              "text",
              { x, y: y + 4, class: "receipt-glyph", "text-anchor": "middle" },
              node.result === "pass" ? "✓" : node.result === "fail" ? "✕" : "!",
            ),
          );
        case "commit":
          return s("circle", { cx: x, cy: y, r: 4.5, class: "shape shape-commit" });
        case "file":
          return s("rect", {
            x: x - 4,
            y: y - 6,
            width: 8,
            height: 11,
            rx: 1.5,
            class: "shape shape-file",
          });
        default:
          return s("rect", { x: x - 9, y: y - 9, width: 18, height: 18, rx: 4, class: "shape" });
      }
    })();
    const label = `${KIND_LABEL[node.type] ?? node.type} ${node.id}: ${node.label}${stateClass ? `, ${stateClass === "stale" ? "needs attention" : stateClass}` : ""}`;
    return s(
      "g",
      {
        class: `node node-${node.type} ${node.id === state.selected ? "is-selected" : ""} ${dimmed} ${node.withheld ? "withheld" : ""}`,
        role: "button",
        tabindex: node.detail ? "-1" : "0",
        "data-node": node.id,
        "data-focus": `node-${node.id}`,
        "aria-label": label,
        onclick: () => select(node.id),
        onkeydown: (event: KeyboardEvent) => onNodeKey(event, node.id),
      },
      s(
        "title",
        {},
        `${node.id}\n${node.label}${node.freshnessReason ? `\n${node.freshnessReason}` : ""}${node.applicabilityText ? `\n${node.applicabilityText}` : ""}`,
      ),
      stateClass ? s("circle", { cx: x, cy: y, r: 16, class: `ring ring-${stateClass}` }) : null,
      node.id === state.selected
        ? s("circle", { cx: x, cy: y, r: 19, class: "ring ring-selected" })
        : null,
      shape,
      node.withheld
        ? s("text", { x, y: y + 4, class: "withheld-glyph", "text-anchor": "middle" }, "!")
        : null,
      node.trust === "attributed"
        ? s("circle", { cx: x + 11, cy: y - 11, r: 3.5, class: "human-dot" })
        : null,
    );
  }

  function legendShape(type: string, label: string) {
    const icon = s("svg", { width: 22, height: 18, viewBox: "0 0 22 18", "aria-hidden": "true" });
    const x = 11;
    const y = 9;
    if (type === "task")
      icon.append(s("rect", { x: 1, y: 3, width: 20, height: 12, rx: 4, class: "bar bar-active" }));
    else if (type === "checkpoint")
      icon.append(
        s("polygon", {
          points: `${x},${y - 7} ${x + 7},${y} ${x},${y + 7} ${x - 7},${y}`,
          class: "shape shape-checkpoint",
        }),
      );
    else if (type === "decision")
      icon.append(
        s("rect", {
          x: x - 6,
          y: y - 6,
          width: 12,
          height: 12,
          rx: 3,
          class: "shape shape-decision",
        }),
      );
    else if (type === "knowledge")
      icon.append(s("circle", { cx: x, cy: y, r: 6.5, class: "shape shape-knowledge" }));
    else
      icon.append(
        s("rect", {
          x: 2,
          y: 3,
          width: 18,
          height: 12,
          rx: 6,
          class: "shape shape-receipt receipt-pass",
        }),
      );
    return h("span", { class: "legend-item" }, icon, label);
  }

  function legendLine(basis: string, label: string) {
    return h(
      "span",
      { class: "legend-item" },
      s(
        "svg",
        { width: 30, height: 10, viewBox: "0 0 30 10", "aria-hidden": "true" },
        s("line", { x1: 1, y1: 5, x2: 29, y2: 5, class: `edge edge-${basis}` }),
      ),
      label,
    );
  }

  function legendRing(kind: string, label: string) {
    return h(
      "span",
      { class: "legend-item" },
      s(
        "svg",
        { width: 18, height: 18, viewBox: "0 0 18 18", "aria-hidden": "true" },
        s("circle", { cx: 9, cy: 9, r: 7, class: `ring ring-${kind}` }),
      ),
      label,
    );
  }

  function onNodeKey(event: KeyboardEvent, id: string): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(id);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const elements = [...app.querySelectorAll<SVGGElement>("g.node[data-node]")].filter(
      (el) => el.getAttribute("tabindex") === "0",
    );
    const current = elements.find((el) => el.dataset.node === id);
    if (!current) return;
    const box = (el: SVGGElement) => el.getBBox();
    const here = box(current);
    const cx = here.x + here.width / 2;
    const cy = here.y + here.height / 2;
    let best: SVGGElement | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const el of elements) {
      if (el === current) continue;
      const b = box(el);
      const x = b.x + b.width / 2;
      const y = b.y + b.height / 2;
      const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
      const forward =
        event.key === "ArrowRight"
          ? x > cx + 1
          : event.key === "ArrowLeft"
            ? x < cx - 1
            : event.key === "ArrowDown"
              ? y > cy + 1
              : y < cy - 1;
      if (!forward) continue;
      const score = horizontal
        ? Math.abs(x - cx) + Math.abs(y - cy) * 4
        : Math.abs(y - cy) + Math.abs(x - cx) * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    best?.focus();
  }

  // ---- Table ------------------------------------------------------------------------------------

  function renderTable() {
    const rows = visibleRecords();
    if (rows.length === 0)
      return emptyState(
        "No records match these filters",
        "Widen the filters to see more of the ledger.",
        resetButton(),
      );
    const columns: [string, string][] = [
      ["type", "Kind"],
      ["id", "Record"],
      ["label", "Summary"],
      ["session", "Written by"],
      ["task", "Task"],
      ["at", "Written"],
      ["freshness", "Freshness"],
      ["confidence", "Trust"],
      ["problems", "Problems"],
    ];
    const value = (node: ModelNode, key: string): string | number => {
      if (key === "session") return node.session ? nodeName(node.session) : "";
      if (key === "problems") return node.errors * 1000 + node.warnings;
      if (key === "freshness") return node.freshness ?? node.applicability ?? "";
      const raw = (node as unknown as Record<string, unknown>)[key];
      return typeof raw === "string" || typeof raw === "number" ? raw : "";
    };
    rows.sort((a, b) => {
      const va = value(a, state.sortKey);
      const vb = value(b, state.sortKey);
      const order =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va).localeCompare(String(vb));
      return order * state.sortDir || a.id.localeCompare(b.id);
    });
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages - 1);
    const pageRows = rows.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);

    const table = h(
      "table",
      { class: "records" },
      h("caption", { class: "sr-only" }, `${rows.length} records`),
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          columns.map(([key, label]) =>
            h(
              "th",
              {
                scope: "col",
                "aria-sort":
                  state.sortKey === key ? (state.sortDir > 0 ? "ascending" : "descending") : "none",
              },
              h(
                "button",
                {
                  type: "button",
                  class: "sort",
                  "data-focus": `sort-${key}`,
                  onclick: () => {
                    if (state.sortKey === key) state.sortDir = -state.sortDir;
                    else {
                      state.sortKey = key;
                      state.sortDir = 1;
                    }
                    render();
                  },
                },
                label,
                state.sortKey === key ? (state.sortDir > 0 ? " ↑" : " ↓") : "",
              ),
            ),
          ),
        ),
      ),
      h(
        "tbody",
        {},
        pageRows.map((node) =>
          h(
            "tr",
            { class: node.id === state.selected ? "row-on" : "" },
            h("td", {}, kindBadge(node.type)),
            h("td", {}, recordButton(node.id)),
            h("td", { class: "summary-cell" }, node.label),
            h("td", {}, node.session ? nodeName(node.session) : node.withheld ? "—" : ""),
            h("td", { class: "mono" }, node.task && node.task !== node.id ? node.task : ""),
            h("td", { class: "nowrap" }, time(node.at)),
            h("td", {}, freshnessBadge(node)),
            h("td", {}, trustBadge(node)),
            h("td", {}, problemsBadge(node)),
          ),
        ),
      ),
    );
    const pager =
      pages > 1
        ? h(
            "div",
            { class: "pager" },
            h(
              "button",
              {
                type: "button",
                class: "button",
                disabled: state.page === 0,
                onclick: () => {
                  state.page--;
                  render();
                },
              },
              "Previous",
            ),
            h("span", {}, `Page ${state.page + 1} of ${pages}`),
            h(
              "button",
              {
                type: "button",
                class: "button",
                disabled: state.page >= pages - 1,
                onclick: () => {
                  state.page++;
                  render();
                },
              },
              "Next",
            ),
          )
        : null;
    return h("div", { class: "table-view" }, h("div", { class: "table-scroll" }, table), pager);
  }

  function recordButton(id: string, label?: string) {
    return h(
      "button",
      {
        type: "button",
        class: "record-link",
        "data-focus": `record-${id}`,
        onclick: () => select(id),
      },
      label ?? id,
    );
  }

  function freshnessBadge(node: ModelNode) {
    if (node.withheld) return badge("Withheld", "error");
    if (node.freshness) {
      const tone = ATTENTION_FRESHNESS.includes(node.freshness)
        ? "warn"
        : node.freshness === "scope_changed"
          ? "info"
          : "ok";
      return badge(FRESHNESS_LABEL[node.freshness] ?? node.freshness, tone, node.freshnessReason);
    }
    if (node.applicability) {
      const tone = ATTENTION_APPLICABILITY.includes(node.applicability) ? "warn" : "ok";
      return badge(node.applicability.replace(/-/g, " "), tone, node.applicabilityText);
    }
    return null;
  }

  function trustBadge(node: ModelNode) {
    if (!node.confidence) return null;
    if (node.trust === "attributed")
      return badge(`Confirmed by ${node.human ?? "?"}`, "info", "Attributed, not authenticated");
    if (node.trust === "outdated") return badge("Confirmation outdated", "warn");
    if (node.trust === "unbound") return badge("Confirmation unbound", "warn");
    return badge(node.confidence, "neutral");
  }

  function problemsBadge(node: ModelNode) {
    if (node.errors > 0)
      return badge(`${node.errors} ${node.errors === 1 ? "error" : "errors"}`, "error");
    if (node.warnings > 0)
      return badge(`${node.warnings} ${node.warnings === 1 ? "warning" : "warnings"}`, "warn");
    if (node.disputed) return badge("Disputed", "disputed");
    return null;
  }

  // ---- Timeline ---------------------------------------------------------------------------------

  function renderTimeline() {
    const model = state.model as Model;
    const events = model.timeline.filter((event) => {
      const node = event.record ? index.nodes.get(event.record) : undefined;
      return !node || matches(node);
    });
    if (events.length === 0)
      return emptyState(
        "Nothing in this range",
        "No recorded activity matches these filters.",
        resetButton(),
      );
    const days = new Map<string, TimelineEvent[]>();
    for (const event of events) {
      const day = event.at.slice(0, 10) || "Unknown date";
      days.set(day, [...(days.get(day) ?? []), event]);
    }
    return h(
      "div",
      { class: "timeline" },
      [...days.entries()].map(([day, items]) =>
        h(
          "section",
          { class: "day" },
          h("h3", {}, day),
          h(
            "ol",
            {},
            items.map((event) => {
              const session = event.session ? index.sessions.get(event.session) : undefined;
              return h(
                "li",
                {
                  class: `event event-${event.kind} ${event.basis === "inferred" ? "event-inferred" : ""}`,
                },
                h("span", { class: "event-time" }, clock(event.at)),
                h("span", { class: "event-marker", "aria-hidden": "true" }),
                h(
                  "div",
                  { class: "event-body" },
                  h("div", { class: "event-text" }, event.text),
                  h(
                    "div",
                    { class: "event-meta" },
                    session
                      ? h(
                          "span",
                          { class: "who" },
                          h("span", {
                            class: "agent-dot",
                            "data-color": agentColor(session.agent),
                          }),
                          session.label,
                        )
                      : null,
                    event.basis === "inferred"
                      ? badge("Inferred", "inferred", "Derived from the order of recorded work")
                      : null,
                    event.record ? recordButton(event.record) : null,
                  ),
                ),
              );
            }),
          ),
        ),
      ),
    );
  }

  // ---- Health -----------------------------------------------------------------------------------

  function renderHealth() {
    const model = state.model as Model;
    const items = model.health.items;
    if (items.length === 0) {
      return emptyState(
        "No problems found",
        "Every record passes validation, no evidence changed, and no claims conflict.",
      );
    }
    const groups = new Map<string, HealthItem[]>();
    for (const item of items) groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
    const order = ["validity", "freshness", "conflicts", "claims", "checks", "trust"];
    return h(
      "div",
      { class: "health" },
      h(
        "div",
        { class: "health-cards" },
        order.map((group) => {
          const count = groups.get(group)?.length ?? 0;
          return h(
            "div",
            { class: `health-card ${count ? "has-items" : ""}` },
            h("span", { class: "health-count" }, String(count)),
            h("span", {}, GROUP_LABEL[group] ?? group),
          );
        }),
      ),
      order
        .filter((group) => groups.has(group))
        .map((group) =>
          h(
            "section",
            { class: "health-group" },
            h("h3", {}, GROUP_LABEL[group] ?? group),
            h(
              "ul",
              {},
              (groups.get(group) ?? []).map((item) =>
                h(
                  "li",
                  { class: `finding finding-${item.severity}` },
                  h("span", { class: `severity severity-${item.severity}` }, item.severity),
                  h(
                    "div",
                    { class: "finding-body" },
                    h("div", { class: "finding-message" }, item.message),
                    item.hint ? h("div", { class: "finding-hint" }, item.hint) : null,
                    h(
                      "div",
                      { class: "finding-meta" },
                      h("span", { class: "mono" }, item.code),
                      item.record
                        ? recordButton(
                            item.record,
                            item.record.startsWith("withheld:") ? item.file : item.record,
                          )
                        : item.file
                          ? h("span", { class: "mono" }, item.file)
                          : null,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
    );
  }

  // ---- Briefing ---------------------------------------------------------------------------------

  function renderBriefing() {
    const model = state.model as Model;
    const tasks = model.nodes.filter((node) => node.type === "task");
    if (tasks.length === 0)
      return emptyState(
        "No tasks",
        "A briefing is compiled for a task. Start one with `alethic task start`.",
      );
    const taskSelect = h(
      "select",
      { "data-focus": "briefing-task" },
      tasks.map((node) =>
        h(
          "option",
          { value: node.id, selected: node.id === state.briefingTask },
          `${node.id} (${node.status ?? "?"})`,
        ),
      ),
    ) as HTMLSelectElement;
    taskSelect.addEventListener("change", () => {
      state.briefingTask = taskSelect.value;
    });
    const budget = h("input", {
      type: "number",
      min: "200",
      step: "100",
      value: String(state.briefingBudget),
      "data-focus": "briefing-budget",
    }) as HTMLInputElement;
    budget.addEventListener("change", () => {
      state.briefingBudget = Math.max(200, Number(budget.value) || 1000);
    });
    const compile = h(
      "button",
      {
        type: "button",
        class: "button button-primary",
        onclick: async () => {
          state.briefingError = "";
          try {
            state.briefing = await fetchJson<BriefingResult>(
              `api/briefing?task=${encodeURIComponent(state.briefingTask)}&budget=${state.briefingBudget}`,
            );
          } catch (error) {
            state.briefing = undefined;
            state.briefingError = (error as Error).message;
          }
          render();
        },
      },
      "Compile",
    );
    const result = state.briefing;
    return h(
      "div",
      { class: "briefing" },
      h(
        "div",
        { class: "briefing-controls" },
        field("Task", taskSelect),
        field("Budget (approx. tokens)", budget),
        compile,
      ),
      state.briefingError ? h("p", { class: "banner banner-error" }, state.briefingError) : null,
      result
        ? renderBriefingResult(result)
        : h(
            "p",
            { class: "muted" },
            "Compile a briefing to see what an agent resuming the task would receive now, and why each item is included, shortened, or collapsed.",
          ),
    );
  }

  function renderBriefingResult(result: BriefingResult) {
    const { report } = result;
    const total = Math.max(report.budget, result.tokens);
    const segment = (value: number, kind: string, label: string) =>
      h("span", {
        class: `seg seg-${kind}`,
        "data-width": String(Math.round((value / total) * 1000) / 10),
        title: `${label}: about ${value} tokens`,
      });
    return h(
      "div",
      { class: "briefing-result" },
      h("p", { class: "note" }, result.note),
      h(
        "div",
        { class: "budget" },
        h(
          "div",
          { class: "budget-bar" },
          segment(report.frame, "frame", "Frame"),
          segment(report.required, "required", "Required"),
          segment(report.optional, "optional", "Optional"),
          segment(report.pointers, "pointers", "Pointer lines"),
        ),
        h(
          "div",
          { class: "budget-legend" },
          h("span", {}, h("i", { class: "seg-frame" }), `Frame ${report.frame}`),
          h("span", {}, h("i", { class: "seg-required" }), `Never shortened ${report.required}`),
          h("span", {}, h("i", { class: "seg-optional" }), `Optional ${report.optional}`),
          h("span", {}, h("i", { class: "seg-pointers" }), `Pointer lines ${report.pointers}`),
          h("strong", {}, `${result.tokens} of about ${result.budget} tokens`),
        ),
        result.overBudget
          ? h(
              "p",
              { class: "banner banner-warn" },
              `Over budget: the sections that are never shortened do not fit. ${result.policy}`,
            )
          : h("p", { class: "muted small" }, result.policy),
      ),
      result.sections
        .filter((section) => section.items.length > 0)
        .map((section) =>
          h(
            "section",
            { class: "briefing-section" },
            h("h3", {}, section.title),
            h(
              "ul",
              {},
              section.items.map((item) =>
                h(
                  "li",
                  { class: `briefing-item level-${item.level}` },
                  h(
                    "span",
                    {
                      class: `level level-tag-${item.level}`,
                      title:
                        item.level === "pointer"
                          ? "Collapsed into the section's 'N more' line to fit the budget"
                          : `Shown ${item.level === "full" ? "in full" : "as a one-line summary"}`,
                    },
                    item.level,
                  ),
                  h(
                    "div",
                    {},
                    h("div", { class: "briefing-text" }, item.text),
                    h(
                      "div",
                      { class: "event-meta" },
                      item.record ? recordButton(item.record) : null,
                      (item.reasons ?? []).map((reason) =>
                        badge(reason, "neutral", "How the compiler found this record"),
                      ),
                      item.score !== undefined
                        ? h("span", { class: "muted small" }, `score ${item.score}`)
                        : null,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      result.skipped.length > 0
        ? h(
            "section",
            { class: "briefing-section" },
            h("h3", {}, "Left out on purpose"),
            h(
              "ul",
              {},
              result.skipped.map((entry) => h("li", {}, recordButton(entry.id), " ", entry.reason)),
            ),
          )
        : null,
    );
  }

  // ---- Inspector --------------------------------------------------------------------------------

  function renderInspector() {
    const aside = h("aside", {
      class: `inspector ${state.selected ? "is-open" : ""}`,
      "aria-label": "Inspector",
      "aria-live": "polite",
    });
    const id = state.selected;
    if (!id || !state.model) {
      append(aside, [
        h(
          "div",
          { class: "inspector-hint" },
          h("h2", {}, "Inspector"),
          h(
            "p",
            {},
            "Select a record, a session lane, a table row, or a health item to see its source, its trust, whether its evidence still matches the code, and how it relates to other records.",
          ),
          h(
            "p",
            { class: "muted small" },
            "Each relationship says whether a record states it (explicit) or it was inferred from paths or the order of work. No relationship claims that an agent read a record.",
          ),
        ),
      ]);
      return aside;
    }
    const close = h(
      "button",
      {
        type: "button",
        class: "icon-button",
        "aria-label": "Close inspector",
        "data-focus": "close-inspector",
        onclick: () => select(undefined),
      },
      "×",
    );
    const session = index.sessions.get(id);
    if (session) {
      append(aside, [renderSessionInspector(session, close)]);
      return aside;
    }
    const node = index.nodes.get(id);
    if (!node) return aside;
    if (node.withheld) {
      const findings = state.model.health.items.filter((item) => item.record === id);
      append(aside, [
        h(
          "div",
          { class: "inspector-head" },
          h("div", {}, kindBadge(node.type), badge("Withheld", "error")),
          close,
        ),
        h("h2", { class: "inspector-title" }, node.file ?? node.id),
        h(
          "p",
          {},
          "This record failed validation, so its content is not shown here or used in briefings.",
        ),
        h(
          "dl",
          { class: "facts" },
          fact("Findings", (node.codes ?? []).join(", ")),
          fact("File", h("span", { class: "mono" }, node.file ?? "")),
        ),
        findingsList(findings),
      ]);
      return aside;
    }
    if (node.detail) {
      const referencing = (index.edgesOf.get(id) ?? []).filter((edge) => edge.to === id);
      append(aside, [
        h("div", { class: "inspector-head" }, h("div", {}, kindBadge(node.type)), close),
        h("h2", { class: "inspector-title mono" }, node.label),
        h(
          "section",
          {},
          h("h3", {}, "Cited by"),
          h(
            "ul",
            { class: "relations" },
            referencing.map((edge) => relationRow(edge, edge.from)),
          ),
        ),
      ]);
      return aside;
    }
    const inspection =
      state.inspection && state.inspection.id === id ? state.inspection : undefined;
    append(aside, [
      h(
        "div",
        { class: "inspector-head" },
        h(
          "div",
          { class: "badges" },
          kindBadge(node.type),
          node.status ? badge(node.status, "neutral") : null,
          freshnessBadge(node),
          node.disputed ? badge("Disputed", "disputed") : null,
        ),
        close,
      ),
      h("h2", { class: "inspector-title" }, node.summary ?? node.label),
      h("p", { class: "mono muted small" }, node.id),
    ]);
    if (!inspection) {
      append(aside, [h("p", { class: "muted" }, "Loading the record…")]);
      return aside;
    }
    const data = inspection.data ?? {};
    append(aside, [
      h(
        "dl",
        { class: "facts" },
        fact("Written by", `${inspection.author ?? "?"}, ${time(str(data.created_at))}`),
        node.model ? fact("Model", node.model) : null,
        fact("Trust", inspection.trust ?? ""),
      ),
      renderRecordContent(node, data, inspection),
      renderFreshness(inspection),
      renderRelations(node),
      inspection.findings.length > 0
        ? h("section", {}, h("h3", {}, "Problems"), findingsList(inspection.findings))
        : null,
      h(
        "section",
        {},
        h("h3", {}, "Source"),
        h(
          "dl",
          { class: "facts" },
          fact("File", h("span", { class: "mono" }, inspection.file ?? "")),
          fact("Revision", h("span", { class: "mono" }, (inspection.revision ?? "").slice(0, 12))),
        ),
        h(
          "details",
          {},
          h("summary", {}, "Record file"),
          h("pre", { class: "source" }, inspection.text ?? ""),
        ),
      ),
    ]);
    return aside;
  }

  function fact(label: string, value: Child) {
    if (value === null || value === undefined || value === "") return null;
    return h("div", { class: "fact" }, h("dt", {}, label), h("dd", {}, value));
  }

  function textList(items: unknown[]) {
    const values = items.map((item) => str(item)).filter((item): item is string => Boolean(item));
    return values.length
      ? h(
          "ul",
          { class: "plain" },
          values.map((value) => h("li", {}, value)),
        )
      : null;
  }

  function renderRecordContent(
    node: ModelNode,
    data: Record<string, unknown>,
    inspection: Inspection,
  ) {
    const section = h("section", {}, h("h3", {}, "Content"));
    const facts = h("dl", { class: "facts" });
    switch (node.type) {
      case "task": {
        const owner = obj(data.owner);
        append(facts, [
          fact("Intent", str(data.intent)),
          fact("Next action", str(data.next_action)),
          fact(
            "Owner",
            owner
              ? `${node.owner ?? str(owner.agent) ?? "?"}; lease ${node.leaseExpired ? "expired at" : "until"} ${time(str(owner.lease_expires_at))}`
              : undefined,
          ),
          fact("Branch", str(data.branch)),
        ]);
        break;
      }
      case "decision":
        append(facts, [
          fact("Topic", h("span", { class: "mono" }, str(data.topic) ?? "")),
          fact("Chosen", str(data.chosen)),
          fact("Why", str(data.rationale)),
          fact(
            "Rejected",
            textList(
              list(data.alternatives).map((entry) => {
                const alt = obj(entry);
                return alt
                  ? `${str(alt.option) ?? "?"}: ${str(alt.rejected_because) ?? ""}`
                  : undefined;
              }),
            ),
          ),
        ]);
        break;
      case "knowledge":
        append(facts, [fact("Category", str(data.category)), fact("Fact", str(data.body))]);
        break;
      case "checkpoint": {
        const git = obj(data.git);
        append(facts, [
          fact("Task", node.task ? recordButton(node.task) : undefined),
          fact(
            "Git",
            git
              ? `${str(git.branch) ?? "detached"} @ ${str(git.head) ?? "?"}${git.dirty ? ", uncommitted changes" : ""}`
              : undefined,
          ),
          fact("Done", textList(list(data.done))),
          fact(
            "Failed approaches",
            textList(
              list(data.failed_approaches).map((entry) => {
                const item = obj(entry);
                return item
                  ? `${str(item.approach) ?? "?"}: ${str(item.why_failed) ?? ""}`
                  : undefined;
              }),
            ),
          ),
          fact("Open questions", textList(list(data.open_questions))),
          fact("Next safe action", str(data.next_safe_action)),
        ]);
        break;
      }
      case "receipt": {
        const receipt = inspection.receipt;
        append(facts, [
          fact("Command", h("code", {}, str(data.command) ?? "")),
          fact("Result", `${str(data.result) ?? "?"} (exit ${String(data.exit_code)})`),
          fact("Ran", time(str(data.ran_at))),
          fact("Applies now", receipt?.text),
          fact(
            "How it was recorded",
            receipt
              ? receipt.observed
                ? `Observed by \`alethic receipt run\`${receipt.coverage ? `; coverage ${receipt.coverage}` : ""}`
                : "Reported to Aletheic; not observed"
              : undefined,
          ),
          fact(
            "Output",
            str(data.output_tail)
              ? h("pre", { class: "source" }, str(data.output_tail) ?? "")
              : undefined,
          ),
        ]);
        break;
      }
    }
    section.append(facts);
    return section;
  }

  function renderFreshness(inspection: Inspection) {
    const staleness = inspection.staleness;
    if (!staleness) return null;
    const rows = inspection.anchor?.rows ?? [];
    return h(
      "section",
      {},
      h("h3", {}, "Evidence and freshness"),
      h(
        "p",
        {},
        badge(
          FRESHNESS_LABEL[staleness.status] ?? staleness.status,
          ATTENTION_FRESHNESS.includes(staleness.status)
            ? "warn"
            : staleness.status === "scope_changed"
              ? "info"
              : "ok",
        ),
        staleness.review
          ? h("span", { class: "muted small" }, ` ${staleness.review} change`)
          : null,
      ),
      staleness.reasons.length
        ? h(
            "ul",
            { class: "plain" },
            staleness.reasons.map((reason) => h("li", {}, reason)),
          )
        : null,
      staleness.notes.length
        ? h(
            "ul",
            { class: "plain muted small" },
            staleness.notes.map((note) => h("li", {}, note)),
          )
        : null,
      rows.length
        ? h(
            "div",
            { class: "table-scroll" },
            h(
              "table",
              { class: "anchor" },
              h(
                "thead",
                {},
                h(
                  "tr",
                  {},
                  h("th", { scope: "col" }, "File"),
                  h("th", { scope: "col" }, "Role"),
                  h("th", { scope: "col" }, "When written"),
                  h("th", { scope: "col" }, "Now"),
                ),
              ),
              h(
                "tbody",
                {},
                rows.map((row) =>
                  h(
                    "tr",
                    {},
                    h("td", { class: "mono" }, row.path),
                    h("td", {}, row.role),
                    h("td", { class: "mono" }, (row.anchored ?? "—").slice(0, 8)),
                    h(
                      "td",
                      {},
                      row.state === "same"
                        ? badge("same", "ok")
                        : row.state === "changed"
                          ? badge("changed", "warn")
                          : badge("missing", "error"),
                    ),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "muted small" }, "No file content was fingerprinted for this record."),
      inspection.anchor?.commit
        ? h(
            "p",
            { class: "muted small" },
            `Anchored at commit ${inspection.anchor.commit.slice(0, 7)}. Freshness compares file content, not commits.`,
          )
        : null,
    );
  }

  function relationRow(edge: ModelEdge, other: string) {
    return h(
      "li",
      { class: "relation" },
      badge(
        edge.basis === "explicit"
          ? "Explicit"
          : edge.basis === "inferred"
            ? "Inferred"
            : "Delivered",
        edge.basis,
      ),
      h(
        "div",
        {},
        h(
          "div",
          {},
          h("span", { class: "relation-label" }, edge.label),
          " ",
          recordButton(other, nodeName(other)),
        ),
        h("div", { class: "muted small" }, edge.explanation),
      ),
    );
  }

  function renderRelations(node: ModelNode) {
    const edges = (index.edgesOf.get(node.id) ?? []).filter((edge) => {
      const target = index.nodes.get(edge.from === node.id ? edge.to : edge.from);
      return !target?.detail || state.showDetail;
    });
    if (edges.length === 0) return null;
    const rows = edges.map((edge) => {
      if (edge.type === "handoff" && edge.via) {
        const other = edge.via.fromRecord === node.id ? edge.via.toRecord : edge.via.fromRecord;
        return relationRow(edge, other);
      }
      return relationRow(edge, edge.from === node.id ? edge.to : edge.from);
    });
    return h(
      "section",
      {},
      h("h3", {}, `Relationships (${rows.length})`),
      h("ul", { class: "relations" }, rows),
    );
  }

  function renderSessionInspector(session: ModelSession, close: HTMLElement) {
    const model = state.model as Model;
    const records = model.nodes.filter((node) => node.session === session.id);
    const owned = model.nodes.filter(
      (node) => node.type === "task" && node.ownerSession === session.id,
    );
    const handoffs = model.edges.filter(
      (edge) => edge.type === "handoff" && (edge.from === session.id || edge.to === session.id),
    );
    return h(
      "div",
      {},
      h("div", { class: "inspector-head" }, h("div", {}, kindBadge("session")), close),
      h(
        "h2",
        { class: "inspector-title" },
        h("span", { class: "agent-dot", "data-color": agentColor(session.agent) }),
        session.label,
      ),
      h(
        "dl",
        { class: "facts" },
        fact("Agent", session.agent),
        fact(
          "Session",
          session.session ??
            "Not recorded: runs of this agent without ALETHIC_SESSION cannot be told apart",
        ),
        fact("Active", `${time(session.first)} to ${time(session.last)}`),
        fact("Records written", String(session.records)),
      ),
      owned.length
        ? h(
            "section",
            {},
            h("h3", {}, "Tasks held"),
            h(
              "ul",
              { class: "plain" },
              owned.map((task) => h("li", {}, recordButton(task.id), ` ${task.status ?? ""}`)),
            ),
          )
        : null,
      handoffs.length
        ? h(
            "section",
            {},
            h("h3", {}, "Handoffs (inferred)"),
            h(
              "ul",
              { class: "relations" },
              handoffs.map((edge) =>
                relationRow(edge, edge.from === session.id ? edge.to : edge.from),
              ),
            ),
          )
        : null,
      h(
        "section",
        {},
        h("h3", {}, "Records"),
        h(
          "ul",
          { class: "plain" },
          records
            .slice(0, 50)
            .map((node) => h("li", {}, kindBadge(node.type), " ", recordButton(node.id))),
        ),
      ),
    );
  }

  function findingsList(findings: Finding[]) {
    return h(
      "ul",
      { class: "findings" },
      findings.map((finding) =>
        h(
          "li",
          { class: `finding finding-${finding.severity}` },
          h("span", { class: `severity severity-${finding.severity}` }, finding.severity),
          h(
            "div",
            { class: "finding-body" },
            h("div", {}, finding.message),
            finding.hint ? h("div", { class: "finding-hint" }, finding.hint) : null,
          ),
        ),
      ),
    );
  }

  // Colors and widths come from data attributes, applied through the CSSOM (allowed by the CSP).
  const observer = new MutationObserver(() => applyDataStyles());
  function applyDataStyles(): void {
    for (const el of app.querySelectorAll<HTMLElement>("[data-color]"))
      el.style.backgroundColor = el.dataset.color ?? "";
    for (const el of app.querySelectorAll<HTMLElement>("[data-width]"))
      el.style.width = `${el.dataset.width ?? "0"}%`;
  }
  observer.observe(app, { childList: true, subtree: true });

  document.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    const typing =
      target &&
      (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA");
    if (event.key === "/" && !typing) {
      event.preventDefault();
      app.querySelector<HTMLInputElement>("input.search")?.focus();
    } else if (event.key === "Escape" && state.selected) {
      select(undefined);
    }
  });

  render();
  void load();
  setInterval(() => void poll(), 4000);
}
