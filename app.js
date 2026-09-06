/**
 * app.js – UI-Logik, Streak-/Joker-Berechnung, Erinnerungen, Gamification.
 * Datenschicht ausschließlich über KernroutineDB (db.js).
 */

const REWARDS = [
  { id: 'r7', days: 7, label: '7 Tage', type: 'theme', value: 'ocean', emoji: '🌊' },
  { id: 'r30', days: 30, label: '30 Tage', type: 'theme', value: 'clay', emoji: '🏺' },
  { id: 'r100', days: 100, label: '100 Tage', type: 'stat', value: 'extended-stats', emoji: '🏔️' }
];

const state = {
  view: 'today',
  goals: [],
  checkinsByGoal: {}, // goalId -> [checkin,...]
  points: 0,
  unlockedRewards: [],
  wizard: null,       // Zustand des Zielerstellungs-Wizards
  lastUndo: null,      // für Rückgängig-Toast
  timer: { mode: null, remainingSec: 0, intervalId: null, goalId: null }
};

// ---------- Utilities ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const { todayISO } = window.krUtils;

function isoWeekKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getFullYear()}-W${weekNo}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return todayISO(d);
}

function dateRangeDesc(days) {
  const out = [];
  let cur = todayISO();
  for (let i = 0; i < days; i++) { out.push(cur); cur = addDays(cur, -1); }
  return out; // heute zuerst
}

// ---------- Streak- und Joker-Berechnung ----------
/**
 * Ermittelt pro Tag den Status (done / joker / missed / future) sowie
 * aktuelle/längste Streak. Ein Joker pro Kalenderwoche und Ziel entschärft
 * genau einen ausgelassenen Pflichttag, ohne die Streak zu brechen.
 */
function computeGoalStats(goal, checkins) {
  const checkinMap = new Map(checkins.map((c) => [c.date, c]));
  const days = dateRangeDesc(84).reverse(); // älteste zuerst, 12 Wochen
  const dayStatus = {};
  const jokerUsedInWeek = {};
  let longest = 0, running = 0, current = 0;

  for (const date of days) {
    const c = checkinMap.get(date);
    const week = isoWeekKey(date);
    const isRequired = goal.cadence === 'daily' || true; // Wochenziele werten am Wochenende ab
    if (c) {
      dayStatus[date] = 'done';
      running += 1;
    } else if (date === todayISO()) {
      dayStatus[date] = 'today-open';
      // heutiger Tag zählt weder als Erfolg noch als Bruch, solange er läuft
    } else if (!jokerUsedInWeek[week] && goal.cadence === 'daily') {
      jokerUsedInWeek[week] = true;
      dayStatus[date] = 'joker';
      running += 1; // Joker hält die Streak am Leben
    } else {
      dayStatus[date] = 'missed';
      longest = Math.max(longest, running);
      running = 0;
    }
  }
  longest = Math.max(longest, running);

  // aktuelle Streak: von heute rückwärts zählen, bis ein echter Bruch kommt
  for (const date of days.slice().reverse()) {
    const s = dayStatus[date];
    if (s === 'done' || s === 'joker') current += 1;
    else if (s === 'today-open') continue;
    else break;
  }

  // Wochenfortschritt für Wochenziele / Gamification-Punkte
  const thisWeek = isoWeekKey(todayISO());
  const doneThisWeek = checkins.filter((c) => isoWeekKey(c.date) === thisWeek).length;
  const weeklyTarget = goal.cadence === 'daily' ? 7 : goal.timesPerWeek;
  const weekComplete = doneThisWeek >= weeklyTarget;

  return { dayStatus, currentStreak: current, longestStreak: longest, doneThisWeek, weeklyTarget, weekComplete };
}

// ---------- Erinnerungs-Ton je nach Streak ----------
function reminderMessage(goal, streak) {
  if (streak >= 30) return `${goal.title}: ${streak} Tage in Folge – stark, mach weiter!`;
  if (streak >= 7) return `${goal.title}: ${streak} Tage Streak. Zeit für heute?`;
  return `Zeit für „${goal.title}“.`;
}

// ---------- Initialisierung ----------
async function loadState() {
  state.goals = await KernroutineDB.getAllGoals();
  state.checkinsByGoal = {};
  for (const g of state.goals) {
    state.checkinsByGoal[g.id] = await KernroutineDB.getCheckinsForGoal(g.id);
  }
  state.points = await KernroutineDB.getMeta('points', 0);
  state.unlockedRewards = await KernroutineDB.getMeta('unlockedRewards', []);
  const theme = await KernroutineDB.getMeta('activeTheme', 'default');
  document.documentElement.dataset.theme = theme === 'default' ? '' : theme;
  await checkMilestones();
}

async function checkMilestones() {
  let changed = false;
  for (const g of state.goals) {
    const stats = computeGoalStats(g, state.checkinsByGoal[g.id] || []);
    for (const r of REWARDS) {
      if (stats.longestStreak >= r.days && !state.unlockedRewards.includes(r.id)) {
        state.unlockedRewards.push(r.id);
        changed = true;
      }
    }
  }
  if (changed) await KernroutineDB.setMeta('unlockedRewards', state.unlockedRewards);
}

async function addPointsIfWeekComplete(goal) {
  const stats = computeGoalStats(goal, state.checkinsByGoal[goal.id] || []);
  const key = `weekpoint-${goal.id}-${isoWeekKey(todayISO())}`;
  const already = await KernroutineDB.getMeta(key, false);
  if (stats.weekComplete && !already) {
    state.points += 10;
    await KernroutineDB.setMeta('points', state.points);
    await KernroutineDB.setMeta(key, true);
  }
}

// ---------- Rendering: Navigation ----------
function setView(view) {
  state.view = view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $$('.bottom-nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#fab-add-goal').style.display = view === 'goals' ? 'flex' : 'none';
  render();
}

function render() {
  $('#points-display').textContent = `${state.points} Pkt.`;
  if (state.view === 'today') renderToday();
  if (state.view === 'goals') renderGoals();
  if (state.view === 'stats') renderStats();
}

// ---------- "Heute" ----------
function renderToday() {
  const root = $('#view-today');
  const active = state.goals.filter((g) => g.status === 'active');
  if (active.length === 0) {
    root.innerHTML = `<div class="empty-state"><div class="big">🌱</div>Noch keine aktiven Ziele.<br>Lege unter „Ziele" dein erstes Kernroutine-Ziel an.</div>`;
    return;
  }
  root.innerHTML = active.map((g) => {
    const checkins = state.checkinsByGoal[g.id] || [];
    const stats = computeGoalStats(g, checkins);
    const doneToday = !!checkins.find((c) => c.date === todayISO());
    const streakLabel = stats.currentStreak > 0 ? `🔥 ${stats.currentStreak}` : 'Neu starten';
    return `
      <div class="card goal-card" data-goal-id="${g.id}">
        <div class="goal-row">
          <div class="goal-emoji">${g.emoji}</div>
          <div class="goal-info">
            <div class="goal-title">${escapeHtml(g.title)}</div>
            <div class="goal-sub">${g.cadence === 'daily' ? 'täglich' : g.timesPerWeek + 'x / Woche'} · ${stats.doneThisWeek}/${stats.weeklyTarget} diese Woche</div>
          </div>
          <span class="streak-pill ${stats.currentStreak >= 7 ? 'hot' : ''}">${streakLabel}</span>
          <button class="checkin-btn ${doneToday ? 'done' : ''}" data-action="checkin" data-goal-id="${g.id}" aria-label="Check-in für ${escapeHtml(g.title)}">${doneToday ? '✓' : '○'}</button>
        </div>
        ${g.metric !== 'check' ? `<div class="goal-sub">Ziel: ${g.targetValue} ${g.metric === 'minutes' ? 'Min.' : 'Seiten'}</div>` : ''}
        ${extraModuleButton(g)}
      </div>`;
  }).join('');
}

function extraModuleButton(g) {
  if (g.metric === 'minutes' && /les/i.test(g.title)) {
    return `<button class="btn secondary full" data-action="open-reading-timer" data-goal-id="${g.id}">📖 Lesetimer starten</button>`;
  }
  if (/medit/i.test(g.title)) {
    return `<button class="btn secondary full" data-action="open-meditation-timer" data-goal-id="${g.id}">🌬️ Atemtimer starten</button>`;
  }
  return '';
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Check-in-Flow ----------
async function handleCheckin(goalId) {
  const goal = state.goals.find((g) => g.id === goalId);
  const date = todayISO();
  const existing = await KernroutineDB.getCheckin(goalId, date);

  if (existing) {
    // Rückgängig: erneutes Tippen entfernt den Check-in wieder
    await KernroutineDB.removeCheckin(goalId, date);
    state.checkinsByGoal[goalId] = await KernroutineDB.getCheckinsForGoal(goalId);
    render();
    return;
  }

  if (goal.metric === 'check') {
    await KernroutineDB.upsertCheckin({ goalId, date, value: 1 });
    state.checkinsByGoal[goalId] = await KernroutineDB.getCheckinsForGoal(goalId);
    await addPointsIfWeekComplete(goal);
    await checkMilestones();
    render();
    showUndoToast(goalId, date);
  } else {
    openReflectionSheet(goal);
  }
}

function showUndoToast(goalId, date) {
  state.lastUndo = { goalId, date };
  const toast = $('#undo-toast');
  toast.classList.add('open');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('open'), 5000);
}

async function undoLastCheckin() {
  if (!state.lastUndo) return;
  await KernroutineDB.removeCheckin(state.lastUndo.goalId, state.lastUndo.date);
  state.checkinsByGoal[state.lastUndo.goalId] = await KernroutineDB.getCheckinsForGoal(state.lastUndo.goalId);
  $('#undo-toast').classList.remove('open');
  state.lastUndo = null;
  render();
}

// ---------- Reflexions-Sheet (Notiz + Bewertung) ----------
function openReflectionSheet(goal) {
  $('#reflection-goal-title').textContent = goal.title;
  $('#reflection-value').value = goal.targetValue || '';
  $('#reflection-value-label').textContent = goal.metric === 'minutes' ? 'Minuten' : 'Seiten';
  $('#reflection-note').value = '';
  $$('#reflection-rating .chip').forEach((c) => c.classList.remove('selected'));
  openSheet('sheet-reflection');
  $('#sheet-reflection').dataset.goalId = goal.id;
}

async function submitReflection() {
  const sheet = $('#sheet-reflection');
  const goalId = sheet.dataset.goalId;
  const goal = state.goals.find((g) => g.id === goalId);
  const value = parseInt($('#reflection-value').value, 10) || 0;
  const note = $('#reflection-note').value.trim();
  const ratingEl = $('#reflection-rating .chip.selected');
  const rating = ratingEl ? parseInt(ratingEl.dataset.value, 10) : null;

  await KernroutineDB.upsertCheckin({ goalId, date: todayISO(), value, note, rating });
  state.checkinsByGoal[goalId] = await KernroutineDB.getCheckinsForGoal(goalId);
  await addPointsIfWeekComplete(goal);
  await checkMilestones();
  closeSheet('sheet-reflection');
  render();
  showUndoToast(goalId, todayISO());
}

// ---------- "Ziele" ----------
function renderGoals() {
  const root = $('#view-goals');
  if (state.goals.length === 0) {
    root.innerHTML = `<div class="empty-state"><div class="big">🎯</div>Tippe unten rechts auf „+“, um dein erstes Ziel anzulegen.</div>`;
    return;
  }
  const groups = { active: [], paused: [], archived: [] };
  state.goals.forEach((g) => groups[g.status].push(g));

  const section = (title, list) => list.length ? `<div class="section-title">${title}</div>` + list.map(goalManageCard).join('') : '';
  root.innerHTML = section('Aktiv', groups.active) + section('Pausiert', groups.paused) + section('Archiviert', groups.archived);
}

function goalManageCard(g) {
  const stats = computeGoalStats(g, state.checkinsByGoal[g.id] || []);
  return `
    <div class="card goal-card">
      <div class="goal-row">
        <div class="goal-emoji">${g.emoji}</div>
        <div class="goal-info">
          <div class="goal-title">${escapeHtml(g.title)}</div>
          <div class="goal-sub">Streak: ${stats.currentStreak} · Rekord: ${stats.longestStreak} · Erinnerung: ${g.reminderTime || '–'}</div>
        </div>
      </div>
      <div class="chip-row">
        <button class="chip" data-action="edit-goal" data-goal-id="${g.id}">Bearbeiten</button>
        ${g.status === 'active' ? `<button class="chip" data-action="pause-goal" data-goal-id="${g.id}">Pausieren</button>` : ''}
        ${g.status === 'paused' ? `<button class="chip" data-action="resume-goal" data-goal-id="${g.id}">Fortsetzen</button>` : ''}
        ${g.status !== 'archived' ? `<button class="chip" data-action="archive-goal" data-goal-id="${g.id}">Archivieren</button>` : ''}
        <button class="chip" data-action="delete-goal" data-goal-id="${g.id}" style="color:var(--danger)">Löschen</button>
      </div>
    </div>`;
}

// ---------- "Statistik" ----------
function renderStats() {
  const root = $('#view-stats');
  const activeGoals = state.goals.filter((g) => g.status !== 'archived');
  const heatmaps = activeGoals.map((g) => {
    const checkins = state.checkinsByGoal[g.id] || [];
    const stats = computeGoalStats(g, checkins);
    return `
      <div class="card">
        <div class="goal-row" style="margin-bottom:10px;">
          <div class="goal-emoji">${g.emoji}</div>
          <div class="goal-info"><div class="goal-title">${escapeHtml(g.title)}</div></div>
        </div>
        <div class="heatmap-wrap">${renderHeatmapGrid(stats.dayStatus)}</div>
        <div class="stat-row">
          <div class="stat-box"><div class="num">${stats.currentStreak}</div><div class="lbl">Aktuelle Streak</div></div>
          <div class="stat-box"><div class="num">${stats.longestStreak}</div><div class="lbl">Bestwert</div></div>
          <div class="stat-box"><div class="num">${stats.doneThisWeek}/${stats.weeklyTarget}</div><div class="lbl">Diese Woche</div></div>
        </div>
      </div>`;
  }).join('');

  root.innerHTML = `
    <div class="section-title">Belohnungen</div>
    <div class="card">
      <div class="reward-grid">
        ${REWARDS.map((r) => `
          <div class="reward-item ${state.unlockedRewards.includes(r.id) ? 'unlocked' : ''}">
            <div>${r.emoji}</div>
            <div class="lbl">${r.label}</div>
          </div>`).join('')}
      </div>
      ${state.unlockedRewards.includes('r7') ? themeSwitcher() : '<p class="notice">Erreiche 7 Tage Streak, um Farbthemen freizuschalten.</p>'}
    </div>
    <div class="section-title">Ziele im Überblick (12 Wochen)</div>
    ${heatmaps || '<p class="notice">Noch keine Daten.</p>'}
  `;
}

function themeSwitcher() {
  const themes = [{ id: 'default', label: 'Standard' }];
  if (state.unlockedRewards.includes('r7')) themes.push({ id: 'ocean', label: 'Ozean' });
  if (state.unlockedRewards.includes('r30')) themes.push({ id: 'clay', label: 'Terrakotta' });
  return `<div class="chip-row" style="margin-top:12px;">${themes.map((t) =>
    `<button class="chip" data-action="set-theme" data-theme="${t.id}">${t.label}</button>`).join('')}</div>`;
}

function renderHeatmapGrid(dayStatus) {
  const days = dateRangeDesc(84).reverse();
  const cells = days.map((d) => {
    const s = dayStatus[d];
    const cls = s === 'done' ? 'l4' : s === 'joker' ? 'l2 joker' : s === 'missed' ? '' : '';
    return `<div class="heat-cell ${cls}" title="${d}"></div>`;
  }).join('');
  return `<div class="heatmap">${cells}</div>`;
}

// ---------- Sheets (generisch) ----------
function openSheet(id) {
  $('#sheet-backdrop').classList.add('open');
  $('#' + id).classList.add('open');
}
function closeSheet(id) {
  $('#sheet-backdrop').classList.remove('open');
  $('#' + id).classList.remove('open');
}
function closeAllSheets() {
  $$('.sheet').forEach((s) => s.classList.remove('open'));
  $('#sheet-backdrop').classList.remove('open');
}

// ---------- Ziel-Wizard (3 Schritte) ----------
function startWizard(existingGoal = null) {
  state.wizard = {
    step: 1,
    editingId: existingGoal ? existingGoal.id : null,
    title: existingGoal ? existingGoal.title : '',
    emoji: existingGoal ? existingGoal.emoji : '🎯',
    cadence: existingGoal ? existingGoal.cadence : 'daily',
    timesPerWeek: existingGoal ? existingGoal.timesPerWeek : 3,
    metric: existingGoal ? existingGoal.metric : 'check',
    targetValue: existingGoal ? existingGoal.targetValue : null,
    reminderTime: existingGoal ? existingGoal.reminderTime : ''
  };
  renderWizardStep();
  openSheet('sheet-goal');
}

function renderWizardStep() {
  const w = state.wizard;
  $('#wizard-step-indicator').textContent = `Schritt ${w.step} von 3`;
  const body = $('#wizard-body');

  if (w.step === 1) {
    body.innerHTML = `
      <div class="field-group"><label>Titel</label><input type="text" id="w-title" value="${escapeHtml(w.title)}" placeholder="z. B. Täglich meditieren"></div>
      <div class="field-group"><label>Emoji / Icon</label>
        <div class="chip-row">
          ${['🎯','📖','🧘','🏃','💧','✍️','🎹','💪'].map((e) => `<button class="chip ${w.emoji === e ? 'selected' : ''}" data-emoji="${e}">${e}</button>`).join('')}
        </div>
      </div>`;
  } else if (w.step === 2) {
    body.innerHTML = `
      <div class="field-group"><label>Rhythmus</label>
        <div class="chip-row">
          <button class="chip ${w.cadence === 'daily' ? 'selected' : ''}" data-cadence="daily">Täglich</button>
          <button class="chip ${w.cadence === 'weekly' ? 'selected' : ''}" data-cadence="weekly">X-mal / Woche</button>
        </div>
      </div>
      ${w.cadence === 'weekly' ? `<div class="field-group"><label>Wie oft pro Woche?</label><input type="number" id="w-times" min="1" max="7" value="${w.timesPerWeek}"></div>` : ''}`;
  } else {
    body.innerHTML = `
      <div class="field-group"><label>Messgröße</label>
        <div class="chip-row">
          <button class="chip ${w.metric === 'check' ? 'selected' : ''}" data-metric="check">Einfacher Haken</button>
          <button class="chip ${w.metric === 'minutes' ? 'selected' : ''}" data-metric="minutes">Minuten</button>
          <button class="chip ${w.metric === 'pages' ? 'selected' : ''}" data-metric="pages">Seiten</button>
        </div>
      </div>
      ${w.metric !== 'check' ? `<div class="field-group"><label>Zielwert</label><input type="number" id="w-target" min="1" value="${w.targetValue || ''}"></div>` : ''}
      <div class="field-group"><label>Erinnerung (optional)</label><input type="time" id="w-time" value="${w.reminderTime || ''}"></div>`;
  }

  $('#wizard-back').style.visibility = w.step === 1 ? 'hidden' : 'visible';
  $('#wizard-next').textContent = w.step === 3 ? (w.editingId ? 'Speichern' : 'Ziel erstellen') : 'Weiter';
}

function collectWizardStepInput() {
  const w = state.wizard;
  if (w.step === 1) {
    w.title = ($('#w-title')?.value || '').trim();
  } else if (w.step === 2) {
    if (w.cadence === 'weekly') w.timesPerWeek = parseInt($('#w-times')?.value, 10) || 3;
  } else {
    if (w.metric !== 'check') w.targetValue = parseInt($('#w-target')?.value, 10) || null;
    w.reminderTime = $('#w-time')?.value || '';
  }
}

async function wizardNext() {
  collectWizardStepInput();
  const w = state.wizard;
  if (w.step === 1 && !w.title) { alert('Bitte einen Titel eingeben.'); return; }
  if (w.step < 3) { w.step += 1; renderWizardStep(); return; }

  const payload = {
    title: w.title, emoji: w.emoji, cadence: w.cadence,
    timesPerWeek: w.cadence === 'weekly' ? w.timesPerWeek : 7,
    metric: w.metric, targetValue: w.targetValue, reminderTime: w.reminderTime
  };
  if (w.editingId) {
    await KernroutineDB.updateGoal(w.editingId, payload);
  } else {
    const goal = await KernroutineDB.createGoal(payload);
    if (goal.reminderTime) await maybeExplainNotifications();
  }
  await loadState();
  closeSheet('sheet-goal');
  render();
}

function wizardBack() {
  if (state.wizard.step > 1) { state.wizard.step -= 1; renderWizardStep(); }
}

// ---------- Ziel-Aktionen ----------
async function handleGoalAction(action, goalId) {
  const goal = state.goals.find((g) => g.id === goalId);
  if (action === 'edit-goal') return startWizard(goal);
  if (action === 'pause-goal') await KernroutineDB.updateGoal(goalId, { status: 'paused' });
  if (action === 'resume-goal') await KernroutineDB.updateGoal(goalId, { status: 'active' });
  if (action === 'archive-goal') await KernroutineDB.updateGoal(goalId, { status: 'archived' });
  if (action === 'delete-goal') {
    if (!confirm(`„${goal.title}“ inklusive aller Check-ins endgültig löschen?`)) return;
    await KernroutineDB.deleteGoal(goalId);
  }
  await loadState();
  render();
}

// ---------- Push-Erklärung & Erinnerungs-Scheduler ----------
async function maybeExplainNotifications() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted' || Notification.permission === 'denied') return;
  openSheet('sheet-notif-explain');
}

async function requestNotificationPermission() {
  closeSheet('sheet-notif-explain');
  if (!('Notification' in window)) return;
  try { await Notification.requestPermission(); } catch (e) { /* iOS < 16.4 wirft evtl. Fehler */ }
}

let reminderInterval = null;
function startReminderScheduler() {
  if (reminderInterval) clearInterval(reminderInterval);
  reminderInterval = setInterval(checkReminders, 60 * 1000);
  checkReminders();
}

async function checkReminders() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const now = new Date();
  const hhmm = now.toTimeString().slice(0, 5);
  for (const g of state.goals) {
    if (g.status !== 'active' || !g.reminderTime || g.reminderTime !== hhmm) continue;
    const checkin = await KernroutineDB.getCheckin(g.id, todayISO());
    if (checkin) continue; // bereits erledigt: keine Benachrichtigung
    const stats = computeGoalStats(g, state.checkinsByGoal[g.id] || []);
    const reg = await navigator.serviceWorker.ready;
    reg.showNotification('Kernroutine', {
      body: reminderMessage(g, stats.currentStreak),
      icon: './icons/icon-192.png',
      tag: `reminder-${g.id}`
    });
  }
}

// ---------- Lesetimer (Minuten-Timer mit Lo-fi-Audio) ----------
let readingAudio = null;
function openReadingTimer(goalId) {
  const goal = state.goals.find((g) => g.id === goalId);
  state.timer = { mode: 'reading', remainingSec: (goal.targetValue || 20) * 60, intervalId: null, goalId };
  $('#reading-goal-title').textContent = goal.title;
  updateTimerDisplay('reading-display', state.timer.remainingSec);
  $('#reading-audio-toggle').checked = false;
  openSheet('sheet-reading-timer');
}

function toggleReadingTimer() {
  const btn = $('#reading-start-btn');
  if (state.timer.intervalId) {
    clearInterval(state.timer.intervalId);
    state.timer.intervalId = null;
    btn.textContent = 'Fortsetzen';
    if (readingAudio) readingAudio.pause();
  } else {
    state.timer.intervalId = setInterval(() => {
      state.timer.remainingSec -= 1;
      updateTimerDisplay('reading-display', state.timer.remainingSec);
      if (state.timer.remainingSec <= 0) finishReadingTimer();
    }, 1000);
    btn.textContent = 'Pause';
    if ($('#reading-audio-toggle').checked) {
      if (!readingAudio) readingAudio = new Audio('./audio/lofi.mp3');
      readingAudio.loop = true;
      readingAudio.play().catch(() => {});
    }
  }
}

async function finishReadingTimer() {
  clearInterval(state.timer.intervalId);
  state.timer.intervalId = null;
  if (readingAudio) readingAudio.pause();
  closeSheet('sheet-reading-timer');
  const goal = state.goals.find((g) => g.id === state.timer.goalId);
  openReflectionSheet(goal);
}

function updateTimerDisplay(id, totalSec) {
  const m = Math.max(0, Math.floor(totalSec / 60)).toString().padStart(2, '0');
  const s = Math.max(0, totalSec % 60).toString().padStart(2, '0');
  $('#' + id).textContent = `${m}:${s}`;
}

// ---------- Atemtimer (Meditation) ----------
function openMeditationTimer(goalId) {
  state.timer = { mode: 'meditation', remainingSec: 5 * 60, intervalId: null, goalId };
  $('#meditation-duration').value = 5;
  updateTimerDisplay('meditation-display', state.timer.remainingSec);
  $('#breath-circle').classList.add('paused');
  openSheet('sheet-meditation-timer');
}

function toggleMeditationTimer() {
  const circle = $('#breath-circle');
  const btn = $('#meditation-start-btn');
  if (state.timer.intervalId) {
    clearInterval(state.timer.intervalId);
    state.timer.intervalId = null;
    circle.classList.add('paused');
    btn.textContent = 'Fortsetzen';
  } else {
    if (state.timer.remainingSec <= 0) {
      state.timer.remainingSec = parseInt($('#meditation-duration').value, 10) * 60;
    }
    circle.classList.remove('paused');
    state.timer.intervalId = setInterval(() => {
      state.timer.remainingSec -= 1;
      updateTimerDisplay('meditation-display', state.timer.remainingSec);
      if (state.timer.remainingSec <= 0) finishMeditationTimer();
    }, 1000);
    btn.textContent = 'Pause';
  }
}

async function finishMeditationTimer() {
  clearInterval(state.timer.intervalId);
  state.timer.intervalId = null;
  $('#breath-circle').classList.add('paused');
  closeSheet('sheet-meditation-timer');
  const goal = state.goals.find((g) => g.id === state.timer.goalId);
  if (goal.metric === 'check') {
    await KernroutineDB.upsertCheckin({ goalId: goal.id, date: todayISO(), value: 1 });
    state.checkinsByGoal[goal.id] = await KernroutineDB.getCheckinsForGoal(goal.id);
    await addPointsIfWeekComplete(goal);
    render();
  } else {
    openReflectionSheet(goal);
  }
}

// ---------- Export & Reset ----------
async function exportData() {
  const data = await KernroutineDB.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kernroutine-export-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function resetAllData() {
  if (!confirm('Wirklich ALLE Ziele und Check-ins unwiderruflich löschen?')) return;
  if (!confirm('Letzte Sicherheitsabfrage: Reset wirklich durchführen?')) return;
  await KernroutineDB.resetAll();
  location.reload();
}

// ---------- Event-Delegation ----------
function bindEvents() {
  $$('.bottom-nav button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#fab-add-goal').addEventListener('click', () => startWizard());

  document.body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const action = t.dataset.action;
    const goalId = t.dataset.goalId;
    if (action === 'checkin') handleCheckin(goalId);
    if (action === 'open-reading-timer') openReadingTimer(goalId);
    if (action === 'open-meditation-timer') openMeditationTimer(goalId);
    if (['edit-goal', 'pause-goal', 'resume-goal', 'archive-goal', 'delete-goal'].includes(action)) handleGoalAction(action, goalId);
    if (action === 'set-theme') setTheme(t.dataset.theme);

    if (t.dataset.emoji) { state.wizard.emoji = t.dataset.emoji; renderWizardStep(); }
    if (t.dataset.cadence) { state.wizard.cadence = t.dataset.cadence; renderWizardStep(); }
    if (t.dataset.metric) { state.wizard.metric = t.dataset.metric; renderWizardStep(); }
    if (t.closest('#reflection-rating')) {
      $$('#reflection-rating .chip').forEach((c) => c.classList.remove('selected'));
      t.classList.add('selected');
    }
  });

  $('#sheet-backdrop').addEventListener('click', closeAllSheets);
  $$('[data-close-sheet]').forEach((b) => b.addEventListener('click', () => closeSheet(b.dataset.closeSheet)));

  $('#wizard-next').addEventListener('click', wizardNext);
  $('#wizard-back').addEventListener('click', wizardBack);
  $('#reflection-submit').addEventListener('click', submitReflection);
  $('#undo-toast-btn').addEventListener('click', undoLastCheckin);
  $('#notif-allow-btn').addEventListener('click', requestNotificationPermission);
  $('#notif-later-btn').addEventListener('click', () => closeSheet('sheet-notif-explain'));

  $('#reading-start-btn').addEventListener('click', toggleReadingTimer);
  $('#meditation-start-btn').addEventListener('click', toggleMeditationTimer);
  $('#meditation-duration').addEventListener('change', (e) => {
    state.timer.remainingSec = parseInt(e.target.value, 10) * 60;
    updateTimerDisplay('meditation-display', state.timer.remainingSec);
  });

  $('#export-btn').addEventListener('click', exportData);
  $('#reset-btn').addEventListener('click', resetAllData);
  $('#settings-btn').addEventListener('click', () => openSheet('sheet-settings'));
}

async function setTheme(themeId) {
  await KernroutineDB.setMeta('activeTheme', themeId);
  document.documentElement.dataset.theme = themeId === 'default' ? '' : themeId;
}

// ---------- Bootstrap ----------
async function main() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./service-worker.js'); } catch (e) { console.warn('SW-Registrierung fehlgeschlagen', e); }
  }
  await KernroutineDB.init();
  await loadState();
  bindEvents();
  setView('today');
  startReminderScheduler();
}

document.addEventListener('DOMContentLoaded', main);
