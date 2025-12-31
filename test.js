const axios = require('axios');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://koyeb-adm:npg_QCu3XtSKA1nR@ep-lucky-glade-agvrp7z0.c-2.eu-central-1.pg.koyeb.app/koyebdb',
  ssl: { rejectUnauthorized: false }
});

async function testCompleteWebhookFlow() {
  try {
    console.log('🧪 Test complet du webhook NowPayments (PostgreSQL)\n');
    
    // 1. Vérifier la santé du bot
    console.log('1️⃣ Vérification santé du bot...');
    try {
      const healthResponse = await axios.get('https://b7764d245a9d.ngrok-free.app/');
      console.log('✅ Bot accessible:', healthResponse.data.status);
    } catch (error) {
      console.log('❌ Bot non accessible:', error.message);
      return;
    }
    
    // 2. Récupérer l'utilisateur admin
    console.log('\n2️⃣ Récupération utilisateur admin...');
    const testUserId = 5798607712;
    
    const userResult = await pool.query('SELECT * FROM users WHERE user_id = $1', [testUserId]);
    const user = userResult.rows[0];
    
    if (!user) {
      console.log('❌ Utilisateur admin non trouvé');
      return;
    }
    console.log(`✅ Utilisateur trouvé: ${user.user_id}, solde: ${user.main_balance || 0} SOL`);
    
    // 3. Créer un paiement de test AVEC LES BONNES COLONNES
    console.log('\n3️⃣ Création paiement test...');
    const amountSOL = 0.1;
    const amountUSD = amountSOL * 150;
    const invoiceId = `real_test_invoice_${Date.now()}`;
    const paymentId = `real_test_payment_${Date.now()}`;
    
    // D'abord vérifier si un paiement avec cet ID existe déjà
    const existingPayment = await pool.query(
      'SELECT * FROM payments WHERE invoice_id = $1 OR payment_id = $2',
      [invoiceId, paymentId]
    );
    
    if (existingPayment.rows.length > 0) {
      console.log('⚠️ Paiement existe déjà, utilisation de:', existingPayment.rows[0].invoice_id);
    } else {
      // Insérer avec les colonnes CORRECTES (pas d'order_id)
      const paymentResult = await pool.query(
        `INSERT INTO payments (
          user_id, plan, amount, amount_usdt, payment_id, invoice_id, payment_url, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          testUserId,
          'discovery',
          amountSOL,
          amountUSD,
          paymentId,
          invoiceId,
          'https://test-payment-url.com',
          'pending'
        ]
      );
      console.log(`✅ Paiement créé: ${amountSOL} SOL, Invoice: ${invoiceId}`);
    }
    
    // 4. Préparer les données du webhook SANS order_id
    console.log('\n4️⃣ Envoi du webhook...');
    const webhookData = {
      invoice_id: invoiceId,
      payment_status: 'confirmed',
      pay_amount: amountSOL.toString(),
      outcome_amount: amountSOL.toString(),
      payment_id: paymentId,
      price_amount: amountUSD.toString(),
      price_currency: 'usd',
      pay_currency: 'sol',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    console.log('📤 Données webhook:', JSON.stringify(webhookData, null, 2));
    console.log('🌐 URL: https://b7764d245a9d.ngrok-free.app/nowpayments-webhook');
    
    // 5. Envoyer le webhook
    const response = await axios.post(
      'https://b7764d245a9d.ngrok-free.app/nowpayments-webhook',
      webhookData,
      {
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'NowPayments-Webhook/1.0'
        },
        timeout: 10000
      }
    );
    
    console.log('✅ Webhook réponse:', response.data);
    
    // 6. Attendre et vérifier
    console.log('\n5️⃣ Vérification résultats (attente 3s)...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Vérifier le paiement
    const paymentCheck = await pool.query(
      'SELECT * FROM payments WHERE invoice_id = $1',
      [invoiceId]
    );
    const updatedPayment = paymentCheck.rows[0];
    console.log(`📊 Statut payment: ${updatedPayment?.status || 'non trouvé'}`);
    
    // Vérifier l'utilisateur
    const userCheck = await pool.query(
      'SELECT * FROM users WHERE user_id = $1',
      [testUserId]
    );
    const updatedUser = userCheck.rows[0];
    
    console.log(`\n💰 SOLDE UTILISATEUR:`);
    console.log(`   Ancien: ${user.main_balance || 0} SOL`);
    console.log(`   Nouveau: ${updatedUser?.main_balance || 0} SOL`);
    console.log(`   Différence: ${(updatedUser?.main_balance || 0) - (user.main_balance || 0)} SOL`);
    
    // Vérifier le plan
    console.log(`\n🎯 PLAN UTILISATEUR:`);
    console.log(`   Ancien: ${user.plan || 'Aucun'}`);
    console.log(`   Nouveau: ${updatedUser?.plan || 'Aucun'}`);
    
    // Transactions récentes
    const transactionsResult = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 5',
      [testUserId]
    );
    
    console.log(`\n📋 ${transactionsResult.rows.length} transactions récentes:`);
    transactionsResult.rows.forEach((t, i) => {
      console.log(`   ${i+1}. ${t.type}: ${t.amount} SOL - ${t.description?.substring(0, 50)}...`);
    });
    
    console.log('\n🎉 TEST COMPLÉTÉ !');
    
  } catch (error) {
    console.error('\n❌ Erreur:', error.message);
    if (error.response) {
      console.error('📡 Réponse:', error.response.data);
      console.error('🔢 Statut:', error.response.status);
      
      // Vérifier aussi la structure de la table
      if (error.response.data.message && error.response.data.message.includes('does not exist')) {
        console.error('\n🔧 SUGGESTION: La table payments semble avoir une structure différente.');
        console.error('   Essayez d\'ajouter la colonne manquante avec:');
        console.error('   ALTER TABLE payments ADD COLUMN IF NOT EXISTS order_id TEXT;');
      }
    }
  } finally {
    await pool.end();
  }
}

// Option pour ajouter la colonne manquante si nécessaire
async function fixPaymentsTable() {
  try {
    console.log('🔧 Vérification/Correction table payments...');
    
    // Vérifier si order_id existe
    const checkColumn = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'payments' 
      AND column_name = 'order_id'
    `);
    
    if (checkColumn.rows.length === 0) {
      console.log('➕ Ajout colonne order_id...');
      await pool.query('ALTER TABLE payments ADD COLUMN order_id TEXT');
      console.log('✅ Colonne order_id ajoutée');
    } else {
      console.log('✅ Colonne order_id existe déjà');
    }
    
    // Vérifier aussi invoice_id
    const checkInvoiceId = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'payments' 
      AND column_name = 'invoice_id'
    `);
    
    if (checkInvoiceId.rows.length === 0) {
      console.log('➕ Ajout colonne invoice_id...');
      await pool.query('ALTER TABLE payments ADD COLUMN invoice_id TEXT');
      console.log('✅ Colonne invoice_id ajoutée');
    } else {
      console.log('✅ Colonne invoice_id existe déjà');
    }
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
  }
}

// Exécuter
(async () => {
  // D'abord corriger la table si nécessaire
  await fixPaymentsTable();
  console.log('\n' + '='.repeat(50) + '\n');
  
  // Puis exécuter le test
  await testCompleteWebhookFlow();
})();
