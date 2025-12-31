const { Pool } = require('pg');

// Connexion à PostgreSQL Koyeb
const pool = new Pool({
  connectionString: 'postgres://koyeb-adm:npg_QCu3XtSKA1nR@ep-lucky-glade-agvrp7z0.c-2.eu-central-1.pg.koyeb.app/koyebdb',
  ssl: {
    rejectUnauthorized: false
  }
});

async function addOrderIdColumn() {
  console.log('🔧 Ajout de la colonne order_id à la table payments...\n');
  
  try {
    // 1. Vérifier si la colonne existe déjà
    console.log('1. Vérification de l\'existence de la colonne...');
    const checkQuery = `
      SELECT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'payments' 
        AND column_name = 'order_id'
      ) as column_exists;
    `;
    
    const checkResult = await pool.query(checkQuery);
    const columnExists = checkResult.rows[0].column_exists;
    
    if (columnExists) {
      console.log('⚠️ La colonne order_id existe déjà dans la table payments');
      
      // Afficher les détails de la colonne
      const columnDetails = await pool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns 
        WHERE table_name = 'payments' 
        AND column_name = 'order_id'
      `);
      
      const details = columnDetails.rows[0];
      console.log('\n📊 Détails de la colonne:');
      console.log(`   Nom: ${details.column_name}`);
      console.log(`   Type: ${details.data_type}`);
      console.log(`   Nullable: ${details.is_nullable}`);
      console.log(`   Valeur par défaut: ${details.column_default || 'Aucune'}`);
      
    } else {
      // 2. Ajouter la colonne
      console.log('2. Ajout de la colonne order_id...');
      const alterQuery = `
        ALTER TABLE payments 
        ADD COLUMN order_id VARCHAR(255);
      `;
      
      await pool.query(alterQuery);
      console.log('✅ Colonne order_id ajoutée avec succès!');
    }
    
    // 3. Vérifier la structure complète de la table
    console.log('\n3. Structure complète de la table payments:');
    const structureQuery = `
      SELECT 
        column_name,
        data_type,
        is_nullable,
        character_maximum_length
      FROM information_schema.columns
      WHERE table_name = 'payments'
      ORDER BY ordinal_position;
    `;
    
    const structureResult = await pool.query(structureQuery);
    
    console.log('\n📋 Colonnes de la table payments:');
    console.log('='.repeat(60));
    console.log('| Nom colonne            | Type         | Nullable | Longueur max |');
    console.log('='.repeat(60));
    
    structureResult.rows.forEach(row => {
      const name = row.column_name.padEnd(22);
      const type = row.data_type.padEnd(13);
      const nullable = row.is_nullable === 'YES' ? 'OUI' : 'NON';
      const maxLength = row.character_maximum_length || '-';
      console.log(`| ${name}| ${type}| ${nullable.padEnd(8)}| ${maxLength.toString().padEnd(12)}|`);
    });
    
    console.log('='.repeat(60));
    
    // 4. Optionnel: Mettre à jour les valeurs existantes
    console.log('\n4. Mise à jour des enregistrements existants...');
    const updateQuery = `
      UPDATE payments 
      SET order_id = COALESCE(invoice_id, payment_id, 'order_' || id::text)
      WHERE order_id IS NULL;
    `;
    
    const updateResult = await pool.query(updateQuery);
    console.log(`✅ ${updateResult.rowCount} enregistrements mis à jour`);
    
    // 5. Vérifier quelques exemples
    console.log('\n5. Vérification des données...');
    const sampleQuery = `
      SELECT 
        id,
        invoice_id,
        payment_id,
        order_id,
        status
      FROM payments 
      WHERE order_id IS NOT NULL
      LIMIT 5;
    `;
    
    const sampleResult = await pool.query(sampleQuery);
    
    if (sampleResult.rows.length > 0) {
      console.log('\n📋 Exemples de données avec order_id:');
      sampleResult.rows.forEach((row, index) => {
        console.log(`\n   Enregistrement ${index + 1}:`);
        console.log(`   - ID: ${row.id}`);
        console.log(`   - Invoice ID: ${row.invoice_id}`);
        console.log(`   - Payment ID: ${row.payment_id}`);
        console.log(`   - Order ID: ${row.order_id}`);
        console.log(`   - Statut: ${row.status}`);
      });
    } else {
      console.log('ℹ️ Aucune donnée trouvée dans la table payments');
    }
    
    console.log('\n🎉 Opération terminée avec succès!');
    
  } catch (error) {
    console.error('\n❌ Erreur lors de l\'ajout de la colonne:');
    console.error(`   Message: ${error.message}`);
    
    if (error.code === '42701') {
      console.error('\n💡 Conseil: La colonne existe probablement déjà');
    } else if (error.code === '42P01') {
      console.error('\n💡 Conseil: La table payments n\'existe pas');
      console.error('   Vérifiez le nom de la table ou créez-la d\'abord');
    }
    
  } finally {
    // Fermer la connexion
    await pool.end();
    console.log('\n🔌 Connexion à la base de données fermée');
  }
}

// Exécuter la fonction
addOrderIdColumn();
