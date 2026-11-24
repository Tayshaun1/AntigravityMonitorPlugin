/**
 * Context Window & Token Throughput Sidecar Backend for Antigravity 2.0.
 *
 * Read-only inspection of local conversation transcripts:
 *   <appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 * Persists exact completion timestamps of turn-ending steps in:
 *   <ANTIGRAVITY_EXECUTABLE_DATA_DIR>/step_timings.json
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp, Response } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_VERSION = '3';
const ID_RE = /^[0-9a-f-]{8,}$/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const MODEL_CHANGE_RE = /changed setting `Model Selection` from .*? to ([^\n.]+)\.?/g;
const MAX_TIMING_ENTRIES = 2000;
const MAX_FINISH_DRIFT_MS = 10 * 60 * 1000;

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

// ---------------------------------------------------------------------------
// App data directory discovery (follows swarm_board pattern)
// ---------------------------------------------------------------------------

function findAppDataDirs() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
  }
  const candidates = [];
  const geminiRoot = join(homedir(), '.gemini');
  const defaultApp = join(geminiRoot, 'antigravity');
  if (existsSync(join(defaultApp, 'brain'))) {
    candidates.push(defaultApp);
  }
  try {
    for (const entry of readdirSync(geminiRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(geminiRoot, entry.name);
      if (dir !== defaultApp && existsSync(join(dir, 'brain'))) {
        candidates.push(dir);
      }
    }
  } catch {
    // Ignore unreadable ~/.gemini
  }
  return candidates;
}

function locateTranscript(convId) {
  if (!convId || !ID_RE.test(convId)) return null;
  for (const appData of findAppDataDirs()) {
    const p = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(p)) {
      return { appData, path: p };
    }
  }
  return null;
}

function listRecentConversations(limit = 15) {
  const seen = new Set();
  const items = [];
  for (const appData of findAppDataDirs()) {
    const brainDir = join(appData, 'brain');
    let entries = [];
    try {
      entries = readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name) || seen.has(entry.name)) continue;
      const tPath = join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        const st = statSync(tPath);
        if (st.isFile() && st.size > 0) {
          seen.add(entry.name);
          items.push({
            conversationId: entry.name,
            mtimeMs: st.mtimeMs,
            sizeBytes: st.size,
          });
        }
      } catch {
        // Skip conversations without transcripts
      }
    }
  }
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return items.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Persistent step completion timing cache (captures mtimeMs for final replies)
// ---------------------------------------------------------------------------

const timingsFilePath = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
  ? join(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, 'step_timings.json')
  : null;

const timingsMap = new Map();

function loadTimings() {
  if (!timingsFilePath || !existsSync(timingsFilePath)) return;
  try {
    const raw = JSON.parse(readFileSync(timingsFilePath, 'utf-8'));
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          timingsMap.set(k, v);
        }
      }
    }
  } catch {
    // Ignore corrupted cache file
  }
}

function flushTimings() {
  if (!timingsFilePath) return;
  try {
    while (timingsMap.size > MAX_TIMING_ENTRIES) {
      const oldestKey = timingsMap.keys().next().value;
      timingsMap.delete(oldestKey);
    }
    mkdirSync(dirname(timingsFilePath), { recursive: true });
    writeFileSync(timingsFilePath, JSON.stringify(Object.fromEntries(timingsMap)), 'utf-8');
  } catch {
    // Best-effort cache write
  }
}

loadTimings();

// ---------------------------------------------------------------------------
// Transcript analysis
// ---------------------------------------------------------------------------

const analysisCache = new Map(); // convId -> { key, data }

function parseMs(iso) {
  if (typeof iso !== 'string' || !iso) return NaN;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : NaN;
}

function extractModelName(steps) {
  let modelName = '默认模型 (Auto)';
  for (const step of steps) {
    if (step.type !== 'USER_INPUT' || typeof step.content !== 'string') continue;
    MODEL_CHANGE_RE.lastIndex = 0;
    let match;
    while ((match = MODEL_CHANGE_RE.exec(step.content)) !== null) {
      const candidate = match[1].trim().replace(/\.$/, '');
      if (candidate) modelName = candidate;
    }
  }
  return modelName;
}

function isModelResponseStep(step) {
  return (
    step &&
    step.source === 'MODEL' &&
    (Number.isFinite(step.input_tokens) ||
      Number.isFinite(step.cache_read_tokens) ||
      Number.isFinite(step.output_tokens))
  );
}

function stripMetadataTags(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .trim();
}

function computeComposition(steps, activeTokens, firstPromptTokens) {
  if (!activeTokens || activeTokens <= 0) {
    return { systemPct: 0, toolPct: 0, modelPct: 0, userPct: 0 };
  }

  let userChars = 0;
  let modelChars = 0;
  let toolChars = 0;
  let firstUserChars = 0;
  let seenFirstModel = false;

  for (const step of steps) {
    if (step.type === 'USER_INPUT') {
      const len = stripMetadataTags(step.content).length;
      userChars += len;
      if (!seenFirstModel) firstUserChars += len;
    } else if (isModelResponseStep(step)) {
      seenFirstModel = true;
      const contentLen = typeof step.content === 'string' ? step.content.length : 0;
      const thinkingLen = typeof step.thinking === 'string' ? step.thinking.length : 0;
      const toolCallsLen = Array.isArray(step.tool_calls)
        ? JSON.stringify(step.tool_calls).length
        : 0;
      modelChars += contentLen + thinkingLen + toolCallsLen;
    } else if (step.type === 'GENERIC') {
      toolChars += typeof step.content === 'string' ? step.content.length : 0;
    }
  }

  const approxInitialUserTokens = Math.round(firstUserChars / 3.5);
  const rawSystemTokens = Math.max(0, (firstPromptTokens || 0) - approxInitialUserTokens);
  const systemTokens = Math.min(activeTokens, rawSystemTokens);
  const dynamicTokens = Math.max(0, activeTokens - systemTokens);
  const totalDynamicChars = userChars + modelChars + toolChars;

  let toolTokens = 0;
  let modelTokens = 0;
  let userTokens = 0;
  if (totalDynamicChars > 0 && dynamicTokens > 0) {
    toolTokens = (dynamicTokens * toolChars) / totalDynamicChars;
    modelTokens = (dynamicTokens * modelChars) / totalDynamicChars;
    userTokens = (dynamicTokens * userChars) / totalDynamicChars;
  }

  const parts = [
    { key: 'systemPct', val: (systemTokens / activeTokens) * 100 },
    { key: 'toolPct', val: (toolTokens / activeTokens) * 100 },
    { key: 'modelPct', val: (modelTokens / activeTokens) * 100 },
    { key: 'userPct', val: (userTokens / activeTokens) * 100 },
  ];

  const out = {};
  let sum = 0;
  let maxIdx = 0;
  for (let i = 0; i < parts.length; i++) {
    const rounded = Math.round(parts[i].val * 10) / 10;
    out[parts[i].key] = rounded;
    sum += rounded;
    if (parts[i].val > parts[maxIdx].val) maxIdx = i;
  }
  const diff = Math.round((100 - sum) * 10) / 10;
  if (Math.abs(diff) > 0 && out[parts[maxIdx].key] + diff >= 0) {
    out[parts[maxIdx].key] = Math.round((out[parts[maxIdx].key] + diff) * 10) / 10;
  }
  return out;
}

function detectGenerationState(steps, fileMtimeMs) {
  if (steps.length === 0) {
    return { isGenerating: false, generatingSinceMs: null };
  }
  const lastStep = steps[steps.length - 1];
  if (lastStep.type === 'USER_INPUT') {
    const ts = parseMs(lastStep.created_at);
    return {
      isGenerating: true,
      generatingSinceMs: Number.isFinite(ts) ? ts : fileMtimeMs,
    };
  }
  if (lastStep.type === 'GENERIC') {
    let planner = null;
    let genericCountAfterPlanner = 0;
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (s.type === 'GENERIC') {
        genericCountAfterPlanner++;
      } else if (s.type === 'PLANNER_RESPONSE') {
        planner = s;
        break;
      } else if (s.type === 'USER_INPUT') {
        break;
      }
    }
    const toolCount = Array.isArray(planner?.tool_calls) ? planner.tool_calls.length : 0;
    if (planner && toolCount > 0 && genericCountAfterPlanner >= toolCount) {
      return {
        isGenerating: true,
        generatingSinceMs: Number.isFinite(fileMtimeMs) ? fileMtimeMs : parseMs(lastStep.created_at),
      };
    }
  }
  return { isGenerating: false, generatingSinceMs: null };
}

function collectSubagentTokens(steps, rootConvId, visited) {
  const subagentIds = new Set();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type !== 'PLANNER_RESPONSE' || !Array.isArray(s.tool_calls)) continue;
    const hasInvoke = s.tool_calls.some(
      (tc) => tc?.name === 'invoke_subagent' || tc?.name === 'send_message'
    );
    if (!hasInvoke) continue;
    for (let j = i + 1; j < steps.length; j++) {
      const next = steps[j];
      if (next.type === 'USER_INPUT' || next.type === 'PLANNER_RESPONSE') break;
      if (next.type !== 'GENERIC' || typeof next.content !== 'string') continue;
      UUID_RE.lastIndex = 0;
      let m;
      while ((m = UUID_RE.exec(next.content)) !== null) {
        const candidate = m[0].toLowerCase();
        if (candidate !== rootConvId.toLowerCase()) {
          subagentIds.add(candidate);
        }
      }
    }
  }

  let subagentTotalTokens = 0;
  let subagentCount = 0;
  for (const subId of subagentIds) {
    if (visited.has(subId)) continue;
    visited.add(subId);
    const loc = locateTranscript(subId);
    if (!loc) continue;
    try {
      const text = readFileSync(loc.path, 'utf-8');
      const lines = text.split('\n');
      let subTokens = 0;
      const subSteps = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === 'object') {
            subSteps.push(parsed);
            if (isModelResponseStep(parsed)) {
              subTokens +=
                (parsed.input_tokens || 0) +
                (parsed.cache_read_tokens || 0) +
                (parsed.output_tokens || 0);
            }
          }
        } catch {
          // Ignore incomplete trailing line
        }
      }
      if (subSteps.length > 0) {
        subagentCount += 1;
        subagentTotalTokens += subTokens;
        const nested = collectSubagentTokens(subSteps, subId, visited);
        subagentCount += nested.subagentCount;
        subagentTotalTokens += nested.subagentTotalTokens;
      }
    } catch {
      // Ignore unreadable subagent transcript
    }
  }
  return { subagentCount, subagentTotalTokens };
}

function analyzeConversation(convId) {
  const loc = locateTranscript(convId);
  if (!loc) return null;

  let st;
  try {
    st = statSync(loc.path);
  } catch {
    return null;
  }

  const cacheKey = `${st.mtimeMs}:${st.size}`;
  const cached = analysisCache.get(convId);
  if (cached && cached.key === cacheKey) {
    return cached.data;
  }

  let raw;
  try {
    raw = readFileSync(loc.path, 'utf-8');
  } catch {
    return null;
  }

  const steps = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') {
        steps.push(parsed);
      }
    } catch {
      // Skip torn final line while transcript is actively streaming/flushing
    }
  }

  const modelName = extractModelName(steps);
  const { isGenerating, generatingSinceMs } = detectGenerationState(steps, st.mtimeMs);

  // If the last valid parsed step is a model response step with output tokens,
  // record the file mtimeMs as its completion timestamp.
  let timingsDirty = false;
  if (steps.length > 0) {
    const lastStep = steps[steps.length - 1];
    if (isModelResponseStep(lastStep) && (lastStep.output_tokens || 0) > 0) {
      const startMs = parseMs(lastStep.created_at);
      const timingKey = `${convId}:${lastStep.step_index ?? steps.length - 1}`;
      if (
        Number.isFinite(startMs) &&
        st.mtimeMs >= startMs &&
        st.mtimeMs - startMs <= MAX_FINISH_DRIFT_MS &&
        !timingsMap.has(timingKey)
      ) {
        timingsMap.set(timingKey, st.mtimeMs);
        timingsDirty = true;
      }
    }
  }
  if (timingsDirty) {
    flushTimings();
  }

  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let measuredOutputTokens = 0;
  let measuredDurationSec = 0;
  let peakOutputTps = 0;
  let peakContextTokens = 0;
  let compactionCount = 0;
  let prevContextTokens = 0;
  let firstPromptTokens = 0;

  const modelSteps = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!isModelResponseStep(step)) continue;

    const inputTokens = Number(step.input_tokens) || 0;
    const cacheReadTokens = Number(step.cache_read_tokens) || 0;
    const outputTokens = Number(step.output_tokens) || 0;
    const promptTokens = inputTokens + cacheReadTokens;
    const contextTokens = promptTokens + outputTokens;
    const cacheHitRate =
      promptTokens > 0 ? Math.round((cacheReadTokens / promptTokens) * 1000) / 10 : 0;

    if (firstPromptTokens === 0 && promptTokens > 0) {
      firstPromptTokens = promptTokens;
    }

    if (prevContextTokens > 20000 && contextTokens < prevContextTokens * 0.72) {
      compactionCount += 1;
    }
    prevContextTokens = contextTokens;
    if (contextTokens > peakContextTokens) {
      peakContextTokens = contextTokens;
    }

    totalInputTokens += inputTokens;
    totalCacheReadTokens += cacheReadTokens;
    totalOutputTokens += outputTokens;

    const startMs = parseMs(step.created_at);
    const stepIdx = step.step_index ?? i;
    const timingKey = `${convId}:${stepIdx}`;
    let endMs = null;

    if (i + 1 < steps.length) {
      const nextStep = steps[i + 1];
      if (nextStep.type !== 'USER_INPUT') {
        // When parallel tool results arrive, take the earliest timestamp in the
        // immediate non-MODEL / non-USER_INPUT batch (or next MODEL step if none).
        let earliest = Infinity;
        for (let j = i + 1; j < steps.length; j++) {
          const cand = steps[j];
          if (cand.type === 'USER_INPUT') break;
          const t = parseMs(cand.created_at);
          if (Number.isFinite(t) && t < earliest) {
            earliest = t;
          }
          if (isModelResponseStep(cand)) break;
        }
        if (Number.isFinite(earliest)) {
          endMs = earliest;
        }
      } else if (timingsMap.has(timingKey)) {
        endMs = timingsMap.get(timingKey);
      }
    } else if (timingsMap.has(timingKey)) {
      endMs = timingsMap.get(timingKey);
    }

    let durationSec = null;
    let outputTps = null;
    let totalTps = null;

    if (endMs != null && Number.isFinite(startMs) && outputTokens > 0) {
      durationSec = Math.max(0.5, (endMs - startMs) / 1000);
      outputTps = Math.round((outputTokens / durationSec) * 10) / 10;
      totalTps = Math.round(contextTokens / durationSec);
      measuredOutputTokens += outputTokens;
      measuredDurationSec += durationSec;
      if (outputTps > peakOutputTps) {
        peakOutputTps = outputTps;
      }
    }

    modelSteps.push({
      stepIndex: stepIdx,
      createdAt: step.created_at || null,
      contextTokens,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      cacheHitRate,
      durationSec: durationSec != null ? Math.round(durationSec * 10) / 10 : null,
      outputTps,
      totalTps,
      toolCount: Array.isArray(step.tool_calls) ? step.tool_calls.length : 0,
    });
  }

  const latest = modelSteps.length > 0 ? modelSteps[modelSteps.length - 1] : null;
  const activeTokens = latest ? latest.contextTokens : 0;
  const composition = computeComposition(steps, activeTokens, firstPromptTokens);

  let latestMeasured = null;
  for (let i = modelSteps.length - 1; i >= 0; i--) {
    if (modelSteps[i].outputTps != null) {
      latestMeasured = modelSteps[i];
      break;
    }
  }

  const avgOutputTps =
    measuredDurationSec > 0
      ? Math.round((measuredOutputTokens / measuredDurationSec) * 10) / 10
      : null;

  const visited = new Set([convId.toLowerCase()]);
  const { subagentCount, subagentTotalTokens } = collectSubagentTokens(steps, convId, visited);

  const data = {
    uiVersion: UI_VERSION,
    conversationId: convId,
    modelName,
    isGenerating,
    generatingSinceMs,
    lastUpdatedMs: st.mtimeMs,
    context: {
      activeTokens,
      uncachedInputTokens: latest ? latest.inputTokens : 0,
      cacheReadTokens: latest ? latest.cacheReadTokens : 0,
      lastOutputTokens: latest ? latest.outputTokens : 0,
      cacheHitRate: latest ? latest.cacheHitRate : 0,
      peakContextTokens,
      compactionCount,
      composition,
    },
    throughput: {
      latestOutputTps: latestMeasured ? latestMeasured.outputTps : null,
      latestOutputTokens: latestMeasured ? latestMeasured.outputTokens : null,
      latestDurationSec: latestMeasured ? latestMeasured.durationSec : null,
      latestTotalTps: latestMeasured ? latestMeasured.totalTps : null,
      latestStepIndex: latestMeasured ? latestMeasured.stepIndex : null,
      avgOutputTps,
      peakOutputTps: peakOutputTps > 0 ? peakOutputTps : null,
      measuredStepCount: modelSteps.filter((m) => m.outputTps != null).length,
    },
    sessionTotals: {
      totalInputTokens,
      totalCacheReadTokens,
      totalOutputTokens,
      stepCount: modelSteps.length,
      subagentCount,
      subagentTotalTokens,
    },
    recentSteps: modelSteps.slice(-24),
    etag: `${convId}|${st.mtimeMs}|${st.size}`,
  };

  if (analysisCache.size > 100) analysisCache.clear();
  analysisCache.set(convId, { key: cacheKey, data });
  return data;
}

// ---------------------------------------------------------------------------
// Sidecar HTTP Server
// ---------------------------------------------------------------------------

const app = new SidecarApp();

app.page(
  '/',
  () =>
    new Response(readFileSync(join(__dirname, 'index.html'), 'utf-8'), {
      contentType: 'text/html; charset=utf-8',
      headers: { 'Cache-Control': 'no-store' },
    })
);

for (const [route, [file, contentType]] of Object.entries(STATIC_ASSETS)) {
  app.api(
    route,
    () =>
      new Response(readFileSync(join(__dirname, file), 'utf-8'), {
        contentType,
        headers: { 'Cache-Control': 'no-store' },
      }),
    'GET'
  );
}

app.api(
  '/api/conversations',
  () => ({
    defaultConversationId: app.config.conversationId || null,
    conversations: listRecentConversations(15),
  }),
  'GET'
);

app.api(
  '/api/metrics',
  (data) => {
    const requested = typeof data.conversationId === 'string' ? data.conversationId.trim() : '';
    const conv =
      (requested && ID_RE.test(requested) && requested) ||
      (app.config.conversationId && ID_RE.test(app.config.conversationId) && app.config.conversationId) ||
      listRecentConversations(1)[0]?.conversationId ||
      '';

    if (!conv) {
      return {
        conversationId: null,
        error: '未找到本地对话日志（等待首次对话生成）',
      };
    }

    const metrics = analyzeConversation(conv);
    if (!metrics) {
      return {
        conversationId: conv,
        error: '当前会话尚未写入 transcript.jsonl',
      };
    }

    if (data.etag && data.etag === metrics.etag && !metrics.isGenerating) {
      return {
        uiVersion: UI_VERSION,
        conversationId: conv,
        unchanged: true,
        isGenerating: metrics.isGenerating,
        etag: metrics.etag,
      };
    }

    return metrics;
  },
  'GET'
);

app.run();
