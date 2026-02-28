const express = require("express");
const fs = require("fs");
const path = require("path");

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

// Create storage directory if not exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR);
}

// -------- STORE CHUNK --------
app.post("/store", async (req, res) => {
  try {
    const { chunkId, data } = req.body;

    if (!chunkId || !data) {
      return res.status(400).json({ error: "chunkId and data required" });
    }

    const filePath = path.join(STORAGE_DIR, chunkId);

    fs.writeFileSync(filePath, data, "base64");

    console.log(`[${NODE_ID}] Stored chunk ${chunkId}`);

    return res.json({
      status: "stored",
      node: NODE_ID,
      chunkId,
    });
  } catch (err) {
    console.error(`[${NODE_ID}] Store failed`, err.message);
    return res.status(500).json({ error: "Store failed" });
  }
});

// -------- GET CHUNK --------
app.get("/chunk/:chunkId", (req, res) => {
  try {
    const { chunkId } = req.params;
    const filePath = path.join(STORAGE_DIR, chunkId);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Chunk not found" });
    }

    const data = fs.readFileSync(filePath, "base64");

    return res.json({ chunkId, data });
  } catch (err) {
    console.error(`[${NODE_ID}] Fetch failed`, err.message);
    return res.status(500).json({ error: "Fetch failed" });
  }
});

// -------- DELETE CHUNK --------
app.delete("/chunk/:chunkId", (req, res) => {
  try {
    const { chunkId } = req.params;
    const filePath = path.join(STORAGE_DIR, chunkId);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    console.log(`[${NODE_ID}] Deleted chunk ${chunkId}`);

    return res.json({ status: "deleted" });
  } catch (err) {
    console.error(`[${NODE_ID}] Delete failed`, err.message);
    return res.status(500).json({ error: "Delete failed" });
  }
});

// -------- HEALTH --------
app.get("/health", (req, res) => {
  return res.json({
    node: NODE_ID,
    status: "ACTIVE",
    uptime: process.uptime(),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Storage Node ${NODE_ID} running on port ${PORT}`);
});