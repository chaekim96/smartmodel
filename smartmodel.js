#!/usr/bin/env node
// SmartModel — a model router for Claude Code ("OpenRouter, built into Claude").
//
// Runs as a UserPromptSubmit hook. Before Claude acts on a prompt, it scores the
// task's effort, recommends the cheapest model that can handle it, and (when it
// isn't sure) makes Claude stop and ask you which model to run on.
//
//   node smartmodel.js hook              # UserPromptSubmit entrypoint (reads JSON on stdin)
//   node smartmodel.js pick              # PostToolUse(AskUserQuestion) entrypoint: records your pick
//   node smartmodel.js classify "<text>" # dry-run the scorer
//   node smartmodel.js on | off | status
//   node smartmodel.js mode smart|ask|auto|block
//   node smartmodel.js min <chars>       # ignore prompts shorter than this
//   node smartmodel.js calibrate [--apply]  # tune thresholds from your recorded picks

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const CONFIG_PATH = path.join(DIR, 'config.json');
const LOG_PATH = path.join(DIR, 'decisions.log');

const DEFAULT_CONFIG = {
  enabled: true,
  // smart – auto-route when the score is clearly inside a tier, ask when it's
  //         within `margin` points of a threshold (default)
  // ask   – Claude pauses and asks which model to use
  // auto  – Claude routes to the recommended model without asking
  // block – the hook rejects the prompt and tells you to /model switch first
  //         (zero tokens spent by the current model)
  mode: 'smart',
  // Score at which each tier starts (haiku below `sonnet`). `calibrate` tunes these.
  thresholds: { sonnet: 20, opus: 45, fable: 85 },
  margin: 10, // smart mode: min distance from the nearest threshold to skip the question
  minChars: 25,
  // Mid-task: if this session ran a prompt within this many minutes, don't offer a cheaper
  // model (a cold subagent re-reads context the session already has). Upgrades still ask. 0 = off.
  midTaskMinutes: 30,
  useLLMClassifier: true, // uses Haiku when ANTHROPIC_API_KEY is set
  classifierModel: 'claude-haiku-4-5-20251001',
};

// Cheapest → most capable. `agent` is the Agent tool's `model` value.
const TIERS = [
  { key: 'haiku',  label: 'Haiku 4.5',  agent: 'haiku',  cost: '$',    effort: 'low',
    fit: 'lookups, renames, small edits, git/shell chores, quick explanations' },
  { key: 'sonnet', label: 'Sonnet 5.5', agent: 'sonnet', cost: '$$',   effort: 'medium',
    fit: 'everyday features, bug fixes, tests, single-module refactors' },
  { key: 'opus',   label: 'Opus 5.5',   agent: 'opus',   cost: '$$$',  effort: 'high',
    fit: 'multi-file changes, tricky debugging, design decisions' },
  { key: 'fable',  label: 'Fable 5.1',  agent: 'fable',  cost: '$$$$', effort: 'xhigh',
    fit: 'architecture, from-scratch systems, deep research, hard reasoning' },
];
const tierByKey = Object.fromEntries(TIERS.map(t => [t.key, t]));

// ---------- config ----------
function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  const cfg = { ...DEFAULT_CONFIG, ...c, thresholds: { ...DEFAULT_CONFIG.thresholds, ...c.thresholds } };
  const t = cfg.thresholds;
  if (!(t.sonnet < t.opus && t.opus < t.fable)) cfg.thresholds = { ...DEFAULT_CONFIG.thresholds }; // keep ordered
  return cfg;
}
function saveConfig(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n'); }

// ---------- heuristic scorer ----------
const SIGNALS = [
  // [regex, points, reason]
  [/\b(architect(ure)?|system design|design (a|the) system)\b/i, 30, 'architecture'],
  [/\b(from scratch|greenfield|(build|make|create) (me )?(an?|the) ([\w-]+ ){0,3}(app|tool|service|platform|site|website|mod|plugin|extension|cli|game|agent|bot|dashboard|system))\b/i, 25, 'new build'],
  [/\b(research|investigate|compare (options|approaches)|compare [^.]{0,40}\bvs\.?|trade-?offs?)\b/i, 18, 'research / tradeoffs'],
  [/\b(evaluate|grade|assess|analy[sz]e)\b/i, 6, 'evaluate / analyze'], // judging fit or a page, not deep research (was +18 with research)
  [/\b(refactor|migrat(e|ion)|rewrite|port (it|this|to))\b/i, 20, 'refactor / migration'],
  [/\b(entire|whole|across (the|my|all)|every file|all (the )?files|codebase|repo-?wide|end[- ]to[- ]end)\b/i, 18, 'wide scope'],
  [/\b(debug|race condition|deadlock|memory leak|flaky|intermittent|root cause|segfault|why (does|is) .* (fail|break))\b/i, 24, 'debugging'],
  [/\b(security|vulnab|auth(entication|orization)?|encrypt|concurren|distributed|scal(e|ability)|performance|optimi[sz]e)\b/i, 14, 'high-stakes domain'],
  [/\b(implement|feature|integrat(e|ion)|api|endpoint|database|schema|pipeline|deploy)\b/i, 10, 'implementation'],
  [/\b(algorithm|prove|proof|complexity|math|model training|fine-?tune)\b/i, 14, 'hard reasoning'],
  [/\b(plan|roadmap|spec|requirements|strategy)\b/i, 8, 'planning'],
  [/\b(audit|assess(ment)?|critique|code review)\b/i, 8, 'audit / review'],
  [/\b(write|add|create|make|build|fix|update|change)\b/i, 6, 'makes changes'],
  // writing / career work is quality-sensitive (and `heuristic` floors it at Sonnet), and
  // links mean fetching and reading pages: both need more than a cold Haiku.
  [/\b(cover letter|r[eé]sum[eé]|cv|essay|memo|e-?mail|draft|bullets?|linkedin|pitch|case stud(y|ies)|referrals?|outreach|recruiter|tagline)\b/i, 5, 'writing / career'],
  [/https?:\/\/\S+/i, 3, 'url / external page'],
  // cheap signals
  [/\b(typo|spelling|rename|reformat|format|lint|indent|whitespace|comment out)\b/i, -18, 'cosmetic edit'],
  [/\b(git (status|log|diff|add|commit|push|pull)|commit (this|it|these)|push (it|this)|(sync|merge|rebase)\b[^.]{0,30}\b(main|master|origin))\b/i, -16, 'git chore'],
  [/\b(what is|what's|where is|which file|print|cat|ls|find the|list (the |all )?files)\b/i, -10, 'lookup'],
  [/\b(quick(ly)?|simple|small|tiny|just (a|an|the)|one-?liner|minor)\b/i, -10, 'self-described small'],
  [/\b(explain|summari[sz]e|translate|convert|tl;?dr)\b/i, -6, 'explain / transform'],
];

// Compound requests ("add X and push it", "screenshot, write the README, then commit") are
// bigger than any one clause: a trailing chore doesn't make them chores (see `heuristic`).
const WORK_VERB_RE = /\b(add|create|write|build|make|generate|export|screenshot|install|draft|implement|fix|update|scan|edit|take|set up|deploy|mock up|restyle|rewrite|publish|upload|test)\b/gi;
const GIT_VERB_RE = /\b(push|commit|sync|merge)\b/gi;
const CONNECT_RE = /\b(and|then|also|plus|after that)\b|[,;+]/i;
const CHORE_REASONS = ['git chore', 'lookup', 'self-described small'];

// [min words, points] — first match wins. Longer prompts usually carry more
// requirements; very short ones are usually follow-ups or one-off asks.
const LENGTH_POINTS = [
  [251, 18], // spec-sized brief
  [121, 12], // multi-paragraph request
  [61, 6],   // detailed ask
  [12, 0],   // ordinary prompt
  [0, -4],   // terse one-liner (was -8: short follow-ups like "yes, apply the edit" still need context)
];

function tierForScore(score, th) {
  return score < th.sonnet ? 'haiku' : score < th.opus ? 'sonnet' : score < th.fable ? 'opus' : 'fable';
}
function thresholdDistance(score, th) { return Math.min(...Object.values(th).map(v => Math.abs(score - v))); }

function heuristic(prompt, th = DEFAULT_CONFIG.thresholds) {
  const reasons = [];
  let score = 24; // neutral prior: Sonnet territory. Only an explicit cheap signal (typo, git, lookup) reaches Haiku
  // Signals read the instruction, not what was pasted after it or the words inside a link
  // (a job URL containing "strategy" is not a planning request).
  const head = prompt.replace(/https?:\/\/\S+/g, ' ').slice(0, 600);
  const hits = SIGNALS.filter(([re]) => re.test(re.source.startsWith('https?') ? prompt : head));
  const has = why => hits.some(h => h[2] === why);

  const distinct = (re, text) => new Set((text.match(re) || []).map(w => w.toLowerCase()));
  const workVerbs = distinct(WORK_VERB_RE, head), gitVerbs = distinct(GIT_VERB_RE, head);
  const nVerbs = workVerbs.size + gitVerbs.size;
  const compound = nVerbs >= 2 && CONNECT_RE.test(head);
  // Work beside a chore waives the chore penalty: git/lookup/"small" are the last step, not the task.
  const workAlongside = workVerbs.size >= 1 && (compound || has('writing / career') || has('url / external page'));

  for (const [re, pts, why] of hits) {
    if (workAlongside && CHORE_REASONS.includes(why)) { reasons.push(`0 ${why} (waived: part of a bigger request)`); continue; }
    score += pts; reasons.push(`${pts > 0 ? '+' : ''}${pts} ${why}`);
  }
  if (compound) {
    const pts = nVerbs >= 3 ? 10 : 6;
    score += pts; reasons.push(`+${pts} compound request (${nVerbs} actions)`);
  }

  const words = prompt.trim().split(/\s+/).length;
  let lenPts = LENGTH_POINTS.find(([min]) => words >= min)[1];
  if (lenPts < 0 && (workVerbs.size >= 1 || hits.some(h => h[1] >= 10))) lenPts = 0; // short but carries real action
  if (lenPts) { score += lenPts; reasons.push(`${lenPts > 0 ? '+' : ''}${lenPts} ${words} words`); }

  const files = new Set(prompt.match(/[\w./-]+\.(js|ts|tsx|jsx|py|go|rs|java|rb|swift|kt|c|cpp|h|css|html|md|json|ya?ml|sql|sh)\b/g) || []);
  if (files.size >= 3) { score += 12; reasons.push(`+12 ${files.size} files named`); }
  if (/```|Traceback|Error:|Exception|at .+:\d+:\d+/.test(prompt)) { score += 8; reasons.push('+8 code / stack trace'); }
  const steps = (prompt.match(/^\s*(\d+[.)]|[-*•])\s+/gm) || []).length;
  if (steps >= 3) { score += 10; reasons.push(`+10 ${steps}-step list`); }

  // Writing and career work (resume, cover letter, email) is judged on quality: never Haiku,
  // unless it is a pure cosmetic fix ("fix the typo in my cover letter").
  if (has('writing / career') && !has('cosmetic edit') && score < th.sonnet) {
    score = th.sonnet; reasons.push(`floor ${th.sonnet} writing is never Haiku`);
  }

  score = Math.max(0, Math.min(100, score));
  return { score, key: tierForScore(score, th), reasons, source: 'heuristic' };
}

// ---------- optional LLM scorer (Haiku) ----------
async function llmClassify(prompt, model) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 150,
        system:
          'You route coding-agent tasks to the cheapest capable model. Tiers: ' +
          TIERS.map(t => `${t.key} (${t.fit})`).join('; ') +
          '. Reply with ONLY compact JSON: {"tier":"haiku|sonnet|opus|fable","score":0-100,"why":"<12 words"}',
        messages: [{ role: 'user', content: prompt.slice(0, 6000) }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (!tierByKey[j.tier]) return null;
    return { score: Number(j.score) || 0, key: j.tier, reasons: [j.why], source: 'haiku-classifier', confident: true };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function classify(prompt, cfg) {
  return (cfg.useLLMClassifier && (await llmClassify(prompt, cfg.classifierModel))) || heuristic(prompt, cfg.thresholds);
}

// ---------- helpers ----------
const SKIP_RE = /^\s*(\/|!|#)|^\s*(y(es)?|no?|ok(ay)?|sure|thanks?( you)?|ty|go( ahead)?|continue|do it|proceed|stop|cancel|lgtm|looks good|perfect|great|nice|cool)[.! ]*$/i;
const INLINE_SKIP = /\bsm:skip\b/i;
const INLINE_FORCE = /\bsm:(haiku|sonnet|opus|fable)\b/i;
// Harness-injected turns (subagent hand-backs, reminders, notifications, and
// `!` shell commands echoed back as <bash-input>/<bash-stdout>) also arrive as
// UserPromptSubmit; they aren't new tasks from the user.
const HARNESS_RE = /^\s*(<(agent-message|system-reminder|task-notification|ci-monitor-event|bash-input|bash-stdout|bash-stderr)\b|\[Subagent hand-back\])/i;

// "No task" detector: short acknowledgments / thanks / reactions that ask for nothing
// ("cool, glad that's on the readme"). Deliberately conservative: it only fires when
// there IS ack language and NO sign of a request. When unsure, it does not skip.
const NO_TASK_MAX_WORDS = 15;
const ACK_RE = /\b(thanks?|thank you|thx|ty|ok(ay)?|cool|nice|great|awesome|perfect|excellent|neat|sweet|wow|good|sounds good|got it|gotcha|makes sense|understood|noted|glad|love (it|that)|appreciate|lgtm|yep|yup)\b/i;
// Anything that reads as a request, question, continuation, or bare approval
// ("yes" / "do it" / "go for it" authorize work, so they are never "no task").
const REQUEST_RE = new RegExp('\\?|\\b(' + [
  'fix', 'add', 'make', 'merge', 'update', 'change', 'create', 'run', 'check', 'write', 'remove', 'delete',
  'deploy', 'build', 'push', 'pull', 'commit', 'install', 'implement', 'refactor', 'rename', 'set', 'open',
  'show', 'tell', 'explain', 'list', 'find', 'search', 'look', 'read', 'send', 'draft', 'edit', 'move', 'copy',
  'try', 'test', 'use', 'start', 'stop', 'apply', 'revert', 'undo', 'rewrite', 'generate', 'help', 'need',
  'want', "let'?s", 'should', 'could', 'would', 'can', 'will', 'please', 'plz', 'also', 'now', 'next', 'then',
  'but', 'still', 'instead', 'why', 'how', 'what', 'when', 'where', 'which', 'who', 'do', 'go', 'continue',
  'proceed', 'yes', 'yeah', 'sure', 'give', 'export', 'pdf', 'let', 'prep',
].join('|') + ')\\b', 'i');

function isNoTask(prompt) {
  const text = prompt.trim();
  if (text.split(/\s+/).length > NO_TASK_MAX_WORDS) return false;
  if (/[`<>\\/\d\n]/.test(text)) return false; // code, paths, tags, numbers (PR #1): not chit-chat
  return ACK_RE.test(text) && !REQUEST_RE.test(text);
}

// Conversational / meta question ("what would a next step be?", "should we use X?"): short,
// question-shaped, and no imperative verb up front. Claude just answers; no model picker.
const CONVO_MAX_WORDS = 40;
const CONVO_START_RE = /^\s*(what|why|how|should|would|could|is|are|does|do (you|i|we|they)|can you explain|what if|thoughts on)\b/i; // bare "do" is an imperative ("Do this role as well")
const IMPERATIVE_RE = /\b(build|make|create|add|fix|implement|write|refactor|update|change|delete|remove|run|deploy|install|set up|rewrite|rename|move|push|commit|merge|generate|edit|prep|prepare|draft|give|export|screenshot)\b/i;
function isConversational(prompt) {
  const text = prompt.trim();
  const words = text.split(/\s+/);
  if (words.length > CONVO_MAX_WORDS || text.includes('```')) return false;
  if (!(/\?\s*$/.test(text) || CONVO_START_RE.test(text))) return false;
  return !IMPERATIVE_RE.test(words.slice(0, 6).join(' '));
}

// Returns a reason string when this prompt shouldn't be routed at all, else null.
function skipReason(prompt, cfg, forced) {
  if (!cfg.enabled) return 'disabled';
  if (!prompt) return 'empty prompt';
  if (INLINE_SKIP.test(prompt)) return 'sm:skip tag';
  if (HARNESS_RE.test(prompt)) return 'harness / shell passthrough';
  if (forced) return null; // an sm:<model> tag always routes, even on a short prompt
  if (prompt.trim().length < cfg.minChars || SKIP_RE.test(prompt)) return 'short reply';
  if (isNoTask(prompt)) return 'no task';
  if (isConversational(prompt)) return 'conversational question';
  return null;
}

function currentModel(transcriptPath) {
  try {
    const st = fs.statSync(transcriptPath);
    const len = Math.min(st.size, 200_000);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const all = buf.toString('utf8').match(/"model":"(claude-[^"]+)"/g);
    if (all) return all[all.length - 1].slice(9, -1);
  } catch {}
  return null;
}

function tierOfModelId(id) {
  if (!id) return null;
  return TIERS.find(t => id.includes(t.key)) || null;
}

function log(entry) {
  try { fs.appendFileSync(LOG_PATH, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}

function readLog() {
  try { return fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
const newId = () => crypto.randomBytes(4).toString('hex');
// Decisions that opened a question carry an id; `pick` entries reference it.
const picksById = entries => Object.fromEntries(entries.filter(e => e.type === 'pick' && e.id).map(e => [e.id, e]));

// Escalation signal: a quick follow-up in the same session that sounds like "that wasn't good
// enough", right after a decision where you picked a model. Recorded only; nothing acts on it.
const ESCALATION_RE = /\b(again|redo|retry|try (it )?with|didn'?t work|still (broken|wrong|failing)|wrong|worse|use (opus|fable|sonnet)|bigger model)\b/i;
const ESCALATION_WINDOW_MS = 30 * 60 * 1000;
function escalationOf(session, prompt, entries) {
  if (!session || !ESCALATION_RE.test(prompt)) return {};
  const prev = [...entries].reverse().find(e => e.session === session && e.id && e.type !== 'pick');
  if (!prev || Date.now() - Date.parse(prev.t) >= ESCALATION_WINDOW_MS) return {};
  const pick = picksById(entries)[prev.id];
  return pick ? { escalation: true, prevPicked: pick.picked } : {};
}

const tierIndex = key => TIERS.findIndex(t => t.key === key);
// True when this session logged anything (prompt, skip, or pick) within cfg.midTaskMinutes.
function isMidTask(session, cfg) {
  const mins = Number(cfg.midTaskMinutes) || 0;
  if (!session || mins <= 0) return false;
  const last = [...readLog()].reverse().find(e => e.session === session);
  return !!last && Date.now() - Date.parse(last.t) < mins * 60 * 1000;
}

// `route` is 'auto' (no question) or 'ask'; smart mode picks one per prompt.
function routingInstructions(rec, cur, verdict, route, forced, note) {
  const curLabel = cur ? cur.label : 'the current model';
  const header =
    `[SmartModel] Effort analysis for this prompt — score ${verdict.score}/100 → ` +
    `recommended **${rec.label}** (effort: ${rec.effort}). Signals: ${verdict.reasons.join(', ') || 'none'}. ` +
    `Current session model: ${curLabel}.`;

  const delegateTo = agent =>
    `delegate the WHOLE task with the Agent tool ` +
    `(subagent_type "general-purpose", model "${agent}", run_in_background false). The subagent starts cold, ` +
    `so its prompt must be self-contained: the user's request verbatim, the working directory, and any ` +
    `relevant facts from this conversation. Then relay its result faithfully.`;
  const delegate = `To run on a model other than the current one, ${delegateTo('<choice>')} ` +
    `If they choose the current model, just do the task yourself.`;
  const sameModel = cur && cur.key === rec.key;

  if (forced) {
    return `${header}\nThe user forced model "${rec.key}" with an sm: tag. Do not ask. ` +
      (sameModel ? 'Do the task yourself.' : `To run it, ${delegateTo(rec.agent)}`);
  }
  if (route === 'auto') {
    return `${header}\nSmartModel is routing automatically${note ? ` (${note})` : ''}: do not ask. In one short line tell the user which model ` +
      `you're routing to and why, then ` + (sameModel ? 'do the task yourself.' : delegateTo(rec.agent));
  }

  const ordered = [rec, ...TIERS.filter(t => t.key !== rec.key)];
  const opts = ordered.map((t, i) =>
    `  ${i + 1}. label "${t.label}${i === 0 ? ' (Recommended)' : ''}${cur && cur.key === t.key ? ' · current' : ''}" — ` +
    `description "${t.cost} · ${t.fit}"`).join('\n');

  return `${header}
BEFORE doing anything else (no file reads, no edits, no commands, no planning), STOP and call AskUserQuestion
once with a single question:
  question: "SmartModel rates this ${rec.effort}-effort (score ${verdict.score}/100). Which model should run it?"
  header: "Model"
  multiSelect: false
  options (exactly 4, in this order):
${opts}
Keep any text before the question to one line. After the user answers, act on their choice.
${delegate}
If the user picks "Other" and says to skip or stay, do the task yourself.`;
}

// ---------- hook ----------
async function runHook() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let data = {};
  try { data = JSON.parse(input); } catch {}
  const prompt = String(data.prompt || '');
  const cfg = loadConfig();

  const forcedMatch = prompt.match(INLINE_FORCE);
  const skip = skipReason(prompt, cfg, forcedMatch);
  if (skip) {
    // Log the judgment-call skips so a wrong "no task" is visible in decisions.log.
    if (['no task', 'continuation', 'harness / shell passthrough', 'conversational question'].includes(skip)) log({ session: data.session_id, skipped: skip, prompt: prompt.slice(0, 120) });
    return;
  }

  let cur = tierOfModelId(currentModel(data.transcript_path)), curGuess = false;
  if (!cur) { // brand-new session: the transcript has no assistant turn yet, so assume the last model seen
    const last = [...readLog()].reverse().find(e => e.current && !e.curGuess);
    if (last) { cur = tierByKey[last.current] || null; curGuess = !!cur; }
  }
  let verdict, rec;
  if (forcedMatch) {
    rec = tierByKey[forcedMatch[1].toLowerCase()];
    verdict = { score: '—', key: rec.key, reasons: ['forced by user'], source: 'forced' };
  } else {
    verdict = await classify(prompt, cfg);
    rec = tierByKey[verdict.key];
  }
  const entry = { session: data.session_id, current: cur?.key, rec: rec.key, score: verdict.score, source: verdict.source, mode: cfg.mode, prompt: prompt.slice(0, 120) };
  if (curGuess) entry.curGuess = true;
  Object.assign(entry, escalationOf(data.session_id, prompt, readLog()));

  // Mid-task downgrade: handing a follow-up to a cheaper cold subagent costs more than it saves.
  if (!forcedMatch && cur && isMidTask(data.session_id, cfg) && tierIndex(rec.key) < tierIndex(cur.key)) {
    log({ ...entry, skipped: 'mid-task' });
    return;
  }

  // Claude would just do it anyway, so a question is pure friction. (sm: tags still win.)
  if (!forcedMatch && cur && cur.key === rec.key) {
    log({ ...entry, skipped: 'same as current model' });
    return;
  }

  // smart: confident (clear of every threshold, or an LLM verdict) → auto; borderline → ask.
  let route = cfg.mode === 'auto' ? 'auto' : 'ask', note = '';
  if (cfg.mode === 'smart' && !forcedMatch) {
    const dist = typeof verdict.score === 'number' ? thresholdDistance(verdict.score, cfg.thresholds) : 0;
    if (verdict.confident || dist >= cfg.margin) {
      route = 'auto';
      note = verdict.confident ? 'confident classifier verdict' : `confident: score ${verdict.score} is ${dist} pts from the nearest cutoff`;
      entry.margin = dist;
    } else entry.margin = dist;
  }
  entry.id = newId();
  entry.route = forcedMatch ? 'forced' : cfg.mode === 'block' ? 'block' : route;
  log(entry);

  if (cfg.mode === 'block' && !forcedMatch && (!cur || cur.key !== rec.key)) {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason:
        `SmartModel: effort score ${verdict.score}/100 → recommended ${rec.label} (${rec.cost}, effort ${rec.effort}). ` +
        `You're on ${cur ? cur.label : 'another model'}. Switch with /model ${rec.key} and resend, ` +
        `or resend with "sm:skip" to stay, or "sm:<model>" to force one.`,
    }));
    return;
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: routingInstructions(rec, cur, verdict, route, !!forcedMatch, note),
    },
  }));
}

// ---------- pick (PostToolUse on AskUserQuestion) ----------
// Records which model you chose. The shape of tool_response is undocumented, so the answer is
// dug out defensively. Never blocks, never prints: any failure just exits quietly.
const TIER_WORD_RE = /haiku|sonnet|opus|fable/i;
function answerCandidates(resp, question) {
  const out = [];
  const flat = v => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(flat)
    : v && typeof v === 'object' ? Object.values(v).flatMap(flat) : [];
  if (resp && typeof resp === 'object' && resp.answers != null) out.push(flat(resp.answers).join(' '));
  const raw = typeof resp === 'string' ? resp : JSON.stringify(resp || '');
  const m = raw.match(/SmartModel rates[^"]*?\\?"\s*[=:]\s*\\?"([^"\\]*)/); // "<question>"="<answer>"
  if (m) out.push(m[1]);
  return out.filter(a => a.trim());
}
async function runPick() {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const data = JSON.parse(input);
    if (!JSON.stringify(data.tool_input || '').includes('SmartModel rates')) return;
    const resp = data.tool_response;
    let raw = null, picked = null;
    for (const a of answerCandidates(resp, data.tool_input)) {
      raw = raw ?? a;
      const w = a.match(TIER_WORD_RE);
      if (w) { picked = w[0].toLowerCase(); raw = a; break; }
    }
    if (!picked && raw == null) { // last resort: a single tier word anywhere in the response
      const words = new Set((JSON.stringify(resp || '').match(/haiku|sonnet|opus|fable/gi) || []).map(w => w.toLowerCase()));
      if (words.size !== 1) return;
      picked = [...words][0];
    }
    const entries = readLog();
    const done = picksById(entries);
    const dec = [...entries].reverse().find(e => e.session === data.session_id && e.id && e.type !== 'pick' && !e.skipped && !done[e.id]);
    if (!dec) return;
    // "stayed" = kept the current model. That can mean "don't switch" rather than "this needs X",
    // so calibrate treats it separately from a deliberate choice.
    const stayed = !!picked && (/·\s*current/i.test(String(raw)) || picked === dec.current);
    log(picked
      ? { type: 'pick', session: data.session_id, id: dec.id, picked, override: picked !== dec.rec, stayed }
      : { type: 'pick', session: data.session_id, id: dec.id, picked: 'other', override: true, raw: String(raw).slice(0, 120) });
  } catch {}
}

// ---------- calibrate ----------
const CAL_RADIUS = 15, CAL_MIN_SAMPLES = 5, CAL_STEP = 5;
const TIER_KEYS = TIERS.map(t => t.key);
function joinPicks(entries) {
  const picks = picksById(entries);
  const decisions = entries.filter(e => e.type !== 'pick' && e.id && !e.skipped);
  return { decisions, joined: decisions.filter(d => picks[d.id]).map(d => ({ ...d, pick: picks[d.id] })) };
}
// Older picks have no `stayed` field; infer it from the decision's current model.
const isStay = d => d.pick.stayed ?? (!!d.current && d.pick.picked === d.current);
// A stay that disagrees with the recommendation is ambiguous ("don't switch" vs "needs this tier").
const isAmbiguous = d => isStay(d) && d.pick.picked !== d.rec;
const overrideRate = joined => joined.length ? Math.round(100 * joined.filter(d => d.pick.picked !== d.rec).length / joined.length) : null;
const pct = n => n === null || n === undefined ? 'n/a' : n + '%';
const choiceOverrideRate = joined => overrideRate(joined.filter(d => !isAmbiguous(d)));

function calibrate(apply) {
  const cfg = loadConfig();
  const { decisions, joined } = joinPicks(readLog());
  const lines = [`SmartModel calibrate: ${decisions.length} routed decisions, ${joined.length} with a recorded pick`];
  if (joined.length) {
    const cols = [...TIER_KEYS, 'other'];
    lines.push('  recommended \\ picked  ' + cols.map(c => c.padStart(6)).join(' '));
    for (const r of TIER_KEYS) {
      const row = joined.filter(d => d.rec === r);
      if (row.length) lines.push('  ' + r.padEnd(20) + cols.map(c => String(row.filter(d => d.pick.picked === c).length).padStart(6)).join(' '));
    }
    const amb = joined.filter(isAmbiguous).length;
    lines.push(`  override rate ${overrideRate(joined)}% · ${amb} stayed on current model instead (ignored below) · ` +
      `override rate on deliberate choices ${pct(choiceOverrideRate(joined))} · escalations flagged: ${decisions.filter(d => d.escalation).length}`);
  }
  const th = { ...cfg.thresholds };
  const names = ['sonnet', 'opus', 'fable'];
  const notes = [];
  for (const name of names) {
    const T = cfg.thresholds[name];
    const near = joined.filter(d => typeof d.score === 'number' && Math.abs(d.score - T) <= CAL_RADIUS && tierByKey[d.pick.picked] && !isAmbiguous(d));
    if (near.length < CAL_MIN_SAMPLES) { notes.push(`  ${name} (${T}): ${near.length} picks within ±${CAL_RADIUS}, need ${CAL_MIN_SAMPLES}: no change`); continue; }
    const idx = k => TIER_KEYS.indexOf(k);
    const up = near.filter(d => idx(d.pick.picked) > idx(d.rec)).length;
    const down = near.filter(d => idx(d.pick.picked) < idx(d.rec)).length;
    let delta = 0;
    if (up > down && (up - down) / near.length >= 0.2) delta = -CAL_STEP;      // you go bigger: start the tier sooner
    else if (down > up && (down - up) / near.length >= 0.2) delta = CAL_STEP;  // you go smaller: start it later
    const next = Math.max(5, Math.min(95, T + delta));
    const i = names.indexOf(name);
    const lo = i > 0 ? th[names[i - 1]] : 0, hi = i < 2 ? cfg.thresholds[names[i + 1]] : 100;
    const ok = delta && next !== T && next > lo && next < hi;
    if (ok) th[name] = next;
    notes.push(`  ${name} (${T}): ${near.length} picks nearby, ${up} higher / ${down} lower than recommended → ` +
      (ok ? `${T} → ${next}` : delta ? 'blocked by ordering/limits, no change' : 'no change'));
  }
  lines.push(...notes);
  const changed = names.some(n => th[n] !== cfg.thresholds[n]);
  if (joined.length < CAL_MIN_SAMPLES) lines.push(`Too little data to calibrate: ${joined.length} pick(s) recorded, need at least ${CAL_MIN_SAMPLES} near a boundary. Answer a few model questions first.`);
  else if (!changed) lines.push('No threshold changes suggested.');
  else if (apply) { cfg.thresholds = th; saveConfig(cfg); lines.push(`Applied thresholds: ${JSON.stringify(th)}`); }
  else lines.push(`Suggested thresholds: ${JSON.stringify(th)} (run with --apply to save)`);
  console.log(lines.join('\n'));
}

// ---------- CLI ----------
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const cfg = loadConfig();
  switch (cmd) {
    case 'hook': return runHook();
    case 'pick': return runPick();
    case 'calibrate': return calibrate(rest.includes('--apply'));
    case 'classify': {
      const text = rest.join(' ');
      const skip = skipReason(text, cfg, text.match(INLINE_FORCE));
      if (skip) { console.log(`SKIPPED (${skip}): no model question would be injected`); return; }
      const v = await classify(text, cfg);
      const t = tierByKey[v.key];
      console.log(`${t.label} (${t.cost}, effort ${t.effort}) · score ${v.score} · ${v.source}\n  ${v.reasons.join('\n  ')}`);
      return;
    }
    case 'on': case 'off':
      cfg.enabled = cmd === 'on'; saveConfig(cfg); break;
    case 'mode':
      if (!['smart', 'ask', 'auto', 'block'].includes(rest[0])) { console.log('usage: mode smart|ask|auto|block'); process.exit(1); }
      cfg.mode = rest[0]; saveConfig(cfg); break;
    case 'min':
      cfg.minChars = Number(rest[0]) || DEFAULT_CONFIG.minChars; saveConfig(cfg); break;
    case 'status': case undefined: break;
    default:
      console.log('usage: smartmodel.js hook | pick | classify <text> | on | off | status | mode smart|ask|auto|block | min <n> | calibrate [--apply]');
      process.exit(1);
  }
  const c = loadConfig();
  const { decisions, joined } = joinPicks(readLog());
  const t = c.thresholds, rate = overrideRate(joined);
  console.log(`SmartModel: ${c.enabled ? 'ON' : 'OFF'} · mode ${c.mode} · ignores prompts < ${c.minChars} chars · ` +
    `classifier ${c.useLLMClassifier && process.env.ANTHROPIC_API_KEY ? 'Haiku (API key found)' : 'heuristic'} · ${readLog().filter(e => e.type !== 'pick').length} decisions logged\n` +
    `  thresholds sonnet ${t.sonnet} / opus ${t.opus} / fable ${t.fable} · margin ${c.margin} · ` +
    `${joined.length} picks recorded · override rate ${rate === null ? 'n/a' : rate + '%'}` +
    ` (${pct(choiceOverrideRate(joined))} excluding stays on the current model)`);
}

if (require.main === module) main();
else module.exports = { heuristic, skipReason, DEFAULT_CONFIG, isConversational, isNoTask, tierForScore };
