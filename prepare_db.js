
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./users.db');

console.log('🔄 Préparation de la base de données pour le système de compte secondaire...');

db.serialize(() => {
  // 1. Ajouter secondary_balance à la table users
  db.run(`ALTER TABLE users ADD COLUMN secondary_balance DECIMAL(15, 8) DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('❌ Erreur avec secondary_balance:', err.message);
    } else {
      console.log('✅ Colonne secondary_balance OK');
    }
  });
  
  // 2. Ajouter plan_transferred à la table users
  db.run(`ALTER TABLE users ADD COLUMN plan_transferred DECIMAL(15, 8) DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('❌ Erreur avec plan_transferred:', err.message);
    } else {
      console.log('✅ Colonne plan_transferred OK');
    }
  });
  
  // 3. Ajouter transfer_type à la table transactions
  db.run(`ALTER TABLE transactions ADD COLUMN transfer_type VARCHAR(50) DEFAULT 'normal'`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('❌ Erreur avec transfer_type:', err.message);
    } else {
      console.log('✅ Colonne transfer_type OK');
    }
  });
  
  // 4. Créer la table withdrawals si elle n'existe pas
  db.run(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount DECIMAL(15, 8) NOT NULL,
      wallet_address TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      withdrawal_id VARCHAR(50) UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      processed_at TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
  `, (err) => {
    if (err) {
      console.error('❌ Erreur création table withdrawals:', err.message);
    } else {
      console.log('✅ Table withdrawals OK');
    }
  });
});

db.close(() => {
  console.log('\n🎉 Base de données prête pour le système de compte secondaire!');
  console.log('➡️ Maintenant, mettez à jour votre bot.js avec le code fourni.');
});

