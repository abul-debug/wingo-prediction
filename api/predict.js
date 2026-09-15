const axios = require('axios');
const admin = require('firebase-admin');

// 1. Safe Firebase Initialization
if (!admin.apps.length) {
  try {
    const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY || "";
    // Newline escape character handling for Vercel
    const formattedPrivateKey = rawPrivateKey.replace(/\\n/g, '\n');

    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: "hacker-13fe6",
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: formattedPrivateKey
      }),
      databaseURL: "https://hacker-13fe6-default-rtdb.firebaseio.com"
    });
  } catch (err) {
    console.error("Firebase Init Error:", err.message);
  }
}

const db = admin.database();
const resultsRef = db.ref('daily_results');
const GAME_API_URL = "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json";

// 2. Fetch Latest Results
async function syncLatestResult() {
  try {
    const timestamp = Date.now();
    const response = await axios.get(`${GAME_API_URL}?ts=${timestamp}`, { timeout: 5000 });
    const list = response.data?.data?.list || response.data?.list;

    if (list && Array.isArray(list) && list.length > 0) {
      for (let i = 0; i < Math.min(list.length, 10); i++) {
        const item = list[i];
        const issueNumber = String(item.issueNumber || item.period);
        const number = parseInt(item.number || item.result);

        if (issueNumber && !isNaN(number)) {
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
    }
  } catch (err) {
    console.error("Game Sync Warning:", err.message);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Reset Action
    if (req.query.action === 'reset') {
      await resultsRef.remove();
      return res.status(200).json({ status: "success", message: "Database Cleared" });
    }

    // Auto Sync
    await syncLatestResult();

    // Fetch Firebase Data
    const snapshot = await resultsRef.orderByChild('timestamp').once('value');
    const data = snapshot.val();

    if (!data) {
      return res.status(200).json({ status: "pending", message: "Fetching first batch of results. Refresh in 5 seconds." });
    }

    const sortedList = Object.values(data).sort((a, b) => a.timestamp - b.timestamp);
    const history = sortedList.map(item => item.result);

    if (history.length < 2) {
      return res.status(200).json({ status: "pending", message: "Need at least 2 results to predict. Refreshing..." });
    }

    const latestResult = history[history.length - 1];
    const latestPeriod = sortedList[sortedList.length - 1].period;
    const nextNumbers = [];

    for (let i = 0; i < history.length - 1; i++) {
      if (history[i] === latestResult) {
        nextNumbers.push(history[i + 1]);
      }
    }

    if (nextNumbers.length === 0) {
      return res.status(200).json({
        period: latestPeriod,
        latest_result: latestResult,
        prediction: { big_small: "WAIT", numbers: [] },
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
    return res.status(500).json({ status: "error", error_details: error.message });
  }
};
