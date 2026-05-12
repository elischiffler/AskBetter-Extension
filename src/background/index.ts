// ---------------------------------------------------------------------------
// Background service worker
// Handles communication between content scripts and the popup.
// The background worker proxies Ollama requests — content scripts on https://
// pages cannot make http:// requests directly (mixed-content block), but the
// background service worker has no such restriction.
// ---------------------------------------------------------------------------

import type { LiveScore } from '../analysis/engine';
import type { HeuristicContext } from '../analysis/ollama';

interface ScoreMessage {
  type: 'SCORE_UPDATE';
  score: LiveScore;
}

interface PromptMessage {
  type: 'PROMPT_SUBMITTED';
  text: string;
  score: LiveScore;
}

interface OllamaRequest {
  type: 'OLLAMA_SCORE';
  text: string;
  heuristic?: HeuristicContext;
}

type Message = ScoreMessage | PromptMessage | OllamaRequest;

// Store the latest score for the popup to read
let latestScore: LiveScore | null = null;

// ---------------------------------------------------------------------------
// Ollama proxy — runs here so http://localhost calls aren't blocked by the
// mixed-content policy that applies to content scripts on https:// pages.
// ---------------------------------------------------------------------------

const OLLAMA_URL = 'http://localhost:11434/api/generate';
const MODEL = 'llama3.2';
const TIMEOUT_MS = 30_000; // llama3.2 can be slow on first inference

const SYSTEM_PROMPT = `You are an expert at evaluating the quality of prompts sent to AI assistants.
Score the given prompt on exactly these 4 dimensions, each 0-100:

- ownership (0-100): Does the user provide context, constraints, or their own thinking?
  0 = single vague word ("fix"), 40 = clear question with some context, 70 = shows prior attempt or reasoning, 100 = detailed context + attempts + reasoning
- depth (0-100): Does it seek understanding rather than just an answer?
  0 = "give me X", 40 = "how do I X" with some specifics, 70 = asks why/how with follow-up curiosity, 100 = probes underlying concepts deeply
- critical (0-100): Does it probe edge cases, tradeoffs, or alternatives?
  0 = no probing at all, 40 = implicitly scoped, 70 = asks about tradeoffs or alternatives, 100 = explicitly asks about risks, edge cases, and alternatives
- clarity (0-100): Is it specific, well-contextualized, and unambiguous?
  0 = completely vague, 40 = clear intent with basic context, 70 = specific goal + constraints + format, 100 = crystal clear with all relevant context

Calibration examples:

Example 1 — vague/meaningless prompt:
Prompt: "test test test"
Expected scores: ownership=5, depth=5, critical=5, clarity=0, overall=4, intent="delegation"
Suggestions must be about the literal words "test test test" — do NOT reference any other topic.
Example suggestions: ["What are you trying to test? Describe the specific thing you want to check.", "Add context — is this a software test, a language test, or something else?", "What outcome are you expecting from this test?"]

Example 2 — short delegation prompt:
Prompt: "fix my code"
Expected scores: ownership=10, depth=15, critical=10, clarity=5, overall=10, intent="delegation"
Example suggestions: ["Share the code you want fixed and describe what it should do.", "What error or behaviour are you seeing that needs fixing?", "What have you already tried to fix it?"]

Example 3 — medium quality prompt with context:
Prompt: "how do i build a good breadth first search algorithm? I will be using python to code this on vscode."
Expected scores: ownership=42, depth=48, critical=25, clarity=62, overall=44, intent="curiosity"
Reasoning: Clear question with language/tool context (clarity=62), asks "how" showing curiosity (depth=48), provides tool context but no prior attempt (ownership=42), doesn't ask about tradeoffs or edge cases (critical=25).

Example 4 — high quality structured delegation prompt:
Prompt: "You are an experienced software engineer and technical writer. I am building a mobile app called FlickIt, which allows users to upload, share, and monetize photos from events and friend groups. Your task is to design a detailed MVP feature breakdown for this app. Please include: Core user features (uploading, feeds, profiles, payments, etc.), Admin or backend features needed to support the system, Suggested database structure at a high level, Key APIs that would be required, Any critical edge cases or risks I should account for in early development. Format your response using clear sections and bullet points. Keep it technical but understandable for a solo developer building the MVP."
Expected scores: ownership=78, depth=65, critical=82, clarity=80, overall=76, intent="delegation"
Reasoning: Strong role-setting and detailed context (ownership=78), explicitly requests edge cases and risks (critical=82), clear format and audience constraints (clarity=80), asks for deliverable rather than understanding so depth is moderate (depth=65).

Example 5 — high quality structured delegation with requirements list (no question marks):
Prompt: "You are a university-level history professor and expert academic writer. I need a comprehensive, well-structured essay on the history of the United States. The essay should cover: A chronological overview of U.S. presidents from George Washington to the present day (highlight major shifts in leadership style and policy), Major wars involving the United States, The outcomes of these wars and their long-term consequences, Key political, economic, and social impacts of each major era. Requirements: Organize the essay chronologically by historical era, Clearly connect events to their political and societal effects, Use formal academic tone but remain readable for an undergraduate audience, Provide a strong introduction and conclusion. Optional: include brief comparisons between different eras."
Expected scores: ownership=72, depth=60, critical=65, clarity=78, overall=69, intent="delegation"
Reasoning: Strong role-setting (professor persona) and detailed structured requirements (clarity=78, ownership=72). Explicit audience spec (undergraduate) and format requirements. No prior attempt or reasoning shown (ownership not higher). Doesn't explicitly ask about risks/edge cases (critical=65). Asks for deliverable not understanding (depth=60). Imperative phrasing without question marks is normal for structured delegation — do NOT penalize for lack of question marks when requirements are clearly listed.

Also provide:
- overall: weighted average (ownership 25%, depth 25%, critical 25%, clarity 25%), rounded to nearest integer
- intent: one of "delegation" | "curiosity" | "collaborative" | "verification"
- suggestions: array of exactly 1-3 improvement tips. Rules for suggestions:
  * Each tip must be a concrete, specific question or phrase the user could literally add to their prompt.
  * Each tip must reference the actual subject matter of the prompt — NEVER reference BFS, graphs, algorithms, or any other topic unless the prompt itself mentions them.
  * Each tip must target a DIFFERENT weak dimension (ownership, depth, critical, or clarity).
  * Keep each tip under 90 characters.
  * Bad example (too generic): "Add more context to your prompt."
  * Good example (specific): "What have you already tried with the BFS implementation? Share your current code."
  * You MUST provide suggestions if overall < 75. Only use an empty array if overall >= 75.

CRITICAL: Your suggestions must only reference topics, technologies, and concepts that appear in the prompt being evaluated. Never invent topics.

Respond with ONLY valid JSON, no markdown, no explanation:
{"ownership":N,"depth":N,"critical":N,"clarity":N,"overall":N,"intent":"...","suggestions":["tip1","tip2","tip3"]}`;

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

async function fetchOllamaScore(
  text: string,
  heuristic?: HeuristicContext
): Promise<Partial<LiveScore> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    console.log('[AskBetter:bg] Fetching from Ollama...');
    const t0 = Date.now();

    // Build a pre-analysis block from heuristic data so Ollama doesn't
    // waste tokens re-deriving what we already know, and can focus on
    // generating grounded, specific suggestions.
    let preAnalysis = '';
    if (heuristic) {
      const weakDims = Object.entries(heuristic.scores)
        .filter(([k, v]) => k !== 'overall' && v < 60)
        .sort(([, a], [, b]) => a - b)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      const flagList = heuristic.flags.length > 0 ? heuristic.flags.join(', ') : 'none';
      const topicList = heuristic.topics.length > 0 ? heuristic.topics.join(', ') : 'unknown';

      const baselineBlock = heuristic.displayedScore
        ? `- Currently displayed score (your baseline): ownership=${heuristic.displayedScore.ownership}, depth=${heuristic.displayedScore.depth}, critical=${heuristic.displayedScore.critical}, clarity=${heuristic.displayedScore.clarity}, overall=${heuristic.displayedScore.overall}
- IMPORTANT: Only score a dimension LOWER than its baseline if the prompt has genuinely gotten worse in that area. If the user has added more context or detail, scores should increase from the baseline. This creates a smooth, progressive scoring experience.`
        : '';

      preAnalysis = `
Pre-analysis from heuristic scorer (use this to inform your suggestions):
- Detected intent: ${heuristic.intent}
- Key topics identified: ${topicList}
- Heuristic scores: ownership=${heuristic.scores.ownership}, depth=${heuristic.scores.depth}, critical=${heuristic.scores.critical}, clarity=${heuristic.scores.clarity}, overall=${heuristic.scores.overall}
- Weakest dimensions: ${weakDims || 'none'}
- Detected signals: ${flagList}
${baselineBlock}
Use the key topics and weak dimensions above to write suggestions that are specific to THIS prompt.
`;
    }

    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        prompt: `${SYSTEM_PROMPT}${preAnalysis}\n\nPrompt to evaluate:\n${text}`,
        stream: false,
        options: { temperature: 0.1, num_predict: 500 },
      }),
    });

    console.log(`[AskBetter:bg] Ollama HTTP status: ${res.status} (${Date.now() - t0}ms)`);
    if (!res.ok) return null;

    const data = (await res.json()) as { response?: string };
    console.log('[AskBetter:bg] Raw Ollama response:', data.response?.slice(0, 300));

    const raw = data.response?.trim() ?? '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('[AskBetter:bg] No JSON found in response. Raw:', raw.slice(0, 500));
      return null;
    }

    console.log('[AskBetter:bg] Extracted JSON:', jsonMatch[0]);
    const parsed = JSON.parse(jsonMatch[0]) as {
      ownership?: number;
      depth?: number;
      critical?: number;
      clarity?: number;
      overall?: number;
      intent?: string;
      suggestions?: unknown[];
    };

    if (
      typeof parsed.ownership !== 'number' ||
      typeof parsed.depth !== 'number' ||
      typeof parsed.critical !== 'number' ||
      typeof parsed.clarity !== 'number'
    ) {
      console.log('[AskBetter:bg] Parsed JSON missing required fields:', parsed);
      return null;
    }

    const ownership = clamp(parsed.ownership);
    const depth = clamp(parsed.depth);
    const critical = clamp(parsed.critical);
    const clarity = clamp(parsed.clarity);
    const overall = clamp(
      parsed.overall ?? Math.round((ownership + depth + critical + clarity) / 4)
    );

    const validIntents = new Set(['delegation', 'curiosity', 'collaborative', 'verification']);
    const intent = validIntents.has(parsed.intent ?? '')
      ? (parsed.intent as LiveScore['intent'])
      : 'unknown';

    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.filter((s): s is string => typeof s === 'string').slice(0, 3)
      : [];

    const result = { ownership, depth, critical, clarity, overall, intent, suggestions };
    console.log('[AskBetter:bg] Ollama score parsed successfully:', result);
    return result;
  } catch (err) {
    console.log(
      '[AskBetter:bg] Ollama fetch error:',
      err instanceof Error ? `${err.name}: ${err.message}` : err
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Message listeners
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type === 'SCORE_UPDATE') {
    latestScore = message.score;
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'PROMPT_SUBMITTED') {
    latestScore = message.score;
    console.log('[AskBetter] Prompt submitted:', {
      length: message.text.length,
      score: message.score.overall,
      intent: message.score.intent,
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'OLLAMA_SCORE') {
    // Proxy the Ollama fetch and return the result asynchronously
    fetchOllamaScore(message.text, message.heuristic).then((score) => {
      sendResponse({ score });
    });
    return true; // keep message channel open for async response
  }

  sendResponse({ ok: true });
  return true;
});

// Handle popup requesting the latest score
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_LATEST_SCORE') {
    sendResponse({ score: latestScore });
  }
  return true;
});
