import { scoreIntents, primaryIntentFrom } from './classifier';
import { detectFlags, scorePromptQuality, computeQualityScore } from './rubric';
import { extractTopicTFIDF, extractTopicsTFIDF } from './tfidf';
import type { PromptIntent } from './types';

export interface LiveScore {
  overall: number;
  // The four dimensions shown in the UI
  ownership: number;      // autonomy
  depth: number;          // curiosity
  critical: number;       // criticalThinking
  clarity: number;        // specificity + context averaged
  intent: PromptIntent | 'unknown';
  flags: string[];
  suggestions: string[];
}

// ---------------------------------------------------------------------------
// Topic extraction — delegates to TF-IDF scorer in tfidf.ts.
// Stop words are defined here (shared with rubric signals) and passed in.
// ---------------------------------------------------------------------------

export const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its',
  'this', 'that', 'these', 'those', 'and', 'or', 'but', 'so', 'yet',
  'for', 'nor', 'at', 'by', 'from', 'in', 'into', 'of', 'on', 'to',
  'up', 'with', 'about', 'as', 'if', 'then', 'than', 'because', 'while',
  'please', 'just', 'really', 'very', 'also', 'too', 'not', 'no',
  // Filler action verbs — not meaningful topic words
  'write', 'create', 'make', 'generate', 'build', 'fix', 'give', 'help',
  'explain', 'tell', 'show', 'find', 'get', 'use', 'using',
  'want', 'need', 'like', 'try', 'trying', 'let', 'go', 'put', 'set',
  'come', 'take', 'know', 'think', 'look', 'see', 'say', 'said',
  // Question words
  'what', 'why', 'how', 'when', 'where', 'who', 'which',
]);

function extractTopic(text: string): string {
  return extractTopicTFIDF(text, STOP_WORDS);
}

// ---------------------------------------------------------------------------
// Personalised suggestion builders — each takes the topic + intent so the
// copy references what the user actually typed.
// ---------------------------------------------------------------------------

function ownershipSuggestion(topic: string, intent: PromptIntent | 'unknown'): string {
  if (!topic) {
    return "Share what you've already tried or thought about.";
  }
  switch (intent) {
    case 'delegation':
      return `What have you already tried for "${topic}"? Share it so the answer builds on your work.`;
    case 'curiosity':
      return `What's your current understanding of "${topic}"? Starting there leads to a sharper answer.`;
    case 'collaborative':
      return `What's your instinct on "${topic}"? Your take makes the collaboration more useful.`;
    case 'verification':
      return `Walk through your reasoning on "${topic}" — it helps pinpoint exactly where things go wrong.`;
    default:
      return `What have you already tried or considered about "${topic}"?`;
  }
}

function depthSuggestion(topic: string, intent: PromptIntent | 'unknown'): string {
  if (!topic) {
    return "Ask 'why' or 'how' to get a deeper answer, not just a surface result.";
  }
  switch (intent) {
    case 'delegation':
      return `Ask why "${topic}" works the way it does — you'll understand the output, not just receive it.`;
    case 'curiosity':
      return `Push further on "${topic}" — what underlying mechanism or principle are you really after?`;
    case 'collaborative':
      return `Dig into the 'why' behind "${topic}" — that's where the interesting tradeoffs live.`;
    case 'verification':
      return `Ask how "${topic}" should behave, not just whether it's correct — that surfaces the real issue.`;
    default:
      return `Ask 'why' or 'how' about "${topic}" to go beyond a surface answer.`;
  }
}

function criticalSuggestion(topic: string, intent: PromptIntent | 'unknown'): string {
  if (!topic) {
    return "Ask about edge cases, risks, or alternatives to stress-test the answer.";
  }
  switch (intent) {
    case 'delegation':
      return `Ask what could go wrong with "${topic}", or request an alternative approach.`;
    case 'curiosity':
      return `Ask what the limits or exceptions are for "${topic}" — that's where real understanding lives.`;
    case 'collaborative':
      return `Challenge the assumption — what's the strongest argument against "${topic}"?`;
    case 'verification':
      return `Ask what edge cases or failure modes exist for "${topic}", not just whether it passes the happy path.`;
    default:
      return `Ask about risks, edge cases, or alternatives for "${topic}".`;
  }
}

function claritySuggestion(topic: string, intent: PromptIntent | 'unknown'): string {
  if (!topic) {
    return "Add context: who is this for, what format do you need, what constraints apply?";
  }
  switch (intent) {
    case 'delegation':
      return `Specify the constraints for "${topic}" — audience, format, length, or tech stack.`;
    case 'curiosity':
      return `Narrow the scope of "${topic}" — what specific aspect or use case are you curious about?`;
    case 'collaborative':
      return `Set the frame for "${topic}" — what decision are you trying to make, and what matters most?`;
    case 'verification':
      return `Describe the expected behaviour for "${topic}" so the review has a clear target.`;
    default:
      return `Add context to "${topic}": who is this for, what constraints apply?`;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a single prompt in real-time as the user types.
 */
export function analyzePrompt(text: string): LiveScore {
  const trimmed = text.trim();

  if (trimmed.length < 5) {
    return {
      overall: 0,
      ownership: 0,
      depth: 0,
      critical: 0,
      clarity: 0,
      intent: 'unknown',
      flags: [],
      suggestions: ['Start typing your prompt...'],
    };
  }

  const intentScores = scoreIntents(trimmed);
  const intent = primaryIntentFrom(intentScores, trimmed);
  const flags = detectFlags(trimmed);
  const quality = scorePromptQuality(trimmed, flags, intent);
  const overall = computeQualityScore(quality, intent);

  // Map to UI dimensions
  const ownership = quality.autonomy;
  const depth     = quality.curiosity;
  const critical  = quality.criticalThinking;
  const clarity   = Math.round((quality.specificity + quality.context) / 2);

  // Extract up to 3 distinct topic phrases from the prompt — one per suggestion
  // so each tip references a different aspect rather than all repeating the same keyword.
  const topics = extractTopicsTFIDF(trimmed, STOP_WORDS, 3);
  const topic = topics[0] ?? extractTopic(trimmed); // fallback for single-topic use

  // Build personalised suggestions for the weakest dimensions.
  // Collect all weak dims sorted by score ascending so the most critical
  // issues surface first.
  type DimEntry = { score: number; suggestion: string };
  const weak: DimEntry[] = [];

  if (ownership < 60) weak.push({ score: ownership, suggestion: ownershipSuggestion(topics[0] ?? topic, intent) });
  if (depth     < 60) weak.push({ score: depth,     suggestion: depthSuggestion(topics[1] ?? topic, intent) });
  if (critical  < 60) weak.push({ score: critical,  suggestion: criticalSuggestion(topics[2] ?? topic, intent) });
  if (clarity   < 60) weak.push({ score: clarity,   suggestion: claritySuggestion(topics[0] ?? topic, intent) });

  weak.sort((a, b) => a.score - b.score);
  const suggestions = weak.slice(0, 3).map(d => d.suggestion);

  return {
    overall,
    ownership,
    depth,
    critical,
    clarity,
    intent,
    flags,
    suggestions,
  };
}
