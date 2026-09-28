(() => {
  'use strict';

  const DATA = window.CARD_DATA;
  const CARDS = DATA.cards;
  const STORAGE_KEY = 'card-decoder-state-v4';
  const PRESET_KEY = 'card-decoder-custom-presets-v1';
  const SESSION_HISTORY_KEY = 'card-decoder-session-history-v1';
  const BUILTIN_PRESETS = Array.isArray(window.ACTIVITY_PRESETS) ? window.ACTIVITY_PRESETS : [];
  const WALLPAPERS = Array.isArray(window.CARD_DECODER_WALLPAPERS) ? window.CARD_DECODER_WALLPAPERS.filter(Boolean) : [];
  const FALLBACK_CONFIG = {
    puzzles: 9, totalHints: 11, totalChallenges: 36,
    premiumPuzzles: 3,
    milestones: [{ matches: 1, points: 10 }, { matches: 3, points: 10 }, { matches: 5, points: 10 }],
    solvePoints: 70,
    regularMatchPoints: 1,
    regularSolvePoints: 0,
  };
  const FIELDS = [
    { key: 'border', prop: 'b', bit: 1, icon: '框', label: '卡片边框' },
    { key: 'attribute', prop: 'a', bit: 2, icon: '属', label: '属性' },
    { key: 'race', prop: 'r', bit: 4, icon: '族', label: '种族' },
    { key: 'number', prop: 'n', bit: 8, icon: '级', label: '等级／阶级／连接' },
    { key: 'attack', prop: 'atk', bit: 16, icon: '攻', label: '攻击力' },
    { key: 'defense', prop: 'def', bit: 32, icon: '守', label: '守备力' },
  ];

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const normalizeConfig = (value = {}) => {
    const legacyDays = clampInt(value.days, 1, 99, 1);
    const legacyHints = clampInt(value.initialHints, 0, 999, FALLBACK_CONFIG.totalHints)
      + Math.max(0, legacyDays - 1) * clampInt(value.dailyHints, 0, 999, 0);
    const legacyChallenges = clampInt(value.initialChallenges, 0, 999, FALLBACK_CONFIG.totalChallenges)
      + Math.max(0, legacyDays - 1) * clampInt(value.dailyChallenges, 0, 999, 0);
    return ({
    puzzles: clampInt(value.puzzles, 1, 99, FALLBACK_CONFIG.puzzles),
    totalHints: clampInt(value.totalHints, 0, 999, legacyHints),
    totalChallenges: clampInt(value.totalChallenges, 0, 999, legacyChallenges),
    premiumPuzzles: clampInt(value.premiumPuzzles, 0, clampInt(value.puzzles, 1, 99, FALLBACK_CONFIG.puzzles), FALLBACK_CONFIG.premiumPuzzles),
    milestones: (Array.isArray(value.milestones) ? value.milestones : FALLBACK_CONFIG.milestones)
      .map((item) => ({ matches: clampInt(item.matches, 1, 5, 1), points: clampInt(item.points, 0, 99999, 0) }))
      .sort((a, b) => a.matches - b.matches)
      .filter((item, index, list) => index === 0 || item.matches !== list[index - 1].matches),
    solvePoints: clampInt(value.solvePoints, 0, 99999, FALLBACK_CONFIG.solvePoints),
    regularMatchPoints: clampInt(value.regularMatchPoints, 0, 99999, FALLBACK_CONFIG.regularMatchPoints),
    regularSolvePoints: clampInt(value.regularSolvePoints, 0, 99999, FALLBACK_CONFIG.regularSolvePoints),
  });
  };
  const defaultConfig = () => normalizeConfig(BUILTIN_PRESETS[0]?.config || FALLBACK_CONFIG);
  const freshState = (config = defaultConfig()) => ({
    config: normalizeConfig(config),
    presetId: BUILTIN_PRESETS[0]?.id || 'default',
    puzzle: 1,
    hints: normalizeConfig(config).totalHints,
    challenges: normalizeConfig(config).totalChallenges,
    totalScore: 0,
    premiumScore: 0,
    progressScore: 0,
    puzzleScore: 0,
    pool: 'md',
    known: {},
    matchedMask: 0,
    logs: [],
    activityHistory: [],
    activityId: `activity-${Date.now()}`,
    initialUsed: false,
    solved: false,
    theme: localStorage.getItem('card-decoder-theme') || 'dark',
    imageQuality: localStorage.getItem('card-decoder-image-quality') || 'high',
  });

  let state = loadState();
  let undoStack = [];
  let candidateCache = [];
  let selectedGuess = null;
  let feedbackMask = 0;
  let borderRevealValue = null;
  let lastRecommendations = [];
  let lastQuickMetrics = [];
  let lastAdvice = null;
  let lastProof = null;
  let calculationToken = 0;
  let toastTimer = null;
  let testSession = null;
  let pendingTestTarget = null;
  let comparisonIndices = [];
  let comparisonStrategyResults = new Map();
  let comparisonCalculationToken = 0;
  let strategyExperimentWorker = null;
  let strategyExperimentRows = [
    { name:'基准', depth:3, budget:24000 },
    { name:'增强', depth:3, budget:80000 },
    { name:'深度4', depth:4, budget:200000 },
    { name:'深度5', depth:5, budget:500000 },
  ];
  let simulationRunning = false;
  let simulationWorkers = [];
  let simulationWorkerUrl = null;
  let simulationSnapshot = null;
  let simulationStartedAt = 0;
  let wallpaperTimer = null;
  let challengeSemanticsMigrated = false;
  let manualImportLines = [];

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved || typeof saved !== 'object') return freshState();
      const legacyConfig = saved.config || defaultConfig();
      const base = freshState(legacyConfig);
      const merged = { ...base, ...saved, config: normalizeConfig(saved.config || defaultConfig()) };
      if (legacyConfig.totalHints == null && saved.day != null) {
        const remainingDays = Math.max(0, clampInt(legacyConfig.days, 1, 99, 1) - clampInt(saved.day, 1, 99, 1));
        merged.hints = Math.min(merged.config.totalHints, clampInt(saved.hints, 0, 999, 0) + remainingDays * clampInt(legacyConfig.dailyHints, 0, 999, 0));
        merged.challenges = Math.min(merged.config.totalChallenges, clampInt(saved.challenges, 0, 999, 0) + remainingDays * clampInt(legacyConfig.dailyChallenges, 0, 999, 0));
      }
      if (!Array.isArray(merged.activityHistory)) merged.activityHistory = [];
      if (!merged.activityId) merged.activityId = `activity-${Date.now()}`;
      if (!merged.activityHistory.length && Array.isArray(merged.logs) && merged.logs.length) {
        merged.activityHistory = merged.logs.map((log, index) => ({ ...log, id: `migrated-${index}`, activityId: merged.activityId, puzzle: merged.puzzle, mode: 'activity', timestamp: Date.now() + index }));
      }
      if (saved.premiumScore == null) merged.premiumScore = saved.totalScore || 0;
      if (saved.progressScore == null) merged.progressScore = 0;
      return merged;
    } catch {
      return freshState();
    }
  }

  function saveState() {
    if (testSession) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function readSessionHistory() {
    try {
      const history = JSON.parse(sessionStorage.getItem(SESSION_HISTORY_KEY));
      return Array.isArray(history) ? history : [];
    } catch { return []; }
  }

  function appendHistory(entry) {
    const record = {
      ...clone(entry),
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      activityId: state.activityId,
      puzzle: state.puzzle,
      mode: testSession?.mode || 'activity',
      timestamp: Date.now(),
      candidates: candidateMass(),
    };
    state.activityHistory.push(record);
    if (state.activityHistory.length > 240) state.activityHistory.shift();
    const session = readSessionHistory();
    session.push(record);
    sessionStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(session.slice(-500)));
  }

  function syncCurrentActivityHistory() {
    const unrelated = readSessionHistory().filter((item) => item.activityId !== state.activityId);
    sessionStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify([...unrelated, ...(state.activityHistory || [])].slice(-500)));
  }

  function removeActivityFromSession(activityId) {
    sessionStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(readSessionHistory().filter((item) => item.activityId !== activityId)));
  }

  function clampInt(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  }

  function allPresets() {
    let custom = [];
    try { custom = JSON.parse(localStorage.getItem(PRESET_KEY)) || []; } catch { custom = []; }
    return [...BUILTIN_PRESETS, ...custom];
  }

  function isPremiumPuzzle(puzzle = state.puzzle, config = state.config) {
    return puzzle <= config.premiumPuzzles;
  }

  function solveReward(config = state.config, puzzle = state.puzzle) {
    return isPremiumPuzzle(puzzle, config) ? config.solvePoints : config.regularSolvePoints;
  }

  function maxPuzzleScore(config = state.config, puzzle = state.puzzle) {
    if (!isPremiumPuzzle(puzzle, config)) return 6 * config.regularMatchPoints + config.regularSolvePoints;
    return config.milestones.reduce((sum, item) => sum + item.points, 0) + config.solvePoints;
  }

  function maxActivityScore(config = state.config) {
    let total = 0;
    for (let puzzle = 1; puzzle <= config.puzzles; puzzle += 1) total += maxPuzzleScore(config, puzzle);
    return total;
  }

  function cardImageUrlsForId(id, quality = state.imageQuality) {
    if (!id) return [];
    const key = String(id);
    const shard = key.padStart(8, '0').slice(0, 2);
    const high = `card-images-high/${shard}/${key}.jpg`;
    const chinese = `card-images-zh/${shard}/${key}.webp`;
    if (quality === 'zh') return [chinese, high];
    return [high];
  }

  function cardImageUrl(card, quality = state.imageQuality) {
    return cardImageUrlsForId(card?.ids?.[0], quality)[0] || '';
  }

  function setCardImage(element, card, visible = true, fallback = '') {
    const urls = [...new Set(cardImageUrlsForId(card?.ids?.[0]))];
    let cursor = 0;
    element.hidden = !visible || (!urls.length && !fallback);
    element.dataset.zoomable = urls.length ? 'true' : 'false';
    if (!element.hidden) {
      element.src = urls[0] || fallback;
      element.alt = urls.length ? `${card.name} 卡图` : '未知目标卡';
      element.onerror = () => {
        cursor += 1;
        if (cursor < urls.length) {
          element.src = urls[cursor];
        } else if (fallback && element.getAttribute('src') !== fallback) {
          element.src = fallback;
          element.alt = '未知目标卡';
          element.dataset.zoomable = 'false';
        } else {
          element.hidden = true;
          element.dataset.zoomable = 'false';
        }
      };
    }
  }

  function rotateWallpaper(element, avoidPath = null) {
    if (!element || !WALLPAPERS.length) return null;
    const choices = WALLPAPERS.filter((path) => path !== avoidPath);
    const path = choices[Math.floor(Math.random() * choices.length)] || WALLPAPERS[0];
    const container = element.parentElement;
    let layers = [...container.querySelectorAll('img')];
    if (layers.length < 2) {
      const layer = document.createElement('img');
      layer.alt = '';
      container.appendChild(layer);
      layers = [...container.querySelectorAll('img')];
    }
    const active = layers.find((layer) => layer.classList.contains('is-visible')) || null;
    const incoming = layers.find((layer) => layer !== active) || layers[0];
    const preload = new Image();
    preload.onload = () => {
      incoming.src = path;
      incoming.classList.remove('is-fading');
      requestAnimationFrame(() => requestAnimationFrame(() => {
        incoming.classList.add('is-visible');
        if (active && active !== incoming) {
          active.classList.add('is-fading');
          active.classList.remove('is-visible');
        }
      }));
    };
    preload.onerror = () => incoming.classList.remove('is-visible');
    preload.src = path;
    return path;
  }

  function startWallpaperCycle() {
    let leftPath = rotateWallpaper($('#wallpaperLeft'));
    rotateWallpaper($('#wallpaperRight'), leftPath);
    clearInterval(wallpaperTimer);
    wallpaperTimer = setInterval(() => {
      leftPath = rotateWallpaper($('#wallpaperLeft'));
      setTimeout(() => rotateWallpaper($('#wallpaperRight'), leftPath), 1400);
    }, 45000);
  }

  function pushUndo() {
    undoStack.push(clone(state));
    if (undoStack.length > 30) undoStack.shift();
  }

  function toast(message) {
    const element = $('#toast');
    const openDialogs = [...document.querySelectorAll('dialog[open]')];
    (openDialogs.at(-1) || document.body).appendChild(element);
    element.textContent = message;
    element.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { element.hidden = true; }, 3200);
  }

  function weightOf(card, pool = state.pool) {
    return pool === 'md' ? card.wm : card.wa;
  }

  function popcount(mask) {
    let count = 0;
    for (let value = mask & 63; value; value &= value - 1) count += 1;
    return count;
  }

  function formatBorder(mask) {
    return Object.entries(DATA.labels.frame)
      .filter(([bit]) => mask & Number(bit))
      .map(([, label]) => label)
      .join('／');
  }

  function formatStat(value) {
    if (value === -3) return '无';
    if (value === -2) return '?';
    return String(value);
  }

  function formatValue(field, value) {
    if (field === 'border') return formatBorder(Number(value));
    if (field === 'attribute') return DATA.labels.attribute[value] || String(value);
    if (field === 'race') return DATA.labels.race[value] || String(value);
    if (field === 'attack' || field === 'defense') return formatStat(Number(value));
    return String(value);
  }

  function fieldValue(card, key) {
    const field = FIELDS.find((item) => item.key === key);
    return card[field.prop];
  }

  function cardStats(card) {
    return `${formatBorder(card.b)} · ${DATA.labels.attribute[card.a] || card.a} · ${DATA.labels.race[card.r] || card.r} · ${card.n} · ${formatStat(card.atk)}／${formatStat(card.def)}`;
  }

  async function copyCardName(card) {
    if (!card) return;
    try { await navigator.clipboard.writeText(card.name); toast(`已复制卡名：${card.name}`); }
    catch { toast('复制失败，请手动选择卡名。'); }
  }

  function openGroupDialog(index) {
    const card = CARDS[Number(index)];
    if (!card) return;
    $('#groupDialogTitle').textContent = card.name;
    $('#groupDialogSummary').textContent = `该判定组包含 ${weightOf(card).toLocaleString('zh-CN')} 张记录；六项判定完全相同，选择其中任意一张均算正确。`;
    $('#groupDialogList').innerHTML = card.names.map((name) => `<div class="group-card-entry"><span>${escapeHtml(name)}</span><button type="button" data-copy-group-name="${escapeAttr(name)}">复制</button></div>`).join('');
    $('#groupDialog').showModal();
  }

  function matchMask(target, guess) {
    let mask = 0;
    if ((target.b & 128) ? Boolean(target.b & guess.b & 127) : target.b === guess.b) mask |= 1;
    if (target.a === guess.a) mask |= 2;
    if (target.r === guess.r) mask |= 4;
    if (target.nm & guess.nm) mask |= 8;
    if (target.atk === guess.atk) mask |= 16;
    if (target.def === guess.def) mask |= 32;
    return mask;
  }

  function strictMatchMask(target, guess) {
    return matchMask(target, guess);
  }

  function isExactAnswer(target, guess) {
    return matchMask(target, guess) === 63 && target.b === guess.b;
  }

  function migrateChallengeSemantics() {
    if (challengeSemanticsMigrated) return;
    const migrateLog = (log) => {
      if (log.type !== 'challenge' || log.strictMask != null) return;
      log.strictMask = log.mask;
      if ((log.mask & 1) && log.borderReveal != null && CARDS[log.guess] && CARDS[log.guess].b !== Number(log.borderReveal)) log.strictMask &= ~1;
    };
    (state.activityHistory || []).forEach(migrateLog);
    let matchedMask = 0;
    let migratedPuzzleScore = 0;
    let solved = false;
    for (const log of state.logs || []) {
      migrateLog(log);
      if (log.type !== 'challenge') continue;
      const before = matchedMask;
      matchedMask |= log.strictMask;
      solved = log.strictMask === 63;
      log.delta = thresholdGain(before, matchedMask, state.config, state.puzzle) + (solved ? solveReward(state.config, state.puzzle) : 0);
      migratedPuzzleScore += log.delta;
    }
    const scoreDifference = migratedPuzzleScore - Number(state.puzzleScore || 0);
    state.matchedMask = matchedMask;
    state.puzzleScore = migratedPuzzleScore;
    state.totalScore = Math.max(0, Number(state.totalScore || 0) + scoreDifference);
    if (isPremiumPuzzle()) state.premiumScore = Math.max(0, Number(state.premiumScore || 0) + scoreDifference);
    else state.progressScore = Math.max(0, Number(state.progressScore || 0) + scoreDifference);
    state.solved = solved;
    challengeSemanticsMigrated = true;
  }

  function candidateIndices(testState = state) {
    const result = [];
    outer: for (let index = 0; index < CARDS.length; index += 1) {
      const card = CARDS[index];
      if (weightOf(card, testState.pool) <= 0) continue;
      for (const [key, entry] of Object.entries(testState.known || {})) {
        if (fieldValue(card, key) !== Number(entry.value)) continue outer;
      }
      for (const log of testState.logs || []) {
        if (log.type !== 'challenge') continue;
        const guess = CARDS[log.guess];
        if (!guess || matchMask(card, guess) !== log.mask) continue outer;
        if ((log.mask & 1) && log.borderReveal != null && card.b !== Number(log.borderReveal)) continue outer;
        if ((log.mask & 8) && log.numberReveal != null && card.n !== Number(log.numberReveal)) continue outer;
      }
      result.push(index);
    }
    return result;
  }

  function candidateMass(indices = candidateCache) {
    return indices.reduce((sum, index) => sum + weightOf(CARDS[index]), 0);
  }

  function poolTotals(pool = state.pool) {
    return {
      cards: CARDS.reduce((sum, card) => sum + weightOf(card, pool), 0),
      groups: CARDS.reduce((sum, card) => sum + (weightOf(card, pool) > 0 ? 1 : 0), 0),
    };
  }

  function thresholdGain(beforeMask, afterMask, config = state.config, puzzle = state.puzzle) {
    const before = popcount(beforeMask);
    const after = popcount(afterMask);
    if (!isPremiumPuzzle(puzzle, config)) return Math.max(0, after - before) * config.regularMatchPoints;
    return config.milestones.reduce((points, item) => points + (before < item.matches && after >= item.matches ? item.points : 0), 0);
  }

  function sourceLabel(source) {
    return ({ initial: '初始揭示', hint: '提示揭示', challenge: '挑战相符' })[source] || source;
  }

  function render() {
    migrateChallengeSemantics();
    candidateCache = candidateIndices();
    const config = state.config;
    $('#puzzleNumber').value = state.puzzle;
    $('#puzzleNumber').max = config.puzzles;
    $('#puzzleTotal').textContent = `/ ${config.puzzles}`;
    $('#hintStock').value = state.hints;
    $('#challengeStock').value = state.challenges;
    $('#premiumScore').textContent = state.premiumScore;
    $('#progressScore').textContent = state.progressScore;
    $('#puzzleScore').textContent = state.puzzleScore;
    $('#poolMode').value = state.pool;
    const dataDate = DATA.generatedAt ? new Date(DATA.generatedAt).toLocaleDateString('zh-CN') : '未知日期';
    $('#poolCaveat').textContent = state.pool === 'md'
      ? `数据版本 ${dataDate}：按 Master Duel 格式名单筛选，但“卡片解码者”活动可能另行排除少量卡片。若某个候选确定未出现在活动中，请忽略该候选；由此造成的概率误差通常很小。`
      : `完整官方怪兽仅用于候选归零时排查漏卡，不代表这些卡都已收录于 Master Duel 或本次活动。数据版本 ${dataDate}。`;
    const totals = poolTotals();
    $('#candidateCount').textContent = `${candidateMass().toLocaleString('zh-CN')} / ${totals.cards.toLocaleString('zh-CN')}`;
    $('#candidateMass').textContent = `${candidateCache.length.toLocaleString('zh-CN')} / ${totals.groups.toLocaleString('zh-CN')} 个判定组`;
    const poolSource = DATA.source?.masterDuelPool ? `；筛选源：${DATA.source.masterDuelPool}` : '';
    $('#dataStats').textContent = `本地卡库：大师决斗怪兽 ${DATA.stats.masterDuelMonsterRecords.toLocaleString('zh-CN')} 张，${DATA.stats.masterDuelGroups.toLocaleString('zh-CN')} 个判定组；完整官方怪兽 ${DATA.stats.allMonsterRecords.toLocaleString('zh-CN')} 张${poolSource}。`;
    $('#rewardHelp').textContent = isPremiumPuzzle() ? `揭示只缩小候选集，不计入${config.milestones.map((item) => item.matches).join('／')}项高价值奖励。` : `本题每新增1个累计相符项记 ${config.regularMatchPoints} 点后段进度；揭示不计入。`;
    document.documentElement.dataset.theme = state.theme || 'dark';
    $('#themeSelect').value = state.theme || 'dark';
    state.imageQuality = ['high', 'zh'].includes(state.imageQuality) ? state.imageQuality : 'high';
    $('#imageQualitySelect').value = state.imageQuality;
    $('#calculateBtn').disabled = state.solved || state.challenges <= 0 || candidateCache.length === 0;
    $('#undoBtn').disabled = undoStack.length === 0;
    $('#solvedBanner').hidden = !state.solved;
    $('#nextPuzzleBtn').textContent = state.puzzle >= config.puzzles ? '完成活动' : '进入下一题';
    $('#solvedRewardText').textContent = isPremiumPuzzle() ? `六项全部相符，本题获得 ${state.puzzleScore} 高价值收益` : `六项全部相符，本题累计 ${state.puzzleScore} 后段匹配收益`;
    renderTestMode();
    renderFields();
    renderRewards();
    renderRevealControls();
    renderCandidates();
    renderHistory();
    renderModeGuide();
    clearRecommendation();
    saveState();
  }

  function renderFields() {
    const displayOrder = ['border', 'attribute', 'number', 'race', 'attack', 'defense'];
    $('#fieldGrid').innerHTML = displayOrder.map((key) => FIELDS.find((field) => field.key === key)).map((field) => {
      const known = state.known[field.key];
      const matched = Boolean(state.matchedMask & field.bit);
      return `<article class="field-card${known ? ' is-known' : ''}${matched ? ' is-matched' : ''}" data-field="${field.key}">
        ${fieldGlyphHtml(field, known)}
        <div class="field-content"><span>${field.label}</span><strong>${known ? escapeHtml(formatValue(field.key, known.value)) : '未知'}</strong><small>${known ? sourceLabel(known.source) : '等待线索'}</small></div>
        <div class="field-state ${matched ? 'is-match' : known ? 'is-revealed' : ''}">${matched ? '✓ 相符' : known ? '已知' : '—'}</div>
      </article>`;
    }).join('');
  }

  function fieldGlyphHtml(field, known) {
    const svgOpen = '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">';
    if (field.key === 'border') {
      const colors = { 1: '#d6bd73', 2: '#9a5d36', 4: '#765099', 8: '#e8edf2', 16: '#222833', 32: '#315f9d', 64: '#5571ad', 128: '#48a58e' };
      const selected = Object.entries(colors).filter(([bit]) => Number(known?.value || 0) & Number(bit)).map(([, color]) => color);
      const fill = selected.length > 1 ? `linear-gradient(135deg,${selected.join(',')})` : selected[0] || '#506071';
      return `<div class="field-glyph frame-glyph" style="--frame-fill:${fill}"><span></span><i></i></div>`;
    }
    if (field.key === 'attribute') {
      const label = known ? (DATA.labels.attribute[known.value] || '?') : '属';
      return `<div class="field-glyph attribute-glyph"><span>${escapeHtml(label)}</span></div>`;
    }
    if (field.key === 'race') return `<div class="field-glyph">${svgOpen}<path d="M14 31c1-7 5-11 10-11s9 4 10 11M18 18c0-5 2-8 6-8s6 3 6 8c0 4-2 7-6 7s-6-3-6-7Z"/><path d="M12 36h24"/></svg></div>`;
    if (field.key === 'number') {
      const border = Number(state.known.border?.value || 0);
      if (border & 32) return `<div class="field-glyph">${svgOpen}<path d="m24 8 15 9v17l-15 8-15-8V17Z"/><path d="m24 14 9 6-9 16-9-16Z"/></svg></div>`;
      if (border & 16) return `<div class="field-glyph">${svgOpen}<path d="M24 8 40 24 24 40 8 24Z"/><circle cx="24" cy="24" r="8"/></svg></div>`;
      return `<div class="field-glyph">${svgOpen}<path d="m24 7 5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1Z"/></svg></div>`;
    }
    if (field.key === 'attack') return `<div class="field-glyph attack-glyph">${svgOpen}<path d="m11 37 7-7m3-3L36 12l1-5-5 1-15 15m4 4-5 5m-3 8-5-5 6-3 2 2Z"/><path d="m27 27 10 10m-4-1 4-4"/></svg></div>`;
    return `<div class="field-glyph defense-glyph">${svgOpen}<path d="M24 7 38 12v10c0 9-5 15-14 20-9-5-14-11-14-20V12Z"/><path d="M24 13v22M16 20h16"/></svg></div>`;
  }

  function renderRewards() {
    const matched = popcount(state.matchedMask);
    const premium = isPremiumPuzzle();
    $('#matchedSummary').textContent = `挑战累计相符 ${matched} / 6 · ${premium ? '高价值题' : '后段进度题'}${state.solved ? ' · 本题已通过' : ''}`;
    const nodes = premium
      ? [...state.config.milestones.map((item) => ({ threshold: item.matches, points: item.points, final: false, solveOnly: false })), { threshold: 6, points: state.config.solvePoints, final: true, solveOnly: true }]
      : Array.from({ length: 6 }, (_, index) => ({ threshold: index + 1, points: state.config.regularMatchPoints, final: index === 5, solveOnly: false }));
    const progress = state.solved ? 100 : Math.min(94, matched / 6 * 100);
    $('#rewardTrack').style.gridTemplateColumns = `repeat(${Math.max(1, nodes.length)}, 1fr)`;
    $('#rewardTrack').innerHTML = `<div class="track-line"><span id="rewardProgress" style="width:${progress}%"></span></div>` + nodes.map((item) => `<div class="reward-node${item.final ? ' final' : ''}" data-threshold="${item.threshold}" data-solve-only="${item.solveOnly}"><b>${item.solveOnly ? '全中' : item.threshold}</b><span>+${item.points}</span></div>`).join('');
    $$('.reward-node').forEach((node) => {
      const threshold = Number(node.dataset.threshold);
      const earned = node.dataset.solveOnly === 'true' ? state.solved : matched >= threshold;
      node.classList.toggle('is-earned', earned);
    });
  }

  function renderTestMode() {
    const active = Boolean(testSession);
    $('#testBanner').hidden = !active;
    $('#testModeBtn').textContent = active ? '正在测试' : '测试模式';
    $('#testModeBtn').disabled = active;
    $('#gameModeBtn').textContent = active && testSession.mode === 'game' ? '正在游戏' : '小游戏模式';
    $('#gameModeBtn').disabled = active;
    if (!active) {
      $('#recordChallengeBtn').textContent = '使用这张卡挑战';
      $('#recordChallengeBtn').disabled = selectedGuess == null || state.solved;
      return;
    }
    const target = CARDS[testSession.targetIndex];
    const visible = testSession.mode === 'test' || testSession.revealed || state.solved;
    $('#sessionModeLabel').textContent = testSession.mode === 'test' ? '测试模式 · 目标卡公开' : visible ? '小游戏模式 · 答案已揭晓' : '小游戏模式 · 目标卡隐藏';
    $('#testTargetName').textContent = visible ? target.name : '？？？';
    $('#testTargetStats').textContent = visible ? cardStats(target) : `根据反馈筛选候选并猜中目标；当前剩余 ${candidateMass().toLocaleString('zh-CN')} 张。`;
    if (visible) setCardImage($('#testTargetImage'), target, true, 'card-back.png');
    else {
      const image = $('#testTargetImage');
      image.hidden = false;
      image.src = 'card-back.png';
      image.alt = '未知目标卡';
      image.dataset.zoomable = 'false';
    }
    $('#revealTargetBtn').hidden = testSession.mode !== 'game' || visible;
    $('#recordChallengeBtn').textContent = testSession.mode === 'game' ? '提交当前挑战' : '自动判定当前挑战';
    $('#recordChallengeBtn').disabled = selectedGuess == null || state.solved;
    $('#autoJudgeBtn').textContent = testSession.mode === 'game' ? '提交当前挑战' : '自动判定当前挑战';
    $('#autoJudgeBtn').disabled = selectedGuess == null || state.solved;
  }

  function renderRevealControls() {
    const unknownFields = FIELDS.filter((field) => !state.known[field.key]);
    const fieldSelect = $('#revealField');
    const previous = fieldSelect.value;
    fieldSelect.innerHTML = unknownFields.map((field) => `<option value="${field.key}">${field.label}</option>`).join('');
    if (unknownFields.some((field) => field.key === previous)) fieldSelect.value = previous;
    $('#addRevealBtn').disabled = unknownFields.length === 0 || state.solved;
    $('#randomHintBtn').disabled = unknownFields.length === 0 || state.solved || state.hints <= 0;
    const source = $('#revealSource');
    [...source.options].forEach((option) => {
      option.disabled = option.value === 'initial' ? state.initialUsed : state.hints <= 0;
    });
    if (source.selectedOptions[0]?.disabled) source.value = state.initialUsed ? 'hint' : 'initial';
    populateRevealValues();
  }

  function populateRevealValues() {
    const key = $('#revealField').value;
    if (!key) { $('#revealValue').innerHTML = ''; return; }
    const values = new Map();
    const source = candidateCache.length ? candidateCache : CARDS.map((_, index) => index);
    for (const index of source) {
      const value = fieldValue(CARDS[index], key);
      values.set(value, (values.get(value) || 0) + weightOf(CARDS[index]));
    }
    const sorted = [...values.entries()].sort((left, right) => {
      if (key === 'attack' || key === 'defense' || key === 'number') return Number(left[0]) - Number(right[0]);
      return formatValue(key, left[0]).localeCompare(formatValue(key, right[0]), 'zh-CN');
    });
    $('#revealValue').innerHTML = sorted.map(([value, count]) => `<option value="${value}">${escapeHtml(formatValue(key, value))} · ${count.toLocaleString('zh-CN')}张</option>`).join('');
  }

  function renderCandidates() {
    const container = $('#candidateTable');
    const poolIndices = CARDS.map((_, index) => index).filter((index) => weightOf(CARDS[index]) > 0);
    const knownOnly = $('#candidateKnownOnly').checked;
    const source = knownOnly ? candidateCache : poolIndices;
    const total = candidateMass(source);
    refreshDatabaseFilterValues(poolIndices);
    const query = normalizeSearch($('#candidateSearch').value || '');
    const sort = $('#candidateSort').value;
    const selected = (id) => new Set([...$(id).querySelectorAll('input[type="checkbox"]:checked')].map((input) => Number(input.value)));
    const border = selected('#dbBorder'), attribute = selected('#dbAttribute'), race = selected('#dbRace');
    const numbers = selected('#dbNumber'), attacks = selected('#dbAttack'), defenses = selected('#dbDefense');
    const filtered = source.filter((index) => {
      const card = CARDS[index];
      if (query && !card.names.some((name) => normalizeSearch(name).includes(query))) return false;
      if (border.size && !border.has(card.b)) return false;
      if (attribute.size && !attribute.has(card.a)) return false;
      if (race.size && !race.has(card.r)) return false;
      if (numbers.size && !numbers.has(card.n)) return false;
      if (attacks.size && !attacks.has(card.atk)) return false;
      if (defenses.size && !defenses.has(card.def)) return false;
      return true;
    });
    const comparators = {
      probability: (left, right) => weightOf(CARDS[right]) - weightOf(CARDS[left]) || CARDS[left].name.localeCompare(CARDS[right].name, 'zh-CN'),
      name: (left, right) => CARDS[left].name.localeCompare(CARDS[right].name, 'zh-CN'),
      numberAsc: (left, right) => CARDS[left].n - CARDS[right].n || CARDS[left].name.localeCompare(CARDS[right].name, 'zh-CN'),
      numberDesc: (left, right) => CARDS[right].n - CARDS[left].n || CARDS[left].name.localeCompare(CARDS[right].name, 'zh-CN'),
      attackAsc: (left, right) => CARDS[left].atk - CARDS[right].atk || CARDS[left].name.localeCompare(CARDS[right].name, 'zh-CN'),
      attackDesc: (left, right) => CARDS[right].atk - CARDS[left].atk || CARDS[left].name.localeCompare(CARDS[right].name, 'zh-CN'),
      defenseAsc: (left, right) => CARDS[left].def - CARDS[right].def || CARDS[left].name.localeCompare(CARDS[right].name, 'zh-CN'),
      defenseDesc: (left, right) => CARDS[right].def - CARDS[left].def || CARDS[left].name.localeCompare(CARDS[right].name, 'zh-CN'),
    };
    const top = [...filtered].sort(comparators[sort] || comparators.probability).slice(0, 240);
    const totals = poolTotals();
    const filteredCards = candidateMass(filtered);
    $('#candidateMass').textContent = `显示 ${filteredCards.toLocaleString('zh-CN')} / ${totals.cards.toLocaleString('zh-CN')} 张 · ${filtered.length.toLocaleString('zh-CN')} / ${totals.groups.toLocaleString('zh-CN')} 组${top.length < filtered.length ? ` · 首 ${top.length} 组` : ''}`;
    if (!top.length) { container.innerHTML = `<div class="empty-inline">没有符合当前搜索或筛选条件的卡片。</div>`; return; }
    const grid = container.dataset.view === 'grid';
    container.classList.toggle('candidate-grid', grid);
    container.innerHTML = (grid ? '' : `<div class="candidate-row header"><span>卡图</span><span>代表卡</span><span>边框</span><span>属性</span><span>种族</span><span>数值</span><span>攻／守</span><span>卡数／占当前范围</span></div>`) + top.map((index) => {
      const card = CARDS[index];
      const probability = total ? weightOf(card) / total : 0;
      if (grid) return `<article class="database-card"><img data-card-index="${index}" alt="${escapeAttr(card.name)}卡图"><strong title="${escapeAttr(card.names.join('、'))}">${escapeHtml(card.name)}</strong><small>${escapeHtml(formatBorder(card.b))} · ${escapeHtml(DATA.labels.attribute[card.a] || card.a)} · ${escapeHtml(DATA.labels.race[card.r] || card.r)}</small><span>${card.n} · ${formatStat(card.atk)}／${formatStat(card.def)} · ${weightOf(card)}张</span></article>`;
      return `<div class="candidate-row"><img class="candidate-thumb" data-card-index="${index}" alt="${escapeAttr(card.name)}卡图"><strong title="${escapeAttr(card.names.join('、'))}">${escapeHtml(card.name)}</strong><span>${escapeHtml(formatBorder(card.b))}</span><span>${escapeHtml(DATA.labels.attribute[card.a] || card.a)}</span><span>${escapeHtml(DATA.labels.race[card.r] || card.r)}</span><span>${card.n}</span><span>${formatStat(card.atk)}／${formatStat(card.def)}</span><span class="prob">${weightOf(card).toLocaleString('zh-CN')}张 · ${formatPercent(probability)}</span></div>`;
    }).join('');
    hydrateCardImages(container);
  }

  function refreshDatabaseFilterValues(source) {
    for (const [id, field, label] of [['#dbBorder','border','边框'],['#dbAttribute','attribute','属性'],['#dbRace','race','种族'],['#dbNumber','number','等级／阶级／连接'],['#dbAttack','attack','攻击力'],['#dbDefense','defense','守备力']]) {
      const container = $(id);
      if (container.dataset.ready) continue;
      const values = [...new Set(source.map((index) => fieldValue(CARDS[index], field)))].sort((a,b)=>['number','attack','defense'].includes(field)?Number(a)-Number(b):formatValue(field,a).localeCompare(formatValue(field,b),'zh-CN'));
      container.innerHTML = `<details class="filter-picker"><summary><span>${label}</span><b data-filter-count>全部</b></summary><div class="filter-picker-body"><input type="search" placeholder="搜索${label}" aria-label="搜索${label}"><div class="filter-options">${values.map((value)=>`<label data-filter-label="${escapeAttr(normalizeSearch(formatValue(field,value)))}"><input type="checkbox" value="${value}"><span>${escapeHtml(formatValue(field,value))}</span></label>`).join('')}</div></div></details>`;
      container.dataset.ready='true';
    }
    updateFilterCounts();
  }

  function updateFilterCounts() {
    $$('.filter-picker').forEach((picker)=>{const count=picker.querySelectorAll('input[type="checkbox"]:checked').length;picker.querySelector('[data-filter-count]').textContent=count?`已选 ${count}`:'全部';});
  }

  function historyItemHtml(log, expanded = false) {
    const puzzle = log.puzzle || state.puzzle;
    if (log.type === 'reveal') {
      const field = FIELDS.find((item) => item.key === log.field) || FIELDS[0];
      return `<article class="history-item history-reveal"><div class="history-symbol" data-field="${field.key}">${field.icon}</div><div><header><strong>第${puzzle}题 · ${sourceLabel(log.source)}</strong><time>${log.time || ''}</time></header><p>${field.label}：<b>${escapeHtml(formatValue(log.field, log.value))}</b></p>${expanded ? `<small>揭示用于筛选候选，不累计挑战奖励${log.candidates != null ? ` · 当时约 ${Number(log.candidates).toLocaleString('zh-CN')} 张候选` : ''}</small>` : ''}</div></article>`;
    }
    const guess = CARDS[log.guess];
    const strictMask = log.strictMask == null ? log.mask : log.strictMask;
    const matchedFields = FIELDS.filter((field) => strictMask & field.bit);
    const partialBorder = Boolean((log.mask & 1) && !(strictMask & 1));
    const matched = matchedFields.map((field) => field.label).join('、') || '无相符项';
    return `<article class="history-item history-challenge">${guess ? `<img data-card-index="${log.guess}" alt="${escapeAttr(guess.name)}卡图">` : '<div class="history-symbol">?</div>'}<div><header><strong>第${puzzle}题 · ${escapeHtml(guess?.name || '未知卡')}</strong><time>${log.time || ''}</time></header><p>${matched}${partialBorder ? ' · 边框仅部分点亮' : ''}${log.delta ? ` · <b>+${log.delta}</b>` : ''}</p><div class="history-match-chips">${matchedFields.map((field) => `<span>${field.icon} ${escapeHtml(field.label)}</span>`).join('') || '<span>0项严格相符</span>'}</div>${expanded && log.candidates != null ? `<small>操作前约 ${Number(log.candidates).toLocaleString('zh-CN')} 张候选</small>` : ''}</div></article>`;
  }

  function hydrateCardImages(root) {
    root.querySelectorAll('img[data-card-index]').forEach((image) => {
      setCardImage(image, CARDS[Number(image.dataset.cardIndex)]);
    });
  }

  function renderHistory() {
    const container = $('#historyList');
    const history = Array.isArray(state.activityHistory) ? state.activityHistory : [];
    $('#historyCount').textContent = `${history.length} 条`;
    if (!history.length) {
      container.innerHTML = `<div class="empty-inline">当前活动还没有记录。</div>`;
      return;
    }
    container.innerHTML = [...history].reverse().slice(0, 8).map((log) => historyItemHtml(log)).join('');
    hydrateCardImages(container);
  }

  function openHistoryArchive() {
    const history = readSessionHistory();
    const challenges = history.filter((item) => item.type === 'challenge').length;
    const activities = new Set(history.map((item) => item.activityId)).size;
    $('#historySummary').innerHTML = `<div><span>本窗口活动</span><strong>${activities}</strong></div><div><span>挑战记录</span><strong>${challenges}</strong></div><div><span>全部操作</span><strong>${history.length}</strong></div>`;
    $('#historyTimeline').innerHTML = history.length ? [...history].reverse().map((log) => historyItemHtml(log, true)).join('') : '<div class="empty-inline">当前窗口还没有历史记录。</div>';
    hydrateCardImages($('#historyTimeline'));
    if (!$('#historyDialog').open) $('#historyDialog').showModal();
  }

  function exportActivity() {
    const payload = { format: 'card-decoder-activity', version: 1, exportedAt: new Date().toISOString(), state };
    const text = JSON.stringify(payload, null, 2);
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `卡片解码者-活动记录-${new Date().toISOString().slice(0,10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    navigator.clipboard?.writeText(text).catch(() => {});
    toast('活动记录已下载，并尝试复制到剪贴板。');
  }

  function parseImportedValue(field, raw) {
    const text = String(raw).trim();
    if (field === 'attack' || field === 'defense') {
      if (text === '无') return -3;
      if (text === '?') return -2;
    }
    if (['number','attack','defense'].includes(field) && Number.isFinite(Number(text))) return Number(text);
    if (field === 'border') {
      const value = [...new Set(CARDS.map((card)=>card.b))].find((item)=>formatBorder(item)===text);
      if (value != null) return value;
    }
    if (field === 'attribute' || field === 'race') {
      const entry = Object.entries(DATA.labels[field]).find(([,label])=>label===text);
      if (entry) return Number(entry[0]);
    }
    throw new Error(`无法识别“${text}”作为${FIELDS.find((item)=>item.key===field)?.label || field}。`);
  }

  function importActionLines(text) {
    const fieldAliases = new Map(FIELDS.flatMap((field)=>[[field.key,field],[field.label,field],[field.icon,field]]));
    const next = freshState(state.config); next.pool=state.pool; next.theme=state.theme; next.imageQuality=state.imageQuality;
    const lines=text.split(/\r?\n/).map((line)=>line.trim()).filter((line)=>line&&!line.startsWith('#'));
    if (!lines.length) throw new Error('没有可导入的行动。');
    for (let lineNumber=0;lineNumber<lines.length;lineNumber+=1) {
      const parts=lines[lineNumber].split('|').map((part)=>part.trim());
      const puzzle=clampInt(parts[0].replace(/^题/,''),1,next.config.puzzles,NaN),type=parts[1];
      if (!Number.isFinite(puzzle)||!type) throw new Error(`第 ${lineNumber+1} 行格式不正确。`);
      if (puzzle<next.puzzle||puzzle>next.puzzle+1) throw new Error(`第 ${lineNumber+1} 行题号不连续。`);
      if (puzzle>next.puzzle) { next.puzzle=puzzle;next.known={};next.matchedMask=0;next.logs=[];next.initialUsed=false;next.solved=false;next.puzzleScore=0; }
      if (type==='初始'||type==='提示') {
        const field=fieldAliases.get(parts[2]); if(!field)throw new Error(`第 ${lineNumber+1} 行字段无效。`);
        const source=type==='初始'?'initial':'hint',value=parseImportedValue(field.key,parts[3]);
        if(next.known[field.key])throw new Error(`第 ${lineNumber+1} 行重复揭示了${field.label}。`);
        if(source==='hint'){if(next.hints<=0)throw new Error(`第 ${lineNumber+1} 行提示库存不足。`);next.hints-=1;}else{if(next.initialUsed)throw new Error(`第 ${lineNumber+1} 行重复录入初始揭示。`);next.initialUsed=true;}
        next.known[field.key]={value,source};
        const log={type:'reveal',field:field.key,value,source,time:'导入',puzzle,activityId:next.activityId};next.logs.push(log);next.activityHistory.push(log);
      } else if(type==='挑战') {
        if(next.challenges<=0)throw new Error(`第 ${lineNumber+1} 行挑战库存不足。`);
        const name=normalizeSearch(parts[2]),guess=CARDS.findIndex((card)=>card.names.some((item)=>normalizeSearch(item)===name));
        if(guess<0)throw new Error(`第 ${lineNumber+1} 行找不到挑战卡“${parts[2]}”。`);
        let mask=0;for(const token of (parts[3]||'').split(/[,，/／]+/).map((item)=>item.trim()).filter(Boolean)){const field=fieldAliases.get(token);if(!field)throw new Error(`第 ${lineNumber+1} 行无法识别点亮字段“${token}”。`);mask|=field.bit;}
        const borderReveal=mask&1?parseImportedValue('border',parts[4]):null,numberReveal=mask&8?parseImportedValue('number',parts[5]):null;
        const strictMask=mask&1&&CARDS[guess].b!==borderReveal?mask&~1:mask,before=next.matchedMask,after=before|strictMask,solved=strictMask===63;
        let delta=thresholdGain(before,after,next.config,puzzle);if(solved)delta+=solveReward(next.config,puzzle);
        next.matchedMask=after;next.challenges-=1;next.puzzleScore+=delta;next.totalScore+=delta;if(isPremiumPuzzle(puzzle,next.config))next.premiumScore+=delta;else next.progressScore+=delta;next.solved=solved;
        for(const field of FIELDS)if(mask&field.bit)next.known[field.key]={value:field.key==='border'?borderReveal:field.key==='number'?numberReveal:fieldValue(CARDS[guess],field.key),source:'challenge'};
        const log={type:'challenge',guess,mask,strictMask,borderReveal,numberReveal,delta,time:'导入',puzzle,activityId:next.activityId};next.logs.push(log);next.activityHistory.push(log);
      } else throw new Error(`第 ${lineNumber+1} 行行动只能是“初始”“提示”或“挑战”。`);
      if(!candidateIndices(next).length&&!next.solved)throw new Error(`第 ${lineNumber+1} 行与当前卡库冲突，候选归零。`);
    }
    return next;
  }

  function importActivity() {
    try {
      const raw=$('#activityImportText').value.trim();
      let next;
      if(raw.startsWith('{')){
        const payload = JSON.parse(raw);
        if (payload?.format !== 'card-decoder-activity' || payload.version !== 1 || !payload.state) throw new Error('不是有效的卡片解码者活动记录。');
        const incoming = payload.state;
        if (!Array.isArray(incoming.logs) || !incoming.known || !incoming.config) throw new Error('记录缺少必要的活动状态。');
        next = { ...freshState(incoming.config), ...incoming, config: normalizeConfig(incoming.config) };
      }else next=importActionLines(raw);
      next.puzzle = clampInt(next.puzzle, 1, next.config.puzzles, 1);
      next.hints = clampInt(next.hints, 0, 999, 0);
      next.challenges = clampInt(next.challenges, 0, 999, 0);
      next.matchedMask = clampInt(next.matchedMask, 0, 63, 0);
      for (const log of next.logs) if (log.type === 'challenge' && (!Number.isInteger(log.guess) || !CARDS[log.guess])) throw new Error('记录引用了当前数据库中不存在的卡片。');
      if (!candidateIndices(next).length && !next.solved) throw new Error('记录与当前卡库冲突，导入后候选会归零。');
      pushUndo();
      state = next;
      challengeSemanticsMigrated = false;
      testSession = null;
      $('#importDialog').close();
      $('#historyDialog').close();
      render();
      toast('活动记录已导入，可以从当前进度继续。');
    } catch (error) { toast(`导入失败：${error.message}`); }
  }

  function populateManualValue() {
    const field=$('#manualField').value;
    const values=[...new Set(CARDS.filter((card)=>weightOf(card)>0).map((card)=>fieldValue(card,field)))].sort((a,b)=>['number','attack','defense'].includes(field)?a-b:formatValue(field,a).localeCompare(formatValue(field,b),'zh-CN'));
    $('#manualValue').innerHTML=values.map((value)=>`<option value="${value}">${escapeHtml(formatValue(field,value))}</option>`).join('');
  }

  function renderManualImport() {
    const challenge=$('#manualAction').value==='挑战';
    $('#manualRevealFields').hidden=challenge;$('#manualChallengeFields').hidden=!challenge;
    $('#manualMatchFields').innerHTML=FIELDS.map((field)=>`<label><input type="checkbox" value="${field.key}"><span>${field.label}</span></label>`).join('');
    $('#manualRecordCount').textContent=`${manualImportLines.length} 条`;
    $('#manualRecordList').innerHTML=manualImportLines.length?manualImportLines.map((line,index)=>`<div class="manual-record-row"><span>${escapeHtml(line)}</span><button type="button" data-remove-manual="${index}" aria-label="删除">×</button></div>`).join(''):'<div class="empty-inline">尚未添加行动。</div>';
  }

  function resolveManualCard() {
    const name=normalizeSearch($('#manualCardName').value);
    const index=CARDS.findIndex((card)=>card.names.some((item)=>normalizeSearch(item)===name));
    return index;
  }

  function updateManualChallengeSpecials() {
    const selected=new Set([...$('#manualMatchFields').querySelectorAll('input:checked')].map((input)=>input.value));
    const index=resolveManualCard();
    $('#manualPendulumExactWrap').hidden=!selected.has('border')||index<0||!(CARDS[index].b&128);
    $('#manualNumberWrap').hidden=!selected.has('number');
  }

  function addManualRecord() {
    const puzzle=clampInt($('#manualPuzzle').value,1,state.config.puzzles,1),action=$('#manualAction').value;
    if(action!=='挑战'){
      const field=$('#manualField').value,value=formatValue(field,Number($('#manualValue').value));
      manualImportLines.push(`${puzzle}|${action}|${FIELDS.find((item)=>item.key===field).label}|${value}`);
    }else{
      const index=resolveManualCard();if(index<0){toast('请填写数据库中完整的挑战卡名。');return;}
      const card=CARDS[index],selected=[...$('#manualMatchFields').querySelectorAll('input:checked')].map((input)=>input.value),labels=selected.map((key)=>FIELDS.find((field)=>field.key===key).label);
      const border=selected.includes('border')?($('#manualPendulumExact').checked?formatBorder(card.b):formatBorder(card.b^128)):'-';
      const number=selected.includes('number')?String(clampInt($('#manualNumberValue').value,0,13,card.n)):'-';
      manualImportLines.push(`${puzzle}|挑战|${card.name}|${labels.join(',')}|${border}|${number}`);
    }
    renderManualImport();
  }

  function applyManualRecords() {
    if(!manualImportLines.length){toast('请至少添加一条行动记录。');return;}
    $('#activityImportText').value=manualImportLines.join('\n');
    importActivity();
    $('#manualImportDialog').close();$('#activityDataDialog').close();
  }

  function openImageViewer(source) {
    if (!source || source.hidden || source.dataset.zoomable !== 'true') return;
    const dialog = $('#imageViewerDialog');
    $('#imageViewerImage').src = source.currentSrc || source.src;
    $('#imageViewerImage').alt = source.alt || '卡图';
    $('#imageViewerCaption').textContent = (source.alt || '卡图').replace(/\s*卡图$/, '');
    if (!dialog.open) dialog.showModal();
  }

  function refreshImageQuality() {
    if (selectedGuess != null) setCardImage($('#selectedCardImage'), CARDS[selectedGuess]);
    renderTestMode();
    if (lastRecommendations[0] && !lastAdvice?.recommendHint) setCardImage($('#recommendImage'), CARDS[lastRecommendations[0].index]);
    renderHistory();
    if ($('#historyDialog').open) openHistoryArchive();
    startWallpaperCycle();
  }

  function clearRecommendation() {
    lastRecommendations = [];
    lastQuickMetrics = [];
    lastAdvice = null;
    $('#recommendationCard').classList.add('empty-state');
    $('#recommendTitle').textContent = state.known && Object.keys(state.known).length ? '等待计算' : '录入初始揭示';
    $('#recommendTitle').disabled = true;
    $('#recommendTitle').dataset.cardIndex = '';
    $('#copyRecommendCard').hidden = true;
    $('#copyRecommendCard').dataset.cardIndex = '';
    $('#recommendImage').hidden = true;
    $('#recommendReason').textContent = state.known && Object.keys(state.known).length ? '点击下方按钮，比较当前卡池中的合法挑战。' : '加入本题已经显示的字段，求解器会筛选候选并计算推荐挑战。';
    $('#recommendCardStats').hidden = true;
    $('#metricPoints').textContent = '—';
    $('#metricSolve').textContent = '—';
    $('#metricInfo').textContent = '—';
    $('#alternatives').innerHTML = '';
  }

  function addReveal() {
    const field = $('#revealField').value;
    const value = Number($('#revealValue').value);
    const source = $('#revealSource').value;
    try {
      applyReveal(field, value, source);
    } catch (error) {
      toast(error.message);
    }
  }

  function randomHint() {
    const unknown = FIELDS.filter((field) => !state.known[field.key]);
    if (!unknown.length) { toast('六个字段都已经揭示。'); return; }
    if (state.hints <= 0) { toast('提示库存不足。'); return; }
    const field = unknown[Math.floor(Math.random() * unknown.length)];
    $('#revealField').value = field.key;
    populateRevealValues();
    $('#revealSource').value = 'hint';
    if (!testSession) { toast(`已随机选中“${field.label}”，请录入游戏实际显示的值。`); return; }
    const target = CARDS[testSession.targetIndex];
    applyReveal(field.key, fieldValue(target, field.key), 'hint');
    toast(`提示随机揭示：${field.label}。`);
  }

  function applyReveal(field, value, source) {
    if (!FIELDS.some((item) => item.key === field) || Number.isNaN(Number(value))) throw new Error('字段或揭示值无效。');
    if (state.known[field]) throw new Error('这个字段已经揭示。');
    if (source !== 'initial' && source !== 'hint') throw new Error('揭示来源无效。');
    if (source === 'initial' && state.initialUsed) throw new Error('本题的初始揭示已经录入。');
    if (source === 'hint' && state.hints <= 0) throw new Error('提示库存不足。');
    const trial = clone(state);
    trial.known[field] = { value: Number(value), source };
    if (!candidateIndices(trial).length) throw new Error('这条揭示会使候选归零，请检查数值或切换卡池。');
    pushUndo();
    state.known[field] = { value: Number(value), source };
    if (source === 'initial') state.initialUsed = true;
    if (source === 'hint') state.hints -= 1;
    const log = { type: 'reveal', field, value: Number(value), source, time: timeLabel() };
    state.logs.push(log);
    appendHistory(log);
    render();
    return solverSummary();
  }

  function normalizeSearch(value) {
    return value.toLocaleLowerCase().replace(/[\s·・\-—_\/／「」『』]/g, '');
  }

  function searchCards(query) {
    const normalized = normalizeSearch(query);
    if (!normalized) return [];
    const results = [];
    for (let index = 0; index < CARDS.length; index += 1) {
      const card = CARDS[index];
      if (weightOf(card) <= 0) continue;
      let best = 99;
      for (const name of card.names) {
        const candidate = normalizeSearch(name);
        const position = candidate.indexOf(normalized);
        if (position >= 0) best = Math.min(best, position === 0 ? 0 : 1);
      }
      if (best < 99) results.push({ index, best });
    }
    return results.sort((left, right) => left.best - right.best || CARDS[left.index].name.length - CARDS[right.index].name.length).slice(0, 24).map((item) => item.index);
  }

  function showSearchResults() {
    const query = $('#cardSearch').value.trim();
    const container = $('#searchResults');
    const results = searchCards(query);
    if (!query) { container.hidden = true; return; }
    container.hidden = false;
    container.innerHTML = results.length ? results.map((index) => `<button class="search-result" type="button" data-card-index="${index}"><span><strong>${escapeHtml(CARDS[index].name)}</strong><small>${escapeHtml(cardStats(CARDS[index]))}</small></span><small>${weightOf(CARDS[index])}张同组</small></button>`).join('') : `<div class="empty-inline">没有找到卡名</div>`;
  }

  function selectGuess(index) {
    selectedGuess = Number(index);
    feedbackMask = 0;
    const card = CARDS[selectedGuess];
    $('#cardSearch').value = card.name;
    $('#searchResults').hidden = true;
    $('#selectedCard').hidden = false;
    $('#selectedCardName').textContent = card.name;
    $('#copySelectedCard').dataset.cardIndex = String(selectedGuess);
    $('#selectedCardFacts').innerHTML = FIELDS.map((field) => `<div><span>${escapeHtml(field.label)}</span><strong>${escapeHtml(formatValue(field.key, fieldValue(card, field.key)))}</strong></div>`).join('');
    $('#challengeEvaluation').hidden = true;
    $('#challengeEvaluation').innerHTML = '';
    setCardImage($('#selectedCardImage'), card);
    renderTestMode();
  }

  function clearGuess() {
    selectedGuess = null;
    feedbackMask = 0;
    borderRevealValue = null;
    $('#cardSearch').value = '';
    $('#selectedCard').hidden = true;
    $('#selectedCardImage').hidden = true;
    $('#challengeEvaluation').hidden = true;
    $('#challengeEvaluation').innerHTML = '';
    $('#feedbackGrid').innerHTML = '';
    $('#specialReveals').hidden = true;
    renderTestMode();
  }

  function renderFeedback() {
    if (selectedGuess == null) return;
    const guess = CARDS[selectedGuess];
    $('#feedbackGrid').innerHTML = FIELDS.map((field) => `<button class="feedback-toggle${feedbackMask & field.bit ? ' is-on' : ''}" type="button" data-feedback-bit="${field.bit}"><span>${field.label}</span><small>${escapeHtml(formatValue(field.key, fieldValue(guess, field.key)))}</small></button>`).join('');
    const borderOn = Boolean(feedbackMask & 1);
    const numberOn = Boolean(feedbackMask & 8);
    $('#feedbackConflict').hidden = true;
    $('#specialReveals').hidden = !(borderOn || numberOn);
    $('#borderRevealWrap').hidden = !borderOn;
    $('#numberRevealWrap').hidden = !numberOn;
    if (borderOn) { populateBorderRevealChoices(); $('#feedbackNote').textContent = '请选择游戏画面实际揭示的完整目标边框。'; }
    else $('#feedbackNote').textContent = '勾选游戏中亮起的项目；测试和小游戏模式会自动生成判定。';
    if (numberOn) populateSpecialReveal('number');
  }

  function evaluateChallengeAction(guessIndex, candidates = candidateCache) {
    const guess = CARDS[Number(guessIndex)];
    const total = candidateMass(candidates);
    if (!guess || total <= 0) return null;
    const oldMask = state.matchedMask;
    const oldCount = popcount(oldMask);
    let immediateSum = 0;
    let solveMass = 0;
    let newMatchesSum = 0;
    const outcomes = new Map();
    for (const targetIndex of candidates) {
      const target = CARDS[targetIndex];
      const weight = weightOf(target);
      const mask = matchMask(target, guess);
      const strictMask = strictMatchMask(target, guess);
      const newMask = oldMask | strictMask;
      let gain = thresholdGain(oldMask, newMask);
      if (isExactAnswer(target, guess)) { gain += solveReward(); solveMass += weight; }
      immediateSum += gain * weight;
      newMatchesSum += (popcount(newMask) - oldCount) * weight;
      const borderPart = mask & 1 ? target.b : 0;
      const numberPart = mask & 8 ? target.n + 1 : 0;
      const key = mask | (borderPart << 6) | (numberPart << 14);
      outcomes.set(key, (outcomes.get(key) || 0) + weight);
    }
    let info = 0;
    let expectedRemaining = 0;
    for (const mass of outcomes.values()) {
      const probability = mass / total;
      info -= probability * Math.log2(probability);
      expectedRemaining += probability * mass;
    }
    return {
      index: Number(guessIndex),
      points: immediateSum / total,
      solve: solveMass / total,
      newMatches: newMatchesSum / total,
      info,
      remaining: expectedRemaining,
      outcomes: outcomes.size,
      total,
    };
  }

  async function calculateSelectedChallenge() {
    if (selectedGuess == null) { toast('请先选择一张挑战卡。'); return; }
    if (!candidateCache.length) { toast('当前没有可分析的候选卡。'); return; }
    const button = $('#evaluateChallengeBtn');
    button.disabled = true;
    button.textContent = '计算中…';
    await nextFrame();
    const result = evaluateChallengeAction(selectedGuess);
    button.disabled = false;
    button.textContent = '重新计算收益';
    if (!result) return;
    const element = $('#challengeEvaluation');
    element.hidden = false;
    element.innerHTML = `<div><span>期望即时得分</span><strong>${result.points.toFixed(2)}</strong></div><div><span>直接通关概率</span><strong>${formatPercent(result.solve)}</strong></div><div><span>信息增益</span><strong>${result.info.toFixed(2)} bit</strong></div><div><span>期望新增相符项</span><strong>${result.newMatches.toFixed(2)}</strong></div><div><span>反馈后平均剩余</span><strong>${result.remaining.toFixed(result.remaining < 10 ? 2 : 1)} 张</strong></div><div><span>可能反馈分支</span><strong>${result.outcomes}</strong></div>`;
  }

  function addComparisonCard(index, { quiet = false } = {}) {
    const value = Number(index);
    if (!Number.isInteger(value) || !CARDS[value]) return;
    if (comparisonIndices.includes(value)) {
      if (!quiet) toast('这张卡已经在收益对比中。');
      return;
    }
    if (comparisonIndices.length >= 8) {
      toast('一次最多对比 8 张卡，请先移除一张。');
      return;
    }
    comparisonIndices.push(value);
    comparisonStrategyResults.delete(value);
    renderComparisonList();
  }

  function renderComparisonList() {
    const container = $('#comparisonList');
    if (!comparisonIndices.length) {
      container.innerHTML = '<div class="empty-inline">从挑战区、推荐结果或上方搜索中加入卡片。</div>';
      return;
    }
    const rows = comparisonIndices.map((index) => evaluateChallengeAction(index)).filter(Boolean);
    const completed = rows.map((item) => comparisonStrategyResults.get(item.index)).filter((item) => item?.value);
    let bestStrategy = null;
    for (const result of completed) if (!bestStrategy || compareObjectiveVectors(result.value, bestStrategy.value) > 0) bestStrategy = result;
    container.innerHTML = rows.map((item) => {
      const card = CARDS[item.index];
      const strategy = comparisonStrategyResults.get(item.index);
      const strategyHtml = strategy?.error
        ? `<div class="strategy-summary is-error"><strong>策略计算未完成</strong><span>${escapeHtml(strategy.error)}</span></div>`
        : strategy?.value
        ? `<div class="strategy-summary${strategy === bestStrategy ? ' is-best' : ''}"><strong>${strategy === bestStrategy ? '当前策略价值最高' : '强制首步策略价值'}</strong><div><span><small>预期完成题数</small><b>${strategy.value[0].toFixed(4)}</b></span><span><small>预期新增相符</small><b>${strategy.value[1].toFixed(3)}</b></span><span><small>预期行动数</small><b>${(-strategy.value[2]).toFixed(3)}</b></span><span><small>计算方法</small><b>${strategy.proven ? '精确 Bellman' : `深度 ${strategy.depth} 近似`}</b></span></div><em>${strategy.proven ? '该状态下已精确求解' : `受限策略树，展开 ${Number(strategy.expandedStates || 0).toLocaleString('zh-CN')} 个状态，不宣称全局最优`}</em></div>`
        : '<div class="strategy-summary is-pending"><strong>尚未计算策略价值</strong><span>点击下方“计算策略价值”。</span></div>';
      return `<article class="comparison-card"><img data-compare-image="${item.index}" alt=""><div class="comparison-main"><div class="comparison-title"><strong>${escapeHtml(card.name)}</strong><button type="button" data-remove-comparison="${item.index}" aria-label="移除">×</button></div><small>${escapeHtml(cardStats(card))}</small>${strategyHtml}<div class="comparison-metrics"><span><small>单步期望得分</small><b>${item.points.toFixed(2)}</b></span><span><small>直接通关概率</small><b>${formatPercent(item.solve)}</b></span><span><small>单步信息增益</small><b>${item.info.toFixed(2)} bit</b></span><span><small>单步新增相符</small><b>${item.newMatches.toFixed(2)}</b></span><span><small>反馈后平均剩余</small><b>${item.remaining.toFixed(item.remaining < 10 ? 2 : 1)} 张</b></span><span><small>反馈分支</small><b>${item.outcomes}</b></span></div></div></article>`;
    }).join('');
    $$('[data-compare-image]').forEach((image) => setCardImage(image, CARDS[Number(image.dataset.compareImage)], true, 'card-back.png'));
  }

  async function openChallengeComparison(seed = []) {
    seed.forEach((index) => addComparisonCard(index, { quiet: true }));
    $('#compareCardSearch').value = '';
    $('#compareCardResults').hidden = true;
    renderComparisonList();
    $('#challengeCompareDialog').showModal();
    await runStrategyComparison();
  }

  function forcedStrategyValue(index, alreadyGuessed) {
    if (alreadyGuessed.has(index)) return { error: '同一题重复挑战不会消耗次数或产生新反馈。' };
    const knownMask = FIELDS.reduce((mask, field) => mask | (state.known[field.key] ? field.bit : 0), 0);
    const weights = CARDS.map((card) => weightOf(card));
    const forcedAction = { type: 'challenge', index };
    const finalPuzzle = state.puzzle === state.config.puzzles;
    if (finalPuzzle && candidateCache.length <= 7 && state.hints <= 4 && state.challenges <= 6) {
      const actions = [...new Set([index, ...exactActionRepresentatives(candidateCache, alreadyGuessed)])];
      try {
        const result = window.DecoderSolver.solveExact({ cards:CARDS, weights, universe:candidateCache, actions, forcedAction,
          config:{...state.config,puzzles:state.puzzle}, puzzle:state.puzzle, hints:state.hints, challenges:state.challenges,
          candidates:candidateCache, knownMask, matchedMask:state.matchedMask, guessed:[...alreadyGuessed], maxStates:160000 });
        return { ...result, proven:true, depth:'完整', method:'exact-bellman' };
      } catch (error) {
        if (!String(error.message).startsWith('EXACT_STATE_LIMIT:')) console.error(error);
      }
    }
    if (!lastQuickMetrics.length) return { error:'请先完成一次推荐计算，以建立一致的后续行动集合。' };
    const actions = restrictedActionSet(candidateCache, lastQuickMetrics, comparisonIndices);
    const base = { cards:CARDS, weights, actions, forcedAction, hints:state.hints, challenges:state.challenges,
      candidates:candidateCache, knownMask, matchedMask:state.matchedMask, guessed:[...alreadyGuessed], maxStates:30000,
      remainingPuzzles:state.config.puzzles-state.puzzle+1, resourceModel:{hintChallengeRatio:.61,equivalentCostPerSolve:3.9} };
    for (const depth of [3,2]) {
      try { return { ...window.DecoderSolver.solveRestrictedHorizon({...base,depth}), proven:false }; }
      catch (error) { if (!String(error.message).startsWith('HORIZON_STATE_LIMIT:')) return { error:error.message }; }
    }
    return { error:'策略树超过计算预算，请减少对比卡或在候选更少时重试。' };
  }

  async function runStrategyComparison() {
    if (!comparisonIndices.length || state.challenges <= 0 || !candidateCache.length) return;
    const token = ++comparisonCalculationToken;
    const progress = $('#comparisonProgress');
    const button = $('#runStrategyComparisonBtn');
    progress.hidden = false;
    button.disabled = true;
    if (!lastQuickMetrics.length) {
      progress.textContent = '正在准备与严格推荐一致的后续行动集合…';
      await calculateRecommendations();
      if (token !== comparisonCalculationToken) return;
    }
    const alreadyGuessed = new Set(state.logs.filter((log) => log.type === 'challenge').map((log) => log.guess));
    comparisonStrategyResults = new Map();
    for (let position = 0; position < comparisonIndices.length; position += 1) {
      const index = comparisonIndices[position];
      progress.textContent = `正在计算 ${position + 1} / ${comparisonIndices.length}：${CARDS[index].name}`;
      await nextFrame();
      if (token !== comparisonCalculationToken) return;
      const result = forcedStrategyValue(index, alreadyGuessed);
      if (token !== comparisonCalculationToken) return;
      comparisonStrategyResults.set(index, result);
      renderComparisonList();
    }
    progress.hidden = true;
    button.disabled = false;
    button.textContent = '重新计算策略价值';
  }

  function showComparisonSearchResults() {
    const query = $('#compareCardSearch').value.trim();
    const container = $('#compareCardResults');
    if (!query) { container.hidden = true; return; }
    const results = searchCards(query);
    container.hidden = false;
    container.innerHTML = results.length ? results.map((index) => `<button class="search-result" type="button" data-compare-card-index="${index}"><span><strong>${escapeHtml(CARDS[index].name)}</strong><small>${escapeHtml(cardStats(CARDS[index]))}</small></span><small>${comparisonIndices.includes(index) ? '已加入' : '加入'}</small></button>`).join('') : '<div class="empty-inline">没有找到卡名</div>';
  }

  function renderExperimentGroups() {
    $('#experimentGroups').innerHTML = strategyExperimentRows.map((row,index) => `<div class="experiment-group"><input data-experiment-name="${index}" type="text" value="${escapeAttr(row.name)}" aria-label="组名"><label><span>深度</span><input data-experiment-depth="${index}" type="number" min="1" max="8" value="${row.depth}"></label><label><span>状态预算</span><input data-experiment-budget="${index}" type="number" min="1000" max="2000000" step="1000" value="${row.budget}"></label><button data-remove-experiment="${index}" class="icon-btn" type="button" aria-label="删除">×</button></div>`).join('');
  }

  function readExperimentGroups() {
    return strategyExperimentRows.map((row,index) => ({
      name: $(`[data-experiment-name="${index}"]`)?.value.trim() || `实验${index+1}`,
      depth: clampInt($(`[data-experiment-depth="${index}"]`)?.value,1,8,row.depth),
      budget: clampInt($(`[data-experiment-budget="${index}"]`)?.value,1000,2000000,row.budget),
    }));
  }

  function openStrategyExperiment() {
    renderExperimentGroups();
    $('#strategyExperimentProgress').hidden = true;
    $('#strategyExperimentDialog').showModal();
  }

  function stopStrategyExperiment(message = '实验已停止。') {
    if (strategyExperimentWorker) strategyExperimentWorker.terminate();
    strategyExperimentWorker = null;
    $('#cancelStrategyExperimentBtn').hidden = true;
    $('#runStrategyExperimentBtn').disabled = false;
    $('#strategyExperimentProgress').hidden = false;
    $('#strategyExperimentProgress').textContent = message;
  }

  async function runStrategyExperiment() {
    if (!strategyExperimentRows.length) { toast('请至少添加一个实验组。'); return; }
    if (!candidateCache.length || state.challenges <= 0) { toast('当前状态无法运行策略实验。'); return; }
    strategyExperimentRows = readExperimentGroups();
    const progress = $('#strategyExperimentProgress');
    progress.hidden = false;
    progress.textContent = '正在准备增强行动集合…';
    $('#runStrategyExperimentBtn').disabled = true;
    $('#cancelStrategyExperimentBtn').hidden = false;
    $('#strategyExperimentResults').innerHTML = '';
    if (!lastQuickMetrics.length) await calculateRecommendations();
    if (!lastQuickMetrics.length) { stopStrategyExperiment('无法建立行动集合。'); return; }
    const actions = restrictedActionSet(candidateCache,lastQuickMetrics,[],true);
    const knownMask = FIELDS.reduce((mask,field)=>mask|(state.known[field.key]?field.bit:0),0);
    const source = window.STRATEGY_EXPERIMENT_WORKER_SOURCE;
    if (!source) { stopStrategyExperiment('实验后台模块未载入。'); return; }
    const url = URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
    strategyExperimentWorker = new Worker(url);
    URL.revokeObjectURL(url);
    const results = [];
    strategyExperimentWorker.onmessage = ({data}) => {
      if (data.type === 'group-start') progress.textContent = `正在运行 ${data.position+1}/${strategyExperimentRows.length}：${data.group.name}（深度 ${data.group.depth}，预算 ${data.group.budget.toLocaleString('zh-CN')}）`;
      if (data.type === 'group-result' || data.type === 'group-error') {
        results[data.position] = data;
        $('#strategyExperimentResults').innerHTML = results.filter(Boolean).map((entry) => {
          if (entry.type === 'group-error') return `<article class="experiment-result is-error"><header><strong>${escapeHtml(entry.group.name)}</strong><span>${entry.elapsed.toFixed(2)} 秒</span></header><p>深度 ${entry.group.depth} · 预算 ${entry.group.budget.toLocaleString('zh-CN')} · ${entry.limitReached?'达到状态上限':'计算错误'}</p></article>`;
          const best = entry.result.action?.type === 'challenge' ? CARDS[entry.result.action.index]?.name : entry.result.action?.type === 'hint' ? '使用提示' : '停止';
          const top = [...entry.result.rootActionValues].sort((a,b)=>compareObjectiveVectors(b.value,a.value)).slice(0,4);
          return `<article class="experiment-result"><header><strong>${escapeHtml(entry.group.name)}</strong><span>${entry.elapsed.toFixed(2)} 秒</span></header><div class="experiment-summary"><span>深度 <b>${entry.group.depth}</b></span><span>预算 <b>${entry.group.budget.toLocaleString('zh-CN')}</b></span><span>展开 <b>${entry.result.expandedStates.toLocaleString('zh-CN')}</b></span><span>首选 <b>${escapeHtml(best||'—')}</b></span></div><p>策略价值：${entry.result.value.map((value)=>value.toFixed(4)).join('／')}</p><ol>${top.map((item)=>`<li>${escapeHtml(CARDS[item.action.index].name)} <small>${item.value.map((value)=>value.toFixed(3)).join('／')}</small></li>`).join('')}</ol></article>`;
        }).join('');
      }
      if (data.type === 'complete') {
        strategyExperimentWorker.terminate(); strategyExperimentWorker=null;
        progress.textContent='全部实验完成。可比较深度、预算、耗时、展开状态与首选是否收敛。';
        $('#cancelStrategyExperimentBtn').hidden=true; $('#runStrategyExperimentBtn').disabled=false;
      }
    };
    strategyExperimentWorker.onerror = (event) => stopStrategyExperiment(`实验失败：${event.message}`);
    strategyExperimentWorker.postMessage({type:'start',cards:CARDS,weights:CARDS.map((card)=>weightOf(card)),actions,
      state:{hints:state.hints,challenges:state.challenges,candidates:candidateCache,knownMask,matchedMask:state.matchedMask,
        guessed:state.logs.filter((log)=>log.type==='challenge').map((log)=>log.guess),remainingPuzzles:state.config.puzzles-state.puzzle+1,
        resourceModel:{hintChallengeRatio:.61,equivalentCostPerSolve:3.9}},groups:strategyExperimentRows});
  }

  function populateBorderRevealChoices() {
    const guess = CARDS[selectedGuess];
    const values = [...new Set(CARDS.filter((card) => weightOf(card) > 0 && (matchMask(card, guess) & 1)).map((card) => card.b))].sort((a,b)=>a-b);
    if (!values.includes(borderRevealValue)) borderRevealValue = null;
    $('#borderRevealChoices').innerHTML = values.map((value) => `<button class="border-choice${value === borderRevealValue ? ' is-on' : ''}" type="button" data-border-reveal="${value}">${escapeHtml(formatBorder(value))}</button>`).join('');
  }

  function populateSpecialReveal(field) {
    const guess = CARDS[selectedGuess];
    const values = new Set();
    for (const index of candidateCache) {
      const target = CARDS[index];
      const matches = Boolean(target.nm & guess.nm);
      if (matches) values.add(target.n);
    }
    const select = $('#numberReveal');
    const currentKnown = state.known[field]?.value;
    select.innerHTML = [...values].sort((a, b) => a - b).map((value) => `<option value="${value}">${escapeHtml(formatValue(field, value))}</option>`).join('');
    if (currentKnown != null && values.has(Number(currentKnown))) select.value = String(currentKnown);
    else {
      const guessed = guess.n;
      if (values.has(guessed)) select.value = String(guessed);
    }
  }

  function beginChallenge() {
    if (selectedGuess == null) { toast('请先选择挑战卡。'); return; }
    if (state.challenges <= 0) { toast('挑战库存不足。'); return; }
    if (testSession) { autoJudgeChallenge(); return; }
    feedbackMask = 0;
    borderRevealValue = null;
    renderFeedback();
    $('#feedbackDialog').showModal();
  }

  function recordChallenge() {
    if (selectedGuess == null) { toast('请先选择挑战卡。'); return; }
    if (state.challenges <= 0) { toast('挑战库存不足。'); return; }
    if (state.logs.some((log) => log.type === 'challenge' && log.guess === selectedGuess)) { toast('同题重复挑战这张卡不会扣次数，也不会留下记录。'); return; }
    const guess = CARDS[selectedGuess];
    const borderReveal = feedbackMask & 1 ? borderRevealValue : null;
    if ((feedbackMask & 1) && borderReveal == null) { toast('请选择游戏揭示的完整目标边框。'); return; }
    const numberReveal = feedbackMask & 8 ? Number($('#numberReveal').value) : null;
    if ((feedbackMask & 8) && Number.isNaN(numberReveal)) { toast('请录入目标显示的等级／阶级／连接值。'); return; }
    const trial = clone(state);
    trial.logs.push({ type: 'challenge', guess: selectedGuess, mask: feedbackMask, borderReveal, numberReveal });
    if (!candidateIndices(trial).length) {
      const alert = $('#feedbackConflict');
      alert.textContent = '这组反馈与当前卡池矛盾：请检查点亮项目、完整目标边框及等级／阶级／连接值。';
      alert.hidden = false;
      alert.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }

    pushUndo();
    const strictMask = feedbackMask;
    const newMask = state.matchedMask | strictMask;
    let delta = thresholdGain(state.matchedMask, newMask);
    const solvedNow = strictMask === 63 && borderReveal === guess.b;
    if (solvedNow) delta += solveReward();
    state.matchedMask = newMask;
    state.challenges -= 1;
    state.puzzleScore += delta;
    state.totalScore += delta;
    if (isPremiumPuzzle()) state.premiumScore += delta;
    else state.progressScore += delta;
    if (solvedNow) state.solved = true;
    for (const field of FIELDS) {
      if (!(feedbackMask & field.bit)) continue;
      let value = fieldValue(guess, field.key);
      if (field.key === 'border') value = borderReveal;
      if (field.key === 'number') value = numberReveal;
      state.known[field.key] = { value, source: 'challenge' };
    }
    const log = { type: 'challenge', guess: selectedGuess, mask: feedbackMask, strictMask, borderReveal, numberReveal, delta, time: timeLabel() };
    state.logs.push(log);
    appendHistory(log);
    if ($('#feedbackDialog').open) $('#feedbackDialog').close();
    clearGuess();
    render();
    toast(solvedNow ? `本题完成，获得 ${delta} 分。` : delta ? `记录成功，本次获得 ${delta} 分。` : '记录成功，候选集已更新。');
  }

  function firstActionReferenceDecision(mode) {
    const reference = window.FIRST_ACTION_REFERENCE;
    if (mode !== 'balanced' || !reference?.states || state.pool !== 'md'
      || state.matchedMask !== 0 || state.logs.length !== 1) return null;
    const known = Object.entries(state.known);
    if (known.length !== 1 || known[0][1]?.source !== 'initial') return null;
    const [fieldKey, reveal] = known[0];
    const key = `${fieldKey}:${Number(reveal.value)}`;
    const entry = reference.states[key];
    if (!entry?.best || entry.status !== 'complete') return null;
    const rootActionValues = (entry.topActions || []).map((action) => ({
      action: { type: action.type, index: action.index ?? undefined }, value: action.value,
    }));
    const canonicalContext = state.puzzle === 1 && state.hints === 11 && state.challenges === 36
      && state.config.puzzles === 9 && state.config.totalHints === 11 && state.config.totalChallenges === 36;
    return {
      action: { type: entry.best.type, index: entry.best.index ?? undefined }, value: entry.best.value,
      rootActionValues, expandedStates: entry.expandedStates, depth: reference.canonical?.depth || 3,
      method: 'first-action-reference', proven: false, enhanced: false, actionCount: entry.coverage?.totalActions || 0,
      coverageInfo: entry.coverage, canonicalContext,
      seedIndexes: rootActionValues.filter((item) => item.action.type === 'challenge').map((item) => item.action.index),
    };
  }

  function runResourceRouteDecision(candidates, alreadyGuessed, quick, token) {
    if (!window.RESOURCE_ROUTE_DATA?.profiles?.length || !window.RESOURCE_ROUTE_WORKER_SOURCE || typeof Worker === 'undefined') return Promise.resolve(null);
    const knownMask = FIELDS.reduce((mask, field) => mask | (state.known[field.key] ? field.bit : 0), 0);
    const baseActions = restrictedActionSet(candidates, quick, [], false);
    const rollouts = clampInt($('#resourceRollouts').value, 2, 8, 4);
    $('#calcProgress em').textContent = `资源路线规划：正在运行 ${rollouts} 组配对抽样…`;
    return new Promise((resolve) => {
      const workerUrl = URL.createObjectURL(new Blob([window.RESOURCE_ROUTE_WORKER_SOURCE], { type:'text/javascript' }));
      const worker = new Worker(workerUrl);
      const finish = (value) => { worker.terminate(); URL.revokeObjectURL(workerUrl); resolve(value); };
      const timeout = setTimeout(() => finish(null), 5 * 60 * 1000);
      worker.onmessage = ({ data }) => {
        if (token !== calculationToken) { clearTimeout(timeout); finish(null); return; }
        if (data.type === 'error') { console.error(data.message); clearTimeout(timeout); finish(null); return; }
        if (data.type !== 'complete') return;
        clearTimeout(timeout);
        const result = {
          action:data.best?.action || { type:'stop' }, value:data.best?.value || [0,0],
          rootActionValues:(data.compared || []).map((entry) => ({ action:entry.action, value:[...entry.value,-1] })),
          method:'resource-route-rollout', proven:false, rollouts:data.rollouts,
          profileSamples:data.profileSamples || window.RESOURCE_ROUTE_DATA.validationSamples || window.RESOURCE_ROUTE_DATA.samples,
        };
        finish(result);
      };
      worker.onerror = (event) => { console.error(event.message); clearTimeout(timeout); finish(null); };
      worker.postMessage({
        cards:CARDS, pool:state.pool, profiles:window.RESOURCE_ROUTE_DATA.profiles,
        profileSamples:window.RESOURCE_ROUTE_DATA.validationSamples || window.RESOURCE_ROUTE_DATA.samples,
        candidates, knownMask, matchedMask:state.matchedMask, guessed:[...alreadyGuessed],
        hints:state.hints, challenges:state.challenges,
        remainingPuzzles:Math.max(1,state.config.puzzles-state.puzzle+1), rollouts, baseActions,
        seed:((state.puzzle*2654435761) ^ (state.hints*2246822519) ^ (state.challenges*3266489917) ^ candidates.length) >>> 0,
      });
    });
  }

  async function calculateRecommendations() {
    if (!candidateCache.length || state.challenges <= 0 || state.solved) return null;
    const token = ++calculationToken;
    const button = $('#calculateBtn');
    button.disabled = true;
    button.textContent = '计算中…';
    $('#calcProgress').hidden = false;
    $('#alternatives').innerHTML = '';
    const mode = $('#recommendMode').value;
    const candidates = [...candidateCache];
    const total = candidateMass(candidates);
    const alreadyGuessed = new Set(state.logs.filter((log) => log.type === 'challenge').map((log) => log.guess));
    const actions = [];
    for (let i = 0; i < CARDS.length; i += 1) if (weightOf(CARDS[i]) > 0 && !alreadyGuessed.has(i)) actions.push(i);
    const oldMask = state.matchedMask;
    const oldCount = popcount(oldMask);
    const quick = [];

    for (let actionPos = 0; actionPos < actions.length; actionPos += 1) {
      if (token !== calculationToken) return;
      const guessIndex = actions[actionPos];
      const guess = CARDS[guessIndex];
      let immediateSum = 0;
      let solveMass = 0;
      let newMatchesSum = 0;
      const bitMass = [0, 0, 0, 0, 0, 0];
      for (const targetIndex of candidates) {
        const target = CARDS[targetIndex];
        const weight = weightOf(target);
        const mask = matchMask(target, guess);
        const strictMask = strictMatchMask(target, guess);
        const newMask = oldMask | strictMask;
        let gain = thresholdGain(oldMask, newMask);
        if (isExactAnswer(target, guess)) { gain += solveReward(); solveMass += weight; }
        immediateSum += gain * weight;
        newMatchesSum += (popcount(newMask) - oldCount) * weight;
        if (mask & 1) bitMass[0] += weight;
        if (mask & 2) bitMass[1] += weight;
        if (mask & 4) bitMass[2] += weight;
        if (mask & 8) bitMass[3] += weight;
        if (mask & 16) bitMass[4] += weight;
        if (mask & 32) bitMass[5] += weight;
      }
      const points = immediateSum / total;
      const solve = solveMass / total;
      const newMatches = newMatchesSum / total;
      const infoApprox = bitMass.reduce((sum, mass) => sum + binaryEntropy(mass / total), 0);
      let score = points;
      if (mode === 'points') score = points + solve * .001;
      if (mode === 'solve') score = solve * 1000 + points;
      if (mode === 'info') score = infoApprox + solve * .001;
      quick.push({ index: guessIndex, points, solve, newMatches, infoApprox, score });
      if (actionPos % 80 === 0) {
        $('#calcProgress em').textContent = `正在比较合法挑战… ${Math.round(actionPos / actions.length * 70)}%`;
        await nextFrame();
      }
    }

    quick.sort((a, b) => mode === 'balanced' ? compareObjectiveVectors(actionObjectiveVector(b), actionObjectiveVector(a)) : b.score - a.score);
    lastQuickMetrics = quick;
    // Always refine the most likely direct candidate guesses. In the old version, a certain
    // answer could fall outside the 300-card information shortlist when all remaining rewards
    // were already earned, which caused the reported one-candidate failure.
    const finalists = quick.slice(0, Math.min(300, quick.length));
    const finalistIds = new Set(finalists.map((item) => item.index));
    const directCandidates = [...candidates]
      .sort((left, right) => weightOf(CARDS[right]) - weightOf(CARDS[left]))
      .slice(0, 40);
    const quickByIndex = new Map(quick.map((item) => [item.index, item]));
    for (const index of directCandidates) {
      if (finalistIds.has(index)) continue;
      const item = quickByIndex.get(index);
      if (item) { finalists.push(item); finalistIds.add(index); }
    }
    for (let position = 0; position < finalists.length; position += 1) {
      const item = finalists[position];
      const guess = CARDS[item.index];
      const outcomes = new Map();
      for (const targetIndex of candidates) {
        const target = CARDS[targetIndex];
        const mask = matchMask(target, guess);
        const borderPart = mask & 1 ? target.b : 0;
        const numberPart = mask & 8 ? target.n + 1 : 0;
        const key = mask | (borderPart << 6) | (numberPart << 14);
        outcomes.set(key, (outcomes.get(key) || 0) + weightOf(target));
      }
      let entropy = 0;
      let expectedRemaining = 0;
      for (const mass of outcomes.values()) {
        const probability = mass / total;
        entropy -= probability * Math.log2(probability);
        expectedRemaining += probability * mass;
      }
      item.info = entropy;
      item.remaining = expectedRemaining;
      if (mode === 'balanced') item.score = item.points;
      if (mode === 'info') item.score = entropy + item.solve * .001;
      if (position % 30 === 0) {
        $('#calcProgress em').textContent = `正在精算反馈分支… ${70 + Math.round(position / finalists.length * 30)}%`;
        await nextFrame();
      }
    }
    finalists.sort((a, b) => mode === 'balanced' ? compareObjectiveVectors(actionObjectiveVector(b), actionObjectiveVector(a)) : b.score - a.score);
    const resourceMode = mode === 'balanced' && $('#solverAlgorithm').value === 'resource';
    const resourceDecision = resourceMode ? await runResourceRouteDecision(candidates, alreadyGuessed, quick, token) : null;
    if (token !== calculationToken) return;
    const referenceDecision = resourceMode ? null : firstActionReferenceDecision(mode);
    // This is a user preference rather than a hidden override: the reference
    // can be preferred on later puzzles too, or turned off for a fully live
    // resource-aware calculation.
    const useReferenceDirect = Boolean(referenceDecision && $('#referencePriorityToggle').checked);
    const exactDecision = mode === 'balanced' && !resourceMode && !useReferenceDirect ? tryExactBellman(candidates, alreadyGuessed) : null;
    const enhancedSearch = mode === 'balanced' && $('#enhancedSearchToggle').checked;
    const restrictedDecision = mode === 'balanced' && !resourceMode && !useReferenceDirect && !exactDecision
      ? tryRestrictedPolicy(candidates, alreadyGuessed, quick, enhancedSearch, referenceDecision?.seedIndexes || []) : null;
    const policyDecision = resourceDecision || (useReferenceDirect ? referenceDecision : (exactDecision || restrictedDecision));
    lastProof = policyDecision || (mode === 'balanced' ? boundedCertificate(quick) : null);
    if (policyDecision?.action?.type === 'challenge') {
      let exactItem = finalists.find((item) => item.index === policyDecision.action.index);
      if (!exactItem) {
        exactItem = quickByIndex.get(policyDecision.action.index);
        if (exactItem) { exactItem.info = exactItem.infoApprox; finalists.push(exactItem); }
      }
      if (exactItem) {
        finalists.splice(finalists.indexOf(exactItem), 1);
        finalists.unshift(exactItem);
      }
    }
    if (enhancedSearch && policyDecision?.rootActionValues?.length) {
      const ranked = policyDecision.rootActionValues
        .filter((entry) => entry.action?.type === 'challenge')
        .sort((left, right) => compareObjectiveVectors(right.value, left.value))
        .map((entry) => {
          const item = finalists.find((candidate) => candidate.index === entry.action.index) || quickByIndex.get(entry.action.index);
          return item ? { ...item, info:item.info ?? item.infoApprox ?? 0, policyValue: entry.value } : null;
        })
        .filter(Boolean);
      lastRecommendations = ranked.slice(0, 6);
    } else lastRecommendations = finalists.slice(0, 6);
    if (token !== calculationToken) return;
    const advice = policyDecision
      ? { use: policyDecision.action.type === 'hint', entropy: expectedHintEntropy(candidates, total), strict: true, proven: Boolean(policyDecision.proven), method: policyDecision.method, value: policyDecision.value, expandedStates: policyDecision.expandedStates, depth: policyDecision.depth, enhanced:Boolean(policyDecision.enhanced), actionCount:policyDecision.actionCount || policyDecision.rootActionValues?.length || 0, rollouts:policyDecision.rollouts, profileSamples:policyDecision.profileSamples }
      : hintAdvice(candidates, total, lastRecommendations[0], mode);
    if (policyDecision?.action?.type === 'challenge') {
      const candidateSet = new Set(candidates);
      const tiedCandidates = [...new Set((policyDecision.optimalActions || []).filter((action) => action.type === 'challenge' && candidateSet.has(action.index)).map((action) => action.index))];
      if (tiedCandidates.length > 1) advice.equivalentChoices = tiedCandidates;
    }
    if (resourceDecision) advice.reason = resourceDecision.action.type === 'hint'
      ? `资源路线规划在当前库存下比较了“先提示”和“先挑战”的完整后续模拟，${resourceDecision.rollouts} 组配对抽样更支持先使用提示。路线价值来自 ${Number(resourceDecision.profileSamples || 0).toLocaleString('zh-CN')} 个独立验证样本，不使用固定提示／挑战兑换比。`
      : `资源路线规划在当前库存下比较了“先提示”和“先挑战”的完整后续模拟，${resourceDecision.rollouts} 组配对抽样更支持挑战“${CARDS[resourceDecision.action.index]?.name || ''}”。结果是统计策略改进，不宣称全局最优。`;
    else if (useReferenceDirect) advice.reason = referenceDecision.canonicalContext
      ? `已优先采用离线第一猜参考库：提示与挑战在同一棵深度 ${referenceDecision.depth} 的自适应策略树中比较。该初始揭示状态已离线展开 ${referenceDecision.expandedStates.toLocaleString('zh-CN')} 个状态；大候选状态使用已声明的覆盖挑战集合。`
      : `已优先采用离线第一猜参考库。当前题号或资源库存与其默认规范不同，因此这是可由你关闭的优先推荐；如需按当前资源重新比较提示与挑战，请关闭“优先采用第一猜参考库”。`;
    else if (referenceDecision) advice.reason = `已命中离线第一猜参考库。由于当前题号或资源库存与参考库规范不同，参考库仅提供高质量挑战候选；提示与挑战的最终取舍仍按当前资源由实时策略树重新计算。`;
    else if (restrictedDecision) advice.reason = `提示与挑战已进入同一棵深度 ${restrictedDecision.depth} 的自适应策略树，并在完全猜中分支计入剩余题目的资源续值。已展开 ${restrictedDecision.expandedStates.toLocaleString('zh-CN')} 个状态；这是跨题近似值，尚未证明全局最优。`;
    if (mode === 'balanced' && !policyDecision && lastProof) {
      Object.assign(advice, lastProof);
      advice.reason = lastProof.proven
        ? `深度 ${lastProof.depth} 的分支定界已证明当前挑战最优；共检查 ${lastProof.totalBranches.toLocaleString('zh-CN')} 个行动分支，剪除 ${lastProof.pruned.toLocaleString('zh-CN')} 个。`
        : `已检查 ${lastProof.totalBranches.toLocaleString('zh-CN')} 个行动分支；深度 ${lastProof.depth} 的可行下界与理论上界仍重叠，因此只报告当前下界最优行动，不宣称全局最优。`;
    }
    renderRecommendation(lastRecommendations, advice);
    $('#calcProgress').hidden = true;
    button.disabled = false;
    button.textContent = '重新计算';
    return recommendationSummary();
  }

  function weightedCandidateEntropy(candidates, pool = state.pool) {
    const total = candidates.reduce((sum, index) => sum + (pool === 'md' ? CARDS[index].wm : CARDS[index].wa), 0);
    if (total <= 0) return 0;
    let entropy = 0;
    for (const index of candidates) {
      const probability = (pool === 'md' ? CARDS[index].wm : CARDS[index].wa) / total;
      entropy -= probability * Math.log2(probability);
    }
    return entropy;
  }

  function actionObjectiveVector(item) {
    return [item.solve, item.newMatches || 0, -1];
  }

  function compareObjectiveVectors(left, right) {
    if (window.DecoderSolver) return window.DecoderSolver.compare(left, right);
    for (let index = 0; index < left.length; index += 1) {
      if (Math.abs(left[index] - right[index]) > 1e-11) return left[index] > right[index] ? 1 : -1;
    }
    return 0;
  }

  function boundedCertificate(actions) {
    const globalUpper = window.DecoderSolver?.stateUpperBound({ config: state.config, puzzle: state.puzzle, challenges: state.challenges })
      || [1, state.config.puzzles - state.puzzle + 1, Infinity];
    const branches = actions.map((item) => ({ item, lower: actionObjectiveVector(item) }));
    branches.sort((a, b) => compareObjectiveVectors(b.lower, a.lower));
    const best = branches[0];
    const challengeExact = state.challenges <= 1;
    const hintPossible = state.hints > 0 && FIELDS.some((field) => !state.known[field.key]);
    let pruned = 0;
    let proven = Boolean(best);
    for (let index = 1; index < branches.length; index += 1) {
      const upper = challengeExact ? branches[index].lower : globalUpper;
      if (compareObjectiveVectors(best.lower, upper) >= 0) pruned += 1;
      else proven = false;
    }
    if (hintPossible) proven = false;
    return {
      method: 'branch-and-bound',
      proven,
      lower: best?.lower || [0, 0, 0],
      upper: proven ? best.lower : globalUpper,
      pruned,
      totalBranches: branches.length + (hintPossible ? 1 : 0),
      depth: 1,
    };
  }

  function expectedHintEntropy(candidates, total) {
    const unknown = FIELDS.filter((field) => !state.known[field.key]);
    if (!unknown.length || total <= 0) return 0;
    let entropySum = 0;
    for (const field of unknown) {
      const outcomes = new Map();
      for (const index of candidates) {
        const value = fieldValue(CARDS[index], field.key);
        outcomes.set(value, (outcomes.get(value) || 0) + weightOf(CARDS[index]));
      }
      for (const outcomeMass of outcomes.values()) {
        const probability = outcomeMass / total;
        entropySum -= probability * Math.log2(probability);
      }
    }
    return entropySum / unknown.length;
  }

  function exactActionRepresentatives(candidates, alreadyGuessed) {
    const signatures = new Map();
    for (let guessIndex = 0; guessIndex < CARDS.length; guessIndex += 1) {
      if (weightOf(CARDS[guessIndex]) <= 0 || alreadyGuessed.has(guessIndex)) continue;
      const guess = CARDS[guessIndex];
      const signature = candidates.map((targetIndex) => {
        const target = CARDS[targetIndex];
        const mask = matchMask(target, guess);
        return `${mask}:${strictMatchMask(target, guess)}:${isExactAnswer(target, guess) ? 1 : 0}:${mask & 1 ? target.b : ''}:${mask & 8 ? target.n : ''}`;
      }).join('|');
      if (!signatures.has(signature)) signatures.set(signature, guessIndex);
    }
    return [...signatures.values()];
  }

  function tryExactBellman(candidates, alreadyGuessed) {
    if (!window.DecoderSolver) return null;
    const finalPuzzle = state.puzzle === state.config.puzzles;
    if (!finalPuzzle || candidates.length > 7 || state.hints > 4 || state.challenges > 6) return null;
    const knownMask = FIELDS.reduce((mask, field) => mask | (state.known[field.key] ? field.bit : 0), 0);
    const actions = exactActionRepresentatives(candidates, alreadyGuessed);
    try {
      const result = window.DecoderSolver.solveExact({
        cards: CARDS,
        weights: CARDS.map((card) => weightOf(card)),
        universe: candidates,
        actions,
        config: { ...state.config, puzzles: state.puzzle },
        puzzle: state.puzzle,
        hints: state.hints,
        challenges: state.challenges,
        candidates,
        knownMask,
        matchedMask: state.matchedMask,
        guessed: [...alreadyGuessed],
        maxStates: 160000,
      });
      return { ...result, method: 'exact-bellman', lower: result.value, upper: result.value, proven: true };
    } catch (error) {
      if (!String(error.message).startsWith('EXACT_STATE_LIMIT:')) console.error(error);
      return null;
    }
  }

  function restrictedActionSet(candidates, quick, extras = [], enhanced = false) {
    const selected = new Set(extras);
    const addTop = (sorter, count) => [...quick].sort(sorter).slice(0, count).forEach((item) => selected.add(item.index));
    addTop((a, b) => compareObjectiveVectors(actionObjectiveVector(b), actionObjectiveVector(a)), enhanced ? 30 : 18);
    addTop((a, b) => b.infoApprox - a.infoApprox, enhanced ? 20 : 8);
    [...candidates].sort((a, b) => weightOf(CARDS[b]) - weightOf(CARDS[a])).slice(0, enhanced ? 12 : 8).forEach((index) => selected.add(index));
    if (!enhanced) return [...selected];

    // The stable path deliberately remains small.  Experimental search uses a
    // coverage set: every field value still present among targets receives a
    // strong probing representative, rather than relying solely on global tops.
    // This is not a proof-preserving quotient (the card data has already merged
    // the 9059 physical cards into behaviour groups); it is an explicit, auditable
    // approximation for the remaining non-candidate probes.
    const metricOrder = (left, right) => {
      const objective = compareObjectiveVectors(
        [left.solve, left.newMatches, left.infoApprox],
        [right.solve, right.newMatches, right.infoApprox],
      );
      return objective || right.points - left.points || left.index - right.index;
    };
    const ranked = [...quick].sort(metricOrder);
    addTop((a, b) => b.solve - a.solve || b.newMatches - a.newMatches || b.infoApprox - a.infoApprox, 24);
    addTop((a, b) => b.points - a.points || b.solve - a.solve || b.infoApprox - a.infoApprox, 24);
    addTop((a, b) => b.newMatches - a.newMatches || b.infoApprox - a.infoApprox || b.solve - a.solve, 24);

    const directLimit = candidates.length <= 256 ? candidates.length : 128;
    const direct = [...candidates].sort((a, b) => weightOf(CARDS[b]) - weightOf(CARDS[a]) || a - b);
    direct.slice(0, directLimit).forEach((index) => selected.add(index));

    const valueOf = (card, field) => field.key === 'number' ? card.nm : fieldValue(card, field.key);
    let coveredValueCount = 0;
    for (const field of FIELDS) {
      const targetValues = new Set(candidates.map((index) => valueOf(CARDS[index], field)));
      for (const value of targetValues) {
        const representative = ranked.find((item) => valueOf(CARDS[item.index], field) === value);
        if (representative != null) { selected.add(representative.index); coveredValueCount += 1; }
      }
    }
    const actions = [...selected];
    actions.coverageInfo = {
      directTotal: candidates.length,
      directIncluded: Math.min(candidates.length, directLimit),
      directComplete: candidates.length <= directLimit,
      fieldValueRepresentatives: coveredValueCount,
      extraProbes: Math.max(0, actions.length - Math.min(candidates.length, directLimit)),
    };
    return actions;
  }

  function tryRestrictedPolicy(candidates, alreadyGuessed, quick, enhanced = false, seedIndexes = []) {
    if (!window.DecoderSolver?.solveRestrictedHorizon || !quick.length) return null;
    const selected = restrictedActionSet(candidates, quick, seedIndexes, enhanced);
    const knownMask = FIELDS.reduce((mask, field) => mask | (state.known[field.key] ? field.bit : 0), 0);
    const base = { cards: CARDS, weights: CARDS.map((card) => weightOf(card)), actions: selected,
      hints: state.hints, challenges: state.challenges, candidates, knownMask, matchedMask: state.matchedMask,
      guessed: [...alreadyGuessed], maxStates: enhanced ? 80000 : 24000, remainingPuzzles: state.config.puzzles - state.puzzle + 1,
      resourceModel: { hintChallengeRatio: .61, equivalentCostPerSolve: 3.9 } };
    for (const depth of [3, 2]) {
      try {
        const result = window.DecoderSolver.solveRestrictedHorizon({ ...base, depth });
        return { ...result, enhanced, actionCount:selected.length, coverageInfo:selected.coverageInfo || null, proven: false, lower: result.value, upper: window.DecoderSolver.stateUpperBound({ config: state.config, puzzle: state.puzzle, challenges: state.challenges }) };
      } catch (error) {
        if (!String(error.message).startsWith('HORIZON_STATE_LIMIT:')) console.error(error);
      }
    }
    return null;
  }

  function decideHintUsage({ candidateGroups, targetEntropy, hintEntropy, bestSolve, bestInfo, hints, remainingPuzzles, challenges, premium, mode }) {
    const effectiveCandidates = 2 ** targetEntropy;
    const hintBudget = hints / Math.max(1, remainingPuzzles);
    const challengeBudget = challenges / Math.max(1, remainingPuzzles);
    const futurePuzzles = Math.max(0, remainingPuzzles - 1);
    const futureReserve = Math.min(hints, futurePuzzles);
    const spendableHints = Math.max(0, hints - futureReserve);
    const lastPuzzle = futurePuzzles === 0;
    const result = { use: false, effectiveCandidates, hintBudget, challengeBudget, futureReserve, spendableHints, lastPuzzle };
    // Kept only for the three single-metric analysis views. Strict mode never calls these
    // empirical thresholds; large strict states return a certified-but-unresolved interval.
    if (mode === 'balanced') return { ...result, strict: true, proven: false };
    if (hints <= 0 || targetEntropy <= 0 || mode === 'points') return result;

    // Before the final puzzle, direct guesses dominate random hints for very small candidate sets.
    // On the final puzzle a useful hint has no future opportunity cost, so leftover hints are spent.
    if (!lastPuzzle && (candidateGroups <= 3 || effectiveCandidates <= 3.1)) return result;
    const relativeInformation = bestInfo > 0 ? hintEntropy / bestInfo : hintEntropy;
    const informative = lastPuzzle
      ? hintEntropy >= .05
      : hintEntropy >= .6 && (hintEntropy >= 1.5 || relativeInformation >= .28);
    if (!informative) return result;

    const lowDirectSolve = bestSolve < (lastPuzzle ? .92 : .48);
    const challengePressure = challengeBudget < 3.1;
    const canSpendNow = spendableHints > 0 || (challengePressure && hints > 0);
    if (mode === 'info') result.use = canSpendNow && (lastPuzzle || hintEntropy >= bestInfo * .72);
    else if (mode === 'solve') result.use = canSpendNow && lowDirectSolve && (lastPuzzle || challengePressure);
    else result.use = canSpendNow && lowDirectSolve && (lastPuzzle || challengePressure || spendableHints > 0 || premium);
    return result;
  }

  function hintAdvice(candidates, total, best, mode) {
    const unknown = FIELDS.filter((field) => !state.known[field.key]);
    const entropy = unknown.length && state.hints > 0 ? expectedHintEntropy(candidates, total) : 0;
    if (mode === 'balanced') return {
      use: false,
      entropy,
      strict: true,
      proven: false,
      lower: actionObjectiveVector(best),
      upper: lastProof?.upper,
      reason: '自适应策略树超过本次计算预算，提示与挑战的价值边界仍重叠；当前显示即时可行下界，不把信息熵折算为奖励，也不声称全局最优。',
    };
    if (!unknown.length || state.hints <= 0) return { use: false, entropy: 0 };
    const remainingQuestions = Math.max(1, state.config.puzzles + 1 - state.puzzle);
    const hintsUsed = state.logs.filter((log) => log.type === 'reveal' && log.source === 'hint').length;
    const targetEntropy = weightedCandidateEntropy(candidates);
    const decision = decideHintUsage({
      candidateGroups: candidates.length,
      targetEntropy,
      hintEntropy: entropy,
      bestSolve: best?.solve || 0,
      bestInfo: best?.info || 0,
      hints: state.hints,
      remainingPuzzles: remainingQuestions,
      challenges: state.challenges,
      premium: isPremiumPuzzle(),
      mode,
    });
    return { ...decision, entropy, unknown: unknown.length, targetEntropy, hintsUsed };
  }

  function renderRecommendation(recommendations, hint) {
    const best = recommendations[0];
    if (!best) return;
    const card = CARDS[best.index];
    const recommendHint = hint.use;
    const equivalentChoices = hint.equivalentChoices || [];
    const chooseAny = !recommendHint && equivalentChoices.length > 1;
    lastAdvice = { ...hint, recommendHint };
    $('#recommendationCard').classList.remove('empty-state');
    $('#recommendTitle').textContent = recommendHint ? '先使用1次提示' : chooseAny ? `以下 ${equivalentChoices.length} 张任选其一` : card.name;
    $('#recommendTitle').disabled = recommendHint || chooseAny;
    $('#recommendTitle').dataset.cardIndex = recommendHint || chooseAny ? '' : String(best.index);
    $('#copyRecommendCard').hidden = recommendHint || chooseAny;
    $('#copyRecommendCard').dataset.cardIndex = recommendHint || chooseAny ? '' : String(best.index);
    if (chooseAny) { const image=$('#recommendImage'); image.hidden=false; image.src='card-back.png'; image.dataset.zoomable='false'; }
    else setCardImage($('#recommendImage'), card, !recommendHint);
    $('#recommendReason').textContent = chooseAny
      ? `这些候选在当前策略树中的词典序价值完全相同：${equivalentChoices.slice(0,6).map((index)=>CARDS[index].name).join('、')}${equivalentChoices.length>6?'等':''}。任选一张都不会改变模型期望；请在下方自行选择，求解器不替你随机指定。`
      : hint.strict
      ? hint.proven
        ? hint.method === 'exact-bellman'
          ? recommendHint
            ? `完整 Bellman 穷举证明：先使用提示的词典序价值更高。本次提示预计产生 ${hint.entropy.toFixed(2)} 比特信息，但信息熵没有参与奖励计算。`
            : `完整 Bellman 穷举证明：当前应挑战“${card.name}”。已展开 ${Number(hint.expandedStates || 0).toLocaleString('zh-CN')} 个状态。`
          : hint.reason
        : hint.reason
      : recommendHint
        ? `${hint.lastPuzzle ? '这是最后一题，剩余提示已没有保留价值' : `为后续题预留 ${hint.futureReserve} 次后，当前仍有 ${hint.spendableHints} 次可主动使用`}；本次随机提示预计带来 ${hint.entropy.toFixed(2)} 比特信息。录入后请重新计算。若直接挑战，首选“${card.name}”。`
        : recommendationReason(best);
    const stats = $('#recommendCardStats');
    stats.hidden = false;
    stats.innerHTML = hint.strict
      ? `<span>${hint.method === 'resource-route-rollout' ? '统计策略估计' : hint.proven ? '已证明最优' : '当前可行下界'}</span><span>${hint.method === 'exact-bellman' ? '精确 Bellman' : hint.method === 'restricted-horizon' ? `深度${hint.depth}策略树` : hint.method === 'resource-route-rollout' ? `${hint.rollouts} 组滚动抽样` : '分支定界'}</span><span>候选组 ${candidateCache.length}</span><span>提示信息 ${hint.entropy.toFixed(2)} bit</span>`
      : recommendHint
      ? `<span>剩余提示 ${state.hints}</span><span>后续预留 ${hint.futureReserve}</span><span>当前可支配 ${hint.spendableHints}</span><span>有效候选约 ${hint.effectiveCandidates.toFixed(1)}</span>`
      : `<span>${escapeHtml(formatBorder(card.b))}</span><span>${escapeHtml(DATA.labels.attribute[card.a] || card.a)}</span><span>${escapeHtml(DATA.labels.race[card.r] || card.r)}</span><span>${card.n}</span><span>${formatStat(card.atk)}／${formatStat(card.def)}</span>`;
    $('#metricPoints').textContent = recommendHint ? '0.00' : best.points.toFixed(2);
    $('#metricSolve').textContent = recommendHint ? '0%' : formatPercent(best.solve);
    $('#metricInfo').textContent = `${(recommendHint ? hint.entropy : best.info).toFixed(2)} bit`;
    $('#alternatives').innerHTML = chooseAny
      ? equivalentChoices.slice(0,8).map((index,offset)=>`<button class="alternative" type="button" data-recommend-index="${index}"><div class="alternative-title"><b>=</b><span>${escapeHtml(CARDS[index].name)}</span></div><div class="alternative-metrics"><span><small>关系</small>并列最优</span><span><small>操作</small>点击选择</span></div></button>`).join('')
      : recommendations.slice(recommendHint ? 0 : 1, recommendHint ? 3 : 4).map((item, offset) => `<button class="alternative" type="button" data-recommend-index="${item.index}"><div class="alternative-title"><b>${offset + 1}</b><span>${escapeHtml(CARDS[item.index].name)}</span></div><div class="alternative-metrics">${item.policyValue ? `<span><small>策略解题</small>${item.policyValue[0].toFixed(4)}</span><span><small>策略相符</small>${item.policyValue[1].toFixed(3)}</span><span><small>策略行动</small>${(-item.policyValue[2]).toFixed(3)}</span>` : `<span><small>期望</small>${item.points.toFixed(2)}</span><span><small>通关</small>${formatPercent(item.solve)}</span><span><small>信息</small>${item.info.toFixed(2)} bit</span>`}</div></button>`).join('');
    $('#methodNote').textContent = hint.method === 'resource-route-rollout'
      ? `资源路线模式使用独立训练／验证的整题路线分布，并在每一步重新比较提示与挑战；抽样越多越稳定，耗时也近似线性增加。`
      : hint.method === 'restricted-horizon'
      ? hint.enhanced
        ? `实验性增强搜索：已将 ${hint.actionCount} 张多方向代表卡放入同一深度 ${hint.depth} 策略树，前四按强制首步后的策略价值排序；仍不等于全局最优证明。`
        : `当前为受限深度自适应策略树：提示与挑战使用相同递归和终止规则；结果是合法可行策略，不等于全局最优证明。`
      : `严格模式按预期解题数、首次相符项数、负行动数作词典序比较；信息熵只用于解释。`;
  }

  function recommendationReason(item) {
    const mode = $('#recommendMode').value;
    if (mode === 'points') return `它在当前奖励门槛下的即时得分最高，期望约 ${item.points.toFixed(2)} 分。`;
    if (mode === 'solve') return `它与当前候选六项全部相符的概率最高，约为 ${formatPercent(item.solve)}。`;
    if (mode === 'info') return `它预计带来 ${item.info.toFixed(2)} 比特信息，最能均匀分割当前候选。`;
    return `它在即时奖励、${formatPercent(item.solve)} 的本次通关概率和 ${item.info.toFixed(2)} 比特信息增益之间取得当前最高综合值。`;
  }

  function renderModeGuide() {
    const guides = {
      balanced: '默认：按预期解题数、首次相符项数、负行动数作词典序比较；提示与挑战进入同一策略树。',
      points: '分析视图：只比较下一次挑战的即时奖励，不参与严格综合决策。',
      solve: '分析视图：只比较这一猜直接通关的概率，不代表全活动最优。',
      info: '分析视图：只比较反馈信息量；信息熵不会在严格决策中折算为奖励。',
    };
    $('#modeGuide').textContent = $('#solverAlgorithm')?.value === 'resource' && $('#recommendMode').value === 'balanced'
      ? '新方案：按剩余题数与库存滚动比较提示和挑战；不改动原稳定搜索，可随时切回。'
      : guides[$('#recommendMode').value];
  }

  function renderAlgorithmControls() {
    const resource = $('#solverAlgorithm').value === 'resource';
    $('#resourceRolloutWrap').hidden = !resource;
    $('#referencePriorityToggle').closest('label').hidden = resource;
    $('#enhancedSearchToggle').closest('label').hidden = resource;
    $('#strategyExperimentBtn').hidden = resource;
    localStorage.setItem('card-decoder-algorithm', resource ? 'resource' : 'stable');
    renderModeGuide();
  }

  function binaryEntropy(probability) {
    if (probability <= 0 || probability >= 1) return 0;
    return -probability * Math.log2(probability) - (1 - probability) * Math.log2(1 - probability);
  }

  function nextFrame() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function formatPercent(value) {
    if (value > 0 && value < .0005) return '<0.05%';
    return `${(value * 100).toFixed(value < .1 ? 2 : 1)}%`;
  }

  function timeLabel() {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date());
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  function switchTab(name) {
    $$('.tab').forEach((tab) => {
      const active = tab.dataset.tab === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    $('#revealPane').hidden = name !== 'reveal';
    $('#challengePane').hidden = name !== 'challenge';
  }

  function configFromForm() {
    const milestones = $$('#milestoneRows .milestone-row').map((row) => ({
      matches: Number(row.querySelector('[data-role="matches"]').value),
      points: Number(row.querySelector('[data-role="points"]').value),
    }));
    return normalizeConfig({
      puzzles: $('#cfgPuzzles').value,
      totalHints: $('#cfgTotalHints').value,
      totalChallenges: $('#cfgTotalChallenges').value,
      premiumPuzzles: $('#cfgPremiumPuzzles').value,
      solvePoints: $('#cfgSolvePoints').value,
      regularMatchPoints: $('#cfgRegularMatchPoints').value,
      regularSolvePoints: $('#cfgRegularSolvePoints').value,
      milestones,
    });
  }

  function fillSettingsForm(config) {
    const value = normalizeConfig(config);
    $('#cfgPuzzles').value = value.puzzles;
    $('#cfgTotalHints').value = value.totalHints;
    $('#cfgTotalChallenges').value = value.totalChallenges;
    $('#cfgPremiumPuzzles').value = value.premiumPuzzles;
    $('#cfgSolvePoints').value = value.solvePoints;
    $('#cfgRegularMatchPoints').value = value.regularMatchPoints;
    $('#cfgRegularSolvePoints').value = value.regularSolvePoints;
    $('#milestoneRows').innerHTML = '';
    value.milestones.forEach((item) => addMilestoneRow(item));
  }

  function addMilestoneRow(item = { matches: 1, points: 10 }) {
    const row = document.createElement('div');
    row.className = 'milestone-row';
    row.innerHTML = `<label><span>相符项数</span><input data-role="matches" type="number" min="1" max="5" value="${clampInt(item.matches, 1, 5, 1)}"></label><label><span>奖励分数</span><input data-role="points" type="number" min="0" max="99999" value="${clampInt(item.points, 0, 99999, 0)}"></label><button class="icon-btn" data-remove-milestone type="button" aria-label="删除门槛">×</button>`;
    $('#milestoneRows').append(row);
  }

  function renderPresetOptions(selectedId = state.presetId) {
    const presets = allPresets();
    $('#presetSelect').innerHTML = presets.map((preset) => `<option value="${escapeAttr(preset.id)}">${escapeHtml(preset.name)}</option>`).join('') + '<option value="custom">自定义当前设置</option>';
    $('#presetSelect').value = presets.some((item) => item.id === selectedId) ? selectedId : 'custom';
  }

  function openSettings() {
    renderPresetOptions();
    fillSettingsForm(state.config);
    $('#customPresetName').value = '';
    $('#settingsDialog').showModal();
  }

  function applySettings() {
    const config = configFromForm();
    if (!config.milestones.length) { toast('请至少保留一个累计相符奖励门槛。'); return; }
    if (!confirm('应用新设置会清除当前活动进度，是否继续？')) return;
    const selected = $('#presetSelect').value;
    state = freshState(config);
    state.presetId = selected;
    undoStack = [];
    selectedGuess = null;
    feedbackMask = 0;
    $('#settingsDialog').close();
    render();
    toast('新活动设置已应用。');
  }

  function saveCustomPreset() {
    const name = $('#customPresetName').value.trim();
    if (!name) { toast('请先填写预设名称。'); return; }
    const preset = { id: `local-${Date.now()}`, name, config: configFromForm() };
    let custom = [];
    try { custom = JSON.parse(localStorage.getItem(PRESET_KEY)) || []; } catch { custom = []; }
    custom.push(preset);
    localStorage.setItem(PRESET_KEY, JSON.stringify(custom));
    renderPresetOptions(preset.id);
    $('#presetSelect').value = preset.id;
    toast('预设已保存在本机浏览器。');
  }

  function randomWeightedIndex(pool = state.pool) {
    let total = 0;
    for (const card of CARDS) total += pool === 'md' ? card.wm : card.wa;
    let pick = Math.random() * total;
    for (let index = 0; index < CARDS.length; index += 1) {
      pick -= pool === 'md' ? CARDS[index].wm : CARDS[index].wa;
      if (pick < 0) return index;
    }
    return CARDS.length - 1;
  }

  function startSession(mode, options = {}) {
    if (testSession) return;
    const requestedTarget = Number(options.targetIndex);
    const targetIndex = Number.isInteger(requestedTarget) && requestedTarget >= 0 && requestedTarget < CARDS.length && weightOf(CARDS[requestedTarget]) > 0
      ? requestedTarget
      : randomWeightedIndex(state.pool);
    testSession = { realState: clone(state), targetIndex, mode, revealed: false, initialField: options.initialField || 'random' };
    const pool = state.pool;
    state = freshState(state.config);
    state.pool = pool;
    state.presetId = testSession.realState.presetId;
    seedTestInitialReveal(testSession.initialField);
    undoStack = [];
    render();
    toast(`${mode === 'game' ? '小游戏' : '测试'}模式已开始；退出后会恢复原活动进度。`);
  }

  function openTestSetup() {
    pendingTestTarget = testSession?.mode === 'test' ? testSession.targetIndex : null;
    $('#testTargetMode').value = pendingTestTarget == null ? 'random' : 'specific';
    $('#testInitialField').value = testSession?.initialField || 'random';
    $('#testTargetSearch').value = pendingTestTarget == null ? '' : CARDS[pendingTestTarget].name;
    renderTestTargetPicker();
    $('#testSetupDialog').showModal();
  }

  function renderTestTargetPicker() {
    const specific = $('#testTargetMode').value === 'specific';
    $('#testTargetPicker').hidden = !specific;
    const selected = $('#testTargetSelected');
    selected.hidden = !specific || pendingTestTarget == null;
    selected.innerHTML = pendingTestTarget == null ? '' : `<span>已选择目标</span><strong>${escapeHtml(CARDS[pendingTestTarget].name)}</strong><small>${escapeHtml(cardStats(CARDS[pendingTestTarget]))}</small>`;
    if (!specific) $('#testTargetResults').innerHTML = '';
  }

  function showTestTargetResults() {
    const query = $('#testTargetSearch').value.trim();
    const container = $('#testTargetResults');
    if (!query) { container.innerHTML = ''; return; }
    const results = searchCards(query);
    container.innerHTML = results.length
      ? results.slice(0, 12).map((index) => `<button class="search-result" type="button" data-test-target-index="${index}"><span><strong>${escapeHtml(CARDS[index].name)}</strong><small>${escapeHtml(cardStats(CARDS[index]))}</small></span><small>${weightOf(CARDS[index])}张同组</small></button>`).join('')
      : '<div class="empty-inline">没有找到卡名</div>';
  }

  function applyTestSetup() {
    const specific = $('#testTargetMode').value === 'specific';
    if (specific && pendingTestTarget == null) throw new Error('请先搜索并选择一张目标卡。');
    const options = { targetIndex: specific ? pendingTestTarget : undefined, initialField: $('#testInitialField').value };
    $('#testSetupDialog').close();
    if (testSession?.mode === 'test') {
      const pool = state.pool;
      const config = state.config;
      const presetId = state.presetId;
      testSession.targetIndex = specific ? pendingTestTarget : randomWeightedIndex(pool);
      testSession.initialField = options.initialField;
      testSession.revealed = false;
      state = freshState(config);
      state.pool = pool;
      state.presetId = presetId;
      seedTestInitialReveal(testSession.initialField);
      undoStack = [];
      clearGuess();
      render();
      toast('已按指定设置更换测试目标。');
      return;
    }
    startSession('test', options);
  }

  function startTestMode() { openTestSetup(); }
  function startGameMode() { startSession('game'); }

  function seedTestInitialReveal(fieldKey = 'random') {
    const target = CARDS[testSession.targetIndex];
    const field = FIELDS.find((item) => item.key === fieldKey) || FIELDS[Math.floor(Math.random() * FIELDS.length)];
    const value = fieldValue(target, field.key);
    state.known[field.key] = { value, source: 'initial' };
    state.initialUsed = true;
    const log = { type: 'reveal', field: field.key, value, source: 'initial', time: timeLabel() };
    state.logs.push(log);
    appendHistory(log);
  }

  function newTestTarget() {
    if (!testSession) return;
    if (testSession.mode === 'test') { openTestSetup(); return; }
    const pool = state.pool;
    const config = state.config;
    const presetId = state.presetId;
    testSession.targetIndex = randomWeightedIndex(pool);
    testSession.revealed = false;
    state = freshState(config);
    state.pool = pool;
    state.presetId = presetId;
    seedTestInitialReveal('random');
    undoStack = [];
    clearGuess();
    render();
  }

  function exitTestMode() {
    if (!testSession) return;
    const theme = localStorage.getItem('card-decoder-theme') || state.theme;
    const imageQuality = localStorage.getItem('card-decoder-image-quality') || state.imageQuality;
    state = testSession.realState;
    state.theme = theme;
    state.imageQuality = imageQuality;
    testSession = null;
    undoStack = [];
    clearGuess();
    render();
    toast('已退出测试模式，真实活动进度已恢复。');
  }

  function revealSessionTarget() {
    if (!testSession) return;
    testSession.revealed = true;
    renderTestMode();
  }

  function autoJudgeChallenge() {
    if (!testSession || selectedGuess == null) { toast('请先选择一张挑战卡。'); return; }
    const target = CARDS[testSession.targetIndex];
    feedbackMask = matchMask(target, CARDS[selectedGuess]);
    renderFeedback();
    if (feedbackMask & 1) { borderRevealValue = target.b; renderFeedback(); }
    if (feedbackMask & 8) $('#numberReveal').value = String(target.n);
    recordChallenge();
  }

  function openSimulation() {
    $('#simulationPool').value = state.pool;
    const config = state.config;
    const hardwareCap = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4));
    [...$('#simulationParallel').options].forEach((option)=>{option.disabled=Number(option.value)>hardwareCap;});
    if (Number($('#simulationParallel').value) > hardwareCap) $('#simulationParallel').value=String([8,4,2,1].find((value)=>value<=hardwareCap));
    $('#simulationConfigSummary').textContent = `${config.puzzles} 题；全活动提示 ${config.totalHints} 次、挑战 ${config.totalChallenges} 次。每一步使用与实操相同的策略树。当前设备最多开放 ${hardwareCap} 路并行，推荐 4 路以平衡速度和内存。`;
    if (simulationSnapshot) { renderSimulationSnapshot(simulationSnapshot); renderSimulationWorkers(simulationSnapshot); }
    $('#runSimulationBtn').textContent = simulationRunning ? '停止后台测试' : '开始模拟';
    $('#simulationDialog').showModal();
  }

  function weightedSample(items, pool) {
    let total = 0;
    for (const index of items) total += pool === 'md' ? CARDS[index].wm : CARDS[index].wa;
    let pick = Math.random() * total;
    for (const index of items) {
      pick -= pool === 'md' ? CARDS[index].wm : CARDS[index].wa;
      if (pick < 0) return index;
    }
    return items[items.length - 1];
  }

  function simulationWeight(card, pool) {
    return pool === 'md' ? card.wm : card.wa;
  }

  function filterSimCandidates(candidates, guess, mask, target) {
    return candidates.filter((index) => {
      const card = CARDS[index];
      if (matchMask(card, guess) !== mask) return false;
      if ((mask & 1) && card.b !== target.b) return false;
      if ((mask & 8) && card.n !== target.n) return false;
      return true;
    });
  }

  function simulationHintEntropy(candidates, known, pool) {
    const unknown = FIELDS.filter((field) => !known.has(field.key));
    if (!unknown.length) return 0;
    const total = candidates.reduce((sum, index) => sum + simulationWeight(CARDS[index], pool), 0);
    let entropySum = 0;
    for (const field of unknown) {
      const outcomes = new Map();
      for (const index of candidates) {
        const value = fieldValue(CARDS[index], field.key);
        outcomes.set(value, (outcomes.get(value) || 0) + simulationWeight(CARDS[index], pool));
      }
      let entropy = 0;
      for (const mass of outcomes.values()) { const probability = mass / total; entropy -= probability * Math.log2(probability); }
      entropySum += entropy;
    }
    return entropySum / unknown.length;
  }

  function pickSimulationChallenge(candidates, pool, matchedMask, config, puzzle, guessed, resources) {
    if (candidates.length === 1 && !guessed.has(candidates[0])) return { index: candidates[0], solve: 1, info: 0 };
    // Large pools are sampled in proportion to their card multiplicity. Sampled observations
    // carry unit weight; multiplying them by the group weight again would square the prior.
    const sample = candidates.length <= 220
      ? candidates.map((index) => ({ index, weight: simulationWeight(CARDS[index], pool) }))
      : Array.from({ length: 220 }, () => ({ index: weightedSample(candidates, pool), weight: 1 }));
    const actions = [];
    const addAction = (index) => {
      if (index == null || guessed.has(index) || actions.includes(index) || simulationWeight(CARDS[index], pool) <= 0) return;
      actions.push(index);
    };
    const top = [...candidates].sort((a, b) => simulationWeight(CARDS[b], pool) - simulationWeight(CARDS[a], pool)).slice(0, 16);
    for (const index of top) addAction(index);
    if (candidates.length <= 24) for (const index of candidates) addAction(index);
    let candidateAttempts = 0;
    while (actions.length < 32 && actions.length < candidates.length && candidateAttempts < 400) {
      addAction(weightedSample(candidates, pool));
      candidateAttempts += 1;
    }
    let attempts = 0;
    while (actions.length < 48 && attempts < 500) {
      addAction(Math.floor(Math.random() * CARDS.length));
      attempts += 1;
    }
    let best = actions[0] == null ? null : { index: actions[0], solve: 0, info: 0 };
    let bestScore = -Infinity;
    const remainingPuzzles = Math.max(0, config.puzzles - puzzle);
    let futureValue = 0;
    for (let future = puzzle + 1; future <= config.puzzles; future += 1) futureValue += maxPuzzleScore(config, future);
    const capacity = Math.min(1, (Math.max(0, resources.challenges - 1) + resources.hints * .75) / Math.max(2, remainingPuzzles * 3.5 + 2));
    const completionValue = futureValue * capacity + Math.max(8, maxPuzzleScore(config, puzzle) * .35);
    const infoPointValue = resources.challenges <= 1 ? 0 : Math.min(5.5, 1.8 + resources.challenges / Math.max(1, config.puzzles + 1 - puzzle) * .75);
    const oldCount = popcount(matchedMask);
    for (const action of actions) {
      const guess = CARDS[action];
      let total = 0;
      let points = 0;
      let solve = 0;
      let newMatches = 0;
      const outcomes = new Map();
      for (const observation of sample) {
        const targetIndex = observation.index;
        const target = CARDS[targetIndex];
        const weight = observation.weight;
        const mask = matchMask(target, guess);
        let gain = thresholdGain(matchedMask, matchedMask | mask, config, puzzle);
        if (mask === 63) { gain += solveReward(config, puzzle); solve += weight; }
        const key = mask | ((mask & 1 ? target.b : 0) << 6) | ((mask & 8 ? target.n + 1 : 0) << 14);
        outcomes.set(key, (outcomes.get(key) || 0) + weight);
        points += gain * weight;
        newMatches += (popcount(matchedMask | mask) - oldCount) * weight;
        total += weight;
      }
      let entropy = 0;
      for (const mass of outcomes.values()) { const p = mass / total; entropy -= p * Math.log2(p); }
      const solveProbability = solve / total;
      const score = points / total + solveProbability * completionValue + entropy * infoPointValue + newMatches / total * .2;
      if (score > bestScore) { bestScore = score; best = { index: action, solve: solveProbability, info: entropy }; }
    }
    return best;
  }

  function simulationStateKey(candidates, known, matchedMask, guessed, hints, challenges, puzzle, pool) {
    const knownMask = FIELDS.reduce((mask, field) => mask | (known.has(field.key) ? field.bit : 0), 0);
    return `${pool}|${puzzle}|${hints}|${challenges}|${knownMask}|${matchedMask}|${candidates.join(',')}|${[...guessed].sort((a,b)=>a-b).join(',')}`;
  }

  function simulationPolicyDecision(candidates, known, matchedMask, guessed, hints, challenges, puzzle, config, pool, universe, diagnostics, cache) {
    const cacheKey = simulationStateKey(candidates, known, matchedMask, guessed, hints, challenges, puzzle, pool);
    if (cache.has(cacheKey)) { diagnostics.cacheHits += 1; return cache.get(cacheKey); }
    diagnostics.solverCalls += 1;
    const total = candidates.reduce((sum, index) => sum + simulationWeight(CARDS[index], pool), 0);
    const oldCount = popcount(matchedMask);
    const quick = [];
    for (const action of universe) {
      if (guessed.has(action)) continue;
      const guess = CARDS[action];
      let solveMass = 0, newMatches = 0;
      const bitMass = [0,0,0,0,0,0];
      for (const targetIndex of candidates) {
        const target = CARDS[targetIndex], weight = simulationWeight(target, pool), mask = matchMask(target, guess), strictMask = strictMatchMask(target, guess);
        if (isExactAnswer(target, guess)) solveMass += weight;
        newMatches += (popcount(matchedMask | strictMask) - oldCount) * weight;
        for (let bit = 0; bit < 6; bit += 1) if (mask & (1 << bit)) bitMass[bit] += weight;
      }
      let infoApprox = 0;
      for (const value of bitMass) infoApprox += binaryEntropy(value / total);
      quick.push({ index: action, solve: solveMass / total, newMatches: newMatches / total, infoApprox });
    }
    quick.sort((a,b)=>compareObjectiveVectors(actionObjectiveVector(b),actionObjectiveVector(a)));
    let result = null;
    const knownMask = FIELDS.reduce((mask, field) => mask | (known.has(field.key) ? field.bit : 0), 0);
    if (puzzle === config.puzzles && candidates.length <= 7 && hints <= 4 && challenges <= 6) {
      const signatures = new Map();
      for (const action of universe) {
        if (guessed.has(action)) continue;
        const signature = candidates.map((targetIndex) => { const target=CARDS[targetIndex],guess=CARDS[action],mask=matchMask(target,guess); return `${mask}:${strictMatchMask(target,guess)}:${isExactAnswer(target,guess)?1:0}:${mask&1?target.b:''}:${mask&8?target.n:''}`; }).join('|');
        if (!signatures.has(signature)) signatures.set(signature, action);
      }
      try {
        result = window.DecoderSolver.solveExact({ cards:CARDS, weights:CARDS.map(card=>simulationWeight(card,pool)), universe:candidates, actions:[...signatures.values()],
          config:{...config,puzzles:puzzle}, puzzle, hints, challenges, candidates, knownMask, matchedMask, guessed:[...guessed], maxStates:160000 });
        diagnostics.exactCalls += 1;
      } catch (error) { if (!String(error.message).startsWith('EXACT_STATE_LIMIT:')) console.error(error); }
    }
    if (!result) {
      const selected = new Set();
      quick.slice(0,18).forEach(item=>selected.add(item.index));
      [...quick].sort((a,b)=>b.infoApprox-a.infoApprox).slice(0,8).forEach(item=>selected.add(item.index));
      [...candidates].sort((a,b)=>simulationWeight(CARDS[b],pool)-simulationWeight(CARDS[a],pool)).slice(0,8).forEach(index=>selected.add(index));
      const base={cards:CARDS,weights:CARDS.map(card=>simulationWeight(card,pool)),actions:[...selected],hints,challenges,candidates,knownMask,matchedMask,guessed:[...guessed],maxStates:24000,remainingPuzzles:config.puzzles-puzzle+1,resourceModel:{hintChallengeRatio:.61,equivalentCostPerSolve:3.9}};
      for (const depth of [3,2]) {
        try { result=window.DecoderSolver.solveRestrictedHorizon({...base,depth}); diagnostics[`depth${depth}Calls`]+=1; break; }
        catch(error){if(!String(error.message).startsWith('HORIZON_STATE_LIMIT:'))console.error(error);}
      }
    }
    if (!result) { result={action:{type:'challenge',index:quick[0].index},method:'fallback'}; diagnostics.fallbackCalls += 1; }
    cache.set(cacheKey,result);
    if (cache.size > 4000) cache.delete(cache.keys().next().value);
    return result;
  }

  async function simulateOneActivity(config, pool, diagnostics, cache) {
    let hints = config.totalHints;
    let challenges = config.totalChallenges;
    let premiumScore = 0;
    let progressScore = 0;
    let solved = 0;
    let hintsUsed = 0;
    let challengesUsed = 0;
    let matchedItems = 0;
    const universe = CARDS.map((_, index) => index).filter((index) => simulationWeight(CARDS[index], pool) > 0);
    let reachedPuzzle = 0;
    for (let puzzle = 1; puzzle <= config.puzzles && challenges > 0; puzzle += 1) {
      reachedPuzzle = puzzle;
      const targetIndex = weightedSample(universe, pool);
      const target = CARDS[targetIndex];
      const known = new Set();
      const initial = FIELDS[Math.floor(Math.random() * FIELDS.length)];
      known.add(initial.key);
      let candidates = universe.filter((index) => fieldValue(CARDS[index], initial.key) === fieldValue(target, initial.key));
      let matchedMask = 0;
      const guessed = new Set();
      let puzzleSolved = false;
      let hintsUsedThisPuzzle = 0;
      const remainingPuzzles = config.puzzles - puzzle + 1;
      while (challenges > 0 && !puzzleSolved) {
        const recommendation = simulationPolicyDecision(candidates, known, matchedMask, guessed, hints, challenges, puzzle, config, pool, universe, diagnostics, cache);
        if (!recommendation?.action || recommendation.action.type === 'stop') break;
        if (hints > 0 && known.size < 6 && recommendation.action.type === 'hint') {
          const unknown = FIELDS.filter((field) => !known.has(field.key));
          const field = unknown[Math.floor(Math.random() * unknown.length)];
          known.add(field.key);
          candidates = candidates.filter((index) => fieldValue(CARDS[index], field.key) === fieldValue(target, field.key));
          hints -= 1;
          hintsUsed += 1;
          hintsUsedThisPuzzle += 1;
          diagnostics.hintDecisions += 1;
          continue;
        }
        const guessIndex = recommendation.action.index;
        diagnostics.challengeDecisions += 1;
        guessed.add(guessIndex);
        const guess = CARDS[guessIndex];
        const mask = matchMask(target, guess);
        const strictMask = strictMatchMask(target, guess);
        matchedItems += popcount(matchedMask | strictMask) - popcount(matchedMask);
        const gain = thresholdGain(matchedMask, matchedMask | strictMask, config, puzzle);
        if (isPremiumPuzzle(puzzle, config)) premiumScore += gain;
        else progressScore += gain;
        matchedMask |= strictMask;
        // Matching challenge fields are revealed by the real game and therefore cannot be
        // selected by a later random hint. Omitting this made simulations waste hints on
        // already-known fields and systematically understated the policy's performance.
        for (const field of FIELDS) if (mask & field.bit) known.add(field.key);
        challenges -= 1;
        challengesUsed += 1;
        if (isExactAnswer(target, guess)) {
          const bonus = solveReward(config, puzzle);
          if (isPremiumPuzzle(puzzle, config)) premiumScore += bonus; else progressScore += bonus;
          solved += 1; puzzleSolved = true; break;
        }
        candidates = filterSimCandidates(candidates, guess, mask, target);
      }
      if (!puzzleSolved) break;
    }
    return { premiumScore, progressScore, solved, reachedPuzzle, premiumComplete: solved >= config.premiumPuzzles, hintsUsed, challengesUsed, matchedItems };
  }

  function percentile(sorted, fraction) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))];
  }

  function combinedSimulationSnapshot(parts, total, config) {
    const results = parts.flatMap((part) => part?.results || []);
    const diagnosticKeys = ['solverCalls','cacheHits','exactCalls','depth3Calls','depth2Calls','fallbackCalls','hintDecisions','challengeDecisions'];
    const diagnostics = Object.fromEntries(diagnosticKeys.map((key) => [key, parts.reduce((sum, part) => sum + Number(part?.diagnostics?.[key] || 0), 0)]));
    const average = (key) => results.length ? results.reduce((sum,item)=>sum+item[key],0)/results.length : 0;
    const solvedValues = results.map((item)=>item.solved).sort((a,b)=>a-b), meanSolved=average('solved');
    const variance=results.length>1?results.reduce((sum,item)=>sum+(item.solved-meanSolved)**2,0)/(results.length-1):0;
    const margin=1.96*Math.sqrt(variance/Math.max(1,results.length));
    const complete=results.filter((item)=>item.solved===config.puzzles).length,p=complete/Math.max(1,results.length),z=1.96,n=Math.max(1,results.length);
    const center=(p+z*z/(2*n))/(1+z*z/n),wm=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/(1+z*z/n);
    const finished=parts.length>0&&parts.every((part)=>['complete','cancelled','error'].includes(part?.type));
    const cancelled=parts.some((part)=>part?.type==='cancelled');
    const workers=parts.map((part,index)=>({index:index+1,status:part?.type||'ready',completed:part?.results?.length||0,current:part?.current||null}));
    return {type:finished?(cancelled?'cancelled':'complete'):'progress',completed:results.length,total,current:parts.find((part)=>part?.current&&part.type==='progress')?.current,workers,summary:{count:results.length,meanSolved,solvedLow:Math.max(0,meanSolved-margin),solvedHigh:Math.min(config.puzzles,meanSolved+margin),p10:percentile(solvedValues,.1),p50:percentile(solvedValues,.5),p90:percentile(solvedValues,.9),completion:p,completionLow:Math.max(0,center-wm),completionHigh:Math.min(1,center+wm),matchedItems:average('matchedItems'),hintsUsed:average('hintsUsed'),challengesUsed:average('challengesUsed'),distribution:Array.from({length:config.puzzles+1},(_,solved)=>({solved,count:results.filter((item)=>item.solved===solved).length})).filter((item)=>item.count),diagnostics,elapsed:(performance.now()-simulationStartedAt)/1000}};
  }

  function renderSimulationSnapshot(snapshot) {
    const { summary, current, completed = 0, total = 1, type } = snapshot;
    if (!summary) return;
    const ratio=Math.min(1,(completed+(current?Math.max(0,current.puzzle-1)/Math.max(1,state.config.puzzles):0))/Math.max(1,total));
    $('#simulationProgress').hidden=false;
    $('#simulationProgress span').style.width=`${ratio*100}%`;
    const runningText=current?`并行任务进行中 · 已完成 ${completed}/${total} · 当前第 ${current.puzzle} 题 · 候选 ${current.candidates.toLocaleString('zh-CN')} · 库存 ${current.hints}提示/${current.challenges}挑战`:`已完成 ${completed}/${total}`;
    $('#simulationProgress strong').textContent=type==='complete'?`已完成 ${completed}/${total}`:type==='cancelled'?`已停止，完成 ${completed}/${total}`:runningText;
    const d=summary.diagnostics,distribution=summary.distribution||[];
    $('#simulationResults').innerHTML=`<div class="simulation-live"><strong>${type==='complete'?'测试完成':type==='cancelled'?'测试已停止':'后台计算中'}</strong><span>已完成 ${summary.count} / ${total} 个活动</span>${current?`<small>正在进行：第 ${current.round} 个活动，第 ${current.puzzle} 题；本轮已用 ${current.hintsUsed} 提示、${current.challengesUsed} 挑战</small>`:''}</div><div class="result-grid"><article><span>实时平均解题数</span><strong>${summary.meanSolved.toFixed(2)} / ${state.config.puzzles}</strong><small>95%区间 ${summary.solvedLow.toFixed(2)}–${summary.solvedHigh.toFixed(2)} · P10 ${summary.p10} · P50 ${summary.p50} · P90 ${summary.p90}</small></article><article><span>实时全题完成率</span><strong>${formatPercent(summary.completion)}</strong><small>Wilson 95%区间 ${formatPercent(summary.completionLow)}–${formatPercent(summary.completionHigh)}</small></article><article><span>平均首次相符项</span><strong>${summary.matchedItems.toFixed(2)}</strong><small>只统计挑战首次猜中的项目</small></article><article><span>平均资源消耗</span><strong>${summary.challengesUsed.toFixed(2)} 挑战</strong><small>${summary.hintsUsed.toFixed(2)} 提示</small></article><article><span>求解层级</span><strong>深度3：${d.depth3Calls}</strong><small>精确 ${d.exactCalls} · 深度2 ${d.depth2Calls} · 降级 ${d.fallbackCalls}</small></article><article><span>运行统计</span><strong>${summary.elapsed.toFixed(1)} 秒</strong><small>${d.solverCalls} 次求解 · ${d.cacheHits} 次缓存 · ${d.hintDecisions} 次提示</small></article></div><div class="histogram">${distribution.map(item=>`<div><span>解出${item.solved}题</span><i><b style="width:${item.count/Math.max(1,summary.count)*100}%"></b></i><strong>${item.count}</strong></div>`).join('')}</div><p class="simulation-disclaimer">测试在独立后台线程运行，关闭窗口不会中断；重新打开“规模测试”可查看最新进度。每一步使用与实操相同的策略树，结果评估当前策略，但不构成全局最优证明。</p>`;
  }

  function renderSimulationWorkers(snapshot) {
    if (snapshot.workers?.length) {
      const cards = snapshot.workers.map((item) => {
        const currentState = item.current;
        const status = item.status === 'complete' ? '已完成' : item.status === 'error' ? '失败' : currentState ? `第 ${currentState.puzzle} 题 · 候选 ${currentState.candidates.toLocaleString('zh-CN')} · ${currentState.hints}提示/${currentState.challenges}挑战` : '准备中';
        return `<article><b>并行 ${item.index}</b><span>${status}</span><small>已完成 ${item.completed} 个活动${currentState ? ` · 本轮已用 ${currentState.hintsUsed}提示/${currentState.challengesUsed}挑战` : ''}</small></article>`;
      }).join('');
      $('#simulationResults .simulation-live').insertAdjacentHTML('afterend', `<div class="simulation-workers">${cards}</div>`);
    }
  }

  function runSimulation() {
    if (simulationRunning) { simulationWorkers.forEach(({worker})=>worker.postMessage({type:'cancel'})); $('#runSimulationBtn').textContent='正在停止…'; return; }
    const rounds = clampInt($('#simulationRounds').value, 1, 500, 50);
    const pool = $('#simulationPool').value;
    const config = normalizeConfig(state.config);
    const hardwareCap = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4));
    const parallel = Math.min(rounds, hardwareCap, clampInt($('#simulationParallel').value, 1, 8, 4));
    simulationRunning = true;
    simulationStartedAt = performance.now();
    $('#runSimulationBtn').textContent = '停止后台测试';
    $('#simulationProgress').hidden = false;
    $('#simulationResults').innerHTML = '';
    if (!window.SIMULATION_WORKER_SOURCE) {
      simulationRunning=false;
      $('#runSimulationBtn').textContent='重新开始';
      $('#simulationResults').innerHTML='<div class="empty-inline">后台线程资源没有加载，请重新解压完整程序后再试。</div>';
      return;
    }
    simulationWorkerUrl=URL.createObjectURL(new Blob([window.SIMULATION_WORKER_SOURCE],{type:'text/javascript'}));
    const compactCards=CARDS.map(({b,a,r,n,nm,atk,def,wm,wa})=>({b,a,r,n,nm,atk,def,wm,wa}));
    const parts=Array.from({length:parallel},()=>null);
    simulationWorkers=Array.from({length:parallel},(_,index)=>{
      const worker=new Worker(simulationWorkerUrl);
      const workerRounds=Math.floor(rounds/parallel)+(index<rounds%parallel?1:0);
      worker.onmessage=({data})=>{
        parts[index]=data;
        const combined=combinedSimulationSnapshot(parts,rounds,config);
        simulationSnapshot=combined;renderSimulationSnapshot(combined);renderSimulationWorkers(combined);
        if(parts.every((part)=>part&&['complete','cancelled','error'].includes(part.type))){
          simulationRunning=false;$('#runSimulationBtn').textContent='重新开始';simulationWorkers.forEach((item)=>item.worker.terminate());simulationWorkers=[];URL.revokeObjectURL(simulationWorkerUrl);simulationWorkerUrl=null;
          const failure=parts.find((part)=>part.type==='error');if(failure)toast(`部分并行任务失败：${failure.message}`);
        }
      };
      worker.onerror=(event)=>{parts[index]={type:'error',results:parts[index]?.results||[],diagnostics:parts[index]?.diagnostics||{},message:event.message};worker.terminate();};
      worker.postMessage({type:'start',cards:compactCards,config,pool,rounds:workerRounds});
      return {worker,rounds:workerRounds};
    });
  }

  function bindEvents() {
    $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
    $('#revealField').addEventListener('change', populateRevealValues);
    $('#addRevealBtn').addEventListener('click', addReveal);
    $('#randomHintBtn').addEventListener('click', randomHint);
    $('#cardSearch').addEventListener('input', showSearchResults);
    $('#searchResults').addEventListener('click', (event) => {
      const button = event.target.closest('[data-card-index]');
      if (button) selectGuess(Number(button.dataset.cardIndex));
    });
    $('#clearSelectedCard').addEventListener('click', clearGuess);
    $('#copySelectedCard').addEventListener('click', () => copyCardName(CARDS[Number($('#copySelectedCard').dataset.cardIndex)]));
    $('#evaluateChallengeBtn').addEventListener('click', calculateSelectedChallenge);
    $('#compareSelectedCardBtn').addEventListener('click', () => {
      if (selectedGuess == null) { toast('请先选择一张挑战卡。'); return; }
      openChallengeComparison([selectedGuess]);
    });
    $('#feedbackGrid').addEventListener('click', (event) => {
      const button = event.target.closest('[data-feedback-bit]');
      if (!button) return;
      const bit = Number(button.dataset.feedbackBit);
      feedbackMask ^= bit;
      if (bit === 1) borderRevealValue = null;
      renderFeedback();
    });
    $('#borderRevealChoices').addEventListener('click', (event) => { const button=event.target.closest('[data-border-reveal]'); if(!button)return; borderRevealValue=Number(button.dataset.borderReveal); populateBorderRevealChoices(); });
    $('#recordChallengeBtn').addEventListener('click', beginChallenge);
    $('#feedbackForm').addEventListener('submit', (event) => { event.preventDefault(); recordChallenge(); });
    $('#feedbackCloseBtn').addEventListener('click', () => $('#feedbackDialog').close());
    $('#feedbackCancelBtn').addEventListener('click', () => $('#feedbackDialog').close());
    $('#calculateBtn').addEventListener('click', calculateRecommendations);
    $('#solverAlgorithm').addEventListener('change', () => { renderAlgorithmControls(); clearRecommendation(); });
    $('#resourceRollouts').addEventListener('change', () => { localStorage.setItem('card-decoder-resource-rollouts', $('#resourceRollouts').value); clearRecommendation(); });
    $('#enhancedSearchToggle').addEventListener('change', () => { clearRecommendation(); toast($('#enhancedSearchToggle').checked ? '已启用实验性增强搜索；下一次计算会更慢，稳定策略与规模测试不受影响。' : '已恢复稳定搜索逻辑。'); });
    $('#strategyExperimentBtn').addEventListener('click', openStrategyExperiment);
    $('#strategyExperimentCloseBtn').addEventListener('click', () => $('#strategyExperimentDialog').close());
    $('#runStrategyExperimentBtn').addEventListener('click', runStrategyExperiment);
    $('#cancelStrategyExperimentBtn').addEventListener('click', () => stopStrategyExperiment());
    $('#addExperimentGroupBtn').addEventListener('click', () => { strategyExperimentRows=readExperimentGroups(); strategyExperimentRows.push({name:`实验${strategyExperimentRows.length+1}`,depth:4,budget:200000}); renderExperimentGroups(); });
    $('#experimentGroups').addEventListener('click',(event)=>{const button=event.target.closest('[data-remove-experiment]');if(!button)return;strategyExperimentRows=readExperimentGroups().filter((_,index)=>index!==Number(button.dataset.removeExperiment));renderExperimentGroups();});
    $('#compareRecommendationsBtn').addEventListener('click', () => {
      const seeds = lastRecommendations.slice(0, 4).map((item) => item.index);
      if (!seeds.length && selectedGuess == null) { toast('请先计算推荐，或在挑战区选择一张卡。'); return; }
      openChallengeComparison(seeds.length ? seeds : [selectedGuess]);
    });
    $('#recommendMode').addEventListener('change', () => { renderModeGuide(); clearRecommendation(); calculateRecommendations(); });
    $('#recommendTitle').addEventListener('click', () => {
      const index = Number($('#recommendTitle').dataset.cardIndex);
      if (!Number.isInteger(index)) return;
      switchTab('challenge'); selectGuess(index); window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    $('#copyRecommendCard').addEventListener('click', () => copyCardName(CARDS[Number($('#copyRecommendCard').dataset.cardIndex)]));
    $('#candidateTable').addEventListener('click', (event) => { const button=event.target.closest('[data-group-index]'); if(button)openGroupDialog(button.dataset.groupIndex); });
    $('#groupDialogClose').addEventListener('click',()=>$('#groupDialog').close());
    $('#groupDialogDone').addEventListener('click',()=>$('#groupDialog').close());
    $('#groupDialogList').addEventListener('click',(event)=>{const button=event.target.closest('[data-copy-group-name]');if(!button)return;navigator.clipboard.writeText(button.dataset.copyGroupName).then(()=>toast(`已复制卡名：${button.dataset.copyGroupName}`)).catch(()=>toast('复制失败。'));});
    $('#faqBtn').addEventListener('click',()=>$('#faqDialog').showModal());
    $('#faqCloseBtn').addEventListener('click',()=>$('#faqDialog').close());
    $('#faqDoneBtn').addEventListener('click',()=>$('#faqDialog').close());
    $('#changelogBtn').addEventListener('click',()=>$('#changelogDialog').showModal());
    $('#changelogCloseBtn').addEventListener('click',()=>$('#changelogDialog').close());
    $('#changelogDoneBtn').addEventListener('click',()=>$('#changelogDialog').close());
    $('#alternatives').addEventListener('click', (event) => {
      const button = event.target.closest('[data-recommend-index]');
      if (!button) return;
      switchTab('challenge');
      selectGuess(Number(button.dataset.recommendIndex));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    [['puzzleNumber', 'puzzle'], ['hintStock', 'hints'], ['challengeStock', 'challenges']].forEach(([id, key]) => {
      $(`#${id}`).addEventListener('change', (event) => {
        const value = Math.max(Number(event.target.min || 0), Number(event.target.value) || 0);
        pushUndo(); state[key] = Math.min(Number(event.target.max || Infinity), value); render();
      });
    });
    $('#poolMode').addEventListener('change', (event) => {
      pushUndo(); state.pool = event.target.value; render();
    });
    $('#candidateSearch').addEventListener('input', renderCandidates);
    $('#candidateKnownOnly').addEventListener('change', renderCandidates);
    $('.database-filters').addEventListener('change',(event)=>{if(event.target.matches('input[type="checkbox"]')){updateFilterCounts();renderCandidates();}});
    $('.database-filters').addEventListener('input',(event)=>{if(!event.target.matches('.filter-picker input[type="search"]'))return;const query=normalizeSearch(event.target.value);event.target.closest('.filter-picker').querySelectorAll('[data-filter-label]').forEach((label)=>{label.hidden=query&&!label.dataset.filterLabel.includes(query);});});
    $('#candidateSort').addEventListener('change', renderCandidates);
    $('#candidateTableView').addEventListener('click',()=>{$('#candidateTable').dataset.view='table';$('#candidateTableView').classList.add('is-active');$('#candidateGridView').classList.remove('is-active');renderCandidates();});
    $('#candidateGridView').addEventListener('click',()=>{$('#candidateTable').dataset.view='grid';$('#candidateGridView').classList.add('is-active');$('#candidateTableView').classList.remove('is-active');renderCandidates();});
    $('#clearDbFilters').addEventListener('click',()=>{$('#candidateSearch').value='';$('.database-filters').querySelectorAll('input[type="checkbox"]').forEach((input)=>{input.checked=false;});$('.database-filters').querySelectorAll('input[type="search"]').forEach((input)=>{input.value='';});updateFilterCounts();renderCandidates();});
    $('#openHistoryBtn').addEventListener('click', openHistoryArchive);
    $('#historyCloseBtn').addEventListener('click', () => $('#historyDialog').close());
    $('#historyDoneBtn').addEventListener('click', () => $('#historyDialog').close());
    $('#exportActivityBtn').addEventListener('click', exportActivity);
    $('#importActivityBtn').addEventListener('click', () => { $('#activityImportText').value=''; $('#importDialog').showModal(); });
    $('#importCloseBtn').addEventListener('click',()=>$('#importDialog').close());
    $('#importCancelBtn').addEventListener('click',()=>$('#importDialog').close());
    $('#activityImportFile').addEventListener('change',async(event)=>{const file=event.target.files?.[0];if(!file)return;try{$('#activityImportText').value=await file.text();toast(`已读取 ${file.name}，请点击“检查并导入”。`);}catch{toast('无法读取这个记录文件。');}});
    $('#importForm').addEventListener('submit',(event)=>{event.preventDefault();importActivity();});
    $('#clearArchiveBtn').addEventListener('click', () => {
      if (!confirm('清除当前窗口中保存的旧活动档案？当前活动记录仍会保留。')) return;
      sessionStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(state.activityHistory || []));
      openHistoryArchive();
    });
    $('#themeSelect').addEventListener('change', (event) => {
      state.theme = event.target.value;
      localStorage.setItem('card-decoder-theme', state.theme);
      render();
    });
    $('#imageQualitySelect').addEventListener('change', (event) => {
      state.imageQuality = ['high', 'zh'].includes(event.target.value) ? event.target.value : 'high';
      localStorage.setItem('card-decoder-image-quality', state.imageQuality);
      saveState();
      refreshImageQuality();
      const message = state.imageQuality === 'zh'
        ? '已切换到中文高清卡图；缺少中文版时会使用英文高清图。'
        : '已切换到英文高清卡图。';
      toast(message);
    });
    $('#undoBtn').addEventListener('click', () => {
      if (!undoStack.length) return;
      state = undoStack.pop(); syncCurrentActivityHistory(); render(); toast('已撤销上一步。');
    });
    $('#resetPuzzleBtn').addEventListener('click', () => {
      if (!confirm('重置本题会移除本题线索、挑战记录和本题得分，是否继续？')) return;
      pushUndo();
      state.totalScore = Math.max(0, state.totalScore - state.puzzleScore);
      if (isPremiumPuzzle()) state.premiumScore = Math.max(0, state.premiumScore - state.puzzleScore);
      else state.progressScore = Math.max(0, state.progressScore - state.puzzleScore);
      state.activityHistory = (state.activityHistory || []).filter((item) => item.puzzle !== state.puzzle || item.activityId !== state.activityId);
      resetPuzzle(false);
      syncCurrentActivityHistory();
      if (testSession) seedTestInitialReveal(testSession.initialField || 'random');
      render();
    });
    $('#resetEventBtn').addEventListener('click', () => {
      if (!confirm(`确定清除整个 ${state.config.puzzles} 题活动的本地记录吗？`)) return;
      pushUndo();
      removeActivityFromSession(state.activityId);
      const presetId = state.presetId;
      state = freshState(state.config);
      state.presetId = presetId;
      render();
    });
    $('#nextPuzzleBtn').addEventListener('click', () => {
      if (state.puzzle >= state.config.puzzles) { $('#solvedBanner').hidden = true; toast(`活动完成：高价值 ${state.premiumScore}，后段匹配 ${state.progressScore}。`); return; }
      pushUndo(); state.puzzle += 1; resetPuzzle(true);
      if (testSession) { testSession.targetIndex = randomWeightedIndex(state.pool); testSession.revealed = false; seedTestInitialReveal(testSession.initialField || 'random'); }
      render();
    });
    $('#settingsBtn').addEventListener('click', openSettings);
    $('#activityDataBtn').addEventListener('click',()=>$('#activityDataDialog').showModal());
    $('#activityDataCloseBtn').addEventListener('click',()=>$('#activityDataDialog').close());
    $('#prominentExportBtn').addEventListener('click',exportActivity);
    $('#prominentImportBtn').addEventListener('click',()=>{$('#activityDataDialog').close();$('#activityImportText').value='';$('#importDialog').showModal();});
    $('#manualImportBtn').addEventListener('click',()=>{manualImportLines=[];$('#manualField').innerHTML=FIELDS.map((field)=>`<option value="${field.key}">${field.label}</option>`).join('');$('#manualPuzzle').max=state.config.puzzles;populateManualValue();renderManualImport();$('#manualImportDialog').showModal();});
    $('#manualImportCloseBtn').addEventListener('click',()=>$('#manualImportDialog').close());
    $('#manualImportCancelBtn').addEventListener('click',()=>$('#manualImportDialog').close());
    $('#manualAction').addEventListener('change',renderManualImport);
    $('#manualField').addEventListener('change',populateManualValue);
    $('#manualMatchFields').addEventListener('change',updateManualChallengeSpecials);
    $('#manualCardName').addEventListener('change',updateManualChallengeSpecials);
    $('#manualAddBtn').addEventListener('click',addManualRecord);
    $('#manualRecordList').addEventListener('click',(event)=>{const button=event.target.closest('[data-remove-manual]');if(!button)return;manualImportLines.splice(Number(button.dataset.removeManual),1);renderManualImport();});
    $('#manualImportForm').addEventListener('submit',(event)=>{event.preventDefault();applyManualRecords();});
    $('#settingsCloseBtn').addEventListener('click', () => $('#settingsDialog').close());
    $('#settingsCancelBtn').addEventListener('click', () => $('#settingsDialog').close());
    $('#presetSelect').addEventListener('change', () => {
      const preset = allPresets().find((item) => item.id === $('#presetSelect').value);
      if (preset) fillSettingsForm(preset.config);
    });
    $('#addMilestoneBtn').addEventListener('click', () => addMilestoneRow());
    $('#milestoneRows').addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-milestone]');
      if (button) button.closest('.milestone-row').remove();
    });
    $('#savePresetBtn').addEventListener('click', saveCustomPreset);
    $('#settingsForm').addEventListener('submit', (event) => { event.preventDefault(); applySettings(); });
    $('#testModeBtn').addEventListener('click', startTestMode);
    $('#gameModeBtn').addEventListener('click', startGameMode);
    $('#testSetupCloseBtn').addEventListener('click', () => $('#testSetupDialog').close());
    $('#testSetupCancelBtn').addEventListener('click', () => $('#testSetupDialog').close());
    $('#testTargetMode').addEventListener('change', () => { if ($('#testTargetMode').value === 'random') pendingTestTarget = null; renderTestTargetPicker(); });
    $('#testTargetSearch').addEventListener('input', () => { pendingTestTarget = null; renderTestTargetPicker(); showTestTargetResults(); });
    $('#testTargetResults').addEventListener('click', (event) => {
      const button = event.target.closest('[data-test-target-index]');
      if (!button) return;
      pendingTestTarget = Number(button.dataset.testTargetIndex);
      $('#testTargetSearch').value = CARDS[pendingTestTarget].name;
      $('#testTargetResults').innerHTML = '';
      renderTestTargetPicker();
    });
    $('#testSetupForm').addEventListener('submit', (event) => { event.preventDefault(); try { applyTestSetup(); } catch (error) { toast(error.message); } });
    $('#challengeCompareCloseBtn').addEventListener('click', () => $('#challengeCompareDialog').close());
    $('#challengeCompareDoneBtn').addEventListener('click', () => $('#challengeCompareDialog').close());
    $('#clearComparisonBtn').addEventListener('click', () => { comparisonCalculationToken += 1; comparisonIndices = []; comparisonStrategyResults = new Map(); $('#comparisonProgress').hidden = true; $('#runStrategyComparisonBtn').disabled = false; renderComparisonList(); });
    $('#runStrategyComparisonBtn').addEventListener('click', runStrategyComparison);
    $('#compareCardSearch').addEventListener('input', showComparisonSearchResults);
    $('#compareCardResults').addEventListener('click', (event) => {
      const button = event.target.closest('[data-compare-card-index]');
      if (!button) return;
      addComparisonCard(Number(button.dataset.compareCardIndex));
      $('#compareCardSearch').value = '';
      $('#compareCardResults').hidden = true;
      runStrategyComparison();
    });
    $('#comparisonList').addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-comparison]');
      if (!button) return;
      comparisonCalculationToken += 1;
      const removed = Number(button.dataset.removeComparison);
      comparisonIndices = comparisonIndices.filter((index) => index !== removed);
      comparisonStrategyResults.delete(removed);
      $('#comparisonProgress').hidden = true;
      $('#runStrategyComparisonBtn').disabled = false;
      renderComparisonList();
    });
    $('#newTestTargetBtn').addEventListener('click', newTestTarget);
    $('#exitTestBtn').addEventListener('click', exitTestMode);
    $('#revealTargetBtn').addEventListener('click', revealSessionTarget);
    $('#autoJudgeBtn').addEventListener('click', autoJudgeChallenge);
    $('#simulationBtn').addEventListener('click', openSimulation);
    $('#simulationCloseBtn').addEventListener('click', () => $('#simulationDialog').close());
    $('#simulationCancelBtn').addEventListener('click', () => $('#simulationDialog').close());
    $('#simulationForm').addEventListener('submit', (event) => { event.preventDefault(); runSimulation(); });
    $('#imageViewerClose').addEventListener('click', () => $('#imageViewerDialog').close());
    $('#imageViewerDialog').addEventListener('click', (event) => {
      if (event.target === $('#imageViewerDialog')) $('#imageViewerDialog').close();
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.search-block')) $('#searchResults').hidden = true;
      const image = event.target.closest('img[data-zoomable="true"]');
      if (image && !image.closest('#imageViewerDialog')) openImageViewer(image);
    });
  }

  function resetPuzzle(keepScore) {
    if (!keepScore) state.puzzleScore = 0;
    else state.puzzleScore = 0;
    state.known = {};
    state.matchedMask = 0;
    state.logs = [];
    state.initialUsed = false;
    state.solved = false;
    clearGuess();
  }

  function solverSummary() {
    return {
      puzzle: state.puzzle,
      hints: state.hints,
      challenges: state.challenges,
      totalScore: state.totalScore,
      premiumScore: state.premiumScore,
      progressScore: state.progressScore,
      premiumPuzzle: isPremiumPuzzle(),
      puzzleScore: state.puzzleScore,
      matchedFields: popcount(state.matchedMask),
      solved: state.solved,
      candidateCards: candidateMass(),
      candidateGroups: candidateCache.length,
      known: Object.fromEntries(Object.entries(state.known).map(([key, entry]) => [key, formatValue(key, entry.value)])),
    };
  }

  function recommendationSummary() {
    const best = lastRecommendations[0];
    if (!best) return null;
    return {
      action: lastAdvice?.recommendHint ? 'use_hint' : 'challenge',
      card: CARDS[best.index].name,
      expectedImmediatePoints: Number(best.points.toFixed(3)),
      solveProbability: Number(best.solve.toFixed(6)),
      informationBits: Number(best.info.toFixed(3)),
      hintInformationBits: lastAdvice ? Number(lastAdvice.entropy.toFixed(3)) : null,
    };
  }

  function registerWebMcpTools() {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const register = (tool) => Promise.resolve(context.registerTool(tool)).catch(() => {});
    void register({
      name: 'read_solver_state',
      title: '读取求解器状态',
      description: '读取当前题号、资源、得分、已知字段和候选数量，不修改页面状态。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute() { return solverSummary(); },
    });
    void register({
      name: 'add_revealed_clue',
      title: '录入揭示字段',
      description: '把游戏中的初始揭示或提示结果录入当前题，并同步更新可见候选集。value 使用卡库中的数字编码。',
      inputSchema: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: FIELDS.map((field) => field.key) },
          value: { type: 'number' },
          source: { type: 'string', enum: ['initial', 'hint'] },
        },
        required: ['field', 'value', 'source'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) { return applyReveal(input.field, input.value, input.source); },
    });
    void register({
      name: 'calculate_best_challenge',
      title: '计算最佳挑战',
      description: '按当前可见状态运行推荐算法，并返回建议先提示还是挑战，以及最佳挑战卡和期望指标。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      async execute() {
        const result = await calculateRecommendations();
        if (!result) throw new Error('当前状态无法计算推荐。');
        return result;
      },
    });
  }

  $('#solverAlgorithm').value = localStorage.getItem('card-decoder-algorithm') === 'resource' ? 'resource' : 'stable';
  $('#resourceRollouts').value = ['2','4','8'].includes(localStorage.getItem('card-decoder-resource-rollouts')) ? localStorage.getItem('card-decoder-resource-rollouts') : '4';
  bindEvents();
  renderAlgorithmControls();
  render();
  startWallpaperCycle();
  registerWebMcpTools();
})();
