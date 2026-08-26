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

  // Date-range presets for the global filter bar. 'custom' reads scope.from/to.
  const RANGES = {
    '7':      { label: 'Last 7 days' },
    '30':     { label: 'Last 30 days' },
    '90':     { label: 'Last 90 days' },
    'month':  { label: 'This month' },
    'all':    { label: 'All time' },
    'custom': { label: 'Custom range' }
  };

  // Green-forward categorical palette, distinguishable slice-to-slice.
  const SERIES = [
    '#30e089', '#22d3ee', '#a3e635', '#2dd4bf',
    '#4ade80', '#84cc16', '#60a5fa', '#fbbf24',
    '#34d399', '#f472b6'
  ];

  /* --------------------------------------------------------------- state */

  let tasks = [];
  let settings = { currency: 'USD', sound: true, view: 'table' };

  /* The global filter. Every card, chart and row on the page reads this slice,
     so one control set answers one question across the whole dashboard. */
  const scope = {
    range: 'all', from: '', to: '',
    status: 'ALL', category: 'ALL', subCategory: 'ALL', platform: 'ALL'
  };

  /* Log-only controls — they narrow the table, not the metrics above it. */
  let search = '';
  let sortBy = 'date-desc';

  let collapsed = [];        // metric group ids the user has folded away
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
      if (raw) {
        const parsed = JSON.parse(raw) || {};
        if (parsed.scope) Object.assign(scope, parsed.scope);
        if (Array.isArray(parsed.collapsed)) collapsed = parsed.collapsed.slice();
        if (typeof parsed.sort === 'string') sortBy = parsed.sort;
        delete parsed.scope; delete parsed.collapsed; delete parsed.sort;
        Object.assign(settings, parsed);
      }
      if (!FX[settings.currency]) settings.currency = 'USD';
      if (!RANGES[scope.range]) scope.range = 'all';
    } catch (err) { /* fall back to defaults */ }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY,
        JSON.stringify({ ...settings, scope, collapsed, sort: sortBy }));
    } catch (err) { /* quota */ }
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

  /** Inclusive ISO bounds for the active range preset. Blank = open ended. */
  function rangeBounds() {
    const today = todayISO();
    switch (scope.range) {
      case '7':     return { from: shiftISO(today, -6),  to: today };
      case '30':    return { from: shiftISO(today, -29), to: today };
      case '90':    return { from: shiftISO(today, -89), to: today };
      case 'month': return { from: today.slice(0, 8) + '01', to: today };
      case 'custom': {
        let { from, to } = scope;
        if (from && to && from > to) [from, to] = [to, from];
        return { from: from || '', to: to || '' };
      }
      default: return { from: '', to: '' };
    }
  }

  /** Human label for the active range — used by the chips and the chart flag. */
  function rangeLabel() {
    if (scope.range !== 'custom') return (RANGES[scope.range] || RANGES.all).label;
    const { from, to } = rangeBounds();
    if (from && to) return `${shortDate(from)} – ${shortDate(to)}`;
    if (from) return `From ${shortDate(from)}`;
    if (to)   return `Up to ${shortDate(to)}`;
    return 'All time';
  }

  function activeFilterCount() {
    return ['status', 'category', 'subCategory', 'platform'].filter((k) => scope[k] !== 'ALL').length
      + (scope.range !== 'all' ? 1 : 0);
  }

  /**
   * The slice every card, chart and row on the page reads from. One filter set
   * drives the whole dashboard, so the numbers always answer one question.
   */
  function scopedTasks() {
    const { from, to } = rangeBounds();
    return tasks.filter((t) => {
      if (from && (!t.date || t.date < from)) return false;
      if (to   && (!t.date || t.date > to))   return false;
      if (scope.status      !== 'ALL' && t.status      !== scope.status)      return false;
      if (scope.category    !== 'ALL' && t.category    !== scope.category)    return false;
      if (scope.subCategory !== 'ALL' && t.subCategory !== scope.subCategory) return false;
      if (scope.platform    !== 'ALL' && t.platform    !== scope.platform)    return false;
      return true;
    });
  }

  /** The scoped slice narrowed by the log's own search box, then sorted. */
  function visibleTasks() {
    let out = scopedTasks();

    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter((t) =>
        [t.ref, t.category, t.subCategory, t.platform, t.notes, t.repoUrl]
          .some((v) => v && String(v).toLowerCase().includes(q)));
    }

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
    return out.sort(sorters[sortBy] || sorters['date-desc']);
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
  function sumEarnedInRange(list, startISO, endISO) {
    return list.reduce((s, t) => {
      if (!isLogged(t) || !t.date) return s;
      if (t.date < startISO || t.date > endISO) return s;
      return s + earned(t);
    }, 0);
  }

  /** Rolling 7-day window vs the 7 days before it. */
  function weeklyTrend(list) {
    const today = todayISO();
    const thisStart = shiftISO(today, -6);
    const lastEnd   = shiftISO(thisStart, -1);
    const lastStart = shiftISO(lastEnd, -6);
    return {
      thisWeek: sumEarnedInRange(list, thisStart, today),
      lastWeek: sumEarnedInRange(list, lastStart, lastEnd)
    };
  }

  /** Current and best consecutive-day streaks of having at least one logged task. */
  function computeStreaks(list) {
    const dates = new Set(list.filter(isLogged).map((t) => t.date).filter(Boolean));

    let current = 0;
    let cursor = todayISO();
    if (!dates.has(cursor)) cursor = shiftISO(cursor, -1);
    while (dates.has(cursor)) { current++; cursor = shiftISO(cursor, -1); }

    const sorted = Array.from(dates).sort();
    let best = 0, run = 0, prev = null;
    sorted.forEach((d) => {
      run = prev && shiftISO(prev, 1) === d ? run + 1 : 1;
      best = Math.max(best, run);
      prev = d;
    });
    return { current, best };
  }

  /** Highest-earning value of a field, plus its share of realised earnings. */
  function topBucket(list, key) {
    const buckets = {};
    let total = 0;
    list.forEach((t) => {
      if (!isLogged(t)) return;
      const v = earned(t);
      const name = t[key] || 'General';
      buckets[name] = (buckets[name] || 0) + v;
      total += v;
    });
    const ranked = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return null;
    const [name, value] = ranked[0];
    return { name, value, share: total ? (value / total) * 100 : 0 };
  }

  /**
   * The day window the charts and sparklines draw. Follows the active range
   * when it is bounded, otherwise falls back to the span the data covers.
   */
  function chartDays(maxSpan, list) {
    const { from, to } = rangeBounds();
    const dates = (list || []).map((t) => t.date).filter(Boolean).sort();
    const end   = to   || (dates.length ? dates[dates.length - 1] : todayISO());
    const start = from || (dates.length ? dates[0] : end);

    const raw = Math.round((new Date(end + 'T00:00:00') - new Date(start + 'T00:00:00')) / 86400000) + 1;
    const span = Math.max(1, Math.min(maxSpan, raw));
    return Array.from({ length: span }, (_, i) => shiftISO(end, -(span - 1 - i)));
  }

  /** Minimal inline sparkline — an area + line path, styled by CSS custom property. */
  function sparkSvg(values, colorVar) {
    if (values.length < 2 || !values.some((v) => Math.abs(v) > 0.0001)) return '';
    const w = 100, h = 40;
    const max = Math.max(...values, 0);
    const min = Math.min(...values, 0);
    const range = (max - min) || 1;
    const stepX = w / (values.length - 1);
    const pts = values.map((v, i) => `${(i * stepX).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`);
    const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p).join(' ');
    const area = `${line} L${w},${h} L0,${h} Z`;
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="spark-svg">
      <path d="${area}" stroke="none" style="fill:${colorVar};opacity:.14"/>
      <path d="${line}" fill="none" style="stroke:${colorVar}" stroke-width="1.6"
        vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  /* --------------------------------------------------------- metric board */

  /**
   * One card, one number. The board is described here and built once, so a new
   * metric means one entry in this list plus one line in metricValues().
   */
  const METRIC_GROUPS = [
    {
      id: 'earnings',
      title: 'Earnings',
      sub: 'What the filtered work has paid',
      metrics: [
        { id: 'total',           label: 'Total earned',     icon: 'wallet',         tone: 'accent',   lead: true, spark: 'earned' },
        { id: 'approved',        label: 'Approved',         icon: 'circle-check',   tone: 'accepted' },
        { id: 'inReviewAmount',  label: 'In review',        icon: 'hourglass',      tone: 'pending' },
        { id: 'incentiveWon',    label: 'Incentive earned', icon: 'gift',           tone: 'lime' },
        { id: 'incentiveLocked', label: 'Locked incentive', icon: 'lock',           tone: 'pending' },
        { id: 'pipeline',        label: 'In pipeline',      icon: 'git-branch',     tone: 'cool' },
        { id: 'thisWeek',        label: 'This week',        icon: 'calendar-days',  tone: 'accent' },
        { id: 'lastWeek',        label: 'Last week',        icon: 'calendar-range', tone: 'cool' },
        { id: 'avgTask',         label: 'Avg per task',     icon: 'layers',         tone: 'accepted' }
      ]
    },
    {
      id: 'delivery',
      title: 'Delivery',
      sub: 'How the work is being received',
      metrics: [
        { id: 'acceptance',  label: 'Acceptance rate', icon: 'badge-check',  tone: 'accepted', lead: true, meter: true },
        { id: 'accepted',    label: 'Accepted',        icon: 'circle-check', tone: 'accepted' },
        { id: 'inReview',    label: 'In review',       icon: 'clock-3',      tone: 'pending' },
        { id: 'rejected',    label: 'Rejected',        icon: 'circle-x',     tone: 'rejected' },
        { id: 'inProgress',  label: 'In progress',     icon: 'loader',       tone: 'cool' },
        { id: 'logged',      label: 'Logged tasks',    icon: 'list-checks',  tone: 'accent' },
        { id: 'inView',      label: 'Tasks in view',   icon: 'filter',       tone: 'lime' },
        { id: 'streak',      label: 'Current streak',  icon: 'flame',        tone: 'warm' },
        { id: 'bestStreak',  label: 'Best streak',     icon: 'trophy',       tone: 'warm' }
      ]
    },
    {
      id: 'time',
      title: 'Time & rate',
      sub: 'Where the hours actually go',
      metrics: [
        { id: 'effRate',     label: 'Effective rate',   icon: 'gauge',     tone: 'warm', lead: true, spark: 'rate' },
        { id: 'billedRate',  label: 'Billed rate',      icon: 'receipt',   tone: 'accent' },
        { id: 'hoursBilled', label: 'Hours billed',     icon: 'clock-3',   tone: 'cool' },
        { id: 'hoursWorked', label: 'Hours worked',     icon: 'timer',     tone: 'cool' },
        { id: 'variance',    label: 'Time variance',    icon: 'scale',     tone: 'accent' },
        { id: 'avgHours',    label: 'Avg hours / task', icon: 'hourglass', tone: 'cool' },
        { id: 'utilisation', label: 'Time used',        icon: 'zap',       tone: 'lime' },
        { id: 'topPlatform', label: 'Top platform',     icon: 'server',    tone: 'cool',   text: true },
        { id: 'topCategory', label: 'Top category',     icon: 'shapes',    tone: 'accent', text: true }
      ]
    }
  ];

  const SPARK_COLOR = { earned: 'var(--accent)', rate: 'var(--pending)' };

  function metricCardHtml(m) {
    let visual = '';
    if (m.spark) {
      visual = `<div class="metric-visual spark" data-spark="${m.spark}"></div>`;
    } else if (m.meter) {
      visual = `
        <div class="metric-visual">
          <div class="meter" role="img" aria-label="Status breakdown">
            <span class="meter-seg is-accepted" data-seg="accepted"></span>
            <span class="meter-seg is-pending"  data-seg="inReview"></span>
            <span class="meter-seg is-rejected" data-seg="rejected"></span>
            <span class="meter-seg is-progress" data-seg="inProgress"></span>
          </div>
          <div class="meter-key" data-meter-key></div>
        </div>`;
    }
    return `
      <article class="metric${m.lead ? ' is-lead' : ''}" data-metric="${m.id}" data-tone="${m.tone}">
        <div class="metric-head">
          <p class="metric-label">${escapeHtml(m.label)}</p>
          <span class="metric-icon" aria-hidden="true"><i data-lucide="${m.icon}"></i></span>
        </div>
        <p class="metric-value${m.text ? ' is-text' : ''}" data-value>—</p>
        <p class="metric-note" data-note></p>
        ${visual}
      </article>`;
  }

  /** Paints the board skeleton once; renderMetrics() only writes values into it. */
  function buildMetricBoard() {
    $('metricBoard').innerHTML = METRIC_GROUPS.map((g) => `
      <section class="metric-group${collapsed.includes(g.id) ? ' is-collapsed' : ''}" data-group="${g.id}">
        <div class="metric-group-head">
          <button type="button" class="metric-group-toggle" data-toggle-group="${g.id}"
            title="Show or hide this group" aria-label="Toggle ${escapeHtml(g.title)}">
            <i data-lucide="chevron-down"></i>
          </button>
          <h2 class="metric-group-title">${escapeHtml(g.title)}</h2>
          <p class="metric-group-sub">${escapeHtml(g.sub)}</p>
          <span class="metric-group-rule" aria-hidden="true"></span>
        </div>
        <div class="metric-grid">${g.metrics.map(metricCardHtml).join('')}</div>
      </section>`).join('');
  }

  /* ------------------------------------------------------- metric values */

  /** Currency value with the symbol set a size down, so the digits lead. */
  function moneyHtml(usd) {
    const v = toDisplay(usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `<span class="metric-sym">${escapeHtml(fx().symbol)}</span>${v}`;
  }

  const unit = (text) => `<span class="metric-unit">${escapeHtml(text)}</span>`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function metricValues(scoped) {
    const t = totals(scoped);
    const pct = (n) => (t.count ? Math.round((n / t.count) * 100) : 0);

    const acceptance  = t.reviewed ? (t.accepted / t.reviewed) * 100 : 0;
    const variance    = t.paidHours - t.actualHours;
    const effective   = t.actualHours > 0 ? t.amount / t.actualHours : 0;
    const billedRate  = t.paidHours   > 0 ? t.amount / t.paidHours   : 0;
    const utilisation = t.paidHours   > 0 ? (t.actualHours / t.paidHours) * 100 : 0;
    const avgHours    = t.reviewed ? t.paidHours / t.reviewed : 0;

    const { thisWeek, lastWeek } = weeklyTrend(scoped);
    const streaks = computeStreaks(scoped);
    const plat = topBucket(scoped, 'platform');
    const cat  = topBucket(scoped, 'category');

    let weekNote;
    if (!thisWeek && !lastWeek) weekNote = 'Nothing logged in the last 7 days';
    else if (!lastWeek) weekNote = '<span class="trend-up">New this week</span>';
    else {
      const delta = ((thisWeek - lastWeek) / lastWeek) * 100;
      const up = delta >= 0;
      weekNote = `<span class="${up ? 'trend-up' : 'trend-down'}">${up ? '▲' : '▼'} ${Math.abs(delta).toFixed(0)}%</span> vs last week`;
    }

    const varianceTone = variance >= 0 ? 'text-accepted' : 'text-rejected';

    return {
      /* --- earnings --- */
      total: {
        value: moneyHtml(t.amount),
        note: t.reviewed
          ? `Realised across ${plural(t.reviewed, 'logged task')}`
          : 'Nothing logged in this view yet'
      },
      approved: {
        value: moneyHtml(t.approved),
        note: t.accepted ? `${plural(t.accepted, 'task')} accepted` : 'No accepted tasks yet'
      },
      inReviewAmount: {
        value: moneyHtml(t.pending),
        note: t.inReview ? `${plural(t.inReview, 'task')} awaiting a verdict` : 'Nothing awaiting review'
      },
      incentiveWon: {
        value: moneyHtml(t.incentiveWon),
        note: 'Bonus already banked on accepted work'
      },
      incentiveLocked: {
        value: moneyHtml(t.incentiveLocked),
        note: 'Unlocks only if those tasks are accepted'
      },
      pipeline: {
        value: moneyHtml(t.pipelineAmount),
        note: t.inProgress
          ? `${plural(t.inProgress, 'task')} in progress · ${t.pipelineHours.toFixed(1)}h to bill`
          : 'No work in progress'
      },
      thisWeek: { value: moneyHtml(thisWeek), note: weekNote },
      lastWeek: { value: moneyHtml(lastWeek), note: 'The 7 days before this one' },
      avgTask: {
        value: moneyHtml(t.reviewed ? t.amount / t.reviewed : 0),
        note: t.reviewed ? `Mean of ${plural(t.reviewed, 'logged task')}` : 'No tasks yet'
      },

      /* --- delivery --- */
      acceptance: {
        value: `${acceptance.toFixed(acceptance % 1 === 0 ? 0 : 1)}${unit('%')}`,
        note: t.reviewed
          ? `${t.accepted} accepted of ${plural(t.reviewed, 'reviewed task')}`
          : 'Nothing has been reviewed yet'
      },
      accepted:   { value: String(t.accepted),   note: `${pct(t.accepted)}% of tasks in view` },
      inReview:   { value: String(t.inReview),   note: `${pct(t.inReview)}% of tasks in view` },
      rejected:   { value: String(t.rejected),   note: `${pct(t.rejected)}% of tasks in view` },
      inProgress: { value: String(t.inProgress), note: `${t.pipelineHours.toFixed(1)}h still to bill` },
      logged:     { value: String(t.reviewed),   note: 'Submitted, so they count towards earnings' },
      inView:     {
        value: String(t.count),
        note: tasks.length === t.count ? 'Every task you have logged' : `Filtered from ${plural(tasks.length, 'task')}`
      },
      streak: {
        value: `${streaks.current}${unit(streaks.current === 1 ? 'day' : 'days')}`,
        note: 'Consecutive days with logged work'
      },
      bestStreak: {
        value: `${streaks.best}${unit(streaks.best === 1 ? 'day' : 'days')}`,
        note: 'Longest run in this view'
      },

      /* --- time & rate --- */
      effRate: {
        value: `${moneyHtml(effective)}${unit('/hr')}`,
        note: t.actualHours > 0
          ? `Over ${t.actualHours.toFixed(1)}h actually worked`
          : 'Log time spent to see a real rate'
      },
      billedRate: {
        value: `${moneyHtml(billedRate)}${unit('/hr')}`,
        note: t.paidHours > 0 ? `Over ${t.paidHours.toFixed(1)}h billed` : 'No billed hours yet'
      },
      hoursBilled: { value: `${t.paidHours.toFixed(1)}${unit('h')}`,   note: 'Hours submitted for payment' },
      hoursWorked: { value: `${t.actualHours.toFixed(1)}${unit('h')}`, note: 'Hours you actually spent' },
      variance: {
        value: `<span class="${t.count ? varianceTone : ''}">${variance >= 0 ? '+' : '−'}${Math.abs(variance).toFixed(1)}</span>${unit('h')}`,
        note: !t.count ? 'No tasks in view'
          : variance >= 0 ? 'Ahead — billed more than you worked' : 'Over — worked more than you billed'
      },
      avgHours: {
        value: `${avgHours.toFixed(2)}${unit('h')}`,
        note: t.reviewed ? 'Billed per logged task' : 'No tasks yet'
      },
      utilisation: {
        value: `${utilisation.toFixed(0)}${unit('%')}`,
        note: t.paidHours > 0 ? 'Of billed hours actually spent' : 'No billed hours yet'
      },
      topPlatform: {
        value: plat ? escapeHtml(plat.name) : '—',
        title: plat ? plat.name : '',
        note: plat ? `${money(plat.value)} · ${Math.round(plat.share)}% of earnings` : 'No data yet'
      },
      topCategory: {
        value: cat ? escapeHtml(cat.name) : '—',
        title: cat ? cat.name : '',
        note: cat ? `${money(cat.value)} · ${Math.round(cat.share)}% of earnings` : 'No data yet'
      },

      /* --- consumed by the meter, not a card of its own --- */
      _meter: t
    };
  }

  function renderMeter(t) {
    const board = $('metricBoard');
    const pct = (n) => (t.count ? (n / t.count) * 100 : 0);
    board.querySelectorAll('[data-seg]').forEach((seg) => {
      seg.style.width = pct(t[seg.dataset.seg]) + '%';
    });

    const key = board.querySelector('[data-meter-key]');
    if (!key) return;
    const parts = [
      ['accepted', 'is-accepted', 'Accepted'],
      ['inReview', 'is-pending',  'In review'],
      ['rejected', 'is-rejected', 'Rejected'],
      ['inProgress', 'is-progress', 'In progress']
    ].filter(([field]) => t[field] > 0);

    key.innerHTML = parts.length
      ? parts.map(([field, cls, label]) =>
          `<span><i class="${cls}"></i>${label} ${t[field]}</span>`).join('')
      : '<span>No tasks in this view</span>';
  }

  function renderSparks(scoped) {
    const days = chartDays(90, scoped);
    const perDay = days.map((d) => scoped.filter((t) => t.date === d && isLogged(t)));

    const series = {
      earned: perDay.map((list) => toDisplay(list.reduce((s, t) => s + earned(t), 0))),
      rate: perDay.map((list) => {
        const hrs = list.reduce((s, t) => s + t.timeSpent, 0);
        const amt = list.reduce((s, t) => s + earned(t), 0);
        return hrs > 0 ? toDisplay(amt / hrs) : 0;
      })
    };

    $('metricBoard').querySelectorAll('[data-spark]').forEach((node) => {
      const key = node.dataset.spark;
      node.innerHTML = sparkSvg(series[key] || [], SPARK_COLOR[key] || 'var(--accent)');
    });
  }

  function renderMetrics(scoped) {
    const symbol = fx().symbol;
    document.querySelectorAll('.cur-sym').forEach((n) => { n.textContent = symbol; });
    $('dialogCurrency').textContent = settings.currency;
    $('footFx').textContent = settings.currency === 'USD'
      ? 'Amounts stored in USD'
      : `Stored in USD · shown in ${settings.currency} at ${fx().rate}`;

    const values = metricValues(scoped);

    $('metricBoard').querySelectorAll('[data-metric]').forEach((card) => {
      const v = values[card.dataset.metric];
      if (!v) return;
      const valueEl = card.querySelector('[data-value]');
      valueEl.innerHTML = v.value;
      if (v.title) valueEl.title = v.title; else valueEl.removeAttribute('title');
      card.querySelector('[data-note]').innerHTML = v.note || '';
    });

    renderMeter(values._meter);
    renderSparks(scoped);
  }

  /* -------------------------------------------------------- filter chrome */

  const SELECT_FOR = {
    status: 'filterStatus',
    category: 'filterCategory',
    subCategory: 'filterSubCategory',
    platform: 'filterPlatform'
  };

  function syncRangeUI() {
    const host = $('rangeFilter');
    host.querySelectorAll('[data-range]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.range === scope.range);
    });
    $('customRange').hidden = scope.range !== 'custom';
    $('rangeFrom').value = scope.from || '';
    $('rangeTo').value   = scope.to   || '';
  }

  function syncFilterUI() {
    Object.entries(SELECT_FOR).forEach(([key, id]) => {
      const select = $(id);
      if (select) select.value = scope[key];
    });
    syncRangeUI();
  }

  function resetFilters() {
    scope.range = 'all';
    scope.from = '';
    scope.to = '';
    scope.status = 'ALL';
    scope.category = 'ALL';
    scope.subCategory = 'ALL';
    scope.platform = 'ALL';
    search = '';
    $('searchInput').value = '';
    syncFilterUI();
  }

  function clearFilter(key) {
    if (key === 'all') { resetFilters(); return; }
    if (key === 'range') { scope.range = 'all'; scope.from = ''; scope.to = ''; syncRangeUI(); return; }
    if (key === 'search') { search = ''; $('searchInput').value = ''; return; }
    scope[key] = 'ALL';
    const select = $(SELECT_FOR[key]);
    if (select) select.value = 'ALL';
  }

  function renderFilterChips() {
    const host = $('filterChips');
    const chips = [];

    if (scope.range !== 'all')       chips.push(['range', 'Range', rangeLabel()]);
    if (scope.status !== 'ALL')      chips.push(['status', 'Status', STATUS_LABEL[scope.status] || scope.status]);
    if (scope.category !== 'ALL')    chips.push(['category', 'Category', scope.category]);
    if (scope.subCategory !== 'ALL') chips.push(['subCategory', 'Sub-category', scope.subCategory]);
    if (scope.platform !== 'ALL')    chips.push(['platform', 'Platform', scope.platform]);
    if (search.trim())               chips.push(['search', 'Search', search.trim()]);

    host.hidden = chips.length === 0;
    if (!chips.length) { host.innerHTML = ''; return; }

    host.innerHTML = chips.map(([key, label, value]) => `
      <span class="chip">${escapeHtml(label)} <b>${escapeHtml(value)}</b>
        <button type="button" class="chip-x" data-clear="${key}" title="Clear this filter"
          aria-label="Clear ${escapeHtml(label)} filter"><i data-lucide="x"></i></button>
      </span>`).join('') +
      (chips.length > 1 ? '<button type="button" class="chip-clear" data-clear="all">Clear all</button>' : '');
  }

  function renderScopeSummary(scoped) {
    const n = activeFilterCount();
    const parts = [];
    if (!tasks.length) parts.push('No tasks yet');
    else parts.push(tasks.length === scoped.length
      ? `All ${plural(tasks.length, 'task')}`
      : `${scoped.length} of ${plural(tasks.length, 'task')}`);
    parts.push(rangeLabel());
    if (n) parts.push(`${plural(n, 'filter')} on`);
    $('scopeSummary').textContent = parts.join(' · ');
    $('timelineRange').textContent = rangeLabel();
  }

  function renderHeatmap(scoped) {
    const host = $('activityHeatmap');
    if (!host) return;

    const WEEKS = 14;
    const today = todayISO();
    const dowMon0 = (new Date(today + 'T00:00:00').getDay() + 6) % 7; // Monday=0 … Sunday=6
    const currentMonday = shiftISO(today, -dowMon0);
    const startMonday = shiftISO(currentMonday, -(WEEKS - 1) * 7);
    const days = Array.from({ length: WEEKS * 7 }, (_, i) => shiftISO(startMonday, i));

    const perDay = {};
    scoped.forEach((t) => {
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

  function renderPlatform(scoped) {
    const canvas = $('platformChart');
    const emptyEl = $('platformEmpty');
    if (!canvas || typeof Chart === 'undefined') return;

    const buckets = {};
    scoped.forEach((t) => {
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

  /** Rebuilds the value lists from whatever is in the log; drops stale picks. */
  function renderFilterOptions() {
    [['filterCategory',    'category',    'All categories'],
     ['filterSubCategory', 'subCategory', 'All sub-categories'],
     ['filterPlatform',    'platform',    'All platforms']].forEach(([id, key, allLabel]) => {
      const select = $(id);
      if (!select) return;
      const values = Array.from(new Set(tasks.map((t) => t[key]).filter(Boolean))).sort();
      const current = scope[key];
      select.innerHTML = `<option value="ALL">${allLabel}</option>` +
        values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
      if (values.includes(current)) select.value = current;
      else { select.value = 'ALL'; scope[key] = 'ALL'; }
    });
    $('filterStatus').value = scope.status;
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
      : `${list.length} of ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} shown`;
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

  function renderTimeline(scoped) {
    const canvas = $('timelineChart');
    if (!canvas || typeof Chart === 'undefined') return;

    const days = chartDays(90, scoped);

    const perDay = days.map((d) =>
      toDisplay(scoped.filter((t) => t.date === d).reduce((s, t) => s + earned(t), 0)));
    const worked = days.map((d) =>
      scoped.filter((t) => t.date === d).reduce((s, t) => s + t.timeSpent, 0));

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

  function renderCategory(scoped) {
    const canvas = $('categoryChart');
    if (!canvas || typeof Chart === 'undefined') return;

    const buckets = {};
    scoped.forEach((t) => {
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
    // Options first: a filter pointing at a value that no longer exists is
    // dropped here, before anything reads the slice.
    renderFilterOptions();

    const scoped = scopedTasks();
    renderScopeSummary(scoped);
    renderFilterChips();
    renderMetrics(scoped);
    renderList();
    renderTimeline(scoped);
    renderCategory(scoped);
    renderHeatmap(scoped);
    renderPlatform(scoped);
    drawIcons();
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
      searchTimer = setTimeout(() => {
        search = value;
        renderList();
        renderFilterChips();
        drawIcons();
      }, 140);
    });

    // Every control below repaints the whole page, not just the table — the
    // point of the filter bar is that the metrics move with it.
    Object.entries(SELECT_FOR).forEach(([key, id]) => {
      $(id).addEventListener('change', (e) => {
        scope[key] = e.target.value;
        saveSettings();
        renderAll();
      });
    });

    $('rangeFilter').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-range]');
      if (!btn) return;
      scope.range = btn.dataset.range;
      syncRangeUI();
      saveSettings();
      renderAll();
    });

    ['rangeFrom', 'rangeTo'].forEach((id) => {
      $(id).addEventListener('change', (e) => {
        scope[id === 'rangeFrom' ? 'from' : 'to'] = e.target.value;
        scope.range = 'custom';
        syncRangeUI();
        saveSettings();
        renderAll();
      });
    });

    $('btnResetFilters').addEventListener('click', () => {
      if (!activeFilterCount() && !search.trim()) { toast('No filters to clear.', 'info'); return; }
      resetFilters();
      saveSettings();
      renderAll();
      toast('Filters cleared.', 'info');
    });

    $('filterChips').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-clear]');
      if (!btn) return;
      clearFilter(btn.dataset.clear);
      saveSettings();
      renderAll();
    });

    $('metricBoard').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-toggle-group]');
      if (!btn) return;
      const group = btn.closest('.metric-group');
      const id = btn.dataset.toggleGroup;
      const folded = !group.classList.contains('is-collapsed');
      group.classList.toggle('is-collapsed', folded);
      collapsed = folded ? collapsed.concat(id) : collapsed.filter((g) => g !== id);
      saveSettings();
    });

    $('sortBy').addEventListener('change', (e) => {
      sortBy = e.target.value;
      saveSettings();
      renderList();
    });

    $('viewToggle').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-view]');
      if (!btn) return;
      settings.view = btn.dataset.view;
      saveSettings();
      el('#viewToggle .is-active').classList.remove('is-active');
      btn.classList.add('is-active');
      renderList();
    });

    $('categoryToggle').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-metric]');
      if (!btn) return;
      chartMetric = btn.dataset.metric;
      el('#categoryToggle .is-active').classList.remove('is-active');
      btn.classList.add('is-active');
      renderCategory(scopedTasks());
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
    $('sortBy').value = sortBy;
    updateSoundIcon();

    el(`#viewToggle [data-view="${settings.view}"]`)?.classList.add('is-active');
    if (settings.view !== 'table') el('#viewToggle [data-view="table"]').classList.remove('is-active');

    buildMetricBoard();
    syncFilterUI();
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
