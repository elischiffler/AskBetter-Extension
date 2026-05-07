// ---------------------------------------------------------------------------
// Platform-specific DOM selectors for finding the chat input field
// Each platform has a different DOM structure — these selectors target
// the textarea/contenteditable where the user types their prompt.
// ---------------------------------------------------------------------------

export interface PlatformConfig {
  name: string;
  inputSelector: string;
  /** The outermost input bar container — badge will be inserted before this */
  inputBarSelector?: string;
  /** Optional: selector for the send button (to detect when a prompt is submitted) */
  sendButtonSelector?: string;
}

const PLATFORMS: Record<string, PlatformConfig> = {
  chatgpt: {
    name: 'ChatGPT',
    inputSelector: '#prompt-textarea, [id="prompt-textarea"]',
    sendButtonSelector: '[data-testid="send-button"], button[aria-label="Send prompt"]',
  },
  gemini: {
    name: 'Gemini',
    inputSelector: '.ql-editor, [contenteditable="true"][aria-label*="prompt"], rich-textarea .ql-editor',
    sendButtonSelector: 'button[aria-label="Send message"], .send-button',
  },
  perplexity: {
    name: 'Perplexity',
    inputSelector: 'textarea[placeholder*="Ask"], textarea[aria-label*="Ask"]',
    sendButtonSelector: 'button[aria-label="Submit"]',
  },
};

/**
 * Detect which AI platform the current page belongs to.
 */
export function detectPlatform(): PlatformConfig | null {
  const host = window.location.hostname;

  if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) {
    return PLATFORMS.chatgpt;
  }
  if (host.includes('gemini.google.com')) {
    return PLATFORMS.gemini;
  }
  if (host.includes('perplexity.ai')) {
    return PLATFORMS.perplexity;
  }

  return null;
}

/**
 * Find the chat input element on the current page.
 * Returns null if not found (page may still be loading).
 */
export function findInputElement(platform: PlatformConfig): HTMLElement | null {
  return document.querySelector<HTMLElement>(platform.inputSelector);
}

/**
 * Get the current text from the input element.
 * Handles both textarea and contenteditable elements.
 */
export function getInputText(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement) {
    return el.value;
  }
  // contenteditable (Gemini uses this)
  return el.innerText || el.textContent || '';
}
