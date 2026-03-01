const express = require("express");
const fs = require("fs");
const path = require("path");
const { createClient } = require("redis");

const app = express();
app.use(express.json({ limit: "50mb" }));

// -------- CONFIG --------
const PORT = process.argv[2];
if (!PORT) {
  console.error("❌ Please provide port number");
  process.exit(1);
}

const NODE_ID = `node-${PORT}`;
const STORAGE_DIR = path.join(__dirname, `storage-${PORT}`);

// Create storage directory
fs.mkdirSync(STORAGE_DIR, { recursive: true });

// -------- REDIS --------
const redis = createClient({
  url: process.env.REDIS_URL || "redis://127.0.0.1:6379",
});
redis.connect().catch(console.error);

// -------- BLACKOUT SIMULATION --------
// -------- BLACKOUT SIMULATION (PHASE SHIFTED) --------
let isInBlackout = false;

const BLACKOUT_INTERVAL = 30000; // every 30 sec
const BLACKOUT_DURATION = 6000;  // 6 sec blackout

// Phase offset based on port
const phaseOffset = (Number(PORT) % 3) * 10000;

let nextBlackoutTime = Date.now() + phaseOffset;

function scheduleBlackout() {
  const delay = nextBlackoutTime - Date.now();

  setTimeout(() => {
    isInBlackout = true;
    console.log(`🌑 ${NODE_ID} entering blackout`);

    setTimeout(() => {
      isInBlackout = false;
      console.log(`🌕 ${NODE_ID} signal restored`);

      nextBlackoutTime = Date.now() + BLACKOUT_INTERVAL;
      scheduleBlackout();

    }, BLACKOUT_DURATION);

  }, delay);
}

scheduleBlackout();

// -------- STORE CHUNK --------
app.post("/store", (req, res) => {
  if (isInBlackout) {
    return res.status(503).json({ error: "Satellite in blackout" });
  }

  const { chunkId, data } = req.body;
  if (!chunkId || !data) {
    return res.status(400).json({ error: "chunkId and data required" });
  }

  const filePath = path.join(STORAGE_DIR, chunkId);
  fs.writeFileSync(filePath, data, "base64");

  console.log(`[${NODE_ID}] Stored chunk ${chunkId}`);

  res.json({ status: "stored", node: NODE_ID });
});

// -------- GET CHUNK --------
app.get("/chunk/:chunkId", (req, res) => {
  if (isInBlackout) {
    return res.status(503).json({ error: "Satellite in blackout" });
  }

  const filePath = path.join(STORAGE_DIR, req.params.chunkId);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Chunk not found" });
  }

  const data = fs.readFileSync(filePath, "base64");
  res.json({ chunkId: req.params.chunkId, data });
});

// -------- ORBITAL STATUS --------
app.get("/orbital-status", (req, res) => {
  res.json({
    nodeId: NODE_ID,
    isInBlackout,
    nextBlackoutInMs: Math.max(0, nextBlackoutTime - Date.now())
  });
});

// -------- HEALTH --------
app.get("/health", (req, res) => {
  res.json({
    node: NODE_ID,
    status: "ACTIVE",
    blackout: isInBlackout
  });
});

// -------- HEARTBEAT --------
setInterval(async () => {
  try {
    await redis.set(`node:${NODE_ID}`, Date.now());
  } catch (err) {
    console.error("Heartbeat failed:", err.message);
  }
}, 3000);

app.get("/orbital-status", (req, res) => {
  res.json({
    nodeId: NODE_ID,
    isInBlackout,
    nextBlackoutInMs: nextBlackoutTime - Date.now()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Storage Node ${NODE_ID} running on port ${PORT}`);
});