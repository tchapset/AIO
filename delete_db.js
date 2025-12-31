const { Pool } = require('pg');

// Utilisez votre DATABASE_URL de Koyeb
const pool = new Pool({
  connectionString: 'postgres://koyeb-adm:npg_QCu3XtSKA1nR@ep-lucky-glade-agvrp7z0.c-2.eu-central-1.pg.koyeb.app/koyebdb',
  ssl: {
    rejectUnauthorized: false
  }
});

async function resetDatabase() {
  console.log('🔗 Connexion à Koyeb PostgreSQL...');
  
  try {
    // Test de connexion
    const test = await pool.query('SELECT NOW()');
    console.log('✅ Connecté à Koyeb:', test.rows[0].now);
    
    console.log('\n🗑️  Effacement des tables...');
    
    // Liste des tables à supprimer (ordre important)
    const tables = [
      'deposits',
      'valid_referrals',
      'fee_logs',
      'referral_earnings',
      'payments',
      'transactions',
      'withdrawals',
      'users'
    ];
    
    let successCount = 0;
    
    for (const table of tables) {
      try {
        const result = await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
        console.log(`✅ ${table} - SUPPRIMÉE`);
        successCount++;
      } catch (error) {
        console.log(`⚠️  ${table} - Erreur: ${error.message}`);
      }
    }
    
    console.log(`\n📊 Résultat: ${successCount}/${tables.length} tables effacées`);
    
    // Vérifier ce qui reste
    const remaining = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    
    if (remaining.rows.length === 0) {
      console.log('🎉 Base de données Koyeb complètement effacée !');
    } else {
      console.log('📋 Tables restantes:');
      remaining.rows.forEach(row => console.log(`  - ${row.table_name}`));
    }
    
    console.log('\n🔄 Maintenant, redémarrez votre bot local pour recréer les tables.');
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
  } finally {
    await pool.end();
    console.log('🔌 Connexion fermée.');
  }
}

resetDatabase();
