// ---------------------------------------------------------------------------
// Content script — injected into ChatGPT, Gemini, and Perplexity pages.
// Simple rule: if the input has text → show score. If empty → hide score.
// ---------------------------------------------------------------------------

import { detectPlatform, findInputElement, getInputText } from './selectors';
import { analyzePrompt, STOP_WORDS } from '../analysis/engine';
import {
  renderOverlay,
  hideOverlay,
  setBadgeLoading,
  renderFeedback,
  hideFeedback,
  attachInputBarHover,
} from './overlay';
import { scoreWithOllama } from '../analysis/ollama';
import { extractTopicsTFIDF } from '../analysis/tfidf';
import type { HeuristicContext } from '../analysis/ollama';

// ---------------------------------------------------------------------------
// Debounce timers and constants
// ---------------------------------------------------------------------------

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let ollamaTimer: ReturnType<typeof setTimeout> | null = null;
let pulseTimer: ReturnType<typeof setTimeout> | null = null;

const DEBOUNCE_MS = 300;
const PULSE_DELAY_MS = 600; // delay after heuristic before pulse starts
const OLLAMA_EXTRA_MS = 1200; // additional wait after heuristic fires (total = 1500 ms from last keystroke)

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

// Generation counter — incremented once per input change so stale Ollama
// responses don't overwrite a newer score.
let currentOllamaGen = 0;

// Last text that was fully scored — used to detect real input changes vs
// observer noise (observer + input + keyup all fire for a single keystroke).
let lastScoredText = '';

// Last AI score — used to blend heuristic scores smoothly when the user
// resumes typing after an AI score has landed.
let lastAiScore: ReturnType<typeof analyzePrompt> | null = null;
let lastAiText = '';

let activeInput: HTMLElement | null = null;
let activeObserver: MutationObserver | null = null;

// ---------------------------------------------------------------------------
// Score blending — interpolates heuristic toward the last AI score based on
// how much the prompt has changed since the AI scored it.
//   similarity = 1 → text unchanged → trust AI fully (up to 60% weight)
//   similarity = 0 → text completely different → trust heuristic fully
// ---------------------------------------------------------------------------

function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;

  // Dice coefficient on character bigrams
  const bigrams = (s: string) => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      map.set(bg, (map.get(bg) ?? 0) + 1);
    }
    return map;
  };

  const aMap = bigrams(a.toLowerCase());
  const bMap = bigrams(b.toLowerCase());
  let intersection = 0;
  for (const [bg, count] of aMap) {
    intersection += Math.min(count, bMap.get(bg) ?? 0);
  }
  const total = a.length - 1 + (b.length - 1);
  return total === 0 ? 0 : (2 * intersection) / total;
}

function blendScore(heuristic: number, ai: number, similarity: number): number {
  // At similarity=1 use up to 60% AI weight; fades to 0% at similarity=0.
  const aiWeight = similarity * 0.6;
  return Math.round(heuristic * (1 - aiWeight) + ai * aiWeight);
}

function blendWithAiScore(
  heuristic: ReturnType<typeof analyzePrompt>,
  currentText: string
): ReturnType<typeof analyzePrompt> {
  if (!lastAiScore) return heuristic;

  const similarity = textSimilarity(currentText, lastAiText);
  if (similarity < 0.4) {
    // Prompt has changed enough that the AI score is stale — clear it
    lastAiScore = null;
    return heuristic;
  }

  return {
    ...heuristic,
    overall: blendScore(heuristic.overall, lastAiScore.overall, similarity),
    ownership: blendScore(heuristic.ownership, lastAiScore.ownership, similarity),
    depth: blendScore(heuristic.depth, lastAiScore.depth, similarity),
    critical: blendScore(heuristic.critical, lastAiScore.critical, similarity),
    clarity: blendScore(heuristic.clarity, lastAiScore.clarity, similarity),
  };
}

// ---------------------------------------------------------------------------
// Soft floor — prevents Ollama from dragging a well-scored prompt down
// significantly. Caps any drop to 8 points below the currently displayed score.
// If the AI scores higher, the full AI value is used.
// ---------------------------------------------------------------------------

function softFloor(ai: number, displayed: number): number {
  return ai >= displayed ? ai : Math.max(ai, displayed - 8);
}

// ---------------------------------------------------------------------------
// Heuristic context builder — packages pre-computed signals for Ollama so it
// can skip re-deriving intent/topics and focus on generating suggestions.
// ---------------------------------------------------------------------------

function buildHeuristicContext(
  text: string,
  heuristicScore: ReturnType<typeof analyzePrompt>,
  displayScore: ReturnType<typeof analyzePrompt>
): HeuristicContext {
  const topics = extractTopicsTFIDF(text, STOP_WORDS, 3);
  return {
    intent: heuristicScore.intent,
    flags: heuristicScore.flags,
    scores: {
      ownership: heuristicScore.ownership,
      depth: heuristicScore.depth,
      critical: heuristicScore.critical,
      clarity: heuristicScore.clarity,
      overall: heuristicScore.overall,
    },
    topics,
    displayedScore: {
      ownership: displayScore.ownership,
      depth: displayScore.depth,
      critical: displayScore.critical,
      clarity: displayScore.clarity,
      overall: displayScore.overall,
    },
  };
}

// ---------------------------------------------------------------------------
// Chrome message helper
// ---------------------------------------------------------------------------

function safeSendMessage(message: object): void {
  try {
    if (!chrome.runtime?.id) return; // context invalidated
    chrome.runtime.sendMessage(message);
  } catch {
    // Extension reloaded while tab was open — nothing to do.
  }
}

// ---------------------------------------------------------------------------
// Core scoring flow
// ---------------------------------------------------------------------------

function onInputChange(el: HTMLElement, platform: ReturnType<typeof detectPlatform>): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (ollamaTimer) clearTimeout(ollamaTimer);

  // Peek at current text before the debounce to decide if pills should hide.
  // Only hide if the text has actually changed from what was last scored —
  // this filters out the burst of observer/input/keyup events that all fire
  // for a single keystroke, which would otherwise kill freshly rendered pills.
  const currentText = getInputText(el);
  if (currentText !== lastScoredText) {
    if (pulseTimer) {
      clearTimeout(pulseTimer);
      pulseTimer = null;
    }
    setBadgeLoading(false);
    hideFeedback();
  }

  debounceTimer = setTimeout(() => {
    const text = getInputText(el);
    console.log(
      '[AskBetter] input change, text length:',
      text.length,
      'trimmed:',
      text.trim().length,
      JSON.stringify(text.slice(0, 50))
    );

    if (text.trim().length < 5) {
      lastScoredText = '';
      hideOverlay();
      hideFeedback(true); // clear pending state so hovering an empty bar shows nothing
      return;
    }

    // Layer 1: instant heuristic score — blended toward last AI score if the
    // prompt hasn't changed much, so the transition feels continuous.
    const heuristicScore = analyzePrompt(text);
    const displayScore = blendWithAiScore(heuristicScore, text);
    lastScoredText = text;
    if (contentSettings.badgeEnabled) {
      renderOverlay(displayScore, el, platform ?? undefined);
    }
    safeSendMessage({ type: 'SCORE_UPDATE', score: displayScore });

    // Bump generation counter after the heuristic fires
    const gen = ++currentOllamaGen;

    // Start pulse after a short delay — feels natural, not jarring
    pulseTimer = setTimeout(() => {
      pulseTimer = null;
      setBadgeLoading(true);
    }, PULSE_DELAY_MS);

    // Layer 2: async Ollama re-score after typing fully settles
    ollamaTimer = setTimeout(() => {
      scheduleOllamaScore(text, heuristicScore, displayScore, el, platform, gen);
    }, OLLAMA_EXTRA_MS);
  }, DEBOUNCE_MS);
}

async function scheduleOllamaScore(
  text: string,
  heuristicScore: ReturnType<typeof analyzePrompt>,
  displayScore: ReturnType<typeof analyzePrompt>,
  el: HTMLElement,
  platform: ReturnType<typeof detectPlatform>,
  gen: number
): Promise<void> {
  console.log('[AskBetter] Ollama scoring started');

  const heuristicContext = buildHeuristicContext(text, heuristicScore, displayScore);
  const aiScore = await scoreWithOllama(text, heuristicContext);

  // Guard 1: generation counter — if the user typed again, discard this result
  if (gen !== currentOllamaGen) return;

  // Guard 2: text match — catches slow in-flight responses from a previous
  // prompt that arrive after the user has already changed the input.
  if (text !== lastScoredText) return;

  // Stop pulsing regardless of whether Ollama succeeded
  setBadgeLoading(false);

  if (!aiScore) {
    console.log('[AskBetter] Ollama unavailable — falling back to heuristic suggestions');
    if (contentSettings.pillsEnabled) {
      renderFeedback(heuristicScore.suggestions, heuristicScore, el, platform ?? undefined);
    }
    return;
  }

  // Merge AI scores over the heuristic base.
  // Soft-floor prevents the badge from visibly dipping when the user has been
  // steadily improving their prompt and Ollama disagrees slightly.
  const ds = displayScore;
  const merged = {
    ...heuristicScore,
    ...aiScore,
    ownership: softFloor(aiScore.ownership ?? heuristicScore.ownership, ds.ownership),
    depth: softFloor(aiScore.depth ?? heuristicScore.depth, ds.depth),
    critical: softFloor(aiScore.critical ?? heuristicScore.critical, ds.critical),
    clarity: softFloor(aiScore.clarity ?? heuristicScore.clarity, ds.clarity),
    overall: softFloor(aiScore.overall ?? heuristicScore.overall, ds.overall),
    // Fall back to heuristic suggestions if Ollama returned none
    suggestions:
      aiScore.suggestions && aiScore.suggestions.length > 0
        ? aiScore.suggestions
        : heuristicScore.suggestions,
  };

  console.log('[AskBetter] Ollama score received:', merged.overall);

  // Store AI score so subsequent heuristic renders can blend toward it
  lastAiScore = merged as ReturnType<typeof analyzePrompt>;
  lastAiText = text;

  if (contentSettings.badgeEnabled) {
    renderOverlay(merged, el, platform ?? undefined);
  }
  if (contentSettings.pillsEnabled) {
    renderFeedback(merged.suggestions, merged, el, platform ?? undefined);
  }
  safeSendMessage({ type: 'SCORE_UPDATE', score: merged });
}

// ---------------------------------------------------------------------------
// Input attachment
// ---------------------------------------------------------------------------

function attachToInput(input: HTMLElement, platform: ReturnType<typeof detectPlatform>): void {
  if (activeObserver) {
    activeObserver.disconnect();
    activeObserver = null;
  }
  activeInput = input;

  console.log(`[AskBetter] Attaching observer to input`, input.id, input.className);

  // Score immediately — text may already be present
  onInputChange(input, platform);

  // Attach hover listeners to the input bar for pill reveal
  attachInputBarHover(input, platform ?? undefined);

  // MutationObserver for contenteditable changes
  const observer = new MutationObserver(() => onInputChange(input, platform));
  observer.observe(input, { childList: true, subtree: true, characterData: true });
  activeObserver = observer;

  // 'input' event covers direct keyboard input
  input.addEventListener('input', () => onInputChange(input, platform));
  // 'keyup' catches deletions in contenteditable that may not fire 'input'
  input.addEventListener('keyup', () => onInputChange(input, platform));

  // Track submitted prompts for the popup/background
  input.addEventListener('keydown', (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' && !ke.shiftKey) {
      const text = getInputText(input);
      if (text.trim().length > 0) {
        safeSendMessage({ type: 'PROMPT_SUBMITTED', text, score: analyzePrompt(text) });
      }
    }
  });

  if (platform?.sendButtonSelector) {
    const sendBtn = document.querySelector(platform.sendButtonSelector);
    sendBtn?.addEventListener('click', () => {
      const text = getInputText(input);
      if (text.trim().length > 0) {
        safeSendMessage({ type: 'PROMPT_SUBMITTED', text, score: analyzePrompt(text) });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Initialisation — polls for the input element, re-attaches on SPA navigation
// ---------------------------------------------------------------------------

function init(): void {
  const platform = detectPlatform();
  if (!platform) return;

  console.log(`[AskBetter] Detected platform: ${platform.name}`);

  const pollInterval = setInterval(() => {
    const input = findInputElement(platform);
    if (!input) return;

    if (input !== activeInput) {
      clearInterval(pollInterval);
      attachToInput(input, platform);

      // Slower heartbeat to re-attach if the SPA replaces the element
      setInterval(() => {
        const current = findInputElement(platform);
        if (current && current !== activeInput) {
          console.log('[AskBetter] Input element replaced, re-attaching');
          attachToInput(current, platform);
        }
      }, 1000);
    }
  }, 500);

  setTimeout(() => clearInterval(pollInterval), 30_000);
}

init();

// ---------------------------------------------------------------------------
// SPA navigation detection — ChatGPT swaps URLs without a page reload.
// Hide the badge and clear AI state whenever the user navigates to a new chat.
// ---------------------------------------------------------------------------

let lastUrl = location.href;
const navObserver = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    lastAiScore = null;
    lastAiText = '';
    hideOverlay();
    // Re-check the input after navigation — the new chat may have a draft
    setTimeout(() => {
      const platform = detectPlatform();
      if (!platform) return;
      const input = findInputElement(platform);
      if (input) onInputChange(input, platform);
    }, 800);
  }
});
navObserver.observe(document.body, { childList: true, subtree: true });

// ---------------------------------------------------------------------------
// Tab visibility — re-score when the user switches back to this tab
// ---------------------------------------------------------------------------

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && activeInput) {
    onInputChange(activeInput, detectPlatform());
  }
});

// ---------------------------------------------------------------------------
// Settings — listen for changes broadcast from the popup
// ---------------------------------------------------------------------------

interface ContentSettings {
  pillsEnabled: boolean;
  badgeEnabled: boolean;
}

// Active settings — applied immediately when received
let contentSettings: ContentSettings = {
  pillsEnabled: true,
  badgeEnabled: true,
};

// Load persisted settings on startup and apply them
chrome.storage.sync.get('askbetter_settings', (result) => {
  if (result['askbetter_settings']) {
    applySettings(result['askbetter_settings'] as Partial<ContentSettings>);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SETTINGS_UPDATE') {
    applySettings(message.settings as Partial<ContentSettings>);
  }
});

function applySettings(settings: Partial<ContentSettings>): void {
  const prevBadge = contentSettings.badgeEnabled;
  const prevPills = contentSettings.pillsEnabled;

  contentSettings = { ...contentSettings, ...settings };

  // Badge toggled off → hide immediately
  if (prevBadge && !contentSettings.badgeEnabled) {
    hideOverlay();
  }
  // Badge toggled on → re-score to show it
  if (!prevBadge && contentSettings.badgeEnabled && activeInput) {
    onInputChange(activeInput, detectPlatform());
  }

  // Pills toggled off → clear immediately
  if (prevPills && !contentSettings.pillsEnabled) {
    hideFeedback(true);
  }
  // Pills toggled on → nothing to do; they'll appear next time feedback arrives
}
