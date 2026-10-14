import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { SEED } from "./data/seed.js";
import { SECTIONS, sectionFor } from "./lib/check.js";
import { storage } from "./lib/storage.js";
import { fetchUpdates, isFeedMode } from "./lib/wire-api.js";
import { PROVIDERS, byId, DEFAULT_PROVIDER } from "./lib/providers/index.js";

const STORE_KEY = "items:v1";
const MODEL_KEY = "model:v1";
const POLL_MINUTES = Number(import.meta.env.VITE_WIRE_POLL_MINUTES || 5);
const POLL_MS = POLL_MINUTES * 60 * 1000;

const RANGES = [
  { id: "all", label: "All time", days: null },
  { id: "7", label: "7 days", days: 7 },
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "custom", label: "Custom", days: null },
];

const iso = (d) => d.toISOString().slice(0, 10);

function fmtDate(d) {
  const t = new Date(d + "T00:00:00");
  if (isNaN(t)) return d;
  // The year is only shown when it isn't the current one — a changelog is
  // mostly recent, and repeating "2026" on every row is noise.
  const sameYear = t.getFullYear() === new Date().getFullYear();
  return t
    .toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    })
    .toUpperCase();
}

/** Inclusive bounds for the active range, as YYYY-MM-DD strings or null. */
function bounds(range) {
  if (range.id === "custom") return { from: range.from || null, to: range.to || null };
  const preset = RANGES.find((r) => r.id === range.id);
  if (!preset?.days) return { from: null, to: null };
  const start = new Date();
  start.setDate(start.getDate() - preset.days);
  return { from: iso(start), to: null };
}

function fmtClock(ts) {
  if (!ts) return "never";
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default function Wire() {
  const [items, setItems] = useState(SEED);
  const [filter, setFilter] = useState("All");
  const [range, setRange] = useState({ id: "all", from: "", to: "" });
  const [tab, setTab] = useState("all");
  const [watching, setWatching] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState("Reading saved entries…");
  const [lastCheck, setLastCheck] = useState(null);
  const [newIds, setNewIds] = useState([]);
  // Learned from the first check: whether the server is pre-searching for us.
  const [searchMode, setSearchMode] = useState(null);
  const [choice, setChoice] = useState(() => {
    const p = byId(DEFAULT_PROVIDER);
    return { provider: p.id, model: p.models[0] };
  });
  // check() runs on a timer, so it reads the latest state through refs rather
  // than closing over a stale render. Refs are synced after commit, never
  // written during render.
  const itemsRef = useRef(items);
  const choiceRef = useRef(choice);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    choiceRef.current = choice;
  }, [choice]);
  const provider = byId(choice.provider);

  /* ---------- load anything saved from a previous visit ---------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await storage.get(STORE_KEY);
        const saved = JSON.parse(res.value);
        if (!cancelled && saved && Array.isArray(saved.items)) {
          const seen = new Set(saved.items.map((i) => i.url + i.title));
          setItems([...saved.items, ...SEED.filter((s) => !seen.has(s.url + s.title))]);
          setLastCheck(saved.lastCheck || null);
        }
      } catch {
        /* nothing saved yet — the seed list stands */
      }
      try {
        const saved = JSON.parse((await storage.get(MODEL_KEY)).value);
        const p = byId(saved.provider);
        if (!cancelled) {
          setChoice({
            provider: p.id,
            model: p.models.includes(saved.model) ? saved.model : p.models[0],
          });
        }
      } catch {
        /* first visit — the default provider stands */
      }
      if (!cancelled) setStatus("Idle. Nothing checked yet this session.");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (next, checkedAt) => {
    try {
      await storage.set(
        STORE_KEY,
        JSON.stringify({ items: next.slice(0, 120), lastCheck: checkedAt || null })
      );
    } catch {
      /* storage is a convenience here, not load-bearing */
    }
  }, []);

  const choose = useCallback((next) => {
    setChoice(next);
    storage.set(MODEL_KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  /* ---------- ask the model what's new, and let it type each item ---------- */
  const check = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    const active = byId(choiceRef.current.provider);
    setStatus(
      isFeedMode
        ? "Reading the shared feed…"
        : active.supportsSearch
          ? `Searching primary sources via ${active.label}…`
          : `${active.label} can't search the live web — asking for what it already knows, with sources.`
    );
    const known = itemsRef.current;

    try {
      const { fresh, checkedAt, mode, searched } = await fetchUpdates(known, choiceRef.current);
      const stamp = checkedAt || Date.now();

      if (fresh.length) {
        const next = [...fresh, ...known];
        setItems(next);
        setNewIds((p) => [...fresh.map((f) => f.id), ...p]);
        const how =
          mode === "injected" ? ` via ${active.label}, from ${searched} search results.` : mode === "memory" ? ` via ${active.label}, from memory — no search.` : isFeedMode ? " from the feed." : ` via ${active.label}.`;
        setSearchMode(mode ?? null);
        setStatus(`${fresh.length} new ${fresh.length === 1 ? "entry" : "entries"}${how}`);
        persist(next, stamp);
      } else {
        setSearchMode(mode ?? null);
        setStatus(
          isFeedMode
            ? "Feed is current — nothing new since the last check."
            : mode === "injected"
              ? `Nothing new in ${searched} search results.`
              : `Nothing new from primary sources, via ${active.label}.`
        );
        persist(known, stamp);
      }
      setLastCheck(stamp);
    } catch (err) {
      setStatus(
        isFeedMode ? `Couldn't read the feed: ${err.message}` : `${active.label} check failed: ${err.message}`
      );
    } finally {
      setChecking(false);
    }
  }, [checking, persist]);

  /* ---------- keep pulling while the tab stays open ---------- */
  useEffect(() => {
    if (!watching) return undefined;
    // Deferred, not called inline: an inline call would setState during the
    // effect body and cascade a second render before the first has painted.
    const kick = setTimeout(check, 0);
    const id = setInterval(check, POLL_MS);
    return () => {
      clearTimeout(kick);
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, choice.provider, choice.model]);

  // Date filtering happens first so the type counts describe what's actually
  // reachable in the current window, rather than the whole archive.
  // Entries written before sections existed, or returned without one, are
  // placed by their type rather than dropped.
  const placed = useMemo(() => items.map((i) => ({ ...i, section: sectionFor(i) })), [items]);

  const inTab = useMemo(
    () => (tab === "all" ? placed : placed.filter((i) => i.section === tab)),
    [placed, tab]
  );

  const inRange = useMemo(() => {
    const { from, to } = bounds(range);
    if (!from && !to) return inTab;
    return inTab.filter((i) => (!from || i.date >= from) && (!to || i.date <= to));
  }, [inTab, range]);

  // Tab counts respect the date range but not the type chip, so switching tabs
  // never lands on an empty list because of a type that doesn't exist there.
  const tabCounts = useMemo(() => {
    const { from, to } = bounds(range);
    const dated = placed.filter((i) => (!from || i.date >= from) && (!to || i.date <= to));
    const counts = { all: dated.length };
    SECTIONS.forEach((sec) => {
      counts[sec.id] = dated.filter((i) => i.section === sec.id).length;
    });
    return counts;
  }, [placed, range]);

  const types = useMemo(() => {
    const counts = new Map();
    inRange.forEach((i) => counts.set(i.type, (counts.get(i.type) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [inRange]);

  const shown = useMemo(() => {
    const list = filter === "All" ? inRange : inRange.filter((i) => i.type === filter);
    return [...list].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [inRange, filter]);

  // The oldest entry bounds the pickers, so you can't select an empty past.
  useEffect(() => {
    if (filter !== "All" && !inRange.some((i) => i.type === filter)) setFilter("All");
  }, [inRange, filter]);

  const earliest = useMemo(
    () => items.map((i) => i.date).sort()[0] || "2026-01-01",
    [items]
  );

  return (
    <div className="wire-root">
      <div className="wire-shell">
        <header className="masthead">
          <div className="eyebrow mono">Primary sources only · LLM systems desk</div>
          <h1>AI WIRE</h1>
          <p style={{ color: "var(--ink-soft)", margin: ".35rem 0 0", fontSize: ".9rem" }}>
            Model releases, API changes, deprecations, pricing and papers, each with the announcement
            behind it. Leave this open and new entries drop in at the top.
          </p>
        </header>

        {/* sections — one entry belongs to exactly one tab */}
        <nav className="tabs" role="tablist" aria-label="Sections">
          {[{ id: "all", label: "Everything" }, ...SECTIONS].map((sec) => (
            <button
              key={sec.id}
              role="tab"
              aria-selected={tab === sec.id}
              className="tab mono"
              data-on={tab === sec.id}
              onClick={() => setTab(sec.id)}
            >
              {sec.label}
              <span className="tabcount">{tabCounts[sec.id] ?? 0}</span>
            </button>
          ))}
        </nav>

        <div className="statusbar mono flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
          <span>
            <span
              className={"pulse" + (watching ? " live" : "")}
              style={!watching ? { background: "var(--wire)" } : undefined}
            />
            {watching ? `WATCHING · every ${POLL_MINUTES} min` : "WATCH OFF"}
          </span>
          <span>LAST CHECK {fmtClock(lastCheck)}</span>
          <span>{items.length} ENTRIES</span>
          {!isFeedMode && (
            <label className="flex items-center gap-1">
              <span className="sr-only">Model</span>
              {PROVIDERS.length > 1 && (
                <select
                  className="picker mono"
                  value={choice.provider}
                  onChange={(e) => {
                    const p = byId(e.target.value);
                    choose({ provider: p.id, model: p.models[0] });
                  }}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              )}
              <select
                className="picker mono"
                value={choice.model}
                onChange={(e) => choose({ ...choice, model: e.target.value })}
              >
                {provider.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!isFeedMode && !provider.supportsSearch && !searchMode && (
            <span className="badge warn">No live search</span>
          )}
          {!isFeedMode && searchMode === "injected" && (
            <span className="badge">Pre-search on</span>
          )}
          <span className="ml-auto flex gap-2">
            <button className="btn ghost" onClick={() => setWatching((w) => !w)}>
              {watching ? "Stop watching" : "Watch for updates"}
            </button>
            <button className="btn" onClick={check} disabled={checking}>
              {checking ? "Checking…" : "Check now"}
            </button>
          </span>
        </div>
        <div className="mono px-3 py-2" style={{ fontSize: ".7rem", color: "var(--ink-soft)" }}>
          {status}
        </div>

        {/* date range */}
        <div className="filterrow flex flex-wrap items-center gap-2 mt-3">
          <span className="filterlabel mono">When</span>
          {RANGES.map((r) => (
            <button
              key={r.id}
              className="chip mono"
              data-on={range.id === r.id}
              onClick={() =>
                setRange((prev) =>
                  r.id === "custom"
                    ? { id: "custom", from: prev.from || earliest, to: prev.to || iso(new Date()) }
                    : { id: r.id, from: "", to: "" }
                )
              }
            >
              {r.label}
            </button>
          ))}
          {range.id === "custom" && (
            <span className="flex items-center gap-1">
              <input
                type="date"
                className="picker mono"
                value={range.from}
                min={earliest}
                max={range.to || undefined}
                onChange={(e) => setRange((p) => ({ ...p, from: e.target.value }))}
                aria-label="From date"
              />
              <span className="mono" style={{ fontSize: ".7rem", color: "var(--ink-soft)" }}>
                to
              </span>
              <input
                type="date"
                className="picker mono"
                value={range.to}
                min={range.from || earliest}
                onChange={(e) => setRange((p) => ({ ...p, to: e.target.value }))}
                aria-label="To date"
              />
            </span>
          )}
        </div>

        {/* type filter — labels come from the model, not a fixed list */}
        <div className="filterrow flex flex-wrap items-center gap-2 mt-2 mb-7">
          <span className="filterlabel mono">What</span>
          <button className="chip mono" data-on={filter === "All"} onClick={() => setFilter("All")}>
            All · {inRange.length}
          </button>
          {types.map(([t, n]) => (
            <button
              key={t}
              className="chip mono"
              data-on={filter === t}
              onClick={() => setFilter(t)}
            >
              {t} · {n}
            </button>
          ))}
        </div>

        <div className="rail">
          {shown.length === 0 && (
            <p className="mono" style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>
              {inTab.length === 0
                ? "Nothing filed in this section yet. Run a check, or try another tab."
                : inRange.length === 0
                  ? "No entries in that date range. Widen it, or try another tab."
                  : `Nothing filed under ${filter} in that date range.`}
            </p>
          )}
          {shown.map((i) => {
            const isNew = newIds.includes(i.id);
            return (
              <article key={i.id} className={"entry" + (isNew ? " fresh" : "")}>
                <span className="node mono" data-new={isNew} aria-hidden="true">
                  {isNew ? "+" : "·"}
                </span>
                <div className="meta mono flex flex-wrap items-center gap-2">
                  <span>{fmtDate(i.date)}</span>
                  <span>{i.source}</span>
                  <span className={"badge" + (i.tier === "Secondary" ? " second" : "")}>
                    {i.tier}
                  </span>
                  <span className="badge second">{i.type}</span>
                  {i.via && <span className="badge second">via {byId(i.via).label}</span>}
                  {i.flagged && <span className="badge warn">⚑ {i.flagged}</span>}
                  {isNew && <span className="badge warn">New</span>}
                </div>
                <a
                  className="head inline-block mt-1"
                  href={i.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {i.title} ↗
                </a>
                <p>{i.summary}</p>
              </article>
            );
          })}
        </div>

        <footer
          className="mono mt-8 pt-4"
          style={{ fontSize: ".65rem", color: "var(--ink-soft)", borderTop: "1px solid var(--rule)" }}
        >
          Entries are kept on this device between visits. Checks search primary sources and the
          model assigns each entry a type, so the filter row grows as new kinds of news arrive. The
          {isFeedMode
            ? "This site reads a shared feed rebuilt on a schedule, so no key is involved and every visitor sees the same wire. Running it locally in direct mode calls a provider live — "
            : "The provider is swappable — "}
          <a href={provider.docs} target="_blank" rel="noopener noreferrer" style={{ color: "var(--signal)" }}>
            {provider.label} API
          </a>{" "}
          {isFeedMode ? "built the entries below." : "is answering right now."}
        </footer>
      </div>
    </div>
  );
}
