// ---------------------------------------------------------------------------
// Score badge UI — circle badge, 4 metric circles stack vertically above on hover.
// Each circle has a glass background, SVG arc ring, score number, and label.
// Also renders 3 feedback pills that fly up from the input bar on hover.
// ---------------------------------------------------------------------------

import type { LiveScore } from '../analysis/engine';
import type { PlatformConfig } from './selectors';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BADGE_ID = 'askbetter-badge';
const BADGE_LABEL_ID = 'askbetter-badge-label';
const BUBBLE_CLASS = 'askbetter-bubble';
const PULSE_STYLE_ID = 'askbetter-pulse-style';
const PULSE_CLASS = 'askbetter-pulsing';
const FEEDBACK_CLASS = 'askbetter-feedback-pill';
const FEEDBACK_STYLE_ID = 'askbetter-feedback-style';
const FEEDBACK_BRIDGE_ID = 'askbetter-feedback-bridge';
const BRIDGE_ID = 'askbetter-bridge';
const BADGE_Z = 999999;
const BASE_Z = 999998;

// Bubble / badge sizing — shared between makeBubble and renderOverlay
const BUBBLE_SIZE = 48;
const INNER_R = 15;
const RING_R = 20;
const RING_STROKE = 3;
const BUBBLE_GAP = 8; // px between bubbles

const LABELS = ['Ownership', 'Depth', 'Critical', 'Clarity'];
const KEYS: (keyof LiveScore)[] = ['ownership', 'depth', 'critical', 'clarity'];

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let currentScore: LiveScore | null = null;
let bubblesVisible = false;
let feedbackVisible = false;

// Pending feedback — stored when Ollama responds, rendered on input bar hover
let pendingSuggestions: string[] = [];
let pendingScores: Pick<LiveScore, 'ownership' | 'depth' | 'critical' | 'clarity'> | null = null;
let pendingInputEl: HTMLElement | null = null;
let pendingPlatform: PlatformConfig | undefined;

// Input bar hover listeners — kept so we can remove them on re-attach
let inputBarHoverEl: HTMLElement | null = null;
let inputBarEnterListener: (() => void) | null = null;
let inputBarLeaveListener: ((e: MouseEvent) => void) | null = null;
let mouseInsideInputBar = false;

// Animated score counter state
let scoreAnimFrame: number | null = null;

// ---------------------------------------------------------------------------
// Colour helper
// ---------------------------------------------------------------------------

function getScoreColor(score: number): string {
  if (score >= 70) return '#4ade80';
  if (score >= 40) return '#fbbf24';
  return '#f87171';
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function findInputBar(inputEl: HTMLElement, _platform?: PlatformConfig): HTMLElement {
  const composerSurface = document.querySelector<HTMLElement>('[data-composer-surface="true"]');
  if (composerSurface) return composerSurface;
  let el: HTMLElement = inputEl;
  while (el.parentElement && el.parentElement !== document.body) {
    if (el.parentElement.children.length > 1) return el;
    el = el.parentElement;
  }
  return el;
}

function positionBadge(badge: HTMLElement, inputBar: HTMLElement): void {
  const rect = inputBar.getBoundingClientRect();
  const size = 48;
  badge.style.top = `${rect.top + rect.height / 2 - size / 2}px`;
  badge.style.left = `${rect.left - size - 10}px`;
}

/**
 * Create an SVG element in the SVG namespace and set multiple attributes at once.
 * Cuts down the repetitive setAttribute chains throughout bubble/badge construction.
 */
function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>
): SVGElementTagNameMap[K] {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * Inject the shared glass gradient <defs> SVG into the document body once.
 * Called before any bubble or badge is created so the gradient is available.
 */
function injectGlassDefs(): void {
  if (document.getElementById('askbetter-glass-defs')) return;
  const defsSvg = svgEl('svg', {
    id: 'askbetter-glass-defs',
    width: '0',
    height: '0',
  });
  defsSvg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;';

  const defs = svgEl('defs', {});
  const grad = svgEl('linearGradient', {
    id: 'askbetter-glass-grad',
    x1: '0%',
    y1: '0%',
    x2: '60%',
    y2: '100%',
  });
  const s1 = svgEl('stop', { offset: '0%', 'stop-color': 'rgba(255,255,255,0.18)' });
  const s2 = svgEl('stop', { offset: '100%', 'stop-color': 'rgba(255,255,255,0.02)' });
  grad.appendChild(s1);
  grad.appendChild(s2);
  defs.appendChild(grad);
  defsSvg.appendChild(defs);
  document.body.appendChild(defsSvg);
}

// ---------------------------------------------------------------------------
// Style injection helpers
// ---------------------------------------------------------------------------

function injectBubbleStyles(): void {
  if (document.getElementById('askbetter-bubble-style')) return;
  const style = document.createElement('style');
  style.id = 'askbetter-bubble-style';
  style.textContent = `
    .${BUBBLE_CLASS} {
      position: fixed;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      width: ${BUBBLE_SIZE}px;
      overflow: visible;
      pointer-events: auto;
      cursor: default;
      z-index: ${BASE_Z};
      opacity: 0;
      transform: translateY(12px) scale(0.85);
      transition: opacity 0.25s cubic-bezier(0.22,1,0.36,1),
                  transform 0.25s cubic-bezier(0.22,1,0.36,1);
    }
    .${BUBBLE_CLASS}.visible {
      opacity: 1;
      transform: translateY(0px) scale(1);
    }
    .askbetter-bubble-svg {
      transition: filter 0.15s ease;
      flex-shrink: 0;
    }
    .askbetter-bubble-label {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 8px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: rgba(167,139,250,0.9);
      white-space: nowrap;
      pointer-events: none;
      width: max-content;
      text-align: center;
      align-self: center;
    }
  `;
  document.head.appendChild(style);
}

function injectFeedbackStyles(): void {
  if (document.getElementById(FEEDBACK_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = FEEDBACK_STYLE_ID;
  style.textContent = `
    @keyframes askbetter-fly-up {
      0%   { opacity: 0; transform: translateY(18px) scale(0.92); }
      60%  { opacity: 1; transform: translateY(-4px) scale(1.02); }
      100% { opacity: 1; transform: translateY(0px) scale(1); }
    }
    @keyframes askbetter-fly-down {
      0%   { opacity: 1; transform: translateY(0px) scale(1); }
      100% { opacity: 0; transform: translateY(14px) scale(0.92); }
    }
    .${FEEDBACK_CLASS} {
      animation: askbetter-fly-up 0.38s cubic-bezier(0.22, 1, 0.36, 1) both;
      max-height: 32px;
      overflow: hidden;
      transition: max-height 0.28s cubic-bezier(0.22, 1, 0.36, 1),
                  box-shadow 0.18s ease,
                  z-index 0s;
      white-space: nowrap;
    }
    .${FEEDBACK_CLASS}:hover {
      max-height: 120px;
      white-space: normal;
      overflow: visible;
      z-index: ${BADGE_Z + 50} !important;
    }
    .${FEEDBACK_CLASS} .askbetter-pill-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: inherit;
      display: block;
      line-height: 1.4;
    }
    .${FEEDBACK_CLASS}.hiding {
      animation: askbetter-fly-down 0.22s ease-in both;
    }
  `;
  document.head.appendChild(style);
}

function injectPulseStyles(): void {
  if (document.getElementById(PULSE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PULSE_STYLE_ID;
  style.textContent = `
    @keyframes askbetter-pulse {
      0%   { filter: drop-shadow(0 0 0px rgba(167,139,250,0.0)); }
      50%  { filter: drop-shadow(0 0 8px rgba(167,139,250,0.9)); }
      100% { filter: drop-shadow(0 0 0px rgba(167,139,250,0.0)); }
    }
    #askbetter-badge-svg.${PULSE_CLASS} {
      animation: askbetter-pulse 1.2s ease-in-out infinite;
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Bubble construction
// ---------------------------------------------------------------------------

/**
 * Build the shared SVG circle structure used by both metric bubbles and the
 * main badge: glass background, purple ring accent, glass highlight, arc
 * track, progress arc, and score text.
 *
 * Returns the SVG element plus named references to the mutable parts so
 * callers can update them without re-querying the DOM.
 */
function buildCircleSvg(
  value: number,
  color: string,
  idPrefix?: string
): {
  svg: SVGSVGElement;
  glassBg: SVGCircleElement;
  arc: SVGCircleElement;
  scoreText: SVGTextElement;
} {
  const circumference = 2 * Math.PI * RING_R;
  const filled = circumference * (value / 100);
  const gap = circumference - filled;
  const cx = String(BUBBLE_SIZE / 2);
  const cy = String(BUBBLE_SIZE / 2);

  const svg = svgEl('svg', {
    width: String(BUBBLE_SIZE),
    height: String(BUBBLE_SIZE),
    viewBox: `0 0 ${BUBBLE_SIZE} ${BUBBLE_SIZE}`,
  }) as SVGSVGElement;

  // Glass background circle — score-color tint with purple border accent
  const glassBg = svgEl('circle', {
    cx,
    cy,
    r: String(INNER_R + 3),
    fill: `${color}18`,
    stroke: `${color}38`,
    'stroke-width': '1',
    ...(idPrefix ? { id: `${idPrefix}-glassbg` } : {}),
  }) as SVGCircleElement;
  svg.appendChild(glassBg);

  // Purple inner ring accent
  svg.appendChild(
    svgEl('circle', {
      cx,
      cy,
      r: String(INNER_R + 3),
      fill: 'none',
      stroke: 'rgba(167,139,250,0.18)',
      'stroke-width': '1.5',
    })
  );

  // Glass highlight (top-left arc shimmer)
  svg.appendChild(
    svgEl('circle', {
      cx,
      cy,
      r: String(INNER_R + 3),
      fill: 'url(#askbetter-glass-grad)',
    })
  );

  // Arc track — purple tint
  svg.appendChild(
    svgEl('circle', {
      cx,
      cy,
      r: String(RING_R),
      fill: 'none',
      stroke: 'rgba(167,139,250,0.20)',
      'stroke-width': String(RING_STROKE),
    })
  );

  // Progress arc
  const arc = svgEl('circle', {
    cx,
    cy,
    r: String(RING_R),
    fill: 'none',
    stroke: color,
    'stroke-width': String(RING_STROKE),
    'stroke-linecap': 'round',
    'stroke-dasharray': `${filled} ${gap}`,
    transform: `rotate(-90 ${cx} ${cy})`,
    ...(idPrefix ? { id: `${idPrefix}-arc` } : {}),
  }) as SVGCircleElement;
  arc.style.transition = 'stroke-dasharray 0.4s ease, stroke 0.2s ease';
  svg.appendChild(arc);

  // Score number
  const scoreText = svgEl('text', {
    x: cx,
    y: cy,
    'text-anchor': 'middle',
    'dominant-baseline': 'central',
    fill: color,
    'font-size': '11',
    'font-weight': '800',
    'font-family': "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    ...(idPrefix ? { id: `${idPrefix}-text` } : {}),
  }) as SVGTextElement;
  scoreText.textContent = String(value);
  svg.appendChild(scoreText);

  return { svg, glassBg, arc, scoreText };
}

/** Build a single metric bubble (one of the four that stack above the badge). */
function makeBubble(value: number, index: number): HTMLElement {
  const color = getScoreColor(value);

  const wrapper = document.createElement('div');
  wrapper.className = BUBBLE_CLASS;
  wrapper.dataset.index = String(index);

  const { svg } = buildCircleSvg(value, color);
  svg.classList.add('askbetter-bubble-svg');
  svg.style.filter = `drop-shadow(0 2px 10px ${color}55)`;
  wrapper.appendChild(svg);

  // Label below the circle
  const label = document.createElement('div');
  label.className = 'askbetter-bubble-label';
  label.textContent = LABELS[index];
  wrapper.appendChild(label);

  // Hover glow + dismiss when leaving the entire widget
  wrapper.addEventListener('mouseenter', () => {
    svg.style.filter = `drop-shadow(0 3px 16px ${color}88)`;
  });
  wrapper.addEventListener('mouseleave', (e: MouseEvent) => {
    svg.style.filter = `drop-shadow(0 2px 10px ${color}55)`;
    const rel = e.relatedTarget as HTMLElement | null;
    if (rel?.closest(`.${BUBBLE_CLASS}`) || rel?.id === BRIDGE_ID || rel?.id === BADGE_ID) return;
    hideBubbles();
  });

  return wrapper;
}

// ---------------------------------------------------------------------------
// Show / hide bubbles
// ---------------------------------------------------------------------------

function showBubbles(badge: HTMLElement): void {
  if (!currentScore) return;
  if (bubblesVisible) {
    if (document.querySelectorAll(`.${BUBBLE_CLASS}`).length > 0) return;
    bubblesVisible = false;
  }

  injectGlassDefs();
  injectBubbleStyles();
  bubblesVisible = true;

  const badgeRect = badge.getBoundingClientRect();
  const badgeCx = badgeRect.left + badgeRect.width / 2;
  const badgeTop = badgeRect.top;

  const rowH = BUBBLE_SIZE + 11 + BUBBLE_GAP;
  const stackH = KEYS.length * rowH - BUBBLE_GAP;
  const stackTop = badgeTop - BUBBLE_GAP - stackH;

  // "OVERALL" label below the badge — fades in with the bubbles
  const badgeLabel = document.createElement('div');
  badgeLabel.id = BADGE_LABEL_ID;
  badgeLabel.textContent = 'OVERALL';
  badgeLabel.style.cssText = `
    position: fixed;
    left: ${badgeCx}px;
    top: ${badgeRect.bottom + 4}px;
    transform: translateX(-50%);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 8px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: rgba(167,139,250,0.9);
    white-space: nowrap;
    pointer-events: none;
    z-index: ${BADGE_Z};
    opacity: 0;
    transition: opacity 0.25s ease;
  `;
  document.body.appendChild(badgeLabel);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      badgeLabel.style.opacity = '1';
    })
  );

  KEYS.forEach((key, i) => {
    const value = currentScore![key] as number;
    const bubble = makeBubble(value, i);

    const stackIndex = KEYS.length - 1 - i;
    const bottomY = badgeTop - BUBBLE_GAP - stackIndex * rowH;
    bubble.style.left = `${badgeCx - BUBBLE_SIZE / 2}px`;
    bubble.style.top = `${bottomY - BUBBLE_SIZE - 11}px`;

    document.body.appendChild(bubble);
    setTimeout(() => bubble.classList.add('visible'), i * 40);
  });

  // Invisible bridge covering the full column from badge top to stack top
  const bridge = document.createElement('div');
  bridge.id = BRIDGE_ID;
  bridge.style.cssText = `
    position: fixed;
    left: ${badgeCx - BUBBLE_SIZE / 2}px;
    top: ${stackTop}px;
    width: ${BUBBLE_SIZE}px;
    height: ${badgeRect.bottom - stackTop}px;
    z-index: ${BASE_Z - 1};
    pointer-events: auto;
    background: transparent;
  `;
  bridge.addEventListener('mouseleave', (e: MouseEvent) => {
    const rel = e.relatedTarget as HTMLElement | null;
    if (rel?.closest(`.${BUBBLE_CLASS}`) || rel?.id === BADGE_ID) return;
    hideBubbles();
  });
  document.body.appendChild(bridge);
}

function hideBubbles(): void {
  if (!bubblesVisible) return;
  bubblesVisible = false;

  document.getElementById(BRIDGE_ID)?.remove();

  const badgeLabel = document.getElementById(BADGE_LABEL_ID);
  if (badgeLabel) {
    badgeLabel.style.opacity = '0';
    setTimeout(() => badgeLabel.remove(), 260);
  }

  document.querySelectorAll<HTMLElement>(`.${BUBBLE_CLASS}`).forEach((b) => {
    b.classList.remove('visible');
    setTimeout(() => b.remove(), 260);
  });
}

// ---------------------------------------------------------------------------
// Feedback pills
// ---------------------------------------------------------------------------

/**
 * Build a single feedback pill element.
 * Extracted from showPendingPills so the render loop stays readable.
 */
function createPillElement(
  text: string,
  index: number,
  isGreen: boolean,
  rect: DOMRect
): HTMLElement {
  const color = isGreen ? '#4ade80' : '#f87171';
  const glowColor = isGreen ? 'rgba(74, 222, 128, 0.18)' : 'rgba(248, 113, 113, 0.18)';
  const borderColor = isGreen ? 'rgba(74, 222, 128, 0.35)' : 'rgba(248, 113, 113, 0.35)';

  const pill = document.createElement('div');
  pill.className = FEEDBACK_CLASS;
  pill.style.cssText = `
    position: fixed;
    left: ${rect.left + 12}px;
    top: ${rect.top - 44 - index * 40}px;
    max-width: ${Math.min(rect.width - 24, 520)}px;
    background: linear-gradient(135deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.04) 100%);
    border: 1px solid ${borderColor};
    border-top: 1px solid rgba(167,139,250,0.30);
    border-radius: 20px;
    padding: 7px 14px 7px 10px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 12px;
    font-weight: 500;
    color: ${color};
    box-shadow: 0 0 20px 3px ${glowColor}, 0 0 8px 1px rgba(167,139,250,0.10), 0 4px 16px rgba(0,0,0,0.18), inset 0 1px 0 rgba(167,139,250,0.12);
    z-index: ${BADGE_Z + 10 + index};
    pointer-events: auto;
    animation-delay: ${index * 60}ms;
    backdrop-filter: blur(14px) saturate(160%);
    -webkit-backdrop-filter: blur(14px) saturate(160%);
    cursor: default;
  `;

  const dot = document.createElement('span');
  dot.style.cssText = `
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${color};
    flex-shrink: 0;
    box-shadow: 0 0 6px 1px ${color}88;
  `;

  const label = document.createElement('span');
  label.className = 'askbetter-pill-label';
  label.textContent = text;

  pill.appendChild(dot);
  pill.appendChild(label);

  pill.addEventListener('mouseleave', (e: MouseEvent) => {
    const rel = e.relatedTarget as HTMLElement | null;
    if (
      (rel && (inputBarHoverEl?.contains(rel) || rel === inputBarHoverEl)) ||
      rel?.closest(`.${FEEDBACK_CLASS}`) ||
      rel?.id === FEEDBACK_BRIDGE_ID
    )
      return;
    mouseInsideInputBar = false;
    hideFeedback();
  });

  return pill;
}

function showPendingPills(): void {
  console.log(
    '[AskBetter:pills] mouseenter fired — pendingScores:',
    pendingScores,
    'suggestions:',
    pendingSuggestions,
    'inputEl:',
    pendingInputEl
  );
  if (!pendingScores || pendingSuggestions.length === 0 || !pendingInputEl) {
    console.log('[AskBetter:pills] showPendingPills bailed — missing data');
    return;
  }

  injectFeedbackStyles();
  document.querySelectorAll<HTMLElement>(`.${FEEDBACK_CLASS}`).forEach((p) => p.remove());
  document.getElementById(FEEDBACK_BRIDGE_ID)?.remove();
  feedbackVisible = true;

  const inputBar = inputBarHoverEl ?? findInputBar(pendingInputEl, pendingPlatform);
  const rect = inputBar.getBoundingClientRect();
  console.log('[AskBetter:pills] rendering pills at rect:', rect.left, rect.top, rect.width);

  const dimOrder: (keyof typeof pendingScores)[] = ['ownership', 'depth', 'critical', 'clarity'];
  const lowDims = dimOrder.filter((k) => pendingScores![k] < 60);

  pendingSuggestions.slice(0, 3).forEach((text, i) => {
    const isGreen = lowDims.length === 0 || lowDims[i] === undefined;
    const pill = createPillElement(text, i, isGreen, rect);
    document.body.appendChild(pill);
  });

  // Transparent bridge covering the gaps between pills and the input bar
  const pillCount = pendingSuggestions.slice(0, 3).length;
  const topPillTop = rect.top - 44 - (pillCount - 1) * 40;
  const bridgeWidth = Math.min(rect.width - 24, 520) + 24;

  const bridge = document.createElement('div');
  bridge.id = FEEDBACK_BRIDGE_ID;
  bridge.style.cssText = `
    position: fixed;
    left: ${rect.left}px;
    top: ${topPillTop}px;
    width: ${bridgeWidth}px;
    height: ${rect.top - topPillTop}px;
    z-index: ${BADGE_Z + 5};
    pointer-events: auto;
    background: transparent;
  `;
  bridge.addEventListener('mouseleave', (e: MouseEvent) => {
    const rel = e.relatedTarget as HTMLElement | null;
    if (
      (rel && (inputBarHoverEl?.contains(rel) || rel === inputBarHoverEl)) ||
      rel?.closest(`.${FEEDBACK_CLASS}`)
    )
      return;
    mouseInsideInputBar = false;
    hideFeedback();
  });
  document.body.appendChild(bridge);
}

// ---------------------------------------------------------------------------
// Animated score counter
// Smoothly counts the displayed number from its current value to the new
// target so score transitions feel fluid rather than jumping.
// ---------------------------------------------------------------------------

function animateScoreTo(textEl: Element, from: number, to: number): void {
  if (scoreAnimFrame !== null) cancelAnimationFrame(scoreAnimFrame);
  if (from === to) {
    textEl.textContent = String(to);
    return;
  }

  const duration = 280; // ms — fast enough to feel snappy, slow enough to read
  const start = performance.now();

  function step(now: number): void {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    textEl.textContent = String(Math.round(from + (to - from) * eased));
    if (progress < 1) {
      scoreAnimFrame = requestAnimationFrame(step);
    } else {
      scoreAnimFrame = null;
    }
  }

  scoreAnimFrame = requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export function attachInputBarHover(inputEl: HTMLElement, platform?: PlatformConfig): void {
  if (inputBarHoverEl && inputBarEnterListener && inputBarLeaveListener) {
    inputBarHoverEl.removeEventListener('mouseenter', inputBarEnterListener);
    inputBarHoverEl.removeEventListener('mouseleave', inputBarLeaveListener);
  }

  const inputBar = findInputBar(inputEl, platform);
  console.log(
    '[AskBetter:pills] attachInputBarHover — resolved inputBar:',
    inputBar.tagName,
    inputBar.className.slice(0, 80)
  );
  inputBarHoverEl = inputBar;

  inputBarEnterListener = () => {
    mouseInsideInputBar = true;
    showPendingPills();
  };
  inputBarLeaveListener = (e: MouseEvent) => {
    const rel = e.relatedTarget as HTMLElement | null;
    if (rel?.closest(`.${FEEDBACK_CLASS}`) || rel?.id === FEEDBACK_BRIDGE_ID) return;
    mouseInsideInputBar = false;
    hideFeedback();
  };

  inputBar.addEventListener('mouseenter', inputBarEnterListener);
  inputBar.addEventListener('mouseleave', inputBarLeaveListener);

  if (inputBar.matches(':hover')) {
    mouseInsideInputBar = true;
  }
}

export function renderFeedback(
  suggestions: string[],
  scores: Pick<LiveScore, 'ownership' | 'depth' | 'critical' | 'clarity'>,
  inputEl: HTMLElement,
  platform?: PlatformConfig
): void {
  console.log(
    '[AskBetter:pills] renderFeedback called — suggestions:',
    suggestions,
    'scores:',
    scores
  );
  pendingSuggestions = suggestions;
  pendingScores = scores;
  pendingInputEl = inputEl;
  pendingPlatform = platform;
  if (feedbackVisible) {
    document.querySelectorAll<HTMLElement>(`.${FEEDBACK_CLASS}`).forEach((p) => p.remove());
    feedbackVisible = false;
  }
  if (mouseInsideInputBar) {
    showPendingPills();
  }
}

export function hideFeedback(instant = false): void {
  if (!feedbackVisible && !instant) return;
  feedbackVisible = false;

  document.getElementById(FEEDBACK_BRIDGE_ID)?.remove();

  if (instant) {
    pendingSuggestions = [];
    pendingScores = null;
    pendingInputEl = null;
  }

  const pills = document.querySelectorAll<HTMLElement>(`.${FEEDBACK_CLASS}`);
  if (pills.length === 0) return;

  if (instant) {
    pills.forEach((p) => p.remove());
    return;
  }

  pills.forEach((p) => {
    p.classList.add('hiding');
    setTimeout(() => p.remove(), 240);
  });
}

export function setBadgeLoading(loading: boolean): void {
  injectPulseStyles();
  const svg = document.getElementById('askbetter-badge-svg');
  if (!svg) return;
  if (loading) svg.classList.add(PULSE_CLASS);
  else svg.classList.remove(PULSE_CLASS);
}

export function renderOverlay(
  score: LiveScore,
  inputEl: HTMLElement,
  platform?: PlatformConfig
): void {
  currentScore = score;
  const inputBar = findInputBar(inputEl, platform);
  const color = getScoreColor(score.overall);

  let badge = document.getElementById(BADGE_ID) as HTMLElement | null;

  if (!badge) {
    injectGlassDefs();

    badge = document.createElement('div');
    badge.id = BADGE_ID;
    badge.style.cssText = `
      position: fixed;
      width: ${BUBBLE_SIZE}px;
      height: ${BUBBLE_SIZE}px;
      z-index: ${BADGE_Z};
      cursor: default;
      pointer-events: auto;
      opacity: 0;
      transition: opacity 0.2s ease;
    `;

    const { svg } = buildCircleSvg(score.overall, color, 'askbetter-badge');
    svg.setAttribute('id', 'askbetter-badge-svg');
    svg.style.cssText = 'position:absolute;top:0;left:0;transition:filter 0.2s ease;';
    badge.appendChild(svg);

    badge.addEventListener('mouseenter', () => {
      const s = document.getElementById('askbetter-badge-svg');
      if (s)
        s.style.filter = `drop-shadow(0 3px 16px ${getScoreColor(currentScore?.overall ?? 0)}88)`;
      showBubbles(badge!);
    });
    badge.addEventListener('mouseleave', (e: MouseEvent) => {
      const s = document.getElementById('askbetter-badge-svg');
      if (s)
        s.style.filter = `drop-shadow(0 2px 10px ${getScoreColor(currentScore?.overall ?? 0)}55)`;
      const rel = e.relatedTarget as HTMLElement | null;
      if (rel?.closest(`.${BUBBLE_CLASS}`) || rel?.id === BRIDGE_ID) return;
      hideBubbles();
    });

    document.body.appendChild(badge);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        badge!.style.opacity = '1';
      })
    );
  }

  // Update SVG elements with new score/color
  const glassBg = badge.querySelector('#askbetter-badge-glassbg');
  if (glassBg) {
    glassBg.setAttribute('fill', `${color}18`);
    glassBg.setAttribute('stroke', `${color}38`);
  }
  const arc = badge.querySelector('#askbetter-badge-arc');
  if (arc) {
    const circumference = 2 * Math.PI * RING_R;
    const filled = circumference * (score.overall / 100);
    const gap = circumference - filled;
    arc.setAttribute('stroke', color);
    arc.setAttribute('stroke-dasharray', `${filled} ${gap}`);
  }
  const text = badge.querySelector('#askbetter-badge-text');
  if (text) {
    text.setAttribute('fill', color);
    const currentVal = parseInt(text.textContent ?? '0', 10);
    animateScoreTo(text, isNaN(currentVal) ? score.overall : currentVal, score.overall);
  }
  const svg = badge.querySelector('#askbetter-badge-svg') as HTMLElement | null;
  if (svg) svg.style.filter = `drop-shadow(0 2px 10px ${color}55)`;

  requestAnimationFrame(() => positionBadge(badge!, inputBar));
}

export function hideOverlay(): void {
  hideBubbles();
  const badge = document.getElementById(BADGE_ID);
  if (badge) {
    badge.style.opacity = '0';
    setTimeout(() => badge.remove(), 200);
  }
}

// ---------------------------------------------------------------------------
// Visibility cleanup — remove floating elements when tab is hidden
// ---------------------------------------------------------------------------

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    document.getElementById(BRIDGE_ID)?.remove();
    document.getElementById(BADGE_LABEL_ID)?.remove();
    document.querySelectorAll<HTMLElement>(`.${BUBBLE_CLASS}`).forEach((b) => b.remove());
    bubblesVisible = false;
  }
});
