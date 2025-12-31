// fix-database-complete.js
require('dotenv').config();
const { Pool } = require('pg');

// Configuration PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function createCompleteDatabase() {
  const client = await pool.connect();
  
  try {
    console.log('🚀 Création complète de la base de données...');
    
    await client.query('BEGIN');
    
    // 1. Table USERS - VERSION COMPLÈTE
    console.log('📋 Création table "users"...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id BIGINT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        plan TEXT DEFAULT NULL,
        plans TEXT[] DEFAULT '{}',
        main_balance NUMERIC DEFAULT 0,
        trading_balance NUMERIC DEFAULT 0,
        referral_balance NUMERIC DEFAULT 0,
        referral_earnings NUMERIC DEFAULT 0,
        deposited NUMERIC DEFAULT 0,
        referrer BIGINT,
        referrals INTEGER DEFAULT 0,
        valid_referrals INTEGER DEFAULT 0,
        wallet TEXT,
        last_claim BIGINT DEFAULT 0,
        last_withdraw BIGINT DEFAULT 0,
        last_daily_withdrawal DATE DEFAULT NULL,
        withdrawal_count_today INTEGER DEFAULT 0,
        free_plan_activated BOOLEAN DEFAULT FALSE,
        free_plan_expiry BIGINT DEFAULT 0,
        free_plan_requirements_met BOOLEAN DEFAULT FALSE,
        withdrawal_pending NUMERIC DEFAULT 0,
        withdrawal_status TEXT DEFAULT 'none',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        waitlist_position INTEGER DEFAULT NULL,
        waitlist_joined_at BIGINT DEFAULT NULL,
        waitlist_access_granted BOOLEAN DEFAULT FALSE,
        access_code_used TEXT DEFAULT NULL,
        referral_code TEXT UNIQUE,
        total_withdrawn NUMERIC DEFAULT 0,
        total_deposited_usdt NUMERIC DEFAULT 0,
        total_withdrawn_usdt NUMERIC DEFAULT 0,
        notification_settings JSONB DEFAULT '{"investment_reminders": true, "trading_updates": true, "plan_expiry": true, "referral_updates": true}',
        last_notification_sent TIMESTAMP DEFAULT NULL,
        last_investment_notification TIMESTAMP DEFAULT NULL,
        state TEXT DEFAULT 'idle',
        state_data JSONB DEFAULT '{}',
        total_trading_earnings NUMERIC DEFAULT 0,
        total_referral_earnings NUMERIC DEFAULT 0,
        lifetime_referral_earnings NUMERIC DEFAULT 0,
        lifetime_trading_earnings NUMERIC DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Table "users" créée');
    
    // 2. Table WITHDRAWALS
    console.log('📋 Création table "withdrawals"...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id SERIAL PRIMARY KEY,
        user_id BIGINT,
        amount NUMERIC,
        amount_usdt NUMERIC,
        fees NUMERIC DEFAULT 0,
        net_amount NUMERIC,
        net_amount_usdt NUMERIC,
        address TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP,
        admin_notes TEXT,
        txid TEXT,
        cancelled_by_admin BOOLEAN DEFAULT FALSE,
        user_approved BOOLEAN DEFAULT FALSE,
        fees_paid_by_user BOOLEAN DEFAULT TRUE
      )
    `);
    console.log('✅ Table "withdrawals" créée');
    
    // 3. Table TRANSACTIONS
    console.log('📋 Création table "transactions"...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id BIGINT,
        type TEXT,
        amount NUMERIC,
        amount_usdt NUMERIC,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Table "transactions" créée');
    
    // 4. Table PAYMENTS
    console.log('📋 Création table "payments"...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        user_id BIGINT,
        plan TEXT,
        amount NUMERIC,
        amount_usdt NUMERIC,
        payment_id TEXT UNIQUE,
        payment_method TEXT DEFAULT 'nowpayments',
        status TEXT DEFAULT 'pending',
        payment_url TEXT,
        invoice_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP
      )
    `);
    console.log('✅ Table "payments" créée');
    
    // 5. Table REFERRAL_EARNINGS
    console.log('📋 Création table "referral_earnings"...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS referral_earnings (
        id SERIAL PRIMARY KEY,
        referrer_id BIGINT,
        referral_id BIGINT,
        level INTEGER,
        amount NUMERIC,
        amount_usdt NUMERIC,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Table "referral_earnings" créée');
    
    // 6. Table FEE_LOGS
    console.log('📋 Création table "fee_logs"...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS fee_logs (
        id SERIAL PRIMARY KEY,
        user_id BIGINT,
        amount NUMERIC,
        amount_usdt NUMERIC,
        sol_price NUMERIC,
        fees_sol NUMERIC,
        fees_usd NUMERIC,
        net_amount NUMERIC,
        net_amount_usdt NUMERIC,
        rules TEXT,
        type TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Table "fee_logs" créée');
    
    // 7. Table VALID_REFERRALS
    console.log('📋 Création table "valid_referrals"...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS valid_referrals (
        id SERIAL PRIMARY KEY,
        referrer_id BIGINT,
        referral_id BIGINT,
        referral_plan TEXT,
        activated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Table "valid_referrals" créée');
    
    // 8. Table DEPOSITS
    console.log('📋 Création table "deposits"...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS deposits (
        id SERIAL PRIMARY KEY,
        user_id BIGINT,
        amount NUMERIC,
        amount_usdt NUMERIC,
        payment_id TEXT,
        invoice_id TEXT,
        order_id TEXT,
        payment_url TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Table "deposits" créée');
    
    // 9. Table USER_STATES
    console.log('📋 Création table "user_states"...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_states (
        user_id BIGINT PRIMARY KEY,
        state TEXT DEFAULT 'idle',
        data JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Table "user_states" créée');
    
    // 10. Création des INDEX
    console.log('🔗 Création des index...');
    
    const indexes = [
      // Index pour la table users
      'CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet)',
      'CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)',
      'CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer)',
      'CREATE INDEX IF NOT EXISTS idx_users_state ON users(state)',
      'CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan)',
      'CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at)',
      
      // Index pour la table withdrawals
      'CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status)',
      'CREATE INDEX IF NOT EXISTS idx_withdrawals_created_at ON withdrawals(created_at)',
      
      // Index pour la table transactions
      'CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type)',
      'CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at)',
      
      // Index pour la table payments
      'CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)',
      'CREATE INDEX IF NOT EXISTS idx_payments_plan ON payments(plan)',
      'CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at)',
      
      // Index pour la table referral_earnings
      'CREATE INDEX IF NOT EXISTS idx_referral_earnings_referrer_id ON referral_earnings(referrer_id)',
      'CREATE INDEX IF NOT EXISTS idx_referral_earnings_referral_id ON referral_earnings(referral_id)',
      
      // Index pour la table valid_referrals
      'CREATE INDEX IF NOT EXISTS idx_valid_referrals_referrer_id ON valid_referrals(referrer_id)',
      'CREATE INDEX IF NOT EXISTS idx_valid_referrals_referral_id ON valid_referrals(referral_id)'
    ];
    
    for (const indexSql of indexes) {
      try {
        await client.query(indexSql);
        console.log(`   ✅ Index créé: ${indexSql.split(' ON ')[1]}`);
      } catch (error) {
        console.log(`   ⚠️ Index existe déjà: ${indexSql.split(' ON ')[1]}`);
      }
    }
    
    // 11. Vérifier et ajouter les colonnes manquantes (au cas où)
    console.log('🔍 Vérification des colonnes manquantes...');
    
    const columnsToAdd = [
      { name: 'total_trading_earnings', type: 'NUMERIC', default: '0' },
      { name: 'total_referral_earnings', type: 'NUMERIC', default: '0' },
      { name: 'lifetime_referral_earnings', type: 'NUMERIC', default: '0' },
      { name: 'lifetime_trading_earnings', type: 'NUMERIC', default: '0' }
    ];
    
    for (const column of columnsToAdd) {
      try {
        // Vérifier si la colonne existe
        const check = await client.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'users' AND column_name = $1
        `, [column.name]);
        
        if (check.rows.length === 0) {
          await client.query(`
            ALTER TABLE users 
            ADD COLUMN ${column.name} ${column.type} DEFAULT ${column.default}
          `);
          console.log(`   ✅ Colonne ${column.name} ajoutée`);
        }
      } catch (error) {
        console.log(`   ℹ️ Colonne ${column.name} déjà présente`);
      }
    }
    
    await client.query('COMMIT');
    
    console.log('\n🎉 BASE DE DONNÉES CRÉÉE AVEC SUCCÈS !');
    console.log('=========================================');
    console.log('📊 Tables créées :');
    console.log('   1. users (utilisateurs)');
    console.log('   2. withdrawals (retraits)');
    console.log('   3. transactions (transactions)');
    console.log('   4. payments (paiements)');
    console.log('   5. referral_earnings (gains parrainage)');
    console.log('   6. fee_logs (logs de frais)');
    console.log('   7. valid_referrals (parrainages valides)');
    console.log('   8. deposits (dépôts)');
    console.log('   9. user_states (états utilisateurs)');
    console.log('\n✅ Votre bot est prêt à fonctionner !');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ ERREUR lors de la création :', error.message);
    console.error('Stack:', error.stack);
    throw error;
  } finally {
    client.release();
  }
}

// Fonction pour vérifier l'état actuel
async function checkCurrentState() {
  try {
    console.log('🔍 Vérification de l\'état actuel...');
    
    const tables = [
      'users', 'withdrawals', 'transactions', 'payments',
      'referral_earnings', 'fee_logs', 'valid_referrals',
      'deposits', 'user_states'
    ];
    
    for (const table of tables) {
      try {
        const result = await pool.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_name = '${table}' 
            AND table_schema = 'public'
          )
        `);
        
        if (result.rows[0].exists) {
          console.log(`   ✅ Table "${table}" existe`);
          
          // Compter les lignes
          const countResult = await pool.query(`SELECT COUNT(*) FROM ${table}`);
          console.log(`      📊 Lignes: ${countResult.rows[0].count}`);
        } else {
          console.log(`   ❌ Table "${table}" n'existe pas`);
        }
      } catch (error) {
        console.log(`   ⚠️ Erreur vérification table "${table}": ${error.message}`);
      }
    }
    
  } catch (error) {
    console.error('Erreur vérification état:', error.message);
  }
}

// Fonction pour supprimer et recréer (DANGEREUX - données perdues)
async function recreateDatabase() {
  const confirm = require('readline-sync').question(
    '⚠️  ATTENTION: Cela va supprimer TOUTES les données !\n' +
    'Êtes-vous sûr ? (tapez "OUI" pour confirmer): '
  );
  
  if (confirm !== 'OUI') {
    console.log('❌ Annulé.');
    return;
  }
  
  const client = await pool.connect();
  
  try {
    console.log('🗑️  Suppression des tables...');
    await client.query('BEGIN');
    
    // Supprimer dans l'ordre inverse des dépendances
    const tablesToDrop = [
      'user_states', 'deposits', 'valid_referrals', 'fee_logs',
      'referral_earnings', 'payments', 'transactions', 'withdrawals', 'users'
    ];
    
    for (const table of tablesToDrop) {
      try {
        await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
        console.log(`   ✅ Table "${table}" supprimée`);
      } catch (error) {
        console.log(`   ⚠️ Erreur suppression "${table}": ${error.message}`);
      }
    }
    
    await client.query('COMMIT');
    console.log('✅ Toutes les tables supprimées');
    
    // Recréer
    await createCompleteDatabase();
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Erreur:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

// Menu principal
async function main() {
  console.clear();
  console.log('🛠️  OUTIL DE GESTION DE BASE DE DONNÉES');
  console.log('=========================================\n');
  
  const readline = require('readline-sync');
  
  console.log('Options disponibles:');
  console.log('1. Vérifier l\'état actuel');
  console.log('2. Créer les tables manquantes');
  console.log('3. RECRÉER COMPLÈTEMENT (supprime tout !)');
  console.log('4. Quitter');
  
  const choice = readline.question('\nVotre choix (1-4): ');
  
  switch(choice) {
    case '1':
      await checkCurrentState();
      break;
    case '2':
      await createCompleteDatabase();
      break;
    case '3':
      await recreateDatabase();
      break;
    case '4':
      console.log('👋 Au revoir !');
      process.exit(0);
      break;
    default:
      console.log('❌ Choix invalide');
  }
  
  // Demander si continuer
  const continueChoice = readline.question('\nVoulez-vous effectuer une autre opération ? (o/n): ');
  if (continueChoice.toLowerCase() === 'o') {
    await main();
  } else {
    console.log('👋 Fermeture...');
    await pool.end();
    process.exit(0);
  }
}

// Gestion des erreurs non capturées
process.on('uncaughtException', (error) => {
  console.error('💥 Erreur non capturée:', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Rejet non géré:', reason);
  process.exit(1);
});

// Exécuter le menu
if (require.main === module) {
  main().catch(error => {
    console.error('💥 Erreur fatale:', error.message);
    process.exit(1);
  });
}

module.exports = { createCompleteDatabase, checkCurrentState };
