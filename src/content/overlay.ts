// ---------------------------------------------------------------------------
// Score badge UI — main circle badge, fans out 4 sub-bubbles with score rings.
// Each sub-bubble has a thin SVG arc showing score 0-100 = 0-360deg.
// ---------------------------------------------------------------------------

import type { LiveScore } from '../analysis/engine';
import type { PlatformConfig } from './selectors';

const BADGE_ID = 'askbetter-badge';
const BUBBLE_CLASS = 'askbetter-bubble';
const BASE_Z = 999998;
const BADGE_Z = 999999;

// Sub-bubble sizing
const BUBBLE_SIZE = 44;       // outer diameter of the SVG
const INNER_R = 14;           // radius of the dark circle inside
const RING_R = 19;            // radius of the progress arc
const RING_STROKE = 3;

// Wider spacing so bubbles never overlap
const ARC = [
  { x: -72, y: -70 },
  { x: -24, y: -88 },
  { x:  24, y: -88 },
  { x:  72, y: -70 },
];

const LABELS = ['Ownership', 'Depth', 'Rigor', 'Clarity'];
const KEYS: (keyof LiveScore)[] = ['autonomy', 'curiosity', 'criticalThinking', 'specificity'];

let currentScore: LiveScore | null = null;
let bubblesVisible = false;
let mouseMoveListener: ((e: MouseEvent) => void) | null = null;
let hullPoints: [number, number][] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getScoreColor(score: number): string {
  if (score >= 70) return '#4ade80';
  if (score >= 40) return '#fbbf24';
  return '#f87171';
}

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
  const size = 36;
  badge.style.top = `${rect.top + rect.height / 2 - size / 2}px`;
  badge.style.left = `${rect.left - size - 10}px`;
}

// ---------------------------------------------------------------------------
// Point-in-polygon & convex hull
// ---------------------------------------------------------------------------

function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function convexHull(points: [number, number][]): [number, number][] {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return [...lower, ...upper];
}

function buildHull(badgeCx: number, badgeCy: number): [number, number][] {
  const pad = 24;
  const badgeR = 18 + pad;
  const allPoints: [number, number][] = [
    [badgeCx - badgeR, badgeCy - badgeR],
    [badgeCx + badgeR, badgeCy - badgeR],
    [badgeCx + badgeR, badgeCy + badgeR],
    [badgeCx - badgeR, badgeCy + badgeR],
  ];
  ARC.forEach(off => {
    const cx = badgeCx + off.x;
    const cy = badgeCy + off.y;
    // Include label space below each bubble
    const r = BUBBLE_SIZE / 2 + pad;
    allPoints.push([cx - r, cy - r]);
    allPoints.push([cx + r, cy - r]);
    allPoints.push([cx + r, cy + r + 18]); // +18 for label
    allPoints.push([cx - r, cy + r + 18]);
  });
  return convexHull(allPoints);
}

// ---------------------------------------------------------------------------
// Sub-bubble SVG with score ring
// ---------------------------------------------------------------------------

function makeBubbleSVG(value: number, index: number): HTMLElement {
  const color = getScoreColor(value);
  const circumference = 2 * Math.PI * RING_R;
  const filled = circumference * (value / 100);
  const gap = circumference - filled;

  // Wrapper div (positions the SVG + label together)
  const wrapper = document.createElement('div');
  wrapper.className = BUBBLE_CLASS;
  wrapper.dataset.index = String(index);
  wrapper.style.cssText = `
    position: fixed;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    pointer-events: auto;
    opacity: 0;
    transform: translate(0px, 0px) scale(0.5);
    transition: opacity 0.22s ease, transform 0.22s ease;
    cursor: default;
    z-index: ${BASE_Z};
  `;

  // SVG circle with progress ring
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', String(BUBBLE_SIZE));
  svg.setAttribute('height', String(BUBBLE_SIZE));
  svg.setAttribute('viewBox', `0 0 ${BUBBLE_SIZE} ${BUBBLE_SIZE}`);
  svg.style.cssText = `
    filter: drop-shadow(0 2px 8px ${color}44);
    transition: filter 0.15s ease;
  `;

  const cx = BUBBLE_SIZE / 2;
  const cy = BUBBLE_SIZE / 2;

  // Background track
  const track = document.createElementNS(svgNS, 'circle');
  track.setAttribute('cx', String(cx));
  track.setAttribute('cy', String(cy));
  track.setAttribute('r', String(RING_R));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', 'rgba(255,255,255,0.07)');
  track.setAttribute('stroke-width', String(RING_STROKE));
  svg.appendChild(track);

  // Progress arc — starts from top (-90deg rotation)
  const arc = document.createElementNS(svgNS, 'circle');
  arc.setAttribute('cx', String(cx));
  arc.setAttribute('cy', String(cy));
  arc.setAttribute('r', String(RING_R));
  arc.setAttribute('fill', 'none');
  arc.setAttribute('stroke', color);
  arc.setAttribute('stroke-width', String(RING_STROKE));
  arc.setAttribute('stroke-linecap', 'round');
  arc.setAttribute('stroke-dasharray', `${filled} ${gap}`);
  arc.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
  arc.style.transition = 'stroke-dasharray 0.4s ease';
  svg.appendChild(arc);

  // Inner dark circle
  const inner = document.createElementNS(svgNS, 'circle');
  inner.setAttribute('cx', String(cx));
  inner.setAttribute('cy', String(cy));
  inner.setAttribute('r', String(INNER_R));
  inner.setAttribute('fill', 'rgba(15, 10, 30, 0.95)');
  svg.appendChild(inner);

  // Score number
  const text = document.createElementNS(svgNS, 'text');
  text.setAttribute('x', String(cx));
  text.setAttribute('y', String(cy));
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.setAttribute('fill', color);
  text.setAttribute('font-size', '11');
  text.setAttribute('font-weight', '800');
  text.setAttribute('font-family', "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif");
  text.textContent = String(value);
  svg.appendChild(text);

  wrapper.appendChild(svg);

  // Label below
  const label = document.createElement('div');
  label.style.cssText = `
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: #a78bfa;
    white-space: nowrap;
    pointer-events: none;
  `;
  label.textContent = LABELS[index];
  wrapper.appendChild(label);

  // Hover: raise z + glow
  wrapper.addEventListener('mouseenter', () => {
    wrapper.style.zIndex = String(BADGE_Z + 1);
    svg.style.filter = `drop-shadow(0 3px 14px ${color}88)`;
    document.querySelectorAll<HTMLElement>(`.${BUBBLE_CLASS}`).forEach(b => {
      if (b !== wrapper) b.style.zIndex = String(BASE_Z - 1);
    });
  });

  wrapper.addEventListener('mouseleave', () => {
    svg.style.filter = `drop-shadow(0 2px 8px ${color}44)`;
    document.querySelectorAll<HTMLElement>(`.${BUBBLE_CLASS}`).forEach(b => {
      b.style.zIndex = String(BASE_Z);
    });
  });

  return wrapper;
}

// ---------------------------------------------------------------------------
// Show / hide
// ---------------------------------------------------------------------------

function startMouseTracking(): void {
  if (mouseMoveListener) return;
  mouseMoveListener = (e: MouseEvent) => {
    if (!bubblesVisible) return;
    if (!pointInPolygon(e.clientX, e.clientY, hullPoints)) hideBubbles();
  };
  document.addEventListener('mousemove', mouseMoveListener);
}

function stopMouseTracking(): void {
  if (mouseMoveListener) {
    document.removeEventListener('mousemove', mouseMoveListener);
    mouseMoveListener = null;
  }
}

function showBubbles(badge: HTMLElement): void {
  if (bubblesVisible || !currentScore) return;
  bubblesVisible = true;

  const badgeRect = badge.getBoundingClientRect();
  const badgeCx = badgeRect.left + badgeRect.width / 2;
  const badgeCy = badgeRect.top + badgeRect.height / 2;

  hullPoints = buildHull(badgeCx, badgeCy);
  startMouseTracking();

  KEYS.forEach((key, i) => {
    const value = currentScore![key] as number;
    const wrapper = makeBubbleSVG(value, i);

    // Start at badge center (offset by half bubble size)
    wrapper.style.left = `${badgeCx - BUBBLE_SIZE / 2}px`;
    wrapper.style.top = `${badgeCy - BUBBLE_SIZE / 2}px`;
    document.body.appendChild(wrapper);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        wrapper.style.opacity = '1';
        wrapper.style.transform = `translate(${ARC[i].x}px, ${ARC[i].y}px) scale(1)`;
      });
    });
  });
}

function hideBubbles(): void {
  if (!bubblesVisible) return;
  bubblesVisible = false;
  stopMouseTracking();

  document.querySelectorAll<HTMLElement>(`.${BUBBLE_CLASS}`).forEach(b => {
    b.style.opacity = '0';
    b.style.transform = 'translate(0px, 0px) scale(0.5)';
    setTimeout(() => b.remove(), 220);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function renderOverlay(score: LiveScore, inputEl: HTMLElement, platform?: PlatformConfig): void {
  currentScore = score;
  const inputBar = findInputBar(inputEl, platform);
  let badge = document.getElementById(BADGE_ID) as HTMLElement | null;

  if (!badge) {
    badge = document.createElement('div');
    badge.id = BADGE_ID;
    badge.style.cssText = `
      position: fixed;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: rgba(15, 10, 30, 0.92);
      border: 2px solid rgba(139, 92, 246, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.02em;
      box-shadow: 0 2px 10px rgba(0,0,0,0.4);
      z-index: ${BADGE_Z};
      cursor: default;
      pointer-events: auto;
      transition: opacity 0.2s, border-color 0.2s;
    `;
    badge.addEventListener('mouseenter', () => showBubbles(badge!));
    document.body.appendChild(badge);
  }

  const color = getScoreColor(score.overall);
  badge.style.color = color;
  badge.style.borderColor = `${color}99`;
  badge.style.opacity = '1';
  badge.textContent = String(score.overall);

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
