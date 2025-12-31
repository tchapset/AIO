const axios = require('axios');
const { Pool } = require('pg');

// Connexion à PostgreSQL Koyeb
const pool = new Pool({
  connectionString: 'postgres://koyeb-adm:npg_QCu3XtSKA1nR@ep-lucky-glade-agvrp7z0.c-2.eu-central-1.pg.koyeb.app/koyebdb',
  ssl: {
    rejectUnauthorized: false
  }
});

async function testCompleteWebhookFlow() {
  try {
    console.log('🧪 Test complet du webhook NowPayments (PostgreSQL)\n');
    
    // 1. Vérifier la santé du bot
    console.log('1️⃣ Vérification santé du bot...');
    try {
      const healthResponse = await axios.get('https://1f41c3e22355.ngrok-free.app');
      console.log('✅ Bot accessible:', healthResponse.data.status);
    } catch (error) {
      console.log('❌ Bot non accessible:', error.message);
      return;
    }
    
    // 2. Créer un vrai utilisateur de test (votre admin)
    console.log('\n2️⃣ Récupération utilisateur admin...');
    const testUserId = 5798607712;
    
    const userResult = await pool.query('SELECT * FROM users WHERE user_id = $1', [testUserId]);
    const user = userResult.rows[0];
    
    if (!user) {
      console.log('❌ Utilisateur admin non trouvé');
      return;
    }
    console.log(`✅ Utilisateur trouvé: ${user.user_id}, solde: ${user.main_balance || 0} SOL`);
    
    // 3. Créer un paiement de test (pas un dépôt car votre bot utilise la table payments)
    console.log('\n3️⃣ Création paiement test...');
    const amountSOL = 0.05;
    const amountUSD = amountSOL * 150;
    const invoiceId = `real_test_invoice_${Date.now()}`;
    const orderId = `real_test_order_${Date.now()}`;
    const paymentId = `real_test_payment_${Date.now()}`;
    
    // Vérifier si la table payments existe
    const tablesResult = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('payments', 'deposits')
    `);
    
    console.log('📋 Tables disponibles:', tablesResult.rows.map(r => r.table_name));
    
    let paymentCreated = false;
    
    // Essayer d'insérer dans payments (table principale pour NowPayments)
    try {
      const paymentResult = await pool.query(
        `INSERT INTO payments (
          user_id, plan, amount, amount_usdt, payment_id, invoice_id, payment_url, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          testUserId,
          'discovery',  // Plan test
          amountSOL,
          amountUSD,
          paymentId,
          invoiceId,
          'https://test-payment-url.com',
          'pending'
        ]
      );
      paymentCreated = true;
      console.log(`✅ Paiement créé dans table payments: ${amountSOL} SOL, Invoice: ${invoiceId}`);
    } catch (paymentError) {
      console.log(`⚠️ Erreur création payment: ${paymentError.message}`);
      
      // Essayer dans deposits
      try {
        const depositResult = await pool.query(
          `INSERT INTO deposits (
            user_id, amount, amount_usdt, payment_id, invoice_id, order_id, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            testUserId,
            amountSOL,
            amountUSD,
            paymentId,
            invoiceId,
            orderId,
            'pending'
          ]
        );
        console.log(`✅ Dépôt créé dans table deposits: ${amountSOL} SOL, Invoice: ${invoiceId}`);
      } catch (depositError) {
        console.log(`❌ Erreur création dépôt: ${depositError.message}`);
        console.log('ℹ️ Création d\'un enregistrement simulé...');
      }
    }
    
    // 4. Envoyer le webhook avec la BONNE URL
    console.log('\n4️⃣ Envoi du webhook...');
    const webhookData = {
      invoice_id: invoiceId,
      order_id: orderId,
      payment_status: 'confirmed',
      pay_amount: amountSOL.toString(),
      outcome_amount: amountSOL.toString(),
      payment_id: paymentId,
      price_amount: amountUSD.toString(),
      price_currency: 'usd',
      pay_currency: 'sol',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      order_description: 'Test payment for Discovery plan'
    };
    
    console.log('📤 Envoi vers: https://1f41c3e22355.ngrok-free.app');
    
    const response = await axios.post(
       'https://1f41c3e22355.ngrok-free.app/nowpayments-webhook',
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
    
    // 5. Vérifier les résultats
    console.log('\n5️⃣ Vérification des résultats...');
    
    // Attendre 2 secondes pour que le bot traite le webhook
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Vérifier le paiement/dépôt
    if (paymentCreated) {
      const paymentCheck = await pool.query(
        'SELECT * FROM payments WHERE invoice_id = $1',
        [invoiceId]
      );
      const updatedPayment = paymentCheck.rows[0];
      console.log(`📊 Statut payment: ${updatedPayment?.status || 'non trouvé'}`);
    } else {
      const depositCheck = await pool.query(
        'SELECT * FROM deposits WHERE invoice_id = $1',
        [invoiceId]
      );
      const updatedDeposit = depositCheck.rows[0];
      console.log(`📊 Statut dépôt: ${updatedDeposit?.status || 'non trouvé'}`);
    }
    
    // Vérifier l'utilisateur
    const userCheck = await pool.query(
      'SELECT * FROM users WHERE user_id = $1',
      [testUserId]
    );
    const updatedUser = userCheck.rows[0];
    
    console.log(`💰 Ancien solde: ${user.main_balance || 0} SOL`);
    console.log(`💰 Nouveau solde: ${updatedUser?.main_balance || 0} SOL`);
    console.log(`📈 Différence: ${(updatedUser?.main_balance || 0) - (user.main_balance || 0)} SOL`);
    
    // Vérifier les transactions
    const transactionsResult = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 5',
      [testUserId]
    );
    const transactions = transactionsResult.rows;
    
    console.log(`\n📋 ${transactions.length} dernières transactions:`);
    transactions.forEach((t, i) => {
      console.log(`  ${i+1}. ${t.type}: ${t.amount} SOL - ${t.description}`);
    });
    
    // Vérifier si le plan a été activé
    console.log(`\n🎯 Plan utilisateur: ${updatedUser?.plan || 'Aucun'}`);
    console.log(`💵 Total déposé: ${updatedUser?.deposited || 0} SOL`);
    
    console.log('\n🎉 TEST COMPLÉTÉ !');
    
  } catch (error) {
    console.error('\n❌ Erreur lors du test:', error.message);
    if (error.response) {
      console.error('📡 Réponse:', error.response.data);
      console.error('🔢 Statut:', error.response.status);
    }
    console.error('🔍 Stack:', error.stack);
  } finally {
    await pool.end();
  }
}

// Vérifier d'abord la structure
async function checkStructure() {
  try {
    const testResult = await pool.query('SELECT NOW() as time');
    console.log('🕒 Heure serveur PostgreSQL:', testResult.rows[0].time);
    
    const tables = await pool.query(`
      SELECT table_name, 
             (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as columns
      FROM information_schema.tables t
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    console.log('\n📋 Tables disponibles:');
    tables.rows.forEach(row => {
      console.log(`  - ${row.table_name} (${row.columns} colonnes)`);
    });
    
  } catch (error) {
    console.error('❌ Erreur connexion:', error.message);
  }
}

// Exécuter
(async () => {
  await checkStructure();
  console.log('\n' + '='.repeat(50) + '\n');
  await testCompleteWebhookFlow();
})();
