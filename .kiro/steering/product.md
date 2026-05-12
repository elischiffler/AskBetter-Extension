# AskBetter Chrome Extension

AskBetter is a Chrome extension that analyzes AI prompts in real-time as the user types in ChatGPT, Gemini, or Perplexity. It scores the prompt across four dimensions — Ownership, Depth, Rigor, and Clarity — and surfaces actionable suggestions before the user hits send.

## Core Purpose

Help users write better prompts by giving them live feedback on prompt quality, intent classification, and specific improvement suggestions.

## Supported Platforms

- ChatGPT (chatgpt.com, chat.openai.com)
- Gemini (gemini.google.com)
- Perplexity (perplexity.ai)

## Scoring Dimensions

- **Ownership** — maps to `autonomy`: does the user show their own thinking?
- **Depth** — maps to `curiosity`: does the prompt ask why/how rather than just what?
- **Critical** (formerly Rigor) — maps to `critical`: does it probe edge cases, risks, or alternatives?
- **Clarity** — average of `specificity` and `context`: is the prompt specific and well-contextualized?

## Scoring Architecture

Two-layer hybrid:
1. **Heuristic** (`engine.ts`) — fires instantly at 300 ms debounce, always available
2. **Ollama LLM** (`ollama.ts`) — fires async at 1500 ms debounce against local `llama3.2`, merges over heuristic result. Falls back silently if Ollama is not running.

Transitions between layers are seamless: when the user resumes typing after an AI score has landed, the heuristic score is blended toward the last AI score using Dice bigram similarity — high similarity gives AI up to 60% weight, fading to 0% below 40% similarity. When the AI result arrives, a soft-floor is applied: if the AI scores lower than what's currently displayed, the score is clamped to no more than 8 points below the displayed value — this prevents Ollama from dragging a well-scored prompt down significantly while still allowing small corrections; if the AI scores higher, the full AI value is used. The currently displayed score is sent to Ollama as a baseline with an instruction to only score dimensions lower if the prompt has genuinely gotten worse. The badge number animates smoothly between values (280 ms ease-out) rather than jumping.

## Intent Classification

Prompts are classified into one of four intents: `delegation`, `curiosity`, `collaborative`, `verification`. Intent influences how quality scores are weighted.

## UI

A floating badge (score circle) appears next to the input bar. Hovering the badge stacks 4 metric circles vertically above it (Clarity closest, Ownership at top), each with a glass-style background tinted by score color, an SVG arc ring, score number, and label. An "OVERALL" label fades in below the badge alongside the metric circles. Circles animate in with a staggered slide-up entrance. While Ollama is scoring, the badge border pulses purple to signal a score update is pending. The badge is anchored to the bottom of the input bar so it stays fixed as the textarea grows vertically.

**Feedback pills** — up to 3 suggestion pills appear above the input bar when the user hovers over it. Pills are stored as pending state after Ollama responds (or heuristic fallback) and rendered on `mouseenter` of the input bar; they hide on `mouseleave`. Pending state is cleared when the user starts typing a new prompt or when the input is emptied (text drops below 5 characters) — hovering an empty input bar shows nothing. Each pill is a bullet point with text from `LiveScore.suggestions`. Color is red (`#f87171`) for dimensions scoring below 60, green (`#4ade80`) when all dimensions are healthy. Pills have a matching color glow and glass-style background (backdrop-filter blur). Pills are collapsed to a single truncated line by default; hovering a pill expands it via a `max-height` transition, wrapping the full text and floating it over pills above via elevated z-index (no layout shift). The hover zone is the input bar + all pills together — moving between them does not dismiss. Pills dismiss only when the mouse leaves the entire group (input bar `mouseleave` checks `relatedTarget` and defers to the pill if the mouse is moving onto one; each pill's `mouseleave` dismisses unless moving back to the input bar or another pill). A transparent bridge div (`#askbetter-feedback-bridge`) spans from the top of the topmost pill down to the top edge of the input bar (stops short of the input bar so clicks and text selection there are not intercepted), filling gaps between pills and between the bottom pill and the input bar so gap-crossing doesn't trigger dismissal.

**Popup dashboard** — two-tab UI (340px wide):
- **Tips tab** (default): static per-dimension improvement cards with example phrases for Ownership, Depth, Critical, and Clarity.
- **Settings tab**: pills toggle, badge toggle — persisted via `chrome.storage.sync` and broadcast live to content scripts. Reset to defaults button.
