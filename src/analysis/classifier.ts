import type { PromptIntent, IntentScores } from './types';

const DELEGATION_SIGNALS = [
  'write', 'create', 'make', 'generate', 'build', 'fix', 'do ', 'give me',
  'produce', 'draft', 'code', 'implement', 'design', 'list', 'summarize',
  'translate', 'convert', 'format', 'rewrite', 'edit', 'update', 'add',
  'remove', 'delete', 'find me', 'show me', 'tell me', 'send', 'calculate',
  // 'explain' is a task verb in delegation contexts ("explain why X occurs",
  // "explain the reasoning") — more common as a deliverable request than as
  // a pure curiosity signal, so it lives here instead of CURIOSITY_SIGNALS.
  'explain', 'analyze', 'identify', 'review', 'suggest', 'provide',
];

const CURIOSITY_SIGNALS = [
  'why', 'how does', 'how do', 'what if', 'what would happen',
  'help me understand', 'what is', "what's", 'how come', 'could you explain',
  'i wonder', 'curious', 'what causes', 'what makes', 'how would',
  'what happens when', 'can you explain', 'walk me through',
];

const COLLABORATIVE_SIGNALS = [
  'what do you think', "let's", 'brainstorm', 'help me think', 'what about',
  'should i', 'i think', 'do you agree', 'what would you suggest',
  'help me decide', 'which is better', 'pros and cons', 'compare', 'tradeoffs',
  'help me figure out', 'together', 'collaborate', 'your opinion',
  'your thoughts', 'what would you do',
];

const VERIFICATION_SIGNALS = [
  'is this correct', 'check', 'review', 'does this make sense', 'verify',
  'am i right', 'is this right', 'is this good', 'does this work',
  'is this accurate', 'validate', 'confirm', 'look over', 'proofread',
  'is there anything wrong', 'did i miss', 'any issues', 'any mistakes',
  'is this okay', 'is this fine', 'feedback on', 'critique',
];

function countSignals(lower: string, signals: string[]): number {
  return signals.reduce((acc, s) => acc + (lower.includes(s) ? 1 : 0), 0);
}

export function scoreIntents(text: string): IntentScores {
  const lower = text.toLowerCase();
  return {
    delegation: countSignals(lower, DELEGATION_SIGNALS),
    curiosity: countSignals(lower, CURIOSITY_SIGNALS),
    collaborative: countSignals(lower, COLLABORATIVE_SIGNALS),
    verification: countSignals(lower, VERIFICATION_SIGNALS),
  };
}

export function primaryIntentFrom(scores: IntentScores, text?: string): PromptIntent {
  const order: PromptIntent[] = ['curiosity', 'collaborative', 'verification', 'delegation'];
  let best: PromptIntent = 'delegation';
  let bestScore = -1;
  for (const intent of order) {
    if (scores[intent] > bestScore) {
      bestScore = scores[intent];
      best = intent;
    }
  }
  // Tie-break: if delegation is within 1 signal of the winner and the prompt
  // has role-setting ("you are"), it's a task assignment — prefer delegation.
  if (best !== 'delegation' && text) {
    const lower = text.toLowerCase();
    const hasRoleSetting = lower.includes('you are') || lower.includes('act as') || lower.includes('your task') || lower.includes('your role');
    if (hasRoleSetting && scores.delegation >= bestScore - 1) {
      best = 'delegation';
    }
  }
  return best;
}
