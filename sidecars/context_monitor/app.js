(() => {
  const POLL_MS = 1200;
  const LIMIT_STORAGE_KEY = 'agy_telemetry_ctx_limit';
  const COMPACTION_WATERMARK = 135000;
  const $ = (id) => document.getElementById(id);

  const state = {
    etag: '',
    uiVersion: '',
    selectedConv: '',
    lastMetrics: null,
    limitTokens: loadSavedLimit(),
    conversationsLoadedAt: 0,
  };

  function loadSavedLimit() {
    try {
      const raw = localStorage.getItem(LIMIT_STORAGE_KEY);
      const val = Number(raw);
      if (Number.isFinite(val) && val >= 8000) return val;
    } catch {
      // Ignore storage access errors
    }
    return 1000000;
  }

  function saveLimit(val) {
    state.limitTokens = val;
    try {
      localStorage.setItem(LIMIT_STORAGE_KEY, String(val));
    } catch {
      // Ignore storage access errors
    }
  }

  // ---------- Theme Sync (matches swarm_board) ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f8fafc)';
    document.documentElement.appendChild(probe);
    let c = getComputedStyle(probe).color;
    probe.remove();
    if ((!c || c === 'rgba(0, 0, 0, 0)') && document.body) {
      c = getComputedStyle(document.body).backgroundColor;
    }
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- Formatting ----------
  function fmtTokens(n) {
    const num = Number(n) || 0;
    if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
    if (num >= 10000) return `${(num / 1000).toFixed(1)}k`;
    if (num >= 1000) return `${(num / 1000).toFixed(2)}k`;
    return num.toLocaleString('en-US');
  }

  function fmtLimit(n) {
    if (n === 1000000) return '1,000k';
    return `${Math.round(n / 1000).toLocaleString('en-US')}k`;
  }

  function fmtTime(ms) {
    if (!Number.isFinite(ms)) return '—';
    return new Date(ms).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  async function apiGet(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  // ---------- Controls Setup ----------
  function initLimitControls() {
    const select = $('limit-select');
    const customWrap = $('custom-limit-wrap');
    const customInput = $('custom-limit-input');
    const presets = ['1000000', '256000', '200000', '135000'];

    if (presets.includes(String(state.limitTokens))) {
      select.value = String(state.limitTokens);
      customWrap.classList.add('hidden');
    } else {
      select.value = 'custom';
      customInput.value = String(Math.round(state.limitTokens / 1000));
      customWrap.classList.remove('hidden');
    }

    select.addEventListener('change', () => {
      if (select.value === 'custom') {
        customWrap.classList.remove('hidden');
        const k = Math.max(8, Math.min(4096, Number(customInput.value) || 200));
        saveLimit(k * 1000);
      } else {
        customWrap.classList.add('hidden');
        saveLimit(Number(select.value));
      }
      if (state.lastMetrics) renderContextSection(state.lastMetrics);
    });

    customInput.addEventListener('input', () => {
      const k = Number(customInput.value);
      if (Number.isFinite(k) && k >= 8 && k <= 4096) {
        saveLimit(Math.round(k * 1000));
        if (state.lastMetrics) renderContextSection(state.lastMetrics);
      }
    });
  }

  function initCopyCompactButton() {
    const btn = $('copy-compact-btn');
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText('/compact');
        btn.textContent = '已复制 /compact';
      } catch {
        btn.textContent = '请输入 /compact';
      }
      setTimeout(() => {
        btn.textContent = '复制 /compact';
      }, 1600);
    });
  }

  function initConversationSelector() {
    const select = $('conv-select');
    const params = new URLSearchParams(location.search);
    const initialConv = window.sidecar?.conversationId || params.get('conversationId') || '';
    state.selectedConv = initialConv;

    select.addEventListener('change', () => {
      state.selectedConv = select.value;
      state.etag = '';
      pollMetrics(true);
    });
  }

  async function refreshConversations() {
    const now = Date.now();
    if (now - state.conversationsLoadedAt < 10000) return;
    state.conversationsLoadedAt = now;
    try {
      const res = await apiGet('/api/conversations');
      const select = $('conv-select');
      const hostConv =
        window.sidecar?.conversationId ||
        new URLSearchParams(location.search).get('conversationId') ||
        res.defaultConversationId ||
        '';
      const list = Array.isArray(res.conversations) ? res.conversations : [];
      const currentVal = state.selectedConv || hostConv;

      const options = [];
      if (hostConv) {
        options.push(`<option value="${esc(hostConv)}">当前会话 (${esc(hostConv.slice(0, 8))})</option>`);
      } else {
        options.push('<option value="">自动追踪最新会话</option>');
      }
      for (const item of list) {
        if (item.conversationId === hostConv) continue;
        const t = new Date(item.mtimeMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        options.push(
          `<option value="${esc(item.conversationId)}">${esc(item.conversationId.slice(0, 8))} · ${t}</option>`
        );
      }
      select.innerHTML = options.join('');
      if (currentVal && [...select.options].some((o) => o.value === currentVal)) {
        select.value = currentVal;
      }
    } catch {
      // Non-fatal
    }
  }

  // ---------- Rendering ----------
  function updateLiveStatus(m) {
    const pill = $('live-pill');
    const text = $('live-text');
    if (m?.isGenerating) {
      pill.classList.remove('idle');
      pill.classList.add('generating');
      const elapsedSec = m.generatingSinceMs
        ? Math.max(0, (Date.now() - m.generatingSinceMs) / 1000).toFixed(1)
        : '0.0';
      text.textContent = `推理生成中 · ${elapsedSec}s`;
    } else {
      pill.classList.remove('generating');
      pill.classList.add('idle');
      text.textContent = '实时监控';
    }
  }

  function renderContextSection(m) {
    const ctx = m.context || {};
    const tot = m.sessionTotals || {};
    const limit = state.limitTokens || 1000000;
    const active = ctx.activeTokens || 0;
    const pct = Math.min(999, (active / limit) * 100);

    $('ctx-active').textContent = fmtTokens(active);
    $('ctx-limit').textContent = fmtLimit(limit);
    $('ctx-pct').textContent = `${pct.toFixed(1)}%`;

    const bar = $('ctx-progressbar');
    bar.setAttribute('aria-valuenow', String(Math.min(100, Math.round(pct))));

    const cachePct = Math.min(100, ((ctx.cacheReadTokens || 0) / limit) * 100);
    const inPct = Math.min(Math.max(0, 100 - cachePct), ((ctx.uncachedInputTokens || 0) / limit) * 100);
    const outPct = Math.min(Math.max(0, 100 - cachePct - inPct), ((ctx.lastOutputTokens || 0) / limit) * 100);

    $('seg-cache').style.width = `${cachePct.toFixed(2)}%`;
    $('seg-input').style.width = `${inPct.toFixed(2)}%`;
    $('seg-output').style.width = `${outPct.toFixed(2)}%`;

    const marker = $('compaction-marker');
    if (limit > COMPACTION_WATERMARK) {
      marker.classList.remove('hidden');
      marker.style.left = `${((COMPACTION_WATERMARK / limit) * 100).toFixed(2)}%`;
    } else {
      marker.classList.add('hidden');
    }

    $('leg-cache').textContent = fmtTokens(ctx.cacheReadTokens);
    $('leg-input').textContent = fmtTokens(ctx.uncachedInputTokens);
    $('leg-output').textContent = fmtTokens(ctx.lastOutputTokens);

    $('m-cache-rate').textContent = `${(ctx.cacheHitRate || 0).toFixed(1)}%`;
    $('m-cache-sub').textContent = `${fmtTokens(ctx.cacheReadTokens)} 命中`;
    $('m-uncached').textContent = fmtTokens(ctx.uncachedInputTokens);
    $('m-total-in').textContent = `累计 ${fmtTokens(tot.totalInputTokens)}`;
    $('m-out').textContent = fmtTokens(ctx.lastOutputTokens);
    $('m-total-out').textContent = `累计 ${fmtTokens(tot.totalOutputTokens)}`;
    $('m-compaction').textContent = `${ctx.compactionCount || 0} 次`;
    $('m-subagents').textContent =
      tot.subagentCount > 0
        ? `${tot.subagentCount} 个 (${fmtTokens(tot.subagentTotalTokens)})`
        : '0 个子代理';

    $('comp-peak').textContent = `峰值 ${fmtTokens(ctx.peakContextTokens)}`;
    const comp = ctx.composition || {};
    $('comp-sys').style.width = `${comp.systemPct || 0}%`;
    $('comp-tool').style.width = `${comp.toolPct || 0}%`;
    $('comp-model').style.width = `${comp.modelPct || 0}%`;
    $('comp-user').style.width = `${comp.userPct || 0}%`;
    $('pct-sys').textContent = `${(comp.systemPct || 0).toFixed(0)}%`;
    $('pct-tool').textContent = `${(comp.toolPct || 0).toFixed(0)}%`;
    $('pct-model').textContent = `${(comp.modelPct || 0).toFixed(0)}%`;
    $('pct-user').textContent = `${(comp.userPct || 0).toFixed(0)}%`;
  }

  function renderThroughputSection(m) {
    const tp = m.throughput || {};
    const steps = Array.isArray(m.recentSteps) ? m.recentSteps : [];

    $('tps-step-count').textContent = `${tp.measuredStepCount || 0} 步已测速`;
    $('tps-latest').textContent = tp.latestOutputTps != null ? tp.latestOutputTps.toFixed(1) : '—';
    $('tps-latest-sub').textContent =
      tp.latestDurationSec != null
        ? `耗时 ${tp.latestDurationSec.toFixed(1)}s · 输出 ${fmtTokens(tp.latestOutputTokens)}`
        : '等待可测速步骤';

    $('tps-avg').textContent = tp.avgOutputTps != null ? tp.avgOutputTps.toFixed(1) : '—';
    $('tps-peak').textContent = tp.peakOutputTps != null ? tp.peakOutputTps.toFixed(1) : '—';
    $('tps-total-sub').textContent =
      tp.latestTotalTps != null ? `含预热 ${fmtTokens(tp.latestTotalTps)} tok/s` : '总吞吐 —';

    // Sparkline (last 20 steps)
    const slice = steps.slice(-20);
    const container = $('spark-bars');
    if (slice.length === 0) {
      container.innerHTML = '';
      return;
    }

    const maxTps = Math.max(10, ...slice.map((s) => s.outputTps || 0));
    container.innerHTML = slice
      .map((s) => {
        if (s.outputTps == null) {
          const tip = `#${s.stepIndex} · 输出 ${s.outputTokens} tok · 耗时未记录`;
          return `<div class="spark-bar unmeasured" data-tip="${esc(tip)}" title="${esc(tip)}"></div>`;
        }
        const h = Math.max(12, Math.round((s.outputTps / maxTps) * 100));
        const tip = `#${s.stepIndex} · ${s.outputTps.toFixed(1)} tok/s · 输出 ${s.outputTokens} tok (${s.durationSec}s)`;
        return `<div class="spark-bar" style="height:${h}%" data-tip="${esc(tip)}" title="${esc(tip)}"></div>`;
      })
      .join('');

    container.querySelectorAll('.spark-bar').forEach((el) => {
      el.addEventListener('mouseenter', () => {
        $('spark-hover').textContent = el.dataset.tip || '';
      });
    });
  }

  function renderStepsTable(m) {
    const steps = Array.isArray(m.recentSteps) ? m.recentSteps : [];
    const tbody = $('steps-tbody');
    $('last-updated').textContent = `更新于 ${fmtTime(m.lastUpdatedMs)}`;

    if (steps.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-row">暂无模型推理记录</td></tr>';
      return;
    }

    const rows = steps.slice(-15).reverse();
    tbody.innerHTML = rows
      .map((s) => {
        const tpsHtml =
          s.outputTps != null
            ? `<span class="tps-chip">${s.outputTps.toFixed(1)}</span>`
            : '<span class="muted-meta">—</span>';
        const durText = s.durationSec != null ? `${s.durationSec.toFixed(1)}s` : '—';
        return `<tr>
          <td>#${s.stepIndex}</td>
          <td>${fmtTokens(s.contextTokens)}</td>
          <td>${s.cacheHitRate.toFixed(0)}%</td>
          <td>${fmtTokens(s.outputTokens)}</td>
          <td>${durText}</td>
          <td>${tpsHtml}</td>
        </tr>`;
      })
      .join('');
  }

  function renderMetrics(m) {
    const errEl = $('error-banner');
    if (!m || m.error) {
      errEl.textContent = m?.error || '无法读取监控数据';
      errEl.classList.remove('hidden');
      return;
    }
    errEl.classList.add('hidden');

    state.lastMetrics = m;
    $('model-badge').textContent = m.modelName || '默认模型 (Auto)';
    updateLiveStatus(m);
    renderContextSection(m);
    renderThroughputSection(m);
    renderStepsTable(m);
  }

  // ---------- Polling ----------
  let pollInFlight = false;
  async function pollMetrics(force = false) {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      await refreshConversations();
      const qs = new URLSearchParams();
      if (state.selectedConv) qs.set('conversationId', state.selectedConv);
      if (state.etag && !force) qs.set('etag', state.etag);
      const data = await apiGet(`/api/metrics?${qs.toString()}`);
      if (data.uiVersion) {
        if (state.uiVersion && state.uiVersion !== data.uiVersion) {
          location.reload();
          return;
        }
        state.uiVersion = data.uiVersion;
      }
      if (data.unchanged) {
        if (state.lastMetrics) {
          state.lastMetrics.isGenerating = Boolean(data.isGenerating);
          updateLiveStatus(state.lastMetrics);
        }
        return;
      }
      if (data.etag) state.etag = data.etag;
      renderMetrics(data);
    } catch (err) {
      const errEl = $('error-banner');
      errEl.textContent = `连接监控服务失败：${err.message}`;
      errEl.classList.remove('hidden');
    } finally {
      pollInFlight = false;
    }
  }

  // ---------- Bootstrap ----------
  $('refresh-ui-btn')?.addEventListener('click', () => location.reload());
  initLimitControls();
  initCopyCompactButton();
  initConversationSelector();
  pollMetrics(true);
  setInterval(() => pollMetrics(false), POLL_MS);
  setInterval(() => {
    if (state.lastMetrics?.isGenerating) {
      updateLiveStatus(state.lastMetrics);
    }
  }, 250);
})();
