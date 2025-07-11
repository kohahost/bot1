const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config();

let proxies = [];
let proxyIndex = 0;

// Load proxies from txt file
function loadProxiesFromFile(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    proxies = data
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    console.log(`✅ Loaded ${proxies.length} proxies`);
  } catch (err) {
    console.error('❌ Failed to load proxies.txt:', err.message);
  }
}

function getNextProxyAgent() {
  if (proxies.length === 0) return null;
  const proxy = proxies[proxyIndex % proxies.length];
  proxyIndex++;
  // console.log('Using proxy:', proxy);
  return new HttpsProxyAgent(proxy);
}

async function getPiWalletAddressFromSeed(mnemonic) {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error("Invalid mnemonic");
  }
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const derivationPath = "m/44'/314159'/0'";
  const { key } = ed25519.derivePath(derivationPath, seed.toString('hex'));
  const keypair = StellarSdk.Keypair.fromRawEd25519Seed(key);
  const publicKey = keypair.publicKey();
  const secretKey = keypair.secret();
  console.log("🚀 Public Key (Sender Pi Wallet Address):", publicKey);
  return { publicKey, secretKey };
}

async function sendPi() {
  const server = new StellarSdk.Server('https://api.mainnet.minepi.com');
  const mnemonic = process.env.MNEMONIC;
  const recipient = process.env.RECEIVER_ADDRESS;
  const wallet = await getPiWalletAddressFromSeed(mnemonic);
  const senderSecret = wallet.secretKey;
  const senderKeypair = StellarSdk.Keypair.fromSecret(senderSecret);
  const senderPublic = wallet.publicKey;
  const apiUrl = `https://api.mainnet.minepi.com/accounts/${senderPublic}`;

  // Ambil proxy agent sekarang
  let agent = getNextProxyAgent();

  try {
    // Load account dari Stellar
    const account = await server.loadAccount(senderPublic);

    // Ambil base fee dan kalkulasi fee
    const baseFee = await server.fetchBaseFee();
    const fee = (baseFee * 2).toString();

    // Ambil balance via axios dengan proxy
    const res = await axios.get(apiUrl, {
      httpsAgent: agent,
      proxy: false, // must disable axios proxy option if use httpsAgent
      timeout: 10000,
    });

    const balances = res.data.balances || [];
    const nativeBalanceObj = balances.find(b => b.asset_type === 'native');
    const balance = nativeBalanceObj ? Number(nativeBalanceObj.balance) : 0;
    console.log(`Pi Balance: ${balance}`);

    // Hitung jumlah kirim = saldo dikurangi 2 Pi untuk fee dan safety buffer
    const withdrawAmount = balance - 2;
    if (withdrawAmount <= 0) {
      console.log("⚠️ Not enough Pi to send. Skipping...");
      console.log('-------------------------------------------------------------------------------------');
    } else {
      const formattedAmount = withdrawAmount.toFixed(7);
      console.log(`➡️ Sending: ${formattedAmount} Pi`);

      const tx = new StellarSdk.TransactionBuilder(account, {
        fee,
        networkPassphrase: 'Pi Network',
      })
        .addOperation(StellarSdk.Operation.payment({
          destination: recipient,
          asset: StellarSdk.Asset.native(),
          amount: formattedAmount,
        }))
        .setTimeout(30)
        .build();

      tx.sign(senderKeypair);

      const result = await server.submitTransaction(tx);

      if (result && result.hash) {
        console.log("✅ Tx Hash:", result.hash);
        console.log(`🔗 View Tx: https://api.mainnet.minepi.com/transactions/${result.hash}`);
        console.log('-------------------------------------------------------------------------------------');
      } else {
        console.log("⚠️ Transaction submitted but not confirmed successful:", result);
        console.log('-------------------------------------------------------------------------------------');
      }
    }
  } catch (e) {
    const errorMsg = e.response?.data?.extras?.result_codes || e.message || e;
    console.error('❌ Error:', errorMsg);
    if (
      e.response?.status === 429 || // Too Many Requests
      (typeof errorMsg === 'string' && errorMsg.toLowerCase().includes('too many requests'))
    ) {
      console.log('🚨 Detected 429 Too Many Requests. Switching proxy...');
      agent = getNextProxyAgent(); // switch proxy on next request
    }
    console.log('-------------------------------------------------------------------------------------');
  } finally {
    setTimeout(sendPi, ); // jalankan ulang tiap 1 ms
  }
}

// Load proxies dan start bot
loadProxiesFromFile('./proxies.txt');
sendPi();
