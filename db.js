/**
 * db.js – Komplette IndexedDB-Datenschicht für Kernroutine.
 * Kein Backend, keine Cloud: alles bleibt im Browser des Geräts.
 *
 * Object Stores:
 *  - goals:    { id, title, emoji, cadence:'daily'|'weekly', timesPerWeek,
 *                metric:'check'|'minutes'|'pages', targetValue,
 *                reminderTime, color, status:'active'|'paused'|'archived',
 *                createdAt }
 *  - checkins: { id, goalId, date:'YYYY-MM-DD', value, note, rating,
 *                isJoker, createdAt }  -- index auf goalId+date
 *  - meta:     { key, value }  -- z.B. points, unlockedRewards, activeTheme
 */

const DB_NAME = 'kernroutine-db';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('goals')) {
        const goals = db.createObjectStore('goals', { keyPath: 'id' });
        goals.createIndex('status', 'status', { unique: false });
      }

      if (!db.objectStoreNames.contains('checkins')) {
        const checkins = db.createObjectStore('checkins', { keyPath: 'id' });
        checkins.createIndex('goalId', 'goalId', { unique: false });
        checkins.createIndex('goalId_date', ['goalId', 'date'], { unique: true });
      }

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, storeNames, mode = 'readonly') {
  return db.transaction(storeNames, mode);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function todayISO(date = new Date()) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

const KernroutineDB = {
  _db: null,

  async init() {
    if (!this._db) this._db = await openDB();
    return this._db;
  },

  // ---------- GOALS ----------
  async createGoal(goal) {
    const db = await this.init();
    const record = {
      id: uuid(),
      title: goal.title,
      emoji: goal.emoji || '🎯',
      cadence: goal.cadence, // 'daily' | 'weekly'
      timesPerWeek: goal.timesPerWeek || (goal.cadence === 'daily' ? 7 : 3),
      metric: goal.metric || 'check', // 'check' | 'minutes' | 'pages'
      targetValue: goal.targetValue || null,
      reminderTime: goal.reminderTime || null, // 'HH:MM'
      color: goal.color || 'sage',
      status: 'active',
      createdAt: Date.now()
    };
    const t = tx(db, 'goals', 'readwrite');
    t.objectStore('goals').add(record);
    await reqToPromise(t.objectStore('goals').get(record.id));
    return record;
  },

  async updateGoal(id, patch) {
    const db = await this.init();
    const t = tx(db, 'goals', 'readwrite');
    const store = t.objectStore('goals');
    const existing = await reqToPromise(store.get(id));
    if (!existing) throw new Error('Ziel nicht gefunden');
    const updated = { ...existing, ...patch };
    store.put(updated);
    return updated;
  },

  async deleteGoal(id) {
    const db = await this.init();
    const t = tx(db, ['goals', 'checkins'], 'readwrite');
    t.objectStore('goals').delete(id);
    const idx = t.objectStore('checkins').index('goalId');
    const cursorReq = idx.openCursor(IDBKeyRange.only(id));
    cursorReq.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  },

  async getAllGoals() {
    const db = await this.init();
    const t = tx(db, 'goals');
    return reqToPromise(t.objectStore('goals').getAll());
  },

  async getGoal(id) {
    const db = await this.init();
    const t = tx(db, 'goals');
    return reqToPromise(t.objectStore('goals').get(id));
  },

  // ---------- CHECK-INS ----------
  async upsertCheckin({ goalId, date = todayISO(), value = 1, note = '', rating = null, isJoker = false }) {
    const db = await this.init();
    const t = tx(db, 'checkins', 'readwrite');
    const store = t.objectStore('checkins');
    const idx = store.index('goalId_date');
    const existing = await reqToPromise(idx.get([goalId, date]));
    const record = existing
      ? { ...existing, value, note, rating, isJoker }
      : { id: uuid(), goalId, date, value, note, rating, isJoker, createdAt: Date.now() };
    store.put(record);
    return record;
  },

  async removeCheckin(goalId, date) {
    const db = await this.init();
    const t = tx(db, 'checkins', 'readwrite');
    const idx = t.objectStore('checkins').index('goalId_date');
    const existing = await reqToPromise(idx.get([goalId, date]));
    if (existing) t.objectStore('checkins').delete(existing.id);
    return existing || null;
  },

  async getCheckinsForGoal(goalId) {
    const db = await this.init();
    const t = tx(db, 'checkins');
    const idx = t.objectStore('checkins').index('goalId');
    return reqToPromise(idx.getAll(IDBKeyRange.only(goalId)));
  },

  async getCheckin(goalId, date) {
    const db = await this.init();
    const t = tx(db, 'checkins');
    const idx = t.objectStore('checkins').index('goalId_date');
    return reqToPromise(idx.get([goalId, date]));
  },

  async getAllCheckins() {
    const db = await this.init();
    const t = tx(db, 'checkins');
    return reqToPromise(t.objectStore('checkins').getAll());
  },

  // ---------- META (Punkte, Rewards, Theme) ----------
  async getMeta(key, fallback = null) {
    const db = await this.init();
    const t = tx(db, 'meta');
    const rec = await reqToPromise(t.objectStore('meta').get(key));
    return rec ? rec.value : fallback;
  },

  async setMeta(key, value) {
    const db = await this.init();
    const t = tx(db, 'meta', 'readwrite');
    t.objectStore('meta').put({ key, value });
    return value;
  },

  // ---------- EXPORT / RESET ----------
  async exportAll() {
    const [goals, checkins] = await Promise.all([this.getAllGoals(), this.getAllCheckins()]);
    const points = await this.getMeta('points', 0);
    const unlockedRewards = await this.getMeta('unlockedRewards', []);
    const theme = await this.getMeta('activeTheme', 'default');
    return {
      exportedAt: new Date().toISOString(),
      app: 'Kernroutine',
      version: DB_VERSION,
      goals,
      checkins,
      meta: { points, unlockedRewards, theme }
    };
  },

  async resetAll() {
    const db = await this.init();
    const t = tx(db, ['goals', 'checkins', 'meta'], 'readwrite');
    t.objectStore('goals').clear();
    t.objectStore('checkins').clear();
    t.objectStore('meta').clear();
  }
};

window.KernroutineDB = KernroutineDB;
window.krUtils = { uuid, todayISO };
