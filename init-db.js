const Database = require('./db');
const bcrypt = require('bcryptjs');
const path = require('path');

async function init() {
  const db = await new Database(path.join(__dirname, 'snoser.db')).open();
  db.pragma('journal_mode = WAL');

  await db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT \'user\', banned INTEGER NOT NULL DEFAULT 0, subscription_expires_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  await db.exec('CREATE TABLE IF NOT EXISTS attacks (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'active\', success_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0, total_sent INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')), FOREIGN KEY (user_id) REFERENCES users(id))');
  await db.exec('CREATE TABLE IF NOT EXISTS subscription_keys (key TEXT PRIMARY KEY, duration_type TEXT NOT NULL, duration_days INTEGER NOT NULL, used_by INTEGER, used_at TEXT, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')), FOREIGN KEY (used_by) REFERENCES users(id), FOREIGN KEY (created_by) REFERENCES users(id))');

  try {
    await db.exec('ALTER TABLE users ADD COLUMN subscription_expires_at TEXT');
  } catch (e) {
    // column already exists
  }

  try {
    await db.exec('CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await db.prepare("INSERT OR IGNORE INTO site_config (key, value) VALUES ('maintenance_mode', '0')").run();
  } catch (e) {}

  // Асинхронный bcrypt — не блокирует event loop
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

  await db.close();
  console.log('Database initialized. Admin: admin / tim10080 | Demo: demo / user123');
}

init().catch(err => {
  console.error('Init failed:', err);
  process.exit(1);
});