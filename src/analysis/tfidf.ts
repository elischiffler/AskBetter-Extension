// ---------------------------------------------------------------------------
// Lightweight TF-IDF topic extraction for single prompts.
//
// Classic TF-IDF adapted for prompt analysis:
//
//   TF  — within a single short prompt, raw frequency is mostly 1 for every
//          word. Instead we use a POSITION weight: words appearing in the
//          second half of the prompt are slightly preferred because they tend
//          to be the object/topic rather than the intent verb.
//
//   IDF — we have no live corpus, so we substitute a pre-computed English
//          word-frequency rank table (idfTable.ts). High-rank (common) words
//          get low IDF; low-rank (rare/specific) words get high IDF. Words
//          absent from the table are assumed rare and get UNKNOWN_WORD_IDF.
//
// On top of raw TF-IDF we apply two domain boosts:
//   • TECHNICAL_BOOST   — programming languages, frameworks, acronyms, and
//                         hyphenated/camelCase tokens are almost always the
//                         real subject of an AI prompt.
//   • QUALIFIER_PENALTY — trailing qualifiers ("quickly", "detail", "simple")
//                         are down-weighted so they don't crowd out the topic.
//
// Tunable constants are exported so callers can experiment.
// ---------------------------------------------------------------------------

import { WORD_IDF } from './idfTable';

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
// Token scoring — pure function, no closure state
// ---------------------------------------------------------------------------

function scoreToken(lower: string, original: string, rawIdx: number, totalWords: number): number {
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

// ---------------------------------------------------------------------------
// Span building — finds all contiguous non-stop-word sequences
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

  const spans: Span[] = [];
  let i = 0;

  while (i < tokens.length) {
    if (tokens[i].isStop) {
      i++;
      continue;
    }

    // Collect a run of non-stop tokens up to MAX_TOPIC_WORDS
    const spanTokens: typeof tokens = [];
    let j = i;
    while (j < tokens.length && !tokens[j].isStop && spanTokens.length < MAX_TOPIC_WORDS) {
      spanTokens.push(tokens[j]);
      j++;
    }

    // Emit every prefix length of this run as a candidate span
    for (let len = 1; len <= spanTokens.length; len++) {
      const slice = spanTokens.slice(0, len);
      const scores = slice.map((t) => scoreToken(t.lower, t.original, t.rawIdx, totalWords));
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
 * Returns a capitalised phrase, or '' if nothing meaningful is found.
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
