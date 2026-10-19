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
  RESPONSE_SCHEMA,
  canonicalUrl,
  isUnapprovedXPost,
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

describe("the injected prompt must not ask for what the data lacks", () => {
  test("no date filter — search results carry no publication date", () => {
    // Ollama's search API returns title, url and content. Nothing else.
    // Telling the model to drop results "older than <date>" asks it to filter
    // on a field it cannot see, and a careful model answers an unanswerable
    // constraint with []. Measured before this change: 59 results, 1 entry.
    const results = [{ title: "T", url: "https://a/b", content: "c", query: "q" }];
    const prompt = buildPrompt(SEED, { supportsSearch: false }, results);
    assert.doesNotMatch(prompt, /older than/i, "cannot filter on an absent field");
    assert.match(prompt, /appears verbatim/, "the url guard must survive");
    assert.match(prompt, /already on the wire/i, "repeats are still called out");
  });

  test("instructions stay OUT of the example values", () => {
    // A model emitted {"date":"2026-10-16 —"} because the guidance lived
    // inside the example value and got copied out as data. Field notes go
    // after the template, never in it.
    const results = [{ title: "T", url: "https://a/b", content: "c", query: "q" }];
    const prompt = buildPrompt(SEED, { supportsSearch: false }, results);
    const today = new Date().toISOString().slice(0, 10);

    assert.match(prompt, /"date":"YYYY-MM-DD"/, "the example value is a bare format");
    assert.doesNotMatch(
      prompt,
      /"date":"YYYY-MM-DD[^"]/,
      "nothing may follow the format inside the quoted value"
    );
    assert.ok(prompt.includes(today), "today's date must be supplied, not implied");
    assert.match(prompt, /never guess a date/i);
    assert.match(prompt, /must never appear in a value/i);
  });

  test("tier is explained, because the model was putting a section id there", () => {
    const results = [{ title: "T", url: "https://a/b", content: "c", query: "q" }];
    const prompt = buildPrompt(SEED, { supportsSearch: false }, results);
    assert.match(prompt, /never a section name/i);
  });

  test("searching providers keep their date anchor — they can see dates", () => {
    const prompt = buildPrompt(SEED, { supportsSearch: true });
    assert.match(prompt, /published AFTER/, "a model that searches knows publication dates");
  });
});

describe("parseArray must not mistake a nested array for the entry list", () => {
  // The bug that produced a day of misleading diagnostics. Ollama's
  // `format: "json"` emitted one bare entry object; parseArray scanned for the
  // first "[" and the last "]", found them inside "models":["Claude"], and
  // returned ["Claude"] as the entry list. normalize() dropped that string for
  // having no url, and the funnel reported "already known 1 dropped" — so every
  // signal pointed at retrieval, the prompt, or model size. None of those.
  const realFailure = JSON.stringify({
    date: "2026-10-16",
    source: "Anthropic",
    tier: "Primary",
    section: "product",
    models: ["Claude"],
    title: "Claude Haiku 5.5",
    summary: "Fastest model in the 5.5 family.",
    url: "https://www.anthropic.com/claude-haiku-5-5",
  });

  test("a bare entry object becomes one real entry, not its models array", () => {
    const out = parseArray(realFailure);
    assert.equal(out.length, 1);
    assert.equal(typeof out[0], "object", "must be an entry, not the string 'Claude'");
    assert.equal(out[0].url, "https://www.anthropic.com/claude-haiku-5-5");
    assert.equal(out[0].title, "Claude Haiku 5.5");
  });

  test("a wrapped list is not confused by a sibling string array", () => {
    const out = parseArray(
      JSON.stringify({ note: "here", models: ["Claude", "GPT"], entries: [{ title: "a", url: "u" }] })
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].url, "u", "the object array wins over the string array");
  });

  test("every entry returned is an object, whatever the input shape", () => {
    const shapes = [
      '[{"title":"a","url":"u"}]',
      '{"entries":[{"title":"a","url":"u"}]}',
      'Sure:\n[{"title":"a","url":"u"}]',
      '```json\n[{"title":"a","url":"u"}]\n```',
      realFailure,
    ];
    for (const shape of shapes) {
      const out = parseArray(shape);
      assert.ok(out.length >= 1, `nothing parsed from: ${shape.slice(0, 40)}`);
      for (const e of out) assert.equal(typeof e, "object", `non-object from: ${shape.slice(0, 40)}`);
    }
  });

  test("an array of bare strings is not an entry list, in any shape", () => {
    assert.deepEqual(parseArray('["Claude","GPT"]'), [], "top-level string array");
    assert.deepEqual(parseArray('Here: ["Claude","GPT"]'), [], "sliced string array");
    assert.deepEqual(parseArray('{"models":["Claude","GPT"]}'), [], "nested string array");
  });

  test("the schema asks for an array and constrains tier", () => {
    const items = RESPONSE_SCHEMA.properties.entries;
    assert.equal(items.type, "array", "the grammar must permit more than one entry");
    assert.deepEqual(items.items.properties.tier.enum, ["Primary", "Secondary"]);
    assert.ok(items.items.properties.section.enum.includes("product"));
  });
});

describe("dedupe keys on the url alone", () => {
  test("a reworded title is not a new entry", () => {
    // The title is model-written prose. Keying on url+title meant the same
    // announcement came back with a new headline and passed as new — three
    // entries from one run reappeared in the next.
    const known = [{ url: "https://a.com/x", title: "Thing shipped" }];
    const out = normalize([{ url: "https://a.com/x", title: "Thing Availability" }], known, "p");
    assert.equal(out.length, 0);
  });

  test("the same entry twice in one batch lands once", () => {
    // `seen` was built from `known` and never updated, so a model that listed
    // a release twice in one response got it onto the wire twice.
    const batch = [
      { url: "https://a.com/x", title: "A" },
      { url: "https://a.com/x", title: "A" },
    ];
    assert.equal(normalize(batch, [], "p").length, 1);
  });

  test("trailing slashes, fragments and utm params are the same entry", () => {
    const batch = [
      { url: "https://a.com/x", title: "A" },
      { url: "https://A.com/x/", title: "B" },
      { url: "https://a.com/x?utm_source=news", title: "C" },
      { url: "https://a.com/x#section", title: "D" },
    ];
    assert.equal(normalize(batch, [], "p").length, 1);
  });

  test("a different path is a different entry", () => {
    const batch = [
      { url: "https://a.com/x", title: "A" },
      { url: "https://a.com/y", title: "B" },
    ];
    assert.equal(normalize(batch, [], "p").length, 2);
  });

  test("canonicalUrl survives junk without throwing", () => {
    for (const bad of ["", null, undefined, "not a url", "://broken"]) {
      assert.equal(typeof canonicalUrl(bad), "string");
    }
  });
});

describe("the prompt must not bias toward one beat", () => {
  const results = [{ title: "T", url: "https://a/b", content: "c", query: "q" }];

  test("no 'changelog' framing — it filled every slot with releases", () => {
    // Three consecutive runs returned entries that were 100% `product`, while
    // acquisitions and 2026 papers sat unpicked in the same result set. The
    // opening line called this a "changelog wire", which is a releases framing.
    const prompt = buildPrompt(SEED, { supportsSearch: false }, results);
    assert.doesNotMatch(prompt, /changelog wire/);
    assert.match(prompt, /three beats/);
  });

  test("every section is named with its brief", () => {
    const prompt = buildPrompt(SEED, { supportsSearch: false }, results);
    for (const sec of SECTIONS) {
      assert.ok(prompt.includes(sec.id), `section id missing: ${sec.id}`);
      assert.ok(prompt.includes(sec.brief), `section brief missing: ${sec.id}`);
    }
  });

  test("an explicit instruction not to return only product", () => {
    const prompt = buildPrompt(SEED, { supportsSearch: false }, results);
    assert.match(prompt, /Spread your picks across sections/);
    assert.match(prompt, /entirely\s*"product"/);
  });
});

describe("X posts: only the labs' own accounts are a primary source", () => {
  test("an official account passes", () => {
    for (const url of [
      "https://x.com/AnthropicAI/status/123",
      "https://x.com/openai/status/9",
      "https://twitter.com/GoogleDeepMind/status/5",
    ]) {
      assert.equal(isUnapprovedXPost(url), false, url);
    }
  });

  test("anyone else is blocked, however insightful the thread", () => {
    // The wire's founding rule named X threads as something to skip. The
    // reconciliation is the account, not the platform — and it's enforced
    // here rather than asked for in the prompt, because an instruction a model
    // can quietly stop following is not a guarantee.
    for (const url of [
      "https://x.com/some_pundit/status/77",
      "https://x.com/",
      "https://twitter.com/randomdev/status/1",
    ]) {
      assert.equal(isUnapprovedXPost(url), true, url);
    }
  });

  test("non-X links are untouched by the gate", () => {
    for (const url of [
      "https://www.anthropic.com/news/thing",
      "https://arxiv.org/abs/2610.14146",
      "https://openai.com/index/x-com-partnership/",
      "not a url",
    ]) {
      assert.equal(isUnapprovedXPost(url), false, url);
    }
  });

  test("normalize drops an unapproved X post even with a valid url and title", () => {
    const batch = [
      { url: "https://x.com/some_pundit/status/77", title: "Hot take on Claude" },
      { url: "https://x.com/AnthropicAI/status/88", title: "Claude Haiku 5.5 is out" },
    ];
    const out = normalize(batch, [], "p");
    assert.equal(out.length, 1);
    assert.match(out[0].url, /AnthropicAI/);
  });

  test("the social section exists and is offered to the model", () => {
    assert.ok(SECTIONS.some((s) => s.id === "social"));
    const prompt = buildPrompt(SEED, { supportsSearch: false }, [
      { title: "T", url: "https://a/b", content: "c", query: "q" },
    ]);
    assert.match(prompt, /only a lab's or vendor's OWN account counts/i);
  });
});

describe("editorial rules that were being ignored", () => {
  const results = [{ title: "T", url: "https://a/b", content: "c", query: "q" }];

  test("titles must name their subject", () => {
    // Shipped entries: "$1.5B Series E Funding" and "Acquisition of Loops".
    // Neither says who. The guidance was three words inside the example value
    // ("specific, version numbers kept") and got ignored; it's now a field note
    // with the actual failures quoted back.
    const prompt = buildPrompt(SEED, { supportsSearch: false }, results);
    assert.match(prompt, /name the subject/i);
    assert.match(prompt, /Who raised, who acquired whom/i);
    assert.doesNotMatch(prompt, /"title":"under 70 chars, specific/);
  });

  test("roundups are refused, and the rule says what to do instead", () => {
    // "AI Funding Roundup" reached the wire despite the skip list, which had
    // bundled roundups into a long sentence with four other exclusions.
    const prompt = buildPrompt(SEED, { supportsSearch: false }, results);
    assert.match(prompt, /Skip roundups/);
    assert.match(prompt, /One title, one event, one primary source/);
  });
});

describe("one event, many write-ups", () => {
  // "Jev 1.14.0 Release" reached the wire five times: a community wiki (twice),
  // a gateway changelog, and two third-party news sites. Every url genuinely
  // distinct, so url dedupe passed all five. An identical title is the
  // strongest same-event signal available without fuzzy matching.
  const sameEvent = [
    { url: "https://jevwiki.ai/wiki/reference/models-and-pricing.md", title: "Jev 1.14.0 Release" },
    { url: "https://jevwiki.ai/wiki/entities/jev.md", title: "Jev 1.14.0 Release" },
    { url: "https://vercel.com/changelog/jev-1-14-gateway", title: "Jev 1.14.0 Release" },
    { url: "https://jevainews.com/jev-day-2026/", title: "Jev 1.14.0 Release" },
  ];

  test("five write-ups of one release become one entry", () => {
    assert.equal(normalize(sameEvent, [], "p").length, 1);
  });

  test("a title already on the wire is not re-reported under a new url", () => {
    const known = [{ url: "https://somewhere.else/x", title: "Jev 1.14.0 Release" }];
    assert.equal(normalize(sameEvent, known, "p").length, 0);
  });

  test("case and punctuation don't make it a new event", () => {
    const batch = [
      { url: "https://a.com/1", title: "Jev 1.14.0 Release" },
      { url: "https://b.com/2", title: "jev 1.14.0  release!" },
    ];
    assert.equal(normalize(batch, [], "p").length, 1);
  });

  test("a different version is a different event", () => {
    const batch = [
      { url: "https://a.com/1", title: "Jev 1.14.0 Release" },
      { url: "https://a.com/2", title: "Jev 1.15.0 Release" },
    ];
    assert.equal(normalize(batch, [], "p").length, 2, "version numbers distinguish releases");
  });
});
