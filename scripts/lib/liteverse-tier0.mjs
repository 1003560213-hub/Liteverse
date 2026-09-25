// Liteverse Tier-0 knowledge: deterministic, dependency-free extraction of the
// essential points of each paper and of the connections between papers.
//
// This module is shared by the Node CLI and the browser/WKWebView UI, so it
// must stay plain ESM with no `node:` imports and no dependencies. Every
// extracted item is a verbatim span of page-marked full text with a
// hash-pinned locator. Nothing produced here is verified scientific evidence;
// it is labelled "Extracted · unreviewed" (Tier 0) by its consumers.

export const TIER0_SCHEMA = "liteverse-tier0-brief-v1";
export const TIER0_LIBRARY_SCHEMA = "liteverse-tier0-library-v1";
export const TIER0_PARTITIONS_SCHEMA = "liteverse-tier0-partitions-v1";
export const GALAXY_PACKET_SCHEMA = "liteverse-galaxy-packet-v1";
export const GALAXY_DIGEST_SCHEMA = "liteverse-galaxy-digest-v1";
/** Bump whenever extraction output changes so caches are rebuilt. */
export const TIER0_BUILDER_VERSION = 1;
export const TIER0_CLUSTER_ALGORITHM = "leiden-modularity-v1";
export const DEFAULT_SIMILARITY_WEIGHTS = Object.freeze({ coupling: 0.45, cocitation: 0.2, text: 0.35 });
export const RELATION_TYPES = Object.freeze([
  "extends",
  "uses_method_of",
  "contradicts",
  "supports",
  "reproduces",
  "same_system_different_regime",
  "compares",
]);
export const MATRIX_FIELDS = Object.freeze(["question", "system", "method", "assumption", "result", "regime"]);
export const KEY_POINT_KINDS = Object.freeze(["question", "method", "result", "limitation", "assumption"]);

const EMPTY_PAGE_TEXT = "[No extractable text on this page.]";
const MAX_KEY_POINTS = 8;
const MAX_QUANTITIES = 12;
const MAX_ABSTRACT_CHARS = 2500;
const MAX_CITATION_CONTEXTS = 400;
const MAX_REFERENCES = 1000;
const MIN_REGION_PAPERS = 4;
const MAX_REGIONS = 10;
const MAX_GALAXIES_PER_REGION = 12;

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-4), synchronous and pure JavaScript.

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const TEXT_ENCODER = new TextEncoder();
const SHA256_W = new Uint32Array(64);

/**
 * SHA-256 of raw bytes, as lowercase hex.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function sha256Bytes(bytes) {
  const length = bytes.length;
  const paddedLength = Math.ceil((length + 9) / 64) * 64;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[length] = 0x80;
  const bitLengthHigh = Math.floor(length / 0x20000000);
  const bitLengthLow = (length * 8) >>> 0;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, bitLengthHigh);
  view.setUint32(paddedLength - 4, bitLengthLow);
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = SHA256_W;
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const x = w[index - 15];
      const y = w[index - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[index] + w[index]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((word) => word.toString(16).padStart(8, "0")).join("");
}

/**
 * SHA-256 of a string's UTF-8 encoding (lone surrogates become U+FFFD, like
 * Node's Buffer.from(text, "utf8")), as lowercase hex.
 * @param {string} value
 * @returns {string}
 */
export function sha256Hex(value) {
  return sha256Bytes(TEXT_ENCODER.encode(String(value)));
}

/** Stable, key-sorted JSON used for content hashes. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function quoteId(paperId, page, start, end) {
  return `q-${sha256Hex(`${paperId}|${page}|${start}|${end}`).slice(0, 16)}`;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32).

export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Text normalization and tokenization.

const GREEK = new Map(Object.entries({
  α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "epsilon", ϵ: "epsilon", ζ: "zeta", η: "eta",
  θ: "theta", ϑ: "theta", ι: "iota", κ: "kappa", λ: "lambda", μ: "mu", ν: "nu", ξ: "xi",
  ο: "omicron", π: "pi", ϖ: "pi", ρ: "rho", ϱ: "rho", σ: "sigma", ς: "sigma", τ: "tau", υ: "upsilon",
  φ: "phi", ϕ: "phi", χ: "chi", ψ: "psi", ω: "omega",
}));
const GREEK_PATTERN = /[αβγδεϵζηθϑικλμνξοπϖρϱσςτυφϕχψω]/g;
const CJK_RUN = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/;

/**
 * Lowercase, strip diacritics, and spell out Greek letters.
 * @param {string} value
 */
export function normalizeTokenText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/µ/g, "μ")
    .replace(GREEK_PATTERN, (letter) => ` ${GREEK.get(letter)} `)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
}

/**
 * Search/similarity tokenizer: word tokens (keeps alphanumerics like "m22"),
 * plus CJK bigrams.
 * @param {string} value
 * @returns {string[]}
 */
export function tokenize(value) {
  const tokens = [];
  for (const match of normalizeTokenText(value).matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0];
    if (CJK_RUN.test(token)) {
      const characters = [...token];
      if (characters.length === 1) tokens.push(token);
      for (let index = 0; index < characters.length - 1; index += 1) tokens.push(characters[index] + characters[index + 1]);
    } else {
      tokens.push(token);
    }
  }
  return tokens;
}

const STOPWORDS = new Set(`a an the and or but if then else of in on at to for from by with without into onto over under
between among through during before after above below as is are was were be been being am do does did done have has had
having it its this that these those there here which who whom whose what when where why how than such so not no nor only
own same too very can could may might must shall should will would we our ours us you your they them their he she his her
i me my also both each either neither all any few more most other some via per et al eg ie while whereas however thus
therefore hence since because although though within upon about against along across around towards toward further
furthermore moreover respectively namely ii iii iv vs cf etc let lets one ones whether yet still even much many`.split(/\s+/));

const GENERIC_WORDS = new Set(`paper papers work works study studies result results show shows shown find finds found
present presents presented use used uses using based given case cases different new first second two three well figure
figures fig figs eq eqs equation equations section sections sect table tables obtain obtained consider considered note see
approach method methods also appendix page arxiv doi ref refs thus however value values number order effect effects way
make makes made however several various important possible large small high low higher lower total general particular
recent recently previous previously discuss discussed describe described shows provide provides provided allow allows
term terms fact form part parts set sets example examples respect addition non type types level levels suggest suggests
suggested reaching reach reaches future versus increase increases increased decrease decreases decreased dominate
dominates dominated test tests tested measured measure measures held hold indicate indicates indicated find finding
findings shown known remains remain explain explains explained leads lead yields yield introduction keywords conclusion
conclusions abstract discussion summary acknowledgments acknowledgements references`.split(/\s+/));

function isContentToken(token) {
  if (STOPWORDS.has(token)) return false;
  if (/^\d/.test(token)) return false;
  if (token.length < 2) return false;
  return true;
}

function contentTokens(value) {
  return tokenize(value).filter((token) => isContentToken(token) && !GENERIC_WORDS.has(token) && (token.length >= 3 || /\d/.test(token)));
}

function phrasesOf(text, counts, weight, occurrences = null) {
  const normalized = normalizeTokenText(text);
  const local = occurrences ? new Set() : null;
  for (const segment of normalized.split(/[^\p{L}\p{N}\s-]+/u)) {
    const words = segment.split(/[\s-]+/).filter(Boolean);
    let run = [];
    const flush = () => {
      for (let start = 0; start < run.length; start += 1) {
        for (let size = 1; size <= 3 && start + size <= run.length; size += 1) {
          const first = run[start];
          const last = run[start + size - 1];
          if (GENERIC_WORDS.has(first) || GENERIC_WORDS.has(last)) continue;
          if (size === 1 && first.length < 3 && !/\d/.test(first)) continue;
          if (size === 1 && /^[a-z]$/.test(first)) continue;
          const phrase = size === 1 ? first : run.slice(start, start + size).join(" ");
          counts.set(phrase, (counts.get(phrase) ?? 0) + weight);
          if (local && !local.has(phrase)) {
            local.add(phrase);
            occurrences.set(phrase, (occurrences.get(phrase) ?? 0) + 1);
          }
        }
      }
      run = [];
    };
    for (const word of words) {
      if (isContentToken(word) && !CJK_RUN.test(word) && word.length <= 40) run.push(word);
      else flush();
    }
    flush();
  }
}

function foldName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "");
}

const NAME_PARTICLES = new Set(["van", "von", "de", "der", "den", "del", "della", "di", "da", "la", "le", "du", "dos", "das"]);

/** Normalized surname key for an author string: "Smith, A." / "A. Smith" / "Ana van Berg". */
export function surnameKey(author) {
  const text = String(author ?? "").trim();
  if (!text) return "";
  let surname;
  if (text.includes(",")) surname = text.slice(0, text.indexOf(","));
  else {
    const parts = text.split(/\s+/).filter((part) => !/^(?:\p{Lu}\.?-?)+$/u.test(part) && !/^(?:jr|sr|ii|iii)\.?$/i.test(part));
    surname = parts.length ? parts[parts.length - 1] : text;
  }
  const tokens = surname.trim().split(/\s+/).filter((token) => !NAME_PARTICLES.has(token.toLowerCase()));
  return foldName(tokens.length ? tokens[tokens.length - 1] : surname);
}

// ---------------------------------------------------------------------------
// Pages.

/**
 * Split Liteverse page-marked full text into pages.
 * @param {string} fulltext
 */
export function splitPages(fulltext) {
  const source = String(fulltext ?? "");
  const markers = [...source.matchAll(/<!--\s*page:\s*(\d+)\s*-->/g)];
  if (!markers.length) {
    const body = source.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "");
    return [makePage(1, body)];
  }
  return markers.map((marker, index) => {
    const start = marker.index + marker[0].length;
    const end = index + 1 < markers.length ? markers[index + 1].index : source.length;
    return makePage(Number(marker[1]), source.slice(start, end));
  });
}

function makePage(page, raw) {
  let text = raw.trim();
  const empty = !text || text === EMPTY_PAGE_TEXT;
  if (empty) text = "";
  return { page, text, sha256: sha256Hex(text), empty };
}

// ---------------------------------------------------------------------------
// Document structure: headings, blocks, sentences.

const KNOWN_HEADINGS = new Set([
  "abstract", "introduction", "background", "related work", "motivation", "methods", "method", "methodology",
  "materials and methods", "model", "the model", "models", "data", "observations", "simulations", "numerical methods",
  "setup", "theory", "formalism", "framework", "results", "results and discussion", "discussion", "discussion and conclusions",
  "conclusion", "conclusions", "summary", "summary and conclusions", "summary and discussion", "summary and outlook",
  "conclusions and outlook", "concluding remarks", "outlook", "limitations", "acknowledgments", "acknowledgements",
  "acknowledgment", "acknowledgement", "references", "bibliography", "literature cited", "appendix", "appendices",
]);
const NUMBERED_HEADING = /^((?:\d{1,2}(?:\.\d{1,2}){0,3})|(?:[IVX]{1,6}))(?:\.|\))?[ \t]+(\p{Lu}[^\n]{0,88})$/u;
const INLINE_HEADING = /^((?:\d{1,2}\.?)|(?:[IVX]{1,6}\.))[ \t]+(Introduction|INTRODUCTION|Conclusions?|CONCLUSIONS?|Summary|SUMMARY|Discussion|DISCUSSION|Results|RESULTS|Methods?|METHODS?)(?=[ \t]+\p{Lu})/u;
const META_LINE = /^(?:Key ?words|KEY ?WORDS|Keywords|Subject headings|PACS(?: numbers)?|Index Terms|MSC)\b/u;
const CAPTION_START = /^(?:Fig(?:ure)?s?\.?|FIG(?:URE)?\.?)[ \t]*\d+[a-z]?[.:]/u;
const REFERENCE_HEADING = /^[ \t]*(?:(?:\d{1,2}|[IVX]{1,5})\.?[ \t]+)?(?:References|REFERENCES|Bibliography|BIBLIOGRAPHY|Literature Cited|LITERATURE CITED|References and Notes|REFERENCES AND NOTES|R ?E ?F ?E ?R ?E ?N ?C ?E ?S)[ \t]*:?[ \t]*$/gmu;
const REFERENCE_HEADING_INLINE = /^[ \t]*(?:References|REFERENCES)[ \t]+(?=\[1\]|1\.[ \t])/gmu;
const APPENDIX_HEADING = /^[ \t]*(?:Appendix|APPENDIX|Appendices|APPENDICES)\b[^\n]{0,90}$/gmu;

const UNIT_WORDS = new Set(["mpc", "kpc", "pc", "gpc", "gev", "mev", "kev", "tev", "ev", "k", "km", "cm", "gyr", "myr", "yr", "hz", "ghz", "mhz", "khz", "per", "percent", "msun", "s", "m", "kg", "g"]);

/**
 * @param {string} line
 * @param {boolean} openContext previous line is blank, a heading, the page start, or ends a sentence
 * @returns {{title: string, consumed: number, inline: boolean} | null}
 */
function headingAt(line, openContext) {
  const trimmedStart = line.length - line.trimStart().length;
  const text = line.trim();
  if (!text || text.length > 96) return null;
  const inline = text.match(INLINE_HEADING);
  if (inline) {
    return { title: text.slice(0, inline[0].length).trim(), consumed: trimmedStart + inline[0].length, inline: text.length > inline[0].length };
  }
  const lower = text.toLowerCase().replace(/[.:]$/, "").trim();
  if (KNOWN_HEADINGS.has(lower)) return { title: text.replace(/[.:]$/, ""), consumed: line.length, inline: false };
  const numbered = text.match(NUMBERED_HEADING);
  if (numbered && KNOWN_HEADINGS.has(numbered[2].trim().toLowerCase().replace(/[.:]$/, ""))) {
    return { title: text, consumed: line.length, inline: false };
  }
  if (!openContext) return null;
  if (numbered && !UNIT_WORDS.has(numbered[2].split(/\s+/)[0].toLowerCase())) {
    const title = numbered[2].trim();
    const words = title.split(/\s+/);
    const nonSpace = title.replace(/\s+/g, "");
    const letters = (title.match(/\p{L}/gu) ?? []).length;
    const number = numbered[1];
    if (
      words.length <= 12
      && !/[.,;]$/.test(title)
      && !/[,=<>]/.test(title)
      && !/\b(?:19|20)\d{2}\b/.test(title)
      && letters / Math.max(1, nonSpace.length) >= 0.7
      && !(/^\d+$/.test(number) && Number(number) > 30)
      && !/^(?:[\p{Lu}]\.\s*)+$/u.test(title)
    ) {
      return { title: text, consumed: line.length, inline: false };
    }
  }
  if (/^(?:Appendix|APPENDIX)\b/.test(text) && text.split(/\s+/).length <= 12 && !/[.,;]$/.test(text)) {
    return { title: text, consumed: line.length, inline: false };
  }
  if (/^[\p{Lu}][\p{Lu}\s&:-]{3,60}$/u.test(text)) {
    const words = text.split(/\s+/);
    if (words.length <= 6 && words.some((word) => word.length >= 4)) return { title: text, consumed: line.length, inline: false };
  }
  return null;
}

/** Map a heading title to a coarse section kind. */
export function sectionKind(title) {
  const text = String(title ?? "").toLowerCase().replace(/^[\divxl.)\s]+/, "");
  if (/abstract/.test(text)) return "abstract";
  if (/introduction|motivation|background/.test(text)) return "introduction";
  if (/reference|bibliograph|literature cited/.test(text)) return "references";
  if (/appendi/.test(text)) return "appendix";
  if (/acknowledg/.test(text)) return "acknowledgments";
  if (/conclu|summary|outlook/.test(text)) return "conclusion";
  if (/discussion/.test(text)) return "discussion";
  if (/result|finding/.test(text)) return "results";
  if (/method|model|setup|simulation|data|observation|formalism|framework|theory|experiment/.test(text)) return "methods";
  return "other";
}

const SENTENCE_CLOSERS = new Set([")", "]", "\"", "'", "”", "’", "»"]);
const ABBREVIATIONS = new Set([
  "al", "e.g", "i.e", "fig", "figs", "eq", "eqs", "eqn", "eqns", "sect", "sects", "sec", "secs", "ref", "refs", "cf", "vs",
  "no", "nos", "tab", "tabs", "approx", "resp", "viz", "ca", "dr", "prof", "mr", "mrs", "ms", "st", "vol", "vols", "pp",
  "p", "ch", "chap", "app", "appx", "def", "thm", "lem", "prop", "cor", "phys", "rev", "lett", "astrophys", "astron",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "est", "incl", "min", "max",
  "et al", "u.s", "a.k.a", "w.r.t",
]);
const SENTENCE_START = /[\p{Lu}\p{N}(["'“‘\p{Script=Greek}]/u;

/** Split a block into sentences, returning offsets relative to `text`. */
function splitSentenceSpans(text) {
  const spans = [];
  const length = text.length;
  let start = 0;
  for (let index = 0; index < length; index += 1) {
    const character = text[index];
    if (character !== "." && character !== "?" && character !== "!") continue;
    let end = index + 1;
    while (end < length && SENTENCE_CLOSERS.has(text[end])) end += 1;
    if (end < length && !/\s/.test(text[end])) continue;
    let next = end;
    while (next < length && /\s/.test(text[next])) next += 1;
    if (next >= length) break;
    if (!SENTENCE_START.test(text[next])) continue;
    if (character === ".") {
      let tokenStart = index - 1;
      while (tokenStart >= 0 && !/[\s(]/.test(text[tokenStart])) tokenStart -= 1;
      const token = text.slice(tokenStart + 1, index).toLowerCase().replace(/^["'“‘[]+/, "");
      if (ABBREVIATIONS.has(token)) continue;
      let previousEnd = tokenStart;
      while (previousEnd >= 0 && /\s/.test(text[previousEnd])) previousEnd -= 1;
      let previousStart = previousEnd;
      while (previousStart >= 0 && !/[\s(]/.test(text[previousStart])) previousStart -= 1;
      const previous = text.slice(previousStart + 1, previousEnd + 1).toLowerCase();
      // A single letter is an initial ("J. Smith") unless it is a unit after a number ("300 K.").
      if (/^\p{L}$/u.test(token) && !/^[-−]?[\d.,]+$/.test(previous)) continue;
      if (/^\d+[a-z]?$/.test(token) && ["fig", "figs", "figure", "table", "tab", "eq", "eqs", "sect", "sec", "ref", "refs"].includes(previous.replace(/\.$/, ""))) continue;
      if (/^(?:\p{L}\.)+\p{L}$/u.test(token)) continue;
    }
    spans.push([start, end]);
    start = next;
    index = next - 1;
  }
  if (start < length) spans.push([start, length]);
  const result = [];
  for (let [from, to] of spans) {
    while (from < to && /\s/.test(text[from])) from += 1;
    while (to > from && /\s/.test(text[to - 1])) to -= 1;
    if (to > from) result.push([from, to]);
  }
  return result;
}

function normalizeSentence(raw) {
  return raw
    .replace(/(\p{L})[-­][ \t]*\n[ \t]*(\p{Ll})/gu, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function lineSpans(text) {
  const spans = [];
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    spans.push({ start, end, text: text.slice(start, end) });
    if (end >= text.length) break;
    start = end + 1;
  }
  return spans;
}

function analyzeDocument(pages) {
  const separator = "\n\n";
  const bases = [];
  let cursor = 0;
  for (const page of pages) {
    bases.push(cursor);
    cursor += page.text.length + separator.length;
  }
  const doc = pages.map((page) => page.text).join(separator);
  const locate = (global) => {
    let low = 0;
    let high = bases.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (bases[middle] <= global) low = middle;
      else high = middle - 1;
    }
    return { pageIndex: low, offset: global - bases[low] };
  };

  // Reference region: last References heading (walking back over repeated
  // running headers inside the reference list).
  const referenceHeadings = [];
  for (const pattern of [REFERENCE_HEADING, REFERENCE_HEADING_INLINE]) {
    pattern.lastIndex = 0;
    for (const match of doc.matchAll(pattern)) {
      referenceHeadings.push({ start: match.index, bodyStart: match.index + match[0].length });
    }
  }
  referenceHeadings.sort((left, right) => left.start - right.start);
  let refStart = -1;
  let refBody = -1;
  if (referenceHeadings.length) {
    let chosen = referenceHeadings.length - 1;
    while (chosen > 0) {
      const previous = referenceHeadings[chosen - 1];
      const between = doc.slice(previous.bodyStart, referenceHeadings[chosen].start);
      if (/^\s*(?:\[\d+\]|\d{1,3}\.[ \t]|\p{Lu}[\p{L}'’-]+,?[ \t]+\p{Lu}\.)/u.test(between.slice(0, 300))) chosen -= 1;
      else break;
    }
    refStart = referenceHeadings[chosen].start;
    refBody = referenceHeadings[chosen].bodyStart;
  }
  let refEnd = doc.length;
  if (refStart >= 0) {
    APPENDIX_HEADING.lastIndex = refBody;
    for (const match of doc.matchAll(APPENDIX_HEADING)) {
      if (match.index >= refBody) {
        refEnd = match.index;
        break;
      }
    }
  }
  const inReferences = (global) => refStart >= 0 && global >= refStart && global < refEnd;

  // Headings and blocks per page.
  const headings = [];
  const blocks = [];
  const titleCounts = new Map();
  pages.forEach((page, pageIndex) => {
    if (page.empty) return;
    let current = null;
    let openContext = true;
    const close = () => {
      if (current) blocks.push(current);
      current = null;
    };
    for (const line of lineSpans(page.text)) {
      const trimmed = line.text.trim();
      if (!trimmed) {
        close();
        openContext = true;
        continue;
      }
      const global = bases[pageIndex] + line.start;
      const heading = inReferences(global) ? null : headingAt(line.text, openContext);
      openContext = Boolean(heading && !heading.inline) || /[.:?!)]$/.test(trimmed);
      if (heading) {
        close();
        headings.push({ title: heading.title, pageIndex, page: page.page, start: line.start, global });
        const key = heading.title.replace(/^[\divxl.)\s]+/i, "").toLowerCase();
        titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
        if (heading.inline) {
          let from = line.start + heading.consumed;
          while (from < line.end && /\s/.test(page.text[from])) from += 1;
          current = { pageIndex, start: from, end: line.end, caption: false };
        }
        continue;
      }
      const leading = line.text.length - line.text.trimStart().length;
      if (META_LINE.test(trimmed)) {
        close();
        blocks.push({ pageIndex, start: line.start + leading, end: line.end, caption: false, meta: true });
        openContext = true;
        continue;
      }
      if (CAPTION_START.test(trimmed)) {
        close();
        current = { pageIndex, start: line.start + leading, end: line.end, caption: true };
        continue;
      }
      if (current) current.end = line.end;
      else current = { pageIndex, start: line.start + leading, end: line.end, caption: false };
    }
    close();
  });
  // Drop running headers: identical non-standard headings on three or more pages.
  const filteredHeadings = headings.filter((heading) => {
    const key = heading.title.replace(/^[\divxl.)\s]+/i, "").toLowerCase();
    return KNOWN_HEADINGS.has(key) || (titleCounts.get(key) ?? 0) < 3;
  });
  if (refStart >= 0) {
    const location = locate(refStart);
    const already = filteredHeadings.some((heading) => heading.global >= refStart && heading.global < refBody);
    if (!already) {
      const line = doc.slice(refStart, refBody).trim();
      filteredHeadings.push({ title: line || "References", pageIndex: location.pageIndex, page: pages[location.pageIndex].page, start: location.offset, global: refStart });
    }
  }
  filteredHeadings.sort((left, right) => left.global - right.global);
  for (const heading of filteredHeadings) heading.kind = sectionKind(heading.title);

  // Sentences.
  const sentences = [];
  let headingCursor = -1;
  blocks.forEach((block, blockIndex) => {
    const page = pages[block.pageIndex];
    const base = bases[block.pageIndex];
    const blockText = page.text.slice(block.start, block.end);
    const spans = splitSentenceSpans(blockText);
    spans.forEach(([from, to], ordinal) => {
      const start = block.start + from;
      const end = block.start + to;
      const global = base + start;
      while (headingCursor + 1 < filteredHeadings.length && filteredHeadings[headingCursor + 1].global <= global) headingCursor += 1;
      const heading = headingCursor >= 0 ? filteredHeadings[headingCursor] : null;
      const raw = page.text.slice(start, end);
      const norm = normalizeSentence(raw);
      sentences.push({
        pageIndex: block.pageIndex,
        page: page.page,
        start,
        end,
        global,
        raw,
        norm,
        lower: norm.toLowerCase(),
        blockIndex,
        ordinal,
        caption: block.caption,
        meta: Boolean(block.meta),
        sectionKind: inReferences(global) ? "references" : heading?.kind ?? "front",
        sectionTitle: heading?.title ?? null,
        inReferences: inReferences(global),
      });
    });
  });
  return {
    doc,
    bases,
    locate,
    headings: filteredHeadings,
    blocks,
    sentences,
    references: refStart >= 0 ? { start: refStart, bodyStart: refBody, end: refEnd } : null,
  };
}

// ---------------------------------------------------------------------------
// Identifiers.

// No lookbehind: WKWebView on older macOS 13 releases lacks support.
const ARXIV_NEW = /(?:^|[^\d.])(\d{2})(\d{2})\.(\d{4,5})(v\d+)?(?![\d])/g;
const ARXIV_OLD = /\b((?:astro-ph|hep-th|hep-ph|hep-ex|hep-lat|gr-qc|nucl-th|nucl-ex|quant-ph|cond-mat|math-ph|physics|math|cs|nlin|q-bio|q-fin|stat|chao-dyn|solv-int|patt-sol|adap-org|cmp-lg|comp-gas|dg-ga|funct-an|mtrl-th|supr-con|acc-phys|ao-sci|atom-ph|bayes-an|chem-ph|plasm-ph)(?:\.[A-Za-z-]{2,})?\/\d{7})(v\d+)?\b/g;
const DOI = /\b(10\.\d{4,9}\/[^\s"<>]+)/gi;

function validArxivNew(match) {
  const month = Number(match[2]);
  if (month < 1 || month > 12) return false;
  const yymm = Number(`${match[1]}${match[2]}`);
  // 4-digit sequence numbers until 1412, 5-digit from 1501.
  return match[3].length === 4 ? yymm <= 1412 : yymm >= 1501;
}

/** Extract arXiv identifiers (base id, no version) from text. */
export function findArxivIds(text) {
  const found = [];
  const source = String(text ?? "");
  for (const match of source.matchAll(ARXIV_NEW)) {
    if (validArxivNew(match)) found.push(`${match[1]}${match[2]}.${match[3]}`);
  }
  for (const match of source.matchAll(ARXIV_OLD)) found.push(match[1]);
  return [...new Set(found)];
}

function cleanDoi(raw) {
  let doi = raw.replace(/[.,;:'"\]}>]+$/, "");
  while (doi.endsWith(")") && (doi.match(/\(/g) ?? []).length < (doi.match(/\)/g) ?? []).length) doi = doi.slice(0, -1).replace(/[.,;:]+$/, "");
  return doi.toLowerCase();
}

/** Extract DOIs (lowercased, trailing punctuation stripped) from text. */
export function findDois(text) {
  return [...new Set([...String(text ?? "").matchAll(DOI)].map((match) => cleanDoi(match[1])))];
}

function arxivBase(id) {
  return String(id ?? "").trim().replace(/^arxiv:/i, "").replace(/v\d+$/i, "").toLowerCase();
}

const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const ARXIV_STAMP = new RegExp(String.raw`arXiv:\s*(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?\s*\[([^\]\n]{1,30})\]\s*(\d{1,2})\s*(?:${MONTHS})[a-z]*\.?\s*((?:19|20)\d{2})`, "u");

function detectIdentity(pages, analysis) {
  const nonEmpty = pages.map((page, index) => ({ page, index })).filter((entry) => !entry.page.empty).slice(0, 2);
  const limit = (entry) => {
    const text = entry.page.text;
    if (!analysis.references) return text;
    const base = analysis.bases[entry.index];
    const cut = analysis.references.start - base;
    return cut <= 0 ? "" : text.slice(0, Math.min(text.length, cut));
  };
  const firstText = nonEmpty[0] ? limit(nonEmpty[0]) : "";
  const both = nonEmpty.map(limit).join("\n");
  const arxivIds = [];
  let year = null;
  const stamp = both.match(ARXIV_STAMP);
  if (stamp) {
    arxivIds.push(stamp[1].toLowerCase());
    year = Number(stamp[5]);
  }
  for (const match of firstText.matchAll(/arXiv:\s*(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/gi)) arxivIds.push(match[1].toLowerCase());
  for (const match of firstText.matchAll(ARXIV_OLD)) arxivIds.push(match[1].toLowerCase());
  const dois = findDois(both).slice(0, 3);
  if (year === null) {
    const dated = firstText.match(/(?:Received|Accepted|Published|Submitted|©|\(c\)|Copyright)[^\n]{0,60}?\b((?:19|20)\d{2})\b/i);
    if (dated) year = Number(dated[1]);
  }
  const uniqueArxiv = [...new Set(arxivIds.map(arxivBase))];
  if (year === null && uniqueArxiv.length) {
    const modern = uniqueArxiv[0].match(/^(\d{2})\d{2}\./);
    const legacy = uniqueArxiv[0].match(/\/(\d{2})\d{5}$/);
    const yy = modern?.[1] ?? legacy?.[1];
    if (yy) year = Number(yy) >= 91 ? 1900 + Number(yy) : 2000 + Number(yy);
  }
  return { arxivIds: uniqueArxiv, dois, year };
}

// ---------------------------------------------------------------------------
// References.

const AUTHOR_LINE = /^\s*(?:(?:(?:van|von|de|der|den|del|di|da|la|le|du)\s+)*\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)?),?\s+(?:\p{Lu}\.\s?-?){1,4}/u;
const YEAR_ANYWHERE = /\b(?:19|20)\d{2}[a-z]?\b/;
const JOURNAL = /((?:\p{Lu}[\p{L}&]*\.?)(?:[ \t]+(?:\p{Lu}[\p{L}&]*\.?|of|and|&))*?),?[ \t]+(\d{1,4})(?:[ \t]*\(\d{1,2}\))?[,:][ \t]*([A-Za-z]?\d{1,7})\b/gu;

function sequentialMarkers(text, pattern) {
  const accepted = [];
  let expected = 1;
  for (const match of text.matchAll(pattern)) {
    const number = Number(match[1]);
    if (number === expected) {
      const labelStart = match[0].includes("[") ? match[0].indexOf("[") : match[0].indexOf(match[1]);
      accepted.push({ index: match.index + labelStart, number, contentStart: match.index + match[0].length });
      expected += 1;
    }
  }
  return accepted;
}

function segmentReferences(text) {
  const bracket = sequentialMarkers(text, /(?:^|\s)\[(\d{1,4})\]\s/g);
  if (bracket.length >= 2) {
    return {
      style: "numeric",
      entries: bracket.map((marker, index) => ({
        label: String(marker.number),
        number: marker.number,
        raw: text.slice(marker.contentStart, index + 1 < bracket.length ? bracket[index + 1].index : text.length),
      })),
    };
  }
  const dotted = sequentialMarkers(text, /(?:^|\n)[ \t]*(\d{1,4})\.[ \t]+(?=\S)/g);
  if (dotted.length >= 2) {
    return {
      style: "numeric",
      entries: dotted.map((marker, index) => ({
        label: String(marker.number),
        number: marker.number,
        raw: text.slice(marker.contentStart, index + 1 < dotted.length ? dotted[index + 1].index : text.length),
      })),
    };
  }
  const entries = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (AUTHOR_LINE.test(line) && (!current || YEAR_ANYWHERE.test(current))) {
      if (current) entries.push(current);
      current = line;
    } else if (current) {
      current += `\n${line}`;
    } else {
      current = line;
    }
  }
  if (current) entries.push(current);
  if (entries.length >= 2) return { style: "author-year", entries: entries.map((raw) => ({ label: null, number: null, raw })) };
  const blocks = text.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const fallback = blocks.length >= 2 ? blocks : text.split("\n").map((line) => line.trim()).filter(Boolean);
  return { style: "unknown", entries: fallback.map((raw) => ({ label: null, number: null, raw })) };
}

function firstAuthorOf(text) {
  const stripped = text.replace(/^\s*(?:\[\d+\]|\d+\.)\s*/, "");
  const particles = String.raw`(?:(?:van|von|de|der|den|del|della|di|da|la|le|du)\s+)*`;
  const surnameFirst = stripped.match(new RegExp(String.raw`^(${particles}\p{Lu}[\p{L}'’-]+)(?:,\s*|\s+)(?:\p{Lu}\.)`, "u"));
  if (surnameFirst) return surnameFirst[1];
  const initialsFirst = stripped.match(new RegExp(String.raw`^((?:\p{Lu}\.\s?-?\s?)+)\s*(${particles}\p{Lu}[\p{L}'’-]+)`, "u"));
  if (initialsFirst) return initialsFirst[2];
  const plain = stripped.match(/^(\p{Lu}[\p{L}'’-]+)/u);
  return plain ? plain[1] : null;
}

/**
 * Parse one reference entry's identifiers and bibliographic key fields.
 * @param {string} raw
 */
export function parseReferenceEntry(raw) {
  const text = String(raw ?? "")
    .replace(/(\p{L})-[ \t]*\n[ \t]*(\p{Ll})/gu, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  const arxivIds = findArxivIds(text);
  const dois = findDois(text);
  let rest = text.replace(DOI, " ").replace(/arXiv:\s*\S+/gi, " ").replace(ARXIV_OLD, " ");
  rest = rest.replace(/(^|[^\d.])\d{4}\.\d{4,5}(?:v\d+)?/g, "$1 ");
  const parenthesized = rest.match(/\(((?:19|20)\d{2})([a-z]?)\)/);
  const bareMatch = rest.match(/(?:^|[^\d./])((?:19|20)\d{2})([a-z]?)(?![\d\p{L}])/u);
  const bare = bareMatch ? [bareMatch[0], bareMatch[1], bareMatch[2]] : null;
  const yearMatch = parenthesized ?? bare;
  let journal = null;
  JOURNAL.lastIndex = 0;
  for (const match of rest.matchAll(JOURNAL)) {
    const name = match[1].trim();
    const tokens = name.split(/\s+/);
    if (!tokens.some((token) => token.replace(/[^\p{L}]/gu, "").length >= 2)) continue;
    if (/^arxiv$/i.test(name)) continue;
    if (tokens.length === 1 && /^\p{Lu}\p{Ll}+$/u.test(name) && !/^(?:Nature|Science|Icarus|Physics|Chaos|Nonlinearity|Neuron|Cell|Genetics)$/.test(name)) {
      // A single capitalized word followed by numbers is usually a surname in a
      // title-less reference, not a journal. Keep only well-known single-word titles.
      continue;
    }
    const volume = match[2];
    if (/^(?:19|20)\d{2}$/.test(volume)) continue;
    journal = { name: name.replace(/,$/, ""), volume, page: match[3] };
    break;
  }
  const author = firstAuthorOf(text);
  return {
    text: text.length > 500 ? `${text.slice(0, 499)}…` : text,
    arxivId: arxivIds[0] ?? null,
    doi: dois[0] ?? null,
    year: yearMatch ? Number(yearMatch[1]) : null,
    yearSuffix: yearMatch?.[2] || null,
    firstAuthor: author,
    journal,
  };
}

function journalKey(journal) {
  if (!journal) return null;
  const name = foldName(journal.name.replace(/&/g, "and"));
  return name ? `${name}|${journal.volume}|${String(journal.page).toLowerCase()}` : null;
}

function parseReferences(analysis) {
  if (!analysis.references) return { style: "none", entries: [] };
  const text = analysis.doc.slice(analysis.references.bodyStart, analysis.references.end);
  const segmented = segmentReferences(text);
  const entries = segmented.entries.slice(0, MAX_REFERENCES).map((entry, ordinal) => {
    const parsed = parseReferenceEntry(entry.raw);
    const index = segmented.style === "numeric" ? entry.number : ordinal + 1;
    const label = segmented.style === "numeric"
      ? entry.label
      : parsed.firstAuthor && parsed.year ? `${parsed.firstAuthor} ${parsed.year}${parsed.yearSuffix ?? ""}` : String(ordinal + 1);
    return { index, label, ...parsed };
  }).filter((entry) => entry.text.length >= 8);
  return { style: segmented.style, entries };
}

// ---------------------------------------------------------------------------
// In-text citation markers.

const NUMERIC_CITATION = /\[(\d{1,4}(?:\s*[-–,]\s*\d{1,4})*)\]/g;
const AUTHOR_YEAR_CITATION = /(\p{Lu}[\p{L}'’-]+)(?:\s+et\s+al\.?|\s+(?:and|&)\s+\p{Lu}[\p{L}'’-]+)?,?\s*\(?((?:19|20)\d{2})([a-z])?(?:,\s*([a-z])\b)?\)?/gu;
const GENERIC_CITATION_HINT = /et al\.?,?\s*\(?(?:19|20)\d{2}|\(\p{Lu}[\p{L}'’-]+(?:\s+et al\.)?,?\s+(?:19|20)\d{2}/u;

function expandNumericMarker(content) {
  const numbers = [];
  for (const part of content.split(",")) {
    const range = part.match(/^\s*(\d+)\s*[-–]\s*(\d+)\s*$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to >= from && to - from <= 50) for (let value = from; value <= to; value += 1) numbers.push(value);
    } else if (/^\s*\d+\s*$/.test(part)) {
      numbers.push(Number(part));
    }
  }
  return numbers;
}

function citationResolver(references) {
  const byNumber = new Map();
  const byAuthorYear = new Map();
  const byAuthorYearNumber = new Map();
  for (const entry of references.entries) {
    if (references.style === "numeric") byNumber.set(entry.index, entry.index);
    const surname = entry.firstAuthor ? surnameKey(entry.firstAuthor) : "";
    if (!surname || !entry.year) continue;
    const exact = `${surname}|${entry.year}${entry.yearSuffix ?? ""}`;
    byAuthorYear.set(exact, [...(byAuthorYear.get(exact) ?? []), entry.index]);
    const loose = `${surname}|${entry.year}`;
    byAuthorYearNumber.set(loose, [...(byAuthorYearNumber.get(loose) ?? []), entry.index]);
  }
  return (sentence) => {
    const found = new Set();
    if (references.style === "numeric") {
      NUMERIC_CITATION.lastIndex = 0;
      for (const match of sentence.matchAll(NUMERIC_CITATION)) {
        for (const number of expandNumericMarker(match[1])) if (byNumber.has(number)) found.add(number);
      }
    } else if (byAuthorYear.size) {
      AUTHOR_YEAR_CITATION.lastIndex = 0;
      for (const match of sentence.matchAll(AUTHOR_YEAR_CITATION)) {
        const surname = surnameKey(match[1]);
        const suffixes = [match[3], match[4]].filter(Boolean);
        const loose = byAuthorYearNumber.get(`${surname}|${match[2]}`) ?? [];
        if (!suffixes.length) {
          if (loose.length === 1) found.add(loose[0]);
          continue;
        }
        for (const suffix of suffixes) {
          const exact = byAuthorYear.get(`${surname}|${match[2]}${suffix}`) ?? [];
          if (exact.length === 1) found.add(exact[0]);
          else if (!exact.length && loose.length === 1) found.add(loose[0]);
        }
      }
    }
    return [...found].sort((left, right) => left - right);
  };
}

// ---------------------------------------------------------------------------
// Abstract.

function boundAbstract(text, start, end) {
  let to = end;
  if (to - start > MAX_ABSTRACT_CHARS) {
    const window = text.slice(start, start + MAX_ABSTRACT_CHARS);
    const lastStop = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n"));
    to = lastStop > MAX_ABSTRACT_CHARS * 0.5 ? start + lastStop + 1 : start + (window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") : MAX_ABSTRACT_CHARS);
  }
  let from = start;
  while (from < to && /\s/.test(text[from])) from += 1;
  while (to > from && /\s/.test(text[to - 1])) to -= 1;
  return [from, to];
}

function detectAbstract(pages, analysis) {
  const candidates = pages.map((page, index) => ({ page, index })).filter((entry) => !entry.page.empty).slice(0, 2);
  for (const { page, index } of candidates) {
    const text = page.text;
    const marker = text.match(/(?:^|\n)[ \t]*(?:Abstract|ABSTRACT|A B S T R A C T)\b[ \t]*[.:—–-]?[ \t]*\n?/);
    if (!marker) continue;
    const start = marker.index + marker[0].length;
    const rest = text.slice(start);
    const stops = [
      /\n[ \t]*(?:Key ?words|KEY ?WORDS|Keywords|Subject headings|PACS|Index Terms)\b/,
      /\n[ \t]*(?:1\.?|I\.)[ \t]+(?:Introduction|INTRODUCTION)\b/,
      /\n[ \t]*(?:Introduction|INTRODUCTION)[ \t]*\n/,
      /\n[ \t]*(?:1\.?|I\.)[ \t]+\p{Lu}[^\n]{0,60}\n/u,
    ];
    let end = text.length;
    for (const stop of stops) {
      const found = rest.match(stop);
      if (found && start + found.index < end) end = start + found.index;
    }
    const [from, to] = boundAbstract(text, start, end);
    if (to - from >= 40) return { pageIndex: index, start: from, end: to };
  }
  const first = candidates[0];
  if (!first) return null;
  const blocks = analysis.blocks.filter((block) => block.pageIndex === first.index && !block.caption);
  const text = first.page.text;
  const wordCount = (value) => value.split(/\s+/).filter(Boolean).length;
  for (const minimum of [40, 25]) {
    for (const block of blocks) {
      let from = block.start;
      // Skip short leading lines (title, authors, affiliations) in blocks that
      // lack blank-line paragraph breaks.
      for (const line of lineSpans(text.slice(block.start, block.end))) {
        if (wordCount(line.text) >= 8) {
          from = block.start + line.start;
          break;
        }
      }
      const body = text.slice(from, block.end);
      if (wordCount(body) < minimum) continue;
      const letters = body.match(/\p{Ll}/gu)?.length ?? 0;
      if (letters / Math.max(1, body.length) < 0.5) continue;
      const [start, end] = boundAbstract(text, from, block.end);
      return { pageIndex: first.index, start, end };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cue lists (extending macos/LiteverseLocalWorker.swift routing signals).

const CUES = {
  question: [
    "aim of this", "central question", "goal of this", "motivated by", "open question", "purpose of this", "we ask",
    "we examine", "we explore", "we investigate", "we study", "whether", "we address", "it remains unclear",
    "remains an open", "the question of", "in order to understand", "we aim", "here we investigate", "is poorly understood",
    "little is known", "we seek",
  ],
  method: [
    "algorithm", "dataset", "experiment", "method", "model", "numerical", "simulation", "we compute", "we employ",
    "we measure", "we solve", "we use", "we develop", "we perform", "we implement", "we apply", "we fit", "we simulate",
    "we run", "we construct", "we introduce", "we model", "we analyse", "we analyze", "technique", "framework", "pipeline",
    "a sample of", "we combine", "we calibrate", "we train",
  ],
  result: [
    "consistent with", "demonstrate", "decreases", "indicate", "increases", "our results", "we find", "we observe",
    "we show", "we detect", "we obtain", "we report", "results show", "is found", "are found", "we conclude", "reveal",
    "suggest", "leads to", "results in", "significantly", "improves", "reduces", "agree with", "in agreement", "constrain",
    "we confirm", "we recover", "outperforms", "yields", "we identify", "we establish", "is ruled out", "excluded at",
  ],
  limitation: [
    "approximation", "cannot", "caveat", "does not", "future work", "however", "limitation", "restricted", "uncertain",
    "limited", "beyond the scope", "not captured", "neglected", "remains uncertain", "we caution", "systematic",
    "cannot rule out", "requires further", "should be tested", "unclear", "not account", "only valid", "neglects",
    "may limit", "limits the", "is limited", "does not capture", "not include", "ignores", "breaks down", "valid only",
  ],
  assumption: [
    "assuming", "for simplicity", "is assumed", "under the assumption", "we adopt", "we assume", "we consider only",
    "we neglect", "we restrict", "we ignore", "we take", "throughout this", "unless otherwise", "we fix",
  ],
};
const CONTRIBUTION_CUES = [
  "we show", "we find", "we demonstrate", "we present", "in this paper", "in this work", "in this letter",
  "in this article", "in this study", "our results", "for the first time", "we propose", "we derive", "here we",
  "we report", "our main", "we introduce", "our analysis",
];
const SECTION_PRIOR = { abstract: 2, conclusion: 1.5, results: 1, discussion: 1, introduction: 0.8, caption: 0.5, methods: 0.3, front: 0.2, other: 0 };
const NEGATION = /\b(?:not|no|cannot|never|neither|nor|without|fails? to|failed to|none)\b/;
const HEDGE = /\b(?:may|might|could|possibly|likely|suggests?|tentative|appears? to)\b/;
const FIRST_PERSON = /\b(?:we|our|us)\b/;
const KIND_PRIORITY = ["result", "limitation", "question", "method", "assumption"];

const WEAK_CUES = new Set(["algorithm", "dataset", "experiment", "method", "model", "numerical", "simulation", "technique", "framework", "pipeline", "however", "systematic", "suggest", "significantly", "whether"]);
const cueRegexCache = new Map();
function cueHits(lower, cues) {
  let hits = 0;
  for (const cue of cues) {
    let regex = cueRegexCache.get(cue);
    if (!regex) {
      regex = new RegExp(`\\b${cue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
      cueRegexCache.set(cue, regex);
    }
    if (regex.test(lower)) hits += cue.includes(" ") ? 1.5 : WEAK_CUES.has(cue) ? 0.5 : 1;
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Quantities.

const NUMBER = String.raw`(?:[-−–]?\d+(?:[.,]\d+)?(?:\s*(?:×|x|\\times|\*)\s*10\s*(?:\^|\*\*)?\s*\{?\s*[-−–]?\s*\d+\s*\}?)?|10\s*(?:\^|\*\*)\s*\{?\s*[-−–]?\s*\d+\s*\}?|10−\d{1,3})`;
const UNITS = [
  "per cent", "percent", "km\\s*s\\s*[−-]\\s*1", "km\\s*s\\^\\s*\\{?-1\\}?", "km/s", "h\\s*[−-]\\s*1\\s*Mpc",
  "keV", "MeV", "GeV", "TeV", "PeV", "meV", "μeV", "µeV", "neV", "eV",
  "Gpc", "Mpc", "kpc", "pc", "AU", "au", "ly",
  "Gyr", "Myr", "kyr", "yr", "M⊙", "M☉", "M_⊙", "M_\\{?sun\\}?", "Msun", "M_sol", "L⊙", "L☉", "Lsun", "R⊙", "R☉",
  "μK", "µK", "mK", "nK", "K",
  "THz", "GHz", "MHz", "kHz", "Hz",
  "erg", "kJ", "MJ", "J", "mW", "kW", "MW", "GW", "W",
  "μs", "µs", "ms", "ns", "ps", "fs", "min", "s",
  "μm", "µm", "mm", "nm", "cm\\s*[−-]\\s*[23]", "cm", "km", "m",
  "mg", "kg", "g",
  "%", "°", "deg", "arcsec", "arcmin", "mas", "sr", "mJy", "μJy", "µJy", "Jy", "dex", "mag",
  "mbar", "bar", "kPa", "MPa", "GPa", "Pa", "mV", "kV", "V", "mT", "μT", "µT", "nT", "T", "Gauss", "mol", "σ",
];
const RELATION = String.raw`(?:~|≈|∼|≃|≲|≳|<|>|≤|≥|\\sim|\\approx|of order|approximately|about|around|roughly)`;
const QUANTITY_PATTERN = new RegExp(
  String.raw`(?:(${RELATION})\s*)?(${NUMBER})(?:\s*(?:-|–|to|and)\s*(${NUMBER}))?(?:\s*(?:±|\+/-|\\pm)\s*(${NUMBER}))?\s*((?:${UNITS.join("|")})(?:\s?\^?\{?[−-][1-4]\}?)?)(?![\p{L}\p{N}])`,
  "gu",
);
const RELATION_ONLY = /([\p{L}_][\p{L}\p{N}_^{}]*)\s*(≈|∼|≃|~|∝)\s*([-−]?\d+(?:\.\d+)?(?:\s*(?:×|x)\s*10\s*\^?\s*[-−]?\d+)?|[\p{L}_][\p{L}\p{N}_^{}\-−+/]*)/gu;

function parseNumber(text) {
  const cleaned = String(text).replace(/[−–]/g, "-").replace(/\s+/g, "").replace(/\\times|×|\*/g, "x");
  const powerOnly = cleaned.match(/^10(?:\^|\*\*)?\{?(-?\d+)\}?$/);
  if (powerOnly && /[\^*{]|^10-/.test(cleaned)) return 10 ** Number(powerOnly[1]);
  const scientific = cleaned.match(/^(-?\d+(?:[.,]\d+)?)x10(?:\^|\*\*)?\{?(-?\d+)\}?$/);
  const mantissaText = scientific ? scientific[1] : cleaned;
  let mantissa;
  if (/^-?\d{1,3}(?:,\d{3})+$/.test(mantissaText)) mantissa = Number(mantissaText.replace(/,/g, ""));
  else mantissa = Number(mantissaText.replace(",", "."));
  if (!Number.isFinite(mantissa)) return null;
  const value = scientific ? mantissa * 10 ** Number(scientific[2]) : mantissa;
  return Number.isFinite(value) ? Number(value.toPrecision(12)) : null;
}

function normalizeUnit(unit) {
  const compact = unit.replace(/\s+/g, "").replace(/−/g, "-").replace(/µ/g, "μ");
  if (/^(?:percent|%)$/i.test(compact)) return "%";
  if (/^km(?:s-1|s\^\{?-1\}?|\/s)$/.test(compact)) return "km/s";
  if (/^(?:M⊙|M☉|M_⊙|M_\{?sun\}?|Msun|M_sol)$/.test(compact)) return "M_sun";
  if (/^(?:L⊙|L☉|Lsun)$/.test(compact)) return "L_sun";
  if (/^(?:R⊙|R☉)$/.test(compact)) return "R_sun";
  const power = compact.match(/^(.+?)\^?\{?-([1-4])\}?$/);
  if (power && !/^\d/.test(power[1])) return `${power[1]}^-${power[2]}`;
  return compact;
}

function sentenceFragment(sentence, matchStart, matchEnd) {
  const length = sentence.end - sentence.start;
  if (length <= 240) return [sentence.start, sentence.end];
  let from = Math.max(0, matchStart - 100);
  let to = Math.min(length, matchEnd + 100);
  const raw = sentence.raw;
  while (from > 0 && !/\s/.test(raw[from - 1])) from -= 1;
  while (to < length && !/\s/.test(raw[to])) to += 1;
  while (from < to && /\s/.test(raw[from])) from += 1;
  while (to > from && /\s/.test(raw[to - 1])) to -= 1;
  return [sentence.start + from, sentence.start + to];
}

function extractQuantities(paperId, sentences, keyPointSpans, pages) {
  const found = [];
  for (const sentence of sentences) {
    if (sentence.inReferences || sentence.raw.length > 2000) continue;
    const raw = sentence.raw;
    const covered = [];
    QUANTITY_PATTERN.lastIndex = 0;
    for (const match of raw.matchAll(QUANTITY_PATTERN)) {
      covered.push([match.index, match.index + match[0].length]);
      const numberText = match[2];
      const unit = match[5];
      // Skip bare four-digit years with ambiguous single-letter units.
      if (/^(?:19|20)\d{2}$/.test(numberText) && /^[smgKTV]$/.test(unit)) continue;
      const value = parseNumber(numberText);
      if (value === null) continue;
      const [start, end] = sentenceFragment(sentence, match.index, match.index + match[0].length);
      found.push({ sentence, start, end, value, unit: normalizeUnit(unit), relation: match[1] ?? null, upper: match[3] ? parseNumber(match[3]) : null, uncertainty: match[4] ? parseNumber(match[4]) : null, at: match.index });
    }
    RELATION_ONLY.lastIndex = 0;
    for (const match of raw.matchAll(RELATION_ONLY)) {
      if (match[2] !== "∝" && !/\d/.test(match[3])) continue;
      if (/^(?:et|al|and|of|the|in|at|to|by|is|be|was|are|with|about)$/i.test(match[1])) continue;
      const matchEnd = match.index + match[0].length;
      if (covered.some(([from, to]) => match.index < to && matchEnd > from)) continue;
      const [start, end] = sentenceFragment(sentence, match.index, match.index + match[0].length);
      found.push({ sentence, start, end, value: match[2] === "∝" ? null : parseNumber(match[3]), unit: null, relation: match[2], upper: null, uncertainty: null, at: match.index });
    }
  }
  const scored = found.map((item) => {
    const kind = item.sentence.caption ? "caption" : item.sentence.sectionKind;
    let score = { abstract: 3, conclusion: 2, results: 1.5, discussion: 1.2, caption: 0.5 }[kind] ?? 0.2;
    if (keyPointSpans.has(`${item.sentence.pageIndex}|${item.sentence.start}`)) score += 2;
    if (item.relation) score += 0.3;
    return { ...item, score };
  });
  scored.sort((left, right) => right.score - left.score || left.sentence.global - right.sentence.global || left.at - right.at);
  const seen = new Set();
  const selected = [];
  for (const item of scored) {
    const key = `${item.value}|${item.unit}|${item.relation === "∝" ? item.sentence.global : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(item);
    if (selected.length >= MAX_QUANTITIES) break;
  }
  selected.sort((left, right) => left.sentence.global - right.sentence.global || left.at - right.at);
  return selected.map((item) => {
    const page = pages[item.sentence.pageIndex];
    const quantity = {
      id: quoteId(paperId, page.page, item.start, item.end),
      text: page.text.slice(item.start, item.end),
      value: item.value,
      unit: item.unit,
      page: page.page,
      start: item.start,
      end: item.end,
      pageSha256: page.sha256,
    };
    if (item.relation) quantity.relation = item.relation;
    if (item.upper !== null) quantity.upper = item.upper;
    if (item.uncertainty !== null) quantity.uncertainty = item.uncertainty;
    return quantity;
  });
}

// ---------------------------------------------------------------------------
// Key points.

function tokenSet(text) {
  return new Set(contentTokens(text));
}

function setCosine(left, right) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const token of small) if (large.has(token)) overlap += 1;
  return overlap / Math.sqrt(left.size * right.size);
}

function candidateSentences(analysis, abstractSpan) {
  const { sentences } = analysis;
  const pool = new Map();
  const add = (sentence, origin) => {
    const key = `${sentence.pageIndex}|${sentence.start}`;
    if (!pool.has(key)) pool.set(key, { sentence, origin });
  };
  for (const sentence of sentences) {
    if (abstractSpan && sentence.pageIndex === abstractSpan.pageIndex && sentence.start >= abstractSpan.start && sentence.end <= abstractSpan.end + 1) {
      sentence.sectionKind = "abstract";
      add(sentence, "abstract");
    }
  }
  const intro = sentences.filter((sentence) => sentence.sectionKind === "introduction" && !sentence.caption);
  const introBlocks = [...new Set(intro.map((sentence) => sentence.blockIndex))];
  const introTail = introBlocks.length >= 3
    ? intro.filter((sentence) => introBlocks.slice(-2).includes(sentence.blockIndex))
    : intro.slice(-6);
  for (const sentence of introTail) add(sentence, "introduction");
  const perKind = new Map();
  for (const sentence of sentences) {
    if (sentence.caption || !["conclusion", "discussion", "results"].includes(sentence.sectionKind)) continue;
    const count = perKind.get(sentence.sectionKind) ?? 0;
    if (count >= 80) continue;
    perKind.set(sentence.sectionKind, count + 1);
    add(sentence, sentence.sectionKind);
  }
  const captionCount = new Map();
  for (const sentence of sentences) {
    if (!sentence.caption || sentence.inReferences) continue;
    const count = captionCount.get(sentence.blockIndex) ?? 0;
    if (count >= 2) continue;
    captionCount.set(sentence.blockIndex, count + 1);
    add(sentence, "caption");
  }
  if (pool.size < 3) {
    const body = sentences.filter((sentence) => !sentence.inReferences);
    const pageIndexes = [...new Set(body.map((sentence) => sentence.pageIndex))];
    const chosen = new Set([...pageIndexes.slice(0, 2), ...pageIndexes.slice(-2)]);
    for (const sentence of body) if (chosen.has(sentence.pageIndex)) add(sentence, sentence.sectionKind);
  }
  return [...pool.values()];
}

function scoreCandidate({ sentence, origin }, context) {
  const { norm, lower } = sentence;
  if (sentence.meta) return null;
  const words = norm.split(/\s+/).length;
  if (words < 6 || words > 90 || norm.length > 700) return null;
  const letters = (norm.match(/\p{L}/gu) ?? []).length;
  if (letters / norm.length < 0.55) return null;
  const signals = [];
  const kindScores = {};
  let cueTotal = 0;
  for (const kind of KEY_POINT_KINDS) {
    kindScores[kind] = cueHits(lower, CUES[kind]);
    cueTotal += kindScores[kind];
  }
  let kind = null;
  let best = 0;
  for (const candidate of KIND_PRIORITY) {
    if (kindScores[candidate] > best) {
      best = kindScores[candidate];
      kind = candidate;
    }
  }
  if (!kind) {
    if (origin === "abstract") kind = context.firstAbstract === sentence ? "question" : "result";
    else if (origin === "caption") kind = "result";
    else if (origin === "introduction") kind = "question";
    else if (sentence.sectionKind === "methods") kind = "method";
    else kind = "result";
  }
  const contribution = cueHits(lower, CONTRIBUTION_CUES);
  const priorKey = origin === "caption" ? "caption" : origin;
  let score = 1 + Math.min(3, cueTotal) * 0.6 + (SECTION_PRIOR[priorKey] ?? 0);
  signals.push(`section:${priorKey}`);
  if (contribution > 0) {
    score += 1.5 + Math.min(1, (contribution - 1) * 0.25);
    signals.push("contribution");
  }
  if (FIRST_PERSON.test(lower)) {
    score += 0.5;
    signals.push("first_person");
  }
  QUANTITY_PATTERN.lastIndex = 0;
  if (QUANTITY_PATTERN.test(sentence.raw)) {
    score += 0.7;
    signals.push("quantity");
  }
  QUANTITY_PATTERN.lastIndex = 0;
  if (context.citationSentences.has(`${sentence.pageIndex}|${sentence.start}`) || GENERIC_CITATION_HINT.test(norm) || /\[\d{1,3}(?:\s*[-–,]\s*\d{1,3})*\]/.test(norm)) {
    score -= 2;
    signals.push("citation_marker");
  }
  if (NEGATION.test(lower)) signals.push("negation");
  if (cueHits(lower, CUES.assumption) > 0) signals.push("assumption");
  if (HEDGE.test(lower)) signals.push("hedge");
  if (words < 10) score -= 1;
  if (words > 55) score -= 1;
  if (/^\p{Ll}/u.test(norm)) score -= 0.5;
  if (context.firstAbstract === sentence) score += 0.3;
  return { sentence, kind, score, signals, tokens: tokenSet(norm) };
}

function selectKeyPoints(scored) {
  const candidates = scored.filter(Boolean).sort((left, right) => right.score - left.score || left.sentence.global - right.sentence.global);
  if (!candidates.length) return [];
  const maxScore = Math.max(...candidates.map((item) => item.score), 1e-9);
  const lambda = 0.7;
  const selected = [];
  const kindCount = new Map();
  const remaining = [...candidates];
  const hasResult = candidates.some((item) => item.kind === "result" && item.score > 0);
  while (selected.length < MAX_KEY_POINTS && remaining.length) {
    let bestIndex = -1;
    let bestValue = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const item = remaining[index];
      if (!selected.length && hasResult && item.kind !== "result") continue;
      if ((kindCount.get(item.kind) ?? 0) >= 3) continue;
      if (item.score <= 0 && selected.length >= 3) continue;
      let maxSimilarity = 0;
      for (const chosen of selected) maxSimilarity = Math.max(maxSimilarity, setCosine(item.tokens, chosen.tokens));
      if (maxSimilarity >= 0.8) continue;
      const diversityBonus = selected.length && !kindCount.has(item.kind) ? 0.08 : 0;
      const value = lambda * (item.score / maxScore) - (1 - lambda) * maxSimilarity + diversityBonus;
      if (value > bestValue + 1e-12) {
        bestValue = value;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    const [chosen] = remaining.splice(bestIndex, 1);
    selected.push(chosen);
    kindCount.set(chosen.kind, (kindCount.get(chosen.kind) ?? 0) + 1);
  }
  return selected.sort((left, right) => left.sentence.global - right.sentence.global);
}

// ---------------------------------------------------------------------------
// Keyphrases.

function paperKeyphrases({ title, abstractText, keyPointTexts, sectionTitles, sentences }) {
  const counts = new Map();
  const occurrences = new Map();
  phrasesOf(title ?? "", counts, 3, occurrences);
  for (const sentence of sentences) {
    if (sentence.sectionKind === "abstract") phrasesOf(sentence.norm, counts, 2, occurrences);
  }
  if (!sentences.some((sentence) => sentence.sectionKind === "abstract")) phrasesOf(abstractText ?? "", counts, 2, occurrences);
  for (const text of keyPointTexts) phrasesOf(text, counts, 1);
  for (const text of sectionTitles) phrasesOf(text, counts, 2, occurrences);
  let budget = 120_000;
  for (const sentence of sentences) {
    if (sentence.inReferences || sentence.meta || ["abstract", "front"].includes(sentence.sectionKind) || sentence.caption) continue;
    budget -= sentence.norm.length;
    if (budget < 0) break;
    phrasesOf(sentence.norm, counts, 1, occurrences);
  }
  const titleCounts = new Map();
  phrasesOf(title ?? "", titleCounts, 1);
  const titlePhrases = new Set(titleCounts.keys());
  const ranked = [];
  for (const [phrase, count] of counts) {
    const size = phrase.split(" ").length;
    if (size > 1 && (occurrences.get(phrase) ?? 0) < 2 && !titlePhrases.has(phrase)) continue;
    ranked.push({ phrase, count, weight: count * (1 + 0.5 * (size - 1)) });
  }
  ranked.sort((left, right) => right.weight - left.weight || compareStrings(left.phrase, right.phrase));
  const chosen = [];
  for (const item of ranked) {
    if (chosen.length >= 30) break;
    const subsumed = chosen.some((other) => other.phrase.length > item.phrase.length
      && ` ${other.phrase} `.includes(` ${item.phrase} `)
      && other.count >= item.count * 0.7);
    if (subsumed) continue;
    chosen.push(item);
  }
  const maxWeight = chosen[0]?.weight ?? 1;
  return chosen.map((item) => ({ phrase: item.phrase, weight: round(item.weight / maxWeight), count: round(item.count, 2) }));
}

// ---------------------------------------------------------------------------
// Paper brief.

/**
 * Build a deterministic Tier-0 brief for one paper.
 * @param {{paperId: string, title?: string, authors?: string[]|string, year?: number|null, arxivId?: string|null, doi?: string|null, fulltext: string, journal?: {name: string, volume: string, page: string}|null}} input
 */
export function buildPaperBrief(input) {
  const { paperId, fulltext } = input ?? {};
  if (typeof paperId !== "string" || !paperId) throw new Error("buildPaperBrief requires a paperId");
  if (typeof fulltext !== "string") throw new Error(`buildPaperBrief requires fulltext for ${paperId}`);
  const pages = splitPages(fulltext);
  const analysis = analyzeDocument(pages);
  const references = parseReferences(analysis);
  const resolve = citationResolver(references);
  const identity = detectIdentity(pages, analysis);

  const citationContexts = [];
  const citationSentences = new Set();
  for (const sentence of analysis.sentences) {
    if (sentence.inReferences || !references.entries.length) continue;
    const refs = resolve(sentence.raw);
    if (!refs.length) continue;
    citationSentences.add(`${sentence.pageIndex}|${sentence.start}`);
    for (const refIndex of refs) {
      if (citationContexts.length >= MAX_CITATION_CONTEXTS) break;
      citationContexts.push({ refIndex, text: sentence.raw, page: sentence.page, start: sentence.start, end: sentence.end });
    }
  }

  const abstractSpan = detectAbstract(pages, analysis);
  const abstract = abstractSpan ? (() => {
    const page = pages[abstractSpan.pageIndex];
    return {
      id: quoteId(paperId, page.page, abstractSpan.start, abstractSpan.end),
      text: page.text.slice(abstractSpan.start, abstractSpan.end),
      page: page.page,
      start: abstractSpan.start,
      end: abstractSpan.end,
      pageSha256: page.sha256,
    };
  })() : null;

  const candidates = candidateSentences(analysis, abstractSpan);
  const firstAbstract = candidates.find((candidate) => candidate.origin === "abstract")?.sentence ?? null;
  const scored = candidates.map((candidate) => scoreCandidate(candidate, { citationSentences, firstAbstract }));
  const keyPoints = selectKeyPoints(scored).map((item) => {
    const page = pages[item.sentence.pageIndex];
    return {
      id: quoteId(paperId, page.page, item.sentence.start, item.sentence.end),
      kind: item.kind,
      text: page.text.slice(item.sentence.start, item.sentence.end),
      page: page.page,
      start: item.sentence.start,
      end: item.sentence.end,
      pageSha256: page.sha256,
      score: round(item.score, 3),
      signals: item.signals,
    };
  });
  const keyPointSpans = new Set(keyPoints.map((point) => {
    const pageIndex = pages.findIndex((page) => page.page === point.page);
    return `${pageIndex}|${point.start}`;
  }));
  const quantities = extractQuantities(paperId, analysis.sentences, keyPointSpans, pages);

  const sections = [];
  for (const heading of analysis.headings) {
    const previous = sections[sections.length - 1];
    if (previous && previous.title === heading.title) continue;
    sections.push({ title: heading.title, page: heading.page });
    if (sections.length >= 80) break;
  }

  const keyphrases = paperKeyphrases({
    title: input.title ?? "",
    abstractText: abstract?.text ?? "",
    keyPointTexts: keyPoints.map((point) => point.text),
    sectionTitles: sections.filter((section) => sectionKind(section.title) === "other" || sectionKind(section.title) === "methods").map((section) => section.title),
    sentences: analysis.sentences,
  });

  const emptyPages = pages.filter((page) => page.empty).map((page) => page.page);
  const meaningful = pages.reduce((sum, page) => sum + page.text.replace(/\s+/g, "").length, 0);
  const nonEmptyCount = pages.length - emptyPages.length;
  let quality = "good";
  if (!nonEmptyCount || emptyPages.length / pages.length >= 0.5 || meaningful / pages.length < 200) quality = "needs_ocr";
  else if (emptyPages.length / pages.length >= 0.2 || meaningful / nonEmptyCount < 800) quality = "sparse";

  const authors = Array.isArray(input.authors)
    ? input.authors.map(String)
    : typeof input.authors === "string" && input.authors.trim() ? input.authors.split(/\s*(?:;|\band\b)\s*/).filter(Boolean) : [];
  return {
    schemaVersion: TIER0_SCHEMA,
    builderVersion: TIER0_BUILDER_VERSION,
    tier: 0,
    status: "extracted_unreviewed",
    paperId,
    title: input.title ?? paperId,
    metadata: {
      authors,
      year: Number.isInteger(input.year) ? input.year : null,
      arxivId: input.arxivId ? arxivBase(input.arxivId) : null,
      doi: input.doi ? cleanDoi(String(input.doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "")) : null,
      journal: input.journal && input.journal.name && input.journal.volume ? { name: String(input.journal.name), volume: String(input.journal.volume), page: String(input.journal.page ?? "") } : null,
    },
    fulltextSha256: sha256Hex(fulltext),
    pageCount: pages.length,
    emptyPages,
    quality,
    identity,
    abstract,
    sections,
    keyPoints,
    quantities,
    keyphrases,
    referenceStyle: references.style,
    references: references.entries.map((entry) => ({
      index: entry.index,
      label: entry.label,
      text: entry.text,
      arxivId: entry.arxivId,
      doi: entry.doi,
      year: entry.year,
      yearSuffix: entry.yearSuffix,
      firstAuthor: entry.firstAuthor,
      journal: entry.journal,
    })),
    citationContexts,
  };
}

// ---------------------------------------------------------------------------
// Library analysis: citation edges, similarity, clustering.

function briefTargetYear(brief) {
  return brief.metadata?.year ?? brief.identity?.year ?? null;
}

function briefFirstAuthorKey(brief) {
  const first = brief.metadata?.authors?.[0];
  return first ? surnameKey(first) : "";
}

function pushMap(map, key, value) {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else {
    map.set(key, [value]);
  }
}

function referenceStrongKeys(reference) {
  const keys = [];
  if (reference.arxivId) keys.push(`arxiv:${arxivBase(reference.arxivId)}`);
  if (reference.doi) keys.push(`doi:${reference.doi.toLowerCase()}`);
  const surname = reference.firstAuthor ? surnameKey(reference.firstAuthor) : "";
  const journal = journalKey(reference.journal);
  if (journal) keys.push(`journal:${journal}`);
  if (surname && reference.year && journal) keys.push(`ayj:${surname}|${reference.year}|${journal}`);
  return keys;
}

class UnionFind {
  constructor() {
    this.parent = new Map();
  }

  find(key) {
    if (!this.parent.has(key)) this.parent.set(key, key);
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    let cursor = key;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor);
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(left, right) {
    const a = this.find(left);
    const b = this.find(right);
    if (a === b) return;
    // Deterministic: the lexicographically smaller key becomes the root.
    if (a < b) this.parent.set(b, a);
    else this.parent.set(a, b);
  }
}

/**
 * Sparse cosine similarity over weighted term vectors. Rows are accumulated
 * with a typed array, so only the top entries of each row are materialized;
 * any other pair is computed on demand with the same pruned terms.
 */
class CosineIndex {
  constructor(vectors, ids, { maxDocumentFrequency = Infinity, scale = null } = {}) {
    this.ids = ids;
    this.vectors = ids.map((id) => vectors.get(id) ?? new Map());
    this.norms = new Float64Array(ids.length);
    this.scale = scale;
    const postings = new Map();
    this.vectors.forEach((vector, index) => {
      let norm = 0;
      for (const [term, weight] of vector) {
        norm += weight * weight;
        const posting = postings.get(term);
        if (posting) {
          posting.docs.push(index);
          posting.weights.push(weight);
        } else {
          postings.set(term, { docs: [index], weights: [weight] });
        }
      }
      this.norms[index] = Math.sqrt(norm);
    });
    this.pruned = new Set();
    for (const [term, posting] of postings) {
      if (posting.docs.length > maxDocumentFrequency) {
        this.pruned.add(term);
        postings.delete(term);
      } else if (posting.docs.length < 2) {
        postings.delete(term);
      }
    }
    this.postings = postings;
    this.accumulator = new Float64Array(ids.length);
    this.marked = new Uint8Array(ids.length);
  }

  finish(left, right, dot) {
    const denominator = this.norms[left] * this.norms[right];
    if (!denominator) return 0;
    let value = Math.min(1, dot / denominator);
    if (this.scale) value *= this.scale[left] * this.scale[right];
    return value > 1e-9 ? value : 0;
  }

  value(left, right) {
    if (left === right) return 0;
    let small = this.vectors[left];
    let large = this.vectors[right];
    if (small.size > large.size) [small, large] = [large, small];
    let dot = 0;
    for (const [term, weight] of small) {
      if (this.pruned.has(term)) continue;
      const other = large.get(term);
      if (other !== undefined) dot += weight * other;
    }
    return this.finish(left, right, dot);
  }

  top(index, limit) {
    const { accumulator, marked } = this;
    const touched = [];
    for (const [term, weight] of this.vectors[index]) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const { docs, weights } = posting;
      for (let position = 0; position < docs.length; position += 1) {
        const other = docs[position];
        if (other === index) continue;
        if (!marked[other]) {
          marked[other] = 1;
          touched.push(other);
        }
        accumulator[other] += weight * weights[position];
      }
    }
    const scored = [];
    for (const other of touched) {
      const value = this.finish(index, other, accumulator[other]);
      if (value > 0) scored.push([other, value]);
      accumulator[other] = 0;
      marked[other] = 0;
    }
    scored.sort((left, right) => right[1] - left[1] || compareStrings(this.ids[left[0]], this.ids[right[0]]));
    return scored.slice(0, limit);
  }
}

function pushPosting(postings, term, id, weight) {
  const list = postings.get(term);
  if (list) list.push([id, weight]);
  else postings.set(term, [[id, weight]]);
}

function textVectors(list) {
  const documentFrequency = new Map();
  const counts = new Map();
  for (const brief of list) {
    const tf = new Map();
    const add = (token, weight) => tf.set(token, (tf.get(token) ?? 0) + weight);
    for (const token of contentTokens(brief.title ?? "")) add(token, 2);
    for (const token of contentTokens(brief.abstract?.text ?? "")) add(token, 1);
    for (const point of brief.keyPoints ?? []) for (const token of contentTokens(point.text)) add(token, 1);
    for (const phrase of brief.keyphrases ?? []) {
      if (phrase.phrase.includes(" ")) add(`«${phrase.phrase}»`, Math.min(3, phrase.count ?? 1));
      else add(phrase.phrase, Math.min(3, (phrase.count ?? 1) / 2));
    }
    counts.set(brief.paperId, tf);
    for (const term of tf.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const total = list.length;
  const vectors = new Map();
  for (const brief of list) {
    const vector = new Map();
    for (const [term, tf] of counts.get(brief.paperId)) {
      const idf = Math.log(1 + total / documentFrequency.get(term));
      vector.set(term, (1 + Math.log(Math.max(1, tf))) * idf);
    }
    vectors.set(brief.paperId, vector);
  }
  return vectors;
}

function libraryKeyphrases(list) {
  const documentFrequency = new Map();
  for (const brief of list) for (const item of brief.keyphrases ?? []) documentFrequency.set(item.phrase, (documentFrequency.get(item.phrase) ?? 0) + 1);
  const result = {};
  const total = list.length;
  for (const brief of list) {
    const items = brief.keyphrases ?? [];
    const sum = items.reduce((acc, item) => acc + (item.count ?? item.weight ?? 1), 0) || 1;
    const scored = items.map((item) => ({
      phrase: item.phrase,
      weight: ((item.count ?? item.weight ?? 1) / sum) * (Math.log((total + 1) / (documentFrequency.get(item.phrase) + 1)) + 1) * (1 + 0.5 * (item.phrase.split(" ").length - 1)),
    })).sort((left, right) => right.weight - left.weight || compareStrings(left.phrase, right.phrase)).slice(0, 12);
    const max = scored[0]?.weight || 1;
    result[brief.paperId] = scored.map((item) => ({ phrase: item.phrase, weight: round(item.weight / max) }));
  }
  return result;
}

function combine(candidate, weights) {
  return weights.coupling * candidate[1] + weights.cocitation * candidate[2] + weights.text * candidate[3];
}

function normalizedWeights(weights) {
  const merged = { ...DEFAULT_SIMILARITY_WEIGHTS, ...(weights ?? {}) };
  for (const key of ["coupling", "cocitation", "text"]) {
    if (!Number.isFinite(merged[key]) || merged[key] < 0) throw new Error(`similarity weight ${key} must be a non-negative number`);
  }
  return { coupling: merged.coupling, cocitation: merged.cocitation, text: merged.text };
}

/**
 * Build library-level Tier-0 analysis from briefs.
 * @param {object[]} briefs
 * @param {{weights?: {coupling?: number, cocitation?: number, text?: number}, k?: number, seed?: number, resolution?: number, stabilitySeeds?: number}} [options]
 */
export function buildLibraryAnalysis(briefs, options = {}) {
  const list = [...(briefs ?? [])].sort((left, right) => compareStrings(left.paperId, right.paperId));
  const ids = list.map((brief) => brief.paperId);
  if (new Set(ids).size !== ids.length) throw new Error("buildLibraryAnalysis received duplicate paper IDs");
  const byId = new Map(list.map((brief) => [brief.paperId, brief]));
  const weights = normalizedWeights(options.weights);
  const k = Number.isInteger(options.k) && options.k > 0 ? options.k : 10;
  const seed = Number.isInteger(options.seed) ? options.seed : 1;

  // Identity indexes for citation resolution.
  const byArxiv = new Map();
  const byDoi = new Map();
  const byAuthorYear = new Map();
  for (const brief of list) {
    const arxivIds = new Set([brief.metadata?.arxivId, ...(brief.identity?.arxivIds ?? [])].filter(Boolean).map(arxivBase));
    const dois = new Set([brief.metadata?.doi, ...(brief.identity?.dois ?? [])].filter(Boolean).map((doi) => doi.toLowerCase()));
    for (const id of arxivIds) pushMap(byArxiv, id, brief.paperId);
    for (const doi of dois) pushMap(byDoi, doi, brief.paperId);
    const surname = briefFirstAuthorKey(brief);
    const year = briefTargetYear(brief);
    if (surname && year) pushMap(byAuthorYear, `${surname}|${year}`, brief.paperId);
  }

  const citationEdges = [];
  for (const source of list) {
    const edges = new Map();
    const contextsByRef = new Map();
    for (const context of source.citationContexts ?? []) pushMap(contextsByRef, context.refIndex, context);
    for (const reference of source.references ?? []) {
      let targets = [];
      let match = null;
      let via = null;
      const arxivTargets = reference.arxivId ? byArxiv.get(arxivBase(reference.arxivId)) ?? [] : [];
      const doiTargets = reference.doi ? byDoi.get(reference.doi.toLowerCase()) ?? [] : [];
      if (arxivTargets.some((id) => id !== source.paperId)) {
        targets = arxivTargets;
        match = "exact";
        via = "arxiv";
      } else if (doiTargets.some((id) => id !== source.paperId)) {
        targets = doiTargets;
        match = "exact";
        via = "doi";
      } else if (reference.firstAuthor && reference.year) {
        const surname = surnameKey(reference.firstAuthor);
        let candidates = (byAuthorYear.get(`${surname}|${reference.year}`) ?? []).filter((id) => id !== source.paperId);
        const referenceJournal = journalKey(reference.journal);
        if (referenceJournal) {
          candidates = candidates.filter((id) => {
            const targetJournal = journalKey(byId.get(id).metadata?.journal);
            return !targetJournal || targetJournal === referenceJournal;
          });
        }
        if (candidates.length === 1) {
          targets = candidates;
          match = "probable";
          const targetJournal = journalKey(byId.get(candidates[0]).metadata?.journal);
          via = referenceJournal && targetJournal && referenceJournal === targetJournal ? "journal" : "author-year";
        }
      }
      for (const target of targets) {
        if (target === source.paperId) continue;
        const contexts = (contextsByRef.get(reference.index) ?? []).map((context) => ({ text: context.text, page: context.page, start: context.start, end: context.end }));
        const existing = edges.get(target);
        if (!existing || (existing.match === "probable" && match === "exact")) {
          edges.set(target, { source: source.paperId, target, match, via, refIndex: reference.index, contexts });
        } else {
          for (const context of contexts) {
            if (!existing.contexts.some((item) => item.page === context.page && item.start === context.start)) existing.contexts.push(context);
          }
        }
      }
    }
    for (const target of [...edges.keys()].sort(compareStrings)) citationEdges.push(edges.get(target));
  }
  const inDegree = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const edge of citationEdges) inDegree[edge.target] += 1;

  // Bibliographic coupling over normalized reference keys (including
  // references outside the library).
  const union = new UnionFind();
  const entryKeys = new Map();
  for (const brief of list) {
    const keys = [];
    for (const reference of brief.references ?? []) {
      const strong = referenceStrongKeys(reference);
      if (strong.length) {
        for (let index = 1; index < strong.length; index += 1) union.union(strong[0], strong[index]);
        keys.push(strong[0]);
      } else if (reference.firstAuthor && reference.year) {
        keys.push(`ay:${surnameKey(reference.firstAuthor)}|${reference.year}${reference.yearSuffix ?? ""}`);
      }
    }
    entryKeys.set(brief.paperId, keys);
  }
  // A library paper's own identity also joins its reference keys so that a
  // reference to it by arXiv ID and by DOI collapse together.
  for (const brief of list) {
    const own = [
      ...(brief.metadata?.arxivId ? [`arxiv:${arxivBase(brief.metadata.arxivId)}`] : []),
      ...(brief.identity?.arxivIds ?? []).map((id) => `arxiv:${arxivBase(id)}`),
      ...(brief.metadata?.doi ? [`doi:${brief.metadata.doi.toLowerCase()}`] : []),
      ...(brief.identity?.dois ?? []).map((doi) => `doi:${doi}`),
    ];
    for (let index = 1; index < own.length; index += 1) union.union(own[0], own[index]);
  }
  const couplingVectors = new Map();
  const referenceCounts = new Map();
  for (const brief of list) {
    const keys = new Set(entryKeys.get(brief.paperId).map((key) => (key.startsWith("ay:") ? key : union.find(key))));
    referenceCounts.set(brief.paperId, (brief.references ?? []).length);
    couplingVectors.set(brief.paperId, new Map([...keys].map((key) => [key, 1])));
  }
  const downWeight = (id) => {
    const count = referenceCounts.get(id);
    return count > 150 ? 1 / Math.sqrt(count / 150) : 1;
  };
  const coupling = new CosineIndex(couplingVectors, ids, { scale: Float64Array.from(ids, downWeight) });

  // In-library co-citation (Small 1973): papers cited together by a library paper.
  const citers = new Map(ids.map((id) => [id, new Map()]));
  for (const edge of citationEdges) citers.get(edge.target).set(edge.source, 1);
  const cocitation = new CosineIndex(citers, ids);

  // Terms in more than half of a larger library carry little information and
  // dominate the cost of pairwise accumulation, so they are pruned.
  const text = new CosineIndex(textVectors(list), ids, { maxDocumentFrequency: ids.length > 60 ? Math.max(30, Math.floor(ids.length * 0.5)) : Infinity });

  // Candidate pairs: union of per-component top lists (plus direct citation
  // partners) with all three component values.
  const candidateLimit = Math.max(15, k + 5);
  const position = new Map(ids.map((id, index) => [id, index]));
  const citationPartners = new Map(ids.map((id) => [id, new Set()]));
  for (const edge of citationEdges) {
    citationPartners.get(edge.source).add(position.get(edge.target));
    citationPartners.get(edge.target).add(position.get(edge.source));
  }
  const candidateMaps = ids.map(() => new Map());
  ids.forEach((id, index) => {
    const partners = new Set(citationPartners.get(id));
    for (const component of [coupling, cocitation, text]) for (const [other] of component.top(index, candidateLimit)) partners.add(other);
    for (const other of partners) {
      if (candidateMaps[index].has(other)) continue;
      const entry = [
        round(coupling.value(index, other)),
        round(cocitation.value(index, other)),
        round(text.value(index, other)),
      ];
      candidateMaps[index].set(other, entry);
      candidateMaps[other].set(index, entry);
    }
  });
  const similarityCandidates = {};
  ids.forEach((id, index) => {
    similarityCandidates[id] = [...candidateMaps[index].entries()].map(([other, entry]) => [ids[other], ...entry]);
  });
  for (const id of ids) similarityCandidates[id].sort((left, right) => compareStrings(left[0], right[0]));

  const neighbors = {};
  for (const id of ids) {
    neighbors[id] = similarityCandidates[id]
      .map((entry) => ({ id: entry[0], weight: round(combine(entry, weights)), coupling: entry[1], cocitation: entry[2], text: entry[3] }))
      .filter((entry) => entry.weight > 0)
      .sort((left, right) => right.weight - left.weight || compareStrings(left.id, right.id))
      .slice(0, k);
  }

  const keyphrases = libraryKeyphrases(list);
  const library = {
    schemaVersion: TIER0_LIBRARY_SCHEMA,
    builderVersion: TIER0_BUILDER_VERSION,
    tier: 0,
    paperIds: ids,
    papers: Object.fromEntries(list.map((brief) => [brief.paperId, { title: brief.title, year: briefTargetYear(brief), quality: brief.quality, fulltextSha256: brief.fulltextSha256 }])),
    citationEdges,
    inDegree,
    keyphrases,
    weights,
    neighbors,
    similarityCandidates,
  };
  const clusters = clusterLibrary(library, {
    weights,
    k,
    seed,
    resolution: Number.isFinite(options.resolution) ? options.resolution : 1,
    stabilitySeeds: Number.isInteger(options.stabilitySeeds) ? options.stabilitySeeds : 5,
  });
  library.clusters = clusters;
  library.readingPaths = readingPaths(library, clusters);
  return library;
}

// ---------------------------------------------------------------------------
// Graph construction and Leiden clustering (Traag, Waltman & van Eck 2019).

function buildGraph(ids, similarityCandidates, weights, k) {
  const index = new Map(ids.map((id, position) => [id, position]));
  const edgeWeights = new Map();
  for (const id of ids) {
    const top = (similarityCandidates[id] ?? [])
      .map((entry) => [entry[0], combine(entry, weights)])
      .filter((entry) => entry[1] > 1e-9 && index.has(entry[0]))
      .sort((left, right) => right[1] - left[1] || compareStrings(left[0], right[0]))
      .slice(0, k);
    const from = index.get(id);
    for (const [other, weight] of top) {
      const to = index.get(other);
      const key = from < to ? `${from}|${to}` : `${to}|${from}`;
      edgeWeights.set(key, Math.max(edgeWeights.get(key) ?? 0, weight));
    }
  }
  return graphFromEdges(ids.length, [...edgeWeights.entries()].sort((left, right) => compareStrings(left[0], right[0])).map(([key, weight]) => {
    const [from, to] = key.split("|").map(Number);
    return [from, to, weight];
  }));
}

/**
 * @param {number} n
 * @param {Array<[number, number, number]>} edges undirected, no duplicates
 */
function graphFromEdges(n, edges) {
  const adjacency = Array.from({ length: n }, () => []);
  const strength = new Float64Array(n);
  const selfLoop = new Float64Array(n);
  for (const [from, to, weight] of edges) {
    if (from === to) {
      selfLoop[from] += weight;
      strength[from] += 2 * weight;
      continue;
    }
    adjacency[from].push([to, weight]);
    adjacency[to].push([from, weight]);
    strength[from] += weight;
    strength[to] += weight;
  }
  let total = 0;
  for (let node = 0; node < n; node += 1) total += strength[node];
  return { n, adjacency, strength, selfLoop, total };
}

function renumber(assignment) {
  const mapping = new Map();
  const result = new Int32Array(assignment.length);
  for (let node = 0; node < assignment.length; node += 1) {
    if (!mapping.has(assignment[node])) mapping.set(assignment[node], mapping.size);
    result[node] = mapping.get(assignment[node]);
  }
  return { assignment: result, count: mapping.size };
}

function fastMoveNodes(graph, partition, resolution, random) {
  const { n, adjacency, strength, total } = graph;
  if (!total) return partition;
  const communityStrength = new Float64Array(n);
  const communitySize = new Int32Array(n);
  for (let node = 0; node < n; node += 1) {
    communityStrength[partition[node]] += strength[node];
    communitySize[partition[node]] += 1;
  }
  const empty = [];
  for (let community = n - 1; community >= 0; community -= 1) if (!communitySize[community]) empty.push(community);
  const queue = shuffled(Array.from({ length: n }, (_, node) => node), random);
  const inQueue = new Uint8Array(n).fill(1);
  const neighborWeight = new Float64Array(n);
  const touched = [];
  let head = 0;
  while (head < queue.length) {
    const node = queue[head];
    head += 1;
    inQueue[node] = 0;
    const current = partition[node];
    for (const [neighbor, weight] of adjacency[node]) {
      const community = partition[neighbor];
      if (neighborWeight[community] === 0) touched.push(community);
      neighborWeight[community] += weight;
    }
    communityStrength[current] -= strength[node];
    communitySize[current] -= 1;
    const factor = (resolution * strength[node]) / total;
    let best = current;
    let bestGain = neighborWeight[current] - factor * communityStrength[current];
    for (const community of touched) {
      if (community === current) continue;
      const gain = neighborWeight[community] - factor * communityStrength[community];
      if (gain > bestGain + 1e-12) {
        bestGain = gain;
        best = community;
      }
    }
    if (bestGain < -1e-12) {
      // An empty community has gain 0.
      if (!communitySize[current]) best = current;
      else if (empty.length) best = empty.pop();
    }
    for (const community of touched) neighborWeight[community] = 0;
    touched.length = 0;
    communityStrength[best] += strength[node];
    communitySize[best] += 1;
    if (!communitySize[current] && current !== best) empty.push(current);
    if (best !== current) {
      partition[node] = best;
      for (const [neighbor] of adjacency[node]) {
        if (!inQueue[neighbor] && partition[neighbor] !== best) {
          inQueue[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }
  }
  return partition;
}

function refinePartition(graph, partition, resolution, theta, random) {
  const { n, adjacency, strength, total } = graph;
  const refined = new Int32Array(n);
  for (let node = 0; node < n; node += 1) refined[node] = node;
  if (!total) return refined;
  const refinedStrength = Float64Array.from(strength);
  const singleton = new Uint8Array(n).fill(1);
  const externalWeight = new Float64Array(n);
  const members = new Map();
  for (let node = 0; node < n; node += 1) pushMap(members, partition[node], node);
  const communityTotal = new Map();
  for (const [community, nodes] of members) communityTotal.set(community, nodes.reduce((sum, node) => sum + strength[node], 0));
  const weightToSubset = new Float64Array(n);
  for (let node = 0; node < n; node += 1) {
    let weight = 0;
    for (const [neighbor, edgeWeight] of adjacency[node]) if (partition[neighbor] === partition[node]) weight += edgeWeight;
    weightToSubset[node] = weight;
    externalWeight[node] = weight;
  }
  const neighborWeight = new Float64Array(n);
  const touched = [];
  for (const community of [...members.keys()].sort((left, right) => left - right)) {
    const nodes = members.get(community);
    if (nodes.length < 2) continue;
    const subsetTotal = communityTotal.get(community);
    for (const node of shuffled(nodes, random)) {
      const wellConnected = weightToSubset[node] >= (resolution * strength[node] * (subsetTotal - strength[node])) / total - 1e-12;
      if (!wellConnected || !singleton[refined[node]] || refined[node] !== node) continue;
      for (const [neighbor, weight] of adjacency[node]) {
        if (partition[neighbor] !== community) continue;
        const target = refined[neighbor];
        if (neighborWeight[target] === 0) touched.push(target);
        neighborWeight[target] += weight;
      }
      const options = [[node, 0]];
      for (const target of touched) {
        if (target === node) continue;
        const targetWell = externalWeight[target] >= (resolution * refinedStrength[target] * (subsetTotal - refinedStrength[target])) / total - 1e-12;
        if (!targetWell) continue;
        const gain = neighborWeight[target] - (resolution * strength[node] * refinedStrength[target]) / total;
        if (gain >= 0) options.push([target, gain]);
      }
      let chosen = node;
      if (options.length > 1) {
        const maxGain = Math.max(...options.map((option) => option[1]));
        const probabilities = options.map((option) => Math.exp((option[1] - maxGain) / theta));
        const sum = probabilities.reduce((acc, value) => acc + value, 0);
        let draw = random() * sum;
        for (let index = 0; index < options.length; index += 1) {
          draw -= probabilities[index];
          if (draw <= 0) {
            chosen = options[index][0];
            break;
          }
        }
        if (draw > 0) chosen = options[options.length - 1][0];
      }
      if (chosen !== node) {
        const toTarget = neighborWeight[chosen];
        refined[node] = chosen;
        refinedStrength[chosen] += strength[node];
        refinedStrength[node] = 0;
        singleton[chosen] = 0;
        singleton[node] = 0;
        externalWeight[chosen] = externalWeight[chosen] + weightToSubset[node] - 2 * toTarget;
      }
      for (const target of touched) neighborWeight[target] = 0;
      touched.length = 0;
    }
  }
  return refined;
}

function aggregateGraph(graph, refined) {
  const { assignment, count } = renumber(refined);
  const edgeWeights = new Map();
  const selfLoops = new Float64Array(count);
  for (let node = 0; node < graph.n; node += 1) {
    const from = assignment[node];
    selfLoops[from] += graph.selfLoop[node];
    for (const [neighbor, weight] of graph.adjacency[node]) {
      if (neighbor < node) continue;
      const to = assignment[neighbor];
      if (from === to) selfLoops[from] += weight;
      else {
        const key = from < to ? from * count + to : to * count + from;
        edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + weight);
      }
    }
  }
  const edges = [...edgeWeights.entries()].sort((left, right) => left[0] - right[0]).map(([key, weight]) => [Math.floor(key / count), key % count, weight]);
  for (let node = 0; node < count; node += 1) if (selfLoops[node]) edges.push([node, node, selfLoops[node]]);
  return { graph: graphFromEdges(count, edges), assignment };
}

function splitDisconnected(graph, assignment) {
  const result = new Int32Array(graph.n).fill(-1);
  let next = 0;
  for (let start = 0; start < graph.n; start += 1) {
    if (result[start] !== -1) continue;
    const label = next;
    next += 1;
    const stack = [start];
    result[start] = label;
    while (stack.length) {
      const node = stack.pop();
      for (const [neighbor] of graph.adjacency[node]) {
        if (result[neighbor] === -1 && assignment[neighbor] === assignment[start]) {
          result[neighbor] = label;
          stack.push(neighbor);
        }
      }
    }
  }
  return result;
}

/**
 * Leiden community detection with the modularity quality function.
 * Returns a community index per node; communities are guaranteed connected.
 * @param {{n: number, adjacency: Array<Array<[number, number]>>, strength: Float64Array, selfLoop: Float64Array, total: number}} original
 */
export function leiden(original, { resolution = 1, seed = 1, theta = 0.01, maxLevels = 32 } = {}) {
  const random = mulberry32(seed);
  let graph = original;
  let partition = new Int32Array(graph.n);
  for (let node = 0; node < graph.n; node += 1) partition[node] = node;
  const nodeOf = new Int32Array(original.n);
  for (let node = 0; node < original.n; node += 1) nodeOf[node] = node;
  for (let level = 0; level < maxLevels; level += 1) {
    partition = fastMoveNodes(graph, partition, resolution, random);
    const { assignment: compact, count } = renumber(partition);
    partition = compact;
    if (count === graph.n) break;
    let refined = refinePartition(graph, partition, resolution, theta, random);
    if (renumber(refined).count === graph.n) refined = partition; // no refinement progress: aggregate by P
    const aggregated = aggregateGraph(graph, refined);
    const nextPartition = new Int32Array(aggregated.graph.n);
    for (let node = 0; node < graph.n; node += 1) nextPartition[aggregated.assignment[node]] = partition[node];
    for (let node = 0; node < original.n; node += 1) nodeOf[node] = aggregated.assignment[nodeOf[node]];
    graph = aggregated.graph;
    partition = nextPartition;
  }
  const flat = new Int32Array(original.n);
  for (let node = 0; node < original.n; node += 1) flat[node] = partition[nodeOf[node]];
  return renumber(splitDisconnected(original, flat)).assignment;
}

/** Modularity of an assignment (resolution 1 by default). */
export function modularity(graph, assignment, resolution = 1) {
  if (!graph.total) return 0;
  const internal = new Map();
  const totals = new Map();
  for (let node = 0; node < graph.n; node += 1) {
    const community = assignment[node];
    totals.set(community, (totals.get(community) ?? 0) + graph.strength[node]);
    internal.set(community, (internal.get(community) ?? 0) + 2 * graph.selfLoop[node]);
    for (const [neighbor, weight] of graph.adjacency[node]) if (assignment[neighbor] === community) internal.set(community, internal.get(community) + weight);
  }
  let value = 0;
  for (const [community, total] of totals) value += internal.get(community) / graph.total - resolution * (total / graph.total) ** 2;
  return value;
}

/** Adjusted Rand index (Hubert & Arabie 1985) of two labelings. */
export function adjustedRandIndex(left, right) {
  const n = left.length;
  if (n !== right.length) throw new Error("adjustedRandIndex requires labelings of equal length");
  if (n < 2) return 1;
  const choose2 = (value) => (value * (value - 1)) / 2;
  const table = new Map();
  const rows = new Map();
  const columns = new Map();
  for (let index = 0; index < n; index += 1) {
    const key = `${left[index]}|${right[index]}`;
    table.set(key, (table.get(key) ?? 0) + 1);
    rows.set(left[index], (rows.get(left[index]) ?? 0) + 1);
    columns.set(right[index], (columns.get(right[index]) ?? 0) + 1);
  }
  let index = 0;
  for (const value of table.values()) index += choose2(value);
  let rowSum = 0;
  for (const value of rows.values()) rowSum += choose2(value);
  let columnSum = 0;
  for (const value of columns.values()) columnSum += choose2(value);
  const expected = (rowSum * columnSum) / choose2(n);
  const maximum = (rowSum + columnSum) / 2;
  if (maximum === expected) return 1;
  return (index - expected) / (maximum - expected);
}

function clusterWeights(graph, assignment) {
  const weights = new Map();
  for (let node = 0; node < graph.n; node += 1) {
    const from = assignment[node];
    for (const [neighbor, weight] of graph.adjacency[node]) {
      const to = assignment[neighbor];
      if (from === to || neighbor < node) continue;
      if (!weights.has(from)) weights.set(from, new Map());
      if (!weights.has(to)) weights.set(to, new Map());
      weights.get(from).set(to, (weights.get(from).get(to) ?? 0) + weight);
      weights.get(to).set(from, (weights.get(to).get(from) ?? 0) + weight);
    }
  }
  return weights;
}

/** Merge clusters below minSize (and beyond maxClusters) into their most-connected cluster. */
function enforceClusterRules(graph, input, { minSize, maxClusters }) {
  const assignment = Int32Array.from(input);
  const members = new Map();
  for (let node = 0; node < assignment.length; node += 1) pushMap(members, assignment[node], node);
  const weights = clusterWeights(graph, assignment);
  const minNode = (cluster) => members.get(cluster)[0];
  while (members.size > 1) {
    const clusters = [...members.keys()].sort((left, right) => members.get(left).length - members.get(right).length || minNode(left) - minNode(right));
    let source = clusters.find((cluster) => members.get(cluster).length < minSize);
    if (source === undefined) {
      if (members.size <= maxClusters) break;
      source = clusters[0];
    }
    let target = -1;
    let bestWeight = -1;
    for (const cluster of members.keys()) {
      if (cluster === source) continue;
      const weight = weights.get(source)?.get(cluster) ?? 0;
      const better = weight > bestWeight + 1e-12
        || (Math.abs(weight - bestWeight) <= 1e-12 && (members.get(cluster).length > members.get(target).length
          || (members.get(cluster).length === members.get(target).length && minNode(cluster) < minNode(target))));
      if (better) {
        bestWeight = weight;
        target = cluster;
      }
    }
    for (const node of members.get(source)) assignment[node] = target;
    members.set(target, [...members.get(target), ...members.get(source)].sort((left, right) => left - right));
    members.delete(source);
    const sourceWeights = weights.get(source) ?? new Map();
    if (!weights.has(target)) weights.set(target, new Map());
    for (const [cluster, weight] of sourceWeights) {
      if (cluster === target) continue;
      weights.get(target).set(cluster, (weights.get(target).get(cluster) ?? 0) + weight);
      if (!weights.has(cluster)) weights.set(cluster, new Map());
      weights.get(cluster).set(target, (weights.get(cluster).get(target) ?? 0) + weight);
      weights.get(cluster).delete(source);
    }
    weights.get(target).delete(source);
    weights.delete(source);
  }
  return canonicalClusters(assignment);
}

/** Renumber clusters by size (desc) then smallest node index. */
function canonicalClusters(assignment) {
  const members = new Map();
  for (let node = 0; node < assignment.length; node += 1) pushMap(members, assignment[node], node);
  const order = [...members.keys()].sort((left, right) => members.get(right).length - members.get(left).length || members.get(left)[0] - members.get(right)[0]);
  const mapping = new Map(order.map((cluster, index) => [cluster, index]));
  return Int32Array.from(assignment, (cluster) => mapping.get(cluster));
}

function coarsePartition(graph, { resolution, seed }) {
  if (graph.n === 0) return new Int32Array(0);
  const gammas = [1, 0.75, 0.5, 0.3, 0.15].map((factor) => resolution * factor);
  let chosen = null;
  for (const gamma of gammas) {
    const raw = leiden(graph, { resolution: gamma, seed });
    const sizes = new Map();
    for (const cluster of raw) sizes.set(cluster, (sizes.get(cluster) ?? 0) + 1);
    chosen = raw;
    if ([...sizes.values()].filter((size) => size >= MIN_REGION_PAPERS).length <= MAX_REGIONS) break;
  }
  return enforceClusterRules(graph, chosen, { minSize: MIN_REGION_PAPERS, maxClusters: MAX_REGIONS });
}

function subgraph(graph, nodes) {
  const local = new Map(nodes.map((node, index) => [node, index]));
  const edges = [];
  for (const node of nodes) {
    for (const [neighbor, weight] of graph.adjacency[node]) {
      if (neighbor > node && local.has(neighbor)) edges.push([local.get(node), local.get(neighbor), weight]);
    }
  }
  return graphFromEdges(nodes.length, edges);
}

function finePartition(graph, coarse, { resolution, seed }) {
  const fine = new Int32Array(graph.n);
  const parent = [];
  const members = new Map();
  for (let node = 0; node < graph.n; node += 1) pushMap(members, coarse[node], node);
  let offset = 0;
  for (const cluster of [...members.keys()].sort((left, right) => left - right)) {
    const nodes = members.get(cluster);
    const local = subgraph(graph, nodes);
    const raw = local.n > 2 ? leiden(local, { resolution, seed: seed + cluster * 7919 }) : new Int32Array(local.n);
    const assignment = enforceClusterRules(local, raw, { minSize: nodes.length >= 2 ? 2 : 1, maxClusters: MAX_GALAXIES_PER_REGION });
    let count = 0;
    nodes.forEach((node, index) => {
      fine[node] = offset + assignment[index];
      count = Math.max(count, assignment[index] + 1);
    });
    for (let index = 0; index < count; index += 1) parent.push(cluster);
    offset += count;
  }
  return { assignment: fine, parent };
}

function jaccardStability(base, others) {
  const clusters = new Map();
  for (let node = 0; node < base.length; node += 1) pushMap(clusters, base[node], node);
  const result = [];
  for (const cluster of [...clusters.keys()].sort((left, right) => left - right)) {
    const set = new Set(clusters.get(cluster));
    let sum = 0;
    for (const other of others) {
      const otherClusters = new Map();
      for (let node = 0; node < other.length; node += 1) pushMap(otherClusters, other[node], node);
      let best = 0;
      for (const nodes of otherClusters.values()) {
        let overlap = 0;
        for (const node of nodes) if (set.has(node)) overlap += 1;
        best = Math.max(best, overlap / (set.size + nodes.length - overlap));
      }
      sum += best;
    }
    result.push(others.length ? round(sum / others.length) : 1);
  }
  return result;
}

function meanPairwiseAri(runs) {
  if (runs.length < 2) return 1;
  let sum = 0;
  let count = 0;
  for (let left = 0; left < runs.length; left += 1) {
    for (let right = left + 1; right < runs.length; right += 1) {
      sum += adjustedRandIndex(runs[left], runs[right]);
      count += 1;
    }
  }
  return round(sum / count);
}

function clusterLabels(ids, assignment, keyphrases, count) {
  // Class-based TF-IDF (as in BERTopic): tf per class, idf over classes.
  const classTerms = Array.from({ length: count }, () => new Map());
  const termFrequency = new Map();
  ids.forEach((id, node) => {
    for (const item of keyphrases[id] ?? []) {
      const terms = classTerms[assignment[node]];
      terms.set(item.phrase, (terms.get(item.phrase) ?? 0) + item.weight);
      termFrequency.set(item.phrase, (termFrequency.get(item.phrase) ?? 0) + item.weight);
    }
  });
  const averageWords = classTerms.reduce((sum, terms) => sum + [...terms.values()].reduce((acc, value) => acc + value, 0), 0) / Math.max(1, count);
  return classTerms.map((terms) => {
    const total = [...terms.values()].reduce((acc, value) => acc + value, 0) || 1;
    const ranked = [...terms.entries()]
      .map(([phrase, value]) => [phrase, (value / total) * Math.log(1 + averageWords / termFrequency.get(phrase))])
      .sort((left, right) => right[1] - left[1] || compareStrings(left[0], right[0]));
    const chosen = [];
    for (const [phrase] of ranked) {
      if (chosen.some((other) => ` ${other} `.includes(` ${phrase} `) || ` ${phrase} `.includes(` ${other} `))) continue;
      chosen.push(phrase);
      if (chosen.length === 3) break;
    }
    return chosen.join(" · ") || "Unlabelled";
  });
}

function assignmentObject(ids, assignment) {
  return Object.fromEntries(ids.map((id, node) => [id, assignment[node]]));
}

function clusterLibrary(library, { weights, k, seed, resolution, stabilitySeeds }) {
  const ids = library.paperIds;
  const graph = buildGraph(ids, library.similarityCandidates, weights, k);
  const seeds = Array.from({ length: Math.max(1, stabilitySeeds) }, (_, index) => seed + index);
  const coarseRuns = seeds.map((value) => coarsePartition(graph, { resolution, seed: value }));
  const coarse = coarseRuns[0];
  const coarseCount = coarse.length ? Math.max(...coarse) + 1 : 0;
  const fineRuns = seeds.map((value) => finePartition(graph, coarse, { resolution, seed: value }));
  const fine = fineRuns[0];
  const fineCount = fine.parent.length;
  return {
    algorithm: TIER0_CLUSTER_ALGORITHM,
    weights,
    resolution,
    seed,
    coarse: {
      assignment: assignmentObject(ids, coarse),
      count: coarseCount,
      labels: clusterLabels(ids, coarse, library.keyphrases, coarseCount),
      sizes: sizesOf(coarse, coarseCount),
      stability: meanPairwiseAri(coarseRuns),
      stabilityMethod: `mean pairwise adjusted Rand index over ${seeds.length} seeds`,
      clusterStability: jaccardStability(coarse, coarseRuns.slice(1)),
      clusterStabilityMethod: "mean best-match Jaccard against the other seeds",
    },
    fine: {
      assignment: assignmentObject(ids, fine.assignment),
      count: fineCount,
      parent: fine.parent,
      labels: clusterLabels(ids, fine.assignment, library.keyphrases, fineCount),
      sizes: sizesOf(fine.assignment, fineCount),
      stability: meanPairwiseAri(fineRuns.map((run) => run.assignment)),
      stabilityMethod: `mean pairwise adjusted Rand index over ${seeds.length} seeds within fixed coarse regions`,
      clusterStability: jaccardStability(fine.assignment, fineRuns.slice(1).map((run) => run.assignment)),
      clusterStabilityMethod: "mean best-match Jaccard against the other seeds",
    },
  };
}

function sizesOf(assignment, count) {
  const sizes = new Array(count).fill(0);
  for (const cluster of assignment) sizes[cluster] += 1;
  return sizes;
}

function readingPaths(library, clusters) {
  const years = Object.fromEntries(library.paperIds.map((id) => [id, library.papers[id]?.year ?? null]));
  const order = (members) => {
    const set = new Set(members);
    const cites = new Map(members.map((id) => [id, new Set()]));
    const citedBy = new Map(members.map((id) => [id, new Set()]));
    for (const edge of library.citationEdges) {
      if (!set.has(edge.source) || !set.has(edge.target) || edge.source === edge.target) continue;
      cites.get(edge.source).add(edge.target);
      citedBy.get(edge.target).add(edge.source);
    }
    const priority = (left, right) => {
      const leftYear = years[left] ?? Infinity;
      const rightYear = years[right] ?? Infinity;
      return leftYear - rightYear || (library.inDegree[right] ?? 0) - (library.inDegree[left] ?? 0) || compareStrings(left, right);
    };
    const remainingDependencies = new Map(members.map((id) => [id, cites.get(id).size]));
    const done = new Set();
    const result = [];
    while (result.length < members.length) {
      const ready = members.filter((id) => !done.has(id) && remainingDependencies.get(id) === 0).sort(priority);
      // Cycle: take the highest-priority remaining paper to break it.
      const next = ready[0] ?? members.filter((id) => !done.has(id)).sort(priority)[0];
      done.add(next);
      result.push(next);
      for (const citer of citedBy.get(next)) remainingDependencies.set(citer, remainingDependencies.get(citer) - 1);
    }
    return result;
  };
  const paths = {};
  const groups = (assignment) => {
    const members = new Map();
    for (const id of library.paperIds) pushMap(members, assignment[id], id);
    return members;
  };
  for (const [cluster, members] of [...groups(clusters.coarse.assignment).entries()].sort((left, right) => left[0] - right[0])) paths[`coarse-${cluster}`] = order(members);
  for (const [cluster, members] of [...groups(clusters.fine.assignment).entries()].sort((left, right) => left[0] - right[0])) paths[`fine-${cluster}`] = order(members);
  return paths;
}

// ---------------------------------------------------------------------------
// Partition proposals.

/**
 * Three deterministic macro-region options from the similarity graph.
 * @param {object} library result of buildLibraryAnalysis
 * @param {{seed?: number, k?: number}} [options]
 */
export function proposePartitions(library, options = {}) {
  const ids = library.paperIds;
  const seed = Number.isInteger(options.seed) ? options.seed : 1;
  const k = Number.isInteger(options.k) && options.k > 0 ? options.k : 10;
  const specs = [
    {
      id: "citation-structure",
      name: "Citation structure",
      principle: "Groups papers that share references (bibliographic coupling, weight 0.7) or are cited together inside the library (co-citation, weight 0.3). Text similarity is ignored.",
      weights: { coupling: 0.7, cocitation: 0.3, text: 0 },
      resolution: 1,
    },
    {
      id: "content",
      name: "Content",
      principle: "Groups papers by TF-IDF text similarity of titles, abstracts, extracted key points and keyphrases. Citations are ignored.",
      weights: { coupling: 0, cocitation: 0, text: 1 },
      resolution: 1,
    },
    {
      id: "hybrid-broader",
      name: "Hybrid, broader",
      principle: "Uses the default combined similarity (coupling 0.45, co-citation 0.2, text 0.35) at a lower resolution, producing fewer and broader regions.",
      weights: { ...DEFAULT_SIMILARITY_WEIGHTS },
      resolution: 0.5,
    },
  ];
  const notes = [];
  const optionsOut = specs.map((spec) => {
    const graph = buildGraph(ids, library.similarityCandidates, spec.weights, k);
    const assignment = coarsePartition(graph, { resolution: spec.resolution, seed });
    const count = assignment.length ? Math.max(...assignment) + 1 : 0;
    const labels = clusterLabels(ids, assignment, library.keyphrases, count);
    const regions = [];
    for (let cluster = 0; cluster < count; cluster += 1) {
      const nodes = [];
      assignment.forEach((value, node) => {
        if (value === cluster) nodes.push(node);
      });
      regions.push({
        key: `${spec.id}-${cluster}`,
        label: labels[cluster],
        paperIds: nodes.map((node) => ids[node]),
        consistency: regionConsistency(graph, assignment, nodes),
      });
    }
    if (graph.total === 0 && ids.length > 1) notes.push(`${spec.name}: the similarity graph has no edges for these weights, so every paper falls into the size-merged fallback region(s).`);
    return {
      id: spec.id,
      name: spec.name,
      principle: spec.principle,
      weights: spec.weights,
      resolution: spec.resolution,
      algorithm: TIER0_CLUSTER_ALGORITHM,
      regions,
      counts: { papers: ids.length, regions: regions.length, regionSizes: regions.map((region) => region.paperIds.length) },
      assignment: assignmentObject(ids, assignment),
    };
  });
  const differences = [];
  for (let left = 0; left < optionsOut.length; left += 1) {
    for (let right = left + 1; right < optionsOut.length; right += 1) {
      const fraction = coMembershipDifference(ids, optionsOut[left].assignment, optionsOut[right].assignment);
      differences.push({ left: optionsOut[left].id, right: optionsOut[right].id, fraction: round(fraction) });
      if (fraction < 0.15) {
        notes.push(`Options "${optionsOut[left].name}" and "${optionsOut[right].name}" differ on only ${(fraction * 100).toFixed(1)}% of paper pairs (< 15%); the corpus does not support them as materially different options.`);
      }
    }
  }
  if (ids.length < MIN_REGION_PAPERS) notes.push(`Only ${ids.length} paper(s): every option is a single region because a region needs at least ${MIN_REGION_PAPERS} papers.`);
  notes.push("Consistency is the mean share of each member's similarity-graph weight that stays inside its region, scaled to 0-100.");
  return {
    schemaVersion: TIER0_PARTITIONS_SCHEMA,
    options: optionsOut,
    differences,
    materiallyDistinct: differences.every((item) => item.fraction >= 0.15),
    notes,
  };
}

function regionConsistency(graph, assignment, nodes) {
  if (nodes.length < 2) return 100;
  let sum = 0;
  for (const node of nodes) {
    let inside = 0;
    let all = 0;
    for (const [neighbor, weight] of graph.adjacency[node]) {
      all += weight;
      if (assignment[neighbor] === assignment[node]) inside += weight;
    }
    sum += all ? inside / all : 0;
  }
  return Math.round((100 * sum) / nodes.length);
}

function coMembershipDifference(ids, left, right) {
  const n = ids.length;
  if (n < 2) return 0;
  const leftValues = ids.map((id) => left[id]);
  const rightValues = ids.map((id) => right[id]);
  let differing = 0;
  for (let a = 0; a < n; a += 1) {
    for (let b = a + 1; b < n; b += 1) {
      if ((leftValues[a] === leftValues[b]) !== (rightValues[a] === rightValues[b])) differing += 1;
    }
  }
  return differing / ((n * (n - 1)) / 2);
}

// ---------------------------------------------------------------------------
// Search (BM25).

/**
 * In-memory BM25 search over briefs and optional extra documents.
 * @param {object[]} briefs
 * @param {Array<{id: string, title?: string, text?: string}>} [extraDocs]
 */
export function createSearchIndex(briefs, extraDocs = []) {
  const k1 = 1.2;
  const b = 0.75;
  const documents = [];
  const fieldWeights = { title: 3, abstract: 1, keyPoints: 1, keyphrases: 1, authors: 1 };
  for (const brief of briefs ?? []) {
    documents.push({
      id: brief.paperId,
      title: brief.title ?? brief.paperId,
      fields: {
        title: brief.title ?? "",
        abstract: brief.abstract?.text ?? "",
        keyPoints: (brief.keyPoints ?? []).map((point) => point.text).join(" "),
        keyphrases: (brief.keyphrases ?? []).map((item) => item.phrase).join(" ; "),
        authors: (brief.metadata?.authors ?? []).join(" ; "),
      },
      keyPoints: (brief.keyPoints ?? []).map((point) => ({ ...point, tokens: new Set(tokenize(point.text)) })),
    });
  }
  for (const doc of extraDocs ?? []) {
    documents.push({ id: doc.id, title: doc.title ?? doc.id, fields: { title: doc.title ?? "", abstract: doc.text ?? "", keyPoints: "", keyphrases: "", authors: "" }, keyPoints: [] });
  }
  const postings = new Map();
  const lengths = [];
  documents.forEach((doc, index) => {
    const tf = new Map();
    let length = 0;
    for (const [field, weight] of Object.entries(fieldWeights)) {
      for (const token of tokenize(doc.fields[field])) {
        if (STOPWORDS.has(token)) continue;
        tf.set(token, (tf.get(token) ?? 0) + weight);
        length += weight;
      }
    }
    lengths.push(length);
    for (const [token, frequency] of tf) pushPosting(postings, token, index, frequency);
  });
  const averageLength = lengths.reduce((sum, value) => sum + value, 0) / Math.max(1, lengths.length);
  const count = documents.length;
  return {
    size: count,
    /**
     * @param {string} query
     * @param {{limit?: number}} [options]
     */
    search(query, { limit = 10 } = {}) {
      const terms = [...new Set(tokenize(query).filter((token) => !STOPWORDS.has(token)))];
      const scores = new Map();
      for (const term of terms) {
        const posting = postings.get(term);
        if (!posting) continue;
        const idf = Math.log(1 + (count - posting.length + 0.5) / (posting.length + 0.5));
        for (const [index, frequency] of posting) {
          const norm = frequency + k1 * (1 - b + (b * lengths[index]) / (averageLength || 1));
          scores.set(index, (scores.get(index) ?? 0) + (idf * frequency * (k1 + 1)) / norm);
        }
      }
      return [...scores.entries()]
        .sort((left, right) => right[1] - left[1] || compareStrings(documents[left[0]].id, documents[right[0]].id))
        .slice(0, Math.max(0, limit))
        .map(([index, score]) => {
          const doc = documents[index];
          let matched = null;
          let bestHits = 0;
          for (const point of doc.keyPoints) {
            let hits = 0;
            for (const term of terms) if (point.tokens.has(term)) hits += 1;
            if (hits > bestHits || (hits === bestHits && hits > 0 && matched && point.score > matched.score)) {
              bestHits = hits;
              matched = point;
            }
          }
          const result = { id: doc.id, score: round(score), title: doc.title };
          if (matched) result.matchedQuote = { id: matched.id, kind: matched.kind, text: matched.text, page: matched.page };
          return result;
        });
    },
  };
}

// ---------------------------------------------------------------------------
// Tier-1 galaxy packets and digests.

const GALAXY_INSTRUCTIONS = [
  "You are reviewing one Liteverse galaxy: a small group of related papers. Every quote below is a verbatim, page-located",
  "span extracted without AI (Tier 0, unreviewed). Answer ONLY with JSON matching answerSchema.",
  "Rules: (1) Every gist, matrix cell and relation must cite quote IDs from this packet; never invent IDs or text.",
  "(2) A gist is at most 400 characters and cites at least one quote of that paper.",
  "(3) Matrix cells (question, system, method, assumption, result, regime) cite only quotes of that paper; use null when",
  "the packet does not support a cell. (4) A relation links two different papers of this packet, has one of the allowed",
  "types, and cites at least one quote of the source paper (its own quotes or its citation contexts) in sourceQuoteIds and",
  "at least one quote of the target paper in targetQuoteIds. Prefer candidatePairs; a citation alone is not agreement,",
  "dependence or contradiction. (5) Relations stay candidates; they are never verified by this review.",
  "(6) Use flags for suspected duplicates, errata, extraction problems or out-of-scope papers.",
].join(" ");

function galaxyAnswerSchema() {
  const cell = { oneOf: [{ type: "null" }, { type: "object", required: ["text", "quoteIds"], properties: { text: { type: "string", maxLength: 400 }, quoteIds: { type: "array", minItems: 1, items: { type: "string" } } } }] };
  return {
    type: "object",
    required: ["schemaVersion", "galaxyId", "packetSha256", "papers", "matrix", "relations", "flags"],
    properties: {
      schemaVersion: { const: GALAXY_DIGEST_SCHEMA },
      galaxyId: { type: "string" },
      packetSha256: { type: "string", description: "Copy packetSha256 from the packet." },
      papers: { type: "array", items: { type: "object", required: ["paperId", "gist", "gistQuoteIds"], properties: { paperId: { type: "string" }, gist: { type: "string", minLength: 1, maxLength: 400 }, gistQuoteIds: { type: "array", minItems: 1, items: { type: "string" } } } } },
      matrix: { type: "array", items: { type: "object", required: ["paperId", ...MATRIX_FIELDS], properties: { paperId: { type: "string" }, ...Object.fromEntries(MATRIX_FIELDS.map((field) => [field, cell])) } } },
      relations: { type: "array", items: { type: "object", required: ["source", "target", "type", "sourceQuoteIds", "targetQuoteIds"], properties: { source: { type: "string" }, target: { type: "string" }, type: { enum: [...RELATION_TYPES] }, sourceQuoteIds: { type: "array", minItems: 1, items: { type: "string" } }, targetQuoteIds: { type: "array", minItems: 1, items: { type: "string" } }, note: { type: "string", maxLength: 600 } } } },
      flags: { type: "array", items: { type: "object", required: ["type"], properties: { type: { enum: ["duplicate", "erratum", "extraction_problem", "out_of_scope", "other"] }, paperIds: { type: "array", items: { type: "string" } }, note: { type: "string", maxLength: 600 } } } },
    },
  };
}

function packetHash(packet) {
  const { packetSha256: _ignored, ...rest } = packet;
  void _ignored;
  return sha256Hex(canonicalJson(rest));
}

/**
 * Build a Tier-1 galaxy review packet for an AI agent.
 * @param {{galaxyId: string, galaxyTitle?: string, paperIds: string[], briefs: object[]|Record<string, object>|Map<string, object>, library?: object|null, maxChars?: number, graphRevision?: number|null}} input
 */
export function buildGalaxyPacket({ galaxyId, galaxyTitle = "", paperIds, briefs, library = null, maxChars = 36000, graphRevision = null }) {
  if (typeof galaxyId !== "string" || !galaxyId) throw new Error("buildGalaxyPacket requires a galaxyId");
  if (!Array.isArray(paperIds) || !paperIds.length) throw new Error("buildGalaxyPacket requires paperIds");
  const lookup = briefs instanceof Map
    ? briefs
    : Array.isArray(briefs) ? new Map(briefs.map((brief) => [brief.paperId, brief])) : new Map(Object.entries(briefs ?? {}));
  const ordered = [...new Set(paperIds)].sort(compareStrings);
  const members = new Set(ordered);
  const papers = ordered.map((paperId) => {
    const brief = lookup.get(paperId);
    if (!brief) throw new Error(`no Tier-0 brief for paper ${paperId}`);
    const quotes = [];
    if (brief.abstract) quotes.push({ id: brief.abstract.id ?? quoteId(paperId, brief.abstract.page, brief.abstract.start, brief.abstract.end), kind: "abstract", text: brief.abstract.text, page: brief.abstract.page, score: Infinity });
    for (const point of brief.keyPoints ?? []) {
      if (quotes.some((quote) => quote.id === point.id)) continue;
      quotes.push({ id: point.id, kind: point.kind, text: point.text, page: point.page, score: point.score ?? 0 });
    }
    return {
      paperId,
      title: brief.title ?? paperId,
      year: brief.metadata?.year ?? brief.identity?.year ?? null,
      quality: brief.quality,
      quotes,
      quantities: (brief.quantities ?? []).map((quantity) => ({ id: quantity.id, text: quantity.text, value: quantity.value, unit: quantity.unit, page: quantity.page })),
    };
  });
  const citationContexts = [];
  const seen = new Set();
  for (const edge of library?.citationEdges ?? []) {
    if (!members.has(edge.source) || !members.has(edge.target)) continue;
    for (const context of edge.contexts ?? []) {
      const id = quoteId(edge.source, context.page, context.start, context.end);
      const key = `${id}|${edge.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      citationContexts.push({ source: edge.source, target: edge.target, match: edge.match, quoteId: id, text: context.text, page: context.page });
    }
  }
  citationContexts.sort((left, right) => compareStrings(left.source, right.source) || compareStrings(left.target, right.target) || left.page - right.page || compareStrings(left.quoteId, right.quoteId));
  const candidatePairs = [];
  const pairKeys = new Set();
  const addPair = (source, target, reason) => {
    const key = `${source}|${target}`;
    if (source === target || pairKeys.has(key)) return;
    pairKeys.add(key);
    candidatePairs.push({ source, target, reason });
  };
  for (const edge of library?.citationEdges ?? []) if (members.has(edge.source) && members.has(edge.target)) addPair(edge.source, edge.target, `cites (${edge.match})`);
  for (const paperId of ordered) {
    const neighbors = (library?.neighbors?.[paperId] ?? []).filter((neighbor) => members.has(neighbor.id)).slice(0, 5);
    for (const neighbor of neighbors) {
      const [source, target] = paperId < neighbor.id ? [paperId, neighbor.id] : [neighbor.id, paperId];
      if (!pairKeys.has(`${target}|${source}`)) addPair(source, target, "similarity neighbour");
    }
  }

  const packet = {
    schemaVersion: GALAXY_PACKET_SCHEMA,
    tier: 1,
    galaxyId,
    galaxyTitle,
    graphRevision,
    maxChars,
    truncated: false,
    papers,
    citationContexts,
    candidatePairs,
    relationTypes: [...RELATION_TYPES],
    instructions: GALAXY_INSTRUCTIONS,
    answerSchema: galaxyAnswerSchema(),
  };
  const size = () => JSON.stringify(packet, (key, value) => (key === "score" ? undefined : value)).length + 90;
  const removable = (paper) => paper.quotes.filter((quote) => quote.kind !== "abstract").length;
  let guard = 0;
  while (size() > maxChars && guard < 10_000) {
    guard += 1;
    packet.truncated = true;
    // 1) Trim key points evenly: take from the paper with the most, lowest score first (keep ≥ 2).
    const byKeyPoints = [...papers].sort((left, right) => removable(right) - removable(left) || compareStrings(left.paperId, right.paperId))[0];
    if (byKeyPoints && removable(byKeyPoints) > 2) {
      removeLowest(byKeyPoints.quotes, (quote) => quote.kind !== "abstract");
      continue;
    }
    const byQuantities = [...papers].sort((left, right) => right.quantities.length - left.quantities.length || compareStrings(left.paperId, right.paperId))[0];
    if (byQuantities && byQuantities.quantities.length) {
      byQuantities.quantities.pop();
      continue;
    }
    if (citationContexts.length) {
      let longest = 0;
      citationContexts.forEach((context, index) => {
        if (context.text.length > citationContexts[longest].text.length) longest = index;
      });
      citationContexts.splice(longest, 1);
      continue;
    }
    if (byKeyPoints && removable(byKeyPoints) > 0) {
      removeLowest(byKeyPoints.quotes, (quote) => quote.kind !== "abstract");
      continue;
    }
    const withAbstract = [...papers].sort((left, right) => (right.quotes[0]?.text.length ?? 0) - (left.quotes[0]?.text.length ?? 0) || compareStrings(left.paperId, right.paperId))[0];
    if (withAbstract && withAbstract.quotes.length) {
      withAbstract.quotes.shift();
      continue;
    }
    break;
  }
  for (const paper of papers) for (const quote of paper.quotes) delete quote.score;
  packet.packetSha256 = packetHash(packet);
  return packet;
}

function removeLowest(quotes, predicate) {
  let lowest = -1;
  quotes.forEach((quote, index) => {
    if (!predicate(quote)) return;
    if (lowest < 0 || quote.score < quotes[lowest].score || (quote.score === quotes[lowest].score && compareStrings(quote.id, quotes[lowest].id) > 0)) lowest = index;
  });
  if (lowest >= 0) quotes.splice(lowest, 1);
}

function quoteOwners(packet) {
  // quote ID -> { paper: owning paper, citation: source paper for citation contexts }
  const owners = new Map();
  for (const paper of packet.papers ?? []) {
    for (const quote of paper.quotes ?? []) owners.set(quote.id, new Set([paper.paperId]));
    for (const quantity of paper.quantities ?? []) {
      if (!owners.has(quantity.id)) owners.set(quantity.id, new Set());
      owners.get(quantity.id).add(paper.paperId);
    }
  }
  for (const context of packet.citationContexts ?? []) {
    if (!owners.has(context.quoteId)) owners.set(context.quoteId, new Set());
    owners.get(context.quoteId).add(context.source);
  }
  return owners;
}

/**
 * Validate an AI-authored galaxy digest against its packet.
 * @param {object} packet
 * @param {object} digest
 * @returns {{ok: boolean, errors: string[], warnings: string[], digest: object|null}}
 */
export function validateGalaxyDigest(packet, digest) {
  const errors = [];
  const warnings = [];
  const fail = (message) => errors.push(message);
  if (!packet || typeof packet !== "object" || packet.schemaVersion !== GALAXY_PACKET_SCHEMA) {
    return { ok: false, errors: ["packet: not a liteverse-galaxy-packet-v1 object"], warnings, digest: null };
  }
  if (packetHash(packet) !== packet.packetSha256) fail("packet: packetSha256 does not match the packet content (packet was modified)");
  if (!digest || typeof digest !== "object" || Array.isArray(digest)) {
    return { ok: false, errors: [...errors, "digest: must be a JSON object"], warnings, digest: null };
  }
  if (digest.schemaVersion !== GALAXY_DIGEST_SCHEMA) fail(`schemaVersion: expected ${GALAXY_DIGEST_SCHEMA}, received ${JSON.stringify(digest.schemaVersion)}`);
  if (digest.galaxyId !== packet.galaxyId) fail(`galaxyId: expected ${packet.galaxyId}, received ${JSON.stringify(digest.galaxyId)}`);
  if (digest.packetSha256 !== packet.packetSha256) fail(`packetSha256: expected ${packet.packetSha256}, received ${JSON.stringify(digest.packetSha256)}`);
  const paperIds = new Set((packet.papers ?? []).map((paper) => paper.paperId));
  const owners = quoteOwners(packet);
  const checkQuotes = (value, path, allowedPaper) => {
    if (!Array.isArray(value) || !value.length) {
      fail(`${path}: must be a non-empty array of quote IDs`);
      return [];
    }
    const ids = [];
    value.forEach((id, index) => {
      if (typeof id !== "string") return fail(`${path}[${index}]: quote ID must be a string`);
      const owner = owners.get(id);
      if (!owner) return fail(`${path}[${index}]: quote ${id} does not exist in the packet`);
      if (!owner.has(allowedPaper)) return fail(`${path}[${index}]: quote ${id} belongs to ${[...owner].sort().join(", ")}, not ${allowedPaper}`);
      if (!ids.includes(id)) ids.push(id);
    });
    return ids;
  };
  const checkPaper = (value, path) => {
    if (typeof value !== "string" || !paperIds.has(value)) {
      fail(`${path}: paper ${JSON.stringify(value)} is not in this packet`);
      return false;
    }
    return true;
  };
  const normalized = {
    schemaVersion: GALAXY_DIGEST_SCHEMA,
    tier: 1,
    galaxyId: packet.galaxyId,
    packetSha256: packet.packetSha256,
    papers: [],
    matrix: [],
    relations: [],
    flags: [],
  };
  const section = (name) => {
    if (digest[name] === undefined) return [];
    if (!Array.isArray(digest[name])) {
      fail(`${name}: must be an array`);
      return [];
    }
    return digest[name];
  };
  const seenPapers = new Set();
  section("papers").forEach((item, index) => {
    const path = `papers[${index}]`;
    if (!item || typeof item !== "object") return fail(`${path}: must be an object`);
    if (!checkPaper(item.paperId, `${path}.paperId`)) return;
    if (seenPapers.has(item.paperId)) fail(`${path}.paperId: duplicate gist for ${item.paperId}`);
    seenPapers.add(item.paperId);
    const gist = typeof item.gist === "string" ? item.gist.trim() : "";
    if (!gist) fail(`${path}.gist: must be a non-empty string`);
    else if (gist.length > 400) fail(`${path}.gist: ${gist.length} characters exceeds 400`);
    const gistQuoteIds = checkQuotes(item.gistQuoteIds, `${path}.gistQuoteIds`, item.paperId);
    normalized.papers.push({ paperId: item.paperId, gist, gistQuoteIds });
  });
  const seenRows = new Set();
  section("matrix").forEach((row, index) => {
    const path = `matrix[${index}]`;
    if (!row || typeof row !== "object") return fail(`${path}: must be an object`);
    if (!checkPaper(row.paperId, `${path}.paperId`)) return;
    if (seenRows.has(row.paperId)) fail(`${path}.paperId: duplicate matrix row for ${row.paperId}`);
    seenRows.add(row.paperId);
    const out = { paperId: row.paperId };
    for (const field of MATRIX_FIELDS) {
      const cell = row[field];
      if (cell === null || cell === undefined) {
        out[field] = null;
        continue;
      }
      if (typeof cell !== "object" || Array.isArray(cell)) {
        fail(`${path}.${field}: must be null or {text, quoteIds}`);
        continue;
      }
      const text = typeof cell.text === "string" ? cell.text.trim() : "";
      if (!text) fail(`${path}.${field}.text: must be a non-empty string`);
      else if (text.length > 400) fail(`${path}.${field}.text: ${text.length} characters exceeds 400`);
      out[field] = { text, quoteIds: checkQuotes(cell.quoteIds, `${path}.${field}.quoteIds`, row.paperId) };
    }
    normalized.matrix.push(out);
  });
  section("relations").forEach((relation, index) => {
    const path = `relations[${index}]`;
    if (!relation || typeof relation !== "object") return fail(`${path}: must be an object`);
    const sourceOk = checkPaper(relation.source, `${path}.source`);
    const targetOk = checkPaper(relation.target, `${path}.target`);
    if (!RELATION_TYPES.includes(relation.type)) fail(`${path}.type: ${JSON.stringify(relation.type)} is not one of ${RELATION_TYPES.join(", ")}`);
    if (sourceOk && targetOk && relation.source === relation.target) fail(`${path}: a relation must link two different papers`);
    const sourceQuoteIds = sourceOk ? checkQuotes(relation.sourceQuoteIds, `${path}.sourceQuoteIds`, relation.source) : [];
    const targetQuoteIds = targetOk ? checkQuotes(relation.targetQuoteIds, `${path}.targetQuoteIds`, relation.target) : [];
    const note = typeof relation.note === "string" ? relation.note.trim() : "";
    if (note.length > 600) fail(`${path}.note: ${note.length} characters exceeds 600`);
    if (sourceOk && targetOk && Array.isArray(packet.candidatePairs)) {
      const listed = packet.candidatePairs.some((pair) => (pair.source === relation.source && pair.target === relation.target) || (pair.source === relation.target && pair.target === relation.source));
      if (!listed) warnings.push(`${path}: ${relation.source} → ${relation.target} is not among the packet's candidatePairs`);
    }
    normalized.relations.push({ source: relation.source, target: relation.target, type: relation.type, sourceQuoteIds, targetQuoteIds, note, status: "candidate" });
  });
  section("flags").forEach((flag, index) => {
    const path = `flags[${index}]`;
    if (typeof flag === "string") {
      if (!flag.trim()) return fail(`${path}: must not be empty`);
      normalized.flags.push({ type: "other", paperIds: [], note: flag.trim().slice(0, 600) });
      return;
    }
    if (!flag || typeof flag !== "object") return fail(`${path}: must be a string or an object`);
    const type = ["duplicate", "erratum", "extraction_problem", "out_of_scope", "other"].includes(flag.type) ? flag.type : null;
    if (!type) fail(`${path}.type: ${JSON.stringify(flag.type)} is not a supported flag type`);
    const flagged = Array.isArray(flag.paperIds) ? flag.paperIds : [];
    flagged.forEach((paperId, paperIndex) => checkPaper(paperId, `${path}.paperIds[${paperIndex}]`));
    const note = typeof flag.note === "string" ? flag.note.trim() : "";
    if (note.length > 600) fail(`${path}.note: ${note.length} characters exceeds 600`);
    normalized.flags.push({ type: type ?? "other", paperIds: [...new Set(flagged)], note });
  });
  for (const paperId of paperIds) {
    if (!seenPapers.has(paperId)) warnings.push(`papers: no gist for ${paperId}`);
  }
  return { ok: errors.length === 0, errors, warnings, digest: errors.length ? null : normalized };
}
