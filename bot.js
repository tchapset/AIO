// bot.js – COVESTING TRADING BOT - VERSION COMPLÈTE
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');

const app = express();
app.use(express.json());

// Configuration optimisée du bot
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { 
  polling: { 
    interval: 300,
    autoStart: true,
    params: {
      timeout: 60,
      limit: 100
    }
  }
});

// Middleware pour maintenir l'instance active
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString() 
  });
});

// Ping toutes les 5 minutes pour maintenir l'instance active
setInterval(() => {
  axios.get(`http://localhost:${process.env.PORT || 8000}/health`).catch(() => {});
}, 4 * 60 * 1000);

// Fonction pour limiter la longueur des messages
function truncateMessage(message, maxLength = 4000) {
  if (message.length <= maxLength) return message;
  return message.substring(0, maxLength - 3) + '...';
}

// Gestion des erreurs
process.on('uncaughtException', (error) => {
  console.error('❌ Exception non capturée:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Rejet non géré:', promise, 'raison:', reason);
});

// Fonction safe pour répondre aux callbacks
async function safeAnswerCallbackQuery(callbackQueryId, options = {}) {
  try {
    await bot.answerCallbackQuery(callbackQueryId, options);
    return true;
  } catch (error) {
    if (error.message.includes('query is too old')) {
      return false;
    } else {
      console.error('Erreur callback query:', error.message);
      throw error;
    }
  }
}

// Configuration
const ADMIN_ID = parseInt(process.env.ADMIN_ID || 0);
const MIN_DEPOSIT_USD = parseFloat(process.env.MIN_DEPOSIT_USD || 10);
const MIN_WITHDRAW = parseFloat(process.env.MIN_WITHDRAW || 0.01);
const MIN_NET_AMOUNT = parseFloat(process.env.MIN_NET_AMOUNT || 0.005);
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN;
const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME;
const DEPOSIT_WALLET = process.env.DEPOSIT_WALLET;
const COMMUNITY_LINK = process.env.COMMUNITY_LINK;
const SOLANA_RPC = process.env.SOLANA_RPC;
const SOLANA_PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;

// Configuration PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
    sslmode: 'require'  // <-- AJOUTER CETTE LIGNE
  }
});

// Test de connexion PostgreSQL
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Erreur connexion PostgreSQL:', err.message);
  } else {
    console.log('✅ PostgreSQL connecté avec succès:', res.rows[0].now);
  }
});

// Prix SOL et USDT en temps réel
let SOL_PRICE = 150.00;
let USDT_PRICE = 1.00;
let WITHDRAWALS_ENABLED = true;

// Configuration Solana
let connection;
let walletKeypair;

if (SOLANA_PRIVATE_KEY && SOLANA_RPC) {
  try {
    const privateKeyUint8Array = bs58.decode(SOLANA_PRIVATE_KEY);
    walletKeypair = Keypair.fromSecretKey(privateKeyUint8Array);
    
    connection = new Connection(SOLANA_RPC, 'confirmed');
    
    console.log('✅ Solana Web3 initialisé');
    console.log(`💰 Adresse Wallet: ${walletKeypair.publicKey.toString()}`);
  } catch (error) {
    console.error('❌ Erreur initialisation Solana:', error.message);
    connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  }
} else {
  console.log('⚠️ Configuration Solana manquante');
  connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
}

// Initialisation de la base de données
async function initializeDatabase() {
  try {
    // Table users
    await pool.query(`
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
        lifetime_trading_earnings NUMERIC DEFAULT 0,
        lifetime_referral_earnings NUMERIC DEFAULT 0,
        total_trading_earnings NUMERIC DEFAULT 0,
        total_referral_earnings NUMERIC DEFAULT 0
      )
    `);

    // Index
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_state ON users(state)');

    // Table withdrawals
    await pool.query(`
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

    // Table transactions
    await pool.query(`
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

    // Table payments
    await pool.query(`
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

    // Table referral_earnings
    await pool.query(`
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

    // Table fee_logs
    await pool.query(`
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

    // Table valid_referrals
    await pool.query(`
      CREATE TABLE IF NOT EXISTS valid_referrals (
        id SERIAL PRIMARY KEY,
        referrer_id BIGINT,
        referral_id BIGINT,
        referral_plan TEXT,
        activated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Table deposits
    await pool.query(`
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

    // Table user_states pour gérer les états des utilisateurs
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_states (
        user_id BIGINT PRIMARY KEY,
        state TEXT DEFAULT 'idle',
        data JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('✅ Base de données PostgreSQL initialisée');
  } catch (error) {
    console.error('❌ Erreur initialisation base de données:', error.message);
  }
}

// Initialiser la base de données
initializeDatabase();

// Mise à jour du prix SOL et USDT
async function updatePrices() {
  try {
    const solResponse = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 5000 });
    SOL_PRICE = parseFloat(solResponse.data.solana.usd);
    console.log(`📊 Prix SOL mis à jour: $${SOL_PRICE.toFixed(4)}`);
    
    USDT_PRICE = 1.00;
    
    return { sol: SOL_PRICE, usdt: USDT_PRICE };
  } catch (error) {
    console.error('⚠️ Erreur mise à jour prix:', error.message);
    
    try {
      const fallbackResponse = await axios.get('https://api.coinbase.com/v2/prices/SOL-USD/spot', { timeout: 3000 });
      SOL_PRICE = parseFloat(fallbackResponse.data.data.amount);
      console.log(`📊 Prix SOL (Coinbase): $${SOL_PRICE.toFixed(4)}`);
    } catch (fallbackError) {
      console.error('⚠️ Erreur fallback prix:', fallbackError.message);
    }
    
    return { sol: SOL_PRICE, usdt: USDT_PRICE };
  }
}

// Conversion SOL vers USDT
function convertSOLtoUSDT(solAmount) {
  return solAmount * SOL_PRICE;
}

// Conversion USDT vers SOL
function convertUSDTtoSOL(usdtAmount) {
  return usdtAmount / SOL_PRICE;
}

// Mettre à jour les prix toutes les 5 minutes
setInterval(updatePrices, 5 * 60 * 1000);

// Plans d'investissement
const PLANS = {
  free: { 
    name: '🎁 Essai Gratuit',    
    price: 0,    
    daily: 0.005, 
    roi: '350%',
    duration: '14 jours',
    min_withdrawal: 0.02,
    max_withdrawals_per_day: 1,
    requires_upgrade_for_withdrawal: true,
    min_referrals_for_withdrawal: 3,
    min_referral_plan: 'discovery',
    description: '0.005 SOL par jour pendant 14 jours (0.07 SOL total)',
    features: ['✅ Gains quotidiens pendant 14 jours', '✅ Système de parrainage actif', '✅ Support de base', '✅ Retrait après 3 parrainages valides'],
    unlocked: true,
    pairs: 10,
    session_duration: 120
  },
  discovery: { 
    name: '🔍 Découverte 150%',    
    price: 0.1,    
    daily: 0.005, 
    roi: '150%',
    duration: '30 jours',
    min_withdrawal: 0.01,
    max_withdrawals_per_day: 1,
    description: '0.005 SOL par jour',
    features: ['✅ ROI 150%', '✅ Analyse de marché', '✅ Support Telegram', '✅ Retraits quotidiens'],
    unlocked: true,
    pairs: 12,
    session_duration: 150
  },
  basic: { 
    name: '🥉 Basique 150%', 
    price: 0.5,   
    daily: 0.025, 
    roi: '150%',
    duration: '30 jours',
    min_withdrawal: 0.1,
    max_withdrawals_per_day: 1,
    description: '0.025 SOL par jour',
    features: ['✅ ROI 150%', '✅ Support prioritaire', '✅ Analyse de marché', '✅ Retraits quotidiens'],
    unlocked: true,
    pairs: 15,
    session_duration: 180
  },
  starter: { 
    name: '🚀 Starter 150%', 
    price: 1,   
    daily: 0.05, 
    roi: '150%',
    duration: '30 jours',
    min_withdrawal: 0.2,
    max_withdrawals_per_day: 2,
    description: '0.05 SOL par jour',
    features: ['✅ ROI 150%', '✅ Support prioritaire', '✅ Analytics avancés', '✅ 2 retraits/jour'],
    unlocked: true,
    pairs: 18,
    session_duration: 210
  },
  advanced: { 
    name: '⚡ Avancé 150%', 
    price: 1.5,   
    daily: 0.075, 
    roi: '150%',
    duration: '30 jours',
    min_withdrawal: 0.3,
    max_withdrawals_per_day: 2,
    description: '0.075 SOL par jour',
    features: ['✅ ROI 150%', '✅ Support VIP', '✅ Analytics avancés', '✅ 2 retraits/jour'],
    unlocked: true,
    pairs: 22,
    session_duration: 240
  },
  pro: { 
    name: '🥈 Pro 150%',   
    price: 2,  
    daily: 0.10,   
    roi: '150%',
    duration: '30 jours',
    min_withdrawal: 0.5,
    max_withdrawals_per_day: 3,
    description: '0.10 SOL par jour',
    features: ['✅ ROI 150%', '✅ Trading algorithmique', '✅ Signaux VIP', '✅ 3 retraits/jour'],
    unlocked: true,
    pairs: 25,
    session_duration: 270
  },
  expert: { 
    name: '💎 Expert 150%',   
    price: 4,  
    daily: 0.20,   
    roi: '150%',
    duration: '30 jours',
    min_withdrawal: 1,
    max_withdrawals_per_day: 3,
    description: '0.20 SOL par jour',
    features: ['✅ ROI 150%', '✅ Manager dédié', '✅ Copy Trading', '✅ 3 retraits/jour'],
    unlocked: true,
    pairs: 30,
    session_duration: 300
  },
  vip: { 
    name: '🥇 VIP Global',   
    price: 10,  
    daily: 0.50,  
    roi: '150%',
    duration: '30 jours',
    min_withdrawal: 2,
    max_withdrawals_per_day: 5,
    description: '0.50 SOL par jour',
    features: ['✅ ROI exceptionnel', '✅ Manager dédié', '✅ Copy Trading', '✅ 5 retraits/jour'],
    unlocked: true,
    pairs: 35,
    session_duration: 360
  }
};

// Générer un code de parrainage unique
function generateReferralCode(userId) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const base = userId.toString(36).toUpperCase();
  let code = base;
  
  while (code.length < 6) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return code.substring(0, 6);
}

// Fonctions de base de données
// Fonctions de base de données
async function getUser(id) {
  try {
    console.log(`🔍 Recherche utilisateur ID: ${id}`);
    
    if (!id) {
      console.error('❌ getUser: ID est undefined ou null');
      return null;
    }
    
    const result = await pool.query('SELECT * FROM users WHERE user_id = $1', [id]);
    
    if (result.rows.length === 0) {
      console.log(`ℹ️ Utilisateur ${id} non trouvé dans la base`);
      return null;
    }
    
    console.log(`✅ Utilisateur ${id} trouvé`);
    return result.rows[0];
    
  } catch (error) {
    console.error(`❌ getUser error pour ID ${id}:`, error.message);
    console.error(`Code erreur PostgreSQL: ${error.code}`);
    console.error('Stack trace:', error.stack);
    
    // Ne pas essayer de re-créer la connexion ici, cela cause des problèmes
    // La connexion sera automatiquement réétablie par le pool
    return null;
  }
}

async function getOrCreateUser(id) {
  try {
    let user = await getUser(id);
    
    if (user) {
      if (user.plan === 'free' && user.free_plan_expiry && Date.now() > user.free_plan_expiry) {
        await pool.query('UPDATE users SET plan = NULL WHERE user_id = $1', [id]);
        user.plan = null;
      }
      
      if (!user.referral_code) {
        const referralCode = generateReferralCode(id);
        await pool.query('UPDATE users SET referral_code = $1 WHERE user_id = $2', [referralCode, id]);
        user.referral_code = referralCode;
      }
      
      return user;
    }
    
    // Créer l'utilisateur s'il n'existe pas
    const referralCode = generateReferralCode(id);
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // D'abord vérifier si l'utilisateur existe déjà (cas de race condition)
      const checkResult = await client.query('SELECT * FROM users WHERE user_id = $1', [id]);
      
      if (checkResult.rows.length > 0) {
        await client.query('ROLLBACK');
        return checkResult.rows[0];
      }
      
      // Créer le nouvel utilisateur avec TOUTES les colonnes nécessaires
      await client.query(
        `INSERT INTO users (user_id, username, first_name, last_name, main_balance, trading_balance, referral_balance, referral_code, plans, 
         lifetime_trading_earnings, lifetime_referral_earnings, total_trading_earnings, total_referral_earnings) 
         VALUES ($1, $2, $3, $4, 0, 0, 0, $5, '{}', 0, 0, 0, 0)`,
        [id, 'user' + id, null, null, referralCode]
      );
      
      await client.query('COMMIT');
      
      user = await getUser(id);
      return user;
    } catch (insertError) {
      await client.query('ROLLBACK');
      
      if (insertError.code === '23505') { // Code d'erreur pour violation de contrainte unique
        // L'utilisateur existe déjà, récupérer ses données
        user = await getUser(id);
        return user;
      }
      
      console.error('❌ Erreur création utilisateur:', insertError.message);
      throw insertError;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('❌ getOrCreateUser error pour ID', id, ':', error.message);
    console.error('Stack trace:', error.stack);
    
    // Créer un objet utilisateur minimal en cas d'erreur
    return {
      user_id: id,
      username: 'user' + id,
      main_balance: 0,
      trading_balance: 0,
      referral_balance: 0,
      referral_earnings: 0,
      lifetime_trading_earnings: 0,
      lifetime_referral_earnings: 0,
      total_trading_earnings: 0,
      total_referral_earnings: 0,
      plan: null,
      plans: [],
      referrals: 0,
      valid_referrals: 0,
      wallet: null,
      free_plan_activated: false,
      free_plan_requirements_met: false
    };
  }
}

async function updateUser(userId, updates) {
  const client = await pool.connect();
  
  try {
    if (!updates || Object.keys(updates).length === 0) return;
    
    await client.query('BEGIN');
    
    // Récupérer l'utilisateur AVANT de vérifier les gains
    const currentUser = await getUser(userId);
    
    // VÉRIFIER SI L'UTILISATEUR EXISTE
    if (!currentUser) {
      console.error(`❌ Utilisateur ${userId} non trouvé dans updateUser`);
      await client.query('ROLLBACK');
      return;
    }
    
    // VÉRIFIER SI ON AJOUTE DES GAINS À REFERRAL OU TRADING
    if (updates.referral_balance !== undefined || updates.trading_balance !== undefined) {
      
      // Si on ajoute au solde referral
      if (updates.referral_balance !== undefined) {
        const currentReferral = parseFloat(currentUser.referral_balance) || 0;
        const newReferral = parseFloat(updates.referral_balance) || 0;
        const difference = newReferral - currentReferral;
        
        if (difference > 0) {
          // C'est un gain, transférer automatiquement vers principal
          const currentMain = parseFloat(currentUser.main_balance) || 0;
          const newMainBalance = currentMain + difference;
          
          // Mettre à jour le main_balance
          updates.main_balance = newMainBalance;
          
          // Garder seulement un petit montant dans referral pour l'affichage
          updates.referral_balance = 0.000001;
          
          // Enregistrer les gains totaux
          const totalReferralEarned = (parseFloat(currentUser.total_referral_earnings) || 0) + difference;
          const lifetimeReferral = (parseFloat(currentUser.lifetime_referral_earnings) || 0) + difference;
          
          updates.total_referral_earnings = totalReferralEarned;
          updates.lifetime_referral_earnings = lifetimeReferral;
          
          console.log(`💰 Transfert auto referral → principal: ${difference.toFixed(6)} SOL`);
          
          // Ajouter une transaction
          await addTransaction(userId, 'auto_transfer', difference, 
            `Transfert automatique gains parrainage → principal`);
        }
      }
      
      // Si on ajoute au solde trading
      if (updates.trading_balance !== undefined) {
        const currentTrading = parseFloat(currentUser.trading_balance) || 0;
        const newTrading = parseFloat(updates.trading_balance) || 0;
        const difference = newTrading - currentTrading;
        
        if (difference > 0) {
          // C'est un gain, transférer automatiquement vers principal
          const currentMain = parseFloat(currentUser.main_balance) || 0;
          const newMainBalance = currentMain + difference;
          
          // Mettre à jour le main_balance
          updates.main_balance = newMainBalance;
          
          // Garder seulement un petit montant dans trading pour l'affichage
          updates.trading_balance = 0.000001;
          
          // Enregistrer les gains totaux
          const totalTradingEarned = (parseFloat(currentUser.total_trading_earnings) || 0) + difference;
          const lifetimeTrading = (parseFloat(currentUser.lifetime_trading_earnings) || 0) + difference;
          
          updates.total_trading_earnings = totalTradingEarned;
          updates.lifetime_trading_earnings = lifetimeTrading;
          
          console.log(`💰 Transfert auto trading → principal: ${difference.toFixed(6)} SOL`);
          
          // Ajouter une transaction
          await addTransaction(userId, 'auto_transfer', difference, 
            `Transfert automatique gains trading → principal`);
        }
      }
    }
    
    const keys = Object.keys(updates);
    const values = Object.values(updates);
    const setClause = keys.map((key, index) => `${key} = $${index + 1}`).join(', ');
    
    const query = `UPDATE users SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE user_id = $${keys.length + 1}`;
    
    await client.query(query, [...values, userId]);
    await client.query('COMMIT');
    
    console.log(`✅ Utilisateur ${userId} mis à jour avec succès:`, updates);
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`❌ updateUser error pour ID ${userId}:`, error.message);
    console.error('Stack trace:', error.stack);
    throw error;
  } finally {
    client.release();
  }
}

async function setUserState(userId, state, data = {}) {
  try {
    await pool.query(
      'UPDATE users SET state = $1, state_data = $2 WHERE user_id = $3',
      [state, JSON.stringify(data), userId]
    );
  } catch (error) {
    console.error('setUserState error:', error.message);
  }
}

async function getUserState(userId) {
  try {
    const result = await pool.query(
      'SELECT state, state_data FROM users WHERE user_id = $1',
      [userId]
    );
    return result.rows[0] || { state: 'idle', state_data: {} };
  } catch (error) {
    console.error('getUserState error:', error.message);
    return { state: 'idle', state_data: {} };
  }
}

async function clearUserState(userId) {
  try {
    await pool.query(
      'UPDATE users SET state = $1, state_data = $2 WHERE user_id = $3',
      ['idle', '{}', userId]
    );
  } catch (error) {
    console.error('clearUserState error:', error.message);
  }
}

async function addTransaction(userId, type, amount, description) {
  try {
    const amountUsdt = convertSOLtoUSDT(amount);
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, amount_usdt, description) VALUES ($1, $2, $3, $4, $5)',
      [userId, type, amount, amountUsdt, description]
    );
  } catch (error) {
    console.error('addTransaction error:', error.message);
    throw error;
  }
}

async function isWalletUnique(wallet, userId) {
  try {
    const result = await pool.query(
      'SELECT user_id FROM users WHERE wallet = $1 AND user_id != $2',
      [wallet, userId || 0]
    );
    return result.rows.length === 0;
  } catch (error) {
    console.error('isWalletUnique error:', error.message);
    return false;
  }
}

// Fonction pour obtenir le solde total
function getTotalBalance(user) {
  // Seul le compte principal est réellement disponible
  return parseFloat(user.main_balance) || 0;
}

function getDisplayBalance(user) {
  // Pour l'affichage seulement
  return (parseFloat(user.main_balance) || 0) + 
         (parseFloat(user.trading_balance) || 0) + 
         (parseFloat(user.referral_balance) || 0);
}

function getLifetimeEarnings(user) {
  // Utiliser les colonnes de gains totaux permanentes
  return {
    referral: parseFloat(user.lifetime_referral_earnings) || 0,
    trading: parseFloat(user.lifetime_trading_earnings) || 0,
    total: (parseFloat(user.lifetime_referral_earnings) || 0) + 
           (parseFloat(user.lifetime_trading_earnings) || 0)
  };
}

// Fonction pour obtenir les plans actifs
function getActivePlans(user) {
  if (!user.plans || !Array.isArray(user.plans)) {
    return [];
  }
  return user.plans.filter(plan => PLANS[plan]);
}

// Vérifier si l'utilisateur peut retirer
async function canUserWithdraw(userId) {
  try {
    const user = await getUser(userId);
    
    if (!user) return { canWithdraw: false, reason: 'Utilisateur non trouvé' };
    
    const activePlans = getActivePlans(user);
    
    if (activePlans.length > 0) {
      const today = new Date().toISOString().split('T')[0];
      if (user.last_daily_withdrawal === today) {
        const maxWithdrawals = Math.max(...activePlans.map(plan => PLANS[plan].max_withdrawals_per_day));
        if (user.withdrawal_count_today >= maxWithdrawals) {
          return {
            canWithdraw: false,
            reason: `❌ Vous avez atteint la limite de ${maxWithdrawals} retraits pour aujourd'hui`
          };
        }
      }
      return { canWithdraw: true };
    }
    
    if (user.plan === 'free') {
      const mainBalance = parseFloat(user.main_balance) || 0;
      const withdrawalCheck = validateWithdrawalAmount(mainBalance, 'free');
      
      if (!withdrawalCheck.valid) {
        return {
          canWithdraw: false,
          reason: withdrawalCheck.reason
        };
      }
      
      const validReferrals = await pool.query(
        'SELECT COUNT(*) as count FROM valid_referrals WHERE referrer_id = $1',
        [userId]
      );
      const count = parseInt(validReferrals.rows[0].count) || 0;
      
      const remaining = 3 - count; // Changé de 5 à 3
      
      if (remaining <= 0) {
        await updateUser(userId, { free_plan_requirements_met: true });
        return { canWithdraw: true };
      }
      
      return {
        canWithdraw: false,
        reason: `⚠️ Plan gratuit : besoin de ${remaining} parrainage(s) supplémentaire(s) (min. plan ${PLANS.free.min_referral_plan}) pour retirer`,
        validReferrals: count,
        requiredReferrals: 3
      };
    }
    
    return { canWithdraw: true };
  } catch (error) {
    console.error('canUserWithdraw error:', error.message);
    return { canWithdraw: false, reason: 'Erreur système' };
  }
}

// Marquer un parrainage comme valide
async function markReferralAsValid(referrerId, referralId, plan) {
  try {
    const validPlan = PLANS[plan];
    if (!validPlan || validPlan.price <= 0) return false;
    
    const existing = await pool.query(
      'SELECT id FROM valid_referrals WHERE referrer_id = $1 AND referral_id = $2',
      [referrerId, referralId]
    );
    
    if (existing.rows.length > 0) return true;
    
    await pool.query(
      'INSERT INTO valid_referrals (referrer_id, referral_id, referral_plan) VALUES ($1, $2, $3)',
      [referrerId, referralId, plan]
    );
    
    const validCount = await pool.query(
      'SELECT COUNT(*) as count FROM valid_referrals WHERE referrer_id = $1',
      [referrerId]
    );
    
    const count = parseInt(validCount.rows[0].count) || 0;
    await updateUser(referrerId, { valid_referrals: count });
    
    if (count >= 3) { // Changé de 5 à 3
      const user = await getUser(referrerId);
      if (user && user.plan === 'free') {
        await updateUser(referrerId, { free_plan_requirements_met: true });
        
        try {
          await bot.sendMessage(referrerId,
            `🎉 **CONDITIONS REMPLIES !**\n\n` +
            `✅ Vous avez maintenant ${count} parrainages valides.\n\n` +
            `💰 **Vous pouvez maintenant retirer vos gains !**\n\n` +
            `👉 Allez dans le menu "Wallet" pour effectuer votre premier retrait.`
          );
        } catch (error) {
          console.error('Notification error:', error.message);
        }
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error marking referral as valid:', error);
    return false;
  }
}

// Fonctions NowPayments
async function createNowPaymentsInvoice(userId, amountUSD, description = "Achat plan COVESTING") {
  try {
    if (!NOWPAYMENTS_API_KEY) {
      throw new Error('Clé API NowPayments non configurée');
    }
    
    if (!WEBHOOK_DOMAIN) {
      throw new Error('Domaine webhook non configuré');
    }
    
    const timestamp = Date.now();
    const randomSuffix = Math.floor(Math.random() * 1000);
    const orderId = `plan_${userId}_${timestamp}_${randomSuffix}`;
    
    const cleanWebhookDomain = WEBHOOK_DOMAIN.replace(/\/+$/, '');
    const webhookUrl = `${cleanWebhookDomain}/nowpayments-webhook`;
    
    const botInfo = await bot.getMe();
    const botUsername = botInfo.username;
    
    const payload = {
      price_amount: amountUSD.toFixed(8),
      price_currency: 'usd',
      pay_currency: 'sol',
      ipn_callback_url: webhookUrl,
      order_id: orderId,
      order_description: description,
      success_url: `https://t.me/${botUsername}?start=payment_success`,
      cancel_url: `https://t.me/${botUsername}?start=payment_cancel`,
      partially_paid_url: `https://t.me/${botUsername}?start=payment_partial`,
      is_fixed_rate: true,
      is_fee_paid_by_user: true
    };
    
    console.log('📤 Création facture NowPayments:', payload);
    
    const response = await axios.post(
      'https://api.nowpayments.io/v1/invoice',
      payload,
      {
        headers: {
          'x-api-key': NOWPAYMENTS_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 30000
      }
    );
    
    if (!response.data || !response.data.id) {
      throw new Error('Réponse NowPayments invalide');
    }
    
    const invoiceData = response.data;
    
    return {
      id: invoiceData.id,
      payment_id: invoiceData.id,
      invoice_id: invoiceData.id,
      order_id: invoiceData.order_id,
      invoice_url: invoiceData.invoice_url,
      payment_url: invoiceData.invoice_url,
      price_amount: invoiceData.price_amount,
      price_currency: invoiceData.price_currency,
      pay_currency: invoiceData.pay_currency,
      created_at: invoiceData.created_at,
      payment_status: 'pending'
    };
    
  } catch (error) {
    console.error('❌ Erreur création facture NowPayments:', error.message);
    
    if (error.response) {
      console.error('Response data:', error.response.data);
      if (error.response.status === 401) {
        throw new Error('Clé API NowPayments invalide');
      } else if (error.response.status === 400) {
        const errorMsg = error.response.data.message || JSON.stringify(error.response.data);
        throw new Error(`Requête invalide: ${errorMsg}`);
      }
    }
    
    throw new Error(`Erreur: ${error.message}`);
  }
}

async function checkNowPaymentsPayment(paymentId) {
  try {
    if (!NOWPAYMENTS_API_KEY) {
      throw new Error('NowPayments API non configuré');
    }
    
    console.log(`🔍 Vérification paiement ID: ${paymentId}`);
    
    try {
      const response = await axios.get(
        `https://api.nowpayments.io/v1/payment/${paymentId}`,
        {
          headers: {
            'x-api-key': NOWPAYMENTS_API_KEY,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      
      console.log('✅ Statut paiement:', response.data.payment_status);
      return response.data;
    } catch (paymentError) {
      try {
        const invoiceResponse = await axios.get(
          `https://api.nowpayments.io/v1/invoice/${paymentId}`,
          {
            headers: {
              'x-api-key': NOWPAYMENTS_API_KEY,
              'Content-Type': 'application/json'
            },
            timeout: 10000
          }
        );
        
        console.log('✅ Statut facture:', invoiceResponse.data);
        return invoiceResponse.data;
      } catch (invoiceError) {
        throw new Error(`Impossible de vérifier le statut pour ID: ${paymentId}`);
      }
    }
  } catch (error) {
    console.error('❌ Erreur vérification NowPayments:', error.message);
    throw error;
  }
}

// Fonctions frais dynamiques
function calculateDynamicFees(amountSOL) {
  let feesSOL;
  
  if (amountSOL <= 0.1) {
    feesSOL = 0.001;
  } else if (amountSOL <= 0.5) {
    feesSOL = 0.002;
  } else if (amountSOL <= 1) {
    feesSOL = 0.003;
  } else {
    feesSOL = 0.005;
  }
  
  const netAmountSOL = amountSOL - feesSOL;
  
  if (netAmountSOL < MIN_NET_AMOUNT) {
    const requiredFeesSOL = amountSOL - MIN_NET_AMOUNT;
    feesSOL = Math.min(Math.max(requiredFeesSOL, 0.001), 0.005);
  }
  
  const finalNetAmountSOL = amountSOL - feesSOL;
  
  return {
    feesSOL,
    feesUSD: feesSOL * SOL_PRICE,
    netAmountSOL: finalNetAmountSOL,
    netAmountUSD: finalNetAmountSOL * SOL_PRICE,
    conversionRate: SOL_PRICE,
    solPrice: SOL_PRICE,
    rulesApplied: {
      minNetAmount: MIN_NET_AMOUNT,
      feeStructure: amountSOL <= 0.1 ? '0.001 SOL' : 
                   amountSOL <= 0.5 ? '0.002 SOL' : 
                   amountSOL <= 1 ? '0.003 SOL' : '0.005 SOL (max)'
    }
  };
}

function validateWithdrawalAmount(amountSOL, userPlan) {
  const plan = PLANS[userPlan] || PLANS.free;
  const minWithdraw = plan.min_withdrawal || MIN_WITHDRAW;
  
  if (userPlan === 'free' && amountSOL === 0) {
    return {
      valid: true,
      fees: calculateDynamicFees(0.02),
      message: `✅ Aucun retrait nécessaire`
    };
  }
  
  const fees = calculateDynamicFees(amountSOL);
  
  if (amountSOL < minWithdraw) {
    return {
      valid: false,
      reason: `❌ Montant minimum pour votre plan: ${minWithdraw} SOL`,
      minAmount: minWithdraw
    };
  }
  
  if (fees.netAmountSOL < MIN_NET_AMOUNT) {
    const minGrossAmount = MIN_NET_AMOUNT + minWithdraw;
    return {
      valid: false,
      reason: `❌ Après frais (${fees.feesSOL} SOL), vous recevrez seulement ${fees.netAmountSOL.toFixed(4)} SOL.\n💡 Minimum requis après frais: ${MIN_NET_AMOUNT} SOL\n💰 Retirez au moins ${Math.max(minGrossAmount, minWithdraw).toFixed(4)} SOL`,
      minGrossAmount: Math.max(minGrossAmount, minWithdraw)
    };
  }
  
  return {
    valid: true,
    fees: fees,
    message: `✅ Montant valide. Frais: ${fees.feesSOL} SOL ($${fees.feesUSD.toFixed(4)})\n💰 Net à recevoir: ${fees.netAmountSOL.toFixed(4)} SOL ($${fees.netAmountUSD.toFixed(4)})`
  };
}

// Fonctions Solana
async function sendSOLWithLowFees(toAddress, amountSOL) {
  try {
    console.log(`[SOLANA] Envoi de ${amountSOL} SOL à ${toAddress}`);
    
    if (!connection || !walletKeypair) {
      throw new Error('Configuration Solana manquante');
    }
    
    let recipientPublicKey;
    try {
      recipientPublicKey = new PublicKey(toAddress);
    } catch (error) {
      throw new Error(`Adresse Solana invalide: ${toAddress}`);
    }
    
    const walletAddress = walletKeypair.publicKey;
    const solBalance = await connection.getBalance(walletAddress);
    const solBalanceSOL = solBalance / LAMPORTS_PER_SOL;
    
    const requiredBalance = amountSOL + 0.000005;
    
    if (solBalanceSOL < requiredBalance) {
      throw new Error(`Solde SOL insuffisant: ${solBalanceSOL.toFixed(4)} SOL`);
    }
    
    const amountLamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);
    
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: walletAddress,
        toPubkey: recipientPublicKey,
        lamports: amountLamports,
      })
    );
    
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [walletKeypair],
      {
        commitment: 'confirmed',
        preflightCommitment: 'confirmed'
      }
    );
    
    console.log(`[SOLANA] ✅ Transaction envoyée! Signature: ${signature}`);
    
    let actualFeesSOL = 0.000005;
    const txDetails = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });
    
    if (txDetails && txDetails.meta) {
      actualFeesSOL = txDetails.meta.fee / LAMPORTS_PER_SOL;
    }
    
    return {
      txid: signature,
      feesSOL: actualFeesSOL,
      feesUSD: actualFeesSOL * SOL_PRICE,
      netAmountSOL: amountSOL - actualFeesSOL,
      netAmountUSD: (amountSOL - actualFeesSOL) * SOL_PRICE
    };
    
  } catch (error) {
    console.error('[SOLANA] Erreur:', error.message);
    throw new Error(`SOLANA: ${error.message}`);
  }
}

// Fonctions admin
async function notifyAdmin(message) {
  if (ADMIN_ID) {
    try {
      await bot.sendMessage(ADMIN_ID, truncateMessage(message), { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Erreur notification admin:', error.message);
    }
  }
}

// Simulation de trading
async function showTradingProgress(chatId, messageId, plan, coins, directions) {
  try {
    let totalGain = 0;
    let message = `🤖 **SESSION DE TRADING EN COURS** ⚡\n\n`;
    
    const targetDaily = plan.daily;
    const totalTrades = Math.floor(plan.session_duration / 15);
    const averageGainPerTrade = targetDaily / totalTrades;
    const pairs = plan.pairs || 10;
    
    const tradingPairs = [
      'BTC/SOL', 'ETH/SOL', 'SOL/USDC', 'BNB/SOL', 'XRP/SOL', 
      'ADA/SOL', 'DOGE/SOL', 'DOT/SOL', 'LINK/SOL', 'MATIC/SOL',
      'AVAX/SOL', 'ATOM/SOL', 'UNI/SOL', 'AAVE/SOL', 'ALGO/SOL',
      'NEAR/SOL', 'FTM/SOL', 'SAND/SOL', 'MANA/SOL', 'GALA/SOL',
      'AXS/SOL', 'APE/SOL', 'CHZ/SOL', 'ENJ/SOL', 'BAT/SOL'
    ].slice(0, pairs);
    
    for (let i = 0; i < totalTrades; i++) {
      const coin = tradingPairs[Math.floor(Math.random() * tradingPairs.length)];
      const direction = directions[Math.floor(Math.random() * directions.length)];
      
      let result, emoji;
      
      if (Math.random() < 0.25) {
        result = '🔴 PERTE';
        emoji = '🔻';
      } else {
        result = '🟢 PROFIT';
        emoji = '📈';
      }
      
      const tradeGain = (averageGainPerTrade * (1 + (Math.random() * 0.4 - 0.2)));
      const gainAmount = result === '🟢 PROFIT' ? tradeGain : -tradeGain * 0.3;
      
      totalGain += gainAmount;
      
      message += `${emoji} **TRADE ${i+1}:** ${coin} ${direction}\n`;
      message += `   Gain: ${gainAmount >= 0 ? '+' : ''}${gainAmount.toFixed(5)} SOL\n`;
      message += `   Résultat: ${result}\n\n`;
      
      const progress = Math.round(((i + 1) / totalTrades) * 100);
      const progressBar = `[${'█'.repeat(Math.floor(progress / 5))}${'░'.repeat(20 - Math.floor(progress / 5))}] ${progress}%`;
      
      const progressMessage = message + `\n📊 **PROGRESSION:** ${progressBar}\n💰 **GAIN ACTUEL:** ${totalGain.toFixed(5)} SOL\n⏱️ **TEMPS RESTANT:** ${Math.floor((plan.session_duration - (i * 15)) / 60)}m ${(plan.session_duration - (i * 15)) % 60}s`;
      
      try {
        await bot.editMessageText(progressMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        });
      } catch (error) {
        // Ignorer les erreurs d'édition
      }
      
      await new Promise(resolve => setTimeout(resolve, 15000));
    }
    
    if (totalGain < targetDaily * 0.8) {
      totalGain = targetDaily * 0.8 + (Math.random() * targetDaily * 0.4);
    }
    
    if (totalGain > targetDaily * 1.5) {
      totalGain = targetDaily * 1.2;
    }
    
    return totalGain;
  } catch (error) {
    console.error('showTradingProgress error:', error.message);
    return plan.daily;
  }
}

// Système de notifications
async function sendInvestmentNotification(chatId) {
  try {
    const user = await getOrCreateUser(chatId);
    
    // Vérifier les paramètres de notification
    const settings = user.notification_settings || {
      investment_reminders: true,
      trading_updates: true,
      plan_expiry: true,
      referral_updates: true
    };
    
    if (!settings.investment_reminders) return;
    
    // Vérifier quand la dernière notification a été envoyée
    const now = Date.now();
    const lastNotification = user.last_investment_notification ? new Date(user.last_investment_notification).getTime() : 0;
    
    // Envoyer une notification toutes les 6 heures
    if (now - lastNotification < 6 * 60 * 60 * 1000) return;
    
    const activePlans = getActivePlans(user);
    
    if (activePlans.length === 0 && !user.plan) {
      // Pas de plan actif
      const messages = [
        `🌟 **Opportunité d'investissement !**\n\nActuellement, le prix du SOL est à *$${SOL_PRICE.toFixed(2)}*.\nC'est le moment idéal pour commencer à investir et générer des profits passifs !\n\n👉 Explorez nos plans dès maintenant !`,
        `💰 **Générez des revenus passifs !**\n\nNos algorithmes de trading génèrent des profits quotidiens.\nCommencez avec seulement *0.1 SOL* et bénéficiez d'un ROI garanti !\n\n🚀 Découvrez nos plans d'investissement !`,
        `📈 **Marché favorable !**\n\nLe marché crypto présente des opportunités intéressantes.\nNos robots de trading sont optimisés pour maximiser vos gains.\n\n💎 Investissez dès aujourd'hui !`
      ];
      
      const randomMessage = messages[Math.floor(Math.random() * messages.length)];
      
      await bot.sendMessage(chatId, randomMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎯 Voir les plans', callback_data: 'plans_menu' }],
            [{ text: '🤖 Comment ça marche ?', callback_data: 'help_support' }]
          ]
        }
      });
    } else if (activePlans.length > 0) {
      // A des plans actifs
      const totalDaily = activePlans.reduce((sum, plan) => sum + PLANS[plan].daily, 0);
      
      const messages = [
        `⚡ **Vos plans génèrent des profits !**\n\nVos ${activePlans.length} plan(s) actif(s) génèrent *${totalDaily.toFixed(4)} SOL/jour*.\n💰 Valeur actuelle: *$${(totalDaily * SOL_PRICE).toFixed(2)}/jour*\n\nConsultez vos gains disponibles !`,
        `📊 **Performance de vos investissements**\n\nVos plans ont généré des profits aujourd'hui.\n💵 Gains quotidiens: *${totalDaily.toFixed(4)} SOL*\n🏦 Solde disponible: *${(parseFloat(user.main_balance) || 0).toFixed(4)} SOL*\n\nPensez à retirer ou réinvestir !`,
        `🚀 **Opportunité d'augmentation !**\n\nVous avez ${activePlans.length} plan(s) actif(s).\nPensez à ajouter un autre plan pour maximiser vos profits !\n\n💎 Explorez nos plans supérieurs !`
      ];
      
      const randomMessage = messages[Math.floor(Math.random() * messages.length)];
      
      await bot.sendMessage(chatId, randomMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📈 Tableau de bord', callback_data: 'dashboard' }],
            [{ text: '💰 Voir mes gains', callback_data: 'show_balance' }],
            [{ text: '🎯 Ajouter un plan', callback_data: 'plans_menu' }]
          ]
        }
      });
    }
    
    // Mettre à jour la date de dernière notification
    await updateUser(chatId, {
      last_investment_notification: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('sendInvestmentNotification error:', error.message);
  }
}

// Planificateur de notifications
function startNotificationScheduler() {
  // Envoyer des notifications toutes les 30 minutes
  setInterval(async () => {
    try {
      const users = await pool.query(
        'SELECT user_id FROM users WHERE waitlist_access_granted = true'
      );
      
      for (const user of users.rows) {
        try {
          await sendInvestmentNotification(user.user_id);
          // Attendre 1 seconde entre chaque notification pour éviter le spam
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`Notification error for user ${user.user_id}:`, error.message);
        }
      }
    } catch (error) {
      console.error('Notification scheduler error:', error.message);
    }
  }, 30 * 60 * 1000); // 30 minutes
}

// ==================== GESTION DES ÉTATS ====================

async function handleUserInput(chatId, text) {
  try {
    const userState = await getUserState(chatId);
    
    switch (userState.state) {
      case 'awaiting_wallet':
        await processWalletInput(chatId, text);
        break;
      case 'awaiting_withdrawal_amount':
        await processWithdrawalAmount(chatId, text);
        break;
      case 'awaiting_access_code':
        await processAccessCode(chatId, text);
        break;
      default:
        // Si pas d'état spécial, vérifier si c'est un code d'accès
        if (text && text.length <= 10) {
          await processAccessCode(chatId, text);
        }
        break;
    }
  } catch (error) {
    console.error('handleUserInput error:', error.message);
  }
}

async function processWalletInput(chatId, walletAddress) {
  try {
    const user = await getOrCreateUser(chatId);
    
    if (!walletAddress || walletAddress.length < 32 || walletAddress.length > 44) {
      await bot.sendMessage(chatId,
        '❌ **ADRESSE SOLANA INVALIDE**\n\n' +
        'L\'adresse Solana doit comporter entre 32 et 44 caractères.\n' +
        '📝 **Exemple valide :** So11111111111111111111111111111111111111112\n\n' +
        '🔍 **Comment trouver mon adresse Solana ?**\n' +
        '1. Ouvrez votre wallet (Phantom, Solflare, etc.)\n' +
        '2. Cliquez sur "Receive"\n' +
        '3. Copiez l\'adresse qui commence par "So1..."\n\n' +
        '🔄 **Veuillez réessayer :**'
      );
      return;
    }
    
    const isUnique = await isWalletUnique(walletAddress, chatId);
    if (!isUnique) {
      await bot.sendMessage(chatId,
        '❌ **ADRESSE DÉJÀ UTILISÉE**\n\n' +
        'Cette adresse Solana est déjà associée à un autre compte.\n' +
        'Veuillez utiliser une adresse différente.\n\n' +
        '🔄 **Veuillez réessayer :**'
      );
      return;
    }
    
    await updateUser(chatId, { wallet: walletAddress });
    await clearUserState(chatId);
    
    await addTransaction(chatId, 'wallet_update', 0, `Wallet Solana configuré: ${walletAddress.substring(0, 15)}...`);
    
    const successMessage = `✅ **WALLET SOLANA CONFIGURÉ AVEC SUCCÈS !**\n\n` +
      `📍 **Votre adresse :**\n\`${walletAddress}\`\n\n` +
      `🔒 **Sécurité :**\n` +
      `• Cette adresse sera utilisée pour tous vos retraits\n` +
      `• Vérifiez bien l'adresse avant de confirmer\n` +
      `• Les retraits sont irréversibles\n\n` +
      `💰 **Vous pouvez maintenant :**\n` +
      `✅ Effectuer des retraits\n` +
      `✅ Recevoir vos gains\n` +
      `✅ Sécuriser vos fonds`;
    
    const buttons = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏦 FAIRE UN RETRAIT', callback_data: 'make_withdrawal' }],
          [{ text: '💼 MON PORTEFEUILLE', callback_data: 'wallet_menu' }],
          [{ text: '🏠 MENU PRINCIPAL', callback_data: 'main_menu' }]
        ]
      },
      parse_mode: 'Markdown'
    };
    
    await bot.sendMessage(chatId, successMessage, buttons);
    
  } catch (error) {
    console.error('processWalletInput error:', error.message);
    await bot.sendMessage(chatId,
      '❌ **ERREUR DE CONFIGURATION**\n\n' +
      'Impossible de configurer votre wallet Solana.\n' +
      'Veuillez réessayer avec une adresse valide.'
    );
  }
}

async function processWithdrawalAmount(chatId, text) {
  try {
    const amount = parseFloat(text);
    
    if (isNaN(amount) || amount <= 0) {
      await bot.sendMessage(chatId,
        '❌ **MONTANT INVALIDE**\n\n' +
        'Veuillez entrer un montant valide en SOL.\n' +
        '📝 **Exemple :** 0.5\n\n' +
        '🔄 **Veuillez réessayer :**'
      );
      return;
    }
    
    await clearUserState(chatId);
    await requestWithdrawalWithFees(chatId, amount);
    
  } catch (error) {
    console.error('processWithdrawalAmount error:', error.message);
    await bot.sendMessage(chatId, '❌ Erreur lors du traitement du montant.');
  }
}

async function processAccessCode(chatId, text) {
  try {
    const user = await getOrCreateUser(chatId);
    
    if (user.waitlist_access_granted) {
      await bot.sendMessage(chatId, '✅ Vous avez déjà un accès complet !');
      await showMainMenu(chatId);
      return;
    }
    
    const referrerUser = await pool.query(
      'SELECT * FROM users WHERE referral_code = $1',
      [text.toUpperCase()]
    );
    
    if (referrerUser.rows.length > 0) {
      const referrerId = referrerUser.rows[0].user_id;
      
      if (user.referrer) {
        await bot.sendMessage(chatId, '❌ Vous avez déjà utilisé un code d\'accès');
      } else {
        await updateUser(chatId, {
          referrer: referrerId,
          access_code_used: text,
          waitlist_access_granted: true
        });
        
        await pool.query(
          'UPDATE users SET referrals = referrals + 1 WHERE user_id = $1',
          [referrerId]
        );
        
        await bot.sendMessage(chatId, 
          `✅ **CODE D'ACCÈS VALIDÉ !**\n\n` +
          `🎉 Accès immédiat accordé !\n\n` +
          `Bienvenue dans la communauté COVESTING !`
        );
        
        await showAccessApproved(chatId, null);
        
        try {
          await bot.sendMessage(referrerId, 
            `🎉 **NOUVEAU PARRAINAGE !**\n\n` +
            `👤 **Nouveau membre:** ${user.first_name || 'Nouvel utilisateur'}\n` +
            `📊 **Total parrainages:** +1\n\n` +
            `💰 **Vous gagnerez 10% lorsqu'il effectuera un dépôt !**`
          );
        } catch (error) {
          console.error('Erreur notification parrain:', error.message);
        }
      }
    } else {
      await bot.sendMessage(chatId,
        '❌ **CODE D\'ACCÈS INVALIDE**\n\n' +
        'Le code que vous avez entré n\'est pas valide.\n' +
        'Veuillez vérifier et réessayer.\n\n' +
        '🔄 **Veuillez réessayer :**'
      );
    }
    
  } catch (error) {
    console.error('processAccessCode error:', error.message);
    await bot.sendMessage(chatId, '❌ Erreur lors du traitement du code d\'accès.');
  }
}

// ==================== COMMANDES ====================

bot.onText(/\/myearnings/, async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    const user = await getOrCreateUser(chatId);
    const lifetimeEarnings = getLifetimeEarnings(user);
    
    // Récupérer les transactions récentes
    const transactions = await pool.query(
      `SELECT * FROM transactions 
       WHERE user_id = $1 AND type IN ('daily_earning', 'referral_bonus', 'auto_transfer')
       ORDER BY created_at DESC LIMIT 10`,
      [chatId]
    );
    
    let message = `📈 **VOS GAINS DÉTAILLÉS**\n\n` +
      `💰 **TOTAUX DEPUIS LE DÉBUT :**\n` +
      `• 🤖 **Trading :** ${lifetimeEarnings.trading.toFixed(6)} SOL ($${convertSOLtoUSDT(lifetimeEarnings.trading).toFixed(2)})\n` +
      `• 👥 **Parrainage :** ${lifetimeEarnings.referral.toFixed(6)} SOL ($${convertSOLtoUSDT(lifetimeEarnings.referral).toFixed(2)})\n` +
      `• 🏦 **Total gagné :** ${lifetimeEarnings.total.toFixed(6)} SOL ($${convertSOLtoUSDT(lifetimeEarnings.total).toFixed(2)})\n\n` +
      `💵 **ACTUELLEMENT DISPONIBLE :** ${(parseFloat(user.main_balance) || 0).toFixed(6)} SOL\n\n`;
    
    if (transactions.rows.length > 0) {
      message += `📝 **10 DERNIERS GAINS :**\n\n`;
      
      transactions.rows.forEach((t, index) => {
        const typeEmoji = t.type === 'daily_earning' ? '🤖' : 
                         t.type === 'referral_bonus' ? '👥' : '🔄';
        const date = new Date(t.created_at).toLocaleDateString();
        
        message += `${index + 1}. ${typeEmoji} **+${parseFloat(t.amount).toFixed(6)} SOL**\n`;
        message += `   📅 ${date}\n`;
        message += `   📝 ${t.description}\n\n`;
      });
    } else {
      message += `📭 **Aucun gain enregistré pour le moment.**\n`;
      message += `Commencez à trader ou parrainez des amis !\n\n`;
    }
    
    message += `💡 **Tous vos gains sont automatiquement transférés vers votre compte principal !**`;
    
    const buttons = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🤖 COMMENCER À TRADER', callback_data: 'trading_menu' },
            { text: '👥 PARRAINER', callback_data: 'referral_menu' }
          ],
          [
            { text: '🏦 RETIRER', callback_data: 'make_withdrawal' },
            { text: '📊 TABLEAU DE BORD', callback_data: 'dashboard' }
          ],
          [{ text: '🏠 MENU PRINCIPAL', callback_data: 'main_menu' }]
        ]
      }
    };
    
    await bot.sendMessage(chatId, message, { ...buttons, parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('/myearnings error:', error.message);
    await bot.sendMessage(chatId, '❌ Erreur lors de la récupération des gains.');
  }
});

// Commande /start
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  try {
    const chatId = msg.chat.id;
    const args = match[1] || '';
    
    // Mettre à jour les informations utilisateur
    const user = await getOrCreateUser(chatId);
    await updateUser(chatId, {
      username: msg.from.username,
      first_name: msg.from.first_name,
      last_name: msg.from.last_name
    });
    
    if (chatId === ADMIN_ID) {
      await updateUser(chatId, {
        waitlist_access_granted: true,
        free_plan_requirements_met: true
      });
      await showMainMenu(chatId);
      return;
    }
    
    if (user.waitlist_access_granted) {
      await showMainMenu(chatId);
      return;
    }
    
    if (args) {
      await processAccessCode(chatId, args);
      return;
    }
    
    const welcomeMessage = `🚀 **BIENVENUE SUR COVESTING INVEST**\n\n` +
      `🤖 Votre assistant d'investissement crypto intelligent\n\n` +
      `📊 **CE QUE COVESTING INVEST VOUS PERMET DE FAIRE :**\n` +
      `• 💼 Investir en sécurité dans des stratégies crypto sélectionnées\n` +
      `• 📈 Suivre vos profits en temps réel\n` +
      `• 🔁 Réinvestir ou retirer à tout moment\n` +
      `• 🧠 Bénéficier d'une gestion intelligente des risques\n\n` +

      `🔑 **AVEZ-VOUS UN CODE D'ACCÈS ?**\n` +
      `Entrez-le ci-dessous pour débloquer un accès instantané.\n\n` +
      `🙋 **PAS DE CODE D'ACCÈS ?**\n` +
      `👇 Appuyez sur le bouton ci-dessous pour rejoindre la liste d'attente et obtenir un accès anticipé.\n\n` +
      `🎯 **COMMENCEZ À CONSTRUIRE VOTRE PORTEFEUILLE CRYPTO DÈS AUJOURD'HUI !**`;

    const buttons = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎟️ Rejoindre la file', callback_data: 'join_queue' }],
          [{ text: '🔑 Entrer code d\'accès', callback_data: 'enter_access_code' }]
        ]
      },
      parse_mode: 'Markdown'
    };

    await bot.sendMessage(chatId, welcomeMessage, buttons);
    
  } catch (error) {
    console.error('/start error:', error);
    await bot.sendMessage(msg.chat.id, '❌ Une erreur est survenue. Veuillez réessayer.');
  }
});

// Gestion des messages
bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text;
    
    // Ignorer les commandes
    if (text && text.startsWith('/')) {
      return;
    }
    
    // Gérer l'entrée utilisateur en fonction de l'état
    if (text) {
      await handleUserInput(chatId, text);
    }
  } catch (error) {
    console.error('Message handler error:', error.message);
  }
});

// ==================== FONCTIONS D'AFFICHAGE ====================

async function showAccessCodeInput(chatId, messageId) {
  try {
    await setUserState(chatId, 'awaiting_access_code');
    
    const message = `🔑 **CODE D'ACCÈS**\n\n` +
      `Veuillez entrer votre code d'accès :\n\n` +
      `📝 **Format :** 6 caractères (ex: ABC123)\n` +
      `💡 **Où trouver ?** Demandez à votre parrain\n\n` +
      `🔄 **Entrez votre code ci-dessous :**`;

    const buttons = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '◀️ Annuler', callback_data: 'main_menu' }]
        ]
      }
    };

    if (messageId) {
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        ...buttons,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.sendMessage(chatId, message, buttons);
    }
  } catch (error) {
    console.error('showAccessCodeInput error:', error.message);
  }
}

async function showWaitlist(chatId, messageId) {
  try {
    const user = await getOrCreateUser(chatId);
    
    // Générer une position aléatoire pour l'effet visuel
    const waitlistPosition = Math.floor(Math.random() * 10000) + 20000;
    const waitTimeHours = Math.floor(Math.random() * 2) + 1;
    const waitTimeMinutes = Math.floor(Math.random() * 60);
    
    // Simuler le temps d'attente
    const waitTimeText = waitTimeHours > 0 
      ? `${waitTimeHours}h ${waitTimeMinutes}m` 
      : `${waitTimeMinutes}m`;
    
    const message = `🎟️ **VOUS ÊTES DANS LA FILE D'ATTENTE !**\n\n` +
      `📊 **Votre position :** #${waitlistPosition}\n` +
      `⏱️ **Accès accordé dans :** ${waitTimeText}\n\n` +
      `🔄 **Actualisation automatique...**\n\n` +
      `💡 **Pour un accès immédiat :**\n` +
      `Demandez un code d'accès à un membre existant !`;
    
    // Simuler le compte à rebours
    let remainingSeconds = (waitTimeHours * 3600) + (waitTimeMinutes * 60);
    
    const updateMessage = async () => {
      if (remainingSeconds <= 0) {
        await updateUser(chatId, { waitlist_access_granted: true });
        await showAccessApproved(chatId, messageId);
        return;
      }
      
      const hours = Math.floor(remainingSeconds / 3600);
      const minutes = Math.floor((remainingSeconds % 3600) / 60);
      const seconds = remainingSeconds % 60;
      
      const updatedMessage = `🎟️ **VOUS ÊTES DANS LA FILE D'ATTENTE !**\n\n` +
        `📊 **Votre position :** #${waitlistPosition}\n` +
        `⏱️ **Accès accordé dans :** ${hours > 0 ? `${hours}h ` : ''}${minutes}m ${seconds}s\n\n` +
        `🔄 **Actualisation automatique...**\n\n` +
        `💡 **Pour un accès immédiat :**\n` +
        `Demandez un code d'accès à un membre existant !`;
      
      try {
        await bot.editMessageText(updatedMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown'
        });
      } catch (error) {
        // Ignorer les erreurs d'édition
      }
      
      remainingSeconds--;
      
      if (remainingSeconds > 0) {
        setTimeout(updateMessage, 1000);
      }
    };
    
    if (messageId) {
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      });
    } else {
      const sentMessage = await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      messageId = sentMessage.message_id;
    }
    
    // Démarrer le compte à rebours
    setTimeout(updateMessage, 1000);
    
  } catch (error) {
    console.error('showWaitlist error:', error.message);
  }
}

async function showAccessApproved(chatId, messageId) {
  try {
    // Échapper les caractères spéciaux dans le lien
    const safeCommunityLink = COMMUNITY_LINK || '';
    
    const message = 
      '<b>🎉 FÉLICITATIONS !</b>\n\n' +
      '<b>✅ Votre code d\'accès a été approuvé avec succès ! 🎉</b>\n\n' +
      '<b>👋 BIENVENUE SUR COVESTING INVEST</b>\n' +
      'Votre plateforme d\'investissement crypto de confiance.\n\n' +
      '<b>💼 CE QUE VOUS POUVEZ FAIRE :</b>\n' +
      '• Investir dans des opportunités crypto structurées\n' +
      '• Surveiller votre performance en temps réel\n' +
      '• Réinvestir vos profits\n' +
      '• Effectuer des retraits en toute transparence\n\n' +
      '<b>🟢 Accès Accordé :</b> COVESTING INVEST\n\n' +
      '<b>📌 Pour commencer :</b>\n' +
      `🔗 <a href="${safeCommunityLink}">Rejoignez notre communauté</a>\n` +
      '📘 Guide d\'investissement\n' +
      '▶️ Tutoriels\n\n' +
      '<b>👇 PRÊT À COMMENCER ?</b>\n' +
      'Appuyez sur <b>Continuer</b> ci-dessous pour accéder au menu principal 🚀';

    const buttons = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '➡️ CONTINUER', callback_data: 'continue_to_bot' }]
        ]
      },
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };

    if (messageId) {
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: buttons.reply_markup,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    } else {
      await bot.sendMessage(chatId, message, buttons);
    }
  } catch (error) {
    console.error('showAccessApproved error:', error.message);
    
    // Version fallback sans HTML
    try {
      const simpleMessage = 
        '✅ ACCÈS APPROUVÉ ! 🎉\n\n' +
        'Bienvenue sur COVESTING INVEST !\n\n' +
        'Cliquez sur CONTINUER pour accéder au menu principal.';
      
      await bot.sendMessage(chatId, simpleMessage, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➡️ CONTINUER', callback_data: 'continue_to_bot' }]
          ]
        },
        disable_web_page_preview: true
      });
    } catch (fallbackError) {
      console.error('Fallback error:', fallbackError.message);
    }
  }
}

async function showMainMenu(chatId, messageId = null) {
  try {
    console.log(`🔄 showMainMenu appelé pour ${chatId}, messageId: ${messageId}`);
    
    const user = await getOrCreateUser(chatId).catch(error => {
      console.error('❌ Erreur getOrCreateUser:', error);
      throw error;
    });
    
    if (!user) {
      console.error(`❌ Utilisateur ${chatId} non trouvé/créé`);
      await bot.sendMessage(chatId, '❌ Erreur de chargement du profil. Essayez /start');
      return;
    }
    
    const totalAvailable = getTotalBalance(user) || 0;
    const totalUSDT = convertSOLtoUSDT(totalAvailable);
    const lifetimeEarnings = getLifetimeEarnings(user);
    
    const activePlans = getActivePlans(user);
    const planNames = activePlans.length > 0 
      ? activePlans.map(plan => PLANS[plan]?.name || plan).join(', ')
      : user.plan ? (PLANS[user.plan]?.name || user.plan) : 'Aucun plan';

    const buttons = [
      [{ text: `💰 Disponible: ${totalAvailable.toFixed(4)} SOL ($${totalUSDT.toFixed(2)})`, callback_data: 'show_balance' }],
      [{ text: '📊 TABLEAU DE BORD', callback_data: 'dashboard' }],
      [
        { text: '🎯 PLANS', callback_data: 'plans_menu' },
        { text: '💼 WALLET', callback_data: 'wallet_menu' }
      ],
      [
        { text: '👥 PARRAINAGE', callback_data: 'referral_menu' },
        { text: '🤖 TRADING', callback_data: 'trading_menu' }
      ],
      [
        { text: '📈 MES GAINS', callback_data: 'my_earnings' },
        { text: '🏦 MES RETRAITS', callback_data: 'withdrawal_history' }
      ],
      [{ text: 'ℹ️ AIDE & SUPPORT', callback_data: 'help_support' }]
    ];
    
    if (chatId === ADMIN_ID) {
      buttons.push([{ text: '👑 ADMIN PANEL', callback_data: 'admin_panel' }]);
    }

    let statusMessage = '';
    if (user.withdrawal_status === 'pending') {
      statusMessage = `\n⏳ **Retrait en attente:** ${parseFloat(user.withdrawal_pending || 0).toFixed(4)} SOL`;
    }

    let freePlanExpired = '';
    if (user.plan === 'free' && user.free_plan_expiry && Date.now() > user.free_plan_expiry) {
      freePlanExpired = `\n⚠️ **Votre essai gratuit a expiré ! Mettez à niveau pour continuer à gagner.**`;
    }
    
    let referralStatus = '';
    if (user.plan === 'free' && !user.free_plan_requirements_met) {
      const validRefs = user.valid_referrals || 0;
      const remaining = 3 - validRefs;
      referralStatus = `\n👥 **Parrainages valides:** ${validRefs}/3 (${remaining} restant)`;
    }

    const welcomeMessage = 
      '<b>🏦 COVESTING TRADING BOT 🚀</b>\n\n' +
      '<i>Générez un revenu passif avec notre technologie de trading algorithmique avancée !</i>\n\n' +
      '<b>💡 Conçu pour les investisseurs et traders</b> souhaitant faire croître leur capital grâce à des stratégies de trading structurées, une exécution automatisée et un suivi de performance transparent — le tout depuis Telegram.\n\n' +
      '<b>⚠️ AVIS DE SÉCURITÉ :</b>\n' +
      'COVESTING INVEST ne vous demandera jamais vos clés privées ou phrases de récupération.\n' +
      'Méfiez-vous des faux airdrops, publicités ou liens externes prétendant être nous.\n\n' +
      '<b>📊 VOTRE STATUT :</b>\n' +
      `• <b>Plan(s) :</b> ${planNames}\n` +
      `• <b>Disponible pour retrait :</b> ${totalAvailable.toFixed(4)} SOL ($${totalUSDT.toFixed(2)})\n` +
      `• <b>Total gains trading :</b> ${(lifetimeEarnings.trading || 0).toFixed(4)} SOL\n` +
      `• <b>Total gains parrainage :</b> ${(lifetimeEarnings.referral || 0).toFixed(4)} SOL\n` +
      `• <b>Total déposé :</b> ${(parseFloat(user.deposited) || 0).toFixed(4)} SOL\n` +
      `• <b>Parrainages :</b> ${user.referrals || 0}\n` +
      `• <b>Parrainages valides :</b> ${user.valid_referrals || 0}/3\n` +
      `${statusMessage}${freePlanExpired}${referralStatus}\n\n` +
      '<b>✨ FONCTIONNALITÉS :</b>\n' +
      '• 🤖 Trading Algorithmique 24/7\n' +
      '• 💰 Gains automatiquement transférés vers compte principal\n' +
      '• 📈 Retours Garantis\n' +
      '• 🔒 Sécurité Maximale des Fonds\n' +
      '• 💼 Support Professionnel\n\n' +
      '<b>🎯 COMMENT COMMENCER :</b>\n' +
      '1. Choisissez un plan d\'investissement\n' +
      '2. Activez votre plan\n' +
      '3. Commencez à trader depuis le menu Trading\n' +
      '4. Vos gains sont automatiquement disponibles pour retrait\n\n' +
      '<i>👉 Sélectionnez une option ci-dessous pour commencer !</i>';

    const options = {
      reply_markup: { inline_keyboard: buttons },
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };

    if (messageId) {
      try {
        console.log(`📝 Tentative d'édition du message ${messageId}`);
        await bot.editMessageText(welcomeMessage, {
          chat_id: chatId,
          message_id: messageId,
          ...options
        });
        console.log(`✅ Message ${messageId} édité avec succès`);
      } catch (editError) {
        console.error(`❌ Erreur d'édition: ${editError.message}`);
        
        // Si l'édition échoue, envoyer un nouveau message
        console.log(`📤 Envoi d'un nouveau message`);
        await bot.sendMessage(chatId, welcomeMessage, options);
        
        // Essayer de supprimer l'ancien message
        try {
          await bot.deleteMessage(chatId, messageId);
        } catch (deleteError) {
          console.error(`⚠️ Impossible de supprimer l'ancien message: ${deleteError.message}`);
        }
      }
    } else {
      console.log(`📤 Envoi d'un nouveau message principal`);
      await bot.sendMessage(chatId, welcomeMessage, options);
    }
  } catch (error) {
    console.error('❌ showMainMenu error détaillé:', {
      message: error.message,
      stack: error.stack,
      name: error.name,
      chatId: chatId
    });
    
    // Message d'erreur utilisateur
    try {
      await bot.sendMessage(chatId, 
        '❌ Une erreur est survenue lors du chargement du menu.\n\n' +
        'Veuillez réessayer avec /start',
        { parse_mode: 'HTML' }
      );
    } catch (sendError) {
      console.error('❌ Impossible d\'envoyer message d\'erreur:', sendError.message);
    }
  }
}

// ==================== CALLBACK HANDLER ====================
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const data = callbackQuery.data;
  const callbackQueryId = callbackQuery.id;

  try {
    await safeAnswerCallbackQuery(callbackQueryId);
    
        if (data.startsWith('confirm_withdrawal_')) {
      const amount = parseFloat(data.replace('confirm_withdrawal_', ''));
      if (!isNaN(amount) && amount > 0) {
        await processWithdrawalApproval(chatId, messageId, amount, callbackQueryId);
        return;
      }
    }
    
    switch(data) {
      case 'join_queue':
        await showWaitlist(chatId, messageId);
        break;
        
      case 'enter_access_code':
        await showAccessCodeInput(chatId, messageId);
        break;
        
      case 'continue_to_bot':
        await showMainMenu(chatId, messageId);
        break;
        
      case 'main_menu':
        await clearUserState(chatId);
        await showMainMenu(chatId, messageId);
        break;
        
      case 'dashboard':
        await showDashboard(chatId, messageId);
        break;
        
      case 'plans_menu':
        await showPlansMenu(chatId, messageId);
        break;
        
      case 'wallet_menu':
        await showWalletMenu(chatId, messageId);
        break;
        
      case 'referral_menu':
        await showReferralMenu(chatId, messageId);
        break;
        
      case 'trading_menu':
        await showTradingMenu(chatId, messageId);
        break;
        
      case 'start_trading':
        await startTrading(chatId, messageId);
        break;
        
      case 'admin_panel':
        await showAdminPanel(chatId, messageId);
        break;
        
      case 'show_balance':
        await showBalance(chatId, messageId);
        break;
        
      case 'show_free_plan':
        await showPlanDetails(chatId, messageId, 'free');
        break;
        
      case 'show_discovery_plan':
        await showPlanDetails(chatId, messageId, 'discovery');
        break;
        
      case 'show_basic_plan':
        await showPlanDetails(chatId, messageId, 'basic');
        break;
        
      case 'show_starter_plan':
        await showPlanDetails(chatId, messageId, 'starter');
        break;
        
      case 'show_advanced_plan':
        await showPlanDetails(chatId, messageId, 'advanced');
        break;
        
      case 'show_pro_plan':
        await showPlanDetails(chatId, messageId, 'pro');
        break;
        
      case 'show_expert_plan':
        await showPlanDetails(chatId, messageId, 'expert');
        break;
        
      case 'show_vip_plan':
        await showPlanDetails(chatId, messageId, 'vip');
        break;
        
      case 'activate_free_plan':
        await activateFreePlan(chatId, messageId, callbackQueryId);
        break;
        

case 'my_earnings':
  await showMyEarnings(chatId, messageId);
  break;


      case 'make_deposit':
        await bot.sendMessage(chatId, 
          `💰 **ACHAT DE PLAN**\n\n` +
          `Choisissez un plan dans le menu Plans.\n` +
          `Le paiement se fait directement via NowPayments.\n\n` +
          `📈 **Prix SOL actuel :** $${SOL_PRICE.toFixed(4)}`,
          { parse_mode: 'Markdown' }
        );
        break;
        
      case 'make_withdrawal':
        await setUserState(chatId, 'awaiting_withdrawal_amount');
        await bot.sendMessage(chatId, 
          `💰 **DEMANDE DE RETRAIT**\n\n` +
          `💵 **Entrez le montant que vous souhaitez retirer :**\n\n` +
          `📝 **Format :** Montant en SOL\n` +
          `📊 **Exemple :** 0.1\n\n` +
          `⚠️ **Minimum :** Varie selon le plan\n` +
          `📈 **Prix SOL actuel :** $${SOL_PRICE.toFixed(4)}\n\n` +
          `🔄 **Entrez le montant ci-dessous :**`,
          { parse_mode: 'Markdown' }
        );
        break;
        
      case 'set_wallet':
        await setUserState(chatId, 'awaiting_wallet');
        await bot.sendMessage(chatId,
          `⚙️ **CONFIGURATION DU WALLET**\n\n` +
          `**Pour configurer votre wallet Solana :**\n\n` +
          `📍 **Entrez votre adresse Solana :**\n\n` +
          `📋 **Exemple valide :**\n` +
          `So11111111111111111111111111111111111111112\n\n` +
          `🔍 **Comment trouver mon adresse Solana ?**\n` +
          `1. Ouvrez votre wallet (Phantom, Solflare, Trust Wallet, etc.)\n` +
          `2. Cliquez sur "Receive" ou "Recevoir"\n` +
          `3. Copiez l'adresse qui commence par "So1..."\n\n` +
          `🔄 **Entrez votre adresse ci-dessous :**`,
          { parse_mode: 'Markdown' }
        );
        break;
        
      case 'show_my_wallet':
        await showMyWallet(chatId, messageId);
        break;
        
      case 'copy_referral_link':
        await copyReferralLink(chatId, messageId, callbackQueryId);
        break;
        
      case 'referral_stats':
        await showReferralStats(chatId, messageId);
        break;
        
      case 'referral_tips':
        await showReferralTips(chatId, messageId);
        break;
        
      case 'referral_ranking':
        await showReferralRanking(chatId, messageId);
        break;
        
      case 'help_support':
        await showHelpSupport(chatId, messageId);
        break;
        
      case 'my_investments':
        await showMyInvestments(chatId, messageId);
        break;
        
      case 'compare_plans':
        await comparePlans(chatId, messageId);
        break;
        
      case 'my_plan':
        await showMyPlan(chatId, messageId);
        break;
        
      case 'withdrawal_history':
        await showWithdrawalHistory(chatId, messageId);
        break;
        
      case 'calculate_fees':
        await showFeeCalculator(chatId, messageId);
        break;
        
      case 'update_sol_price_user':
        await updatePrices();
        await showFeeCalculator(chatId, messageId);
        break;
        
        
      case 'cancel_withdrawal':
        await updateUser(chatId, {
          withdrawal_pending: 0,
          withdrawal_status: 'none'
        });
        await clearUserState(chatId);
        await showMainMenu(chatId, messageId);
        break;
        
      case 'activate_plan_discovery':
        await buyPlan(chatId, messageId, 'discovery');
        break;
        
      case 'activate_plan_basic':
        await buyPlan(chatId, messageId, 'basic');
        break;
        
      case 'activate_plan_starter':
        await buyPlan(chatId, messageId, 'starter');
        break;
        
      case 'activate_plan_advanced':
        await buyPlan(chatId, messageId, 'advanced');
        break;
        
      case 'activate_plan_pro':
        await buyPlan(chatId, messageId, 'pro');
        break;
        
      case 'activate_plan_expert':
        await buyPlan(chatId, messageId, 'expert');
        break;
        
      case 'activate_plan_vip':
        await buyPlan(chatId, messageId, 'vip');
        break;
        
      case 'admin_withdrawal_approve':
      case 'admin_withdrawal_reject':
      case 'admin_withdrawal_hold':
        await handleAdminWithdrawalAction(data, chatId, messageId, callbackQueryId);
        break;
        
      default:
        if (data.startsWith('buy_')) {
          const plan = data.replace('buy_', '');
          await buyPlan(chatId, messageId, plan);
        } else if (data.startsWith('admin_')) {
          await handleAdminCallback(data, chatId, messageId, callbackQueryId);
        } else if (data.startsWith('admin_withdrawal_action_')) {
          const parts = data.split('_');
          const action = parts[3];
          const withdrawalId = parseInt(parts[4]);
          await handleAdminWithdrawalAction(action, chatId, messageId, callbackQueryId, withdrawalId);
        }
        break;
    }
  } catch (error) {
    console.error('Callback error:', error.message);
  }
});

// ==================== FONCTIONS PRINCIPALES ====================

async function showMyEarnings(chatId, messageId) {
  try {
    const user = await getOrCreateUser(chatId);
    const lifetimeEarnings = getLifetimeEarnings(user);
    
    // Récupérer les transactions récentes pour montrer l'historique
    const transactions = await pool.query(
      `SELECT * FROM transactions 
       WHERE user_id = $1 AND type IN ('daily_earning', 'referral_bonus', 'auto_transfer')
       ORDER BY created_at DESC LIMIT 10`,
      [chatId]
    );
    
    // Calculer les gains du mois en cours
    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const monthlyEarnings = await pool.query(
      `SELECT SUM(amount) as total FROM transactions 
       WHERE user_id = $1 
       AND type IN ('daily_earning', 'referral_bonus', 'auto_transfer')
       AND created_at >= $2`,
      [chatId, firstDayOfMonth]
    );
    
    const monthlyTotal = parseFloat(monthlyEarnings.rows[0]?.total || 0);
    
    // Calculer les gains de la semaine en cours
    const firstDayOfWeek = new Date(now);
    firstDayOfWeek.setDate(now.getDate() - now.getDay()); // Dimanche de cette semaine
    firstDayOfWeek.setHours(0, 0, 0, 0);
    
    const weeklyEarnings = await pool.query(
      `SELECT SUM(amount) as total FROM transactions 
       WHERE user_id = $1 
       AND type IN ('daily_earning', 'referral_bonus', 'auto_transfer')
       AND created_at >= $2`,
      [chatId, firstDayOfWeek]
    );
    
    const weeklyTotal = parseFloat(weeklyEarnings.rows[0]?.total || 0);
    
    // Récupérer le nombre de jours de trading
    const tradingDays = await pool.query(
      `SELECT COUNT(DISTINCT DATE(created_at)) as days FROM transactions 
       WHERE user_id = $1 AND type = 'daily_earning'`,
      [chatId]
    );
    
    const daysTraded = parseInt(tradingDays.rows[0]?.days || 0);
    const averageDailyEarnings = daysTraded > 0 ? lifetimeEarnings.trading / daysTraded : 0;
    
    let message = `📈 **VOS GAINS DÉTAILLÉS**\n\n`;
    
    // Section 1: Totaux PERMANENTS depuis le début
    message += `💰 **TOTAUX DEPUIS LE DÉBUT (PERMANENTS) :**\n`;
    message += `• 🤖 **Trading :** ${lifetimeEarnings.trading.toFixed(6)} SOL ($${convertSOLtoUSDT(lifetimeEarnings.trading).toFixed(2)})\n`;
    message += `• 👥 **Parrainage :** ${lifetimeEarnings.referral.toFixed(6)} SOL ($${convertSOLtoUSDT(lifetimeEarnings.referral).toFixed(2)})\n`;
    message += `• 🏦 **Total gagné :** ${lifetimeEarnings.total.toFixed(6)} SOL ($${convertSOLtoUSDT(lifetimeEarnings.total).toFixed(2)})\n\n`;
    
    // Section 2: Statistiques temporelles
    message += `📊 **STATISTIQUES TEMPORELLES :**\n`;
    message += `• 📅 **Ce mois-ci :** ${monthlyTotal.toFixed(6)} SOL ($${convertSOLtoUSDT(monthlyTotal).toFixed(2)})\n`;
    message += `• 📅 **Cette semaine :** ${weeklyTotal.toFixed(6)} SOL ($${convertSOLtoUSDT(weeklyTotal).toFixed(2)})\n`;
    message += `• 📊 **Jours tradés :** ${daysTraded} jours\n`;
    message += `• 📈 **Moyenne quotidienne :** ${averageDailyEarnings.toFixed(6)} SOL\n\n`;
    
    // Section 3: Soldes actuels
    message += `💵 **SOLDES ACTUELS :**\n`;
    message += `• 🏦 **Principal (retirable) :** ${(parseFloat(user.main_balance) || 0).toFixed(6)} SOL ($${convertSOLtoUSDT(parseFloat(user.main_balance) || 0).toFixed(2)})\n`;
    message += `• 🤖 **Trading :** ${(parseFloat(user.trading_balance) || 0).toFixed(6)} SOL ($${convertSOLtoUSDT(parseFloat(user.trading_balance) || 0).toFixed(2)})\n`;
    message += `• 👥 **Parrainage :** ${(parseFloat(user.referral_balance) || 0).toFixed(6)} SOL ($${convertSOLtoUSDT(parseFloat(user.referral_balance) || 0).toFixed(2)})\n\n`;
    
    // Section 4: Historique récent
    if (transactions.rows.length > 0) {
      message += `📝 **10 DERNIERS GAINS :**\n\n`;
      
      transactions.rows.forEach((t, index) => {
        const typeEmoji = t.type === 'daily_earning' ? '🤖' : 
                         t.type === 'referral_bonus' ? '👥' : '🔄';
        const date = new Date(t.created_at);
        const formattedDate = `${date.getDate().toString().padStart(2, '0')}/${(date.getMonth() + 1).toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
        
        message += `${index + 1}. ${typeEmoji} **+${parseFloat(t.amount).toFixed(6)} SOL**\n`;
        message += `   📅 ${formattedDate}\n`;
        message += `   📝 ${t.description.substring(0, 30)}${t.description.length > 30 ? '...' : ''}\n\n`;
      });
    } else {
      message += `📭 **Aucun gain enregistré pour le moment.**\n`;
      message += `Commencez à trader ou parrainez des amis !\n\n`;
    }
    
    // Section 5: Prochain trading disponible
    const nowTimestamp = Math.floor(Date.now() / 1000);
    let nextTradingInfo = '';
    
    if (user.last_claim && user.last_claim > 0) {
      const nextClaimIn = Math.max(0, 86400 - (nowTimestamp - user.last_claim));
      const canTrade = nextClaimIn === 0;
      
      if (canTrade) {
        nextTradingInfo = `✅ **TRADING DISPONIBLE MAINTENANT !**\n`;
      } else {
        const hoursLeft = Math.floor(nextClaimIn / 3600);
        const minutesLeft = Math.floor((nextClaimIn % 3600) / 60);
        nextTradingInfo = `⏳ **Prochain trading dans :** ${hoursLeft}h ${minutesLeft}m\n`;
      }
    } else {
      nextTradingInfo = `✅ **TRADING DISPONIBLE !**\n`;
    }
    
    message += `🔄 **STATUT :**\n${nextTradingInfo}\n`;
    
    message += `💡 **Tous vos gains sont automatiquement transférés vers votre compte principal !**\n`;
    message += `📊 **Ces totaux sont PERMANENTS et ne seront jamais réinitialisés.**`;

    const buttons = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🤖 COMMENCER À TRADER', callback_data: 'trading_menu' },
            { text: '👥 PARRAINER', callback_data: 'referral_menu' }
          ],
          [
            { text: '🏦 RETIRER', callback_data: 'make_withdrawal' },
            { text: '📊 TABLEAU DE BORD', callback_data: 'dashboard' }
          ],
          [
            { text: '💼 MON PORTEFEUILLE', callback_data: 'wallet_menu' },
            { text: '🎯 MES PLANS', callback_data: 'my_plan' }
          ],
          [{ text: '🏠 MENU PRINCIPAL', callback_data: 'main_menu' }]
        ]
      }
    };
    
    if (messageId) {
      try {
        await bot.editMessageText(message, {
          chat_id: chatId,
          message_id: messageId,
          ...buttons,
          parse_mode: 'Markdown'
        });
      } catch (editError) {
        // Si l'édition échoue, envoyer un nouveau message
        await bot.sendMessage(chatId, message, { ...buttons, parse_mode: 'Markdown' });
      }
    } else {
      await bot.sendMessage(chatId, message, { ...buttons, parse_mode: 'Markdown' });
    }
    
  } catch (error) {
    console.error('/myearnings error détaillé:', error.message);
    
    try {
      // Message d'erreur simplifié
      await bot.sendMessage(chatId, 
        '❌ Erreur lors de la récupération des gains.\n\n' +
        'Veuillez réessayer dans quelques instants.',
        { parse_mode: 'Markdown' }
      );
    } catch (sendError) {
      console.error('Erreur envoi message:', sendError.message);
    }
  }
}

async function showDashboard(chatId, messageId) {
  try {
    const user = await getOrCreateUser(chatId);
    const totalAvailable = getTotalBalance(user);
    const totalUSDT = convertSOLtoUSDT(totalAvailable);
    const lifetimeEarnings = getLifetimeEarnings(user);
    
    const activePlans = getActivePlans(user);
    const planNames = activePlans.length > 0 
      ? activePlans.map(plan => PLANS[plan].name).join(', ')
      : user.plan ? PLANS[user.plan].name : 'Aucun plan';

    const totalDaily = activePlans.reduce((sum, plan) => sum + PLANS[plan].daily, 0);

    const now = Math.floor(Date.now() / 1000);
    
    let canTrade = true;
    let nextClaimIn = 0;
    let hoursLeft = 0;
    let minutesLeft = 0;
    
    if (user.last_claim && user.last_claim > 0) {
      nextClaimIn = Math.max(0, 86400 - (now - user.last_claim));
      canTrade = nextClaimIn === 0;
      hoursLeft = Math.floor(nextClaimIn / 3600);
      minutesLeft = Math.floor((nextClaimIn % 3600) / 60);
    }

    const withdrawalCheck = await canUserWithdraw(chatId);
    const canWithdraw = withdrawalCheck.canWithdraw;
    const withdrawalReason = withdrawalCheck.reason || '';

    const dashboardMessage = `📊 **TABLEAU DE BORD PERSONNEL**\n\n` +
      `💰 **DISPONIBLE POUR RETRAIT :**\n` +
      `• 💵 Compte Principal : ${totalAvailable.toFixed(4)} SOL ($${totalUSDT.toFixed(2)})\n\n` +
      `🎯 **VOS GAINS TOTAUX :**\n` +
      `• 🤖 Trading : ${lifetimeEarnings.trading.toFixed(4)} SOL ($${convertSOLtoUSDT(lifetimeEarnings.trading).toFixed(2)})\n` +
      `• 👥 Parrainage : ${lifetimeEarnings.referral.toFixed(4)} SOL ($${convertSOLtoUSDT(lifetimeEarnings.referral).toFixed(2)})\n` +
      `• 🏦 Total gagné : ${lifetimeEarnings.total.toFixed(4)} SOL ($${convertSOLtoUSDT(lifetimeEarnings.total).toFixed(2)})\n\n` +
      `📈 **INVESTISSEMENT ACTIF :**\n` +
      `• 📋 Plan(s) : ${planNames}\n` +
      `• 📈 Gain Quotidien Total : ${totalDaily.toFixed(4)} SOL ($${convertSOLtoUSDT(totalDaily).toFixed(2)})\n` +
      `• ⏰ Prochain Trading : ${canTrade ? '✅ DISPONIBLE MAINTENANT' : `⏳ Dans ${hoursLeft}h ${minutesLeft}m`}\n\n` +
      `👥 **RÉSEAU :**\n` +
      `• 🔗 Parrainages Directs : ${user.referrals || 0}\n` +
      `• ✅ Parrainages Valides : ${user.valid_referrals || 0}/3\n\n` +
      `⚡ **ACTIONS RAPIDES :**\n` +
      `${canTrade ? '✅ Allez dans le menu Trading pour lancer les robots !' : '⏳ Attendez le prochain trading...'}\n` +
      `${canWithdraw ? '✅ Retraits disponibles' : `❌ ${withdrawalReason}`}`;

    const buttons = [
      [{ text: '🤖 TRADING', callback_data: 'trading_menu' }],
      [
        { text: '📈 PLANS', callback_data: 'plans_menu' },
        { text: '🏦 RETRAIT', callback_data: 'make_withdrawal' }
      ],
      [
        { text: '👥 PARRAINAGE', callback_data: 'referral_menu' },
        { text: '💼 WALLET', callback_data: 'wallet_menu' }
      ],
      [{ text: '◀️ MENU', callback_data: 'main_menu' }]
    ];

    try {
      await bot.editMessageText(dashboardMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    } catch (error) {
      await bot.sendMessage(chatId, dashboardMessage, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    console.error('showDashboard error:', error.message);
  }
}

async function showPlansMenu(chatId, messageId) {
  try {
    const user = await getOrCreateUser(chatId);
    const activePlans = getActivePlans(user);
    const currentPlans = activePlans.length > 0 
      ? activePlans.map(plan => PLANS[plan].name).join(', ')
      : user.plan ? PLANS[user.plan].name : 'Aucun';

    const plansMessage = `🎯 **PLANS D'INVESTISSEMENT - TRADING CRYPTO**\n\n` +
      `*Votre plan(s) actuel(s) : ${currentPlans}*\n\n` +
      `📊 **PLANS DISPONIBLES :**\n\n` +
      `1️⃣ 🆓 **ESSAI GRATUIT** - *Testez notre plateforme*\n` +
      `• Prix : 0 SOL (0 USD)\n` +
      `• Quotidien : 0.005 SOL ($${convertSOLtoUSDT(0.005).toFixed(2)})\n` +
      `• Durée : 14 jours seulement\n` +
      `• Gain total max : ~0.07 SOL ($${convertSOLtoUSDT(0.07).toFixed(2)})\n\n` +
      `2️⃣ 🔍 **DÉCOUVERTE 150%** - *Débutant*\n` +
      `• Prix : 0.1 SOL ($${convertSOLtoUSDT(0.1).toFixed(2)})\n` +
      `• Quotidien : 0.005 SOL ($${convertSOLtoUSDT(0.005).toFixed(2)})\n` +
      `• ROI : 150%\n` +
      `• Durée : 30 jours\n` +
      `• Break-even : ~20 jours\n` +
      `• Paires : ${PLANS.discovery.pairs}\n\n` +
      `3️⃣ 🥉 **BASIQUE 150%** - *Intermédiaire*\n` +
      `• Prix : 0.5 SOL ($${convertSOLtoUSDT(0.5).toFixed(2)})\n` +
      `• Quotidien : 0.025 SOL ($${convertSOLtoUSDT(0.025).toFixed(2)})\n` +
      `• ROI : 150%\n` +
      `• Durée : 30 jours\n` +
      `• Break-even : ~20 jours\n` +
      `• Paires : ${PLANS.basic.pairs}\n\n` +
      `4️⃣ 🚀 **STARTER 150%** - *Avancé*\n` +
      `• Prix : 1 SOL ($${convertSOLtoUSDT(1).toFixed(2)})\n` +
      `• Quotidien : 0.05 SOL ($${convertSOLtoUSDT(0.05).toFixed(2)})\n` +
      `• ROI : 150%\n` +
      `• Durée : 30 jours\n` +
      `• Break-even : ~20 jours\n` +
      `• Paires : ${PLANS.starter.pairs}\n\n` +
      `5️⃣ ⚡ **AVANCÉ 150%** - *Expert*\n` +
      `• Prix : 1.5 SOL ($${convertSOLtoUSDT(1.5).toFixed(2)})\n` +
      `• Quotidien : 0.075 SOL ($${convertSOLtoUSDT(0.075).toFixed(2)})\n` +
      `• ROI : 150%\n` +
      `• Durée : 30 jours\n` +
      `• Break-even : ~20 jours\n` +
      `• Paires : ${PLANS.advanced.pairs}\n\n` +
      `6️⃣ 🥈 **PRO 150%** - *Professionnel*\n` +
      `• Prix : 2 SOL ($${convertSOLtoUSDT(2).toFixed(2)})\n` +
      `• Quotidien : 0.10 SOL ($${convertSOLtoUSDT(0.10).toFixed(2)})\n` +
      `• ROI : 150%\n` +
      `• Durée : 30 jours\n` +
      `• Break-even : ~20 jours\n` +
      `• Paires : ${PLANS.pro.pairs}\n\n` +
      `7️⃣ 💎 **EXPERT 150%** - *Élite*\n` +
      `• Prix : 4 SOL ($${convertSOLtoUSDT(4).toFixed(2)})\n` +
      `• Quotidien : 0.20 SOL ($${convertSOLtoUSDT(0.20).toFixed(2)})\n` +
      `• ROI : 150%\n` +
      `• Durée : 30 jours\n` +
      `• Break-even : ~20 jours\n` +
      `• Paires : ${PLANS.expert.pairs}\n\n` +
      `8️⃣ 🥇 **VIP GLOBAL** - *VIP*\n` +
      `• Prix : 10 SOL ($${convertSOLtoUSDT(10).toFixed(2)})\n` +
      `• Quotidien : 0.50 SOL ($${convertSOLtoUSDT(0.50).toFixed(2)})\n` +
      `• Durée : 30 jours\n` +
      `• Break-even : ~20 jours\n` +
      `• Paires : ${PLANS.vip.pairs}\n\n` +
      `💡 **Comment ça marche ?**\n` +
      `• Choisissez un plan et payez directement via NowPayments\n` +
      `• Le plan s'active automatiquement après paiement\n` +
      `• Commencez à trader depuis le menu Trading\n` +
      `• Nos robots génèrent des profits 24/7\n` +
      `• Retirez quand vous voulez !\n\n` +
      `✨ **Vous pouvez cumuler plusieurs plans !**`;

    const buttons = [
      [{ text: '🆓 ESSAI GRATUIT', callback_data: 'show_free_plan' }],
      [{ text: '🔍 DÉCOUVERTE 150%', callback_data: 'show_discovery_plan' }],
      [
        { text: '🥉 BASIQUE 150%', callback_data: 'show_basic_plan' },
        { text: '🚀 STARTER 150%', callback_data: 'show_starter_plan' }
      ],
      [
        { text: '⚡ AVANCÉ 150%', callback_data: 'show_advanced_plan' },
        { text: '🥈 PRO 150%', callback_data: 'show_pro_plan' }
      ],
      [
        { text: '💎 EXPERT 150%', callback_data: 'show_expert_plan' },
        { text: '🥇 VIP GLOBAL', callback_data: 'show_vip_plan' }
      ],
      [
        { text: '📊 COMPARER', callback_data: 'compare_plans' },
        { text: '💼 MES PLANS', callback_data: 'my_plan' }
      ],
      [{ text: '◀️ RETOUR', callback_data: 'main_menu' }]
    ];

    try {
      await bot.editMessageText(plansMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    } catch (error) {
      await bot.sendMessage(chatId, plansMessage, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    console.error('showPlansMenu error:', error.message);
  }
}

async function showPlanDetails(chatId, messageId, planKey) {
  try {
    const user = await getOrCreateUser(chatId);
    const plan = PLANS[planKey];
    
    const activePlans = getActivePlans(user);
    const alreadyActive = activePlans.includes(planKey);
    
    let actionButton = '';
    let statusInfo = '';
    let canActivate = false;
    
    if (planKey === 'free') {
      if (user.free_plan_activated) {
        if (user.free_plan_expiry && Date.now() > user.free_plan_expiry) {
          statusInfo = '❌ **STATUT :** Essai gratuit expiré';
          actionButton = '🔄 RENOUVELER LE PLAN';
        } else {
          statusInfo = '✅ **STATUT :** Déjà activé';
          actionButton = '✅ Activé';
        }
      } else if (alreadyActive) {
        statusInfo = '⚠️ **STATUT :** Vous avez déjà ce plan actif';
        actionButton = '✅ Actif';
      } else {
        statusInfo = '✅ **STATUT :** Disponible pour activation';
        actionButton = '🎁 ACTIVER ESSAI GRATUIT';
        canActivate = true;
      }
    } else {
      if (alreadyActive) {
        statusInfo = '✅ **STATUT :** Plan actuellement actif';
        actionButton = '✅ ACTIF';
      } else {
        statusInfo = '✅ **STATUT :** Disponible pour achat';
        actionButton = `⚡ ACHETER ${plan.price} SOL`;
        canActivate = true;
      }
    }

    const planMessage = `🎯 **${plan.name.toUpperCase()}**\n\n` +
      `💰 **INVESTISSEMENT :** ${plan.price} SOL ($${convertSOLtoUSDT(plan.price).toFixed(2)})\n` +
      `📈 **GAINS QUOTIDIENS :** ${plan.daily} SOL ($${convertSOLtoUSDT(plan.daily).toFixed(2)})\n` +
      `📊 **ROI GARANTI :** ${plan.roi || 'Exceptionnel'}\n` +
      `⏰ **DURÉE :** ${plan.duration}\n` +
      `💸 **RETRAIT MINIMUM :** ${plan.min_withdrawal} SOL ($${convertSOLtoUSDT(plan.min_withdrawal).toFixed(2)})\n` +
      `🔄 **RETRAITS MAX/JOUR :** ${plan.max_withdrawals_per_day || 1}\n` +
      `🤖 **PAIRES DE TRADING :** ${plan.pairs} paires\n` +
      `⏱️ **DURÉE DE SESSION :** ${Math.floor(plan.session_duration / 60)} minutes\n` +
      `📝 **DESCRIPTION :** ${plan.description}\n\n` +
      `${statusInfo}\n\n` +
      `✨ **FONCTIONNALITÉS INCLUSES :**\n` +
      `${plan.features.map(f => `• ${f}`).join('\n')}\n\n` +
      `📈 **PROJECTION DE PROFITS :**\n` +
      `• Par jour : ${plan.daily} SOL ($${convertSOLtoUSDT(plan.daily).toFixed(2)})\n` +
      `• Par mois (30j) : ${(plan.daily * 30).toFixed(4)} SOL ($${convertSOLtoUSDT(plan.daily * 30).toFixed(2)})\n` +
      `• Retour sur investissement : ${plan.roi || 'Exceptionnel'}\n\n` +
      `💎 **Ce plan peut être cumulé avec d'autres !**`;

    const buttons = [];
    
    if (planKey === 'free' && canActivate) {
      buttons.push([{ text: actionButton, callback_data: 'activate_free_plan' }]);
    } else if (planKey !== 'free') {
      if (canActivate) {
        buttons.push([{ text: actionButton, callback_data: `buy_${planKey}` }]);
      } else {
        buttons.push([{ text: actionButton, callback_data: 'plans_menu' }]);
      }
    }
    
    buttons.push(
      [{ text: '📋 TOUS LES PLANS', callback_data: 'plans_menu' }],
      [{ text: '💼 MON WALLET', callback_data: 'wallet_menu' }],
      [{ text: '◀️ MENU PRINCIPAL', callback_data: 'main_menu' }]
    );

    try {
      await bot.editMessageText(planMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    } catch (error) {
      await bot.sendMessage(chatId, planMessage, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    console.error('showPlanDetails error:', error.message);
  }
}

async function activateFreePlan(chatId, messageId, callbackQueryId) {
  try {
    const user = await getOrCreateUser(chatId);
    
    if (user.free_plan_activated) {
      await bot.sendMessage(chatId, '❌ Vous avez déjà activé le plan gratuit !');
      return;
    }
    
    const expiryDate = Date.now() + (14 * 24 * 60 * 60 * 1000);
    
    await updateUser(chatId, { 
      plan: 'free',
      free_plan_activated: true,
      free_plan_expiry: expiryDate,
      free_plan_requirements_met: false,
      last_claim: 0
    });
    
    await addTransaction(chatId, 'plan_activation', 0, 'Activation plan essai gratuit (14 jours)');
    
    const successMessage = `✅ **ESSAI GRATUIT ACTIVÉ AVEC SUCCÈS !** 🎉\n\n` +
      `🎯 **Votre plan d'essai est maintenant actif pour 14 jours !**\n\n` +
      `📊 **DÉTAILS :**\n` +
      `• Plan : Essai Gratuit\n` +
      `• Gains quotidiens : 0.005 SOL ($${convertSOLtoUSDT(0.005).toFixed(2)})\n` +
      `• Durée : 14 jours\n` +
      `• Gain total max : ~0.07 SOL ($${convertSOLtoUSDT(0.07).toFixed(2)})\n` +
      `• Expiration : ${new Date(expiryDate).toLocaleDateString()}\n\n` +
      `⚠️ **CONDITIONS DE RETRAIT :**\n` +
      `Pour retirer vos gains, vous avez besoin de :\n` +
      `1. ✅ 3 parrainages valides (qui activent minimum le plan ${PLANS.free.min_referral_plan})\n` +
      `   OU\n` +
      `2. 💰 Passez à un plan payant\n\n` +
      `📊 **VOTRE STATUT ACTUEL :**\n` +
      `• Parrainages valides : 0/3\n` +
      `• Jours restants : 14\n\n` +
      `⚡ **VOUS POUVEZ MAINTENANT :**\n` +
      `✅ **Commencer à trader immédiatement**\n` +
      `✅ Parrainer des amis\n` +
      `✅ Gagner des profits quotidiens\n\n` +
      `💡 **Astuce :** Commencez à trader maintenant pour générer vos premiers profits !`;

    const buttons = [
      [{ text: '🚀 COMMENCER À TRADER', callback_data: 'trading_menu' }],
      [{ text: '👥 SYSTÈME DE PARRAINAGE', callback_data: 'referral_menu' }],
      [{ text: '💎 PASSER À UN PLAN', callback_data: 'plans_menu' }],
      [{ text: '🏠 MENU PRINCIPAL', callback_data: 'main_menu' }]
    ];
    
    try {
      await bot.editMessageText(successMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    } catch (error) {
      await bot.sendMessage(chatId, successMessage, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    }
    
  } catch (error) {
    console.error('activateFreePlan error:', error.message);
    await bot.sendMessage(chatId, '❌ Erreur lors de l\'activation. Veuillez réessayer.');
  }
}

async function buyPlan(chatId, messageId, planKey) {
  try {
    const user = await getOrCreateUser(chatId);
    const plan = PLANS[planKey];
    
    const activePlans = getActivePlans(user);
    const alreadyActive = activePlans.includes(planKey);
    
    if (alreadyActive) {
      await bot.sendMessage(chatId, '❌ Ce plan est déjà actif !');
      return;
    }
    
    const amountUSD = plan.price * SOL_PRICE;
    
    if (amountUSD < MIN_DEPOSIT_USD) {
      await bot.sendMessage(chatId, 
        `❌ **MONTANT TROP FAIBLE !**\n\n` +
        `💰 **Nécessaire :** $${MIN_DEPOSIT_USD} USD\n` +
        `💵 **Plan :** $${amountUSD.toFixed(2)} USD\n\n` +
        `💡 Choisissez un plan plus élevé.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    // Créer l'invoice NowPayments
    let paymentData;
    try {
      paymentData = await createNowPaymentsInvoice(chatId, amountUSD, `Achat plan ${plan.name} - ${plan.price} SOL`);
      
      if (!paymentData || !paymentData.id) {
        throw new Error('Aucune donnée de paiement valide reçue');
      }
    } catch (error) {
      console.error('⚠️ Erreur système de paiement:', error.message);
      throw new Error(`Erreur système de paiement: ${error.message}`);
    }

    // Enregistrer le paiement
    await pool.query(
      `INSERT INTO payments (
        user_id, 
        plan, 
        amount, 
        amount_usdt, 
        payment_id, 
        invoice_id,
        payment_url,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
      [
        chatId, 
        planKey, 
        plan.price, 
        amountUSD, 
        paymentData.payment_id, 
        paymentData.invoice_id,
        paymentData.payment_url
      ]
    );

    // Message avec bouton de paiement
    const paymentMessage = `💰 **ACHAT DU PLAN ${plan.name.toUpperCase()}**\n\n` +
      `💵 **MONTANT :** $${amountUSD.toFixed(2)} USD (${plan.price.toFixed(4)} SOL)\n` +
      `📈 **PRIX SOL ACTUEL :** $${SOL_PRICE.toFixed(4)}\n` +
      `🔗 **LIEN DE PAIEMENT :**\n${paymentData.payment_url}\n\n` +
      `📋 **IDENTIFIANT :** \`${paymentData.invoice_id}\`\n\n` +
      `📝 **INSTRUCTIONS :**\n` +
      `1. Cliquez sur le lien de paiement\n` +
      `2. Payez $${amountUSD.toFixed(2)} USD en SOL\n` +
      `3. Attendez 1-2 confirmations\n` +
      `4. Votre plan sera activé automatiquement\n\n` +
      `⚠️ **IMPORTANT :**\n` +
      `• Sauvegardez l'identifiant\n` +
      `• Le système vérifie automatiquement\n` +
      `• Contactez le support en cas de problème\n\n` +
      `💎 **Ce plan s'ajoutera à vos plans existants !**`;

    const buttons = [
      [{ text: '💳 PAYER MAINTENANT', url: paymentData.payment_url }],
      [
        { text: '◀️ PLANS', callback_data: 'plans_menu' },
        { text: '🏠 MENU', callback_data: 'main_menu' }
      ]
    ];

    await bot.sendMessage(chatId, paymentMessage, {
      reply_markup: { inline_keyboard: buttons },
      parse_mode: 'Markdown',
      disable_web_page_preview: false
    });
    
    // Message séparé avec l'ID pour référence
    await bot.sendMessage(chatId,
      `📋 **CONSERVEZ POUR RÉFÉRENCE**\n\n` +
      `Voici votre identifiant de transaction :\n\n` +
      `📝 **Invoice ID :** \`${paymentData.invoice_id}\`\n\n` +
      `Utilisez cet ID pour vérifier le statut du paiement.`,
      { parse_mode: 'Markdown' }
    );
    
    // Log pour l'admin
    await notifyAdmin(
      `🆕 **NOUVEL ACHAT DE PLAN INITIÉ**\n\n` +
      `👤 Utilisateur : ${chatId}\n` +
      `🎯 Plan : ${plan.name}\n` +
      `💰 Montant : $${amountUSD} (${plan.price} SOL)\n` +
      `📋 Invoice ID : ${paymentData.invoice_id}\n` +
      `🔗 URL : ${paymentData.payment_url}\n` +
      `⏰ Date : ${new Date().toLocaleString()}`
    );
      
  } catch (error) {
    console.error('❌ buyPlan error:', error.message);
    
    const fallbackMessage = `💰 **ACHAT DU PLAN ${planKey.toUpperCase()}**\n\n` +
      `💵 **MONTANT :** $${(plan.price * SOL_PRICE).toFixed(2)} USD (${plan.price.toFixed(4)} SOL)\n` +
      `📈 **PRIX SOL ACTUEL :** $${SOL_PRICE.toFixed(4)}\n\n` +
      `⚠️ **SYSTÈME DE PAIEMENT TEMPORAIREMENT INDISPONIBLE**\n\n` +
      `📝 **INSTRUCTIONS DE PAIEMENT MANUEL :**\n` +
      `1. Envoyez **${plan.price.toFixed(4)} SOL** à :\n` +
      `\`${DEPOSIT_WALLET}\`\n\n` +
      `2. Contactez le support avec :\n` +
      `• Votre ID utilisateur : ${chatId}\n` +
      `• Plan : ${planKey}\n` +
      `• Montant : ${plan.price} SOL\n` +
      `• TXID de votre transaction\n\n` +
      `📞 **CONTACTER LE SUPPORT :**\n@${SUPPORT_USERNAME}`;

    const buttons = [
      [{ text: '📞 SUPPORT', url: `https://t.me/${SUPPORT_USERNAME}` }],
      [
        { text: '◀️ PLANS', callback_data: 'plans_menu' },
        { text: '🏠 MENU', callback_data: 'main_menu' }
      ]
    ];

    await bot.sendMessage(chatId, fallbackMessage, {
      reply_markup: { inline_keyboard: buttons },
      parse_mode: 'Markdown'
    });
  }
}

async function showWalletMenu(chatId, messageId) {
  try {
    const user = await getOrCreateUser(chatId);
    const totalSOL = getTotalBalance(user);
    const totalUSDT = convertSOLtoUSDT(totalSOL);
    
    const walletMessage = `💼 **PORTEFEUILLE** 💰\n\n` +
      `📊 **SOLDE GLOBAL :** ${totalSOL.toFixed(4)} SOL ($${totalUSDT.toFixed(2)})\n\n` +
      `💵 **COMPTE PRINCIPAL :**\n` +
      `${(parseFloat(user.main_balance) || 0).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(user.main_balance) || 0).toFixed(2)})\n` +
      `*Pour les retraits*\n\n` +
      `🤖 **COMPTE TRADING :**\n` +
      `${(parseFloat(user.trading_balance) || 0).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(user.trading_balance) || 0).toFixed(2)})\n` +
      `*Solde utilisé pour le trading*\n\n` +
      `👥 **COMPTE PARRAINAGE :**\n` +
      `${(parseFloat(user.referral_balance) || 0).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(user.referral_balance) || 0).toFixed(2)})\n` +
      `*Gains de parrainage*\n\n` +
      `🎯 **ACTIONS DISPONIBLES :**\n` +
      `• Retirer depuis le compte principal\n` +
      `• Configurer votre wallet Solana\n` +
      `• Vérifier les frais de retrait`;

    const buttons = [
      [
        { text: '📤 RETIRER', callback_data: 'make_withdrawal' },
        { text: '⚙️ WALLET', callback_data: 'show_my_wallet' }
      ],
      [
        { text: '📊 FRAIS', callback_data: 'calculate_fees' },
        { text: '📈 SOLDE', callback_data: 'show_balance' }
      ],
      [{ text: '◀️ MENU PRINCIPAL', callback_data: 'main_menu' }]
    ];

    try {
      await bot.editMessageText(walletMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    } catch (error) {
      await bot.sendMessage(chatId, walletMessage, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    console.error('showWalletMenu error:', error.message);
  }
}

async function showMyWallet(chatId, messageId) {
  try {
    const user = await getOrCreateUser(chatId);
    
    if (!user.wallet) {
      const noWalletMessage = `❌ **WALLET NON CONFIGURÉ**\n\n` +
        `Vous n'avez pas encore configuré votre wallet Solana pour les retraits.\n\n` +
        `📝 **Pour configurer votre wallet :**\n` +
        `Cliquez sur le bouton "CONFIGURER WALLET" ci-dessous, puis entrez votre adresse Solana.\n\n` +
        `🔍 **Comment trouver mon adresse Solana ?**\n` +
        `1. Ouvrez votre wallet (Phantom, Solflare, Trust Wallet, etc.)\n` +
        `2. Cliquez sur "Receive" ou "Recevoir"\n` +
        `3. Copiez l'adresse qui commence par "So1..."\n\n` +
        `⚠️ **Important :**\n` +
        `• Utilisez une adresse que vous contrôlez\n` +
        `• Les retraits sont irréversibles\n` +
        `• Vérifiez l'adresse avant de confirmer`;
      
      const buttons = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⚙️ CONFIGURER WALLET', callback_data: 'set_wallet' }],
            [{ text: '💼 RETOUR PORTEFEUILLE', callback_data: 'wallet_menu' }],
            [{ text: '🏠 MENU PRINCIPAL', callback_data: 'main_menu' }]
          ]
        },
        parse_mode: 'Markdown'
      };
      
      if (messageId) {
        await bot.editMessageText(noWalletMessage, {
          chat_id: chatId,
          message_id: messageId,
          ...buttons
        });
      } else {
        await bot.sendMessage(chatId, noWalletMessage, buttons);
      }
    } else {
      const walletMessage = `✅ **VOTRE WALLET SOLANA CONFIGURÉ**\n\n` +
        `📍 **Adresse :**\n\`${user.wallet}\`\n\n` +
        `📊 **Informations :**\n` +
        `• Tous vos retraits seront envoyés à cette adresse\n` +
        `• Les transactions Solana sont irréversibles\n` +
        `• Vérifiez toujours l'adresse avant de confirmer\n` +
        `• Dernière vérification : ${new Date().toLocaleDateString()}\n\n` +
        `🔄 **Pour modifier cette adresse :**\n` +
        `Cliquez sur le bouton "MODIFIER" ci-dessous\n\n` +
        `🔒 **Sécurité :**\n` +
        `Ne partagez jamais votre clé privée ou phrase de récupération !`;
      
      const buttons = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🏦 FAIRE UN RETRAIT', callback_data: 'make_withdrawal' },
              { text: '✏️ MODIFIER', callback_data: 'set_wallet' }
            ],
            [
              { text: '📊 FRAIS', callback_data: 'calculate_fees' },
              { text: '💼 PORTEFEUILLE', callback_data: 'wallet_menu' }
            ],
            [{ text: '🏠 MENU PRINCIPAL', callback_data: 'main_menu' }]
          ]
        },
        parse_mode: 'Markdown'
      };
      
      if (messageId) {
        await bot.editMessageText(walletMessage, {
          chat_id: chatId,
          message_id: messageId,
          ...buttons
        });
      } else {
        await bot.sendMessage(chatId, walletMessage, buttons);
      }
    }
  } catch (error) {
    console.error('showMyWallet error:', error.message);
    await bot.sendMessage(chatId, '❌ Erreur lors de l\'affichage du wallet.');
  }
}

async function showTradingMenu(chatId, messageId) {
  try {
    const user = await getOrCreateUser(chatId);
    const activePlans = getActivePlans(user);
    
    if (activePlans.length === 0 && !user.plan) {
      const errorMessage = `❌ **PAS DE PLAN ACTIF**\n\n` +
        `Vous devez activer un plan d'investissement avant d'utiliser le trading algorithmique.\n\n` +
        `👉 **ÉTAPES À SUIVRE :**\n` +
        `1. Allez dans "Plans d'investissement"\n` +
        `2. Activez le plan gratuit ou choisissez un plan\n` +
        `3. Retournez ici pour commencer à trader\n\n` +
        `💡 **Astuce :** Commencez avec le plan gratuit pour tester la plateforme !`;

      const buttons = [
        [{ text: '🎯 PLANS D\'INVESTISSEMENT', callback_data: 'plans_menu' }],
        [{ text: '🏠 MENU PRINCIPAL', callback_data: 'main_menu' }]
      ];

      await bot.editMessageText(errorMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    
    let canTrade = true;
    let hoursLeft = 0;
    let minutesLeft = 0;
    
    if (user.last_claim && user.last_claim > 0) {
      const nextClaimIn = Math.max(0, 86400 - (now - user.last_claim));
      canTrade = nextClaimIn === 0;
      hoursLeft = Math.floor(nextClaimIn / 3600);
      minutesLeft = Math.floor((nextClaimIn % 3600) / 60);
    }

    // Calculer le total des gains quotidiens
    const totalDaily = activePlans.reduce((sum, plan) => sum + PLANS[plan].daily, 0) + 
                      (user.plan && user.plan !== 'free' ? PLANS[user.plan].daily : 0);
    
    // Trouver le plan avec la durée de session la plus longue
    const maxSessionDuration = Math.max(...activePlans.map(plan => PLANS[plan].session_duration));
    const maxPairs = Math.max(...activePlans.map(plan => PLANS[plan].pairs));

    const tradingMessage = `🤖 **TRADING ALGORITHMIQUE** ⚡\n\n` +
      `📊 **VOS PLANS ACTIFS :** ${activePlans.length}\n` +
      `💰 **GAIN QUOTIDIEN TOTAL :** ${totalDaily.toFixed(4)} SOL ($${convertSOLtoUSDT(totalDaily).toFixed(2)})\n` +
      `🤖 **PAIRES DE TRADING MAX :** ${maxPairs} paires\n` +
      `⏱️ **DURÉE DE SESSION MAX :** ${Math.floor(maxSessionDuration / 60)} minutes\n` +
      `⏰ **STATUT :** ${canTrade ? '✅ PRÊT À TRADER' : `⏳ PROCHAIN TRADING DANS ${hoursLeft}h ${minutesLeft}m`}\n\n` +
      `📈 **PROCESSUS DE TRADING :**\n` +
      `1. Lancement des robots IA\n` +
      `2. Analyse du marché en temps réel\n` +
      `3. Exécution automatique des trades\n` +
      `4. Gains crédités sur votre compte principal\n\n` +
      `🔧 **CONFIGURATION ACTUELLE :**\n` +
      `• 🤖 Robots : IA Avancée\n` +
      `• 📊 Paires : ${maxPairs} paires crypto\n` +
      `• ⚡ Vitesse : Haute fréquence\n` +
      `• 🛡️ Sécurité : Maximum\n` +
      `• ⏱️ Durée : ${Math.floor(maxSessionDuration / 60)} minutes\n\n` +
      `${canTrade ? '✅ **Cliquez sur "COMMENCER À TRADER" pour générer des profits !**' : '⏳ **Attendez le prochain cycle de trading...**'}`;

    const buttons = [];
    
    if (canTrade) {
      buttons.push([{ text: '🚀 COMMENCER À TRADER', callback_data: 'start_trading' }]);
    } else {
      buttons.push([{ text: `⏳ ${hoursLeft}h ${minutesLeft}m`, callback_data: 'trading_menu' }]);
    }
    
    buttons.push(
      [
        { text: '📊 TABLEAU DE BORD', callback_data: 'dashboard' },
        { text: '🎯 PLANS', callback_data: 'plans_menu' }
      ],
      [{ text: '◀️ MENU PRINCIPAL', callback_data: 'main_menu' }]
    );

    await bot.editMessageText(tradingMessage, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: buttons },
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('showTradingMenu error:', error.message);
  }
}

async function startTrading(chatId, messageId) {
  try {
    const user = await getOrCreateUser(chatId);
    
    const activePlans = getActivePlans(user);
    if (activePlans.length === 0 && !user.plan) {
      await bot.sendMessage(chatId, '❌ Activez un plan d\'abord !');
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    
    if (user.last_claim && user.last_claim > 0 && now - user.last_claim < 86400) {
      const hoursLeft = Math.floor((86400 - (now - user.last_claim)) / 3600);
      const minutesLeft = Math.floor(((86400 - (now - user.last_claim)) % 3600) / 60);
      await bot.sendMessage(chatId, `⏳ Prochain trading dans ${hoursLeft}h ${minutesLeft}m`);
      return;
    }

    // Utiliser le plan avec la durée de session la plus longue
    const activePlansList = activePlans.length > 0 ? activePlans : [user.plan];
    const planKeys = activePlansList.filter(plan => plan && plan !== 'free');
    
    if (planKeys.length === 0) {
      // Utiliser le plan free si c'est le seul
      planKeys.push('free');
    }
    
    const longestPlan = planKeys.reduce((longest, plan) => {
      return PLANS[plan].session_duration > PLANS[longest].session_duration ? plan : longest;
    }, planKeys[0]);
    
    const plan = PLANS[longestPlan];
    const directions = ['🔼 LONG', '🔽 SHORT'];
    
    // Calculer le gain total quotidien BASÉ SUR TOUS LES PLANS
    let totalDaily = 0;
    
    // Ajouter les gains de tous les plans actifs
    if (activePlans.length > 0) {
      totalDaily = activePlans.reduce((sum, p) => sum + PLANS[p].daily, 0);
    }
    
    // Ajouter le gain du plan principal si différent
    if (user.plan && user.plan !== 'free' && !activePlans.includes(user.plan)) {
      totalDaily += PLANS[user.plan].daily;
    }
    
    // Si toujours 0, utiliser au moins le plan gratuit
    if (totalDaily === 0 && (user.plan === 'free' || activePlans.includes('free'))) {
      totalDaily = PLANS.free.daily; // 0.005 SOL
    }
    
    console.log(`🔍 Trading debug - Chat: ${chatId}, Active Plans: ${activePlans}, Total Daily: ${totalDaily}`);
    
    await bot.editMessageText(`🤖 **SIMULATION DE TRADING EN COURS** ⚡\n\n` +
      `🔄 Initialisation des algorithmes d'IA...\n` +
      `📊 Analyse du marché en temps réel...\n` +
      `🤖 **Robots actifs :** IA Avancée\n` +
      `📈 **Paires analysées :** ${plan.pairs}\n` +
      `⏱️ **Durée estimée :** ${Math.floor(plan.session_duration / 60)} minutes\n` +
      `💰 **Objectif quotidien :** ${totalDaily.toFixed(5)} SOL ($${convertSOLtoUSDT(totalDaily).toFixed(2)})`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
      }
    );

    const totalGain = await showTradingProgress(chatId, messageId, plan, [], directions);

    // Calculer le nouveau solde principal
    const currentMainBalance = parseFloat(user.main_balance) || 0;
    const newMainBalance = currentMainBalance + totalGain;
    
    // Récupérer les gains totaux actuels depuis la base de données
    const currentUser = await getUser(chatId);
    const currentLifetimeTrading = parseFloat(currentUser.lifetime_trading_earnings) || 0;
    const currentTotalTrading = parseFloat(currentUser.total_trading_earnings) || 0;
    
    // Calculer les nouveaux totaux PERMANENTS
    const newLifetimeTrading = currentLifetimeTrading + totalGain;
    const newTotalTrading = currentTotalTrading + totalGain;
    
    // Mettre à jour l'utilisateur avec les gains PERMANENTS
    await updateUser(chatId, {
      main_balance: newMainBalance,
      trading_balance: 0.000001, // Garder un petit montant pour l'affichage
      lifetime_trading_earnings: newLifetimeTrading,
      total_trading_earnings: newTotalTrading,
      last_claim: now
    });
    
    await addTransaction(chatId, 'daily_earning', totalGain, 
      `Trading réussi - ${activePlans.length} plan(s) actif(s)`);

    const successMessage = `🎉 **TRADING TERMINÉ AVEC SUCCÈS !** 💰\n\n` +
      `📊 **RÉSUMÉ DE LA SESSION :**\n` +
      `• 🤖 Robots utilisés : IA Avancée\n` +
      `• 📈 Paires tradées : ${plan.pairs}\n` +
      `• ⏱️ Durée : ${Math.floor(plan.session_duration / 60)} minutes\n` +
      `• 💰 **Profit total :** +${totalGain.toFixed(5)} SOL ($${convertSOLtoUSDT(totalGain).toFixed(2)})\n` +
      `• 🎯 Plans actifs : ${activePlans.length}\n\n` +
      `💰 **NOUVEAU SOLDE PRINCIPAL :** ${newMainBalance.toFixed(4)} SOL ($${convertSOLtoUSDT(newMainBalance).toFixed(2)})\n` +
      `📈 **GAINS TOTAUX TRADING (PERMANENTS) :** ${newLifetimeTrading.toFixed(4)} SOL ($${convertSOLtoUSDT(newLifetimeTrading).toFixed(2)})\n` +
      `⏰ **PROCHAIN TRADING :** Dans 24 heures\n\n` +
      `💡 **Conseil :** Vous pouvez maintenant retirer vos gains !`;

    const buttons = [
      [
        { text: '📊 TABLEAU DE BORD', callback_data: 'dashboard' },
        { text: '🏦 RETRAIT', callback_data: 'make_withdrawal' }
      ],
      [
        { text: '🤖 TRADING', callback_data: 'trading_menu' },
        { text: '📈 MES GAINS', callback_data: 'my_earnings' }
      ],
      [{ text: '🏠 MENU PRINCIPAL', callback_data: 'main_menu' }]
    ];

    await bot.editMessageText(successMessage, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: buttons },
      parse_mode: 'Markdown'
    });

  } catch (error) {
    console.error('❌ startTrading error:', error.message);
    
    // BLOCCATCH CORRIGÉ - Version améliorée
    try {
      const user = await getOrCreateUser(chatId);
      const activePlans = getActivePlans(user);
      
      // Calculer le gain total de façon fiable
      let totalGain = 0;
      
      // 1. Vérifier les plans actifs dans le tableau 'plans'
      if (activePlans.length > 0) {
        totalGain = activePlans.reduce((sum, p) => {
          const planDaily = PLANS[p]?.daily || 0;
          console.log(`Plan ${p} daily: ${planDaily}`);
          return sum + planDaily;
        }, 0);
      }
      
      // 2. Vérifier le plan principal si présent
      if (totalGain === 0 && user.plan) {
        const planDaily = PLANS[user.plan]?.daily || 0;
        console.log(`Main plan ${user.plan} daily: ${planDaily}`);
        totalGain = planDaily;
      }
      
      // 3. Si toujours 0, utiliser une valeur minimale
      if (totalGain === 0) {
        totalGain = 0.0001; // Minimum pour éviter 0.00000
        console.log(`Using minimum gain: ${totalGain}`);
      }
      
      // S'assurer que totalGain n'est pas inférieur au minimum du plan gratuit
      if (totalGain < PLANS.free.daily) {
        totalGain = PLANS.free.daily;
      }
      
      console.log(`Fallback - Final totalGain: ${totalGain} SOL`);
      
      const currentMainBalance = parseFloat(user.main_balance) || 0;
      const newMainBalance = currentMainBalance + totalGain;
      const now = Math.floor(Date.now() / 1000);
      
      // Récupérer les gains totaux actuels
      const currentLifetimeTrading = parseFloat(user.lifetime_trading_earnings) || 0;
      const currentTotalTrading = parseFloat(user.total_trading_earnings) || 0;
      
      // Calculer les nouveaux totaux PERMANENTS
      const newLifetimeTrading = currentLifetimeTrading + totalGain;
      const newTotalTrading = currentTotalTrading + totalGain;
      
      // Mettre à jour avec les gains PERMANENTS
      await updateUser(chatId, {
        main_balance: newMainBalance,
        trading_balance: 0.000001,
        lifetime_trading_earnings: newLifetimeTrading,
        total_trading_earnings: newTotalTrading,
        last_claim: now
      });
      
      await addTransaction(chatId, 'daily_earning', totalGain, `Trading automatique complété (fallback)`);
      
      // Message du bloc catch CORRIGÉ
      const fallbackMessage = `✅ **TRADING COMPLÉTÉ**\n\n` +
        `📊 **RÉSUMÉ DE LA SESSION :**\n` +
        `• 🤖 Robots utilisés : IA Avancée\n` +
        `• 📈 Paires tradées : Diverses\n` +
        `• ⏱️ Durée : Session rapide\n` +
        `• 💰 **Profit total :** +${totalGain.toFixed(5)} SOL ($${convertSOLtoUSDT(totalGain).toFixed(2)})\n` +
        `• 🎯 Plans actifs : ${activePlans.length}\n\n` +
        `💰 **NOUVEAU SOLDE PRINCIPAL :** ${newMainBalance.toFixed(4)} SOL ($${convertSOLtoUSDT(newMainBalance).toFixed(2)})\n` +
        `📈 **GAINS TOTAUX TRADING (PERMANENTS) :** ${newLifetimeTrading.toFixed(4)} SOL ($${convertSOLtoUSDT(newLifetimeTrading).toFixed(2)})\n` +
        `⏰ **PROCHAIN TRADING :** Dans 24 heures\n\n` +
        `💡 **Conseil :** Vous pouvez maintenant retirer vos gains !`;
      
      const fallbackButtons = [
        [
          { text: '📊 TABLEAU DE BORD', callback_data: 'dashboard' },
          { text: '🏦 RETRAIT', callback_data: 'make_withdrawal' }
        ],
        [
          { text: '🤖 TRADING', callback_data: 'trading_menu' },
          { text: '📈 MES GAINS', callback_data: 'my_earnings' }
        ],
        [{ text: '🏠 MENU PRINCIPAL', callback_data: 'main_menu' }]
      ];
      
      // Essayer d'éditer d'abord, sinon envoyer un nouveau message
      try {
        await bot.editMessageText(fallbackMessage, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: fallbackButtons },
          parse_mode: 'Markdown'
        });
      } catch (editError) {
        // Si l'édition échoue, envoyer un nouveau message
        await bot.sendMessage(chatId, fallbackMessage, {
          reply_markup: { inline_keyboard: fallbackButtons },
          parse_mode: 'Markdown'
        });
      }
      
    } catch (fallbackError) {
      console.error('❌ Fallback error détaillé:', {
        message: fallbackError.message,
        stack: fallbackError.stack,
        chatId: chatId
      });
      
      // Message d'erreur très simple
      try {
        await bot.sendMessage(chatId, 
          '❌ Une erreur est survenue lors du trading.\n' +
          'Nos équipes ont été notifiées.\n\n' +
          'Veuillez réessayer dans quelques minutes.',
          { parse_mode: 'Markdown' }
        );
      } catch (sendError) {
        console.error('❌ Impossible d\'envoyer message d\'erreur:', sendError.message);
      }
    }
  }
}

async function requestWithdrawalWithFees(chatId, amountSOL) {
  try {
    const user = await getOrCreateUser(chatId);
    const mainBalance = parseFloat(user.main_balance) || 0;
    
    if (!WITHDRAWALS_ENABLED) {
      await bot.sendMessage(chatId,
        `⏸️ **RETRAITS TEMPORAIREMENT DÉSACTIVÉS**\n\n` +
        `Les retraits sont actuellement désactivés pour maintenance.\n` +
        `Veuillez réessayer plus tard.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    const canWithdrawCheck = await canUserWithdraw(chatId);
    if (!canWithdrawCheck.canWithdraw) {
      await bot.sendMessage(chatId, canWithdrawCheck.reason);
      return;
    }
    
    // Déterminer le plan pour les validations (prendre le premier plan actif)
    const activePlans = getActivePlans(user);
    const userPlan = activePlans.length > 0 ? activePlans[0] : (user.plan || 'free');
    
    const validation = validateWithdrawalAmount(amountSOL, userPlan);
    if (!validation.valid) {
      await bot.sendMessage(chatId, validation.reason);
      return;
    }
    
    const fees = validation.fees;
    
    if (amountSOL > mainBalance) {
      await bot.sendMessage(chatId, 
        `❌ **SOLDE PRINCIPAL INSUFFISANT.**\n\n` +
        `💵 **Disponible :** ${mainBalance.toFixed(4)} SOL ($${convertSOLtoUSDT(mainBalance).toFixed(2)})\n` +
        `💰 **Demandé :** ${amountSOL.toFixed(4)} SOL`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    if (!user.wallet) {
      await bot.sendMessage(chatId,
        `❌ **WALLET NON CONFIGURÉ**\n\n` +
        `Vous devez configurer votre wallet Solana avant de faire un retrait.\n\n` +
        `Cliquez sur le bouton "CONFIGURER WALLET" ci-dessous.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⚙️ CONFIGURER WALLET', callback_data: 'set_wallet' }],
              [{ text: '◀️ ANNULER', callback_data: 'wallet_menu' }]
            ]
          },
          parse_mode: 'Markdown'
        }
      );
      return;
    }
    
    if (user.withdrawal_status === 'pending') {
      await bot.sendMessage(chatId,
        `⏳ **RETRAIT EN ATTENTE**\n\n` +
        `Vous avez déjà un retrait en attente de ${parseFloat(user.withdrawal_pending).toFixed(4)} SOL.\n` +
        `Veuillez attendre qu'il soit traité.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const netAmount = fees.netAmountSOL;
    
    if (netAmount <= 0) {
      await bot.sendMessage(chatId,
        `❌ **MONTANT TROP FAIBLE**\n\n` +
        `Avec ${amountSOL} SOL, après frais (${fees.feesSOL} SOL), ` +
        `vous recevriez ${netAmount.toFixed(4)} SOL.\n\n` +
        `💡 **Augmentez votre montant de retrait** à au moins ${(MIN_WITHDRAW + 0.005).toFixed(4)} SOL.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const confirmationMessage = `💸 **DEMANDE DE RETRAIT - FRAIS DYNAMIQUES**\n\n` +
      `📊 **DÉTAILS DE LA DEMANDE :**\n` +
      `• 💰 **Montant brut :** ${amountSOL.toFixed(4)} SOL ($${convertSOLtoUSDT(amountSOL).toFixed(2)})\n` +
      `• 📈 **Prix SOL :** $${SOL_PRICE.toFixed(4)} (temps réel)\n` +
      `• ⚡ **Frais réseau :** ${fees.feesSOL} SOL ($${fees.feesUSD.toFixed(4)})\n` +
      `• 🏦 **Montant net :** ${netAmount.toFixed(4)} SOL ($${fees.netAmountUSD.toFixed(4)})\n` +
      `• 📍 **Destination :** \`${user.wallet}\`\n\n` +
      `📋 **RÈGLES DE FRAIS APPLIQUÉES :**\n` +
      `• ${fees.rulesApplied.feeStructure}\n` +
      `• Minimum net après frais : ${fees.rulesApplied.minNetAmount} SOL\n\n` +
      `⚠️ **IMPORTANT :**\n` +
      `• Les frais sont calculés avec le prix SOL réel\n` +
      `• Vous recevez le montant NET après frais\n\n` +
      `✅ **VOULEZ-VOUS PROCÉDER À CE RETRAIT ?**`;

    const buttons = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: `✅ APPROUVER (Recevoir ${netAmount.toFixed(4)} SOL)`, callback_data: `confirm_withdrawal_${amountSOL}` },
            { text: '❌ ANNULER', callback_data: 'cancel_withdrawal' }
          ],
          [
            { text: '📊 CALCULER LES FRAIS', callback_data: 'calculate_fees' },
            { text: '🏠 MENU PRINCIPAL', callback_data: 'main_menu' }
          ]
        ]
      },
      parse_mode: 'Markdown'
    };

    await updateUser(chatId, {
      withdrawal_pending: amountSOL,
      withdrawal_status: 'pending_approval'
    });

    await bot.sendMessage(chatId, confirmationMessage, buttons);

  } catch (error) {
    console.error('requestWithdrawalWithFees error:', error.message);
    await bot.sendMessage(chatId, '❌ Erreur lors du traitement de la demande de retrait');
  }
}

async function processWithdrawalApproval(chatId, messageId, amountSOL, callbackQueryId) {
  try {
    console.log(`💰 Approbation retrait demandée: ${amountSOL} SOL par ${chatId}`);
    
    const user = await getOrCreateUser(chatId);
    
    // Vérifier si l'utilisateur a un retrait en attente
    if (Math.abs(parseFloat(user.withdrawal_pending || 0) - amountSOL) > 0.001) {
      console.log(`❌ Incompatibilité de montant: ${user.withdrawal_pending || 0} vs ${amountSOL}`);
      await sendSafeMessage(chatId, 
        '❌ <b>Incompatibilité de montant.</b>\n\n' +
        'Le montant a changé depuis votre demande initiale.\n' +
        'Veuillez recommencer le retrait.'
      );
      return;
    }
    
    const canWithdrawCheck = await canUserWithdraw(chatId);
    if (!canWithdrawCheck.canWithdraw) {
      await sendSafeMessage(chatId, canWithdrawCheck.reason);
      return;
    }
    
    const mainBalance = parseFloat(user.main_balance) || 0;
    if (amountSOL > mainBalance) {
      await sendSafeMessage(chatId, 
        `❌ <b>SOLDE PRINCIPAL INSUFFISANT.</b>\n\n` +
        `💵 <b>Disponible :</b> ${mainBalance.toFixed(4)} SOL\n` +
        `💰 <b>Demandé :</b> ${amountSOL.toFixed(4)} SOL`
      );
      return;
    }
    
    const fees = calculateDynamicFees(amountSOL);
    const netAmount = fees.netAmountSOL;
    
    console.log(`📊 Frais calculés: ${fees.feesSOL} SOL, Net: ${netAmount} SOL`);
    
    // Créer l'enregistrement de retrait
    const withdrawalId = await pool.query(
      `INSERT INTO withdrawals (
        user_id, 
        amount, 
        amount_usdt, 
        fees, 
        net_amount, 
        net_amount_usdt, 
        address, 
        status, 
        fees_paid_by_user,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', TRUE, NOW()) RETURNING id`,
      [
        chatId, 
        amountSOL, 
        convertSOLtoUSDT(amountSOL), 
        fees.feesSOL, 
        netAmount, 
        convertSOLtoUSDT(netAmount), 
        user.wallet || 'Non configuré'
      ]
    );

    const withdrawalIdValue = withdrawalId.rows[0].id;
    console.log(`✅ Retrait #${withdrawalIdValue} créé pour ${chatId}`);

    await updateUser(chatId, {
      withdrawal_status: 'pending',
      withdrawal_pending: amountSOL
    });

    await addTransaction(chatId, 'withdrawal_request', 0, 
      `Demande de retrait #${withdrawalIdValue} - ${amountSOL} SOL en attente`);

    // ========== MESSAGE HTML SÉCURISÉ ==========
    // Échapper manuellement les données dangereuses
    const safeWallet = (user.wallet || 'Non configuré')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
    
    const userConfirmation = 
      `✅ <b>DEMANDE DE RETRAIT SOUMISE</b>\n\n` +
      `<b>DEMANDE #${withdrawalIdValue}</b>\n` +
      `• 💰 <b>Montant brut :</b> ${amountSOL.toFixed(4)} SOL ($${convertSOLtoUSDT(amountSOL).toFixed(2)})\n` +
      `• 📈 <b>Prix SOL :</b> $${SOL_PRICE.toFixed(4)}\n` +
      `• ⚡ <b>Frais réseau :</b> ${fees.feesSOL.toFixed(6)} SOL ($${fees.feesUSD.toFixed(4)})\n` +
      `• 🏦 <b>Montant net :</b> ${netAmount.toFixed(6)} SOL ($${fees.netAmountUSD.toFixed(4)})\n` +
      `• 📍 <b>Destination :</b> <code>${safeWallet}</code>\n` +
      `• 💵 <b>Votre solde actuel :</b> ${mainBalance.toFixed(4)} SOL (non débité)\n\n` +
      `<b>TRAITEMENT :</b>\n` +
      `1. ✅ Demande enregistrée (#${withdrawalIdValue})\n` +
      `2. ⏳ Approuvé automatiquement en 5 minutes\n` +
      `3. 💸 Fonds envoyés à votre wallet\n` +
      `4. 📊 Votre solde sera alors débité\n\n` +
      `<b>Support :</b> @${SUPPORT_USERNAME}`;

    const userButtons = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📜 VOIR L\'HISTORIQUE', callback_data: 'withdrawal_history' }],
          [{ text: '💼 MON PORTEFEUILLE', callback_data: 'wallet_menu' }],
          [{ text: '🏠 MENU PRINCIPAL', callback_data: 'main_menu' }]
        ]
      }
    };

    // Éditer le message original
    try {
      await bot.editMessageText(userConfirmation, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: userButtons.reply_markup,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
      console.log('✅ Message édité avec succès');
    } catch (editError) {
      console.log('⚠️ Impossible d\'éditer le message:', editError.message);
      // Envoyer un nouveau message SIMPLE sans HTML
      const simpleMessage = 
        `✅ DEMANDE DE RETRAIT SOUMISE\n\n` +
        `DEMANDE #${withdrawalIdValue}\n` +
        `• Montant brut : ${amountSOL.toFixed(4)} SOL\n` +
        `• Frais réseau : ${fees.feesSOL.toFixed(6)} SOL\n` +
        `• Montant net : ${netAmount.toFixed(6)} SOL\n` +
        `• Destination : ${safeWallet}\n` +
        `• Traitement automatique dans 5 minutes`;
      
      await bot.sendMessage(chatId, simpleMessage, {
        reply_markup: userButtons.reply_markup,
        disable_web_page_preview: true
      });
    }

    // ========== NOTIFICATION ADMIN CORRIGÉE ==========
    // REMPLACEZ CE BLOC (ligne problématique) :
    const adminMessage = 
      `💰 <b>NOUVELLE DEMANDE DE RETRAIT</b>\n\n` +
      `<b>ID :</b> #${withdrawalIdValue}\n` +
      `<b>Utilisateur :</b> ${chatId} (${user.username || 'Sans nom'})\n` +
      `<b>Montant :</b> ${amountSOL.toFixed(4)} SOL ($${convertSOLtoUSDT(amountSOL).toFixed(2)})\n` +
      `<b>Frais :</b> ${fees.feesSOL.toFixed(6)} SOL\n` +
      `<b>Net :</b> ${netAmount.toFixed(6)} SOL ($${convertSOLtoUSDT(netAmount).toFixed(2)})\n` +
      `<b>Wallet :</b> <code>${safeWallet}</code>\n` +
      `<b>Solde utilisateur :</b> ${mainBalance.toFixed(4)} SOL\n` +
      `<b>Date :</b> ${new Date().toLocaleString()}\n\n` +
      `<b>Actions admin :</b>\n` +
      `<code>/approve ${withdrawalIdValue}</code> - Approuver\n` +
      `<code>/reject ${withdrawalIdValue}</code> - Rejeter\n` +
      `<code>/hold ${withdrawalIdValue}</code> - Attente`;
    
    if (ADMIN_ID) {
      try {
        await bot.sendMessage(ADMIN_ID, adminMessage, {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      } catch (adminError) {
        console.error('❌ Erreur notification admin:', adminError.message);
        // Fallback sans HTML
        await bot.sendMessage(ADMIN_ID,
          `💰 NOUVELLE DEMANDE DE RETRAIT #${withdrawalIdValue}\n` +
          `Utilisateur: ${chatId}\n` +
          `Montant: ${amountSOL.toFixed(4)} SOL\n` +
          `Wallet: ${user.wallet || 'Non configuré'}`,
          { disable_web_page_preview: true }
        );
      }
    }

    console.log(`⏰ Planification traitement automatique pour #${withdrawalIdValue} dans 5 minutes`);

    // Planifier le traitement automatique
    setTimeout(async () => {
      try {
        console.log(`⏰ Début traitement automatique du retrait #${withdrawalIdValue}`);
        await processAutomaticWithdrawal(withdrawalIdValue);
      } catch (autoError) {
        console.error('❌ Erreur traitement automatique:', autoError.message);
      }
    }, 5 * 60 * 1000); // 5 minutes

  } catch (error) {
    console.error('❌ processWithdrawalApproval error détaillé:', {
      message: error.message,
      stack: error.stack,
      chatId: chatId,
      amount: amountSOL
    });
    
    try {
      await updateUser(chatId, {
        withdrawal_status: 'none',
        withdrawal_pending: 0
      });
    } catch (dbError) {
      console.error('❌ Erreur DB cleanup:', dbError.message);
    }
    
    // Message d'erreur TRÈS SIMPLE
    try {
      await bot.sendMessage(chatId, 
        '❌ ERREUR LORS DE LA SOUMISSION\n' +
        'Une erreur est survenue. Veuillez réessayer.',
        { disable_web_page_preview: true }
      );
    } catch (sendError) {
      console.error('❌ Impossible d\'envoyer message erreur:', sendError.message);
    }
  }
}

async function processAutomaticWithdrawal(withdrawalId) {
  try {
    const withdrawal = await pool.query('SELECT * FROM withdrawals WHERE id = $1', [withdrawalId]);
    
    if (withdrawal.rows.length === 0 || withdrawal.rows[0].status !== 'pending') {
      return;
    }
    
    const withdrawalData = withdrawal.rows[0];
    
    if (!WITHDRAWALS_ENABLED) {
      await pool.query('UPDATE withdrawals SET status = $1, admin_notes = $2 WHERE id = $3', 
        ['on_hold', 'Retraits temporairement désactivés', withdrawalId]);
      
      await notifyAdmin(`⏸️ Retrait #${withdrawalId} en attente (retraits désactivés)`);
      
      await bot.sendMessage(withdrawalData.user_id,
        `⏸️ **RETRAIT EN ATTENTE**\n\n` +
        `Votre retrait de ${withdrawalData.amount} SOL est temporairement en attente.\n` +
        `Notre système est en maintenance.\n\n` +
        `Nous traiterons votre retrait dès que possible.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    
    let result;
    let sendError = null;
    
    try {
      if (connection && walletKeypair) {
        result = await sendSOLWithLowFees(withdrawalData.address, withdrawalData.net_amount);
      } else {
        throw new Error('Solana non configuré');
      }
    } catch (error) {
      sendError = error;
      result = { txid: `FAILED_${Date.now()}`, feesSOL: withdrawalData.fees };
    }
    
    if (sendError) {
      console.log(`❌ Retrait #${withdrawalId} échoué:`, sendError.message);
      
      await pool.query(`UPDATE withdrawals SET status = $1, admin_notes = $2, processed_at = CURRENT_TIMESTAMP WHERE id = $3`, 
        ['failed', `Échec : ${sendError.message.substring(0, 100)}`, withdrawalId]);
      
      const user = await getOrCreateUser(withdrawalData.user_id);
      const currentBalance = parseFloat(user.main_balance) || 0;
      
      await updateUser(withdrawalData.user_id, {
        withdrawal_status: 'none',
        withdrawal_pending: 0
      });
      
      await addTransaction(withdrawalData.user_id, 'withdrawal_failed', 0, 
        `Retrait #${withdrawalId} échoué - ${sendError.message.substring(0, 50)}`);
      
      await bot.sendMessage(withdrawalData.user_id,
        `❌ **RETRAIT ÉCHOUÉ**\n\n` +
        `Votre retrait de ${withdrawalData.amount} SOL n'a pas pu être traité.\n` +
        `💰 **Votre solde n'a pas été débité :** ${currentBalance.toFixed(4)} SOL\n` +
        `⚠️ **Raison :** ${sendError.message.substring(0, 100)}\n\n` +
        `🔄 **Vous pouvez réessayer le retrait.**`,
        { parse_mode: 'Markdown' }
      );
      
      await notifyAdmin(
        `❌ **RETRAIT ÉCHOUÉ** #${withdrawalId}\n` +
        `👤 User: ${withdrawalData.user_id}\n` +
        `💰 ${withdrawalData.amount} SOL\n` +
        `❌ ${sendError.message}\n` +
        `💵 Solde restant: ${currentBalance.toFixed(4)} SOL`
      );
      
    } else {
      console.log(`✅ Retrait #${withdrawalId} réussi:`, result.txid);
      
      const actualFeesSOL = result.feesSOL || withdrawalData.fees;
      
      await pool.query(`UPDATE withdrawals SET status = $1, processed_at = CURRENT_TIMESTAMP, txid = $2, fees = $3 WHERE id = $4`, 
        ['approved', result.txid, actualFeesSOL, withdrawalId]);
      
      const user = await getOrCreateUser(withdrawalData.user_id);
      const currentBalance = parseFloat(user.main_balance) || 0;
      
      let newBalance = currentBalance - parseFloat(withdrawalData.amount);
      
      if (newBalance < 0) {
        console.error(`❌ Solde négatif pour user ${withdrawalData.user_id} après retrait`);
        newBalance = 0;
      }
      
      const today = new Date().toISOString().split('T')[0];
      let withdrawalCountToday = user.withdrawal_count_today || 0;
      let lastDailyWithdrawal = user.last_daily_withdrawal;
      
      if (lastDailyWithdrawal !== today) {
        withdrawalCountToday = 1;
        lastDailyWithdrawal = today;
      } else {
        withdrawalCountToday += 1;
      }
      
      await updateUser(withdrawalData.user_id, {
        main_balance: newBalance,
        last_withdraw: Math.floor(Date.now() / 1000),
        last_daily_withdrawal: lastDailyWithdrawal,
        withdrawal_count_today: withdrawalCountToday,
        withdrawal_status: 'none',
        withdrawal_pending: 0,
        total_withdrawn: (parseFloat(user.total_withdrawn) || 0) + parseFloat(withdrawalData.amount),
        total_withdrawn_usdt: (parseFloat(user.total_withdrawn_usdt) || 0) + convertSOLtoUSDT(parseFloat(withdrawalData.amount))
      });
      
      await addTransaction(withdrawalData.user_id, 'withdrawal', -parseFloat(withdrawalData.amount), 
        `Retrait #${withdrawalId} approuvé - TX: ${result.txid}`);
      
      await bot.sendMessage(withdrawalData.user_id, 
        `✅ **RETRAIT COMPLÉTÉ !**\n\n` +
        `📋 **Transaction #${withdrawalId}**\n` +
        `• 💰 **Montant :** ${parseFloat(withdrawalData.amount).toFixed(4)} SOL\n` +
        `• ⚡ **Frais :** ${actualFeesSOL.toFixed(6)} SOL\n` +
        `• 🏦 **Net reçu :** ${parseFloat(withdrawalData.net_amount).toFixed(4)} SOL\n` +
        `• 📤 **Wallet :** \`${withdrawalData.address.substring(0, 20)}...\`\n` +
        `• 🔗 **TXID :** \`${result.txid}\`\n` +
        `• 📊 **Nouveau solde :** ${newBalance.toFixed(4)} SOL`,
        { parse_mode: 'Markdown' }
      );
      
      await notifyAdmin(
        `✅ **RETRAIT TRAITÉ** #${withdrawalId}\n` +
        `👤 User: ${withdrawalData.user_id}\n` +
        `💰 ${withdrawalData.amount} SOL\n` +
        `🔗 ${result.txid}`
      );
    }
      
  } catch (error) {
    console.error('❌ processAutomaticWithdrawal error:', error.message);
    
    try {
      await pool.query('UPDATE withdrawals SET status = $1, admin_notes = $2 WHERE id = $3', 
        ['failed', `Erreur système: ${error.message.substring(0, 50)}`, withdrawalId]);
      
      const withdrawal = await pool.query('SELECT user_id FROM withdrawals WHERE id = $1', [withdrawalId]);
      if (withdrawal.rows.length > 0) {
        await updateUser(withdrawal.rows[0].user_id, {
          withdrawal_status: 'none',
          withdrawal_pending: 0
        });
      }
    } catch (err) {
      console.error('Erreur de nettoyage:', err.message);
    }
  }
}



async function copyReferralLink(chatId, messageId, callbackQueryId) {
  try {
    const user = await getOrCreateUser(chatId);
    const botUsername = (await bot.getMe()).username;
    const link = `https://t.me/${botUsername}?start=${user.referral_code}`;
    
    await bot.sendMessage(chatId, 
      `🔗 **VOTRE LIEN DE PARRAINAGE :**\n\n` +
      `\`${link}\`\n\n` +
      `📋 **Votre code de parrainage :** \`${user.referral_code}\`\n\n` +
      `📤 **Partagez avec des amis pour gagner des bonus !**\n` +
      `✅ **Les parrainages valides aident à débloquer les retraits du plan gratuit**`,
      { parse_mode: 'Markdown' }
    );
    
    await safeAnswerCallbackQuery(callbackQueryId, {
      text: '✅ Lien envoyé dans le chat.',
      show_alert: false
    });
  } catch (error) {
    console.error('copyReferralLink error:', error.message);
  }
}

async function showReferralStats(chatId, messageId) {
  try {
    const user = await getOrCreateUser(chatId);
    
    if (!user) {
      await bot.sendMessage(chatId, '❌ Utilisateur non trouvé');
      return;
    }
    
    const botUsername = (await bot.getMe()).username;
    const link = `https://t.me/${botUsername}?start=${user.referral_code}`;
    
    const validReferralsResult = await pool.query(
      'SELECT * FROM valid_referrals WHERE referrer_id = $1 ORDER BY activated_at DESC LIMIT 10', 
      [chatId]
    );
    
    const validReferrals = validReferralsResult.rows;
    
    let message = `<b>📊 STATISTIQUES DE PARRAINAGE</b>\n\n` +
      `<b>💰 GAINS TOTAUX :</b> ${(parseFloat(user.referral_earnings) || 0).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(user.referral_earnings) || 0).toFixed(2)})\n` +
      `<b>👥 PARRAINAGES DIRECTS :</b> ${user.referrals || 0}\n` +
      `<b>✅ PARRAINAGES VALIDES :</b> ${user.valid_referrals || 0}/3\n\n` +
      `<b>🔗 LIEN DE PARRAINAGE :</b>\n` +
      `<code>${link}</code>\n\n` +
      `<b>🔑 VOTRE CODE :</b> <code>${user.referral_code || 'Génération...'}</code>\n\n` +
      `<b>🏆 VOTRE NIVEAU :</b>\n`;
    
    if (user.referrals >= 50) {
      message += `💎 DIAMANT\n\n`;
    } else if (user.referrals >= 20) {
      message += `🥇 OR\n\n`;
    } else if (user.referrals >= 10) {
      message += `🥈 ARGENT\n\n`;
    } else {
      message += `🥉 BRONZE\n\n`;
    }
    
    message += `<b>📋 PARRAINAGES VALIDES RÉCENTS :</b>\n`;
    
    if (validReferrals.length > 0) {
      validReferrals.forEach((ref, index) => {
        message += `${index + 1}. Plan : ${ref.referral_plan || 'Inconnu'} - ${new Date(ref.activated_at).toLocaleDateString()}\n`;
      });
    } else {
      message += 'Aucun parrainage valide pour le moment. Partagez votre lien !';
    }

    const buttons = [
      [
        { text: '📋 COPIER LE LIEN', callback_data: 'copy_referral_link' },
        { text: '💡 ASTUCES', callback_data: 'referral_tips' }
      ],
      [
        { text: '🏆 CLASSEMENT', callback_data: 'referral_ranking' },
        { text: '◀️ RETOUR', callback_data: 'referral_menu' }
      ]
    ];

    const options = {
      reply_markup: { inline_keyboard: buttons },
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };

    if (messageId) {
      try {
        await bot.editMessageText(message, {
          chat_id: chatId,
          message_id: messageId,
          ...options
        });
      } catch (editError) {
        await bot.sendMessage(chatId, message, options);
      }
    } else {
      await bot.sendMessage(chatId, message, options);
    }
  } catch (error) {
    console.error('❌ showReferralStats error:', error.message);
    
    try {
      await bot.sendMessage(chatId, 
        '❌ Erreur lors du chargement des statistiques.\nVeuillez réessayer plus tard.',
        { parse_mode: 'HTML' }
      );
    } catch (sendError) {
      console.error('Erreur envoi message:', sendError.message);
    }
  }
}
async function showReferralTips(chatId, messageId) {
  try {
    const tipsMessage = 
      '<b>💡 ASTUCES DE PARRAINAGE 🚀</b>\n\n' +
      '<b>🎯 STRATÉGIES EFFICACES :</b>\n\n' +
      '<b>1️⃣ RÉSEAUX SOCIAUX :</b>\n' +
      '• Créez un groupe Telegram dédié\n' +
      '• Partagez vos vrais résultats\n' +
      '• Postez des captures d\'écran de vos gains\n\n' +
      '<b>2️⃣ CONTENU QUALITÉ :</b>\n' +
      '• Faites des tutoriels vidéo\n' +
      '• Écrivez des articles\n' +
      '• Créez des infographies\n\n' +
      '<b>3️⃣ COMMUNAUTÉS :</b>\n' +
      '• Rejoignez des groupes crypto\n' +
      '• Participez aux discussions\n' +
      '• Soyez utile et répondez aux questions\n\n' +
      '<b>✅ À ÉVITER :</b>\n' +
      '• Spam\n' +
      '• Promesses irréalistes\n' +
      '• Pression excessive\n\n' +
      '<b>🎁 ASTUCES BONUS :</b>\n' +
      '• Concentrez-vous sur les parrainages VALIDES (plans payants)\n' +
      '• Expliquez clairement les avantages\n' +
      '• Offrez de l\'aide aux nouveaux membres\n\n' +
      `<b>👥 REJOIGNEZ NOTRE COMMUNAUTÉ :</b>\n` +
      `${COMMUNITY_LINK || 'Lien non disponible'}`;

    const buttons = [
      [
        { text: '📊 STATISTIQUES', callback_data: 'referral_stats' },
        { text: '🏆 CLASSEMENT', callback_data: 'referral_ranking' }
      ],
      [{ text: '👥 REJOINDRE', url: COMMUNITY_LINK || 'https://t.me/' }],
      [{ text: '◀️ RETOUR', callback_data: 'referral_menu' }]
    ];

    const options = {
      reply_markup: { inline_keyboard: buttons },
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };

    if (messageId) {
      try {
        await bot.editMessageText(tipsMessage, {
          chat_id: chatId,
          message_id: messageId,
          ...options
        });
      } catch (editError) {
        await bot.sendMessage(chatId, tipsMessage, options);
      }
    } else {
      await bot.sendMessage(chatId, tipsMessage, options);
    }
  } catch (error) {
    console.error('❌ showReferralTips error:', error.message);
    
    // Version simplifiée sans HTML
    try {
      const simpleMessage = '💡 ASTUCES DE PARRAINAGE\n\n' +
        '1. Partagez votre lien de parrainage\n' +
        '2. Expliquez les avantages\n' +
        '3. Soyez honnête et transparent';
      
      await bot.sendMessage(chatId, simpleMessage, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '◀️ RETOUR', callback_data: 'referral_menu' }]
          ]
        }
      });
    } catch (sendError) {
      console.error('Erreur envoi message simple:', sendError.message);
    }
  }
}

async function showReferralRanking(chatId, messageId) {
  try {
    const topReferrers = await pool.query(`
      SELECT username, referrals, valid_referrals, referral_earnings 
      FROM users 
      WHERE referrals > 0 
      ORDER BY referrals DESC 
      LIMIT 10
    `);

    let rankingMessage = `🏆 **CLASSEMENT DES TOP PARRAINEURS** 🥇\n\n` +
      `📊 **TOP 10 :**\n\n`;

    if (topReferrers.rows.length === 0) {
      rankingMessage += `Aucun parraineur actif pour le moment. Soyez le premier !`;
    } else {
      topReferrers.rows.forEach((user, index) => {
        const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
        rankingMessage += `${medal} **${user.username || 'Anonyme'}**\n`;
        rankingMessage += `   👥 Parrainages : ${user.referrals || 0}\n`;
        rankingMessage += `   ✅ Valides : ${user.valid_referrals || 0}\n`;
        rankingMessage += `   💰 Gains : ${(parseFloat(user.referral_earnings) || 0).toFixed(4)} SOL\n\n`;
      });
    }

    const user = await getOrCreateUser(chatId);
    rankingMessage += `\n📈 **VOTRE POSITION :**\n`;
    rankingMessage += `• 👥 **Vos parrainages :** ${user.referrals || 0}\n`;
    rankingMessage += `• ✅ **Vos parrainages valides :** ${user.valid_referrals || 0}\n`;
    rankingMessage += `• 💰 **Vos gains :** ${(parseFloat(user.referral_earnings) || 0).toFixed(4)} SOL\n\n`;

    rankingMessage += `💡 **NIVEAU SUIVANT :**\n`;
    if (user.referrals < 10) {
      rankingMessage += `Besoin de ${10 - (user.referrals || 0)} parrainages pour Argent`;
    } else if (user.referrals < 20) {
      rankingMessage += `Besoin de ${20 - (user.referrals || 0)} parrainages pour Or`;
    } else if (user.referrals < 50) {
      rankingMessage += `Besoin de ${50 - (user.referrals || 0)} parrainages pour Diamant`;
    } else {
      rankingMessage += `Félicitations ! Vous avez atteint le niveau maximum !`;
    }

    const buttons = [
      [
        { text: '📊 STATISTIQUES', callback_data: 'referral_stats' },
        { text: '💡 ASTUCES', callback_data: 'referral_tips' }
      ],
      [{ text: '◀️ RETOUR', callback_data: 'referral_menu' }]
    ];

    try {
      await bot.editMessageText(rankingMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    } catch (error) {
      await bot.sendMessage(chatId, rankingMessage, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    console.error('showReferralRanking error:', error.message);
  }
}

async function showBalance(chatId, messageId) {
  try {
    const user = await getOrCreateUser(chatId);
    const totalAvailable = getTotalBalance(user);
    const totalUSDT = convertSOLtoUSDT(totalAvailable);
    const lifetimeEarnings = getLifetimeEarnings(user);
    const activePlans = getActivePlans(user);
    
    const balanceMessage = `💰 **VOTRE SOLDE DÉTAILLÉ**\n\n` +
      `💵 **COMPTE PRINCIPAL (retirable) :** ${totalAvailable.toFixed(4)} SOL ($${totalUSDT.toFixed(2)})\n\n` +
      `📊 **GAINS TOTAUX DEPUIS LE DÉBUT :**\n` +
      `• 🤖 **Trading :** ${lifetimeEarnings.trading.toFixed(4)} SOL ($${convertSOLtoUSDT(lifetimeEarnings.trading).toFixed(2)})\n` +
      `• 👥 **Parrainage :** ${lifetimeEarnings.referral.toFixed(4)} SOL ($${convertSOLtoUSDT(lifetimeEarnings.referral).toFixed(2)})\n` +
      `• 🏦 **Total gagné :** ${lifetimeEarnings.total.toFixed(4)} SOL ($${convertSOLtoUSDT(lifetimeEarnings.total).toFixed(2)})\n\n` +
      `📈 **STATISTIQUES :**\n` +
      `• Plans actifs : ${activePlans.length}\n` +
      `• Gains quotidiens : ${activePlans.reduce((sum, plan) => sum + PLANS[plan].daily, 0).toFixed(4)} SOL\n` +
      `• Parrainages : ${user.referrals || 0}\n` +
      `• Parrainages valides : ${user.valid_referrals || 0}/3\n` +
      `• Wallet : ${user.wallet ? '✅ Configuré' : '❌ Non configuré'}\n` +
      `• Prix SOL : $${SOL_PRICE.toFixed(4)}\n` +
      `• Total déposé : ${(parseFloat(user.deposited) || 0).toFixed(4)} SOL\n` +
      `• Total retiré : ${(parseFloat(user.total_withdrawn) || 0).toFixed(4)} SOL`;

    const buttons = [
      [
        { text: '🏦 RETIRER', callback_data: 'make_withdrawal' },
        { text: '🎯 PLANS', callback_data: 'plans_menu' }
      ],
      [
        { text: '💼 WALLET', callback_data: 'wallet_menu' },
        { text: '📊 TABLEAU DE BORD', callback_data: 'dashboard' }
      ],
      [{ text: '◀️ MENU PRINCIPAL', callback_data: 'main_menu' }]
    ];

    try {
      await bot.editMessageText(balanceMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    } catch (error) {
      await bot.sendMessage(chatId, balanceMessage, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    console.error('showBalance error:', error.message);
  }
}
async function showWithdrawalHistory(chatId, messageId) {
  try {
    const withdrawals = await pool.query(
      'SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', 
      [chatId]
    );

    let historyMessage = '';
    if (withdrawals.rows.length === 0) {
      historyMessage = '📭 **AUCUN HISTORIQUE DE RETRAIT**\n\nVous n\'avez effectué aucun retrait pour le moment.';
    } else {
      historyMessage = '📜 **VOS 10 DERNIERS RETRAITS**\n\n';
      
      withdrawals.rows.forEach((w, index) => {
        const statusIcon = w.status === 'approved' ? '✅' : w.status === 'rejected' ? '❌' : w.status === 'cancelled' ? '🚫' : '⏳';
        const statusText = w.status === 'approved' ? 'Approuvé' : w.status === 'rejected' ? 'Rejeté' : w.status === 'cancelled' ? 'Annulé' : 'En attente';
        const date = new Date(w.created_at).toLocaleDateString();
        
        historyMessage += `${index + 1}. ${statusIcon} **${parseFloat(w.amount).toFixed(4)} SOL** ($${convertSOLtoUSDT(parseFloat(w.amount)).toFixed(2)})\n`;
        historyMessage += `   📅 ${date}\n`;
        historyMessage += `   📍 ${w.address ? w.address.substring(0, 15) + '...' : 'Non spécifié'}\n`;
        historyMessage += `   📋 Statut : ${statusText}\n`;
        if (w.fees > 0) {
          historyMessage += `   ⚡ Frais : ${parseFloat(w.fees).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(w.fees)).toFixed(2)})\n`;
        }
        if (w.net_amount > 0) {
          historyMessage += `   🏦 Net : ${parseFloat(w.net_amount).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(w.net_amount)).toFixed(2)})\n`;
        }
        historyMessage += '\n';
      });
    }

    const buttons = [
      [
        { text: '🏦 NOUVEAU RETRAIT', callback_data: 'make_withdrawal' },
        { text: '📊 TABLEAU DE BORD', callback_data: 'dashboard' }
      ],
      [{ text: '◀️ RETOUR', callback_data: 'main_menu' }]
    ];

    try {
      await bot.editMessageText(historyMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    } catch (error) {
      await bot.sendMessage(chatId, historyMessage, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    console.error('showWithdrawalHistory error:', error.message);
  }
}

async function showReferralMenu(chatId, messageId) {
  try {
    const user = await getOrCreateUser(chatId);
    const botUsername = (await bot.getMe()).username;
    const link = `https://t.me/${botUsername}?start=${user.referral_code}`;
    
    // Message HTML pour éviter les problèmes Markdown
    const referralMessage = 
      `<b>👥 PROGRAMME DE PARRAINAGE 💰</b>\n\n` +
      `<b>📊 VOS STATISTIQUES :</b>\n` +
      `• Gains parrainage : ${(parseFloat(user.referral_earnings) || 0).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(user.referral_earnings) || 0).toFixed(2)})\n` +
      `• Parrainages directs : ${user.referrals || 0}\n` +
      `• Parrainages valides : ${user.valid_referrals || 0}/3\n` +
      `• Votre code de parrainage : <code>${user.referral_code || 'Génération...'}</code>\n` +
      `• Niveau : ${user.referrals >= 50 ? '💎 Diamant' : 
                        user.referrals >= 20 ? '🥇 Or' : 
                        user.referrals >= 10 ? '🥈 Argent' : '🥉 Bronze'}\n\n` +
      `<b>🔗 LIEN DE PARRAINAGE :</b>\n` +
      `<code>${link}</code>\n\n` +
      `<b>💰 COMMISSIONS :</b>\n` +
      `• Niveau 1 (Direct) : 10% des achats de plans\n\n` +
      `<b>🎯 CONDITIONS DE PARRAINAGE VALIDE :</b>\n` +
      `• Le filleul doit acheter au moins le plan ${PLANS.free.min_referral_plan}\n` +
      `• Seuls les plans payants comptent pour les 3 parrainages requis\n` +
      `• Les parrainages essai gratuit ne comptent PAS\n\n` +
      `<b>✨ AVANTAGES :</b>\n` +
      `• 🎁 Revenu passif supplémentaire\n` +
      `• 🏆 Niveaux avec récompenses\n` +
      `• 📊 Tableau de bord détaillé\n` +
      `• ✅ Compte pour les conditions de retrait du plan gratuit\n\n` +
      `<b>🏆 REJOIGNEZ NOTRE COMMUNAUTÉ :</b>\n` +
      `${COMMUNITY_LINK}`;

    const buttons = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📋 COPIER LE LIEN', callback_data: 'copy_referral_link' },
            { text: '📊 STATISTIQUES', callback_data: 'referral_stats' }
          ],
          [
            { text: '💡 ASTUCES', callback_data: 'referral_tips' },
            { text: '🏆 CLASSEMENT', callback_data: 'referral_ranking' }
          ],
          [{ text: '👥 REJOINDRE', url: COMMUNITY_LINK }],
          [{ text: '◀️ MENU PRINCIPAL', callback_data: 'main_menu' }]
        ]
      }
    };

    if (messageId) {
      try {
        await bot.editMessageText(referralMessage, {
          chat_id: chatId,
          message_id: messageId,
          ...buttons,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      } catch (editError) {
        // Si l'édition échoue, envoyer un nouveau message
        await bot.sendMessage(chatId, referralMessage, {
          ...buttons,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      }
    } else {
      await bot.sendMessage(chatId, referralMessage, {
        ...buttons,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    }
  } catch (error) {
    console.error('❌ showReferralMenu error:', error.message);
    
    // Message d'erreur simple
    try {
      await bot.sendMessage(chatId, 
        'Une erreur est survenue lors du chargement du menu parrainage. Veuillez réessayer.',
        { disable_web_page_preview: true }
      );
    } catch (sendError) {
      console.error('Erreur envoi message:', sendError.message);
    }
  }
}

async function comparePlans(chatId, messageId) {
  try {
    const compareMessage = `📊 **COMPARAISON DES PLANS** 📈\n\n` +
      `┌──────────────┬────────────┬──────────────┬─────────┬────────────┬──────────────┬─────────┐\n` +
      `│     Plan     │   Prix     │    Quotidien │   ROI   │   Durée    │ Min Retrait  │  Paires │\n` +
      `├──────────────┼────────────┼──────────────┼─────────┼────────────┼──────────────┼─────────┤\n` +
      `│ 🆓 Gratuit   │   0 SOL    │   0.005 SOL  │  350%   │ 14 jours   │  0.02 SOL    │   10    │\n` +
      `│ 🔍 Découverte│  0.1 SOL   │   0.005 SOL  │  150%   │ 30 jours   │  0.05 SOL    │   12    │\n` +
      `│ 🥉 Basique   │  0.5 SOL   │   0.025 SOL  │  150%   │ 30 jours   │  0.1 SOL     │   15    │\n` +
      `│ 🚀 Starter    │  1 SOL     │   0.05 SOL   │  150%   │ 30 jours   │  0.2 SOL     │   18    │\n` +
      `│ ⚡ Avancé     │  1.5 SOL   │   0.075 SOL  │  150%   │ 30 jours   │  0.3 SOL     │   22    │\n` +
      `│ 🥈 Pro       │  2 SOL     │   0.10 SOL   │  150%   │ 30 jours   │  0.5 SOL     │   25    │\n` +
      `│ 💎 Expert    │  4 SOL     │   0.20 SOL   │  150%   │ 30 jours   │  1 SOL       │   30    │\n` +
      `│ 🥇 VIP       │  10 SOL    │   0.50 SOL   │  150%   │ 30 jours   │  2 SOL       │   35    │\n` +
      `└──────────────┴────────────┴──────────────┴─────────┴────────────┴──────────────┴─────────┘\n\n` +
      `📈 **ANALYSE DE RENTABILITÉ :**\n` +
      `• **Gratuit :** Testez la plateforme 14 jours (0.07 SOL total)\n` +
      `• **Découverte :** Récupérez 0.15 SOL en 30 jours\n` +
      `• **Basique :** Récupérez 0.75 SOL en 30 jours\n` +
      `• **Starter :** Récupérez 1.5 SOL en 30 jours\n` +
      `• **Avancé :** Récupérez 2.25 SOL en 30 jours\n` +
      `• **Pro :** Récupérez 3 SOL en 30 jours\n` +
      `• **Expert :** Récupérez 6 SOL en 30 jours\n` +
      `• **VIP :** Récupérez 15 SOL en 30 jours\n\n` +
      `⏱️ **TEMPS DE RÉCUPÉRATION :**\n` +
      `• Découverte : 20 jours\n` +
      `• Basique : 20 jours\n` +
      `• Starter : 20 jours\n` +
      `• Avancé : 20 jours\n` +
      `• Pro : 20 jours\n` +
      `• Expert : 20 jours\n` +
      `• VIP : 20 jours\n\n` +
      `⏰ **DURÉE DES SESSIONS :**\n` +
      `• Gratuit : 2 minutes\n` +
      `• Découverte : 2.5 minutes\n` +
      `• Basique : 3 minutes\n` +
      `• Starter : 3.5 minutes\n` +
      `• Avancé : 4 minutes\n` +
      `• Pro : 4.5 minutes\n` +
      `• Expert : 5 minutes\n` +
      `• VIP : 6 minutes\n\n` +
      `💡 **RECOMMANDATIONS :**\n` +
      `• Débutant : Commencez avec l'Essai Gratuit\n` +
      `• Petit investisseur : Choisissez Découverte\n` +
      `• Intermédiaire : Passez à Starter ou Avancé\n` +
      `• Investisseur sérieux : Choisissez Pro ou Expert\n` +
      `• Professionnel : Choisissez VIP\n\n` +
      `💎 **Vous pouvez cumuler plusieurs plans !**`;

    const buttons = [
      [
        { text: '🆓 GRATUIT', callback_data: 'show_free_plan' },
        { text: '🔍 DÉCOUVERTE', callback_data: 'show_discovery_plan' }
      ],
      [
        { text: '🥉 BASIQUE', callback_data: 'show_basic_plan' },
        { text: '🚀 STARTER', callback_data: 'show_starter_plan' }
      ],
      [
        { text: '⚡ AVANCÉ', callback_data: 'show_advanced_plan' },
        { text: '🥈 PRO', callback_data: 'show_pro_plan' }
      ],
      [
        { text: '💎 EXPERT', callback_data: 'show_expert_plan' },
        { text: '🥇 VIP', callback_data: 'show_vip_plan' }
      ],
      [
        { text: '◀️ RETOUR', callback_data: 'plans_menu' },
        { text: '🏠 MENU', callback_data: 'main_menu' }
      ]
    ];

    try {
      await bot.editMessageText(compareMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    } catch (error) {
      await bot.sendMessage(chatId, compareMessage, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    console.error('comparePlans error:', error.message);
  }
}

async function showMyPlan(chatId, messageId) {
  try {
    const user = await getOrCreateUser(chatId);
    const activePlans = getActivePlans(user);
    
    if (activePlans.length === 0 && !user.plan) {
      await bot.sendMessage(chatId, 
        `❌ **PAS DE PLAN ACTIF**\n\n` +
        `Vous n'avez pas activé de plan d'investissement.\n\n` +
        `👉 Cliquez sur "Plans d'investissement" pour commencer !`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const nextClaimIn = user.last_claim > 0 ? Math.max(0, 86400 - (now - user.last_claim)) : 0;
    const hoursLeft = Math.floor(nextClaimIn / 3600);
    const minutesLeft = Math.floor((nextClaimIn % 3600) / 60);
    const canTrade = nextClaimIn === 0;

    let myPlanMessage = `🎯 **VOS PLANS ACTIFS**\n\n`;
    
    if (activePlans.length > 0) {
      activePlans.forEach((planKey, index) => {
        const plan = PLANS[planKey];
        myPlanMessage += `${index + 1}. **${plan.name}**\n`;
        myPlanMessage += `   💰 Investissement : ${plan.price} SOL\n`;
        myPlanMessage += `   📈 Quotidien : ${plan.daily} SOL ($${convertSOLtoUSDT(plan.daily).toFixed(2)})\n`;
        myPlanMessage += `   📊 ROI : ${plan.roi}\n`;
        myPlanMessage += `   ⏰ Durée : ${plan.duration}\n\n`;
      });
    } else if (user.plan) {
      const plan = PLANS[user.plan];
      myPlanMessage += `📋 **NOM :** ${plan.name}\n`;
      myPlanMessage += `💰 **INVESTISSEMENT :** ${plan.price} SOL ($${convertSOLtoUSDT(plan.price).toFixed(2)})\n`;
      myPlanMessage += `📈 **GAINS QUOTIDIENS :** ${plan.daily} SOL ($${convertSOLtoUSDT(plan.daily).toFixed(2)})\n`;
      myPlanMessage += `📊 **ROI :** ${plan.roi}\n`;
      myPlanMessage += `⏰ **DURÉE :** ${plan.duration}\n`;
      myPlanMessage += `💸 **RETRAIT MINIMUM :** ${plan.min_withdrawal} SOL\n`;
      myPlanMessage += `🔄 **RETRAITS MAX/JOUR :** ${plan.max_withdrawals_per_day}\n`;
      myPlanMessage += `🤖 **PAIRES :** ${plan.pairs} paires\n`;
      myPlanMessage += `⏱️ **SESSION :** ${Math.floor(plan.session_duration / 60)} minutes\n\n`;
    }
    
    myPlanMessage += `📅 **STATISTIQUES :**\n`;
    myPlanMessage += `• 🕒 **Prochain trading :** ${canTrade ? '✅ DISPONIBLE' : `Dans ${hoursLeft}h ${minutesLeft}m`}\n`;
    myPlanMessage += `• 💰 **Total gains trading :** ${(parseFloat(user.main_balance) || 0).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(user.main_balance) || 0).toFixed(2)})\n`;
    myPlanMessage += `• 📊 **Parrainages valides :** ${user.valid_referrals || 0}/3\n\n`;
    myPlanMessage += `💎 **Vous pouvez ajouter d'autres plans !**`;

    const buttons = [
      [{ text: canTrade ? '🤖 COMMENCER À TRADER' : `⏳ ${hoursLeft}h ${minutesLeft}m`, callback_data: 'trading_menu' }],
      [
        { text: '🔄 AJOUTER UN PLAN', callback_data: 'plans_menu' },
        { text: '📊 TABLEAU DE BORD', callback_data: 'dashboard' }
      ],
      [{ text: '◀️ MENU PRINCIPAL', callback_data: 'main_menu' }]
    ];

    try {
      await bot.editMessageText(myPlanMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    } catch (error) {
      await bot.sendMessage(chatId, myPlanMessage, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    console.error('showMyPlan error:', error.message);
  }
}

async function showFeeCalculator(chatId, messageId) {
  try {
    const user = await getOrCreateUser(chatId);
    const mainBalance = parseFloat(user.main_balance) || 0;
    const mainUSDT = convertSOLtoUSDT(mainBalance);
    
    await updatePrices();
    
    const examples = [0.05, 0.1, 0.3, 0.5, 0.75, 1, 2];
    let examplesText = '';
    examples.forEach(amount => {
      const fees = calculateDynamicFees(amount);
      examplesText += `\n• ${amount} SOL → ${fees.feesSOL} SOL frais ($${fees.feesUSD.toFixed(4)}) → Recevez ${fees.netAmountSOL.toFixed(4)} SOL ($${fees.netAmountUSD.toFixed(4)})`;
    });
    
    const calculatorMessage = `📊 **CALCULATEUR DE FRAIS DYNAMIQUES** ⚡\n\n` +
      `💰 **Votre solde principal :** ${mainBalance.toFixed(4)} SOL ($${mainUSDT.toFixed(2)})\n` +
      `📈 **Prix SOL actuel (temps réel) :** $${SOL_PRICE.toFixed(4)}\n\n` +
      `📋 **STRUCTURE DES FRAIS :**\n` +
      `• ≤ 0.1 SOL : 0.001 SOL frais\n` +
      `• ≤ 0.5 SOL : 0.002 SOL frais\n` +
      `• ≤ 1 SOL : 0.003 SOL frais\n` +
      `• > 1 SOL : 0.005 SOL frais (max)\n\n` +
      `⚠️ **AJUSTEMENTS :**\n` +
      `• Minimum net après frais : ${MIN_NET_AMOUNT} SOL\n` +
      `• Si net < ${MIN_NET_AMOUNT} SOL, frais ajustés\n\n` +
      `🔢 **EXEMPLES ($${SOL_PRICE.toFixed(4)}) :${examplesText}\n\n` +
      `💡 **ASTUCES :**\n` +
      `• Retirez plus pour moins de frais %\n` +
      `• Frais avec prix SOL réel\n` +
      `• Toujours ≥ ${MIN_NET_AMOUNT} SOL net`;

    const buttons = [
      [
        { 
          text: `💰 0.1 SOL`, 
          callback_data: 'confirm_withdrawal_0.1' 
        },
        { 
          text: `💰 0.5 SOL`, 
          callback_data: 'confirm_withdrawal_0.5' 
        }
      ],
      [
        { 
          text: `💰 1 SOL`, 
          callback_data: 'confirm_withdrawal_1' 
        },
        { 
          text: '💳 PERSO', 
          callback_data: 'make_withdrawal' 
        }
      ],
      [
        { 
          text: '🔄 PRIX SOL', 
          callback_data: 'update_sol_price_user' 
        },
        { 
          text: '🏠 MENU', 
          callback_data: 'main_menu' 
        }
      ]
    ];

    try {
      await bot.editMessageText(calculatorMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    } catch (error) {
      await bot.sendMessage(chatId, calculatorMessage, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    console.error('showFeeCalculator error:', error.message);
  }
}

async function showHelpSupport(chatId, messageId) {
  try {
    const helpMessage = `ℹ️ **AIDE & SUPPORT** 📞\n\n` +
      `🤖 **QU'EST-CE QUE CE BOT ?**\n` +
      `Plateforme de trading algorithmique qui génère un revenu passif grâce à l'IA.\n\n` +
      `🎯 **COMMENT ÇA MARCHE ?**\n` +
      `1. Choisissez un plan d'investissement\n` +
      `2. Payez directement via NowPayments\n` +
      `3. Le plan s'active automatiquement\n` +
      `4. Commencez à trader depuis le menu Trading\n` +
      `5. Nos robots tradent pour vous\n` +
      `6. Retirez vos profits quand vous voulez\n\n` +
      `💰 **PLANS DISPONIBLES :**\n` +
      `• 🆓 Essai Gratuit : 0.005 SOL/jour (350% ROI sur 14 jours)\n` +
      `• 🔍 Découverte (0.1 SOL) : 0.005 SOL/jour (150% ROI)\n` +
      `• 🥉 Basique (0.5 SOL) : 0.025 SOL/jour (150% ROI)\n` +
      `• 🚀 Starter (1 SOL) : 0.05 SOL/jour (150% ROI)\n` +
      `• ⚡ Avancé (1.5 SOL) : 0.075 SOL/jour (150% ROI)\n` +
      `• 🥈 Pro (2 SOL) : 0.10 SOL/jour (150% ROI)\n` +
      `• 💎 Expert (4 SOL) : 0.20 SOL/jour (150% ROI)\n` +
      `• 🥇 VIP (10 SOL) : 0.50 SOL/jour (150% ROI)\n\n` +
      `🤖 **TRADING :**\n` +
      `• Durée : ${PLANS.free.session_duration / 60}-${PLANS.vip.session_duration / 60} minutes par session\n` +
      `• Fréquence : Une fois toutes les 24h\n` +
      `• Processus : Simulation temps réel avec ${PLANS.free.pairs}-${PLANS.vip.pairs} trades\n` +
      `• Résultats : Gains garantis = quotidien de votre plan\n\n` +
      `👥 **PARRAINAGE :**\n` +
      `Gagnez 10% des achats de plans de vos filleuls.\n\n` +
      `⚠️ **RESTRICTIONS PLAN GRATUIT :**\n` +
      `• Valable 14 jours seulement\n` +
      `• Besoin de 3 parrainages valides pour retirer\n` +
      `• Parrainages valides = parrainages avec plans payants\n` +
      `• Alternative : Passez à n'importe quel plan payant\n\n` +
      `🏦 **RETRAITS - FRAIS DYNAMIQUES :**\n` +
      `• Minimum : Varie selon le plan\n` +
      `• Minimum net après frais : ${MIN_NET_AMOUNT} SOL\n` +
      `• Délai : 24h entre les retraits\n` +
      `• Processus : Automatique en 5 minutes\n` +
      `• Frais : 0.001-0.005 SOL déduits du retrait\n` +
      `• Max retraits/jour : Varie selon le plan\n\n` +
      `💼 **SYSTÈME MULTI-COMPTES :**\n` +
      `• Compte Principal : Pour retraits et gains trading\n` +
      `• Compte Trading : Pour investir\n` +
      `• Compte Parrainage : Pour gains de parrainage\n\n` +
      `📞 **CONTACT :**\n` +
      `• Support : @${SUPPORT_USERNAME}\n` +
      `• Communauté : ${COMMUNITY_LINK}\n` +
      `💡 **ASTUCES :**\n` +
      `1. Commencez avec le plan gratuit\n` +
      `2. Configurez votre wallet Solana\n` +
      `3. Parrainez activement\n` +
      `4. Réinvestissez vos gains\n` +
      `5. Rejoignez notre communauté\n\n` +
      `💎 **Vous pouvez cumuler plusieurs plans !**`;

    const buttons = [
      [
        { text: '🎯 PLANS', callback_data: 'plans_menu' },
        { text: '🏦 RETRAITS', callback_data: 'make_withdrawal' }
      ],
      [
        { text: '👥 PARRAINAGE', callback_data: 'referral_menu' },
        { text: '📊 TABLEAU', callback_data: 'dashboard' }
      ],
      [
        { text: '👥 COMMUNAUTÉ', url: COMMUNITY_LINK },
        { text: '💼 WALLET', callback_data: 'wallet_menu' }
      ],
      [{ text: '◀️ MENU', callback_data: 'main_menu' }]
    ];

    try {
      await bot.editMessageText(helpMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    } catch (error) {
      await bot.editMessageText(helpMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    console.error('showHelpSupport error:', error.message);
    
    try {
      await bot.sendMessage(chatId, 
        'Une erreur est survenue lors du chargement de l\'aide. Veuillez réessayer.'
      );
    } catch (sendError) {
      console.error('Erreur envoi message:', sendError.message);
    }
  }
}

// ==================== FONCTIONS ADMIN ====================

async function handleAdminWithdrawalAction(action, chatId, messageId, callbackQueryId, withdrawalId = null) {
  if (chatId !== ADMIN_ID) {
    await bot.sendMessage(chatId, '❌ Accès refusé');
    return;
  }
  
  try {
    if (!withdrawalId) {
      // Récupérer l'ID du retrait depuis le message
      const message = callbackQuery.message.text;
      const idMatch = message.match(/#(\d+)/);
      if (idMatch) {
        withdrawalId = parseInt(idMatch[1]);
      }
    }
    
    if (!withdrawalId) {
      await bot.sendMessage(chatId, '❌ ID de retrait non trouvé');
      return;
    }
    
    switch(action) {
      case 'approve':
        await processAdminWithdrawalApproval(chatId, withdrawalId);
        break;
      case 'reject':
        await processAdminWithdrawalRejection(chatId, withdrawalId);
        break;
      case 'hold':
        await processAdminWithdrawalHold(chatId, withdrawalId);
        break;
    }
    
    await showAdminPanel(chatId, messageId);
    
  } catch (error) {
    console.error('handleAdminWithdrawalAction error:', error.message);
    await bot.sendMessage(chatId, `❌ Erreur: ${error.message}`);
  }
}

async function processAdminWithdrawalApproval(chatId, withdrawalId) {
  try {
    await processAutomaticWithdrawal(withdrawalId);
    await bot.sendMessage(chatId, `✅ Retrait #${withdrawalId} approuvé manuellement.`);
  } catch (error) {
    console.error('processAdminWithdrawalApproval error:', error.message);
    throw error;
  }
}

async function processAdminWithdrawalRejection(chatId, withdrawalId) {
  try {
    const withdrawal = await pool.query('SELECT * FROM withdrawals WHERE id = $1', [withdrawalId]);
    
    if (withdrawal.rows.length === 0) {
      throw new Error(`Retrait #${withdrawalId} non trouvé`);
    }
    
    await pool.query('UPDATE withdrawals SET status = $1, admin_notes = $2 WHERE id = $3', 
      ['rejected', 'Rejeté par l\'admin', withdrawalId]);
    
    const user = await getOrCreateUser(withdrawal.rows[0].user_id);
    const newBalance = (parseFloat(user.main_balance) || 0) + parseFloat(withdrawal.rows[0].amount);
    
    await updateUser(withdrawal.rows[0].user_id, {
      main_balance: newBalance,
      withdrawal_status: 'none',
      withdrawal_pending: 0
    });
    
    await addTransaction(withdrawal.rows[0].user_id, 'refund', parseFloat(withdrawal.rows[0].amount), `Retrait #${withdrawalId} rejeté - Remboursé`);
    
    await bot.sendMessage(withdrawal.rows[0].user_id,
      `❌ **RETRAIT REJETÉ**\n\n` +
      `Votre retrait de ${parseFloat(withdrawal.rows[0].amount)} SOL ($${convertSOLtoUSDT(parseFloat(withdrawal.rows[0].amount)).toFixed(2)}) a été rejeté.\n` +
      `💰 **Remboursé :** ${parseFloat(withdrawal.rows[0].amount)} SOL ($${convertSOLtoUSDT(parseFloat(withdrawal.rows[0].amount)).toFixed(2)})\n` +
      `💳 **Nouveau solde principal :** ${newBalance.toFixed(4)} SOL ($${convertSOLtoUSDT(newBalance).toFixed(2)})\n\n` +
      `⚠️ **Raison :** Rejeté par l'administrateur\n` +
      `📞 **Contactez le support pour plus d'informations.**`,
      { parse_mode: 'Markdown' }
    );
    
    await bot.sendMessage(chatId, `✅ Retrait #${withdrawalId} rejeté et utilisateur remboursé.`);
    
  } catch (error) {
    console.error('processAdminWithdrawalRejection error:', error.message);
    throw error;
  }
}

async function processAdminWithdrawalHold(chatId, withdrawalId) {
  try {
    const withdrawal = await pool.query('SELECT * FROM withdrawals WHERE id = $1', [withdrawalId]);
    
    if (withdrawal.rows.length === 0) {
      throw new Error(`Retrait #${withdrawalId} non trouvé`);
    }
    
    await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', ['on_hold', withdrawalId]);
    
    await bot.sendMessage(withdrawal.rows[0].user_id,
      `⏸️ **RETRAIT MIS EN ATTENTE**\n\n` +
      `Votre retrait de ${parseFloat(withdrawal.rows[0].amount)} SOL ($${convertSOLtoUSDT(parseFloat(withdrawal.rows[0].amount)).toFixed(2)}) a été mis en attente.\n\n` +
      `📞 **Contactez le support pour plus d'informations.**`,
      { parse_mode: 'Markdown' }
    );
    
    await bot.sendMessage(chatId, `✅ Retrait #${withdrawalId} mis en attente.`);
    
  } catch (error) {
    console.error('processAdminWithdrawalHold error:', error.message);
    throw error;
  }
}

async function showAdminPanel(chatId, messageId) {
  try {
    if (chatId !== ADMIN_ID) {
      await bot.sendMessage(chatId, '❌ **ACCÈS REFUSÉ**', { parse_mode: 'Markdown' });
      return;
    }

    const adminMessage = `👑 **PANEL ADMINISTRATEUR** 🚀\n\n` +
      `⚙️ **COMMANDES DISPONIBLES :**\n` +
      `• \`/stats\` - Statistiques détaillées\n` +
      `• \`/user ID\` - Voir infos utilisateur\n` +
      `• \`/pending\` - Voir retraits en attente\n` +
      `• \`/broadcast message\` - Envoyer à tous\n` +
      `• \`/solana_status\` - Vérifier compte Solana\n` +
      `• \`/update_sol_price\` - Mettre à jour prix SOL\n` +
      `• \`/solprice\` - Voir prix SOL\n` +
      `• \`/approve ID\` - Approuver retrait manuellement\n` +
      `• \`/reject ID raison\` - Rejeter retrait\n` +
      `• \`/hold ID\` - Mettre retrait en attente\n` +
      `• \`/setbalance ID SOL\` - Modifier solde utilisateur\n` +
      `• \`/addbonus ID SOL raison\` - Ajouter bonus\n` +
      `• \`/removeuser ID\` - Supprimer utilisateur\n` +
      `• \`/resetplan ID\` - Réinitialiser plan utilisateur\n` +
      `• \`/listusers\` - Lister tous les utilisateurs\n` +
      `• \`/searchuser query\` - Rechercher utilisateur\n` +
      `• \`/exportdata\` - Exporter données\n\n` +
      `🔧 **GESTION :**\n` +
      `• ✅ Retraits automatiques (5 min délai)\n` +
      `• ✅ Approubation manuelle disponible\n` +
      `• 📊 Analytics avancés\n` +
      `• 💰 Système de frais dynamiques activé\n` +
      `• 👥 Système de codes de parrainage actif\n\n` +
      `⚠️ **STATUT SYSTÈME :**\n` +
      `• Retraits : ${WITHDRAWALS_ENABLED ? '✅ Activés' : '❌ Désactivés'}\n` +
      `• Prix SOL : $${SOL_PRICE.toFixed(4)}\n` +
      `• Minimum net après frais : ${MIN_NET_AMOUNT} SOL\n` +
      `• Bot : ✅ **OPÉRATIONNEL**`;

    const buttons = [
      [
        { text: '📋 RETRAITS', callback_data: 'admin_pending' },
        { text: '👥 UTILISATEURS', callback_data: 'admin_users' }
      ],
      [
        { text: '📊 STATS', callback_data: 'admin_stats' },
        { text: '📢 DIFFUSER', callback_data: 'admin_broadcast' }
      ],
      [
        { text: WITHDRAWALS_ENABLED ? '⏸️ RETRAITS' : '▶️ RETRAITS', 
          callback_data: WITHDRAWALS_ENABLED ? 'admin_disable_withdrawals' : 'admin_enable_withdrawals' }
      ],
      [
        { text: '🔧 OUTILS', callback_data: 'admin_tools' },
        { text: '📁 EXPORTER', callback_data: 'admin_export' }
      ],
      [{ text: '◀️ MENU', callback_data: 'main_menu' }]
    ];

    try {
      await bot.editMessageText(adminMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    } catch (error) {
      await bot.sendMessage(chatId, adminMessage, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    console.error('showAdminPanel error:', error.message);
  }
}

async function handleAdminCallback(data, chatId, messageId, callbackQueryId) {
  if (chatId !== ADMIN_ID) {
    await bot.sendMessage(chatId, '❌ Accès refusé');
    return;
  }
  
  try {
    if (data === 'admin_panel') {
      await showAdminPanel(chatId, messageId);
    } else if (data === 'admin_pending') {
      await adminShowPending(chatId, messageId);
    } else if (data === 'admin_users') {
      await adminShowUsers(chatId, messageId);
    } else if (data === 'admin_stats') {
      await adminShowStats(chatId, messageId);
    } else if (data === 'admin_broadcast') {
      await bot.sendMessage(chatId, '📢 Utilisez la commande `/broadcast message` pour diffuser un message.', { parse_mode: 'Markdown' });
    } else if (data === 'admin_disable_withdrawals') {
      WITHDRAWALS_ENABLED = false;
      await bot.sendMessage(chatId, '✅ Retraits désactivés');
    } else if (data === 'admin_enable_withdrawals') {
      WITHDRAWALS_ENABLED = true;
      await bot.sendMessage(chatId, '✅ Retraits activés');
    } else if (data === 'admin_tools') {
      await showAdminTools(chatId, messageId);
    } else if (data === 'admin_export') {
      await exportData(chatId);
    }
  } catch (error) {
    console.error('Admin callback error:', error.message);
  }
}

async function showAdminTools(chatId, messageId) {
  try {
    const toolsMessage = `🔧 **OUTILS ADMIN AVANCÉS**\n\n` +
      `📋 **MODIFICATION DE SOLDES :**\n` +
      `• \`/setbalance ID SOL compte\` - Définir solde\n` +
      `  Ex: \`/setbalance 12345 10 main\` - Définit solde principal à 10 SOL\n` +
      `  Comptes: main, trading, referral, all\n\n` +
      `🎁 **AJOUT DE BONUS :**\n` +
      `• \`/addbonus ID SOL raison\` - Ajouter bonus\n` +
      `  Ex: \`/addbonus 12345 1 "Bonus fidélité"\`\n\n` +
      `🔄 **GESTION UTILISATEURS :**\n` +
      `• \`/resetplan ID\` - Réinitialiser plan\n` +
      `• \`/removeuser ID\` - Supprimer utilisateur\n` +
      `• \`/changewallet ID adresse\` - Changer wallet\n\n` +
      `🔍 **RECHERCHE :**\n` +
      `• \`/searchuser query\` - Rechercher par ID, nom, wallet\n` +
      `• \`/listusers page\` - Lister utilisateurs (20/page)\n\n` +
      `📊 **ANALYSE :**\n` +
      `• \`/userstats ID\` - Statistiques détaillées utilisateur\n` +
      `• \`/planstats plan\` - Statistiques par plan\n\n` +
      `⚠️ **AVERTISSEMENT :** Utilisez ces commandes avec prudence.`;

    const buttons = [
      [{ text: '◀️ RETOUR ADMIN', callback_data: 'admin_panel' }],
      [{ text: '🏠 MENU PRINCIPAL', callback_data: 'main_menu' }]
    ];

    if (messageId) {
      await bot.editMessageText(toolsMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    } else {
      await bot.sendMessage(chatId, toolsMessage, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    console.error('showAdminTools error:', error.message);
  }
}

async function adminShowPending(chatId, messageId) {
  try {
    if (chatId !== ADMIN_ID) {
      await bot.sendMessage(chatId, '❌ Accès refusé');
      return;
    }
    
    const withdrawals = await pool.query(`SELECT * FROM withdrawals WHERE status = 'pending' ORDER BY created_at DESC`);
    
    if (withdrawals.rows.length === 0) {
      return bot.sendMessage(chatId, '✅ **AUCUN RETRAIT EN ATTENTE**\n\nToutes les demandes ont été traitées.', { parse_mode: 'Markdown' });
    }
    
    let message = `⏳ **RETRAITS EN ATTENTE (${withdrawals.rows.length})**\n\n`;
    
    for (const w of withdrawals.rows) {
      const user = await getOrCreateUser(w.user_id);
      message += `📋 **ID :** #${w.id}\n`;
      message += `👤 **Utilisateur :** ID: ${w.user_id} (${user.username || 'Pas de nom'})\n`;
      message += `💰 **Montant :** ${parseFloat(w.amount).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(w.amount)).toFixed(2)})\n`;
      message += `📈 **Prix SOL :** $${SOL_PRICE.toFixed(4)}\n`;
      message += `⚡ **Frais :** ${parseFloat(w.fees).toFixed(4)} SOL\n`;
      message += `🏦 **Net :** ${parseFloat(w.net_amount).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(w.net_amount)).toFixed(2)})\n`;
      message += `📍 **Wallet :** \`${w.address}\`\n`;
      message += `📅 **Demandé :** ${new Date(w.created_at).toLocaleDateString()}\n`;
      
      // Boutons d'action
      message += `🔧 **Actions :** \n`;
      message += `   ✅ /approve_${w.id} | ❌ /reject_${w.id} | ⏸️ /hold_${w.id}\n`;
      message += `─────────────────────\n`;
    }
    
    const buttons = [[{ text: '◀️ RETOUR ADMIN', callback_data: 'admin_panel' }]];
    
    if (messageId) {
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    } else {
      await bot.sendMessage(chatId, message, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    console.error('adminShowPending error:', error.message);
  }
}

async function adminShowUsers(chatId, messageId) {
  try {
    if (chatId !== ADMIN_ID) {
      await bot.sendMessage(chatId, '❌ Accès refusé');
      return;
    }
    
    const users = await pool.query(`SELECT user_id, username, plan, plans, main_balance, trading_balance, referral_balance, referrals, valid_referrals, deposited, referral_code, wallet, created_at FROM users ORDER BY created_at DESC LIMIT 20`);
    
    let message = `👥 **20 DERNIERS UTILISATEURS**\n\n`;
    
    users.rows.forEach((user, index) => {
      const totalBalance = getTotalBalance(user);
      const activePlans = getActivePlans(user);
      message += `${index + 1}. **ID :** ${user.user_id}\n`;
      message += `   👤 ${user.username || 'Pas de nom'}\n`;
      message += `   🎯 Plans : ${activePlans.length > 0 ? activePlans.map(p => PLANS[p].name).join(', ') : (user.plan ? PLANS[user.plan].name : 'Pas de plan')}\n`;
      message += `   💰 Total : ${totalBalance.toFixed(4)} SOL\n`;
      message += `   📊 ${user.referrals || 0} parrainages (${user.valid_referrals || 0} valides)\n`;
      message += `   🔑 Code : ${user.referral_code || 'N/A'}\n`;
      message += `   🏦 Wallet : ${user.wallet ? '✅' : '❌'}\n`;
      message += `   📅 ${new Date(user.created_at).toLocaleDateString()}\n`;
      message += `   ⚡ \`/user ${user.user_id}\` | \`/setbalance ${user.user_id} 0 main\`\n`;
      message += `─────────────────────\n`;
    });
    
    const buttons = [
      [{ text: '📊 STATISTIQUES', callback_data: 'admin_stats' }],
      [{ text: '🔧 OUTILS', callback_data: 'admin_tools' }],
      [{ text: '◀️ RETOUR ADMIN', callback_data: 'admin_panel' }]
    ];
    
    if (messageId) {
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    } else {
      await bot.sendMessage(chatId, message, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    console.error('adminShowUsers error:', error.message);
  }
}

async function adminShowStats(chatId, messageId) {
  try {
    if (chatId !== ADMIN_ID) {
      await bot.sendMessage(chatId, '❌ Accès refusé');
      return;
    }
    
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_users,
        SUM(deposited) as total_deposits,
        SUM(main_balance) as total_main_balance,
        SUM(trading_balance) as total_trading_balance,
        SUM(referral_balance) as total_referral_balance,
        SUM(referral_earnings) as total_referral_earnings,
        SUM(valid_referrals) as total_valid_referrals,
        (SELECT COUNT(*) FROM withdrawals WHERE status = 'approved') as approved_withdrawals,
        (SELECT SUM(amount) FROM withdrawals WHERE status = 'approved') as total_withdrawn,
        (SELECT SUM(fees) FROM withdrawals WHERE status = 'approved') as total_fees,
        (SELECT COUNT(*) FROM withdrawals WHERE status = 'pending') as pending_withdrawals,
        (SELECT COUNT(*) FROM users WHERE plan IS NOT NULL OR plans != '{}') as active_plans,
        (SELECT COUNT(*) FROM users WHERE plan = 'free') as free_plans,
        (SELECT COUNT(*) FROM users WHERE 'discovery' = ANY(plans) OR plan = 'discovery') as discovery_plans,
        (SELECT COUNT(*) FROM users WHERE 'basic' = ANY(plans) OR plan = 'basic') as basic_plans,
        (SELECT COUNT(*) FROM users WHERE 'starter' = ANY(plans) OR plan = 'starter') as starter_plans,
        (SELECT COUNT(*) FROM users WHERE 'advanced' = ANY(plans) OR plan = 'advanced') as advanced_plans,
        (SELECT COUNT(*) FROM users WHERE 'pro' = ANY(plans) OR plan = 'pro') as pro_plans,
        (SELECT COUNT(*) FROM users WHERE 'expert' = ANY(plans) OR plan = 'expert') as expert_plans,
        (SELECT COUNT(*) FROM users WHERE 'vip' = ANY(plans) OR plan = 'vip') as vip_plans
      FROM users
    `);

    const statsData = stats.rows[0];
    const totalBalance = (parseFloat(statsData.total_main_balance) || 0) + (parseFloat(statsData.total_trading_balance) || 0) + (parseFloat(statsData.total_referral_balance) || 0);
    
    const message = `📊 **STATISTIQUES DÉTAILLÉES** 📈\n\n` +
      `👥 **UTILISATEURS :**\n` +
      `• Total : ${statsData.total_users || 0}\n` +
      `• Plans actifs : ${statsData.active_plans || 0}\n` +
      `• Essais gratuits : ${statsData.free_plans || 0}\n` +
      `• Découverte : ${statsData.discovery_plans || 0}\n` +
      `• Basique : ${statsData.basic_plans || 0}\n` +
      `• Starter : ${statsData.starter_plans || 0}\n` +
      `• Avancé : ${statsData.advanced_plans || 0}\n` +
      `• Pro : ${statsData.pro_plans || 0}\n` +
      `• Expert : ${statsData.expert_plans || 0}\n` +
      `• VIP : ${statsData.vip_plans || 0}\n\n` +
      `💰 **FINANCES :**\n` +
      `• Total déposé : ${(parseFloat(statsData.total_deposits) || 0).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(statsData.total_deposits) || 0).toFixed(2)})\n` +
      `• Total solde : ${totalBalance.toFixed(4)} SOL ($${convertSOLtoUSDT(totalBalance).toFixed(2)})\n` +
      `• Principal : ${(parseFloat(statsData.total_main_balance) || 0).toFixed(4)} SOL\n` +
      `• Trading : ${(parseFloat(statsData.total_trading_balance) || 0).toFixed(4)} SOL\n` +
      `• Parrainage : ${(parseFloat(statsData.total_referral_balance) || 0).toFixed(4)} SOL\n` +
      `• Gains parrainage : ${(parseFloat(statsData.total_referral_earnings) || 0).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(statsData.total_referral_earnings) || 0).toFixed(2)})\n` +
      `• Parrainages valides : ${statsData.total_valid_referrals || 0}\n\n` +
      `🏦 **RETRAITS :**\n` +
      `• Approuvés : ${statsData.approved_withdrawals || 0} (${(parseFloat(statsData.total_withdrawn) || 0).toFixed(4)} SOL)\n` +
      `• Frais collectés : ${(parseFloat(statsData.total_fees) || 0).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(statsData.total_fees) || 0).toFixed(2)})\n` +
      `• En attente : ${statsData.pending_withdrawals || 0}\n\n` +
      `⚙️ **SYSTÈME :**\n` +
      `• Retraits : ${WITHDRAWALS_ENABLED ? '✅ Activés' : '❌ Désactivés'}\n` +
      `• Prix SOL : $${SOL_PRICE.toFixed(4)}\n` +
      `• Minimum net après frais : ${MIN_NET_AMOUNT} SOL\n` +
      `• Statut : ✅ **OPÉRATIONNEL**`;

    const buttons = [
      [{ text: '👥 VOIR UTILISATEURS', callback_data: 'admin_users' }],
      [{ text: '◀️ RETOUR ADMIN', callback_data: 'admin_panel' }]
    ];

    if (messageId) {
      await bot.editMessageText(message, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    } else {
      await bot.sendMessage(chatId, message, {
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      });
    }
  } catch (error) {
    console.error('adminShowStats error:', error.message);
  }
}

// ==================== COMMANDES ADMIN ====================

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, '❌ Accès refusé');
  }
  
  await adminShowStats(chatId, null);
});

bot.onText(/\/user (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = parseInt(match[1]);
  
  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, '❌ Accès refusé');
  }
  
  try {
    const user = await getUser(userId);
    
    if (!user) {
      return bot.sendMessage(chatId, `❌ Utilisateur ${userId} non trouvé`);
    }
    
    const withdrawals = await pool.query('SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5', [userId]);
    const transactions = await pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5', [userId]);
    const validReferrals = await pool.query('SELECT * FROM valid_referrals WHERE referrer_id = $1 ORDER BY activated_at DESC LIMIT 5', [userId]);
    const payments = await pool.query('SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5', [userId]);
    
    const totalBalance = getTotalBalance(user);
    const activePlans = getActivePlans(user);
    
    let message = `👤 **DÉTAILS UTILISATEUR**\n\n` +
      `• **ID :** ${user.user_id}\n` +
      `• **Nom :** ${user.username || 'Aucun'}\n` +
      `• **Plan principal :** ${user.plan ? PLANS[user.plan].name : 'Aucun'}\n` +
      `• **Plans actifs :** ${activePlans.length > 0 ? activePlans.map(p => PLANS[p].name).join(', ') : 'Aucun'}\n` +
      `• **Solde principal :** ${parseFloat(user.main_balance).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(user.main_balance)).toFixed(2)})\n` +
      `• **Solde trading :** ${parseFloat(user.trading_balance).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(user.trading_balance)).toFixed(2)})\n` +
      `• **Solde parrainage :** ${parseFloat(user.referral_balance).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(user.referral_balance)).toFixed(2)})\n` +
      `• **Total solde :** ${totalBalance.toFixed(4)} SOL ($${convertSOLtoUSDT(totalBalance).toFixed(2)})\n` +
      `• **Gains parrainage :** ${parseFloat(user.referral_earnings).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(user.referral_earnings)).toFixed(2)})\n` +
      `• **Total déposé :** ${parseFloat(user.deposited).toFixed(4)} SOL ($${convertSOLtoUSDT(parseFloat(user.deposited)).toFixed(2)})\n` +
      `• **Parrainages :** ${user.referrals || 0}\n` +
      `• **Parrainages valides :** ${user.valid_referrals || 0}/3\n` +
      `• **Parrain :** ${user.referrer || 'Aucun'}\n` +
      `• **Code parrainage :** ${user.referral_code || 'Aucun'}\n` +
      `• **Wallet :** ${user.wallet || 'Non configuré'}\n` +
      `• **Conditions plan gratuit remplies :** ${user.free_plan_requirements_met ? 'Oui' : 'Non'}\n` +
      `• **Créé :** ${new Date(user.created_at).toLocaleString()}\n\n`;
    
    if (validReferrals.rows.length > 0) {
      message += `✅ **PARRAINAGES VALIDES :**\n`;
      validReferrals.rows.forEach(ref => {
        message += `• ${ref.referral_id} (${ref.referral_plan}) - ${new Date(ref.activated_at).toLocaleDateString()}\n`;
      });
      message += `\n`;
    }
    
    if (payments.rows.length > 0) {
      message += `💰 **5 DERNIERS PAIEMENTS :**\n`;
      payments.rows.forEach(p => {
        message += `• ${parseFloat(p.amount).toFixed(4)} SOL (${p.status}) - ${new Date(p.created_at).toLocaleDateString()}\n`;
      });
      message += `\n`;
    }
    
    if (withdrawals.rows.length > 0) {
      message += `📜 **5 DERNIERS RETRAITS :**\n`;
      withdrawals.rows.forEach(w => {
        message += `• #${w.id}: ${parseFloat(w.amount).toFixed(4)} SOL (${w.status}) - ${new Date(w.created_at).toLocaleDateString()}\n`;
      });
      message += `\n`;
    }
    
    if (transactions.rows.length > 0) {
      message += `📈 **5 DERNIÈRES TRANSACTIONS :**\n`;
      transactions.rows.forEach(t => {
        message += `• ${t.type}: ${parseFloat(t.amount).toFixed(4)} SOL - ${t.description}\n`;
      });
    }
    
    message += `\n🔧 **COMMANDES ADMIN :**\n`;
    message += `• \`/setbalance ${userId} 0 main\` - Réinitialiser solde principal\n`;
    message += `• \`/setbalance ${userId} 0 trading\` - Réinitialiser solde trading\n`;
    message += `• \`/setbalance ${userId} 0 referral\` - Réinitialiser solde parrainage\n`;
    message += `• \`/resetplan ${userId}\` - Réinitialiser plan\n`;
    message += `• \`/addbonus ${userId} 1 "Bonus admin"\` - Ajouter bonus\n`;
    
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('User info error:', error.message);
    await bot.sendMessage(chatId, `❌ Erreur : ${error.message}`);
  }
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const message = match[1];
  
  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, '❌ Accès refusé');
  }
  
  if (!message) {
    return bot.sendMessage(chatId, '❌ Utilisation : /broadcast votre message');
  }
  
  try {
    const users = await pool.query('SELECT user_id FROM users WHERE waitlist_access_granted = true');
    
    let sent = 0;
    let failed = 0;
    
    const broadcastMessage = `📢 **ANNONCE IMPORTANTE**\n\n` +
      `${message}\n\n` +
      `👑 **Équipe COVESTING**`;
    
    for (const user of users.rows) {
      try {
        await bot.sendMessage(user.user_id, broadcastMessage, { parse_mode: 'Markdown' });
        sent++;
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        failed++;
      }
    }
    
    await bot.sendMessage(chatId, 
      `✅ **DIFFUSION TERMINÉE**\n\n` +
      `📤 **Envoyé :** ${sent} utilisateurs\n` +
      `❌ **Échoué :** ${failed} utilisateurs\n` +
      `📊 **Total :** ${users.rows.length} utilisateurs`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Broadcast error:', error.message);
    await bot.sendMessage(chatId, `❌ Erreur diffusion : ${error.message}`);
  }
});

bot.onText(/\/pending/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, '❌ Accès refusé');
  }
  
  await adminShowPending(chatId, null);
});

bot.onText(/\/solprice/, async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    await updatePrices();
    
    const message = `📊 **SOLANA (SOL) PRIX TEMPS RÉEL**\n\n` +
      `💰 **Prix actuel :** $${SOL_PRICE.toFixed(4)}\n` +
      `💵 **Valeur USDT :** 1 USDT = $${USDT_PRICE.toFixed(4)}\n` +
      `📅 **Mis à jour :** ${new Date().toLocaleTimeString()}\n\n` +
      `📋 **CALCUL DES FRAIS :**\n` +
      `• 0.001 SOL frais = $${(0.001 * SOL_PRICE).toFixed(4)} (${convertSOLtoUSDT(0.001).toFixed(4)} USDT)\n` +
      `• 0.002 SOL frais = $${(0.002 * SOL_PRICE).toFixed(4)} (${convertSOLtoUSDT(0.002).toFixed(4)} USDT)\n` +
      `• 0.003 SOL frais = $${(0.003 * SOL_PRICE).toFixed(4)} (${convertSOLtoUSDT(0.003).toFixed(4)} USDT)\n` +
      `• 0.005 SOL frais = $${(0.005 * SOL_PRICE).toFixed(4)} (${convertSOLtoUSDT(0.005).toFixed(4)} USDT)\n\n` +
      `💱 **TAUX DE CONVERSION :**\n` +
      `• 1 SOL = $${SOL_PRICE.toFixed(4)} (${convertSOLtoUSDT(1).toFixed(4)} USDT)\n` +
      `• 0.1 SOL = $${(0.1 * SOL_PRICE).toFixed(4)} (${convertSOLtoUSDT(0.1).toFixed(4)} USDT)\n` +
      `• 0.5 SOL = $${(0.5 * SOL_PRICE).toFixed(4)} (${convertSOLtoUSDT(0.5).toFixed(4)} USDT)`;
    
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    await bot.sendMessage(chatId, `❌ Erreur mise à jour prix : ${error.message}`);
  }
});

bot.onText(/\/solana_status/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, '❌ Accès refusé');
  }
  
  try {
    if (!connection || !walletKeypair) {
      return bot.sendMessage(chatId, '❌ Solana non configuré');
    }
    
    const walletAddress = walletKeypair.publicKey;
    const solBalance = await connection.getBalance(walletAddress);
    const solBalanceSOL = solBalance / LAMPORTS_PER_SOL;
    
    const message = `📊 **STATUT COMPTE SOLANA**\n\n` +
      `📍 **Adresse :** \`${walletAddress.toString()}\`\n` +
      `💰 **Solde SOL :** ${solBalanceSOL.toFixed(4)} SOL\n` +
      `💵 **Valeur USD :** $${(solBalanceSOL * SOL_PRICE).toFixed(2)}\n` +
      `📈 **Prix SOL :** $${SOL_PRICE.toFixed(4)}\n` +
      `🏦 **Statut :** ✅ **ACTIF**`;
    
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    await bot.sendMessage(chatId, `❌ Erreur : ${error.message}`);
  }
});

bot.onText(/\/update_sol_price/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, '❌ Accès refusé');
  }
  
  try {
    const prices = await updatePrices();
    
    await bot.sendMessage(chatId, 
      `✅ **PRIX MIS À JOUR**\n\n` +
      `💰 **SOL :** $${prices.sol.toFixed(4)}\n` +
      `💵 **USDT :** $${prices.usdt.toFixed(4)}\n\n` +
      `💱 **Conversion :** 1 SOL = ${convertSOLtoUSDT(1).toFixed(4)} USDT`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Price update error:', error.message);
    await bot.sendMessage(chatId, `❌ Erreur mise à jour prix : ${error.message}`);
  }
});

// Commandes admin pour gérer les retraits
bot.onText(/\/approve (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const withdrawalId = parseInt(match[1]);
  
  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, '❌ Accès refusé');
  }
  
  try {
    await processAdminWithdrawalApproval(chatId, withdrawalId);
  } catch (error) {
    console.error('Approve error:', error.message);
    await bot.sendMessage(chatId, `❌ Erreur : ${error.message}`);
  }
});

bot.onText(/\/reject (\d+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const withdrawalId = parseInt(match[1]);
  const reason = match[2];
  
  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, '❌ Accès refusé');
  }
  
  try {
    const withdrawal = await pool.query('SELECT * FROM withdrawals WHERE id = $1', [withdrawalId]);
    
    if (withdrawal.rows.length === 0) {
      return bot.sendMessage(chatId, `❌ Retrait #${withdrawalId} non trouvé`);
    }
    
    await pool.query('UPDATE withdrawals SET status = $1, admin_notes = $2 WHERE id = $3', 
      ['rejected', reason, withdrawalId]);
    
    const user = await getOrCreateUser(withdrawal.rows[0].user_id);
    const newBalance = (parseFloat(user.main_balance) || 0) + parseFloat(withdrawal.rows[0].amount);
    
    await updateUser(withdrawal.rows[0].user_id, {
      main_balance: newBalance,
      withdrawal_status: 'none',
      withdrawal_pending: 0
    });
    
    await addTransaction(withdrawal.rows[0].user_id, 'refund', parseFloat(withdrawal.rows[0].amount), `Retrait #${withdrawalId} rejeté - Remboursé`);
    
    await bot.sendMessage(withdrawal.rows[0].user_id,
      `❌ **RETRAIT REJETÉ**\n\n` +
      `Votre retrait de ${parseFloat(withdrawal.rows[0].amount)} SOL ($${convertSOLtoUSDT(parseFloat(withdrawal.rows[0].amount)).toFixed(2)}) a été rejeté.\n` +
      `💰 **Remboursé :** ${parseFloat(withdrawal.rows[0].amount)} SOL ($${convertSOLtoUSDT(parseFloat(withdrawal.rows[0].amount)).toFixed(2)})\n` +
      `💳 **Nouveau solde principal :** ${newBalance.toFixed(4)} SOL ($${convertSOLtoUSDT(newBalance).toFixed(2)})\n\n` +
      `⚠️ **Raison :** ${reason}\n` +
      `📞 **Contactez le support pour plus d'informations.**`,
      { parse_mode: 'Markdown' }
    );
    
    await bot.sendMessage(chatId, `✅ Retrait #${withdrawalId} rejeté et utilisateur remboursé.`);
    
  } catch (error) {
    console.error('Reject error:', error.message);
    await bot.sendMessage(chatId, `❌ Erreur : ${error.message}`);
  }
});

bot.onText(/\/hold (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const withdrawalId = parseInt(match[1]);
  
  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, '❌ Accès refusé');
  }
  
  try {
    await processAdminWithdrawalHold(chatId, withdrawalId);
  } catch (error) {
    console.error('Hold error:', error.message);
    await bot.sendMessage(chatId, `❌ Erreur : ${error.message}`);
  }
});

// Commandes admin pour gérer les soldes
bot.onText(/\/setbalance (\d+) ([0-9.]+) (\w+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = parseInt(match[1]);
  const amount = parseFloat(match[2]);
  const accountType = match[3].toLowerCase();
  
  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, '❌ Accès refusé');
  }
  
  if (isNaN(amount) || amount < 0) {
    return bot.sendMessage(chatId, '❌ Montant invalide');
  }
  
  try {
    const user = await getUser(userId);
    
    if (!user) {
      return bot.sendMessage(chatId, `❌ Utilisateur ${userId} non trouvé`);
    }
    
    let updates = {};
    let description = '';
    
    switch(accountType) {
      case 'main':
        updates = { main_balance: amount };
        description = `Solde principal défini à ${amount} SOL par admin`;
        break;
      case 'trading':
        updates = { trading_balance: amount };
        description = `Solde trading défini à ${amount} SOL par admin`;
        break;
      case 'referral':
        updates = { referral_balance: amount };
        description = `Solde parrainage défini à ${amount} SOL par admin`;
        break;
      case 'all':
        updates = { 
          main_balance: amount,
          trading_balance: amount,
          referral_balance: amount
        };
        description = `Tous les soldes définis à ${amount} SOL par admin`;
        break;
      default:
        return bot.sendMessage(chatId, '❌ Type de compte invalide. Utilisez: main, trading, referral, all');
    }
    
    await updateUser(userId, updates);
    
    await addTransaction(userId, 'admin_adjustment', amount - (parseFloat(user[`${accountType}_balance`]) || 0), description);
    
    await bot.sendMessage(chatId,
      `✅ **SOLDE MODIFIÉ**\n\n` +
      `👤 **Utilisateur:** ${userId}\n` +
      `💰 **Montant:** ${amount} SOL\n` +
      `📊 **Compte:** ${accountType}\n` +
      `📝 **Description:** ${description}`,
      { parse_mode: 'Markdown' }
    );
    
    try {
      await bot.sendMessage(userId,
        `⚡ **MODIFICATION DE SOLDE**\n\n` +
        `Votre solde ${accountType} a été modifié par l'administrateur.\n` +
        `💰 **Nouveau solde :** ${amount} SOL ($${convertSOLtoUSDT(amount).toFixed(2)})\n` +
        `📝 **Raison :** ${description}`,
        { parse_mode: 'Markdown' }
      );
    } catch (notifyError) {
      console.error('Notification error:', notifyError.message);
    }
    
  } catch (error) {
    console.error('Setbalance error:', error.message);
    await bot.sendMessage(chatId, `❌ Erreur : ${error.message}`);
  }
});

bot.onText(/\/addbonus (\d+) ([0-9.]+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = parseInt(match[1]);
  const amount = parseFloat(match[2]);
  const reason = match[3];
  
  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, '❌ Accès refusé');
  }
  
  if (isNaN(amount) || amount <= 0) {
    return bot.sendMessage(chatId, '❌ Montant invalide');
  }
  
  try {
    const user = await getUser(userId);
    
    if (!user) {
      return bot.sendMessage(chatId, `❌ Utilisateur ${userId} non trouvé`);
    }
    
    const newMainBalance = (parseFloat(user.main_balance) || 0) + amount;
    
    await updateUser(userId, {
      main_balance: newMainBalance,
      deposited: (parseFloat(user.deposited) || 0) + amount
    });
    
    await addTransaction(userId, 'bonus', amount, `Bonus admin: ${reason}`);
    
    await bot.sendMessage(chatId,
      `✅ **BONUS AJOUTÉ**\n\n` +
      `👤 **Utilisateur:** ${userId}\n` +
      `💰 **Montant:** ${amount} SOL ($${convertSOLtoUSDT(amount).toFixed(2)})\n` +
      `📝 **Raison:** ${reason}\n` +
      `🏦 **Nouveau solde principal:** ${newMainBalance.toFixed(4)} SOL`,
      { parse_mode: 'Markdown' }
    );
    
    try {
      await bot.sendMessage(userId,
        `🎁 **BONUS RECU !**\n\n` +
        `Vous avez reçu un bonus de l'administrateur !\n` +
        `💰 **Montant :** ${amount} SOL ($${convertSOLtoUSDT(amount).toFixed(2)})\n` +
        `📝 **Raison :** ${reason}\n` +
        `🏦 **Nouveau solde principal :** ${newMainBalance.toFixed(4)} SOL ($${convertSOLtoUSDT(newMainBalance).toFixed(2)})`,
        { parse_mode: 'Markdown' }
      );
    } catch (notifyError) {
      console.error('Notification error:', notifyError.message);
    }
    
  } catch (error) {
    console.error('Addbonus error:', error.message);
    await bot.sendMessage(chatId, `❌ Erreur : ${error.message}`);
  }
});

bot.onText(/\/resetplan (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = parseInt(match[1]);
  
  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, '❌ Accès refusé');
  }
  
  try {
    const user = await getUser(userId);
    
    if (!user) {
      return bot.sendMessage(chatId, `❌ Utilisateur ${userId} non trouvé`);
    }
    
    await updateUser(userId, {
      plan: null,
      plans: [],
      free_plan_activated: false,
      free_plan_expiry: 0,
      free_plan_requirements_met: false,
      last_claim: 0
    });
    
    await addTransaction(userId, 'plan_reset', 0, 'Plan réinitialisé par admin');
    
    await bot.sendMessage(chatId,
      `✅ **PLAN RÉINITIALISÉ**\n\n` +
      `👤 **Utilisateur:** ${userId}\n` +
      `📋 **Ancien plan(s):** ${user.plan ? PLANS[user.plan].name : 'Aucun'}\n` +
      `🔄 **Nouveau plan:** Aucun\n` +
      `📝 **Toutes les données de plan ont été réinitialisées.**`,
      { parse_mode: 'Markdown' }
    );
    
    try {
      await bot.sendMessage(userId,
        `🔄 **PLAN RÉINITIALISÉ**\n\n` +
        `Votre plan d'investissement a été réinitialisé par l'administrateur.\n` +
        `📋 **Ancien plan :** ${user.plan ? PLANS[user.plan].name : 'Aucun'}\n` +
        `🔄 **Nouveau statut :** Aucun plan actif\n\n` +
        `💡 **Vous pouvez maintenant activer un nouveau plan.**`,
        { parse_mode: 'Markdown' }
      );
    } catch (notifyError) {
      console.error('Notification error:', notifyError.message);
    }
    
  } catch (error) {
    console.error('Resetplan error:', error.message);
    await bot.sendMessage(chatId, `❌ Erreur : ${error.message}`);
  }
});

bot.onText(/\/removeuser (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = parseInt(match[1]);
  
  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, '❌ Accès refusé');
  }
  
  try {
    const user = await getUser(userId);
    
    if (!user) {
      return bot.sendMessage(chatId, `❌ Utilisateur ${userId} non trouvé`);
    }
    
    await pool.query('DELETE FROM users WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM withdrawals WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM payments WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM referral_earnings WHERE referrer_id = $1 OR referral_id = $1', [userId]);
    await pool.query('DELETE FROM valid_referrals WHERE referrer_id = $1 OR referral_id = $1', [userId]);
    
    await bot.sendMessage(chatId,
      `✅ **UTILISATEUR SUPPRIMÉ**\n\n` +
      `👤 **Utilisateur:** ${userId}\n` +
      `📋 **Nom:** ${user.username || 'N/A'}\n` +
      `📊 **Plan(s):** ${user.plan || 'Aucun'}\n` +
      `💰 **Solde:** ${getTotalBalance(user).toFixed(4)} SOL\n\n` +
      `⚠️ **Toutes les données ont été supprimées.**`,
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    console.error('Removeuser error:', error.message);
    await bot.sendMessage(chatId, `❌ Erreur : ${error.message}`);
  }
});

bot.onText(/\/listusers(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const page = parseInt(match[1]) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  
  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, '❌ Accès refusé');
  }
  
  try {
    const users = await pool.query(
      `SELECT user_id, username, plan, plans, main_balance, trading_balance, referral_balance, referrals, created_at FROM users ORDER BY user_id DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    
    const totalUsersResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const totalUsers = parseInt(totalUsersResult.rows[0].count) || 0;
    const totalPages = Math.ceil(totalUsers / limit);
    
    let message = `👥 **LISTE DES UTILISATEURS**\n\n`;
    message += `📊 **Page ${page}/${totalPages} (${totalUsers} utilisateurs)**\n\n`;
    
    if (users.rows.length === 0) {
      message += `Aucun utilisateur trouvé.`;
    } else {
      users.rows.forEach((user, index) => {
        const totalBalance = getTotalBalance(user);
        const activePlans = getActivePlans(user);
        const num = offset + index + 1;
        message += `${num}. **ID:** ${user.user_id}\n`;
        message += `   👤 ${user.username || 'Anonyme'}\n`;
        message += `   🎯 ${activePlans.length > 0 ? activePlans.map(p => PLANS[p].name).join(', ') : (user.plan ? PLANS[user.plan].name : 'Aucun')}\n`;
        message += `   💰 ${totalBalance.toFixed(4)} SOL\n`;
        message += `   📊 ${user.referrals || 0} parrainages\n`;
        message += `   📅 ${new Date(user.created_at).toLocaleDateString()}\n`;
        message += `   ⚡ \`/user ${user.user_id}\`\n`;
        message += `─────────────────────\n`;
      });
    }
    
    const buttons = [];
    
    if (page > 1) {
      buttons.push({ text: '◀️ Page précédente', callback_data: `admin_listusers_${page - 1}` });
    }
    
    if (page < totalPages) {
      buttons.push({ text: 'Page suivante ▶️', callback_data: `admin_listusers_${page + 1}` });
    }
    
    const inlineKeyboard = buttons.length > 0 ? [buttons] : [];
    inlineKeyboard.push([{ text: '◀️ RETOUR ADMIN', callback_data: 'admin_panel' }]);
    
    await bot.sendMessage(chatId, message, {
      reply_markup: { inline_keyboard: inlineKeyboard },
      parse_mode: 'Markdown'
    });
    
  } catch (error) {
    console.error('Listusers error:', error.message);
    await bot.sendMessage(chatId, `❌ Erreur : ${error.message}`);
  }
});

// Gestion du callback pour la pagination
bot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const data = callbackQuery.data;
  
  if (data.startsWith('admin_listusers_')) {
    const page = parseInt(data.replace('admin_listusers_', ''));
    await bot.deleteMessage(chatId, msg.message_id);
    await bot.sendMessage(chatId, `/listusers ${page}`, { parse_mode: 'Markdown' });
  }
});

bot.onText(/\/searchuser (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1];
  
  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, '❌ Accès refusé');
  }
  
  try {
    const users = await pool.query(
      `SELECT user_id, username, plan, plans, main_balance, trading_balance, referral_balance, referrals, wallet, created_at FROM users WHERE user_id = $1 OR username LIKE $2 OR wallet LIKE $3 ORDER BY user_id DESC LIMIT 10`,
      [parseInt(query) || 0, `%${query}%`, `%${query}%`]
    );
    
    let message = `🔍 **RÉSULTATS DE RECHERCHE : "${query}"**\n\n`;
    
    if (users.rows.length === 0) {
      message += `Aucun utilisateur trouvé.`;
    } else {
      message += `📊 **${users.rows.length} résultat(s) trouvé(s)**\n\n`;
      
      users.rows.forEach((user, index) => {
        const totalBalance = getTotalBalance(user);
        const activePlans = getActivePlans(user);
        message += `${index + 1}. **ID:** ${user.user_id}\n`;
        message += `   👤 ${user.username || 'Anonyme'}\n`;
        message += `   🎯 ${activePlans.length > 0 ? activePlans.map(p => PLANS[p].name).join(', ') : (user.plan ? PLANS[user.plan].name : 'Aucun')}\n`;
        message += `   💰 ${totalBalance.toFixed(4)} SOL\n`;
        message += `   📊 ${user.referrals || 0} parrainages\n`;
        message += `   🏦 ${user.wallet ? user.wallet.substring(0, 20) + '...' : 'Non configuré'}\n`;
        message += `   📅 ${new Date(user.created_at).toLocaleDateString()}\n`;
        message += `   ⚡ \`/user ${user.user_id}\`\n`;
        message += `─────────────────────\n`;
      });
    }
    
    const buttons = [[{ text: '◀️ RETOUR ADMIN', callback_data: 'admin_panel' }]];
    
    await bot.sendMessage(chatId, message, {
      reply_markup: { inline_keyboard: buttons },
      parse_mode: 'Markdown'
    });
    
  } catch (error) {
    console.error('Searchuser error:', error.message);
    await bot.sendMessage(chatId, `❌ Erreur : ${error.message}`);
  }
});

async function exportData(chatId) {
  try {
    if (chatId !== ADMIN_ID) {
      return bot.sendMessage(chatId, '❌ Accès refusé');
    }
    
    await bot.sendMessage(chatId, '📊 **EXPORTATION DES DONNÉES**\n\nL\'exportation est en cours... Cela peut prendre quelques secondes.', { parse_mode: 'Markdown' });
    
    const users = await pool.query('SELECT * FROM users ORDER BY user_id');
    const withdrawals = await pool.query('SELECT * FROM withdrawals ORDER BY id');
    const transactions = await pool.query('SELECT * FROM transactions ORDER BY id');
    const payments = await pool.query('SELECT * FROM payments ORDER BY id');
    
    const summary = `📊 **RÉSUMÉ DES DONNÉES EXPORTÉES**\n\n` +
      `👥 **Utilisateurs :** ${users.rows.length}\n` +
      `🏦 **Retraits :** ${withdrawals.rows.length}\n` +
      `📈 **Transactions :** ${transactions.rows.length}\n` +
      `💳 **Paiements :** ${payments.rows.length}\n` +
      `💰 **Total déposé :** ${users.rows.reduce((sum, u) => sum + (parseFloat(u.deposited) || 0), 0).toFixed(4)} SOL\n` +
      `💸 **Total retiré :** ${withdrawals.rows.filter(w => w.status === 'approved').reduce((sum, w) => sum + (parseFloat(w.amount) || 0), 0).toFixed(4)} SOL\n` +
      `📅 **Date d'export :** ${new Date().toLocaleString()}`;
    
    await bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
    
    const sampleUsers = users.rows.slice(0, 5);
    let sampleMessage = `👥 **ÉCHANTILLON UTILISATEURS (5/${users.rows.length})**\n\n`;
    
    sampleUsers.forEach(user => {
      const activePlans = getActivePlans(user);
      sampleMessage += `ID: ${user.user_id} | ${user.username || 'Anonyme'} | Plans: ${activePlans.length > 0 ? activePlans.map(p => PLANS[p].name).join(', ') : (user.plan ? PLANS[user.plan].name : 'Aucun')} | Solde: ${getTotalBalance(user).toFixed(4)} SOL\n`;
    });
    
    await bot.sendMessage(chatId, sampleMessage, { parse_mode: 'Markdown' });
    
    await bot.sendMessage(chatId,
      `💾 **DONNÉES COMPLÈTES**\n\n` +
      `Les données complètes sont stockées dans la base de données PostgreSQL.\n` +
      `📁 **Base de données :** ${process.env.DATABASE_URL ? 'Connectée' : 'Non connectée'}\n\n` +
      `🔧 **Pour accéder aux données :**\n` +
      `1. Connectez-vous au serveur PostgreSQL\n` +
      `2. Utilisez pgAdmin ou psql\n` +
      `3. Explorez les tables\n\n` +
      `📊 **Tables disponibles :**\n` +
      `• users - Tous les utilisateurs\n` +
      `• withdrawals - Tous les retraits\n` +
      `• transactions - Toutes les transactions\n` +
      `• payments - Tous les paiements\n` +
      `• referral_earnings - Tous les gains de parrainage\n` +
      `• valid_referrals - Tous les parrainages valides`,
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    console.error('Export data error:', error.message);
    await bot.sendMessage(chatId, `❌ Erreur lors de l'exportation : ${error.message}`);
  }
}

// Webhook NowPayments
app.post('/nowpayments-webhook', express.json(), async (req, res) => {
  try {
    console.log('📨 Webhook NowPayments reçu:', JSON.stringify(req.body, null, 2));
    
    const payment = req.body;
    const { invoice_id, payment_status, pay_amount, order_id } = payment;
    
    if (!invoice_id || !payment_status) {
      console.log('❌ Webhook invalide - champs manquants');
      return res.status(400).json({ error: 'Champs manquants' });
    }
    
    const paymentRecord = await pool.query('SELECT * FROM payments WHERE invoice_id = $1 OR order_id = $2', 
      [invoice_id, order_id]);
    
    if (paymentRecord.rows.length === 0) {
      console.log(`❌ Paiement non trouvé pour invoice_id: ${invoice_id}`);
      return res.status(404).json({ error: 'Paiement non trouvé' });
    }
    
    const paymentData = paymentRecord.rows[0];
    
    if (paymentData.status === 'confirmed' || paymentData.status === 'finished') {
      console.log(`ℹ️ Paiement ${paymentData.id} déjà traité (statut: ${paymentData.status})`);
      return res.status(200).json({ status: 'already_processed' });
    }
    
    if (payment_status === 'confirmed' || payment_status === 'finished') {
      console.log(`✅ Paiement ${paymentData.id} confirmé, activation du plan...`);
      
      await pool.query('UPDATE payments SET status = $1 WHERE id = $2', ['confirmed', paymentData.id]);
      
      const user = await getUser(paymentData.user_id);
      if (!user) {
        console.error(`❌ Utilisateur ${paymentData.user_id} non trouvé`);
        return res.status(404).json({ error: 'Utilisateur non trouvé' });
      }
      
      const amountSOL = parseFloat(paymentData.amount);
      const planKey = paymentData.plan;
      const plan = PLANS[planKey];
      
      // Mettre à jour les plans de l'utilisateur
      const currentPlans = user.plans || [];
      if (!currentPlans.includes(planKey)) {
        currentPlans.push(planKey);
      }
      
      // Si l'utilisateur a le plan gratuit, le désactiver
      if (user.plan === 'free') {
        await updateUser(paymentData.user_id, {
          free_plan_activated: false,
          free_plan_expiry: 0,
          free_plan_requirements_met: false
        });
      }
      
      await updateUser(paymentData.user_id, {
        plans: currentPlans,
        plan: planKey, // Garder le plan principal
        deposited: (parseFloat(user.deposited) || 0) + amountSOL,
        total_deposited_usdt: (parseFloat(user.total_deposited_usdt) || 0) + parseFloat(paymentData.amount_usdt || 0),
        last_claim: 0
      });
      
      await addTransaction(
        paymentData.user_id, 
        'plan_activation', 
        amountSOL, 
        `Achat plan ${plan.name} - Invoice: ${invoice_id}`
      );
      
      console.log(`✅ Plan ${plan.name} activé pour utilisateur ${paymentData.user_id}`);
      
// Version HTML (alternative)
try {
  const htmlMessage = `✅ <b>PLAN ACTIVÉ AVEC SUCCÈS !</b>\n\n` +
    `Votre achat a été confirmé et votre plan est maintenant actif.\n` +
    `🎯 <b>Plan :</b> ${plan.name}\n` +
    `💰 <b>Investissement :</b> ${amountSOL.toFixed(4)} SOL\n` +
    `📈 <b>Gains quotidiens :</b> ${plan.daily} SOL ($${convertSOLtoUSDT(plan.daily).toFixed(2)})\n` +
    `⏰ <b>Durée :</b> ${plan.duration}\n\n` +
    `🤖 <b>Vous pouvez maintenant :</b>\n` +
    `• Commencer à trader depuis le menu Trading\n` +
    `• Générer des profits quotidiens\n` +
    `• Retirer vos gains quand vous voulez !\n\n` +
    `📋 <b>Invoice ID :</b> <code>${invoice_id}</code>\n\n` +
    `💎 <b>Ce plan s'ajoute à vos plans existants !</b>`;
  
  await bot.sendMessage(
    paymentData.user_id,
    htmlMessage,
    { 
      parse_mode: 'HTML',
      disable_web_page_preview: true 
    }
  );
} catch (error) {
  console.error('❌ Erreur notification utilisateur:', error.message);
}

// Notification admin en HTML
const adminHtmlMessage = `💰 <b>PLAN ACTIVÉ</b>\n\n` +
  `👤 <b>Utilisateur :</b> ${paymentData.user_id}\n` +
  `🎯 <b>Plan :</b> ${plan.name}\n` +
  `💵 <b>Montant :</b> ${amountSOL.toFixed(4)} SOL ($${(amountSOL * SOL_PRICE).toFixed(2)})\n` +
  `📋 <b>Invoice ID :</b> <code>${invoice_id}</code>\n` +
  `⏰ <b>Date :</b> ${new Date().toLocaleString()}`;

// Vous devez aussi modifier notifyAdmin() pour accepter HTML
await bot.sendMessage(
  ADMIN_ID,
  adminHtmlMessage,
  { 
    parse_mode: 'HTML',
    disable_web_page_preview: true 
  }
);
      if (user.referrer) {
        const bonus = amountSOL * 0.10;
        console.log(`🎁 Bonus parrainage de ${bonus.toFixed(4)} SOL pour le parrain ${user.referrer}`);
        
await updateUser(user.referrer, {
  referral_balance: (parseFloat((await getUser(user.referrer)).referral_balance) || 0) + bonus
});
        
        await pool.query(`INSERT INTO referral_earnings (referrer_id, referral_id, level, amount, amount_usdt, description) VALUES ($1, $2, $3, $4, $5, $6)`,
          [user.referrer, paymentData.user_id, 1, bonus, convertSOLtoUSDT(bonus), `Bonus parrainage - Achat plan ${plan.name} de ${amountSOL} SOL`]);
        
        await markReferralAsValid(user.referrer, paymentData.user_id, planKey);
        
        try {
          await bot.sendMessage(user.referrer, 
            `💰 **BONUS DE PARRAINAGE !**\n\n` +
            `Votre filleul (ID: ${paymentData.user_id}) a acheté le plan ${plan.name}.\n` +
            `🎁 **Bonus reçu :** ${bonus.toFixed(4)} SOL ($${convertSOLtoUSDT(bonus).toFixed(2)})\n` +
            `🏦 **Nouveau solde parrainage :** ${((await getUser(user.referrer)).referral_balance || 0).toFixed(4)} SOL`,
            { parse_mode: 'Markdown' }
          );
        } catch (refError) {
          console.error('❌ Erreur notification parrain:', refError.message);
        }
      }
      
    } else if (payment_status === 'failed' || payment_status === 'expired') {
      console.log(`❌ Paiement ${paymentData.id} échoué : ${payment_status}`);
      await pool.query('UPDATE payments SET status = $1 WHERE id = $2', [payment_status, paymentData.id]);
    } else {
      console.log(`ℹ️ Paiement ${paymentData.id} statut intermédiaire : ${payment_status}`);
      await pool.query('UPDATE payments SET status = $1 WHERE id = $2', [payment_status, paymentData.id]);
    }
    
    res.status(200).json({ 
      status: 'ok', 
      message: 'Webhook traité avec succès',
      payment_id: paymentData.id,
      user_id: paymentData.user_id,
      plan: paymentData.plan,
      new_status: payment_status
    });
    
  } catch (error) {
    console.error('❌ Erreur webhook NowPayments:', error.message, error.stack);
    res.status(500).json({ 
      error: 'Erreur interne',
      message: error.message 
    });
  }
});

// Route pour maintenir l'instance active
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'COVESTING Trading Bot', 
    version: '3.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Lancement du bot
const PORT = process.env.PORT || 8000;
app.listen(PORT, async () => {
  console.log(`🚀 **COVESTING TRADING BOT LANCÉ**`);
  console.log(`✅ Port : ${PORT}`);
  console.log(`✅ PostgreSQL : ✅ Connecté`);
  console.log(`✅ Token : ${process.env.TELEGRAM_TOKEN ? 'Configuré' : '❌ Manquant'}`);
  console.log(`✅ Admin : ${ADMIN_ID || '❌ Non configuré'}`);
  console.log(`✅ NowPayments : ${NOWPAYMENTS_API_KEY ? '✅ Configuré' : '❌ Non configuré'}`);
  console.log(`✅ Webhook : ${WEBHOOK_DOMAIN ? '✅ Configuré' : '❌ Non configuré'}`);
  console.log(`✅ Solana : ${connection ? '✅ Configuré' : '❌ Non configuré'}`);
  console.log(`✅ Système d'achat direct : ✅ Activé`);
  console.log(`✅ Plans : ${Object.keys(PLANS).length} disponibles`);
  console.log(`✅ Retraits : ${WITHDRAWALS_ENABLED ? '✅ Activés' : '❌ Désactivés'}`);
  console.log(`✅ Support : @${SUPPORT_USERNAME}`);
  console.log(`✅ Communauté : ${COMMUNITY_LINK}`);
  console.log(`✅ Mises à jour prix : ✅ Activées (SOL/USDT)`);
  console.log(`✅ Dépôts minimum : $${MIN_DEPOSIT_USD} USD`);
  console.log(`✅ Parrainages requis : 3 (au lieu de 5)`);
  console.log(`✅ Plans multiples : ✅ Activé`);
  console.log(`✅ Notifications : ✅ Activées`);
  
  await updatePrices();
  
  // Démarrer le planificateur de notifications
  startNotificationScheduler();
  
  console.log(`🤖 **Prêt à générer des profits avec COVESTING !**`);
  
  setInterval(() => {
    axios.get(`http://localhost:${PORT || 8000}/health`).catch(() => {});
  }, 4 * 60 * 1000);
});

bot.getMe().then((me) => {
  console.log(`✅ Bot connecté : @${me.username} (${me.id})`);
}).catch((error) => {
  console.error('❌ Erreur connexion Telegram :', error.message);
});
