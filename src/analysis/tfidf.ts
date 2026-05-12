// ---------------------------------------------------------------------------
// Lightweight TF-IDF topic extraction for single prompts.
//
// Classic TF-IDF adapted for prompt analysis:
//
//   TF  — within a single short prompt, raw frequency is mostly 1 for every
//          word. Instead we use a POSITION weight: words appearing after the
//          command verb (second half of the prompt) are slightly preferred
//          because they tend to be the object/topic rather than the intent.
//
//   IDF — we have no live corpus, so we substitute a pre-computed English
//          word-frequency rank table. High-rank (common) words get low IDF;
//          low-rank (rare/specific) words get high IDF. Words absent from the
//          table are assumed rare and get the maximum IDF score.
//
// On top of raw TF-IDF we apply two domain boosts:
//   • TECHNICAL_BOOST  — programming languages, frameworks, acronyms, and
//                        hyphenated/camelCase tokens are almost always the
//                        real subject of an AI prompt.
//   • QUALIFIER_PENALTY — trailing qualifiers ("quickly", "detail", "simple")
//                         are down-weighted so they don't crowd out the topic.
//
// Tunable constants are exported so callers can experiment.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

/** Weight applied to words in the second half of the prompt (position boost). */
export const POSITION_WEIGHT = 1.3;

/** Multiplier for words that look like technical terms. */
export const TECHNICAL_BOOST = 2.0;

/** Multiplier for common trailing qualifiers. */
export const QUALIFIER_PENALTY = 0.4;

/** IDF score assigned to words not found in the frequency table (assumed rare). */
export const UNKNOWN_WORD_IDF = 10.0;

/** Maximum number of words to include in the extracted topic phrase. */
export const MAX_TOPIC_WORDS = 3;

// ---------------------------------------------------------------------------
// English word frequency table — IDF proxy.
// Values are approximate IDF scores derived from word frequency ranks.
// Higher = rarer = more topic-worthy.
// Common function words are handled by the stop-word list in engine.ts;
// this table covers content words that slip through.
// ---------------------------------------------------------------------------

// Format: word → IDF score (1.0 = very common, 10.0 = rare/specific)
const WORD_IDF: Record<string, number> = {
  // Very common content words — low IDF
  thing: 1.2,
  things: 1.2,
  way: 1.3,
  ways: 1.3,
  time: 1.3,
  times: 1.3,
  people: 1.4,
  person: 1.4,
  place: 1.4,
  part: 1.4,
  point: 1.4,
  work: 1.5,
  works: 1.5,
  working: 1.5,
  good: 1.5,
  best: 1.5,
  better: 1.5,
  new: 1.5,
  old: 1.5,
  different: 1.6,
  same: 1.5,
  other: 1.5,
  number: 1.6,
  type: 1.6,
  types: 1.6,
  kind: 1.6,
  kinds: 1.6,
  example: 1.7,
  examples: 1.7,
  case: 1.7,
  cases: 1.7,
  information: 1.7,
  data: 1.8,
  result: 1.7,
  results: 1.7,
  problem: 1.8,
  problems: 1.8,
  solution: 1.8,
  solutions: 1.8,
  question: 1.7,
  answer: 1.7,
  idea: 1.7,
  ideas: 1.7,
  step: 1.7,
  steps: 1.7,
  process: 1.8,
  method: 1.8,
  methods: 1.8,
  system: 1.8,
  systems: 1.8,
  model: 1.9,
  models: 1.9,
  simple: 1.5,
  basic: 1.5,
  general: 1.5,
  specific: 1.6,
  detail: 1.6,
  quick: 1.5,
  fast: 1.5,
  easy: 1.5,
  hard: 1.5,
  complex: 1.7,
  short: 1.5,
  long: 1.5,
  small: 1.5,
  large: 1.5,
  big: 1.5,
  important: 1.6,
  useful: 1.6,
  common: 1.6,
  popular: 1.6,
  current: 1.6,
  recent: 1.6,
  modern: 1.7,
  latest: 1.6,
  real: 1.5,
  actual: 1.5,
  possible: 1.6,
  available: 1.6,

  // Mid-range — moderate IDF
  code: 2.5,
  function: 2.5,
  class: 2.5,
  object: 2.5,
  variable: 2.6,
  array: 2.6,
  string: 2.5,
  number_type: 2.5,
  boolean: 2.8,
  file: 2.3,
  files: 2.3,
  folder: 2.4,
  directory: 2.6,
  server: 2.5,
  client: 2.5,
  database: 2.7,
  query: 2.7,
  request: 2.5,
  response: 2.5,
  error: 2.4,
  bug: 2.6,
  test: 2.4,
  component: 2.7,
  module: 2.6,
  package: 2.6,
  library: 2.6,
  algorithm: 3.0,
  structure: 2.7,
  pattern: 2.7,
  design: 2.5,
  performance: 2.8,
  security: 2.8,
  authentication: 3.2,
  authorization: 3.2,
  interface: 2.7,
  implementation: 2.8,
  architecture: 3.0,
  list: 2.0,
  table: 2.2,
  chart: 2.4,
  graph: 2.5,
  tree: 2.5,
  email: 2.3,
  message: 2.3,
  text: 2.2,
  document: 2.4,
  report: 2.4,
  image: 2.3,
  video: 2.4,
  audio: 2.5,
  format: 2.4,
  user: 2.2,
  users: 2.2,
  account: 2.4,
  profile: 2.5,
  role: 2.4,
  page: 2.2,
  site: 2.3,
  app: 2.3,
  application: 2.5,
  website: 2.4,
  feature: 2.5,
  functionality: 2.8,
  requirement: 2.8,
  language: 2.5,
  framework: 2.8,
  tool: 2.3,
  tools: 2.3,
  concept: 2.6,
  theory: 2.7,
  principle: 2.7,
  rule: 2.4,
  rules: 2.4,
  strategy: 2.8,
  approach: 2.6,
  technique: 2.8,
  practice: 2.6,
  difference: 2.5,
  comparison: 2.7,
  alternative: 2.7,
  option: 2.4,
  benefit: 2.5,
  advantage: 2.6,
  disadvantage: 2.7,
  tradeoff: 3.0,
  risk: 2.6,
  issue: 2.4,
  challenge: 2.6,
  limitation: 2.8,
  cause: 2.5,
  effect: 2.5,
  impact: 2.6,
  reason: 2.4,
  history: 2.5,
  background: 2.5,
  context: 2.5,
  overview: 2.5,
  summary: 2.5,
  introduction: 2.5,
  explanation: 2.6,
  description: 2.5,
  analysis: 2.8,
  review: 2.5,
  evaluation: 2.8,
  assessment: 2.8,
  plan: 2.4,
  goal: 2.5,
  objective: 2.7,
  purpose: 2.5,
  project: 2.5,
  task: 2.4,
  job: 2.3,
  role_noun: 2.5,
  team: 2.4,
  company: 2.4,
  business: 2.5,
  industry: 2.6,
  science: 2.7,
  research: 2.7,
  study: 2.6,
  experiment: 2.8,
  math: 2.7,
  physics: 3.0,
  chemistry: 3.0,
  biology: 3.0,
  health: 2.6,
  medical: 2.8,
  legal: 2.8,
  financial: 2.8,
  social: 2.5,
  political: 2.7,
  economic: 2.7,
  cultural: 2.7,
  environment: 2.7,
  climate: 2.8,
  energy: 2.7,
  technology: 2.6,

  // High IDF — specific/technical (these are just seeds; unknown words default to UNKNOWN_WORD_IDF)
  typescript: 4.5,
  javascript: 4.5,
  python: 4.5,
  rust: 4.5,
  golang: 4.5,
  react: 4.5,
  vue: 4.5,
  angular: 4.5,
  svelte: 4.5,
  nextjs: 4.5,
  nodejs: 4.5,
  express: 4.0,
  fastapi: 4.5,
  django: 4.5,
  flask: 4.5,
  postgresql: 4.8,
  mysql: 4.5,
  mongodb: 4.5,
  redis: 4.5,
  sqlite: 4.5,
  docker: 4.5,
  kubernetes: 4.8,
  aws: 4.5,
  gcp: 4.5,
  azure: 4.5,
  graphql: 4.8,
  rest: 3.5,
  api: 3.5,
  oauth: 4.8,
  jwt: 4.8,
  regex: 4.5,
  recursion: 4.5,
  async: 4.0,
  promise: 3.8,
  callback: 4.0,
  webpack: 4.5,
  vite: 4.5,
  eslint: 4.5,
  prettier: 4.5,
  photosynthesis: 5.0,
  mitochondria: 5.0,
  quantum: 5.0,
  neural: 4.5,
  blockchain: 4.8,
  cryptocurrency: 4.8,
  bitcoin: 4.8,
  renaissance: 5.0,
  byzantine: 5.0,
  mesopotamia: 5.0,
};

// ---------------------------------------------------------------------------
// Trailing qualifiers — penalised so they don't surface as the topic
// ---------------------------------------------------------------------------

const QUALIFIERS = new Set([
  'quickly',
  'fast',
  'simple',
  'simply',
  'easy',
  'easily',
  'brief',
  'briefly',
  'detailed',
  'detail',
  'details',
  'thorough',
  'thoroughly',
  'clear',
  'clearly',
  'concise',
  'concisely',
  'comprehensive',
  'complete',
  'completely',
  'accurate',
  'correct',
  'proper',
  'properly',
  'correct',
  'correctly',
  'professional',
  'formal',
  'informal',
  'casual',
  'friendly',
  'short',
  'long',
  'small',
  'large',
  'big',
  'full',
  'partial',
  'modern',
  'latest',
  'current',
  'recent',
  'updated',
  'new',
  'old',
  'basic',
  'advanced',
  'beginner',
  'expert',
  'intermediate',
  'please',
  'thanks',
  'thank',
]);

// ---------------------------------------------------------------------------
// Technical term detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the word looks like a technical term:
 * - All-caps acronym (API, SQL, JWT)
 * - camelCase or PascalCase (useState, MyClass)
 * - Contains digits mixed with letters (ES2022, GPT4)
 * - Hyphenated compound (type-safe, end-to-end)
 * - Known technical word in the IDF table with score >= 3.5
 */
function isTechnical(word: string, original: string): boolean {
  if (/^[A-Z]{2,}$/.test(original)) return true; // acronym
  if (/[a-z][A-Z]/.test(original)) return true; // camelCase
  if (/[A-Z][a-z]/.test(original) && original.length > 3) return true; // PascalCase
  if (/[a-zA-Z]\d|\d[a-zA-Z]/.test(original)) return true; // alphanumeric mix
  if (original.includes('-') && original.length > 4) return true; // hyphenated
  const idf = WORD_IDF[word];
  return idf !== undefined && idf >= 3.5;
}

// ---------------------------------------------------------------------------
// Span building + scoring (shared by both exports)
// ---------------------------------------------------------------------------

interface Span {
  words: string[];
  avgScore: number;
  startIdx: number;
  endIdx: number;
}

function buildSpans(text: string, stopWords: Set<string>): Span[] {
  const rawWords = text.split(/\s+/).filter(Boolean);
  const totalWords = rawWords.length;

  const tokens = rawWords.map((original, rawIdx) => {
    const lower = original.replace(/[^\w-]/g, '').toLowerCase();
    const isStop = lower.length <= 1 || stopWords.has(lower);
    return { original: original.replace(/[^\w\s-]/g, ''), lower, rawIdx, isStop };
  });

  function scoreToken(lower: string, original: string, rawIdx: number): number {
    const idf = WORD_IDF[lower] ?? UNKNOWN_WORD_IDF;
    const positionInPrompt = rawIdx / Math.max(totalWords - 1, 1);
    let tf = 1.0;
    if (positionInPrompt > 0.5) tf *= POSITION_WEIGHT;
    if (positionInPrompt < 0.25) tf *= 0.85;
    let boost = 1.0;
    if (isTechnical(lower, original)) boost *= TECHNICAL_BOOST;
    if (QUALIFIERS.has(lower)) boost *= QUALIFIER_PENALTY;
    return tf * idf * boost;
  }

  const spans: Span[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].isStop) {
      i++;
      continue;
    }

    const spanTokens: typeof tokens = [];
    let j = i;
    while (j < tokens.length && !tokens[j].isStop && spanTokens.length < MAX_TOPIC_WORDS) {
      spanTokens.push(tokens[j]);
      j++;
    }

    for (let len = 1; len <= spanTokens.length; len++) {
      const slice = spanTokens.slice(0, len);
      const scores = slice.map((t) => scoreToken(t.lower, t.original, t.rawIdx));
      const avgScore = scores.reduce((s, v) => s + v, 0) / scores.length;
      spans.push({
        words: slice.map((t) => t.original),
        avgScore,
        startIdx: slice[0].rawIdx,
        endIdx: slice[slice.length - 1].rawIdx,
      });
    }

    i = j === i ? i + 1 : j;
  }

  return spans;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract the single best topic phrase from a prompt.
 * Returns a capitalised phrase or '' if nothing meaningful is found.
 */
export function extractTopicTFIDF(text: string, stopWords: Set<string>): string {
  const spans = buildSpans(text, stopWords);
  if (spans.length === 0) return '';
  spans.sort((a, b) => b.avgScore - a.avgScore);
  const best = spans[0].words.join(' ');
  return best.charAt(0).toUpperCase() + best.slice(1);
}

/**
 * Extract up to `n` distinct, non-overlapping topic phrases ranked by score.
 * Each phrase comes from a different part of the prompt so suggestions feel
 * varied rather than all referencing the same keyword.
 * Falls back to repeating the best topic if fewer than n spans exist.
 */
export function extractTopicsTFIDF(text: string, stopWords: Set<string>, n: number): string[] {
  const spans = buildSpans(text, stopWords);
  if (spans.length === 0) return [];

  spans.sort((a, b) => b.avgScore - a.avgScore);

  const chosen: Span[] = [];
  const usedIndices = new Set<number>();

  for (const span of spans) {
    if (chosen.length >= n) break;
    // Skip if any token in this span overlaps with an already-chosen span
    const overlaps = Array.from(
      { length: span.endIdx - span.startIdx + 1 },
      (_, k) => span.startIdx + k
    ).some((idx) => usedIndices.has(idx));
    if (overlaps) continue;

    chosen.push(span);
    for (let idx = span.startIdx; idx <= span.endIdx; idx++) usedIndices.add(idx);
  }

  const phrases = chosen.map((s) => {
    const p = s.words.join(' ');
    return p.charAt(0).toUpperCase() + p.slice(1);
  });

  // Pad with the best phrase if we didn't find enough distinct spans
  while (phrases.length < n) phrases.push(phrases[0] ?? '');

  return phrases;
}
