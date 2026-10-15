/**
 * Tests for the pure logic — classification, parsing, prompt assembly.
 *
 *   npm test
 *
 * Node's built-in runner, so there's nothing to install. Everything here is a
 * pure function: no network, no filesystem, no React. The parts that do touch
 * the network (run-check, search, the providers) are covered by the stubbed
 * end-to-end test in test/run-check.test.js instead.
 *
 * Several of these are regression tests for bugs that actually shipped during
 * development; those say so, because a test whose reason is forgotten is a
 * test someone deletes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  modelsFor,
  sectionFor,
  parseArray,
  normalize,
  buildPrompt,
  newestDate,
  familyLabel,
  MODEL_FAMILIES,
  SECTIONS,
} from "../src/lib/check.js";
import { SEED } from "../src/data/seed.js";

const entry = (over = {}) => ({ title: "", summary: "", source: "", ...over });

describe("modelsFor — which model families an entry concerns", () => {
  test("finds a family named in the title", () => {
    assert.deepEqual(modelsFor(entry({ title: "Gemini 3.7 Flash GA" })), ["gemini"]);
  });

  test("returns several when an entry concerns several", () => {
    const got = modelsFor(entry({ title: "Claude vs Gemini vs Llama on SWE-bench" }));
    assert.deepEqual(got.sort(), ["claude", "gemini", "llama"]);
  });

  test("returns none for genuinely model-agnostic entries", () => {
    // A protocol revision and a funding round legitimately have no family.
    assert.deepEqual(modelsFor(entry({ title: "MCP goes stateless", source: "MCP" })), []);
  });

  test("normalises a version the model reported into its family", () => {
    // The model is asked for families but often answers with a version.
    assert.deepEqual(modelsFor(entry({ models: ["Claude Opus 5"] })), ["claude"]);
  });

  test("accepts a family id directly", () => {
    assert.deepEqual(modelsFor(entry({ models: ["gemini"] })), ["gemini"]);
  });

  describe("word boundaries — short match terms must not match inside words", () => {
    // Regression: "sol", "luna" and "terra" are GPT-5.6 model names, and a
    // substring match had them firing on "solution" and "lunar".
    for (const [text, why] of [
      ["A solution for lunar terraforming", "sol/luna/terra inside words"],
      ["This will amuse you", "muse inside amuse"],
      ["Graphic philosophy", "phi inside philosophy"],
      ["Innovation in casanova", "nova inside casanova"],
    ]) {
      test(why, () => assert.deepEqual(modelsFor(entry({ title: text })), []));
    }
  });

  test("still matches those names when they stand alone", () => {
    assert.deepEqual(modelsFor(entry({ title: "GPT-5.6 Sol pricing" })), ["gpt"]);
  });

  describe("vendor names count as the family", () => {
    test("from the source field", () => {
      assert.deepEqual(modelsFor(entry({ title: "Python SDK v1.0", source: "Anthropic" })), [
        "claude",
      ]);
    });

    test("from the title, when a third party reports it", () => {
      // Regression: vendor names were matched only against `source`, so a
      // funding story carried by TechCrunch came back with no family at all.
      assert.deepEqual(
        modelsFor(entry({ title: "TypeSafe AI raises $40M seed", source: "TechCrunch" })),
        ["jev"]
      );
    });
  });

  test("every registered family has a label and at least one match term", () => {
    for (const f of MODEL_FAMILIES) {
      assert.ok(f.id && f.label, `${f.id}: needs an id and a label`);
      assert.ok(f.match.length > 0, `${f.id}: needs at least one match term`);
      assert.ok(Array.isArray(f.vendor), `${f.id}: vendor must be an array`);
      assert.equal(familyLabel(f.id), f.label);
    }
  });

  describe("against the seed entries", () => {
    // Properties, not an exact tally: a snapshot of the counts would break on
    // every seed edit without catching anything a property wouldn't.
    const ids = new Set(MODEL_FAMILIES.map((f) => f.id));

    test("only ever returns registered family ids", () => {
      for (const e of SEED) {
        for (const f of modelsFor(e)) assert.ok(ids.has(f), `${f} is not a registered family`);
      }
    });

    test("no entry is assigned the same family twice", () => {
      for (const e of SEED) {
        const got = modelsFor(e);
        assert.equal(new Set(got).size, got.length, `${e.title} has duplicates`);
      }
    });

    test("vendor entries resolve to their family", () => {
      const bySource = (s) => SEED.filter((e) => e.source === s);
      for (const [source, family] of [
        ["Anthropic", "claude"],
        ["OpenAI", "gpt"],
        ["Google", "gemini"],
      ]) {
        const entries = bySource(source);
        assert.ok(entries.length > 0, `no seed entries from ${source}`);
        for (const e of entries) {
          assert.ok(modelsFor(e).includes(family), `${e.title} should be ${family}`);
        }
      }
    });

    test("model-agnostic entries get no family", () => {
      // The MCP revision and the arXiv papers are about no particular model.
      const agnostic = SEED.filter((e) => ["MCP"].includes(e.source) || /^arXiv/.test(e.source));
      assert.ok(agnostic.length > 0, "expected some model-agnostic seed entries");
      for (const e of agnostic) assert.deepEqual(modelsFor(e), [], `${e.title} should have none`);
    });
  });
});

describe("sectionFor — which tab an entry belongs to", () => {
  test("uses the section the model gave, case-insensitively", () => {
    assert.equal(sectionFor({ section: "BUSINESS", type: "Pricing" }), "business");
  });

  test("falls back to the type when the section is missing", () => {
    assert.equal(sectionFor({ type: "Research" }), "innovation");
    assert.equal(sectionFor({ type: "Industry" }), "business");
    assert.equal(sectionFor({ type: "Pricing" }), "product");
  });

  test("falls back when the section is unrecognised", () => {
    assert.equal(sectionFor({ section: "miscellaneous", type: "Protocol" }), "product");
  });

  test("never returns a section that has no tab", () => {
    const ids = SECTIONS.map((s) => s.id);
    for (const e of [...SEED, { type: "nonsense" }, {}]) {
      assert.ok(ids.includes(sectionFor(e)), `${sectionFor(e)} has no tab`);
    }
  });
});

describe("parseArray — models rarely return clean JSON", () => {
  test("plain array", () => {
    assert.deepEqual(parseArray('[{"url":"u"}]'), [{ url: "u" }]);
  });

  test("fenced in markdown", () => {
    assert.deepEqual(parseArray('```json\n[{"url":"u"}]\n```'), [{ url: "u" }]);
  });

  test("wrapped in prose", () => {
    assert.deepEqual(parseArray('Here you go:\n[{"url":"u"}]\nHope that helps!'), [{ url: "u" }]);
  });

  test("wrapped in an object, which JSON mode tends to produce", () => {
    assert.deepEqual(parseArray('{"entries":[{"url":"u"}]}'), [{ url: "u" }]);
  });

  test("returns [] rather than throwing on junk", () => {
    for (const junk of ["sorry, nothing found", "", "{", "null", undefined]) {
      assert.deepEqual(parseArray(junk), []);
    }
  });
});

describe("normalize — what reaches the feed", () => {
  const known = [{ url: "https://a", title: "A", date: "2026-09-01" }];

  test("drops entries already on the wire", () => {
    const got = normalize([{ url: "https://a", title: "A" }], known, "ollama");
    assert.equal(got.length, 0);
  });

  test("keeps entries that are new", () => {
    const got = normalize([{ url: "https://b", title: "B" }], known, "ollama");
    assert.equal(got.length, 1);
  });

  test("drops entries with no url or no title", () => {
    const got = normalize([{ url: "https://b" }, { title: "B" }, null], known, "ollama");
    assert.equal(got.length, 0);
  });

  test("stamps section, models and provider", () => {
    const [got] = normalize(
      [{ url: "https://b", title: "Gemini 4 ships", type: "Model release" }],
      known,
      "ollama"
    );
    assert.equal(got.section, "product");
    assert.deepEqual(got.models, ["gemini"]);
    assert.equal(got.via, "ollama");
  });

  test("coerces a bad date to today rather than dropping the entry", () => {
    const [got] = normalize([{ url: "https://b", title: "B", date: "last Tuesday" }], known, "x");
    assert.match(got.date, /^\d{4}-\d{2}-\d{2}$/);
  });

  test("defaults an unknown tier to Primary", () => {
    const [got] = normalize([{ url: "https://b", title: "B", tier: "nonsense" }], known, "x");
    assert.equal(got.tier, "Primary");
  });
});

describe("buildPrompt — three retrieval modes", () => {
  const results = [{ title: "T", url: "https://docs.example/x", content: "..." }];

  test("native: tells a searching model to search", () => {
    const p = buildPrompt(SEED, { supportsSearch: true });
    assert.match(p, /Search the web for developments/);
  });

  test("memory: tells a model with no search that [] is a valid answer", () => {
    const p = buildPrompt(SEED, { supportsSearch: false });
    assert.match(p, /You cannot search/);
    assert.match(p, /Returning \[\] is the correct answer/);
  });

  test("injected: forbids inventing a url outside the supplied results", () => {
    // This instruction plus the url guard in run-check is what keeps a local
    // model from filling the wire with plausible-looking dead links.
    const p = buildPrompt(SEED, { supportsSearch: false }, results);
    assert.match(p, /SEARCH RESULTS/);
    assert.match(p, /never write a url that is not listed here/);
    assert.ok(p.includes("https://docs.example/x"));
  });

  test("always asks for the fields the UI filters on", () => {
    const p = buildPrompt(SEED, { supportsSearch: true });
    for (const field of ['"section"', '"models"', '"type"', '"tier"', '"flagged"']) {
      assert.ok(p.includes(field), `prompt is missing ${field}`);
    }
  });

  test("anchors on the newest entry so the model doesn't re-report old news", () => {
    const p = buildPrompt(SEED, { supportsSearch: true });
    assert.ok(p.includes(newestDate(SEED)));
  });

  test("newestDate handles an empty wire", () => {
    assert.match(newestDate([]), /^\d{4}-\d{2}-\d{2}$/);
  });
});
