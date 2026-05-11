# Project Structure

## Root Layout

```
manifest.json        # Chrome MV3 manifest — permissions, entry points, host_permissions
popup.html           # Extension popup UI (inline CSS, loads dist/popup.js)
vite.config.ts       # Build config — defines the three entry points
tsconfig.json        # TypeScript config — strict, ES2022, bundler resolution
package.json
icons/               # Extension icons at 16, 48, 128px
dist/                # Build output (gitignored) — loaded by Chrome
src/                 # All source TypeScript
```

## src/ Modules

### `src/analysis/` — Pure scoring logic, no DOM dependencies

| File | Responsibility |
|---|---|
| `types.ts` | Shared types: `PromptIntent`, `IntentScores`, `QualityScores` |
| `classifier.ts` | Signal-based intent scoring (`scoreIntents`, `primaryIntentFrom`) |
| `rubric.ts` | Flag detection and quality scoring (`detectFlags`, `scorePromptQuality`, `computeQualityScore`) |
| `tfidf.ts` | Adapted TF-IDF topic extraction. IDF is a pre-computed English word frequency table (~150 entries); unknown words default to `UNKNOWN_WORD_IDF=10`. Finds all **contiguous spans** of non-stop words, scores each by average TF-IDF (position weight, technical boost, qualifier penalty), and returns the best-scoring span as a coherent noun phrase. Exports two functions: `extractTopicTFIDF(text, stopWords)` — single best phrase; `extractTopicsTFIDF(text, stopWords, n)` — top N **non-overlapping** spans from different parts of the prompt, so each suggestion can reference a distinct aspect. Falls back to repeating the best phrase if fewer than N spans exist. All multipliers (`POSITION_WEIGHT`, `TECHNICAL_BOOST`, `QUALIFIER_PENALTY`, `UNKNOWN_WORD_IDF`, `MAX_TOPIC_WORDS`) are exported constants. |
| `engine.ts` | Public API — `analyzePrompt(text): LiveScore` — composes classifier + rubric into UI-ready scores. `LiveScore` dimensions: `ownership`, `depth`, `critical`, `clarity`. Calls `extractTopicsTFIDF` to get up to 3 distinct topic phrases, then assigns a different phrase to each suggestion builder (`ownershipSuggestion`, `depthSuggestion`, `criticalSuggestion`, `claritySuggestion`) so tips reference different parts of the prompt. Weak dimensions (score < 60) sorted ascending; top 3 returned. |
| `ollama.ts` | Thin proxy — `scoreWithOllama(text, heuristic?)` sends an `OLLAMA_SCORE` message (with optional `HeuristicContext`) to the background worker and returns the result. `HeuristicContext` carries pre-computed intent, flags, dimension scores, TF-IDF topics, and `displayedScore` (the currently blended score shown to the user — used as a baseline floor in the Ollama prompt and for `softFloor` blending on the result). Does not fetch directly (content scripts on https:// pages cannot make http:// requests — Chrome mixed-content block) |

### `src/content/` — Injected into AI platform pages

| File | Responsibility |
|---|---|
| `index.ts` | Entry point — detects platform, polls for input element, attaches observers via `attachToInput()`, debounces analysis, sends messages to background. Tracks `activeInput`/`activeObserver` module-level refs; 1 s heartbeat re-attaches if SPA replaces the element; `visibilitychange` re-scores on tab focus. Two-layer scoring: heuristic fires at 300 ms debounce, Ollama async re-score fires at 1500 ms debounce with spinner feedback. `lastScoredText` tracks the last fully-scored text so observer/input/keyup event bursts from a single keystroke don't incorrectly hide pills — `hideFeedback()` only fires when the text has actually changed from `lastScoredText`. Before calling `scoreWithOllama`, builds a `HeuristicContext` (intent, flags, dimension scores, top TF-IDF topics, and `displayedScore` — the currently blended score shown to the user) so Ollama receives pre-digested signal and a baseline to anchor against. **Score blending (AI→heuristic)**: `lastAiScore` + `lastAiText` stored when AI lands; next heuristic render uses `blendWithAiScore()` — Dice bigram similarity between current and AI-scored text, AI gets up to 60% weight, fades to 0% below 40% similarity. `lastAiScore` is cleared on SPA navigation so stale context doesn't bleed into a new chat. **Score blending (heuristic→AI)**: `softFloor()` applied to AI result — if AI score < displayed score, blends 30% AI / 70% displayed to prevent visible dips; if AI score ≥ displayed, full AI value used. `scheduleOllamaScore` receives `displayScore` as a parameter for this purpose. **Stale response guard**: two checks after `await scoreWithOllama` — (1) generation counter `gen !== currentOllamaGen` discards responses if the user typed again; (2) text match `text !== lastScoredText` discards responses where the input changed since the request was fired, catching slow in-flight responses from previous prompts that arrive while the generation is still valid. |
| `selectors.ts` | `PlatformConfig` type + per-platform DOM selectors for ChatGPT, Gemini, Perplexity |
| `overlay.ts` | Floating badge + 4 vertical metric circles + feedback pills — all DOM creation is imperative vanilla JS, no framework. Badge is an SVG circle identical in structure to the metric bubbles (glass bg, purple ring accent, arc ring, score number). Badge hover shows 4 glass-style SVG circles stacked vertically above the badge (staggered slide-up animation). A transparent bridge `div` (`#askbetter-bridge`) spans the full column between badge and bubbles so the hover zone is continuous. Exports `setBadgeLoading(bool)` (pulsing drop-shadow on `#askbetter-badge-svg` while Ollama scores), `renderFeedback(suggestions, scores, inputEl, platform?)` (saves pending pill state), `hideFeedback(instant?)` (fly-down exit or instant removal + clears pending state + removes feedback bridge), and `attachInputBarHover(inputEl, platform?)` (mouseenter/mouseleave on input bar for pill reveal). A transparent `#askbetter-feedback-bridge` div spans from the top of the topmost pill down to the top edge of the input bar (not the bottom — stops short so the input bar remains fully interactive), filling gaps so mouse travel between pills and input bar doesn't trigger dismissal. **Score number animates** via `animateScoreTo()` — counts up/down over 280 ms with ease-out cubic, cancelling any in-progress animation and restarting from the current displayed value so rapid updates don't stutter. |

### `src/background/` — Service worker

| File | Responsibility |
|---|---|
| `index.ts` | Receives `SCORE_UPDATE` and `PROMPT_SUBMITTED` messages from content script; serves `GET_LATEST_SCORE` to popup; proxies `OLLAMA_SCORE` requests to `http://localhost:11434`. When `OLLAMA_SCORE` includes a `HeuristicContext`, injects a pre-analysis block into the Ollama prompt (detected intent, key topics, heuristic scores, weakest dimensions, detected signals) so the model focuses on generating specific suggestions rather than re-deriving what the heuristic already computed. |

### `src/popup/` — Extension popup

| File | Responsibility |
|---|---|
| `index.ts` | Requests latest score from background, renders score rows into `popup.html` |

## Key Architectural Rules

- `src/analysis/` must stay DOM-free and platform-agnostic — it can be unit tested in isolation
- `src/content/` is the only layer that touches the page DOM
- Message passing between layers uses typed discriminated unions (`type: 'SCORE_UPDATE' | 'PROMPT_SUBMITTED' | 'GET_LATEST_SCORE' | 'OLLAMA_SCORE'`)
- The overlay (`overlay.ts`) manages its own state (`currentScore`, `bubblesVisible`, `feedbackVisible`, `pendingSuggestions`, `pendingScores`, `pendingInputEl`, `inputBarHoverEl`, `mouseInsideInputBar`) as module-level variables — there is no external state store
- Platform selectors live exclusively in `selectors.ts` — never hardcode selectors elsewhere
- All scores are integers 0–100, clamped via `clamp()` in `rubric.ts`
- The `LiveScore` interface (defined in `engine.ts`) is the single contract between analysis and UI layers
- **Two-layer scoring**: heuristic (`engine.ts`) fires instantly at 300 ms debounce; Ollama (`ollama.ts`) fires async at 1500 ms debounce and merges over the heuristic result. Ollama failures are silent — heuristic score remains. Badge border pulses purple 600 ms after heuristic fires to signal AI scoring is pending; pulse cancels immediately if user resumes typing. **Feedback pills are stored as pending state** when Ollama (or heuristic fallback) responds — they render only when the user hovers the input bar (`mouseenter`) and hide on `mouseleave`. If the mouse is already inside the input bar when feedback arrives, pills show immediately. Pending state is cleared when the user starts typing a new prompt **or when the input is emptied** (text < 5 chars — `hideFeedback(true)` is called, clearing all pending state so hovering an empty bar shows nothing). `attachInputBarHover` is called once per input attach in `index.ts`. When merging Ollama scores, if Ollama returns empty suggestions the heuristic suggestions are used as fallback so pills always have content.
- **Ollama fetch lives in the background worker** (`background/index.ts`), not in the content script. Content scripts on https:// pages cannot make http:// requests (Chrome mixed-content block). `ollama.ts` is a thin message-passing wrapper only.
- **Ollama CORS config required**: Ollama rejects requests from `chrome-extension://` origins by default (403). Must set `OLLAMA_ORIGINS="chrome-extension://*"` before starting Ollama. Persistent setup: add `export OLLAMA_ORIGINS="chrome-extension://*"` to `~/.zshrc`, or run `launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"` once for the macOS app. Model: `llama3.2`, timeout: 30 s (first inference is slow — warm up with `ollama run llama3.2` before use).
- **Ollama system prompt** uses anchored scale descriptions (0/40/70/100 examples per dimension) and three calibration examples — vague prompt ("test test test", scores ~5), short delegation ("fix my code", scores ~10), and medium-quality prompt (scores ~44) — to cover the full quality range. Suggestions rules: must reference only topics present in the prompt (never invent topics), be a concrete question the user could literally add, target a different weak dimension each, with good/bad examples. Hard constraint: `CRITICAL: suggestions must only reference topics that appear in the prompt`. `num_predict=500`.
