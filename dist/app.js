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
  let lastRecommendations = [];
  let lastAdvice = null;
  let lastProof = null;
  let calculationToken = 0;
  let toastTimer = null;
  let testSession = null;
  let simulationRunning = false;
  let simulationWorker = null;
  let simulationWorkerUrl = null;
  let simulationSnapshot = null;
  let wallpaperTimer = null;

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
    const high = `card-images-high/${id}.jpg`;
    const chinese = `card-images-zh/${id}.webp`;
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

  function matchMask(target, guess) {
    let mask = 0;
    if (target.b & guess.b) mask |= 1;
    if (target.a === guess.a) mask |= 2;
    if (target.r === guess.r) mask |= 4;
    if (target.nm & guess.nm) mask |= 8;
    if (target.atk === guess.atk) mask |= 16;
    if (target.def === guess.def) mask |= 32;
    return mask;
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
    $('#candidateCount').textContent = candidateMass().toLocaleString('zh-CN');
    $('#candidateMass').textContent = `${candidateCache.length.toLocaleString('zh-CN')} 个字段组`;
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
    $('#fieldGrid').innerHTML = FIELDS.map((field) => {
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
    if (visible) setCardImage($('#testTargetImage'), target, true, 'card-back.gif');
    else {
      const image = $('#testTargetImage');
      image.hidden = false;
      image.src = 'card-back.gif';
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
    const total = candidateMass();
    if (!candidateCache.length) {
      container.innerHTML = `<div class="empty-inline">当前反馈在此卡池中没有候选。可检查录入，或切换到“完整官方怪兽兜底”。</div>`;
      return;
    }
    refreshCandidateFilterValues();
    const query = normalizeSearch($('#candidateSearch').value || '');
    const filterField = $('#candidateFilterField').value;
    const filterValue = $('#candidateFilterValue').value;
    const sort = $('#candidateSort').value;
    const filtered = candidateCache.filter((index) => {
      const card = CARDS[index];
      if (query && !card.names.some((name) => normalizeSearch(name).includes(query))) return false;
      if (filterField !== 'all' && filterValue !== '' && fieldValue(card, filterField) !== Number(filterValue)) return false;
      return true;
    });
    const comparators = {
      probability: (left, right) => weightOf(CARDS[right]) - weightOf(CARDS[left]) || CARDS[left].name.localeCompare(CARDS[right].name, 'zh-CN'),
      name: (left, right) => CARDS[left].name.localeCompare(CARDS[right].name, 'zh-CN'),
      numberAsc: (left, right) => CARDS[left].n - CARDS[right].n || CARDS[left].name.localeCompare(CARDS[right].name, 'zh-CN'),
      attackDesc: (left, right) => CARDS[right].atk - CARDS[left].atk || CARDS[left].name.localeCompare(CARDS[right].name, 'zh-CN'),
      defenseDesc: (left, right) => CARDS[right].def - CARDS[left].def || CARDS[left].name.localeCompare(CARDS[right].name, 'zh-CN'),
    };
    const top = [...filtered].sort(comparators[sort] || comparators.probability).slice(0, 100);
    $('#candidateMass').textContent = filtered.length === candidateCache.length ? `${candidateCache.length.toLocaleString('zh-CN')} 个字段组` : `显示 ${filtered.length.toLocaleString('zh-CN')} / ${candidateCache.length.toLocaleString('zh-CN')}`;
    if (!top.length) { container.innerHTML = `<div class="empty-inline">没有符合当前搜索或筛选条件的候选卡。</div>`; return; }
    container.innerHTML = `<div class="candidate-row header"><span>代表卡</span><span>边框</span><span>属性</span><span>种族</span><span>数值</span><span>攻／守</span><span>概率</span></div>` + top.map((index) => {
      const card = CARDS[index];
      const probability = total ? weightOf(card) / total : 0;
      return `<div class="candidate-row"><strong title="${escapeAttr(card.names.join('、'))}">${escapeHtml(card.name)}</strong><span>${escapeHtml(formatBorder(card.b))}</span><span>${escapeHtml(DATA.labels.attribute[card.a] || card.a)}</span><span>${escapeHtml(DATA.labels.race[card.r] || card.r)}</span><span>${card.n}</span><span>${formatStat(card.atk)}／${formatStat(card.def)}</span><span class="prob">${formatPercent(probability)}</span></div>`;
    }).join('');
  }

  function refreshCandidateFilterValues() {
    const field = $('#candidateFilterField').value;
    const select = $('#candidateFilterValue');
    const previous = select.value;
    if (field === 'all') {
      select.innerHTML = '<option value="">全部值</option>';
      select.disabled = true;
      return;
    }
    const values = [...new Set(candidateCache.map((index) => fieldValue(CARDS[index], field)))].sort((left, right) => {
      if (['number', 'attack', 'defense'].includes(field)) return Number(left) - Number(right);
      return formatValue(field, left).localeCompare(formatValue(field, right), 'zh-CN');
    });
    select.disabled = false;
    select.innerHTML = '<option value="">全部值</option>' + values.map((value) => `<option value="${value}">${escapeHtml(formatValue(field, value))}</option>`).join('');
    if (values.some((value) => String(value) === previous)) select.value = previous;
  }

  function historyItemHtml(log, expanded = false) {
    const puzzle = log.puzzle || state.puzzle;
    if (log.type === 'reveal') {
      const field = FIELDS.find((item) => item.key === log.field) || FIELDS[0];
      return `<article class="history-item history-reveal"><div class="history-symbol" data-field="${field.key}">${field.icon}</div><div><header><strong>第${puzzle}题 · ${sourceLabel(log.source)}</strong><time>${log.time || ''}</time></header><p>${field.label}：<b>${escapeHtml(formatValue(log.field, log.value))}</b></p>${expanded ? `<small>揭示用于筛选候选，不累计挑战奖励${log.candidates != null ? ` · 当时约 ${Number(log.candidates).toLocaleString('zh-CN')} 张候选` : ''}</small>` : ''}</div></article>`;
    }
    const guess = CARDS[log.guess];
    const matchedFields = FIELDS.filter((field) => log.mask & field.bit);
    const matched = matchedFields.map((field) => field.label).join('、') || '无相符项';
    return `<article class="history-item history-challenge">${guess ? `<img data-card-index="${log.guess}" alt="${escapeAttr(guess.name)}卡图">` : '<div class="history-symbol">?</div>'}<div><header><strong>第${puzzle}题 · ${escapeHtml(guess?.name || '未知卡')}</strong><time>${log.time || ''}</time></header><p>${matched}${log.delta ? ` · <b>+${log.delta}</b>` : ''}</p><div class="history-match-chips">${matchedFields.map((field) => `<span>${field.icon} ${escapeHtml(field.label)}</span>`).join('') || '<span>0项相符</span>'}</div>${expanded && log.candidates != null ? `<small>操作前约 ${Number(log.candidates).toLocaleString('zh-CN')} 张候选</small>` : ''}</div></article>`;
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
    lastAdvice = null;
    $('#recommendationCard').classList.add('empty-state');
    $('#recommendTitle').textContent = state.known && Object.keys(state.known).length ? '等待计算' : '录入初始揭示';
    $('#recommendTitle').disabled = true;
    $('#recommendTitle').dataset.cardIndex = '';
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
    $('#selectedCardFacts').innerHTML = FIELDS.map((field) => `<div><span>${escapeHtml(field.label)}</span><strong>${escapeHtml(formatValue(field.key, fieldValue(card, field.key)))}</strong></div>`).join('');
    setCardImage($('#selectedCardImage'), card);
    renderTestMode();
  }

  function clearGuess() {
    selectedGuess = null;
    feedbackMask = 0;
    $('#cardSearch').value = '';
    $('#selectedCard').hidden = true;
    $('#selectedCardImage').hidden = true;
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
    $('#specialReveals').hidden = !(borderOn || numberOn);
    $('#borderRevealWrap').hidden = !borderOn;
    $('#numberRevealWrap').hidden = !numberOn;
    if (borderOn) populateSpecialReveal('border');
    if (numberOn) populateSpecialReveal('number');
  }

  function populateSpecialReveal(field) {
    const guess = CARDS[selectedGuess];
    const values = new Set();
    for (const index of candidateCache) {
      const target = CARDS[index];
      const matches = field === 'border' ? Boolean(target.b & guess.b) : Boolean(target.nm & guess.nm);
      if (matches) values.add(field === 'border' ? target.b : target.n);
    }
    const select = field === 'border' ? $('#borderReveal') : $('#numberReveal');
    const currentKnown = state.known[field]?.value;
    select.innerHTML = [...values].sort((a, b) => a - b).map((value) => `<option value="${value}">${escapeHtml(formatValue(field, value))}</option>`).join('');
    if (currentKnown != null && values.has(Number(currentKnown))) select.value = String(currentKnown);
    else {
      const guessed = field === 'border' ? guess.b : guess.n;
      if (values.has(guessed)) select.value = String(guessed);
    }
  }

  function beginChallenge() {
    if (selectedGuess == null) { toast('请先选择挑战卡。'); return; }
    if (state.challenges <= 0) { toast('挑战库存不足。'); return; }
    if (testSession) { autoJudgeChallenge(); return; }
    feedbackMask = 0;
    renderFeedback();
    $('#feedbackDialog').showModal();
  }

  function recordChallenge() {
    if (selectedGuess == null) { toast('请先选择挑战卡。'); return; }
    if (state.challenges <= 0) { toast('挑战库存不足。'); return; }
    if (state.logs.some((log) => log.type === 'challenge' && log.guess === selectedGuess)) { toast('同题重复挑战这张卡不会扣次数，也不会留下记录。'); return; }
    const borderReveal = feedbackMask & 1 ? Number($('#borderReveal').value) : null;
    const numberReveal = feedbackMask & 8 ? Number($('#numberReveal').value) : null;
    if ((feedbackMask & 1) && Number.isNaN(borderReveal)) { toast('请录入目标显示的完整边框。'); return; }
    if ((feedbackMask & 8) && Number.isNaN(numberReveal)) { toast('请录入目标显示的等级／阶级／连接值。'); return; }
    const trial = clone(state);
    trial.logs.push({ type: 'challenge', guess: selectedGuess, mask: feedbackMask, borderReveal, numberReveal });
    if (!candidateIndices(trial).length) { toast('这组反馈与当前卡池冲突，请检查勾选，或切换完整卡池。'); return; }

    pushUndo();
    const guess = CARDS[selectedGuess];
    const newMask = state.matchedMask | feedbackMask;
    let delta = thresholdGain(state.matchedMask, newMask);
    const solvedNow = feedbackMask === 63;
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
    const log = { type: 'challenge', guess: selectedGuess, mask: feedbackMask, borderReveal, numberReveal, delta, time: timeLabel() };
    state.logs.push(log);
    appendHistory(log);
    if ($('#feedbackDialog').open) $('#feedbackDialog').close();
    clearGuess();
    render();
    toast(solvedNow ? `本题完成，获得 ${delta} 分。` : delta ? `记录成功，本次获得 ${delta} 分。` : '记录成功，候选集已更新。');
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
        const newMask = oldMask | mask;
        let gain = thresholdGain(oldMask, newMask);
        if (mask === 63) { gain += solveReward(); solveMass += weight; }
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
    const exactDecision = mode === 'balanced' ? tryExactBellman(candidates, alreadyGuessed) : null;
    const restrictedDecision = mode === 'balanced' && !exactDecision ? tryRestrictedPolicy(candidates, alreadyGuessed, quick) : null;
    const policyDecision = exactDecision || restrictedDecision;
    lastProof = exactDecision || restrictedDecision || (mode === 'balanced' ? boundedCertificate(quick) : null);
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
    lastRecommendations = finalists.slice(0, 6);
    if (token !== calculationToken) return;
    const advice = policyDecision
      ? { use: policyDecision.action.type === 'hint', entropy: expectedHintEntropy(candidates, total), strict: true, proven: Boolean(policyDecision.proven), method: policyDecision.method, value: policyDecision.value, expandedStates: policyDecision.expandedStates, depth: policyDecision.depth }
      : hintAdvice(candidates, total, lastRecommendations[0], mode);
    if (policyDecision?.action?.type === 'challenge') {
      const candidateSet = new Set(candidates);
      const tiedCandidates = [...new Set((policyDecision.optimalActions || []).filter((action) => action.type === 'challenge' && candidateSet.has(action.index)).map((action) => action.index))];
      if (tiedCandidates.length > 1) advice.equivalentChoices = tiedCandidates;
    }
    if (restrictedDecision) advice.reason = `提示与挑战已进入同一棵深度 ${restrictedDecision.depth} 的自适应策略树，并在完全猜中分支计入剩余题目的资源续值。已展开 ${restrictedDecision.expandedStates.toLocaleString('zh-CN')} 个状态；这是跨题近似值，尚未证明全局最优。`;
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
        return `${mask}:${mask & 1 ? target.b : ''}:${mask & 8 ? target.n : ''}`;
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

  function tryRestrictedPolicy(candidates, alreadyGuessed, quick) {
    if (!window.DecoderSolver?.solveRestrictedHorizon || !quick.length) return null;
    const selected = new Set();
    quick.slice(0, 18).forEach((item) => selected.add(item.index));
    [...quick].sort((a, b) => b.infoApprox - a.infoApprox).slice(0, 8).forEach((item) => selected.add(item.index));
    [...candidates].sort((a, b) => weightOf(CARDS[b]) - weightOf(CARDS[a])).slice(0, 8).forEach((index) => selected.add(index));
    const knownMask = FIELDS.reduce((mask, field) => mask | (state.known[field.key] ? field.bit : 0), 0);
    const base = { cards: CARDS, weights: CARDS.map((card) => weightOf(card)), actions: [...selected],
      hints: state.hints, challenges: state.challenges, candidates, knownMask, matchedMask: state.matchedMask,
      guessed: [...alreadyGuessed], maxStates: 24000, remainingPuzzles: state.config.puzzles - state.puzzle + 1,
      resourceModel: { hintChallengeRatio: .61, equivalentCostPerSolve: 3.9 } };
    for (const depth of [3, 2]) {
      try {
        const result = window.DecoderSolver.solveRestrictedHorizon({ ...base, depth });
        return { ...result, proven: false, lower: result.value, upper: window.DecoderSolver.stateUpperBound({ config: state.config, puzzle: state.puzzle, challenges: state.challenges }) };
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
    if (chooseAny) { const image=$('#recommendImage'); image.hidden=false; image.src='card-back.gif'; image.dataset.zoomable='false'; }
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
      ? `<span>${hint.proven ? '已证明最优' : '当前可行下界'}</span><span>${hint.method === 'exact-bellman' ? '精确 Bellman' : hint.method === 'restricted-horizon' ? `深度${hint.depth}策略树` : '分支定界'}</span><span>候选组 ${candidateCache.length}</span><span>提示信息 ${hint.entropy.toFixed(2)} bit</span>`
      : recommendHint
      ? `<span>剩余提示 ${state.hints}</span><span>后续预留 ${hint.futureReserve}</span><span>当前可支配 ${hint.spendableHints}</span><span>有效候选约 ${hint.effectiveCandidates.toFixed(1)}</span>`
      : `<span>${escapeHtml(formatBorder(card.b))}</span><span>${escapeHtml(DATA.labels.attribute[card.a] || card.a)}</span><span>${escapeHtml(DATA.labels.race[card.r] || card.r)}</span><span>${card.n}</span><span>${formatStat(card.atk)}／${formatStat(card.def)}</span>`;
    $('#metricPoints').textContent = recommendHint ? '0.00' : best.points.toFixed(2);
    $('#metricSolve').textContent = recommendHint ? '0%' : formatPercent(best.solve);
    $('#metricInfo').textContent = `${(recommendHint ? hint.entropy : best.info).toFixed(2)} bit`;
    $('#alternatives').innerHTML = chooseAny
      ? equivalentChoices.slice(0,8).map((index,offset)=>`<button class="alternative" type="button" data-recommend-index="${index}"><div class="alternative-title"><b>=</b><span>${escapeHtml(CARDS[index].name)}</span></div><div class="alternative-metrics"><span><small>关系</small>并列最优</span><span><small>操作</small>点击选择</span></div></button>`).join('')
      : recommendations.slice(recommendHint ? 0 : 1, recommendHint ? 3 : 4).map((item, offset) => `<button class="alternative" type="button" data-recommend-index="${item.index}"><div class="alternative-title"><b>${offset + 1}</b><span>${escapeHtml(CARDS[item.index].name)}</span></div><div class="alternative-metrics"><span><small>期望</small>${item.points.toFixed(2)}</span><span><small>通关</small>${formatPercent(item.solve)}</span><span><small>信息</small>${item.info.toFixed(2)} bit</span></div></button>`).join('');
    $('#methodNote').textContent = hint.method === 'restricted-horizon'
      ? `当前为受限深度自适应策略树：提示与挑战使用相同递归和终止规则；结果是合法可行策略，不等于全局最优证明。`
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
    $('#modeGuide').textContent = guides[$('#recommendMode').value];
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

  function startSession(mode) {
    if (testSession) return;
    testSession = { realState: clone(state), targetIndex: randomWeightedIndex(state.pool), mode, revealed: false };
    const pool = state.pool;
    state = freshState(state.config);
    state.pool = pool;
    state.presetId = testSession.realState.presetId;
    seedTestInitialReveal();
    undoStack = [];
    render();
    toast(`${mode === 'game' ? '小游戏' : '测试'}模式已开始；退出后会恢复原活动进度。`);
  }

  function startTestMode() { startSession('test'); }
  function startGameMode() { startSession('game'); }

  function seedTestInitialReveal() {
    const target = CARDS[testSession.targetIndex];
    const field = FIELDS[Math.floor(Math.random() * FIELDS.length)];
    const value = fieldValue(target, field.key);
    state.known[field.key] = { value, source: 'initial' };
    state.initialUsed = true;
    const log = { type: 'reveal', field: field.key, value, source: 'initial', time: timeLabel() };
    state.logs.push(log);
    appendHistory(log);
  }

  function newTestTarget() {
    if (!testSession) return;
    const pool = state.pool;
    const config = state.config;
    const presetId = state.presetId;
    testSession.targetIndex = randomWeightedIndex(pool);
    testSession.revealed = false;
    state = freshState(config);
    state.pool = pool;
    state.presetId = presetId;
    seedTestInitialReveal();
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
    if (feedbackMask & 1) $('#borderReveal').value = String(target.b);
    if (feedbackMask & 8) $('#numberReveal').value = String(target.n);
    recordChallenge();
  }

  function openSimulation() {
    $('#simulationPool').value = state.pool;
    const config = state.config;
    $('#simulationConfigSummary').textContent = `${config.puzzles} 题；全活动提示 ${config.totalHints} 次、挑战 ${config.totalChallenges} 次。每一步使用与实操相同的精确／受限策略树，因此会明显慢于旧版快速基线。`;
    if (simulationSnapshot) renderSimulationSnapshot(simulationSnapshot);
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
        const target = CARDS[targetIndex], weight = simulationWeight(target, pool), mask = matchMask(target, guess);
        if (mask === 63) solveMass += weight;
        newMatches += (popcount(matchedMask | mask) - oldCount) * weight;
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
        const signature = candidates.map((targetIndex) => { const target=CARDS[targetIndex],mask=matchMask(target,CARDS[action]); return `${mask}:${mask&1?target.b:''}:${mask&8?target.n:''}`; }).join('|');
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
        matchedItems += popcount(matchedMask | mask) - popcount(matchedMask);
        const gain = thresholdGain(matchedMask, matchedMask | mask, config, puzzle);
        if (isPremiumPuzzle(puzzle, config)) premiumScore += gain;
        else progressScore += gain;
        matchedMask |= mask;
        // Matching challenge fields are revealed by the real game and therefore cannot be
        // selected by a later random hint. Omitting this made simulations waste hints on
        // already-known fields and systematically understated the policy's performance.
        for (const field of FIELDS) if (mask & field.bit) known.add(field.key);
        challenges -= 1;
        challengesUsed += 1;
        if (mask === 63) {
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

  function renderSimulationSnapshot(snapshot) {
    const { summary, current, completed = 0, total = 1, type } = snapshot;
    if (!summary) return;
    const ratio=Math.min(1,(completed+(current?Math.max(0,current.puzzle-1)/Math.max(1,state.config.puzzles):0))/Math.max(1,total));
    $('#simulationProgress').hidden=false;
    $('#simulationProgress span').style.width=`${ratio*100}%`;
    const runningText=current?`第 ${current.round}/${total} 个活动 · 第 ${current.puzzle} 题 · 候选 ${current.candidates.toLocaleString('zh-CN')} · 库存 ${current.hints}提示/${current.challenges}挑战`:`已完成 ${completed}/${total}`;
    $('#simulationProgress strong').textContent=type==='complete'?`已完成 ${completed}/${total}`:type==='cancelled'?`已停止，完成 ${completed}/${total}`:runningText;
    const d=summary.diagnostics,distribution=summary.distribution||[];
    $('#simulationResults').innerHTML=`<div class="simulation-live"><strong>${type==='complete'?'测试完成':type==='cancelled'?'测试已停止':'后台计算中'}</strong><span>已完成 ${summary.count} / ${total} 个活动</span>${current?`<small>正在进行：第 ${current.round} 个活动，第 ${current.puzzle} 题；本轮已用 ${current.hintsUsed} 提示、${current.challengesUsed} 挑战</small>`:''}</div><div class="result-grid"><article><span>实时平均解题数</span><strong>${summary.meanSolved.toFixed(2)} / ${state.config.puzzles}</strong><small>95%区间 ${summary.solvedLow.toFixed(2)}–${summary.solvedHigh.toFixed(2)} · P10 ${summary.p10} · P50 ${summary.p50} · P90 ${summary.p90}</small></article><article><span>实时全题完成率</span><strong>${formatPercent(summary.completion)}</strong><small>Wilson 95%区间 ${formatPercent(summary.completionLow)}–${formatPercent(summary.completionHigh)}</small></article><article><span>平均首次相符项</span><strong>${summary.matchedItems.toFixed(2)}</strong><small>只统计挑战首次猜中的项目</small></article><article><span>平均资源消耗</span><strong>${summary.challengesUsed.toFixed(2)} 挑战</strong><small>${summary.hintsUsed.toFixed(2)} 提示</small></article><article><span>求解层级</span><strong>深度3：${d.depth3Calls}</strong><small>精确 ${d.exactCalls} · 深度2 ${d.depth2Calls} · 降级 ${d.fallbackCalls}</small></article><article><span>运行统计</span><strong>${summary.elapsed.toFixed(1)} 秒</strong><small>${d.solverCalls} 次求解 · ${d.cacheHits} 次缓存 · ${d.hintDecisions} 次提示</small></article></div><div class="histogram">${distribution.map(item=>`<div><span>解出${item.solved}题</span><i><b style="width:${item.count/Math.max(1,summary.count)*100}%"></b></i><strong>${item.count}</strong></div>`).join('')}</div><p class="simulation-disclaimer">测试在独立后台线程运行，关闭窗口不会中断；重新打开“规模测试”可查看最新进度。每一步使用与实操相同的策略树，结果评估当前策略，但不构成全局最优证明。</p>`;
  }

  function runSimulation() {
    if (simulationRunning) { simulationWorker?.postMessage({type:'cancel'}); $('#runSimulationBtn').textContent='正在停止…'; return; }
    const rounds = clampInt($('#simulationRounds').value, 1, 500, 50);
    const pool = $('#simulationPool').value;
    const config = normalizeConfig(state.config);
    simulationRunning = true;
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
    simulationWorker = new Worker(simulationWorkerUrl);
    simulationWorker.onmessage = ({data}) => {
      simulationSnapshot=data; renderSimulationSnapshot(data);
      if(['complete','cancelled','error'].includes(data.type)){
        simulationRunning=false; $('#runSimulationBtn').textContent='重新开始'; simulationWorker.terminate(); simulationWorker=null; URL.revokeObjectURL(simulationWorkerUrl); simulationWorkerUrl=null;
        if(data.type==='error'){ $('#simulationResults').innerHTML=`<div class="empty-inline">后台测试失败：${escapeHtml(data.message)}</div>`; }
      }
    };
    simulationWorker.onerror = (event) => { simulationRunning=false; $('#runSimulationBtn').textContent='重新开始'; $('#simulationResults').innerHTML=`<div class="empty-inline">后台测试失败：${escapeHtml(event.message)}</div>`; if(simulationWorkerUrl){URL.revokeObjectURL(simulationWorkerUrl);simulationWorkerUrl=null;} };
    const compactCards=CARDS.map(({b,a,r,n,nm,atk,def,wm,wa})=>({b,a,r,n,nm,atk,def,wm,wa}));
    simulationWorker.postMessage({type:'start',cards:compactCards,config,pool,rounds});
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
    $('#feedbackGrid').addEventListener('click', (event) => {
      const button = event.target.closest('[data-feedback-bit]');
      if (!button) return;
      feedbackMask ^= Number(button.dataset.feedbackBit);
      renderFeedback();
    });
    $('#recordChallengeBtn').addEventListener('click', beginChallenge);
    $('#feedbackForm').addEventListener('submit', (event) => { event.preventDefault(); recordChallenge(); });
    $('#feedbackCloseBtn').addEventListener('click', () => $('#feedbackDialog').close());
    $('#feedbackCancelBtn').addEventListener('click', () => $('#feedbackDialog').close());
    $('#calculateBtn').addEventListener('click', calculateRecommendations);
    $('#recommendMode').addEventListener('change', () => { renderModeGuide(); clearRecommendation(); calculateRecommendations(); });
    $('#recommendTitle').addEventListener('click', () => {
      const index = Number($('#recommendTitle').dataset.cardIndex);
      if (!Number.isInteger(index)) return;
      switchTab('challenge'); selectGuess(index); window.scrollTo({ top: 0, behavior: 'smooth' });
    });
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
    $('#candidateFilterField').addEventListener('change', () => { $('#candidateFilterValue').value = ''; refreshCandidateFilterValues(); renderCandidates(); });
    $('#candidateFilterValue').addEventListener('change', renderCandidates);
    $('#candidateSort').addEventListener('change', renderCandidates);
    $('#openHistoryBtn').addEventListener('click', openHistoryArchive);
    $('#historyCloseBtn').addEventListener('click', () => $('#historyDialog').close());
    $('#historyDoneBtn').addEventListener('click', () => $('#historyDialog').close());
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
      state = undoStack.pop(); render(); toast('已撤销上一步。');
    });
    $('#resetPuzzleBtn').addEventListener('click', () => {
      if (!confirm('重置本题会移除本题线索、挑战记录和本题得分，是否继续？')) return;
      pushUndo();
      state.totalScore = Math.max(0, state.totalScore - state.puzzleScore);
      if (isPremiumPuzzle()) state.premiumScore = Math.max(0, state.premiumScore - state.puzzleScore);
      else state.progressScore = Math.max(0, state.progressScore - state.puzzleScore);
      resetPuzzle(false);
      if (testSession) seedTestInitialReveal();
      render();
    });
    $('#resetEventBtn').addEventListener('click', () => {
      if (!confirm(`确定清除整个 ${state.config.puzzles} 题活动的本地记录吗？`)) return;
      pushUndo();
      const presetId = state.presetId;
      state = freshState(state.config);
      state.presetId = presetId;
      render();
    });
    $('#nextPuzzleBtn').addEventListener('click', () => {
      if (state.puzzle >= state.config.puzzles) { $('#solvedBanner').hidden = true; toast(`活动完成：高价值 ${state.premiumScore}，后段匹配 ${state.progressScore}。`); return; }
      pushUndo(); state.puzzle += 1; resetPuzzle(true);
      if (testSession) { testSession.targetIndex = randomWeightedIndex(state.pool); testSession.revealed = false; seedTestInitialReveal(); }
      render();
    });
    $('#settingsBtn').addEventListener('click', openSettings);
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

  bindEvents();
  render();
  startWallpaperCycle();
  registerWebMcpTools();
})();
