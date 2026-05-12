import type { PromptIntent, QualityScores } from './types';

const LEARNING_INTENT_SIGNALS = [
  'explain', 'why', 'walk me through', 'teach me', 'so i understand',
  'reasoning', 'rationale',
];

const PRIOR_ATTEMPT_SIGNALS = [
  'i tried', 'my attempt', "here's what i have", 'here is what i have',
  'i think', 'my reasoning', 'i got', 'i believe', 'my solution',
  'this is my code', 'here is my code', "here's my code",
];

const REASONING_REQUEST_SIGNALS = [
  'explain your reasoning', 'why', 'walk me through', 'step by step',
  'how did you get', 'what is the logic', 'rationale', 'reasoning',
];

const ALTERNATIVES_SIGNALS = [
  'alternative', 'another way', 'compare', 'tradeoffs', 'pros and cons',
  'which is better', 'different approach', 'options',
];

const RISK_SIGNALS = [
  'what could go wrong', 'limitations', 'edge cases', 'assumptions', 'risks',
  'counterargument', 'weaknesses', 'failure cases', 'downside',
];

const FOLLOW_UP_SIGNALS = [
  'now', 'what about', 'also', 'can you adjust', 'instead', 'then',
  'based on that',
];

export const CONTEXT_SIGNALS = [
  'constraints', 'requirements', 'audience', 'format', 'rubric', 'example',
  'goal', 'context', 'background', 'best practices', 'behavior', 'behaviour',
  'use case', 'scenario', 'criteria',
];

const BARE_DELEGATION_PHRASES = [
  'make it better', 'fix it', 'do it', 'make it shorter', 'make it longer',
  'make it more', 'make it less',
];

function hasAny(lower: string, signals: string[]): boolean {
  return signals.some((s) => lower.includes(s));
}

// ---------------------------------------------------------------------------
// Intent excellence scoring
//
// Each intent has a set of signals that define what doing it *well* looks like.
// We count how many excellence signals the prompt hits, then apply a graduated
// bonus to the dimensions that matter most for that intent.
//
// This replaces ad-hoc per-scenario boosts with a general principle:
// "the better you play to your intent, the higher your relevant scores."
// ---------------------------------------------------------------------------

interface ExcellenceResult {
  /** 0–1 ratio of excellence signals hit vs total possible for this intent */
  ratio: number;
  /** Flat bonus points to apply to each dimension key */
  bonuses: Partial<Record<keyof QualityScores, number>>;
}

function scoreIntentExcellence(
  lower: string,
  flags: string[],
  intent: PromptIntent,
  wordCount: number,
): ExcellenceResult {
  let hits = 0;
  let total = 0;
  const bonuses: Partial<Record<keyof QualityScores, number>> = {};

  if (intent === 'delegation') {
    // Excellence signals for delegation: clear role/task framing, constraints,
    // format spec, risk/edge case request, sufficient length, audience spec.
    total = 6;
    if (lower.includes('you are') || lower.includes('your task') || lower.includes('your role') || lower.includes('act as')) hits++;
    if (hasAny(lower, CONTEXT_SIGNALS)) hits++;
    if (lower.includes('format') || lower.includes('bullet') || lower.includes('section') || lower.includes('table') || lower.includes('step')) hits++;
    if (flags.includes('asks_for_risk_or_limitations')) hits++;
    if (wordCount >= 40) hits++;
    if (lower.includes('audience') || lower.includes('solo') || lower.includes('team') || lower.includes('beginner') || lower.includes('expert') || lower.includes('developer') || lower.includes('non-technical')) hits++;

    // Reward dimensions that matter for delegation excellence
    const bonus = Math.round((hits / total) * 25);
    bonuses.autonomy = bonus;
    bonuses.criticalThinking = Math.round(bonus * 0.8);
    bonuses.specificity = Math.round(bonus * 0.8);
    bonuses.context = Math.round(bonus * 0.8);

  } else if (intent === 'curiosity') {
    // Excellence signals for curiosity: asks why/how, probes mechanisms,
    // shows prior understanding, scopes the question, asks for examples.
    total = 5;
    if (lower.includes('why') || lower.includes('how does') || lower.includes('how do') || lower.includes('what causes')) hits++;
    if (lower.includes('underlying') || lower.includes('mechanism') || lower.includes('principle') || lower.includes('concept') || lower.includes('theory')) hits++;
    if (flags.includes('shows_prior_attempt') || lower.includes('i understand') || lower.includes('i know') || lower.includes('i thought')) hits++;
    if (lower.includes('specifically') || lower.includes('in the context') || lower.includes('when') || lower.includes('scenario')) hits++;
    if (lower.includes('example') || lower.includes('for instance') || lower.includes('such as')) hits++;

    const bonus = Math.round((hits / total) * 25);
    bonuses.curiosity = bonus;
    bonuses.autonomy = Math.round(bonus * 0.6);

  } else if (intent === 'collaborative') {
    // Excellence signals for collaborative: shares own view, invites pushback,
    // frames a decision, acknowledges tradeoffs, asks for opinion.
    total = 5;
    if (lower.includes('i think') || lower.includes('i believe') || lower.includes('my view') || lower.includes('in my opinion')) hits++;
    if (lower.includes('do you agree') || lower.includes('push back') || lower.includes('challenge') || lower.includes('disagree')) hits++;
    if (lower.includes('deciding') || lower.includes('decision') || lower.includes('choose') || lower.includes('should i')) hits++;
    if (flags.includes('asks_for_alternatives') || lower.includes('tradeoff') || lower.includes('pros and cons')) hits++;
    if (lower.includes('what would you') || lower.includes('your opinion') || lower.includes('your thoughts') || lower.includes('your take')) hits++;

    const bonus = Math.round((hits / total) * 25);
    bonuses.autonomy = bonus;
    bonuses.curiosity = Math.round(bonus * 0.8);
    bonuses.criticalThinking = Math.round(bonus * 0.6);

  } else if (intent === 'verification') {
    // Excellence signals for verification: shares the artifact, states expected
    // behaviour, asks about edge cases, provides context for the review.
    total = 5;
    if (flags.includes('shows_prior_attempt') || lower.includes('here is') || lower.includes("here's") || lower.includes('attached') || lower.includes('below')) hits++;
    if (lower.includes('should') || lower.includes('expected') || lower.includes('supposed to') || lower.includes('correct behaviour')) hits++;
    if (flags.includes('asks_for_risk_or_limitations') || lower.includes('edge case') || lower.includes('miss') || lower.includes('overlook')) hits++;
    if (hasAny(lower, CONTEXT_SIGNALS)) hits++;
    if (lower.includes('specifically') || lower.includes('in particular') || lower.includes('focus on')) hits++;

    const bonus = Math.round((hits / total) * 25);
    bonuses.autonomy = bonus;
    bonuses.criticalThinking = bonus;
    bonuses.specificity = Math.round(bonus * 0.6);
  }

  return { ratio: total > 0 ? hits / total : 0, bonuses };
}

export function detectFlags(text: string): string[] {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const flags: string[] = [];

  if (hasAny(lower, LEARNING_INTENT_SIGNALS))   flags.push('delegation_with_learning_intent');
  if (hasAny(lower, PRIOR_ATTEMPT_SIGNALS))      flags.push('shows_prior_attempt');
  if (hasAny(lower, REASONING_REQUEST_SIGNALS))  flags.push('asks_for_reasoning');
  if (hasAny(lower, ALTERNATIVES_SIGNALS))       flags.push('asks_for_alternatives');
  if (hasAny(lower, RISK_SIGNALS))               flags.push('asks_for_risk_or_limitations');
  if (hasAny(lower, FOLLOW_UP_SIGNALS))          flags.push('follow_up_signal');
  if (hasAny(lower, BARE_DELEGATION_PHRASES))    flags.push('bare_delegation_no_context');

  // copy_paste_without_question fires for any long unstructured text regardless
  // of intent — a curiosity prompt can also be a raw paste dump.
  const hasStructureSignals =
    hasAny(lower, RISK_SIGNALS) ||
    hasAny(lower, ALTERNATIVES_SIGNALS) ||
    hasAny(lower, LEARNING_INTENT_SIGNALS) ||
    hasAny(lower, CONTEXT_SIGNALS) ||
    lower.includes('you are') || lower.includes('your task') ||
    lower.includes('your role') || lower.includes('act as') ||
    lower.includes('format') || lower.includes('bullet') || lower.includes('section');
  if (wordCount > 100 && !text.includes('?') && !hasStructureSignals) {
    flags.push('copy_paste_without_question');
  }

  return flags;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function scorePromptQuality(
  text: string,
  flags: string[],
  intent: PromptIntent,
): QualityScores {
  const lower = text.toLowerCase();
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  const isShort  = wordCount < 10;
  const isMedium = wordCount >= 10 && wordCount < 20;

  let autonomy        = isShort ? 25 : isMedium ? 35 : 45;
  let curiosity       = isShort ? 25 : isMedium ? 35 : 45;
  let criticalThinking = isShort ? 25 : isMedium ? 35 : 45;
  let specificity     = isShort ? 15 : isMedium ? 25 : 35;
  let context         = isShort ? 15 : isMedium ? 25 : 35;
  const iteration = 50;

  if (flags.includes('delegation_with_learning_intent')) {
    autonomy += 10; curiosity += 15; criticalThinking += 10;
  }
  if (flags.includes('shows_prior_attempt')) {
    autonomy += 25; context += 10; specificity += 10;
  }
  if (flags.includes('asks_for_reasoning')) {
    curiosity += 20; criticalThinking += 10;
  }
  if (flags.includes('asks_for_alternatives')) {
    criticalThinking += 15; curiosity += 10;
  }
  if (flags.includes('asks_for_risk_or_limitations')) {
    criticalThinking += 25; autonomy += 10;
  }

  if (intent === 'verification')  { criticalThinking += 15; }
  if (intent === 'collaborative') { autonomy += 10; criticalThinking += 10; }
  // Curiosity boost is reduced for short prompts — a one-liner "why is X weird?"
  // shows intent but not depth; the full boost requires some context.
  if (intent === 'curiosity') {
    curiosity += wordCount >= 15 ? 15 : 5;
  }

  // Context signal check — scan the first 40% of the text (setup/framing region).
  // Signals buried deep in a paste body are incidental, not intentional framing.
  const firstPart = lower.slice(0, Math.ceil(lower.length * 0.4));
  if (CONTEXT_SIGNALS.some((s) => firstPart.includes(s))) {
    specificity += 18; context += 18;
  }

  if (wordCount >= 20 && wordCount <= 120) { specificity += 10; }
  if (wordCount < 6)  { specificity -= 25; context -= 20; }
  if (wordCount > 120 && !text.includes('?') && intent === 'delegation') {
    const hasStructure = flags.includes('asks_for_risk_or_limitations') ||
      flags.includes('asks_for_alternatives') ||
      flags.includes('delegation_with_learning_intent') ||
      CONTEXT_SIGNALS.some((s) => firstPart.includes(s));
    if (!hasStructure) {
      curiosity -= 15; autonomy -= 10;
    }
  }

  if (intent === 'delegation' && wordCount < 15) {
    // Soften penalty if the prompt at least names a specific topic/technology
    // (word count 6-14 with some content is a basic but valid ask)
    const hasTopic = wordCount >= 6;
    autonomy -= hasTopic ? 15 : 25;
    curiosity -= hasTopic ? 10 : 15;
    criticalThinking -= 10;
  }
  if (flags.includes('copy_paste_without_question')) {
    autonomy -= 15; curiosity -= 15;
  }
  if (flags.includes('bare_delegation_no_context') && wordCount < 15) {
    specificity -= 25; autonomy -= 15;
  }

  if (
    wordCount < 10 &&
    !flags.includes('shows_prior_attempt') &&
    !flags.includes('asks_for_reasoning') &&
    !flags.includes('delegation_with_learning_intent')
  ) {
    specificity -= 10; context -= 10;
  }

  if (!text.includes('?')) { curiosity -= 10; specificity -= 5; }

  if (wordCount <= 4 && flags.length === 0) {
    autonomy -= 15; curiosity -= 15; criticalThinking -= 15;
    specificity -= 15; context -= 15;
  }
  if (wordCount <= 1) {
    autonomy -= 20; curiosity -= 20; criticalThinking -= 20;
    specificity -= 20; context -= 20;
  }

  if (
    intent === 'delegation' &&
    !flags.includes('delegation_with_learning_intent') &&
    !flags.includes('shows_prior_attempt') &&
    !flags.includes('asks_for_reasoning') &&
    wordCount < 10 &&
    wordCount < 6  // only fire for truly minimal prompts (1-5 words), not basic asks
  ) {
    autonomy -= 15; curiosity -= 10;
  }

  if (
    wordCount >= 5 &&
    !CONTEXT_SIGNALS.some((s) => firstPart.includes(s)) &&
    !flags.includes('shows_prior_attempt')
  ) {
    context -= 10; specificity -= 5;
  }

  // Apply intent excellence bonuses — rewards prompts that play strongly
  // to their detected intent rather than one-off scenario boosts.
  const excellence = scoreIntentExcellence(lower, flags, intent, wordCount);
  if (excellence.bonuses.autonomy)        autonomy        += excellence.bonuses.autonomy;
  if (excellence.bonuses.curiosity)       curiosity       += excellence.bonuses.curiosity;
  if (excellence.bonuses.criticalThinking) criticalThinking += excellence.bonuses.criticalThinking;
  if (excellence.bonuses.specificity)     specificity     += excellence.bonuses.specificity;
  if (excellence.bonuses.context)         context         += excellence.bonuses.context;

  // For high-excellence prompts, lift the no-? curiosity penalty — a prompt
  // that nails its intent doesn't need question marks to prove depth.
  if (excellence.ratio >= 0.6 && !text.includes('?')) {
    curiosity += 10; // restore most of the -10 penalty
  }

  return {
    autonomy:        clamp(autonomy),
    curiosity:       clamp(curiosity),
    criticalThinking: clamp(criticalThinking),
    specificity:     clamp(specificity),
    context:         clamp(context),
    iteration,
  };
}

export function computeQualityScore(q: QualityScores, intent?: PromptIntent): number {
  // Exclude iteration from the real-time score since it's fixed at 50.
  // Weight dimensions by intent — delegation prompts are judged more on
  // ownership and specificity/context than on curiosity (depth).
  if (intent === 'delegation') {
    return Math.round(
      q.autonomy        * 0.30 +
      q.curiosity       * 0.15 +
      q.criticalThinking * 0.25 +
      q.specificity     * 0.15 +
      q.context         * 0.15,
    );
  }
  if (intent === 'curiosity') {
    return Math.round(
      q.autonomy        * 0.20 +
      q.curiosity       * 0.30 +
      q.criticalThinking * 0.20 +
      q.specificity     * 0.15 +
      q.context         * 0.15,
    );
  }
  // Default: equal weights
  return Math.round(
    (q.autonomy + q.curiosity + q.criticalThinking + q.specificity + q.context) / 5,
  );
}
