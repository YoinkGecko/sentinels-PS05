const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const redis = require("./redisClient");
const { startElection, amILeader } = require("./leader");
const multer = require("multer");
const { LRUCache } = require("lru-cache");

const app = express();
app.use(express.json({ limit: "200mb" }));

const upload = multer({ storage: multer.memoryStorage() });

const fileCache = new LRUCache({
  max: 5,
  maxSize: 200 * 1024 * 1024,
  sizeCalculation: (value) => value.buffer.length,
});

const PORT = process.argv[2];
if (!PORT) {
  console.error("Provide port");
  process.exit(1);
}

const MASTER_ID = `master-${PORT}`;
startElection(MASTER_ID);

// ---------------- STORAGE NODES ----------------
const NODES = [
  "http://localhost:4001",
  "http://localhost:4002",
  "http://localhost:4003",
];

let roundRobinIndex = 0;

// ---------------- ALIVE NODE CHECK ----------------
async function getAliveNodes() {
  const now = Date.now();
  const aliveNodes = [];

  for (const nodeUrl of NODES) {
    const nodeId = `node-${nodeUrl.split(":").pop()}`;
    const lastSeen = await redis.get(`node:${nodeId}`);
    if (!lastSeen) continue;

    if (now - Number(lastSeen) < 6000) {
      aliveNodes.push(nodeUrl);
    }
  }

  return aliveNodes;
}

// ---------------- SAFE RECONSTRUCTION ----------------
async function reconstructFile(metadata, avoidNode = null) {
  const buffers = [];

  for (const chunk of metadata.chunks) {
    let chunkBuffer = null;

    for (const node of chunk.nodes) {
      if (avoidNode && node === avoidNode) continue;

      try {
        const response = await axios.get(
          `${node}/chunk/${chunk.chunkId}`,
          { timeout: 2000 }
        );

        chunkBuffer = Buffer.from(response.data.data, "base64");
        break;
      } catch (_) {}
    }

    if (!chunkBuffer) {
      throw new Error("Reconstruction failed");
    }

    buffers.push(chunkBuffer);
  }

  return Buffer.concat(buffers);
}

// ---------------- PRE-CACHE ----------------
async function preCacheFilesFromNode(nodeUrl) {
  const keys = await redis.keys("file:*");

  for (const key of keys) {
    const data = await redis.get(key);
    if (!data) continue;

    const metadata = JSON.parse(data);
    const fileId = metadata.fileId;

    if (fileCache.has(fileId)) continue;

    const affected = metadata.chunks.some(chunk =>
      chunk.nodes.includes(nodeUrl)
    );

    if (!affected) continue;

    console.log(`   📦 Pre-caching file ${fileId}`);

    try {
      const buffer = await reconstructFile(metadata, nodeUrl);

      fileCache.set(fileId, {
        buffer,
        filename: metadata.filename
      });

      console.log(`   ✅ Cached ${fileId}`);
    } catch (err) {
      console.log(
        `   ❌ Pre-cache failed for ${fileId}: ${err.message}`
      );
    }
  }
}

// ---------------- REBALANCER ----------------
async function rebalance() {
  if (!amILeader()) return;

  const aliveNodes = await getAliveNodes();
  if (aliveNodes.length < 2) return;

  const keys = await redis.keys("file:*");

  for (const key of keys) {
    const fileData = await redis.get(key);
    if (!fileData) continue;

    const metadata = JSON.parse(fileData);
    let updated = false;

    for (const chunk of metadata.chunks) {
      if (chunk.nodes.length >= 2) continue;

      const sourceNode = chunk.nodes[0];
      const targetNode = aliveNodes.find(
        node => !chunk.nodes.includes(node)
      );

      if (!targetNode) continue;

      try {
        const response = await axios.get(
          `${sourceNode}/chunk/${chunk.chunkId}`
        );

        await axios.post(`${targetNode}/store`, {
          chunkId: chunk.chunkId,
          data: response.data.data,
        });

        chunk.nodes.push(targetNode);
        updated = true;

        console.log(
          `Rebalanced chunk ${chunk.chunkId} to ${targetNode}`
        );
      } catch (err) {
        console.log("Rebalance failed:", err.message);
      }
    }

    if (updated) {
      await redis.set(key, JSON.stringify(metadata));
    }
  }
}

// ---------------- PREDICTIVE AVAILABILITY ----------------
async function predictiveAvailabilityCheck() {
  if (!amILeader()) return;

  const thresholdMs = 4000;

  for (const nodeUrl of NODES) {
    try {
      const response = await axios.get(`${nodeUrl}/orbital-status`);
      const { isInBlackout, nextBlackoutInMs } = response.data;

      console.log(
        `🛰 ${nodeUrl} blackout in: ${nextBlackoutInMs} ms`
      );

      if (
        !isInBlackout &&
        nextBlackoutInMs > 0 &&
        nextBlackoutInMs < thresholdMs
      ) {
        console.log(`🔮 Predicting blackout for ${nodeUrl}`);
        await preCacheFilesFromNode(nodeUrl);
      }

    } catch (err) {
      console.log(`❌ Orbital check failed for ${nodeUrl}`);
    }
  }
}

// ---------------- BACKGROUND LOOPS ----------------
setInterval(rebalance, 10000);
setInterval(predictiveAvailabilityCheck, 3000);

// ---------------- UPLOAD ----------------
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!amILeader()) {
    return res.status(403).json({ error: "Not leader" });
  }

  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  try {
    const aliveNodes = await getAliveNodes();
    if (aliveNodes.length < 2) {
      return res.status(500).json({
        error: "Not enough alive nodes",
      });
    }

    const fileId = uuidv4();
    const filename = req.file.originalname;
    const buffer = req.file.buffer;

    const chunkSize = 1024 * 1024;
    const metadata = {
      fileId,
      filename,
      totalChunks: 0,
      chunks: [],
    };

    for (let i = 0; i < buffer.length; i += chunkSize) {
      const chunk = buffer.slice(i, i + chunkSize);
      const chunkId = `${fileId}_chunk_${metadata.totalChunks}`;

      const hash = crypto
        .createHash("sha256")
        .update(chunk)
        .digest("hex");

      const primary =
        aliveNodes[roundRobinIndex % aliveNodes.length];
      const replica =
        aliveNodes[(roundRobinIndex + 1) % aliveNodes.length];

      roundRobinIndex++;

      await axios.post(`${primary}/store`, {
        chunkId,
        data: chunk.toString("base64"),
      });

      await axios.post(`${replica}/store`, {
        chunkId,
        data: chunk.toString("base64"),
      });

      metadata.chunks.push({
        chunkId,
        hash,
        nodes: [primary, replica],
      });

      metadata.totalChunks++;
    }

    await redis.set(`file:${fileId}`, JSON.stringify(metadata));

    res.json({
      message: "Upload successful",
      fileId,
      totalChunks: metadata.totalChunks,
    });

  } catch (err) {
    console.error("Upload failed:", err.message);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ---------------- DOWNLOAD ----------------
app.get("/download/:fileId", async (req, res) => {
  const { fileId } = req.params;
  const start = Date.now();

  try {
    console.log(`\n📥 Download requested for ${fileId}`);

    if (fileCache.has(fileId)) {
      const cached = fileCache.get(fileId);

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${cached.filename}"`
      );
      res.setHeader("Content-Type", "application/octet-stream");

      return res.send(cached.buffer);
    }

    const data = await redis.get(`file:${fileId}`);
    if (!data) {
      return res.status(404).json({ error: "File not found" });
    }

    const metadata = JSON.parse(data);
    const finalBuffer = await reconstructFile(metadata);

    fileCache.set(fileId, {
      buffer: finalBuffer,
      filename: metadata.filename
    });

    console.log(
      `📦 Reconstructed ${(finalBuffer.length / 1024 / 1024).toFixed(2)} MB`
    );
    console.log(`⏱ Total time ${Date.now() - start} ms`);

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${metadata.filename}"`
    );
    res.setHeader("Content-Type", "application/octet-stream");

    res.send(finalBuffer);

  } catch (err) {
    console.error("Download failed:", err.message);
    res.status(500).json({ error: "Download failed" });
  }
});

// ---------------- METADATA ----------------
app.get("/metadata", async (req, res) => {
  const keys = await redis.keys("file:*");
  const files = [];

  for (const key of keys) {
    const data = await redis.get(key);
    if (data) files.push(JSON.parse(data));
  }

  res.json({ totalFiles: files.length, files });
});

app.get("/nodes", async (req, res) => {
  const results = [];

  for (const nodeUrl of NODES) {
    try {
      const health = await axios.get(`${nodeUrl}/health`);
      const orbital = await axios.get(`${nodeUrl}/orbital-status`);

      results.push({
        url: nodeUrl,
        alive: true,
        ...orbital.data,
      });

    } catch (err) {
      results.push({
        url: nodeUrl,
        alive: false,
      });
    }
  }

  res.json(results);
});


app.get("/cache-status", (req, res) => {
  const entries = [];

  fileCache.forEach((value, key) => {
    entries.push({
      fileId: key,
      filename: value.filename,
      sizeMB: (value.buffer.length / 1024 / 1024).toFixed(2),
    });
  });

  res.json({
    totalCached: entries.length,
    files: entries
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Master ${MASTER_ID} running on ${PORT}`);
});