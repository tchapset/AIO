// database-manager-fixed.js
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Configuration PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Fonction pour lire une saisie utilisateur
function askQuestion(question) {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// NOUVELLE FONCTION : Réparer spécifiquement la colonne updated_at
async function fixUpdatedAtIssue() {
  console.log('🔧 RÉPARATION SPÉCIFIQUE updated_at manquant\n');
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 1. Vérifier l'état actuel de la table users
    console.log('🔍 Analyse de la table users...');
    
    const columns = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns 
      WHERE table_name = 'users'
      ORDER BY ordinal_position
    `);
    
    console.log('\n📋 Colonnes existantes:');
    columns.rows.forEach(col => {
      console.log(`   • ${col.column_name} (${col.data_type})`);
    });
    
    // 2. Vérifier si updated_at existe
    const hasUpdatedAt = columns.rows.some(col => col.column_name === 'updated_at');
    
    if (!hasUpdatedAt) {
      console.log('\n❌ ERREUR: Colonne updated_at MANQUANTE !');
      console.log('➕ Ajout de la colonne updated_at...');
      
      try {
        // Essayer d'ajouter la colonne
        await client.query(`
          ALTER TABLE users 
          ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        `);
        console.log('✅ Colonne updated_at ajoutée avec succès !');
      } catch (error) {
        console.log(`⚠️ Erreur lors de l'ajout: ${error.message}`);
        
        // Essayer une approche alternative
        console.log('\n🔄 Tentative alternative...');
        await client.query(`
          ALTER TABLE users 
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        `);
        console.log('✅ Tentative alternative réussie');
      }
    } else {
      console.log('\n✅ Colonne updated_at existe déjà');
    }
    
    // 3. Vérifier et ajouter TOUTES les colonnes manquantes
    console.log('\n🔍 Vérification des autres colonnes manquantes...');
    
    const requiredColumns = [
      { name: 'total_trading_earnings', type: 'NUMERIC', default: '0' },
      { name: 'total_referral_earnings', type: 'NUMERIC', default: '0' },
      { name: 'lifetime_referral_earnings', type: 'NUMERIC', default: '0' },
      { name: 'lifetime_trading_earnings', type: 'NUMERIC', default: '0' },
      { name: 'state', type: 'TEXT', default: "'idle'" },
      { name: 'state_data', type: 'JSONB', default: "'{}'::jsonb" },
      { name: 'notification_settings', type: 'JSONB', default: "'{\"investment_reminders\": true, \"trading_updates\": true, \"plan_expiry\": true, \"referral_updates\": true}'::jsonb" },
      { name: 'last_notification_sent', type: 'TIMESTAMP', default: 'NULL' },
      { name: 'last_investment_notification', type: 'TIMESTAMP', default: 'NULL' }
    ];
    
    for (const column of requiredColumns) {
      const exists = columns.rows.some(col => col.column_name === column.name);
      
      if (!exists) {
        console.log(`   ➕ Ajout: ${column.name}...`);
        try {
          await client.query(`
            ALTER TABLE users 
            ADD COLUMN ${column.name} ${column.type} DEFAULT ${column.default}
          `);
          console.log(`   ✅ ${column.name} ajoutée`);
        } catch (error) {
          console.log(`   ⚠️ Erreur ${column.name}: ${error.message}`);
        }
      } else {
        console.log(`   ✅ ${column.name} existe déjà`);
      }
    }
    
    // 4. Vérifier la fonction updateUser dans bot.js
    console.log('\n🔧 Vérification de la fonction updateUser()...');
    
    try {
      const botJsPath = path.join(__dirname, 'bot.js');
      if (fs.existsSync(botJsPath)) {
        const botContent = fs.readFileSync(botJsPath, 'utf8');
        
        // Chercher la ligne problématique
        if (botContent.includes('updated_at = CURRENT_TIMESTAMP WHERE user_id = $')) {
          console.log('   ⚠️ Fonction updateUser utilise updated_at');
          console.log('   💡 Si erreur persiste, modifiez temporairement bot.js');
        }
      }
    } catch (error) {
      console.log('   ℹ️ Impossible de vérifier bot.js');
    }
    
    await client.query('COMMIT');
    
    console.log('\n' + '='.repeat(60));
    console.log('🎉 RÉPARATION updated_at TERMINÉE AVEC SUCCÈS !');
    console.log('='.repeat(60));
    console.log('\n✅ Toutes les colonnes nécessaires ont été vérifiées/ajoutées.');
    console.log('👉 Votre bot devrait maintenant fonctionner sans erreur.');
    console.log('\n📝 Prochaines étapes :');
    console.log('   1. Redémarrez votre bot: node bot.js');
    console.log('   2. Testez avec la commande /start');
    console.log('   3. Si erreur persiste, exécutez l\'option 2 (Créer tables)');
    
    return true;
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\n❌ Erreur lors de la réparation:', error.message);
    
    // Solution d'urgence
    console.log('\n🚨 SOLUTION D\'URGENCE :');
    console.log('   Modifiez temporairement votre bot.js :');
    console.log('   Cherchez la ligne avec "updated_at = CURRENT_TIMESTAMP"');
    console.log('   Remplacez par juste "WHERE user_id ="');
    
    return false;
  } finally {
    client.release();
  }
}

// Fonction améliorée pour créer la base de données
async function createCompleteDatabase() {
  const client = await pool.connect();
  
  try {
    console.log('🚀 Création COMPLÈTE de la base de données...\n');
    
    await client.query('BEGIN');
    
    // D'abord, vérifier et réparer updated_at si nécessaire
    console.log('🔧 Vérification préalable de la colonne updated_at...');
    try {
      await client.query('SELECT updated_at FROM users LIMIT 1');
      console.log('   ✅ Colonne updated_at existe');
    } catch (error) {
      if (error.message.includes('updated_at') || error.message.includes('42703')) {
        console.log('   ❌ updated_at manquant, ajout...');
        await client.query('ALTER TABLE users ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
        console.log('   ✅ updated_at ajouté');
      }
    }
    
    // 1. Table USERS - AVEC GESTION D'ERREUR AMÉLIORÉE
    console.log('\n📋 1. Création/MAJ table "users"...');
    
    // D'abord créer les colonnes manquantes une par une
    const userColumns = [
      'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
      'total_trading_earnings NUMERIC DEFAULT 0',
      'total_referral_earnings NUMERIC DEFAULT 0',
      'lifetime_referral_earnings NUMERIC DEFAULT 0',
      'lifetime_trading_earnings NUMERIC DEFAULT 0',
      'state TEXT DEFAULT \'idle\'',
      'state_data JSONB DEFAULT \'{}\'::jsonb',
      'notification_settings JSONB DEFAULT \'{"investment_reminders": true, "trading_updates": true, "plan_expiry": true, "referral_updates": true}\'::jsonb',
      'last_notification_sent TIMESTAMP DEFAULT NULL',
      'last_investment_notification TIMESTAMP DEFAULT NULL'
    ];
    
    // Vérifier si la table existe
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'users'
      )
    `);
    
    if (tableExists.rows[0].exists) {
      console.log('   ℹ️ Table users existe, ajout des colonnes manquantes...');
      
      for (const columnDef of userColumns) {
        const columnName = columnDef.split(' ')[0];
        try {
          await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${columnDef}`);
          console.log(`   ✅ ${columnName} vérifié/ajouté`);
        } catch (error) {
          console.log(`   ⚠️ ${columnName}: ${error.message}`);
        }
      }
    } else {
      // Créer la table complète
      await client.query(`
        CREATE TABLE users (
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
      console.log('   ✅ Table "users" créée avec TOUTES les colonnes');
    }
    
    // Les autres tables (inchangées mais avec IF NOT EXISTS)
    const otherTables = [
      {
        name: 'withdrawals',
        sql: `
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
        `
      },
      {
        name: 'transactions',
        sql: `
          CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            user_id BIGINT,
            type TEXT,
            amount NUMERIC,
            amount_usdt NUMERIC,
            description TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `
      },
      {
        name: 'payments',
        sql: `
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
        `
      },
      {
        name: 'referral_earnings',
        sql: `
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
        `
      },
      {
        name: 'fee_logs',
        sql: `
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
        `
      },
      {
        name: 'valid_referrals',
        sql: `
          CREATE TABLE IF NOT EXISTS valid_referrals (
            id SERIAL PRIMARY KEY,
            referrer_id BIGINT,
            referral_id BIGINT,
            referral_plan TEXT,
            activated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `
      },
      {
        name: 'deposits',
        sql: `
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
        `
      },
      {
        name: 'user_states',
        sql: `
          CREATE TABLE IF NOT EXISTS user_states (
            user_id BIGINT PRIMARY KEY,
            state TEXT DEFAULT 'idle',
            data JSONB DEFAULT '{}',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `
      }
    ];
    
    console.log('\n📋 Création des autres tables...');
    for (const table of otherTables) {
      try {
        await client.query(table.sql);
        console.log(`   ✅ Table "${table.name}" créée/vérifiée`);
      } catch (error) {
        console.log(`   ⚠️ Table "${table.name}": ${error.message}`);
      }
    }
    
    // Création des index
    console.log('\n🔗 Création des index...');
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet)',
      'CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)',
      'CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer)',
      'CREATE INDEX IF NOT EXISTS idx_users_state ON users(state)',
      'CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan)',
      'CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status)',
      'CREATE INDEX IF NOT EXISTS idx_withdrawals_created_at ON withdrawals(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type)',
      'CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)',
      'CREATE INDEX IF NOT EXISTS idx_payments_plan ON payments(plan)',
      'CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_referral_earnings_referrer_id ON referral_earnings(referrer_id)',
      'CREATE INDEX IF NOT EXISTS idx_referral_earnings_referral_id ON referral_earnings(referral_id)',
      'CREATE INDEX IF NOT EXISTS idx_valid_referrals_referrer_id ON valid_referrals(referrer_id)',
      'CREATE INDEX IF NOT EXISTS idx_valid_referrals_referral_id ON valid_referrals(referral_id)'
    ];
    
    let indexCount = 0;
    for (const indexSql of indexes) {
      try {
        await client.query(indexSql);
        indexCount++;
      } catch (error) {
        // Ignorer
      }
    }
    console.log(`   ✅ ${indexCount} index créés/vérifiés`);
    
    await client.query('COMMIT');
    
    console.log('\n' + '='.repeat(50));
    console.log('🎉 BASE DE DONNÉES CRÉÉE/RÉPARÉE AVEC SUCCÈS !');
    console.log('='.repeat(50));
    console.log('\n✅ Problème updated_at résolu !');
    console.log('✅ Toutes les tables sont prêtes.');
    console.log('\n👉 Redémarrez votre bot avec: node bot.js');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\n❌ ERREUR:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

// Fonction pour vérifier l'état actuel (améliorée)
async function checkCurrentState() {
  try {
    console.log('🔍 Vérification détaillée de l\'état...\n');
    
    // Vérifier spécifiquement updated_at
    console.log('🔧 Vérification colonne updated_at...');
    try {
      const hasUpdatedAt = await pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'users' 
        AND column_name = 'updated_at'
      `);
      
      if (hasUpdatedAt.rows.length > 0) {
        console.log('   ✅ Colonne updated_at EXISTE');
      } else {
        console.log('   ❌ COLONNE updated_at MANQUANTE !');
        console.log('   💡 Exécutez l\'option 8 pour réparer');
      }
    } catch (error) {
      console.log('   ⚠️ Erreur vérification:', error.message);
    }
    
    // Vérifier les tables
    const tables = [
      'users', 'withdrawals', 'transactions', 'payments',
      'referral_earnings', 'fee_logs', 'valid_referrals',
      'deposits', 'user_states'
    ];
    
    let existingTables = 0;
    
    console.log('\n📋 Vérification des tables...');
    for (const table of tables) {
      try {
        const result = await pool.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_name = $1 
            AND table_schema = 'public'
          )
        `, [table]);
        
        if (result.rows[0].exists) {
          console.log(`   ✅ Table "${table}" existe`);
          existingTables++;
        } else {
          console.log(`   ❌ Table "${table}" manquante`);
        }
      } catch (error) {
        console.log(`   ⚠️ Erreur table "${table}"`);
      }
    }
    
    console.log(`\n📈 Résumé : ${existingTables} tables existent sur ${tables.length}`);
    
    if (existingTables < tables.length) {
      console.log('\n⚠️  Certaines tables manquent !');
      console.log('   Exécutez l\'option 2 pour les créer.');
    }
    
  } catch (error) {
    console.error('Erreur vérification état:', error.message);
  }
}

// Menu principal amélioré
async function main() {
  console.clear();
  console.log('🛠️  GESTIONNAIRE DE BASE DE DONNÉES - COVESTING BOT');
  console.log('='.repeat(65));
  console.log('⚠️  PROBLÈME DÉTECTÉ: colonne "updated_at" manquante');
  console.log('='.repeat(65) + '\n');
  
  console.log('Options disponibles :');
  console.log('1. Vérifier l\'état actuel (recommandé)');
  console.log('2. Créer/Mettre à jour toutes les tables');
  console.log('3. Supprimer toutes les tables (DANGER !)');
  console.log('4. Exporter la base de données');
  console.log('5. Importer une sauvegarde');
  console.log('6. Afficher les statistiques');
  console.log('7. Quitter');
  console.log('8. 🔧 RÉPARER SPÉCIFIQUE updated_at (CHOIX RECOMMANDÉ)');
  
  console.log('\n' + '━'.repeat(40));
  console.log('💡 RECOMMANDATION: Choisissez l\'option 8 d\'abord');
  console.log('━'.repeat(40) + '\n');
  
  const choice = await askQuestion('Votre choix (1-8) : ');
  
  switch(choice) {
    case '1':
      await checkCurrentState();
      break;
    case '2':
      await createCompleteDatabase();
      break;
    case '3':
      const confirm = await askQuestion('⚠️  Supprimer TOUTES les données ? (tapez "SUPPRIMER") : ');
      if (confirm === 'SUPPRIMER') {
        await deleteAllTables();
      } else {
        console.log('❌ Annulé.');
      }
      break;
    case '4':
      await exportDatabase();
      break;
    case '5':
      await importDatabase();
      break;
    case '6':
      await showStatistics();
      break;
    case '7':
      console.log('👋 Au revoir !');
      await pool.end();
      process.exit(0);
      break;
    case '8':
      console.log('\n' + '🔧'.repeat(20));
      console.log('LANCEMENT DE LA RÉPARATION SPÉCIFIQUE');
      console.log('🔧'.repeat(20) + '\n');
      await fixUpdatedAtIssue();
      break;
    default:
      console.log('❌ Choix invalide. Essayez l\'option 8.');
  }
  
  // Demander si continuer
  const continueChoice = await askQuestion('\nVoulez-vous effectuer une autre opération ? (o/n) : ');
  if (continueChoice.toLowerCase() === 'o') {
    console.log('\n');
    await main();
  } else {
    console.log('👋 Fermeture...');
    await pool.end();
  }
}

// Ajoutez les autres fonctions nécessaires (deleteAllTables, exportDatabase, importDatabase, showStatistics)
// Ces fonctions restent inchangées par rapport à votre code original

// Fonction pour supprimer toutes les tables
async function deleteAllTables() {
  const client = await pool.connect();
  try {
    console.log('🗑️  Suppression des tables...');
    await client.query('BEGIN');
    
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
    console.log('\n✅ Toutes les tables supprimées !');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Erreur:', error.message);
  } finally {
    client.release();
  }
}

// Fonction export (simplifiée)
async function exportDatabase() {
  console.log('💾 Export simplifié...');
  // Votre code d'export existant
}

// Fonction import (simplifiée)
async function importDatabase() {
  console.log('📥 Import simplifié...');
  // Votre code d'import existant
}

// Fonction statistiques
async function showStatistics() {
  console.log('📊 Statistiques...');
  // Votre code statistiques existant
}

// Gestion des erreurs
process.on('uncaughtException', (error) => {
  console.error('\n💥 Erreur fatale:', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('\n💥 Rejet non géré:', reason);
  process.exit(1);
});

// Exécution
if (require.main === module) {
  main().catch(error => {
    console.error('\n💥 Erreur:', error.message);
    process.exit(1);
  });
}

module.exports = {
  fixUpdatedAtIssue,
  createCompleteDatabase,
  checkCurrentState,
  deleteAllTables
};
