const initSqlJs = require('sql.js');
const { Pool } = require('pg');
const fs = require('fs');

class Database {
  constructor(config) {
    this.config = config;
    this.db = null;
    this._dirty = false;
    this._autoSaveInterval = null;
    this._closed = false;
    this._mode = 'sqlite';
    this._pgPool = null;
  }

  async open() {
    const dbUrl = process.env.DATABASE_URL || this.config;

    if (dbUrl && (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://'))) {
      this._mode = 'pg';
      this._pgPool = new Pool({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false }
      });
      const client = await this._pgPool.connect();
      client.release();
      console.log('Connected to PostgreSQL');
      return this;
    }

    // SQLite mode
    const SQL = await initSqlJs();
    const dbPath = this.config;
    if (fs.existsSync(dbPath)) {
      this.db = new SQL.Database(fs.readFileSync(dbPath));
    } else {
      this.db = new SQL.Database();
    }

    this._autoSaveInterval = setInterval(() => {
      if (this._dirty && !this._closed) this._save();
    }, 30000);

    const shutdown = () => {
      if (!this._closed) {
        if (this._autoSaveInterval) {
          clearInterval(this._autoSaveInterval);
          this._autoSaveInterval = null;
        }
        this._save();
        this._closed = true;
        if (this.db) { this.db.close(); this.db = null; }
      }
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('exit', () => {
      if (this._dirty && this.db && !this._closed) {
        try { fs.writeFileSync(this.config, Buffer.from(this.db.export())); } catch (e) {}
      }
    });

    return this;
  }

  _convertSql(sql) {
    if (this._mode !== 'pg') return sql;

    let result = sql;
    // INTEGER PRIMARY KEY AUTOINCREMENT -> SERIAL PRIMARY KEY
    result = result.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'SERIAL PRIMARY KEY');
    // INSERT OR IGNORE INTO -> INSERT INTO ... ON CONFLICT DO NOTHING
    result = result.replace(/INSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO');
    if (/^INSERT\s+INTO\b/i.test(result.trim()) && !/ON\s+CONFLICT/i.test(result)) {
      result = result.replace(/;\s*$/, '') + ' ON CONFLICT DO NOTHING';
    }
    // datetime('now') -> NOW()
    result = result.replace(/datetime\s*\(\s*'now'\s*\)\s*/gi, 'NOW()');
    // PRAGMA statements -> skip
    result = result.replace(/PRAGMA\s+.+/gi, 'SELECT 1');
    // ? placeholders -> $1, $2, ...
    let idx = 0;
    result = result.replace(/\?/g, () => `$${++idx}`);
    // String empty string '' for null (PG specific)
    return result;
  }

  prepare(sql) {
    const self = this;

    if (this._mode === 'pg') {
      const pgSql = this._convertSql(sql);
      return {
        async get(...params) {
          try {
            const result = await self._pgPool.query(pgSql, params);
            return result.rows[0] || null;
          } catch (e) {
            console.error('PG get error:', e.message, 'SQL:', pgSql, 'Params:', params);
            throw e;
          }
        },
        async all(...params) {
          try {
            const result = await self._pgPool.query(pgSql, params);
            return result.rows;
          } catch (e) {
            console.error('PG all error:', e.message, 'SQL:', pgSql, 'Params:', params);
            throw e;
          }
        },
        async run(...params) {
          try {
            let finalSql = pgSql;
            const isInsert = /^INSERT\s+INTO\b/i.test(finalSql.trim());
            if (isInsert && !/RETURNING\s/i.test(finalSql)) {
              finalSql = finalSql.replace(/;\s*$/, '') + ' RETURNING id';
            }
            const result = await self._pgPool.query(finalSql, params);
            return { lastInsertRowid: result.rows[0]?.id || null };
          } catch (e) {
            console.error('PG run error:', e.message, 'SQL:', pgSql, 'Params:', params);
            throw e;
          }
        }
      };
    }

    // SQLite mode
    return {
      get(...params) {
        const stmt = self.db.prepare(sql);
        if (params.length) stmt.bind(params);
        if (stmt.step()) {
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        }
        stmt.free();
      },
      all(...params) {
        const stmt = self.db.prepare(sql);
        if (params.length) stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
      },
      run(...params) {
        self.db.run(sql, params);
        self._markDirty();
        const result = self.db.exec('SELECT last_insert_rowid()');
        return { lastInsertRowid: result[0]?.values[0][0] };
      }
    };
  }

  exec(sql) {
    if (this._mode === 'pg') {
      const pgSql = this._convertSql(sql);
      return this._pgPool.query(pgSql);
    }
    this.db.exec(sql);
    this._markDirty();
  }

  pragma(str) {
    if (this._mode !== 'pg') {
      this.db.exec('PRAGMA ' + str);
    }
  }

  async close() {
    if (this._mode === 'pg') {
      await this._pgPool.end();
      return;
    }
    if (this._autoSaveInterval) {
      clearInterval(this._autoSaveInterval);
      this._autoSaveInterval = null;
    }
    this._save();
    this._closed = true;
    if (this.db) { this.db.close(); this.db = null; }
  }

  _markDirty() {
    this._dirty = true;
  }

  _save() {
    if (!this._dirty || this._closed) return;
    try {
      fs.writeFileSync(this.config, Buffer.from(this.db.export()));
      this._dirty = false;
    } catch (e) {
      console.error('Failed to save database:', e.message);
    }
  }
}

module.exports = Database;
