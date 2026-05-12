import { scoreIntents, primaryIntentFrom } from './classifier';
import { detectFlags, scorePromptQuality, computeQualityScore } from './rubric';
import { extractTopicTFIDF, extractTopicsTFIDF } from './tfidf';
import { STOP_WORDS } from './stopWords';
import type { PromptIntent } from './types';

// Re-export so existing imports from engine.ts keep working
export { STOP_WORDS };

export interface LiveScore {
  overall: number;
  // The four dimensions shown in the UI
  ownership: number; // autonomy
  depth: number; // curiosity
  critical: number; // criticalThinking
  clarity: number; // specificity + context averaged
  intent: PromptIntent | 'unknown';
  flags: string[];
  suggestions: string[];
}

// ---------------------------------------------------------------------------
// Personalised suggestion builders
// Each takes the extracted topic + detected intent so the copy references
// what the user actually typed rather than generic advice.
// ---------------------------------------------------------------------------

function ownershipSuggestion(topic: string, intent: PromptIntent | 'unknown'): string {
  if (!topic) return "Share what you've already tried or thought about.";
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
  if (!topic) return "Ask 'why' or 'how' to get a deeper answer, not just a surface result.";
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
  if (!topic) return 'Ask about edge cases, risks, or alternatives to stress-test the answer.';
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
  if (!topic)
    return 'Add context: who is this for, what format do you need, what constraints apply?';
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

  // Map internal quality dimensions to UI dimensions
  const ownership = quality.autonomy;
  const depth = quality.curiosity;
  const critical = quality.criticalThinking;
  const clarity = Math.round((quality.specificity + quality.context) / 2);

  // Extract up to 3 distinct topic phrases — one per suggestion so each tip
  // references a different aspect of the prompt rather than repeating the same keyword.
  const topics = extractTopicsTFIDF(trimmed, STOP_WORDS, 3);
  const fallbackTopic = topics[0] ?? extractTopicTFIDF(trimmed, STOP_WORDS);

  // --- Weak dimension collection ---
  // Collect dimensions scoring below 60, sorted ascending so the most critical
  // issues surface first. Each gets a different topic phrase for variety.
  type DimEntry = { score: number; suggestion: string };
  const weak: DimEntry[] = [];

  if (ownership < 60)
    weak.push({
      score: ownership,
      suggestion: ownershipSuggestion(topics[0] ?? fallbackTopic, intent),
    });
  if (depth < 60)
    weak.push({ score: depth, suggestion: depthSuggestion(topics[1] ?? fallbackTopic, intent) });
  if (critical < 60)
    weak.push({
      score: critical,
      suggestion: criticalSuggestion(topics[2] ?? fallbackTopic, intent),
    });
  if (clarity < 60)
    weak.push({
      score: clarity,
      suggestion: claritySuggestion(topics[0] ?? fallbackTopic, intent),
    });

  weak.sort((a, b) => a.score - b.score);
  const suggestions = weak.slice(0, 3).map((d) => d.suggestion);

  return { overall, ownership, depth, critical, clarity, intent, flags, suggestions };
}
