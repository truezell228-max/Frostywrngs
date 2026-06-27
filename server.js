const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Database = require('./db');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 80;
let db;

// Keep-alive: пингуем сами себя каждые 10 мин, чтобы Render не вырубал
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (SELF_URL) {
  console.log('Keep-alive enabled, pinging:', SELF_URL);
  setInterval(async () => {
    try {
      const start = Date.now();
      await fetch(SELF_URL, { signal: AbortSignal.timeout(15000) });
      console.log('Self-ping OK (' + (Date.now() - start) + 'ms)');
    } catch (e) {
      console.error('Self-ping failed:', e.message);
    }
  }, 10 * 60 * 1000);
}

async function start() {
  db = await new Database(path.join(__dirname, 'snoser.db')).open();

  // PRAGMA только для SQLite, для PG игнорируется
  db.pragma('journal_mode = WAL');

  await db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT \'user\', banned INTEGER NOT NULL DEFAULT 0, subscription_expires_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  await db.exec('CREATE TABLE IF NOT EXISTS attacks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'active\', success_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0, total_sent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')), FOREIGN KEY (user_id) REFERENCES users(id))');
  await db.exec('CREATE TABLE IF NOT EXISTS subscription_keys (key TEXT PRIMARY KEY, duration_type TEXT NOT NULL, duration_days INTEGER NOT NULL, used_by INTEGER, used_at TEXT, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')), FOREIGN KEY (used_by) REFERENCES users(id), FOREIGN KEY (created_by) REFERENCES users(id))');
  await db.exec('CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  await db.prepare("INSERT OR IGNORE INTO site_config (key, value) VALUES ('maintenance_mode', '0')").run();

  const [adminPassword, userPassword] = await Promise.all([
    bcrypt.hash('tim10080', 10),
    bcrypt.hash('user123', 10)
  ]);
  await db.prepare('INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)').run('admin', adminPassword, 'admin');
  await db.prepare('INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)').run('demo', userPassword, 'user');
  const adminUser = await db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  if (adminUser) {
    await db.prepare("UPDATE users SET subscription_expires_at = '9999-12-31 23:59:59' WHERE id = ?").run(adminUser.id);
  }

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.use(session({
    store: new PgSession({
      conString: process.env.DATABASE_URL,
      createTableIfMissing: true
    }),
    secret: process.env.SESSION_SECRET || 'snoser_secret_key_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
  }));

  async function isAuth(req, res, next) {
    if (!req.session.user) return res.redirect('/login');
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    if (!user || user.banned) {
      req.session.destroy();
      return res.redirect('/login?banned=1');
    }
    req.session.user = user;
    req.user = user;
    next();
  }

  async function isAdmin(req, res, next) {
    if (!req.session.user) return res.redirect('/login');
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    if (!user || user.role !== 'admin') return res.status(403).send('Forbidden');
    req.session.user = user;
    req.user = user;
    next();
  }

  // ===== PAGES =====
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
  app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
  app.get('/dashboard', isAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
  app.get('/admin', isAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

  // ===== API: AUTH =====
  app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || username.length < 3 || password.length < 4) {
      return res.json({ ok: false, error: 'Минимум 3 символа для логина и 4 для пароля' });
    }
    const exists = await db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (exists) return res.json({ ok: false, error: 'Пользователь уже существует' });

    const hash = await bcrypt.hash(password, 10);
    await db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hash);
    const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    req.session.user = user;
    res.json({ ok: true });
  });

  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return res.json({ ok: false, error: 'Неверный логин или пароль' });
    if (user.banned) return res.json({ ok: false, error: 'Аккаунт заблокирован' });
    if (!bcrypt.compareSync(password, user.password)) {
      return res.json({ ok: false, error: 'Неверный логин или пароль' });
    }
    req.session.user = user;
    res.json({ ok: true, role: user.role });
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    if (!req.session.user) return res.json({ ok: false });
    const user = req.session.user;
    if (user.banned) {
      req.session.destroy();
      return res.json({ ok: false });
    }
    const now = new Date().toISOString();
    const hasSub = user.subscription_expires_at && user.subscription_expires_at > now;
    res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role, banned: user.banned, subscription_expires_at: user.subscription_expires_at, has_subscription: !!hasSub } });
  });

  app.get('/api/user-attacks', isAuth, async (req, res) => {
    const attacks = await db.prepare('SELECT * FROM attacks WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(req.user.id);
    res.json(attacks);
  });

  function hasActiveSubscription(user) {
    if (!user.subscription_expires_at) return false;
    return user.subscription_expires_at > new Date().toISOString();
  }

  // ===== API: PUBLIC STATS =====
  app.get('/api/stats', async (req, res) => {
    const totalAttacks = await db.prepare('SELECT COUNT(*) as c FROM attacks').get();
    const totalSent = await db.prepare('SELECT COALESCE(SUM(total_sent), 0) as c FROM attacks').get();
    const maintenance = await db.prepare("SELECT value FROM site_config WHERE key = 'maintenance_mode'").get();
    res.json({ sessionsOnline: 368, totalAttacks: totalAttacks.c, totalSent: totalSent.c, maintenance: maintenance && maintenance.value === '1' });
  });

  // ===== API: ATTACK =====
  app.post('/api/attack', isAuth, async (req, res) => {
    const { target, reason } = req.body;
    if (!target || !reason) return res.json({ ok: false, error: 'Заполните все поля' });

    const maintenance = await db.prepare("SELECT value FROM site_config WHERE key = 'maintenance_mode'").get();
    if (maintenance && maintenance.value === '1') {
      if (req.user.role !== 'admin') {
        return res.json({ ok: false, error: 'Сайт на технических работах. Попробуйте позже.' });
      }
    }

    const lastAttack = await db.prepare("SELECT created_at FROM attacks WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(req.user.id);
    if (lastAttack) {
      const lastTime = new Date(lastAttack.created_at.replace(' ', 'T')).getTime();
      const now = Date.now();
      const diff = now - lastTime;
      const cooldownMs = 10 * 60 * 1000;
      if (diff < cooldownMs) {
        const remaining = Math.ceil((cooldownMs - diff) / 1000 / 60);
        if (req.user.role !== 'admin') {
          return res.json({ ok: false, error: 'Подождите ' + remaining + ' мин перед следующей атакой' });
        }
      }
    }

    if (!hasActiveSubscription(req.user)) {
      return res.json({ ok: false, error: 'Необходима подписка для запуска атаки. Приобретите ключ в панели.' });
    }

    const attack = await db.prepare('INSERT INTO attacks (user_id, target, reason) VALUES (?, ?, ?)').run(req.user.id, target, reason);
    const attackId = attack.lastInsertRowid;

    const totalSessions = 50 + Math.floor(Math.random() * 319);
    const invalidRate = Math.random() * 0.3 + 0.05;
    const wavesCount = 8 + Math.floor(Math.random() * 8);
    const sessionsPerWave = Math.floor(totalSessions / wavesCount);
    let sentSoFar = 0, successCount = 0, errorCount = 0;
    let wave = 0;

    const interval = setInterval(async () => {
      if (wave >= wavesCount || sentSoFar >= totalSessions) {
        clearInterval(interval);
        const status = errorCount === 0 ? 'completed' : 'completed_with_errors';
        await db.prepare('UPDATE attacks SET status = ?, success_count = ?, error_count = ?, total_sent = ? WHERE id = ?')
          .run(status, successCount, errorCount, successCount + errorCount, attackId);
        return;
      }
      wave++;
      const batch = Math.min(sessionsPerWave + Math.floor(Math.random() * 6) - 2, totalSessions - sentSoFar);
      let bs = 0, be = 0;
      for (let i = 0; i < batch; i++) {
        Math.random() > invalidRate ? (bs++, successCount++) : (be++, errorCount++);
      }
      sentSoFar += batch;
      await db.prepare('UPDATE attacks SET success_count = ?, error_count = ?, total_sent = ? WHERE id = ?')
        .run(successCount, errorCount, sentSoFar, attackId);
    }, 500 + Math.random() * 500);

    res.json({ ok: true, attackId, totalSessions });
  });

  // ===== API: ADMIN =====
  app.get('/api/admin/users', isAdmin, async (req, res) => {
    const users = await db.prepare('SELECT id, username, role, banned, subscription_expires_at, created_at FROM users ORDER BY id').all();
    res.json(users);
  });

  app.get('/api/admin/reports', isAdmin, async (req, res) => {
    const totalUsers = await db.prepare('SELECT COUNT(*) as c FROM users').get();
    const totalAttacks = await db.prepare('SELECT COUNT(*) as c FROM attacks').get();
    const completedAttacks = await db.prepare("SELECT COUNT(*) as c FROM attacks WHERE status LIKE 'completed%'").get();
    const totalSent = await db.prepare('SELECT COALESCE(SUM(total_sent), 0) as c FROM attacks').get();
    res.json({ totalUsers: totalUsers.c, totalAttacks: totalAttacks.c, completedAttacks: completedAttacks.c, totalSent: totalSent.c });
  });

  app.post('/api/admin/toggle-ban', isAdmin, async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.json({ ok: false });
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || user.username === 'admin') return res.json({ ok: false, error: 'Нельзя заблокировать главного администратора' });
    const newStatus = user.banned ? 0 : 1;
    await db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(newStatus, userId);
    res.json({ ok: true, banned: !!newStatus });
  });

  app.post('/api/admin/set-admin', isAdmin, async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.json({ ok: false, error: 'Укажите пользователя' });
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.json({ ok: false, error: 'Пользователь не найден' });
    if (user.role === 'admin') return res.json({ ok: false, error: 'Пользователь уже администратор' });
    await db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', userId);
    res.json({ ok: true });
  });

  app.post('/api/admin/remove-admin', isAdmin, async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.json({ ok: false, error: 'Укажите пользователя' });
    if (req.user.username !== 'admin') return res.json({ ok: false, error: 'Только главный администратор может снимать админов' });
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.json({ ok: false, error: 'Пользователь не найден' });
    if (user.username === 'admin') return res.json({ ok: false, error: 'Нельзя снять права главного администратора' });
    if (user.role !== 'admin') return res.json({ ok: false, error: 'Пользователь не является администратором' });
    await db.prepare('UPDATE users SET role = ? WHERE id = ?').run('user', userId);
    res.json({ ok: true });
  });

  app.post('/api/admin/create-key', isAdmin, async (req, res) => {
    const { duration } = req.body;
    if (!duration) return res.json({ ok: false, error: 'Укажите длительность' });

    const durations = {
      day: { type: 'day', days: 1 },
      week: { type: 'week', days: 7 },
      month: { type: 'month', days: 30 },
      forever: { type: 'forever', days: 99999 }
    };

    const cfg = durations[duration];
    if (!cfg) return res.json({ ok: false, error: 'Неверный тип подписки' });

    const key = crypto.randomBytes(16).toString('hex');
    await db.prepare('INSERT INTO subscription_keys (key, duration_type, duration_days, created_by) VALUES (?, ?, ?, ?)')
      .run(key, cfg.type, cfg.days, req.user.id);

    res.json({ ok: true, key });
  });

  app.post('/api/admin/set-subscription', isAdmin, async (req, res) => {
    if (req.user.username !== 'admin') return res.json({ ok: false, error: 'Только главный администратор может выдавать подписки' });
    const { userId, durationType } = req.body;
    if (!userId || !durationType) return res.json({ ok: false, error: 'Заполните все поля' });

    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.json({ ok: false, error: 'Пользователь не найден' });

    const durations = {
      day: 1,
      week: 7,
      month: 30,
      forever: 99999
    };

    const days = durations[durationType];
    if (!days) return res.json({ ok: false, error: 'Неверный тип подписки' });

    let expiresAt;
    if (durationType === 'forever') {
      expiresAt = '9999-12-31 23:59:59';
    } else {
      const d = new Date();
      d.setDate(d.getDate() + days);
      expiresAt = d.toISOString().replace('T', ' ').substring(0, 19);
    }

    await db.prepare('UPDATE users SET subscription_expires_at = ? WHERE id = ?').run(expiresAt, userId);
    res.json({ ok: true, expires_at: expiresAt });
  });

  app.post('/api/admin/remove-subscription', isAdmin, async (req, res) => {
    if (req.user.username !== 'admin') return res.json({ ok: false, error: 'Только главный администратор может забирать подписки' });
    const { userId } = req.body;
    if (!userId) return res.json({ ok: false, error: 'Укажите пользователя' });
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.json({ ok: false, error: 'Пользователь не найден' });
    if (!user.subscription_expires_at) return res.json({ ok: false, error: 'У пользователя нет подписки' });
    await db.prepare("UPDATE users SET subscription_expires_at = NULL WHERE id = ?").run(userId);
    res.json({ ok: true });
  });

  app.get('/api/admin/keys', isAdmin, async (req, res) => {
    const keys = await db.prepare('SELECT sk.key, sk.duration_type, sk.duration_days, sk.used_by, sk.used_at, sk.created_at, u.username AS used_by_username FROM subscription_keys sk LEFT JOIN users u ON sk.used_by = u.id ORDER BY sk.created_at DESC LIMIT 100').all();
    res.json(keys);
  });

  app.get('/api/admin/user-attacks/:userId', isAdmin, async (req, res) => {
    const userId = parseInt(req.params.userId);
    if (!userId) return res.json({ ok: false, error: 'Укажите пользователя' });
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.json({ ok: false, error: 'Пользователь не найден' });
    const attacks = await db.prepare('SELECT * FROM attacks WHERE user_id = ? ORDER BY created_at DESC').all(userId);
    const totalAttacks = attacks.length;
    const completedAttacks = attacks.filter(a => a.status.startsWith('completed')).length;
    const totalSuccess = attacks.reduce((s, a) => s + a.success_count, 0);
    const totalErrors = attacks.reduce((s, a) => s + a.error_count, 0);
    const totalSent = attacks.reduce((s, a) => s + a.total_sent, 0);
    res.json({ ok: true, user: { id: user.id, username: user.username }, stats: { totalAttacks, completedAttacks, totalSuccess, totalErrors, totalSent }, attacks });
  });

  app.get('/api/admin/maintenance-status', isAdmin, async (req, res) => {
    const row = await db.prepare("SELECT value FROM site_config WHERE key = 'maintenance_mode'").get();
    res.json({ maintenance: row && row.value === '1' });
  });

  app.post('/api/admin/toggle-maintenance', isAdmin, async (req, res) => {
    if (req.user.username !== 'admin') return res.json({ ok: false, error: 'Только главный администратор может управлять тех.работами' });
    const row = await db.prepare("SELECT value FROM site_config WHERE key = 'maintenance_mode'").get();
    const current = row && row.value === '1';
    const newVal = current ? '0' : '1';
    await db.prepare("UPDATE site_config SET value = ? WHERE key = 'maintenance_mode'").run(newVal);
    res.json({ ok: true, maintenance: newVal === '1' });
  });

  // ===== API: SUBSCRIPTION =====
  app.post('/api/activate-key', isAuth, async (req, res) => {
    const { key } = req.body;
    if (!key) return res.json({ ok: false, error: 'Введите ключ' });

    const row = await db.prepare('SELECT * FROM subscription_keys WHERE key = ?').get(key);
    if (!row) return res.json({ ok: false, error: 'Неверный ключ' });
    if (row.used_by) return res.json({ ok: false, error: 'Ключ уже использован' });

    let expiresAt;
    if (row.duration_type === 'forever') {
      expiresAt = '9999-12-31 23:59:59';
    } else {
      const d = new Date();
      d.setDate(d.getDate() + row.duration_days);
      expiresAt = d.toISOString().replace('T', ' ').substring(0, 19);
    }

    await db.prepare('UPDATE subscription_keys SET used_by = ?, used_at = datetime(\'now\') WHERE key = ?').run(req.user.id, key);
    await db.prepare('UPDATE users SET subscription_expires_at = ? WHERE id = ?').run(expiresAt, req.user.id);

    res.json({ ok: true, expires_at: expiresAt });
  });

  app.listen(PORT, () => {
    console.log('Frosty server running at http://localhost:' + PORT);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});

module.exports = app;
