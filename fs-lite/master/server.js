const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const redis = require("./redisClient");
const { startElection, amILeader } = require("./leader");
const multer = require("multer");
const { LRUCache } = require("lru-cache");

const fileCache = new LRUCache({
  max: 5,
  maxSize: 200 * 1024 * 1024,
  sizeCalculation: (value) => value.length,
});

const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(express.json({ limit: "200mb" }));

const PORT = process.argv[2];
if (!PORT) {
  console.error("Provide port");
  process.exit(1);
}

const MASTER_ID = `master-${PORT}`;
startElection(MASTER_ID);

// Storage nodes
const NODES = [
  "http://localhost:4001",
  "http://localhost:4002",
  "http://localhost:4003",
];

let roundRobinIndex = 0;

// ---------------- ALIVE NODE DETECTION ----------------
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
      if (!chunk.nodes) continue; // Safety for old schema

      // Remove dead nodes from metadata
      chunk.nodes = chunk.nodes.filter(node =>
        aliveNodes.includes(node)
      );

      if (chunk.nodes.length >= 2) continue;

      if (chunk.nodes.length === 0) {
        console.log("All replicas lost for chunk:", chunk.chunkId);
        continue;
      }

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

// Run rebalancer every 10 seconds
setInterval(() => {
  rebalance();
}, 10000);

// ---------------- UPLOAD ----------------
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!amILeader()) {
    return res.status(403).json({ error: "Not leader" });
  }

  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const storedChunks = [];

  try {
    const aliveNodes = await getAliveNodes();

    if (aliveNodes.length < 2) {
      return res.status(500).json({
        error: "Not enough alive nodes for replication",
      });
    }

    const fileId = uuidv4();
    const filename = req.file.originalname;
    const buffer = req.file.buffer;

    const chunkSize = 1024 * 1024;
    const chunks = [];

    for (let i = 0; i < buffer.length; i += chunkSize) {
      chunks.push(buffer.slice(i, i + chunkSize));
    }

    const metadata = {
      fileId,
      filename,
      totalChunks: chunks.length,
      chunks: [],
    };

    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `${fileId}_chunk_${i}`;
      const hash = crypto
        .createHash("sha256")
        .update(chunks[i])
        .digest("hex");

      const primaryIndex = roundRobinIndex % aliveNodes.length;
      const replicaIndex = (primaryIndex + 1) % aliveNodes.length;

      const primaryNode = aliveNodes[primaryIndex];
      const replicaNode = aliveNodes[replicaIndex];

      roundRobinIndex++;

      try {
        await axios.post(`${primaryNode}/store`, {
          chunkId,
          data: chunks[i].toString("base64"),
        });

        await axios.post(`${replicaNode}/store`, {
          chunkId,
          data: chunks[i].toString("base64"),
        });

        storedChunks.push({
          chunkId,
          nodes: [primaryNode, replicaNode],
        });

      } catch (err) {
        console.error("Replication failed, rolling back...");

        for (const chunk of storedChunks) {
          for (const node of chunk.nodes) {
            try {
              await axios.delete(`${node}/chunk/${chunk.chunkId}`);
            } catch (_) {}
          }
        }

        return res.status(500).json({
          error: "Upload failed during replication. Rolled back.",
        });
      }

      metadata.chunks.push({
        chunkId,
        hash,
        nodes: [primaryNode, replicaNode],
      });
    }

    await redis.set(`file:${fileId}`, JSON.stringify(metadata));

    return res.json({
      message: "Upload successful",
      fileId,
      totalChunks: chunks.length,
    });

  } catch (err) {
    console.error("Upload failed:", err.message);
    return res.status(500).json({ error: "Upload failed" });
  }
});

// ---------------- DOWNLOAD ----------------
app.get("/download/:fileId", async (req, res) => {
  const { fileId } = req.params;
  const requestStart = Date.now();

  try {
    console.log(`\n📥 Download requested for file: ${fileId}`);

    // ---------------- CACHE CHECK ----------------
    if (fileCache.has(fileId)) {
      console.log("⚡ Cache HIT:", fileId);

      const cachedBuffer = fileCache.get(fileId);

      console.log(
        `⏱ Served from cache in ${Date.now() - requestStart} ms`
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="cached_${fileId}"`
      );
      res.setHeader("Content-Type", "application/octet-stream");
      return res.send(cachedBuffer);
    }

    console.log("🌀 Cache MISS — reconstructing from nodes");

    const data = await redis.get(`file:${fileId}`);
    if (!data) {
      console.log("❌ File metadata not found");
      return res.status(404).json({ error: "File not found" });
    }

    const metadata = JSON.parse(data);
    const buffers = [];

    // ---------------- CHUNK FETCH ----------------
    for (const chunk of metadata.chunks) {
      let chunkBuffer = null;

      console.log(`🔍 Fetching chunk: ${chunk.chunkId}`);

      for (const node of chunk.nodes) {
        try {
          const nodeStart = Date.now();

          const response = await axios.get(
            `${node}/chunk/${chunk.chunkId}`,
            { timeout: 2000 }
          );

          console.log(
            `   ✅ Fetched from ${node} in ${Date.now() - nodeStart} ms`
          );

          chunkBuffer = Buffer.from(response.data.data, "base64");
          break;

        } catch (err) {
          console.log(`   ❌ Failed from ${node}`);
        }
      }

      if (!chunkBuffer) {
        console.log("🚨 All replicas failed for chunk:", chunk.chunkId);
        return res.status(500).json({
          error: "All replicas failed for chunk",
        });
      }

      // ---------------- INTEGRITY CHECK ----------------
      const hash = crypto
        .createHash("sha256")
        .update(chunkBuffer)
        .digest("hex");

      if (hash !== chunk.hash) {
        console.log("🚨 Integrity check failed for:", chunk.chunkId);
        return res.status(500).json({
          error: "Integrity check failed",
        });
      }

      buffers.push(chunkBuffer);
    }

    // ---------------- RECONSTRUCTION ----------------
    const finalBuffer = Buffer.concat(buffers);

    console.log(
      `📦 Reconstruction complete. Size: ${(finalBuffer.length / 1024 / 1024).toFixed(2)} MB`
    );

    // ---------------- STORE IN CACHE ----------------
    fileCache.set(fileId, finalBuffer);
    console.log("💾 Stored in cache:", fileId);

    console.log(
      `⏱ Total download time: ${Date.now() - requestStart} ms`
    );

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

// ---------------- HEALTH ----------------
app.get("/health", (req, res) => {
  res.json({
    master: MASTER_ID,
    leader: amILeader(),
  });
});

app.get("/metadata", async (req, res) => {
  const keys = await redis.keys("file:*");
  const result = [];

  for (const key of keys) {
    const data = await redis.get(key);
    if (!data) continue;

    result.push(JSON.parse(data));
  }

  res.json({
    totalFiles: result.length,
    files: result
  });
});

app.get("/metadata/:fileId", async (req, res) => {
  const { fileId } = req.params;

  const data = await redis.get(`file:${fileId}`);
  if (!data) {
    return res.status(404).json({ error: "File not found" });
  }

  res.json(JSON.parse(data));
});



app.listen(PORT, () => {
  console.log(`🚀 Master ${MASTER_ID} running on ${PORT}`);
});