/* ==========================================================================
   Project Dynamo — task & earnings log
   Data lives in Supabase (public.dynamo_tasks); localStorage is a read cache
   so the page still renders something when the network is down.

   Money is stored in USD. The currency selector (USD/INR only) converts for
   display and for entry, using the fixed rate in FX below (1 USD = 95 INR).
   ========================================================================== */

(function () {
  'use strict';

  /* ----------------------------------------------------------- constants */

  const CACHE_KEY    = 'dynamo.tasks.cache';
  const SETTINGS_KEY = 'dynamo.settings';

  const FX = {
    USD: { symbol: '$', rate: 1 },
    INR: { symbol: '₹', rate: 95 }
  };

  const STATUS_LABEL = {
    IN_PROGRESS: 'In progress',
    PENDING:     'In review',
    ACCEPTED:    'Accepted',
    REJECTED:    'Rejected'
  };

  const STATUSES = ['IN_PROGRESS', 'PENDING', 'ACCEPTED', 'REJECTED'];

  // Green-forward categorical palette, distinguishable slice-to-slice.
  const SERIES = [
    '#30e089', '#22d3ee', '#a3e635', '#2dd4bf',
    '#4ade80', '#84cc16', '#60a5fa', '#fbbf24',
    '#34d399', '#f472b6'
  ];

  /* --------------------------------------------------------------- state */

  let tasks = [];
  let settings = { currency: 'USD', sound: true, view: 'table' };

  const filters = {
    search: '', status: 'ALL', category: 'ALL', platform: 'ALL', sort: 'date-desc'
  };

  let chartRange  = '7';
  let chartMetric = 'amount';

  let timelineChart = null;
  let categoryChart = null;
  let platformChart = null;

  let sb = null;             // supabase client
  let connection = 'offline'; // offline | syncing | live
  let audioCtx = null;

  const $  = (id) => document.getElementById(id);
  const el = (sel, root) => (root || document).querySelector(sel);

  /* ------------------------------------------------------------ currency */

  const fx = () => FX[settings.currency] || FX.USD;

  /** USD (stored) -> selected display currency. */
  const toDisplay = (usd) => (Number(usd) || 0) * fx().rate;

  /** Selected display currency -> USD (stored). */
  const toBase = (amount) => (Number(amount) || 0) / fx().rate;

  function money(usd, withSymbol = true) {
    const v = toDisplay(usd);
    const s = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return withSymbol ? fx().symbol + s : s;
  }

  /* --------------------------------------------------------------- utils */

  /**
   * Lucide's default stroke of 2 reads heavy at these sizes. 1.5 with
   * absoluteStrokeWidth keeps the weight identical whether an icon renders at
   * 13px or 16px, which is what makes a set look consistent.
   */
  function drawIcons() {
    if (!window.lucide) return;
    window.lucide.createIcons({
      attrs: { 'stroke-width': 1.5, 'absolute-stroke-width': 'true' }
    });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Normalises a typed link to an absolute http(s) URL, or '' if it is not one.
   * Anything else (javascript:, data:, gibberish) is rejected rather than
   * rendered as an href.
   */
  function safeUrl(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'https://' + raw);
      return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : '';
    } catch (err) {
      return '';
    }
  }

  /** Strips scheme and trailing slash so links read as 'github.com/you/repo'. */
  function prettyUrl(url) {
    return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  }

  function todayISO() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function shiftISO(iso, days) {
    const d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function shortDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00');
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  function hoursLabel(value) {
    const total = Math.max(0, Number(value) || 0);
    const h = Math.floor(total);
    const m = Math.round((total - h) * 60);
    return m === 60 ? `${h + 1}h 00m` : `${h}h ${String(m).padStart(2, '0')}m`;
  }

  /**
   * Earnings model, in USD:
   *   hourly pay  — counts the moment the task is logged, whatever its status
   *   incentive   — counts only once the task has been accepted
   */
  /** In-progress work is not finished, so it has earned nothing yet. */
  function isLogged(task) { return task.status !== 'IN_PROGRESS'; }

  function hourlyPay(task) {
    return isLogged(task) ? (Number(task.totalAmount) || 0) : 0;
  }
  function incentiveOf(task) { return Number(task.incentive) || 0; }
  function incentiveEarned(task) {
    return task.status === 'ACCEPTED' ? incentiveOf(task) : 0;
  }
  /** What this task has actually earned right now. */
  function earned(task) { return hourlyPay(task) + incentiveEarned(task); }

  /** Effective hourly rate, in USD. Falls back to billed hours when untracked. */
  function effRate(task) {
    const basis = Number(task.timeSpent) > 0 ? Number(task.timeSpent) : Number(task.paidHours);
    return basis > 0 ? earned(task) / basis : 0;
  }

  function newRef(category) {
    const source = (category || 'TASK').replace(/[^a-zA-Z]/g, '').toUpperCase();
    const prefix = (source.slice(0, 4) || 'TASK').padEnd(3, 'X');
    return `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
  }

  /* --------------------------------------------------------------- sound */

  function beep(kind) {
    if (!settings.sound) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const now  = audioCtx.currentTime;
      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';

      const tones = {
        click:   { freq: [520],           peak: 0.035, len: 0.05 },
        success: { freq: [523, 659, 784], peak: 0.05,  len: 0.28 },
        remove:  { freq: [320, 200],      peak: 0.045, len: 0.16 },
        error:   { freq: [220, 165],      peak: 0.05,  len: 0.22 }
      };
      const t = tones[kind] || tones.click;

      t.freq.forEach((f, i) => osc.frequency.setValueAtTime(f, now + i * (t.len / t.freq.length)));
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(t.peak, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t.len);
      osc.start(now);
      osc.stop(now + t.len + 0.02);
    } catch (err) {
      /* audio is a nicety; never let it break an action */
    }
  }

  function celebrate() {
    if (!window.confetti) return;
    window.confetti({
      particleCount: 44,
      spread: 58,
      startVelocity: 26,
      gravity: 0.9,
      scalar: 0.8,
      ticks: 120,
      origin: { y: 0.72 },
      colors: ['#30e089', '#a3e635', '#22d3ee', '#fbbf24', '#4ade80']
    });
  }

  /* -------------------------------------------------------------- toasts */

  function toast(message, kind = 'info') {
    const host = $('toasts');
    if (!host) return;

    const icons = { success: 'check', warning: 'triangle-alert', error: 'circle-alert', info: 'info' };
    const node = document.createElement('div');
    node.className = `toast is-${kind}`;
    node.innerHTML = `<i data-lucide="${icons[kind] || 'info'}"></i><span>${escapeHtml(message)}</span>`;
    host.appendChild(node);
    drawIcons();

    setTimeout(() => {
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 220);
    }, 3400);
  }

  /* ----------------------------------------------------- confirm dialog */

  let confirmResolve = null;

  function confirmDialog(title, body, okLabel = 'Delete') {
    $('confirmTitle').textContent = title;
    $('confirmBody').textContent = body;
    $('btnConfirmOk').textContent = okLabel;
    $('confirmScrim').hidden = false;
    $('btnConfirmOk').focus();
    return new Promise((resolve) => { confirmResolve = resolve; });
  }

  function closeConfirm(result) {
    $('confirmScrim').hidden = true;
    if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
  }

  /* --------------------------------------------------------- persistence */

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) Object.assign(settings, JSON.parse(raw));
      if (!FX[settings.currency]) settings.currency = 'USD';
    } catch (err) { /* fall back to defaults */ }
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (err) { /* quota */ }
  }

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) { return []; }
  }

  function writeCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(tasks)); } catch (err) { /* quota */ }
  }

  /* ---------------------------------------------------------- data layer */

  function rowToTask(row) {
    return {
      id:          row.id,
      ref:         row.task_ref,
      platform:    row.platform || 'General',
      category:    row.category,
      subCategory: row.sub_category || 'General',
      paidHours:   Number(row.paid_hours)   || 0,
      hourlyRate:  Number(row.hourly_rate)  || 0,
      totalAmount: Number(row.total_amount) || 0,
      timeSpent:   Number(row.time_spent)   || 0,
      status:      row.status || 'PENDING',
      date:        row.task_date,
      notes:       row.notes || '',
      incentive:   Number(row.incentive) || 0,
      repoUrl:     row.repo_url || '',
      createdAt:   row.created_at
    };
  }

  function taskToRow(task) {
    return {
      task_ref:     task.ref,
      platform:     task.platform,
      category:     task.category,
      sub_category: task.subCategory,
      paid_hours:   task.paidHours,
      hourly_rate:  task.hourlyRate,
      total_amount: task.totalAmount,
      incentive:    task.incentive || 0,
      time_spent:   task.timeSpent,
      status:       task.status,
      task_date:    task.date,
      notes:        task.notes,
      repo_url:     task.repoUrl || ''
    };
  }

  function setConnection(state, label) {
    connection = state;
    const chip = $('syncChip');
    if (!chip) return;
    chip.className = `sync-chip is-${state}`;
    $('syncLabel').textContent = label;
  }

  function connect() {
    const cfg = window.DYNAMO_CONFIG;
    if (!cfg || !window.supabase) {
      setConnection('offline', 'No connection');
      return false;
    }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
      auth: { persistSession: false }
    });
    return true;
  }

  async function fetchTasks() {
    if (!sb) return false;
    setConnection('syncing', 'Syncing');

    const { data, error } = await sb
      .from(window.DYNAMO_CONFIG.table)
      .select('*')
      .order('task_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[dynamo] fetch failed:', error);
      setConnection('offline', 'Offline');
      return false;
    }

    tasks = data.map(rowToTask);
    writeCache();
    setConnection('live', 'Synced');
    return true;
  }

  function subscribeToChanges() {
    if (!sb) return;
    sb.channel('dynamo-tasks')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: window.DYNAMO_CONFIG.table },
        () => { fetchTasks().then(renderAll); })
      .subscribe();
  }

  async function createTask(task) {
    if (!sb) { toast('Not connected — cannot save.', 'error'); return false; }
    const { data, error } = await sb
      .from(window.DYNAMO_CONFIG.table)
      .insert(taskToRow(task))
      .select()
      .single();

    if (error) {
      console.error('[dynamo] insert failed:', error);
      toast('Could not save the task.', 'error');
      beep('error');
      return false;
    }
    tasks.unshift(rowToTask(data));
    writeCache();
    return true;
  }

  async function updateTask(id, task) {
    if (!sb) { toast('Not connected — cannot save.', 'error'); return false; }
    const { data, error } = await sb
      .from(window.DYNAMO_CONFIG.table)
      .update(taskToRow(task))
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('[dynamo] update failed:', error);
      toast('Could not update the task.', 'error');
      beep('error');
      return false;
    }
    const i = tasks.findIndex((t) => t.id === id);
    if (i !== -1) tasks[i] = rowToTask(data);
    writeCache();
    return true;
  }

  async function removeTask(id) {
    if (!sb) { toast('Not connected — cannot delete.', 'error'); return false; }
    const { error } = await sb.from(window.DYNAMO_CONFIG.table).delete().eq('id', id);
    if (error) {
      console.error('[dynamo] delete failed:', error);
      toast('Could not delete the task.', 'error');
      beep('error');
      return false;
    }
    tasks = tasks.filter((t) => t.id !== id);
    writeCache();
    return true;
  }

  async function insertMany(list) {
    if (!sb) { toast('Not connected.', 'error'); return 0; }
    const rows = list.map(taskToRow);
    const { data, error } = await sb.from(window.DYNAMO_CONFIG.table).insert(rows).select();
    if (error) {
      console.error('[dynamo] bulk insert failed:', error);
      toast('Import failed.', 'error');
      return 0;
    }
    await fetchTasks();
    return data.length;
  }

  async function deleteAll() {
    if (!sb) { toast('Not connected.', 'error'); return false; }
    // .neq on the primary key matches every row; Supabase requires a filter.
    const { error } = await sb
      .from(window.DYNAMO_CONFIG.table)
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) {
      console.error('[dynamo] delete all failed:', error);
      toast('Could not clear tasks.', 'error');
      return false;
    }
    tasks = [];
    writeCache();
    return true;
  }

  /* ------------------------------------------------------------ selectors */

  function visibleTasks() {
    let out = tasks.slice();

    const q = filters.search.trim().toLowerCase();
    if (q) {
      out = out.filter((t) =>
        [t.ref, t.category, t.subCategory, t.platform, t.notes, t.repoUrl]
          .some((v) => v && String(v).toLowerCase().includes(q)));
    }
    if (filters.status   !== 'ALL') out = out.filter((t) => t.status === filters.status);
    if (filters.category !== 'ALL') out = out.filter((t) => t.category === filters.category);
    if (filters.platform !== 'ALL') out = out.filter((t) => t.platform === filters.platform);

    const byDate = (a, b) => (a.date || '').localeCompare(b.date || '');
    const sorters = {
      'date-desc':      (a, b) => byDate(b, a) || String(b.createdAt).localeCompare(String(a.createdAt)),
      'date-asc':       (a, b) => byDate(a, b) || String(a.createdAt).localeCompare(String(b.createdAt)),
      'amount-desc':    (a, b) => earned(b) - earned(a),
      'amount-asc':     (a, b) => earned(a) - earned(b),
      'rate-desc':      (a, b) => effRate(b) - effRate(a),
      'paidHours-desc': (a, b) => b.paidHours - a.paidHours,
      'timeSpent-desc': (a, b) => b.timeSpent - a.timeSpent
    };
    return out.sort(sorters[filters.sort] || sorters['date-desc']);
  }

  function totals(list) {
    const t = {
      amount: 0, approved: 0, pending: 0,
      incentiveWon: 0, incentiveLocked: 0,
      paidHours: 0, actualHours: 0,
      accepted: 0, inReview: 0, rejected: 0, reviewed: 0,
      inProgress: 0, pipelineAmount: 0, pipelineHours: 0,
      count: list.length
    };
    list.forEach((x) => {
      // Pipeline work is excluded from every realised figure on the dashboard.
      if (!isLogged(x)) {
        t.inProgress++;
        t.pipelineAmount += (Number(x.totalAmount) || 0) + incentiveOf(x);
        t.pipelineHours  += x.paidHours;
        return;
      }

      t.amount      += earned(x);
      t.paidHours   += x.paidHours;
      t.actualHours += x.timeSpent;
      t.reviewed++;
      if (x.status === 'ACCEPTED') {
        t.approved += earned(x);
        t.incentiveWon += incentiveOf(x);
        t.accepted++;
      } else if (x.status === 'PENDING') {
        t.pending += hourlyPay(x);
        t.incentiveLocked += incentiveOf(x);
        t.inReview++;
      } else {
        t.incentiveLocked += incentiveOf(x);
        t.rejected++;
      }
    });
    return t;
  }

  /* ------------------------------------------------------- extra metrics */

  /** Sum of earned() for logged tasks whose date falls within [startISO, endISO]. */
  function sumEarnedInRange(startISO, endISO) {
    return tasks.reduce((s, t) => {
      if (!isLogged(t) || !t.date) return s;
      if (t.date < startISO || t.date > endISO) return s;
      return s + earned(t);
    }, 0);
  }

  /** Rolling 7-day window vs the 7 days before it — same convention as the timeline's "7 days" toggle. */
  function weeklyTrend() {
    const today = todayISO();
    const thisStart = shiftISO(today, -6);
    const lastEnd   = shiftISO(thisStart, -1);
    const lastStart = shiftISO(lastEnd, -6);
    return {
      thisWeek: sumEarnedInRange(thisStart, today),
      lastWeek: sumEarnedInRange(lastStart, lastEnd)
    };
  }

  /** Current and best consecutive-day streaks of having at least one logged task. */
  function computeStreaks() {
    const dates = new Set(tasks.filter(isLogged).map((t) => t.date).filter(Boolean));
    if (!dates.size) return { current: 0, best: 0 };

    let current = 0;
    let cursor = todayISO();
    if (!dates.has(cursor)) cursor = shiftISO(cursor, -1); // grace: today isn't over yet
    while (dates.has(cursor)) { current++; cursor = shiftISO(cursor, -1); }

    const sorted = Array.from(dates).sort();
    let best = 0, run = 0, prev = null;
    sorted.forEach((d) => {
      run = (prev && shiftISO(prev, 1) === d) ? run + 1 : 1;
      best = Math.max(best, run);
      prev = d;
    });
    return { current, best };
  }

  /** Platform with the highest realised earnings, and its share of the total. */
  function topPlatform() {
    const buckets = {};
    let total = 0;
    tasks.forEach((t) => {
      if (!isLogged(t)) return;
      const v = earned(t);
      const key = t.platform || 'General';
      buckets[key] = (buckets[key] || 0) + v;
      total += v;
    });
    const ranked = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return null;
    const [name, value] = ranked[0];
    return { name, value, share: total ? (value / total) * 100 : 0 };
  }

  /** Minimal inline sparkline — an area + line path, styled by CSS custom property. */
  function sparkSvg(values, colorVar) {
    if (!values.length || !values.some((v) => Math.abs(v) > 0.0001)) return '';
    const w = 100, h = 26;
    const max = Math.max(...values, 0);
    const min = Math.min(...values, 0);
    const range = (max - min) || 1;
    const stepX = values.length > 1 ? w / (values.length - 1) : 0;
    const pts = values.map((v, i) => `${(i * stepX).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`);
    const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p).join(' ');
    const area = `${line} L${w},${h} L0,${h} Z`;
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="spark-svg">
      <path d="${area}" stroke="none" style="fill:${colorVar};opacity:.14"/>
      <path d="${line}" fill="none" style="stroke:${colorVar}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  /* -------------------------------------------------------------- render */

  function renderSummary() {
    const t = totals(tasks);
    const symbol = fx().symbol;

    document.querySelectorAll('.cur-sym').forEach((n) => { n.textContent = symbol; });
    $('dialogCurrency').textContent = settings.currency;
    $('footFx').textContent = settings.currency === 'USD'
      ? 'Amounts stored in USD'
      : `Stored in USD · shown in ${settings.currency} at ${fx().rate}`;

    $('statTotal').textContent    = money(t.amount, false);
    $('statApproved').textContent = money(t.approved);
    $('statPending').textContent  = money(t.pending);

    const incentiveNote = $('statIncentive');
    if (t.incentiveWon || t.incentiveLocked) {
      incentiveNote.hidden = false;
      const parts = [];
      if (t.incentiveWon) {
        parts.push(`<span class="text-accepted">+${escapeHtml(money(t.incentiveWon))}</span> incentive earned`);
      }
      if (t.incentiveLocked) {
        parts.push(`${escapeHtml(money(t.incentiveLocked))} locked until accepted`);
      }
      incentiveNote.innerHTML = parts.join(' <span class="sep">·</span> ');
    } else {
      incentiveNote.hidden = true;
    }

    // Rate is over reviewed work only — in-progress tasks have not been judged.
    const rate = t.reviewed ? (t.accepted / t.reviewed) * 100 : 0;
    $('statAcceptance').textContent = rate.toFixed(rate % 1 === 0 ? 0 : 1);

    const counts = [];
    if (t.accepted)   counts.push(`${t.accepted} accepted`);
    if (t.inReview)   counts.push(`${t.inReview} in review`);
    if (t.rejected)   counts.push(`${t.rejected} rejected`);
    if (t.inProgress) counts.push(`${t.inProgress} in progress`);
    $('statCounts').textContent = counts.length ? counts.join(' · ') : 'No tasks yet';

    const pct = (n) => (t.count ? (n / t.count) * 100 : 0);
    $('meterAccepted').style.width = pct(t.accepted) + '%';
    $('meterPending').style.width  = pct(t.inReview) + '%';
    $('meterRejected').style.width = pct(t.rejected) + '%';
    $('meterProgress').style.width = pct(t.inProgress) + '%';

    const pipeline = $('statPipeline');
    if (t.inProgress) {
      pipeline.hidden = false;
      pipeline.innerHTML =
        `<span class="text-progress">${escapeHtml(money(t.pipelineAmount))}</span> in the pipeline` +
        ` <span class="sep">·</span> ${t.inProgress} task${t.inProgress === 1 ? '' : 's'}` +
        `, ${t.pipelineHours.toFixed(1)}h to bill`;
    } else {
      pipeline.hidden = true;
    }

    $('statPaidHours').textContent   = t.paidHours.toFixed(1);
    $('statActualHours').textContent = t.actualHours.toFixed(1) + 'h';

    const variance = t.paidHours - t.actualHours;
    const varianceEl = $('statVariance');
    if (!t.count) {
      varianceEl.textContent = '—';
      varianceEl.className = '';
    } else {
      varianceEl.textContent = variance >= 0
        ? `${variance.toFixed(1)}h ahead`
        : `${Math.abs(variance).toFixed(1)}h over`;
      varianceEl.className = variance >= 0 ? 'text-accepted' : 'text-rejected';
    }

    const effective = t.actualHours > 0 ? t.amount / t.actualHours : 0;
    const billed    = t.paidHours   > 0 ? t.amount / t.paidHours   : 0;
    $('statEffRate').textContent   = money(effective, false);
    $('statBilledRate').textContent = money(billed) + '/hr';
  }

  function renderKpis() {
    const t = totals(tasks);

    const { thisWeek, lastWeek } = weeklyTrend();
    $('kpiWeekAmount').textContent = money(thisWeek, false);
    const trendEl = $('kpiWeekTrend');
    if (!thisWeek && !lastWeek) {
      trendEl.textContent = 'No data yet';
    } else if (!lastWeek) {
      trendEl.innerHTML = '<span class="trend-up">New this week</span>';
    } else {
      const delta = ((thisWeek - lastWeek) / lastWeek) * 100;
      const up = delta >= 0;
      trendEl.innerHTML = `<span class="${up ? 'trend-up' : 'trend-down'}">${up ? '▲' : '▼'} ${Math.abs(delta).toFixed(0)}%</span> vs last week`;
    }

    const { current, best } = computeStreaks();
    $('kpiStreak').textContent = current;
    $('kpiStreakBest').textContent = best ? `Best ${best} day${best === 1 ? '' : 's'}` : 'Best — days';

    $('kpiAvgTask').textContent = t.reviewed ? money(t.amount / t.reviewed, false) : '0.00';
    $('kpiAvgTaskCount').textContent = t.reviewed
      ? `Across ${t.reviewed} logged task${t.reviewed === 1 ? '' : 's'}`
      : 'No tasks yet';

    const top = topPlatform();
    const topName = $('kpiTopPlatform');
    if (top) {
      topName.textContent = top.name;
      topName.title = top.name;
      $('kpiTopPlatformShare').textContent = `${money(top.value)} · ${Math.round(top.share)}% of earnings`;
    } else {
      topName.textContent = '—';
      topName.title = '';
      $('kpiTopPlatformShare').textContent = 'No data yet';
    }
  }

  function renderSparklines() {
    const N = 14;
    const days = Array.from({ length: N }, (_, i) => shiftISO(todayISO(), -(N - 1 - i)));
    const dayTasks = days.map((d) => tasks.filter((t) => t.date === d && isLogged(t)));

    const earnedSeries = dayTasks.map((list) => toDisplay(list.reduce((s, t) => s + earned(t), 0)));
    const acceptSeries = dayTasks.map((list) => {
      const accepted = list.filter((t) => t.status === 'ACCEPTED').length;
      return list.length ? (accepted / list.length) * 100 : 0;
    });
    const hoursSeries = dayTasks.map((list) => list.reduce((s, t) => s + t.paidHours, 0));
    const rateSeries = dayTasks.map((list) => {
      const hrs = list.reduce((s, t) => s + t.timeSpent, 0);
      const amt = list.reduce((s, t) => s + earned(t), 0);
      return hrs > 0 ? toDisplay(amt / hrs) : 0;
    });

    $('sparkTotal').innerHTML      = sparkSvg(earnedSeries, 'var(--accent)');
    $('sparkAcceptance').innerHTML = sparkSvg(acceptSeries, 'var(--accepted)');
    $('sparkHours').innerHTML      = sparkSvg(hoursSeries, 'var(--cyan)');
    $('sparkEffRate').innerHTML    = sparkSvg(rateSeries, 'var(--pending)');
  }

  function renderHeatmap() {
    const host = $('activityHeatmap');
    if (!host) return;

    const WEEKS = 14;
    const today = todayISO();
    const dowMon0 = (new Date(today + 'T00:00:00').getDay() + 6) % 7; // Monday=0 … Sunday=6
    const currentMonday = shiftISO(today, -dowMon0);
    const startMonday = shiftISO(currentMonday, -(WEEKS - 1) * 7);
    const days = Array.from({ length: WEEKS * 7 }, (_, i) => shiftISO(startMonday, i));

    const perDay = {};
    tasks.forEach((t) => {
      if (!isLogged(t) || !t.date) return;
      perDay[t.date] = (perDay[t.date] || 0) + earned(t);
    });
    const max = Math.max(0, ...Object.values(perDay));

    host.innerHTML = days.map((d) => {
      if (d > today) return '<span class="heatmap-cell is-future"></span>';
      const amount = perDay[d] || 0;
      let level = 0;
      if (amount > 0 && max > 0) {
        const ratio = amount / max;
        level = ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1;
      }
      const label = `${shortDate(d)}: ${amount ? money(amount) : 'no earnings'}`;
      return `<span class="heatmap-cell" data-level="${level}" title="${escapeHtml(label)}"></span>`;
    }).join('');
  }

  function renderPlatform() {
    const canvas = $('platformChart');
    const emptyEl = $('platformEmpty');
    if (!canvas || typeof Chart === 'undefined') return;

    const buckets = {};
    tasks.forEach((t) => {
      if (!isLogged(t)) return;
      const key = t.platform || 'General';
      buckets[key] = (buckets[key] || 0) + toDisplay(earned(t));
    });
    const ranked = Object.entries(buckets).sort((a, b) => b[1] - a[1]).slice(0, 6);

    if (platformChart) { platformChart.destroy(); platformChart = null; }
    if (emptyEl) emptyEl.hidden = ranked.length > 0;
    if (!ranked.length) return;

    platformChart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: ranked.map(([k]) => k),
        datasets: [{
          data: ranked.map(([, v]) => Math.round(v * 100) / 100),
          backgroundColor: ranked.map((_, i) => SERIES[i % SERIES.length]),
          borderRadius: 5,
          maxBarThickness: 18
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { right: 8 } },
        plugins: {
          legend: { display: false },
          tooltip: { ...tooltipStyle, callbacks: { label: (c) => `${fx().symbol}${c.parsed.x.toFixed(2)}` } }
        },
        scales: {
          x: {
            beginAtZero: true,
            grid: { color: 'rgba(228,242,234,.07)', drawTicks: false },
            border: { display: false },
            ticks: { padding: 6, maxTicksLimit: 5, callback: (v) => fx().symbol + v }
          },
          y: {
            grid: { display: false },
            border: { display: false },
            ticks: { padding: 6 }
          }
        }
      }
    });
  }

  function renderFilterOptions() {
    [['filterCategory', 'category', 'All categories'],
     ['filterPlatform', 'platform', 'All platforms']].forEach(([id, key, allLabel]) => {
      const select = $(id);
      const values = Array.from(new Set(tasks.map((t) => t[key]).filter(Boolean))).sort();
      const current = filters[key];
      select.innerHTML = `<option value="ALL">${allLabel}</option>` +
        values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
      if (values.includes(current)) select.value = current;
      else { select.value = 'ALL'; filters[key] = 'ALL'; }
    });
  }

  /** Renders the repo link, or nothing when the task has no valid one. */
  function repoLink(task, withLabel) {
    const url = safeUrl(task.repoUrl);
    if (!url) return '';
    const label = prettyUrl(url);
    return `<a class="repo-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"
      title="${escapeHtml(label)}"><i data-lucide="link-2"></i>${
        withLabel ? `<span class="repo-label">${escapeHtml(label)}</span>` : ''}</a>`;
  }

  function statusPill(status) {
    const cls = {
      ACCEPTED:    'is-accepted',
      PENDING:     'is-pending',
      IN_PROGRESS: 'is-progress',
      REJECTED:    'is-rejected'
    }[status] || 'is-pending';
    return `<span class="pill ${cls}">${STATUS_LABEL[status] || status}</span>`;
  }

  function rowActions(id) {
    return `
      <div class="row-actions">
        <button class="act" data-act="cycle" data-id="${id}" title="Change status"><i data-lucide="refresh-cw"></i></button>
        <button class="act" data-act="edit" data-id="${id}" title="Edit"><i data-lucide="pencil"></i></button>
        <button class="act" data-act="copy" data-id="${id}" title="Duplicate"><i data-lucide="copy"></i></button>
        <button class="act is-danger" data-act="delete" data-id="${id}" title="Delete"><i data-lucide="trash-2"></i></button>
      </div>`;
  }

  function renderTable(list) {
    $('tableBody').innerHTML = list.map((t) => {
      const billed = isLogged(t);
      const gross = Number(t.totalAmount) || 0;
      const rate = effRate(t);
      const rateCls = !billed ? 'is-low' : rate >= 45 ? 'is-high' : rate < 25 ? 'is-low' : '';
      return `
        <tr>
          <td>
            <div class="ref-cell">
              <span class="cell-ref" data-act="copy-ref" data-ref="${escapeHtml(t.ref)}" title="Copy task ID">${escapeHtml(t.ref)}</span>
              ${repoLink(t, false)}
            </div>
          </td>
          <td>
            <div class="cell-stack">
              <span class="cell-primary">${escapeHtml(shortDate(t.date))}</span>
              <span class="cell-secondary">${escapeHtml(t.platform)}</span>
            </div>
          </td>
          <td>
            <div class="cell-stack">
              <span class="cell-primary">${escapeHtml(t.category)}</span>
              <span class="cell-secondary">${escapeHtml(t.subCategory)}</span>
            </div>
          </td>
          <td class="num cell-muted">${t.paidHours.toFixed(2)}</td>
          <td class="num cell-muted">${t.timeSpent.toFixed(2)}</td>
          <td class="num">
            <div class="cell-stack cell-stack-end">
              <span class="cell-amount${billed ? '' : ' is-unbilled'}"${
                billed ? '' : ' title="Not earned until the task is logged"'}>${money(gross)}</span>
              ${incentiveOf(t) ? `<span class="cell-incentive ${t.status === 'ACCEPTED' ? 'is-won' : 'is-locked'}"
                 title="${t.status === 'ACCEPTED' ? 'Incentive earned' : 'Unlocks when accepted'}"
                 >+${escapeHtml(money(incentiveOf(t)))}</span>` : ''}
            </div>
          </td>
          <td class="num cell-rate ${rateCls}">${billed ? money(rate) : '—'}</td>
          <td>${statusPill(t.status)}</td>
          <td>${rowActions(t.id)}</td>
        </tr>`;
    }).join('');
  }

  function renderCards(list) {
    $('cardView').innerHTML = list.map((t) => `
      <article class="task-card">
        <div class="task-card-head">
          <div>
            <p class="task-card-title">${escapeHtml(t.category)}</p>
            <p class="task-card-meta">${escapeHtml(t.ref)} · ${escapeHtml(t.platform)}</p>
            ${repoLink(t, true)}
          </div>
          ${statusPill(t.status)}
        </div>
        <div class="task-card-stats">
          <div class="task-card-stat">
            <span class="k">${isLogged(t) ? 'Earned' : 'Pending'}</span>
            <span class="v${isLogged(t) ? '' : ' is-unbilled'}">${
              money(isLogged(t) ? earned(t) : (Number(t.totalAmount) || 0))}${incentiveOf(t)
              ? `<span class="cell-incentive ${t.status === 'ACCEPTED' ? 'is-won' : 'is-locked'}">+${escapeHtml(money(incentiveOf(t)))}</span>`
              : ''}</span>
          </div>
          <div class="task-card-stat"><span class="k">Hours</span><span class="v">${t.paidHours.toFixed(1)} / ${t.timeSpent.toFixed(1)}</span></div>
          <div class="task-card-stat"><span class="k">Rate</span><span class="v">${money(effRate(t))}</span></div>
        </div>
        <div class="task-card-foot">
          <span>${escapeHtml(shortDate(t.date))}</span>
          ${rowActions(t.id)}
        </div>
      </article>`).join('');
  }

  function renderList() {
    const list = visibleTasks();
    const shown = totals(list);

    $('resultCount').textContent = tasks.length === 0
      ? 'No tasks'
      : `${list.length} of ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`;
    $('resultTotal').textContent = `${money(shown.amount)} earned`;

    const isEmpty = list.length === 0;
    const filtering = tasks.length > 0;

    $('emptyState').hidden = !isEmpty;
    $('tableView').hidden  = isEmpty || settings.view !== 'table';
    $('cardView').hidden   = isEmpty || settings.view !== 'cards';

    if (isEmpty) {
      $('emptyTitle').textContent = filtering ? 'Nothing matches' : 'No tasks yet';
      $('emptyBody').textContent  = filtering
        ? 'Try clearing the search or filters above.'
        : 'Log your first task to start tracking earnings and effective rate.';
      $('btnEmptyNew').hidden = filtering;
    } else if (settings.view === 'table') {
      renderTable(list);
    } else {
      renderCards(list);
    }

    drawIcons();
  }

  /* -------------------------------------------------------------- charts */

  function chartTheme() {
    if (typeof Chart === 'undefined') return;
    Chart.defaults.font.family = "'Poppins', sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.color = '#93ac9f';
    Chart.defaults.borderColor = 'rgba(228,242,234,.07)';
    Chart.defaults.animation.duration = 380;
  }

  const tooltipStyle = {
    backgroundColor: '#101b16',
    borderColor: '#274036',
    borderWidth: 1,
    titleColor: '#e4f2ea',
    titleFont: { family: "'Poppins', sans-serif", size: 11.5, weight: '500' },
    bodyColor: '#a8c2b4',
    bodyFont: { family: "'Poppins', sans-serif", size: 11.5 },
    padding: 10,
    cornerRadius: 7,
    displayColors: false,
    boxPadding: 4
  };

  function renderTimeline() {
    const canvas = $('timelineChart');
    if (!canvas || typeof Chart === 'undefined') return;

    let days;
    if (chartRange === 'all') {
      const dates = tasks.map((t) => t.date).filter(Boolean).sort();
      if (!dates.length) days = [todayISO()];
      else {
        const span = Math.min(
          90,
          Math.max(1, Math.round((new Date(dates[dates.length - 1]) - new Date(dates[0])) / 86400000) + 1)
        );
        days = Array.from({ length: span }, (_, i) => shiftISO(dates[dates.length - 1], -(span - 1 - i)));
      }
    } else {
      const n = Number(chartRange);
      days = Array.from({ length: n }, (_, i) => shiftISO(todayISO(), -(n - 1 - i)));
    }

    const perDay = days.map((d) =>
      toDisplay(tasks.filter((t) => t.date === d).reduce((s, t) => s + earned(t), 0)));
    const worked = days.map((d) =>
      tasks.filter((t) => t.date === d).reduce((s, t) => s + t.timeSpent, 0));

    if (timelineChart) timelineChart.destroy();

    const ctx = canvas.getContext('2d');
    const fill = ctx.createLinearGradient(0, 0, 0, 240);
    fill.addColorStop(0, 'rgba(48,224,137,.20)');
    fill.addColorStop(1, 'rgba(48,224,137,0)');

    timelineChart = new Chart(ctx, {
      data: {
        labels: days.map(shortDate),
        datasets: [
          {
            type: 'line',
            label: 'Earned',
            data: perDay,
            yAxisID: 'y',
            borderColor: '#30e089',
            backgroundColor: fill,
            borderWidth: 2,
            fill: true,
            tension: 0.32,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: '#30e089',
            pointHoverBorderColor: '#0c1411',
            pointHoverBorderWidth: 2
          },
          {
            type: 'line',
            label: 'Hours worked',
            data: worked,
            yAxisID: 'y1',
            borderColor: '#557163',
            borderWidth: 1.5,
            borderDash: [3, 3],
            fill: false,
            tension: 0.32,
            pointRadius: 0,
            pointHoverRadius: 3
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: {
              boxWidth: 7, boxHeight: 7, usePointStyle: true, pointStyle: 'circle',
              padding: 14, color: '#93ac9f', font: { size: 11 }
            }
          },
          tooltip: {
            ...tooltipStyle,
            callbacks: {
              label: (c) => c.datasetIndex === 0
                ? `Earned  ${fx().symbol}${c.parsed.y.toFixed(2)}`
                : `Worked  ${c.parsed.y.toFixed(2)}h`
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8, padding: 6 }
          },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(228,242,234,.07)', drawTicks: false },
            border: { display: false },
            ticks: { padding: 8, maxTicksLimit: 5, callback: (v) => fx().symbol + v }
          },
          y1: {
            beginAtZero: true,
            position: 'right',
            grid: { display: false },
            border: { display: false },
            ticks: { padding: 8, maxTicksLimit: 5, callback: (v) => v + 'h' }
          }
        }
      }
    });
  }

  /** Draws the total in the middle of the doughnut. */
  const centreLabel = {
    id: 'centreLabel',
    afterDraw(chart) {
      const meta = chart.getDatasetMeta(0);
      if (!meta || !meta.data.length) return;
      const { x, y } = meta.data[0];
      const total = chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
      const ctx = chart.ctx;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#e4f2ea';
      ctx.font = "600 16px 'Poppins', sans-serif";
      ctx.fillText(
        chartMetric === 'amount' ? fx().symbol + Math.round(total).toLocaleString('en-US') : String(total),
        x, y - 7
      );
      ctx.fillStyle = '#6e8a7a';
      ctx.font = "400 10px 'Poppins', sans-serif";
      ctx.fillText(chartMetric === 'amount' ? 'total' : 'tasks', x, y + 10);
      ctx.restore();
    }
  };

  function renderCategory() {
    const canvas = $('categoryChart');
    if (!canvas || typeof Chart === 'undefined') return;

    const buckets = {};
    tasks.forEach((t) => {
      const key = t.category || 'Uncategorised';
      buckets[key] = (buckets[key] || 0) +
        (chartMetric === 'amount' ? toDisplay(earned(t)) : 1);
    });

    // Top 5 stay named; the tail is folded into one slice so the legend stays legible.
    const ranked = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
    const entries = ranked.slice(0, 5);
    const tail = ranked.slice(5);
    if (tail.length) entries.push(['Other', tail.reduce((s, [, v]) => s + v, 0)]);

    const fmt = (v) => (chartMetric === 'amount'
      ? fx().symbol + v.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : String(v));

    const grand = entries.reduce((s, [, v]) => s + v, 0);
    $('categoryLegend').innerHTML = entries.length
      ? entries.map(([name, value], i) => `
          <li class="legend-item">
            <span class="legend-dot" style="background:${SERIES[i % SERIES.length]}"></span>
            <span class="legend-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <span class="legend-value">${fmt(value)}</span>
            <span class="legend-share">${grand ? Math.round((value / grand) * 100) : 0}%</span>
          </li>`).join('')
      : '<li class="legend-empty">No data yet</li>';

    if (categoryChart) categoryChart.destroy();

    categoryChart = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: entries.map(([k]) => k),
        datasets: [{
          data: entries.map(([, v]) => Math.round(v * 100) / 100),
          backgroundColor: SERIES,
          borderColor: '#0c1411',
          borderWidth: 2,
          hoverOffset: 5
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        layout: { padding: 4 },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltipStyle,
            callbacks: {
              title: (items) => items[0].label,
              label: (c) => chartMetric === 'amount'
                ? `${fx().symbol}${c.parsed.toFixed(2)}`
                : `${c.parsed} ${c.parsed === 1 ? 'task' : 'tasks'}`
            }
          }
        }
      },
      plugins: [centreLabel]
    });
  }

  function renderAll() {
    renderSummary();
    renderKpis();
    renderSparklines();
    renderFilterOptions();
    renderList();
    renderTimeline();
    renderCategory();
    renderHeatmap();
    renderPlatform();
  }

  /* --------------------------------------------------------------- forms */

  function openDialog(task) {
    $('fieldRowId').value       = task ? task.id : '';
    $('dialogTitle').textContent = task ? 'Edit task' : 'New task';
    $('btnSubmitText').textContent = task ? 'Save changes' : 'Add task';

    $('fieldRef').value         = task ? task.ref : newRef('');
    $('fieldPlatform').value    = task ? task.platform : '';
    $('fieldCategory').value    = task ? task.category : '';
    $('fieldSubCategory').value = task ? task.subCategory : '';
    $('fieldPaidHours').value   = task ? task.paidHours : '';
    $('fieldRate').value        = task ? toDisplay(task.hourlyRate).toFixed(2) : '';
    $('fieldAmount').value      = task ? toDisplay(task.totalAmount).toFixed(2) : '';
    $('fieldTimeSpent').value   = task ? task.timeSpent : '';
    $('fieldStatus').value      = task ? task.status : 'PENDING';
    $('fieldDate').value        = task ? task.date : todayISO();
    $('fieldIncentive').value   = task && task.incentive ? toDisplay(task.incentive).toFixed(2) : '';
    $('fieldRepo').value        = task ? task.repoUrl : '';
    $('fieldNotes').value       = task ? task.notes : '';

    applyStatusMode();
    updateReadout();
    $('scrim').hidden = false;
    setTimeout(() => $(task ? 'fieldPaidHours' : 'fieldRef').focus(), 30);
  }

  function closeDialog() { $('scrim').hidden = true; }

  /**
   * An in-progress task has not finished, so its hours and pay are estimates.
   * Don't demand them, and label them honestly.
   */
  function applyStatusMode() {
    const wip = $('fieldStatus').value === 'IN_PROGRESS';

    const labels = wip
      ? { fieldPaidHours: 'Hours expected', fieldAmount: 'Expected pay',
          fieldTimeSpent: 'Time spent so far', fieldDate: 'Date started' }
      : { fieldPaidHours: 'Hours billed', fieldAmount: 'Hourly pay',
          fieldTimeSpent: 'Time actually spent', fieldDate: 'Date' };

    Object.keys(labels).forEach((id) => {
      const label = el(`label[for="${id}"]`);
      if (label) label.textContent = labels[id];
    });

    ['fieldPaidHours', 'fieldAmount', 'fieldTimeSpent'].forEach((id) => {
      $(id).required = !wip;
    });

    $('hintIncentive').textContent = wip ? 'Expected' : 'On acceptance';
    $('wipNote').hidden = !wip;
    if (wip) drawIcons();
  }

  function updateReadout() {
    const paid   = parseFloat($('fieldPaidHours').value) || 0;
    const amount = parseFloat($('fieldAmount').value) || 0;
    const spent  = parseFloat($('fieldTimeSpent').value) || 0;

    $('hintPaidHours').textContent = hoursLabel(paid);
    $('hintTimeSpent').textContent = hoursLabel(spent);

    const incentive = parseFloat($('fieldIncentive').value) || 0;
    const status = $('fieldStatus').value;
    const wip = status === 'IN_PROGRESS';
    const accepted = status === 'ACCEPTED';
    const counting = wip ? 0 : amount + (accepted ? incentive : 0);

    const earnedOut = $('readoutEarned');
    earnedOut.className = 'readout-value';
    if (wip) {
      const potential = amount + incentive;
      earnedOut.textContent = potential
        ? `${fx().symbol}0.00 · ${fx().symbol}${potential.toFixed(2)} pipeline`
        : `${fx().symbol}0.00`;
      if (potential) earnedOut.className = 'readout-value readout-value-sm';
    } else {
      earnedOut.textContent = `${fx().symbol}${counting.toFixed(2)}`;
      if (incentive && !accepted) {
        earnedOut.textContent += ` (+${fx().symbol}${incentive.toFixed(2)} on accept)`;
        earnedOut.className = 'readout-value readout-value-sm';
      }
    }

    const basis = spent > 0 ? spent : paid;
    $('readoutRate').textContent = (!wip && basis > 0)
      ? `${fx().symbol}${(counting / basis).toFixed(2)}/hr`
      : '—';

    const variance = paid - spent;
    const out = $('readoutVariance');
    if (!paid && !spent) {
      out.textContent = '—';
      out.className = 'readout-value';
    } else {
      out.textContent = variance >= 0
        ? `${variance.toFixed(2)}h ahead`
        : `${Math.abs(variance).toFixed(2)}h over`;
      out.className = 'readout-value ' + (variance >= 0 ? 'text-accepted' : 'text-rejected');
    }
  }

  async function submitForm(event) {
    event.preventDefault();

    const rowId = $('fieldRowId').value;
    const ref   = $('fieldRef').value.trim();
    const category = $('fieldCategory').value.trim();

    if (!ref || !category) {
      toast('Task ID and category are required.', 'warning');
      return;
    }

    const task = {
      ref,
      platform:    $('fieldPlatform').value.trim() || 'General',
      category,
      subCategory: $('fieldSubCategory').value.trim() || 'General',
      paidHours:   Math.max(0, parseFloat($('fieldPaidHours').value) || 0),
      hourlyRate:  toBase(parseFloat($('fieldRate').value) || 0),
      totalAmount: toBase(parseFloat($('fieldAmount').value) || 0),
      incentive:   toBase(parseFloat($('fieldIncentive').value) || 0),
      timeSpent:   Math.max(0, parseFloat($('fieldTimeSpent').value) || 0),
      status:      $('fieldStatus').value,
      date:        $('fieldDate').value || todayISO(),
      notes:       $('fieldNotes').value.trim(),
      repoUrl:     safeUrl($('fieldRepo').value)
    };

    const typedRepo = $('fieldRepo').value.trim();
    if (typedRepo && !task.repoUrl) {
      toast('That repo link is not a valid http(s) URL.', 'warning');
      $('fieldRepo').focus();
      return;
    }

    // Round money to the 2dp the column stores, so display matches storage.
    task.hourlyRate  = Math.round(task.hourlyRate * 100) / 100;
    task.totalAmount = Math.round(task.totalAmount * 100) / 100;
    task.incentive   = Math.round(task.incentive * 100) / 100;

    const btn = $('btnSubmit');
    btn.disabled = true;

    const wasAccepted = rowId
      ? (tasks.find((t) => t.id === rowId) || {}).status === 'ACCEPTED'
      : false;

    const ok = rowId ? await updateTask(rowId, task) : await createTask(task);
    btn.disabled = false;

    if (!ok) return;

    closeDialog();
    renderAll();
    beep('success');
    toast(rowId ? `Updated ${ref}.` : `Logged ${ref}.`, 'success');
    if (task.status === 'ACCEPTED' && !wasAccepted) celebrate();
  }

  /* ------------------------------------------------------------- actions */

  async function cycleStatus(id) {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const next = {
      IN_PROGRESS: 'PENDING',
      PENDING:     'ACCEPTED',
      ACCEPTED:    'REJECTED',
      REJECTED:    'IN_PROGRESS'
    };
    const updated = { ...task, status: next[task.status] || 'PENDING' };
    delete updated.id; delete updated.createdAt;

    if (await updateTask(id, updated)) {
      renderAll();
      beep('click');
      if (updated.status === 'ACCEPTED') celebrate();
    }
  }

  async function duplicate(id) {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const copy = { ...task, ref: newRef(task.category), status: 'PENDING', date: todayISO() };
    delete copy.id; delete copy.createdAt;

    if (await createTask(copy)) {
      renderAll();
      beep('success');
      toast(`Duplicated as ${copy.ref}.`, 'success');
    }
  }

  async function confirmRemove(id) {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const yes = await confirmDialog('Delete task', `${task.ref} will be removed permanently.`, 'Delete');
    if (!yes) return;
    if (await removeTask(id)) {
      renderAll();
      beep('remove');
      toast(`Deleted ${task.ref}.`, 'info');
    }
  }

  /* --------------------------------------------------------- import/export */

  function download(content, filename, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const csvCell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;

  function exportCSV() {
    if (!tasks.length) { toast('Nothing to export.', 'warning'); return; }
    const head = ['Task ID', 'Date', 'Platform', 'Category', 'Sub-category',
                  'Hours billed', 'Hourly rate (USD)', 'Amount (USD)',
                  'Incentive (USD)', 'Time spent', 'Status', 'Repo link', 'Notes'];
    const body = tasks.map((t) => [
      t.ref, t.date, t.platform, t.category, t.subCategory,
      t.paidHours, t.hourlyRate, t.totalAmount, t.incentive, t.timeSpent, t.status, t.repoUrl, t.notes
    ].map(csvCell).join(','));

    download([head.map(csvCell).join(','), ...body].join('\r\n'),
      `dynamo-tasks-${todayISO()}.csv`, 'text/csv;charset=utf-8;');
    toast('CSV downloaded.', 'success');
  }

  function exportJSON() {
    if (!tasks.length) { toast('Nothing to back up.', 'warning'); return; }
    download(JSON.stringify(tasks, null, 2), `dynamo-backup-${todayISO()}.json`, 'application/json');
    toast('Backup downloaded.', 'success');
  }

  /** Splits one CSV line, honouring quoted fields containing commas. */
  function splitCsvLine(line) {
    const out = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  function normalise(raw) {
    const status = String(raw.status || 'PENDING').toUpperCase();
    return {
      ref:         String(raw.ref || raw.id || newRef(raw.category)),
      platform:    String(raw.platform || 'General'),
      category:    String(raw.category || 'Uncategorised'),
      subCategory: String(raw.subCategory || raw.sub_category || 'General'),
      paidHours:   Math.max(0, Number(raw.paidHours) || 0),
      hourlyRate:  Math.max(0, Number(raw.hourlyRate) || 0),
      totalAmount: Math.max(0, Number(raw.totalAmount) || 0),
      timeSpent:   Math.max(0, Number(raw.timeSpent) || Number(raw.paidHours) || 0),
      status:      STATUSES.includes(status) ? status : 'PENDING',
      date:        /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : todayISO(),
      notes:       String(raw.notes || ''),
      incentive:   Math.max(0, Number(raw.incentive) || 0),
      repoUrl:     safeUrl(raw.repoUrl || raw.repo_url)
    };
  }

  async function handleImport(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;

    let parsed = [];
    try {
      const text = await file.text();

      if (file.name.toLowerCase().endsWith('.json')) {
        const json = JSON.parse(text);
        if (!Array.isArray(json)) throw new Error('Expected an array');
        parsed = json.map(normalise);
      } else {
        const lines = text.split(/\r?\n/).filter((l) => l.trim());
        if (lines.length < 2) throw new Error('No data rows');
        parsed = lines.slice(1).map((line) => {
          const c = splitCsvLine(line);
          return normalise({
            ref: c[0], date: c[1], platform: c[2], category: c[3], subCategory: c[4],
            paidHours: c[5], hourlyRate: c[6], totalAmount: c[7], incentive: c[8],
            timeSpent: c[9], status: c[10], repoUrl: c[11], notes: c[12]
          });
        });
      }
    } catch (err) {
      console.error('[dynamo] import failed:', err);
      toast('Could not read that file.', 'error');
      return;
    }

    if (!parsed.length) { toast('No tasks found in that file.', 'warning'); return; }

    const yes = await confirmDialog(
      'Import tasks',
      `Add ${parsed.length} ${parsed.length === 1 ? 'task' : 'tasks'} from ${file.name}? Existing tasks are kept.`,
      'Import'
    );
    if (!yes) return;

    const added = await insertMany(parsed);
    if (added) {
      renderAll();
      beep('success');
      toast(`Imported ${added} ${added === 1 ? 'task' : 'tasks'}.`, 'success');
    }
  }

  const SAMPLE = [
    ['RLHF-9421', 'DataAnnotation', 'RLHF & Reasoning',       'Multi-turn logic',    1.50, 42, 63.00, 1.15, 'ACCEPTED', 0,  'Calculus reasoning chain, approved without edits.'],
    ['CODE-8834', 'Outlier AI',     'Coding & Software',      'Python code generation', 2.00, 50, 100.00, 1.60, 'ACCEPTED', 0,  'AST parser plus unit tests.'],
    ['FACT-7712', 'Alignerr',       'Factuality & Grounding', 'Hallucination detection', 0.75, 40, 30.00, 0.80, 'PENDING',  1,  'Citation audit on a financial summary.'],
    ['SAFE-6520', 'Invisible AI',   'Safety & Red Teaming',   'Adversarial testing', 1.25, 45, 56.25, 0.95, 'ACCEPTED', 2,  'Robustness pass on encoded payloads.'],
    ['MATH-5419', 'DataAnnotation', 'Math & Science',         'Multi-turn logic',    2.50, 42, 105.00, 2.10, 'ACCEPTED', 3,  'Step-by-step differential equation checks.'],
    ['EVAL-4310', 'Scale AI',       'Model Evaluation',       'Preference ranking',  1.00, 38, 38.00, 1.20, 'REJECTED', 4,  'Rubric dispute: creativity vs factuality weighting.'],
    ['CODE-3928', 'Outlier AI',     'Coding & Software',      'Code review & fix',   1.75, 50, 87.50, 1.40, 'ACCEPTED', 5,  'Race condition in async queue handling.'],
    ['MULT-2841', 'Mindrift',       'Multimodal & Vision',    'Rubric grading',      1.20, 36, 43.20, 1.35, 'PENDING',  6,  'Chart-reading accuracy across 40 samples.'],
    ['CREA-1750', 'Mercor',         'Creative & Writing',     'Prompt optimisation', 0.90, 44, 39.60, 0.70, 'ACCEPTED', 7,  'Tone-matching rewrites, all accepted.'],
    ['RLHF-1102', 'DataAnnotation', 'RLHF & Reasoning',       'Preference ranking',  2.25, 42, 94.50, 2.00, 'ACCEPTED', 8,  'Side-by-side comparisons, long context.']
  ].map(([ref, platform, category, subCategory, paidHours, hourlyRate, totalAmount, timeSpent, status, ago, notes]) => ({
    ref, platform, category, subCategory, paidHours, hourlyRate, totalAmount, timeSpent, status,
    date: shiftISO(todayISO(), -ago), notes
  }));

  async function loadSample() {
    const yes = await confirmDialog(
      'Load sample data',
      `Adds ${SAMPLE.length} example tasks to your log. Existing tasks are kept.`,
      'Load'
    );
    if (!yes) return;
    const added = await insertMany(SAMPLE);
    if (added) { renderAll(); beep('success'); toast(`Added ${added} sample tasks.`, 'success'); }
  }

  async function clearAll() {
    if (!tasks.length) { toast('Nothing to delete.', 'warning'); return; }
    const yes = await confirmDialog(
      'Delete all tasks',
      `All ${tasks.length} tasks will be permanently removed from Supabase. Download a backup first if you want to keep them.`,
      'Delete all'
    );
    if (!yes) return;
    if (await deleteAll()) { renderAll(); beep('remove'); toast('All tasks deleted.', 'info'); }
  }

  /* -------------------------------------------------------------- events */

  function toggleMenu(open) {
    const menu = $('dataMenu');
    const next = open === undefined ? menu.hidden : open;
    menu.hidden = !next;
    $('btnDataMenu').setAttribute('aria-expanded', String(next));
  }

  function updateSoundIcon() {
    const btn = $('btnSoundToggle');
    const icon = $('soundIcon');
    btn.classList.toggle('is-muted', !settings.sound);
    btn.title = settings.sound ? 'Sound on' : 'Sound off';
    icon.setAttribute('data-lucide', settings.sound ? 'volume-2' : 'volume-x');
    drawIcons();
  }

  function bindEvents() {
    $('btnNewTask').addEventListener('click', () => openDialog(null));
    $('btnEmptyNew').addEventListener('click', () => openDialog(null));
    $('btnCloseDialog').addEventListener('click', closeDialog);
    $('btnCancelDialog').addEventListener('click', closeDialog);
    $('taskForm').addEventListener('submit', submitForm);

    $('scrim').addEventListener('mousedown', (e) => { if (e.target === $('scrim')) closeDialog(); });
    $('confirmScrim').addEventListener('mousedown', (e) => { if (e.target === $('confirmScrim')) closeConfirm(false); });
    $('btnConfirmCancel').addEventListener('click', () => closeConfirm(false));
    $('btnConfirmOk').addEventListener('click', () => closeConfirm(true));

    ['fieldPaidHours', 'fieldRate', 'fieldAmount', 'fieldTimeSpent', 'fieldIncentive']
      .forEach((id) => $(id).addEventListener('input', updateReadout));
    $('fieldStatus').addEventListener('change', () => {
      applyStatusMode();
      updateReadout();
    });

    $('btnGenerateRef').addEventListener('click', () => {
      $('fieldRef').value = newRef($('fieldCategory').value);
    });
    $('btnDateToday').addEventListener('click', () => { $('fieldDate').value = todayISO(); });
    $('btnCalcAmount').addEventListener('click', () => {
      const hours = parseFloat($('fieldPaidHours').value) || 0;
      const rate  = parseFloat($('fieldRate').value) || 0;
      if (hours > 0 && rate > 0) {
        $('fieldAmount').value = (hours * rate).toFixed(2);
        updateReadout();
      } else {
        toast('Enter hours and an hourly rate first.', 'warning');
      }
    });

    $('currencySelect').addEventListener('change', (e) => {
      settings.currency = e.target.value;
      saveSettings();
      renderAll();
    });

    $('btnSoundToggle').addEventListener('click', () => {
      settings.sound = !settings.sound;
      saveSettings();
      updateSoundIcon();
      if (settings.sound) beep('click');
    });

    $('syncChip').addEventListener('click', async () => {
      if (!sb && !connect()) { toast('Supabase config missing.', 'error'); return; }
      const ok = await fetchTasks();
      renderAll();
      toast(ok ? 'Refreshed from Supabase.' : 'Still offline.', ok ? 'success' : 'error');
    });

    let searchTimer;
    $('searchInput').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      const value = e.target.value;
      searchTimer = setTimeout(() => { filters.search = value; renderList(); }, 140);
    });

    $('filterStatus').addEventListener('change',   (e) => { filters.status   = e.target.value; renderList(); });
    $('filterCategory').addEventListener('change', (e) => { filters.category = e.target.value; renderList(); });
    $('filterPlatform').addEventListener('change', (e) => { filters.platform = e.target.value; renderList(); });
    $('sortBy').addEventListener('change',         (e) => { filters.sort     = e.target.value; renderList(); });

    $('viewToggle').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-view]');
      if (!btn) return;
      settings.view = btn.dataset.view;
      saveSettings();
      el('#viewToggle .is-active').classList.remove('is-active');
      btn.classList.add('is-active');
      renderList();
    });

    $('rangeToggle').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-range]');
      if (!btn) return;
      chartRange = btn.dataset.range;
      el('#rangeToggle .is-active').classList.remove('is-active');
      btn.classList.add('is-active');
      renderTimeline();
    });

    $('categoryToggle').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-metric]');
      if (!btn) return;
      chartMetric = btn.dataset.metric;
      el('#categoryToggle .is-active').classList.remove('is-active');
      btn.classList.add('is-active');
      renderCategory();
    });

    $('btnDataMenu').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
    $('dataMenu').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      toggleMenu(false);
      ({
        'export-csv':  exportCSV,
        'export-json': exportJSON,
        'sample':      loadSample,
        'clear':       clearAll
      })[btn.dataset.action]();
    });
    $('importInput').addEventListener('change', handleImport);
    document.addEventListener('click', () => toggleMenu(false));

    // One delegated handler covers both the table and the card grid.
    document.addEventListener('click', (e) => {
      const trigger = e.target.closest('[data-act]');
      if (!trigger) return;

      if (trigger.dataset.act === 'copy-ref') {
        const ref = trigger.dataset.ref;
        navigator.clipboard?.writeText(ref)
          .then(() => toast(`Copied ${ref}.`, 'info'))
          .catch(() => toast('Could not copy.', 'error'));
        return;
      }

      const id = trigger.dataset.id;
      if (!id) return;
      if (trigger.dataset.act === 'edit')   openDialog(tasks.find((t) => t.id === id));
      if (trigger.dataset.act === 'cycle')  cycleStatus(id);
      if (trigger.dataset.act === 'copy')   duplicate(id);
      if (trigger.dataset.act === 'delete') confirmRemove(id);
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('confirmScrim').hidden) closeConfirm(false);
        else if (!$('scrim').hidden) closeDialog();
        else toggleMenu(false);
      }
      if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if ($('scrim').hidden) { e.preventDefault(); openDialog(null); }
      }
    });
  }

  /* ---------------------------------------------------------------- boot */

  async function init() {
    loadSettings();
    $('currencySelect').value = settings.currency;
    updateSoundIcon();

    el(`#viewToggle [data-view="${settings.view}"]`)?.classList.add('is-active');
    if (settings.view !== 'table') el('#viewToggle [data-view="table"]').classList.remove('is-active');

    chartTheme();
    bindEvents();

    // Paint the cached copy first so the page is never blank while we fetch.
    tasks = readCache();
    if (tasks.length) {
      $('footStorage').textContent = 'Loaded from cache';
      renderAll();
    }

    if (connect()) {
      const ok = await fetchTasks();
      $('footStorage').textContent = ok ? 'Synced with Supabase' : 'Cached copy — offline';
      renderAll();
      if (ok) subscribeToChanges();
    } else {
      setConnection('offline', 'Offline');
      $('footStorage').textContent = 'Cached copy — offline';
      renderAll();
    }

    drawIcons();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
