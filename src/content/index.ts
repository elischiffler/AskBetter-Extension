// ---------------------------------------------------------------------------
// Content script — injected into ChatGPT, Gemini, and Perplexity pages.
// Watches the chat input for changes and runs live analysis.
// ---------------------------------------------------------------------------

import { detectPlatform, findInputElement, getInputText } from './selectors';
import { analyzePrompt } from '../analysis/engine';
import { renderOverlay, hideOverlay } from './overlay';

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 300;

/**
 * Safely send a message to the background script.
 * Silently no-ops if the extension context has been invalidated
 * (e.g. after an extension reload while the tab was still open).
 */
function safeSendMessage(message: object): void {
  try {
    chrome.runtime.sendMessage(message);
  } catch {
    // Context invalidated — extension was reloaded. Nothing to do.
  }
}

function onInputChange(el: HTMLElement, platform: ReturnType<typeof detectPlatform>): void {
  if (debounceTimer) clearTimeout(debounceTimer);

  debounceTimer = setTimeout(() => {
    const text = getInputText(el);

    if (text.trim().length < 5) {
      hideOverlay();
      return;
    }

    const score = analyzePrompt(text);
    renderOverlay(score, el, platform ?? undefined);

    // Send score to background for popup display
    safeSendMessage({ type: 'SCORE_UPDATE', score });
  }, DEBOUNCE_MS);
}

function init(): void {
  const platform = detectPlatform();
  if (!platform) return;

  console.log(`[AskBetter] Detected platform: ${platform.name}`);

  // Poll for the input element (it may not exist yet on page load)
  const pollInterval = setInterval(() => {
    const input = findInputElement(platform);
    if (!input) return;

    clearInterval(pollInterval);
    console.log(`[AskBetter] Found input element, attaching listener`);

    // Listen for input changes
    input.addEventListener('input', () => onInputChange(input, platform));

    // For contenteditable elements, also watch for mutations
    if (!(input instanceof HTMLTextAreaElement)) {
      const observer = new MutationObserver(() => onInputChange(input, platform));
      observer.observe(input, { childList: true, subtree: true, characterData: true });
    }

    // Also watch for the send button click (to track submitted prompts)
    if (platform.sendButtonSelector) {
      const sendBtn = document.querySelector(platform.sendButtonSelector);
      if (sendBtn) {
        sendBtn.addEventListener('click', () => {
          const text = getInputText(input);
          if (text.trim().length > 0) {
            const score = analyzePrompt(text);
            safeSendMessage({ type: 'PROMPT_SUBMITTED', text, score });
          }
          // Hide overlay after sending
          setTimeout(hideOverlay, 500);
        });
      }
    }
  }, 1000);

  // Stop polling after 30 seconds
  setTimeout(() => clearInterval(pollInterval), 30000);
}

// Run when the content script loads
init();
