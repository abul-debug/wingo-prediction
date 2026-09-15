const axios = require('axios');
const admin = require('firebase-admin');

// Firebase Admin Initialization (Via Environment Variables)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: "hacker-13fe6",
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
    }),
    databaseURL: "https://hacker-13fe6-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();
const resultsRef = db.ref('daily_results');
const GAME_API_URL = "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json";

// Live Fetcher Function
async function syncLatestResult() {
  try {
    const timestamp = Date.now();
    const response = await axios.get(`${GAME_API_URL}?ts=${timestamp}`, { timeout: 4000 });
    const list = response.data?.data?.list || response.data?.list;

    if (list && list.length > 0) {
      // Top 5 entries sync karo taaki koi missing gap na rahe
      for (let i = 0; i < Math.min(list.length, 5); i++) {
        const item = list[i];
        const issueNumber = String(item.issueNumber || item.period);
        const number = parseInt(item.number || item.result);

        const periodRef = resultsRef.child(issueNumber);
        const snapshot = await periodRef.once('value');
        if (!snapshot.exists()) {
          await periodRef.set({
            period: issueNumber,
            result: number,
            timestamp: timestamp - (i * 1000)
          });
        }
      }
    }
  } catch (err) {
    console.error("Game Sync Warning:", err.message);
  }
}

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 1. Midnight Reset Trigger (Auto Called by Vercel Cron at 12:00 AM)
    if (req.query.action === 'reset') {
      await resultsRef.remove();
      return res.status(200).json({ status: "success", message: "Midnight DB Cleanup Complete!" });
    }

    // 2. Fetch Latest Results Before Calculation
    await syncLatestResult();

    // 3. Load All Stored Results from Firebase
    const snapshot = await resultsRef.orderByChild('timestamp').once('value');
    const data = snapshot.val();

    if (!data) {
      return res.status(400).json({ status: "error", message: "No data stored today yet." });
    }

    const sortedList = Object.values(data).sort((a, b) => a.timestamp - b.timestamp);
    const history = sortedList.map(item => item.result);

    if (history.length < 2) {
      return res.status(400).json({ status: "error", message: "Waiting for at least 2 period results..." });
    }

    const latestResult = history[history.length - 1];
    const latestPeriod = sortedList[sortedList.length - 1].period;
    const nextNumbers = [];

    // Pattern Analysis
    for (let i = 0; i < history.length - 1; i++) {
      if (history[i] === latestResult) {
        nextNumbers.push(history[i + 1]);
      }
    }

    if (nextNumbers.length === 0) {
      return res.json({
        latest_period: latestPeriod,
        latest_result: latestResult,
        prediction: "WAIT",
        message: "First occurrence of this result today."
      });
    }

    let bigCount = 0;
    let smallCount = 0;
    const freqMap = {};

    nextNumbers.forEach(num => {
      freqMap[num] = (freqMap[num] || 0) + 1;
      if (num >= 5) bigCount++;
      else smallCount++;
    });

    const sortedFreq = Object.entries(freqMap).sort((a, b) => b[1] - a[1]);
    const top2Numbers = sortedFreq.slice(0, 2).map(item => parseInt(item[0]));

    let bsPrediction = "BIG";
    if (smallCount > bigCount) bsPrediction = "SMALL";
    else if (smallCount === bigCount) bsPrediction = "TIE";

    // Direct Single Prediction Engine JSON Output
    return res.status(200).json({
      period: latestPeriod,
      latest_result: latestResult,
      prediction: {
        big_small: bsPrediction,
        numbers: top2Numbers
      },
      analytics: {
        matches: nextNumbers.length,
        big_vs_small: { big: bigCount, small: smallCount },
        frequencies: freqMap
      }
    });

  } catch (error) {
    return res.status(500).json({ status: "error", message: error.message });
  }
};
