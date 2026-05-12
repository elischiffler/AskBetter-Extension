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
| `classifier.ts` | Signal-based intent scoring (`scoreIntents`, `primaryIntentFrom`). `explain`, `analyze`, `identify`, `review`, `suggest`, `provide` are delegation signals (task verbs), not curiosity signals. `primaryIntentFrom` accepts optional `text` param — if delegation is within 1 signal of the winner and the prompt contains role-setting (`you are`, `act as`, `your task`, `your role`), delegation wins the tie-break. |
| `stopWords.ts` | Exported `STOP_WORDS` set — filtered out before TF-IDF topic extraction. Re-exported from `engine.ts` for backward compatibility. |
| `idfTable.ts` | Exported `WORD_IDF` record — pre-computed IDF proxy table (~500 entries, grouped by frequency tier). Covers CS/software, medicine/biology, physics/chemistry, mathematics/statistics, ML/AI, law, finance/economics, psychology, linguistics, history/social sciences, and engineering. Imported by `tfidf.ts` only. |
| `rubric.ts` | Flag detection and quality scoring (`detectFlags`, `scorePromptQuality`, `computeQualityScore`). Internally composed of four helpers: `computeBaseScores` (starting values by word count), `applyFlagBonuses`, `applyIntentBonuses`, `applyPenalties`. `computeQualityScore` is intent-aware: delegation weights autonomy×0.30, criticalThinking×0.25, curiosity×0.15, specificity×0.15, context×0.15; curiosity intent weights curiosity×0.30; all others equal. Long delegation penalty (`wordCount>120, no ?`) only fires when the prompt lacks structure signals. `copy_paste_without_question` flag only fires when no structure signals present. `CONTEXT_SIGNALS` includes: `constraints`, `requirements`, `audience`, `format`, `rubric`, `example`, `goal`, `context`, `background`, `best practices`, `behavior`, `behaviour`, `use case`, `scenario`, `criteria`. **Intent excellence scoring**: `computeExcellenceBonus()` runs after base scoring and applies graduated bonuses (up to +25 pts) to the dimensions most relevant for each intent — delegation (6 signals), curiosity (5), collaborative (5), verification (5). Bonus scales linearly with ratio of signals hit. High-excellence prompts (ratio ≥ 0.6) without `?` have the no-question curiosity penalty partially restored (+10). |
| `tfidf.ts` | Adapted TF-IDF topic extraction. Imports IDF table from `idfTable.ts`. `scoreToken` is a module-level pure function (takes `totalWords` as param). Finds all **contiguous spans** of non-stop words, scores each by average TF-IDF (position weight, technical boost, qualifier penalty), and returns the best-scoring span as a coherent noun phrase. Exports: `extractTopicTFIDF(text, stopWords)` — single best phrase; `extractTopicsTFIDF(text, stopWords, n)` — top N **non-overlapping** spans. All multipliers (`POSITION_WEIGHT`, `TECHNICAL_BOOST`, `QUALIFIER_PENALTY`, `UNKNOWN_WORD_IDF`, `MAX_TOPIC_WORDS`) are exported constants. |
| `engine.ts` | Public API — `analyzePrompt(text): LiveScore` — composes classifier + rubric into UI-ready scores. Imports `STOP_WORDS` from `stopWords.ts` and re-exports it. `LiveScore` dimensions: `ownership`, `depth`, `critical`, `clarity`. Calls `extractTopicsTFIDF` to get up to 3 distinct topic phrases, then assigns a different phrase to each suggestion builder (`ownershipSuggestion`, `depthSuggestion`, `criticalSuggestion`, `claritySuggestion`) so tips reference different parts of the prompt. Weak dimensions (score < 60) sorted ascending; top 3 returned. |
| `ollama.ts` | Thin proxy — `scoreWithOllama(text, heuristic?)` sends an `OLLAMA_SCORE` message (with optional `HeuristicContext`) to the background worker and returns the result. `HeuristicContext` carries pre-computed intent, flags, dimension scores, TF-IDF topics, and `displayedScore`. Does not fetch directly (content scripts on https:// pages cannot make http:// requests — Chrome mixed-content block) |

### `src/content/` — Injected into AI platform pages

| File | Responsibility |
|---|---|
| `index.ts` | Entry point — detects platform, polls for input element, attaches observers via `attachToInput()`, debounces analysis, sends messages to background. Tracks `activeInput`/`activeObserver` module-level refs; 1 s heartbeat re-attaches if SPA replaces the element; `visibilitychange` re-scores on tab focus. Two-layer scoring: heuristic fires at 300 ms debounce, Ollama async re-score fires at 1500 ms debounce with spinner feedback. `lastScoredText` tracks the last fully-scored text so observer/input/keyup event bursts from a single keystroke don't incorrectly hide pills. `buildHeuristicContext(text, heuristicScore, displayScore)` packages pre-computed signals into a `HeuristicContext` for Ollama. `softFloor(ai, displayed)` is a module-level pure function — caps AI score drops to 8 pts below displayed. **Score blending (AI→heuristic)**: `lastAiScore` + `lastAiText` stored when AI lands; next heuristic render uses `blendWithAiScore()` — Dice bigram similarity, AI gets up to 60% weight, fades to 0% below 40% similarity. `lastAiScore` is cleared on SPA navigation. **Stale response guard**: generation counter + text match checks after `await scoreWithOllama`. |
| `selectors.ts` | `PlatformConfig` type + per-platform DOM selectors for ChatGPT, Gemini, Perplexity |
| `overlay.ts` | Floating badge + 4 vertical metric circles + feedback pills — all DOM creation is imperative vanilla JS, no framework. `buildCircleSvg(value, color, idPrefix?)` is a shared helper that constructs the glass bg, purple ring, highlight, arc track, progress arc, and score text — used by both `makeBubble` and `renderOverlay` to eliminate duplication. `injectGlassDefs()` injects the shared SVG gradient once and is called before any circle is created. `createPillElement(text, index, isGreen, rect)` builds a single pill element, keeping the render loop in `showPendingPills` to a clean 3-liner. `svgEl(tag, attrs)` is a tiny helper that creates SVG elements and sets attributes from an object. Exports `setBadgeLoading(bool)`, `renderFeedback(suggestions, scores, inputEl, platform?)`, `hideFeedback(instant?)`, `attachInputBarHover(inputEl, platform?)`, `renderOverlay(score, inputEl, platform?)`, `hideOverlay()`. **Score number animates** via `animateScoreTo()` — counts up/down over 280 ms with ease-out cubic. |

### `src/background/` — Service worker

| File | Responsibility |
|---|---|
| `index.ts` | Receives `SCORE_UPDATE` and `PROMPT_SUBMITTED` messages from content script; serves `GET_LATEST_SCORE` to popup; proxies `OLLAMA_SCORE` requests to `http://localhost:11434`. `buildPreAnalysis(heuristic)` is an extracted helper that builds the pre-analysis block injected into the Ollama prompt (detected intent, key topics, heuristic scores, weakest dimensions, detected signals, baseline scores). `SYSTEM_PROMPT` constant is defined after the message handlers for readability. |

### `src/popup/` — Extension popup

| File | Responsibility |
|---|---|
| `index.ts` | Two-tab dashboard (Tips / Settings). Tips tab: static per-dimension improvement guide. Settings tab: pills toggle, badge toggle — persisted via `chrome.storage.sync` and broadcast to content scripts via `SETTINGS_UPDATE`. Reset to defaults button. Platform badge in header reads active tab URL. |

## Key Architectural Rules

- `src/analysis/` must stay DOM-free and platform-agnostic — it can be unit tested in isolation
- `src/content/` is the only layer that touches the page DOM
- Message passing between layers uses typed discriminated unions (`type: 'SCORE_UPDATE' | 'PROMPT_SUBMITTED' | 'GET_LATEST_SCORE' | 'OLLAMA_SCORE' | 'SETTINGS_UPDATE'`)
- The overlay (`overlay.ts`) manages its own state (`currentScore`, `bubblesVisible`, `feedbackVisible`, `pendingSuggestions`, `pendingScores`, `pendingInputEl`, `inputBarHoverEl`, `mouseInsideInputBar`, `badgeLabelRemoveTimeout`) as module-level variables — there is no external state store. `badgeLabelRemoveTimeout` tracks the pending `setTimeout` that removes the OVERALL label after fade-out; cancelled on re-hover to prevent duplicate label creation.
- Platform selectors live exclusively in `selectors.ts` — never hardcode selectors elsewhere
- All scores are integers 0–100, clamped via `clamp()` in `rubric.ts`
- The `LiveScore` interface (defined in `engine.ts`) is the single contract between analysis and UI layers
- **Two-layer scoring**: heuristic (`engine.ts`) fires instantly at 300 ms debounce; Ollama (`ollama.ts`) fires async at 1500 ms debounce and merges over the heuristic result. Ollama failures are silent — heuristic score remains. Badge border pulses purple 600 ms after heuristic fires to signal AI scoring is pending; pulse cancels immediately if user resumes typing. **Feedback pills are stored as pending state** when Ollama (or heuristic fallback) responds — they render only when the user hovers the input bar (`mouseenter`) and hide on `mouseleave`. If the mouse is already inside the input bar when feedback arrives, pills show immediately. Pending state is cleared when the user starts typing a new prompt **or when the input is emptied** (text < 5 chars — `hideFeedback(true)` is called, clearing all pending state so hovering an empty bar shows nothing). `attachInputBarHover` is called once per input attach in `index.ts`. When merging Ollama scores, if Ollama returns empty suggestions the heuristic suggestions are used as fallback so pills always have content.
- **Settings persistence**: user settings (`pillsEnabled`, `badgeEnabled`) are stored in `chrome.storage.sync`. Popup broadcasts `SETTINGS_UPDATE` to all tabs on change; content script applies changes immediately via module-level `contentSettings` object. Toggling badge off calls `hideOverlay()` instantly; toggling on re-triggers `onInputChange`. Toggling pills off calls `hideFeedback(true)` instantly. `renderOverlay` and `renderFeedback` calls in the scoring flow are gated by `contentSettings.badgeEnabled` / `contentSettings.pillsEnabled`.
- **Ollama fetch lives in the background worker** (`background/index.ts`), not in the content script. Content scripts on https:// pages cannot make http:// requests (Chrome mixed-content block). `ollama.ts` is a thin message-passing wrapper only.
- **Ollama CORS config required**: Ollama rejects requests from `chrome-extension://` origins by default (403). Must set `OLLAMA_ORIGINS="chrome-extension://*"` before starting Ollama. Persistent setup: add `export OLLAMA_ORIGINS="chrome-extension://*"` to `~/.zshrc`, or run `launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"` once for the macOS app. Model: `llama3.2`, timeout: 30 s (first inference is slow — warm up with `ollama run llama3.2` before use).
- **Ollama system prompt** uses anchored scale descriptions (0/40/70/100 examples per dimension) and five calibration examples — vague prompt ("test test test", scores ~4), short delegation ("fix my code", scores ~10), medium-quality curiosity prompt (BFS in Python, scores ~44), high-quality structured delegation prompt (FlickIt MVP, scores ~76), and high-quality structured delegation with requirements list and no question marks (academic essay, scores ~69) — covering the full quality range and explicitly teaching the model not to penalize imperative phrasing when requirements are clearly listed. Suggestions rules: must reference only topics present in the prompt (never invent topics), be a concrete question the user could literally add, target a different weak dimension each, with good/bad examples. Hard constraint: `CRITICAL: suggestions must only reference topics that appear in the prompt`. `num_predict=500`.
