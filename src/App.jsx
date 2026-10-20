import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { SEED } from "./data/seed.js";
import { SECTIONS, sectionFor, modelsFor, familyLabel, MODEL_FAMILIES } from "./lib/check.js";
import { storage } from "./lib/storage.js";
import { fetchUpdates, isFeedMode } from "./lib/wire-api.js";
import { PROVIDERS, byId, DEFAULT_PROVIDER } from "./lib/providers/index.js";

const REPO = "https://github.com/juubaker/ai-wire";

/**
 * Where feedback goes.
 *
 * GitHub issues rather than a mailto:, because an address published in plain
 * HTML is harvested by scrapers within days, and an issue thread survives
 * better than a one-off email. To use email instead, swap this for
 * `mailto:you@example.com?subject=AI%20Wire%20feedback` — nothing else changes.
 */
const FEEDBACK_URL = `${REPO}/issues/new`;

/**
 * The clock, read once at module load rather than during render.
 *
 * A useState lazy initializer still runs during the first render, so
 * `useState(() => Date.now())` is the same impurity in a nicer coat. Module
 * scope runs before any render, so this is a constant as far as React is
 * concerned. Everything derived from it changes by the day, and the hourly
 * interval below keeps a long-lived tab honest.
 */
const LOADED_AT = Date.now();

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

/**
 * The entry's real host, shown next to the model-written `source`.
 *
 * `source` is prose the model chose and it is demonstrably unreliable: an
 * audit of 46 entries found a university page filed as "Meta", an AWS page
 * filed as "Anthropic", and a third-party release tracker filed as "OpenAI",
 * alongside wikis and funding trackers presented as vendor announcements.
 * The domain is the one thing that cannot be wrong, and it was the only part
 * of the provenance not on screen.
 */
function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function fmtDate(d, currentYear) {
  const t = new Date(d + "T00:00:00");
  if (isNaN(t)) return d;
  // The year is only shown when it isn't the current one — a changelog is
  // mostly recent, and repeating "2026" on every row is noise.
  // `currentYear` is passed in rather than read here: this runs during render,
  // and React requires render to be pure — two renders reading the clock could
  // disagree.
  const sameYear = t.getFullYear() === currentYear;
  return t
    .toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    })
    .toUpperCase();
}

/**
 * Inclusive bounds for the active range, as YYYY-MM-DD strings or null.
 *
 * `now` is a parameter because this is called from useMemo — i.e. during
 * render — and reading the clock there is impure.
 */
function bounds(range, now) {
  if (range.id === "custom") return { from: range.from || null, to: range.to || null };
  const preset = RANGES.find((r) => r.id === range.id);
  if (!preset?.days) return { from: null, to: null };
  const start = new Date(now);
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
  const [query, setQuery] = useState("");
  const [range, setRange] = useState({ id: "all", from: "", to: "" });
  const [tab, setTab] = useState("all");
  const [model, setModel] = useState("all");
  /**
   * One reading of the clock per tick, rather than a Date.now() wherever a date
   * is needed. Render must be pure: calling the clock inside a useMemo or in
   * JSX means two renders of the same state can disagree, and React flags it.
   *
   * Refreshed hourly, because everything derived from it — the staleness
   * banner, relative date ranges, the copyright year — changes by the day.
   */
  const [now, setNow] = useState(LOADED_AT);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);
  const currentYear = useMemo(() => new Date(now).getFullYear(), [now]);

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
  const placed = useMemo(
    () => items.map((i) => ({ ...i, section: sectionFor(i), models: modelsFor(i) })),
    [items]
  );

  const inTab = useMemo(
    () => (tab === "all" ? placed : placed.filter((i) => i.section === tab)),
    [placed, tab]
  );

  const inRange = useMemo(() => {
    const { from, to } = bounds(range, now);
    if (!from && !to) return inTab;
    return inTab.filter((i) => (!from || i.date >= from) && (!to || i.date <= to));
  }, [inTab, range, now]);

  /**
   * Free-text match across everything a reader can see on an entry, including
   * the host — searching "arxiv" or "anthropic.com" should work, and the host
   * is on screen now so it ought to be searchable.
   *
   * Multiple words are ANDed, in any order and any field: "gemini pricing"
   * matches an entry whose title says Gemini and whose type says Pricing.
   */
  const matchesQuery = useCallback(
    (i) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      const hay = `${i.title} ${i.summary} ${i.source} ${i.type} ${hostOf(i.url)}`.toLowerCase();
      return q.split(/\s+/).every((term) => hay.includes(term));
    },
    [query]
  );

  // Search narrows before the chip counts are taken, so the counts stay
  // reachable: a type chip reading "3" means three entries you can actually
  // land on, not three that exist somewhere outside the search.
  const matched = useMemo(() => inRange.filter(matchesQuery), [inRange, matchesQuery]);

  // Tab counts respect the date range and the search, but not the type chip,
  // so switching tabs never lands on an empty list because of a type that
  // doesn't exist there — while a search still tells you which tabs hold hits.
  const tabCounts = useMemo(() => {
    const { from, to } = bounds(range, now);
    const dated = placed.filter(
      (i) => (!from || i.date >= from) && (!to || i.date <= to) && matchesQuery(i)
    );
    const counts = { all: dated.length };
    SECTIONS.forEach((sec) => {
      counts[sec.id] = dated.filter((i) => i.section === sec.id).length;
    });
    return counts;
  }, [placed, range, now, matchesQuery]);

  const matchesModel = (i) => model === "all" || (i.models || []).includes(model);
  const matchesType = (i) => filter === "All" || i.type === filter;

  // Each chip row counts against the OTHER row's active filter, so a count you
  // can see is always a count you can reach. Showing totals here instead would
  // let you click a chip and land on an empty list.
  const types = useMemo(() => {
    const counts = new Map();
    matched.filter(matchesModel).forEach((i) => counts.set(i.type, (counts.get(i.type) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [matched, model]);

  const modelCounts = useMemo(() => {
    const counts = new Map();
    matched.filter(matchesType).forEach((i) => {
      // An entry can belong to several families and is counted under each.
      (i.models || []).forEach((m) => counts.set(m, (counts.get(m) || 0) + 1));
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [matched, filter]);

  // Registered families with nothing on the wire yet. Named rather than
  // charted, so "where's my filter?" has an answer on the page.
  const untrackedFamilies = useMemo(() => {
    const present = new Set(placed.flatMap((i) => i.models || []));
    return MODEL_FAMILIES.filter((f) => !present.has(f.id)).map((f) => f.label);
  }, [placed]);

  const shown = useMemo(() => {
    const list = matched.filter((i) => matchesType(i) && matchesModel(i));
    return [...list].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [matched, filter, model]);

  // There used to be two effects here that silently reset a chip whenever it
  // matched nothing. They were wrong in the common case: narrowing the date
  // range to zero results also wiped the type and model the user had picked,
  // discarding an explicit choice without saying so. The active-filter pills
  // do that job honestly — every filter is visible and one click removes it —
  // so the magic is gone.

  /**
   * A stale wire looks exactly like a fresh one — same entries, same layout —
   * which is the worst failure mode a news page can have. Say it outright.
   *
   * Measured from the newest entry rather than the last check: a check that
   * runs hourly and finds nothing is fine, but a wire whose newest item is a
   * week old means retrieval has quietly stopped working.
   */
  const staleness = useMemo(() => {
    const newest = items.map((i) => i.date).sort().slice(-1)[0];
    if (!newest) return null;
    const days = Math.floor((now - new Date(`${newest}T00:00:00`)) / 86400000);
    if (days < 2) return null;
    return {
      days,
      everChecked: Boolean(lastCheck),
    };
  }, [items, lastCheck, now]);

  const earliest = useMemo(
    () => items.map((i) => i.date).sort()[0] || "2026-01-01",
    [items]
  );

  /**
   * What's narrowing the view right now, each with its own undo. This doubles
   * as the collapsed state of the filter drawer: with four independent
   * dimensions, you need one place that says what's applied and one way out.
   * The tab isn't included — it's navigation, and it's always visible above.
   */
  const activeFilters = useMemo(() => {
    const active = [];
    if (range.id !== "all") {
      const preset = RANGES.find((r) => r.id === range.id);
      active.push({
        key: "when",
        label:
          range.id === "custom"
            ? `${range.from || "any"} → ${range.to || "now"}`
            : preset.label,
        clear: () => setRange({ id: "all", from: "", to: "" }),
      });
    }
    if (filter !== "All") active.push({ key: "what", label: filter, clear: () => setFilter("All") });
    if (model !== "all")
      active.push({ key: "model", label: familyLabel(model), clear: () => setModel("all") });
    return active;
  }, [range, filter, model]);

  const clearFilters = () => {
    setQuery("");
    setRange({ id: "all", from: "", to: "" });
    setFilter("All");
    setModel("all");
  };

  // Opening the drawer is a deliberate act; it stays open until dismissed, so
  // adjusting two filters in a row doesn't mean two trips.
  const [filtersOpen, setFiltersOpen] = useState(false);

  return (
    <div className="wire-root">
      <div className="wire-shell">
        <header className="masthead">
          <div className="eyebrow mono">Primary sources only · LLM systems desk</div>
          <h1>AI WIRE</h1>
          {/* One line, not three: this is read once and then skipped forever. */}
          <p className="standfirst">
            What shipped, from the announcement itself. Leave it open and new entries drop in.
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
          {/* The entry count lives on the tabs; repeating it here just taught
              the eye to skip counts, including the ones that narrow. */}
          <span>LAST CHECK {fmtClock(lastCheck)}</span>
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

        {staleness && (
          <div className="stale mono" role="status">
            <strong>Nothing new in {staleness.days} days.</strong>{" "}
            {staleness.everChecked
              ? "Checks are running but finding nothing, which usually means retrieval has broken rather than that the industry went quiet."
              : "No check has succeeded yet — everything here is seed content."}
          </div>
        )}

        {/* Collapsed by default: three always-open rows pushed the first entry
            below the fold. The summary below carries the active state. */}
        <div className="filterbar flex flex-wrap items-center gap-2 mt-3">
          <span className="searchbox">
            <span className="searchicon mono" aria-hidden="true">⌕</span>
            {/*
              Escape clears an <input type="search"> natively WITHOUT firing an
              input event. On a controlled input that desyncs the DOM from
              React: the box looks empty, `query` still holds the old text, the
              list stays filtered, and nothing reconciles the two because no
              render is triggered. Handled explicitly, and `onInput` backs up
              `onChange` for any other path a browser clears by.
            */}
            <input
              type="search"
              className="searchinput mono"
              placeholder="Search entries…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setQuery("");
                }
              }}
              aria-label="Search entries by keyword"
            />
            {query && (
              <button
                type="button"
                className="searchclear mono"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                title="Clear search"
              >
                ✕
              </button>
            )}
          </span>

          <button
            className="chip mono"
            data-on={filtersOpen}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((o) => !o)}
          >
            {filtersOpen ? "Hide filters" : "Filters"}
            {activeFilters.length > 0 && <span className="tabcount">{activeFilters.length}</span>}
          </button>

          {activeFilters.map((f) => (
            <button
              key={f.key}
              className="activefilter mono"
              onClick={f.clear}
              title={`Remove the ${f.key} filter`}
            >
              {f.label}
              <span aria-hidden="true">✕</span>
            </button>
          ))}

          {activeFilters.length > 1 && (
            <button className="linkbtn mono" onClick={clearFilters}>
              clear all
            </button>
          )}

          <span className="ml-auto mono showing">
            {shown.length === items.length
              ? `${items.length} entries`
              : `${shown.length} of ${items.length}`}
          </span>
        </div>

        {filtersOpen && (
        <>
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
        <div className="filterrow flex flex-wrap items-center gap-2 mt-2">
          <span className="filterlabel mono">What</span>
          <button className="chip mono" data-on={filter === "All"} onClick={() => setFilter("All")}>
            All · {matched.filter(matchesModel).length}
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

        {/* model family — only families actually present are offered */}
        {(modelCounts.length > 0 || model !== "all") && (
          <div className="filterrow flex flex-wrap items-center gap-2 mt-2">
            <span className="filterlabel mono">Model</span>
            <button className="chip mono" data-on={model === "all"} onClick={() => setModel("all")}>
              Any · {matched.filter(matchesType).length}
            </button>
            {modelCounts.map(([id, n]) => (
              <button
                key={id}
                className="chip mono"
                data-on={model === id}
                onClick={() => setModel(id)}
              >
                {familyLabel(id)} · {n}
              </button>
            ))}
            {/* Chips only exist for families that have entries, which reads as
                "this family isn't tracked" when it just means nothing has
                mentioned it yet. One muted line answers that, where a dozen
                zero-count chips would only add noise. */}
            {untrackedFamilies.length > 0 && (
              <span className="alsotracking mono" title={untrackedFamilies.join(", ")}>
                also watching {untrackedFamilies.length} more
              </span>
            )}
          </div>
        )}
        </>
        )}

        <div className="mb-7" />

        <div className="rail">
          {shown.length === 0 && (
            <p className="mono" style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>
              {inTab.length === 0
                ? "Nothing filed in this section yet. Run a check, or try another tab."
                : inRange.length === 0
                  ? "No entries in that date range. Widen it, or try another tab."
                  : matched.length === 0
                    ? `Nothing matches “${query.trim()}”. Try fewer words, or search another tab.`
                    : `No ${filter === "All" ? "" : `${filter} `}entries${
                        model === "all" ? "" : ` for ${familyLabel(model)}`
                      }${query.trim() ? ` matching “${query.trim()}”` : ""} in that date range.`}
            </p>
          )}
          {shown.map((i) => {
            const isNew = newIds.includes(i.id);
            return (
              <article key={i.id} className={"entry" + (isNew ? " fresh" : "")}>
                <span className="node mono" data-new={isNew} aria-hidden="true">
                  {isNew ? "+" : "·"}
                </span>
                {/* Dateline, then headline, then the rest. The title is what
                    people scan for, so nothing but the date precedes it. */}
                <div className="dateline mono flex flex-wrap items-center gap-2">
                  <span>{fmtDate(i.date, currentYear)}</span>
                  <span className="dateline-source">{i.source}</span>
                  {hostOf(i.url) && <span className="dateline-host">{hostOf(i.url)}</span>}
                  {isNew && <span className="badge warn">New</span>}
                  {i.flagged && <span className="badge warn">⚑ {i.flagged}</span>}
                </div>
                <a className="head" href={i.url} target="_blank" rel="noopener noreferrer">
                  {i.title} ↗
                </a>
                <p>{i.summary}</p>
                <div className="meta mono flex flex-wrap items-center gap-2 mt-1">
                  {/* "Primary" on 14 of 15 entries is a label for the default,
                      which costs a slot and carries nothing. Flag the exception. */}
                  {i.tier === "Secondary" && <span className="badge second">Secondary</span>}
                  <span className="badge second">{i.type}</span>
                  {(i.models || []).map((m) => (
                    <button
                      key={m}
                      className="badge badge-model"
                      onClick={() => setModel(m)}
                      title={`Filter to ${familyLabel(m)}`}
                    >
                      {familyLabel(m)}
                    </button>
                  ))}
                  {i.via && <span className="badge second">via {byId(i.via).label}</span>}
                </div>
              </article>
            );
          })}
        </div>

        <footer
          className="mono mt-8 pt-4"
          style={{ fontSize: ".65rem", color: "var(--ink-soft)", borderTop: "1px solid var(--rule)" }}
        >
          {/* Two different claims, so two different sentences. The old copy
              named the local provider in feed mode and said it "built the
              entries", which was false twice over: the scheduled job builds
              them, and the per-entry "via" badge is the accurate attribution. */}
          Entries are kept on this device between visits, and each one is classified by the model
          that filed it — so the filter rows grow as new kinds of news arrive.{" "}
          {isFeedMode ? (
            <>
              This site reads a shared feed rebuilt on a schedule: no key is involved and every
              visitor sees the same wire. Each entry&rsquo;s <span className="badge second">via</span>{" "}
              badge names the provider that filed it.
            </>
          ) : (
            <>
              The provider is swappable, and{" "}
              <a
                href={provider.docs}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--signal)" }}
              >
                {provider.label}
              </a>{" "}
              is answering right now.
            </>
          )}

          {/* The MIT grant covers the code and nothing else. Every entry
              summarises and links to someone else's announcement or paper,
              which stays theirs — worth stating where people read it, not
              only in the repo. */}
          <div className="colophon">
            <a href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">
              MIT licensed
            </a>
            {" · "}
            <a href={REPO} target="_blank" rel="noopener noreferrer">
              source
            </a>
            {" · "}
            {/* A wire that classifies and summarises automatically will get
                things wrong — a miscategorised entry, a thin summary, a source
                worth adding. Saying so should take one click from the page
                itself, not a hunt through the repo. */}
            <a href={FEEDBACK_URL} target="_blank" rel="noopener noreferrer">
              report a problem or suggest a source
            </a>
            {" · "}© {currentYear} John William Baker. Entries summarise and link to
            other people&rsquo;s announcements, which remain theirs.
          </div>
        </footer>
      </div>
    </div>
  );
}
