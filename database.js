const sqlite3 = require('sqlite3').verbose();

async function setupDatabase(dbPath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) { reject(err); return; }

            db.serialize(() => {
                db.run(`
                    CREATE TABLE IF NOT EXISTS trades (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        initiator_id TEXT NOT NULL,
                        recipient_id TEXT NOT NULL,
                        description TEXT NOT NULL,
                        status TEXT DEFAULT 'pending',
                        created_at DATETIME DEFAULT (datetime('now')),
                        confirmed_at DATETIME NULL,
                        expires_at DATETIME NULL,
                        guild_id TEXT NOT NULL,
                        channel_id TEXT NOT NULL
                    )
                `);

                db.run(`
                    CREATE TABLE IF NOT EXISTS trade_confirmations (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        trade_id INTEGER NOT NULL,
                        user_id TEXT NOT NULL,
                        confirmed BOOLEAN DEFAULT FALSE,
                        confirmed_at DATETIME NULL,
                        FOREIGN KEY (trade_id) REFERENCES trades (id)
                    )
                `);

                db.run(`
                    CREATE TABLE IF NOT EXISTS trade_reports (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        trade_id INTEGER NOT NULL,
                        reporter_id TEXT NOT NULL,
                        reported_user_id TEXT NOT NULL,
                        reason TEXT NOT NULL,
                        description TEXT,
                        status TEXT DEFAULT 'pending',
                        created_at DATETIME DEFAULT (datetime('now')),
                        resolved_at DATETIME NULL,
                        resolved_by TEXT NULL,
                        guild_id TEXT NOT NULL,
                        FOREIGN KEY (trade_id) REFERENCES trades (id)
                    )
                `);

                db.run(`
                    CREATE TABLE IF NOT EXISTS user_warnings (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id TEXT NOT NULL,
                        moderator_id TEXT NOT NULL,
                        reason TEXT NOT NULL,
                        created_at DATETIME DEFAULT (datetime('now')),
                        guild_id TEXT NOT NULL
                    )
                `);

                db.run(`
                    CREATE TABLE IF NOT EXISTS scammer_list (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id TEXT NOT NULL,
                        moderator_id TEXT NOT NULL,
                        reason TEXT NOT NULL,
                        marked_at DATETIME DEFAULT (datetime('now')),
                        guild_id TEXT NOT NULL,
                        UNIQUE(user_id, guild_id)
                    )
                `);

                db.run(`
                    CREATE TABLE IF NOT EXISTS config (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    )
                `, (err) => {
                    if (err) reject(err);
                    else resolve(db);
                });
            });
        });
    });
}

async function cleanupExpiredTrades(db) {
    const now = new Date().toISOString();
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE trades SET status = 'expired' WHERE status = 'pending' AND expires_at < ? AND expires_at IS NOT NULL`,
            [now],
            (err) => {
                if (err) {
                    console.error('Error cleaning up expired trades:', err);
                    reject(err);
                } else {
                    console.log('Cleaned up expired trades');
                    resolve();
                }
            }
        );
    });
}

module.exports = { setupDatabase, cleanupExpiredTrades };
