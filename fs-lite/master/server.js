const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const redis = require("./redisClient");
const { startElection, amILeader } = require("./leader");
const multer = require("multer");
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
    // 🔥 Get alive nodes first
    const aliveNodes = await getAliveNodes();

    if (aliveNodes.length < 2) {
      return res.status(500).json({
        error: "Not enough alive nodes for replication",
      });
    }

    const fileId = uuidv4();
    const filename = req.file.originalname;
    const buffer = req.file.buffer;

    const chunkSize = 1024 * 1024; // 1MB
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

      // 🔥 Use alive nodes only
      const primaryIndex = roundRobinIndex % aliveNodes.length;
      const replicaIndex = (primaryIndex + 1) % aliveNodes.length;

      const primaryNode = aliveNodes[primaryIndex];
      const replicaNode = aliveNodes[replicaIndex];

      roundRobinIndex++;

      try {
        // Store in primary
        await axios.post(`${primaryNode}/store`, {
          chunkId,
          data: chunks[i].toString("base64"),
        });

        // Store in replica
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

        // Rollback everything stored so far
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
  try {
    const { fileId } = req.params;

    const data = await redis.get(`file:${fileId}`);
    if (!data) return res.status(404).json({ error: "File not found" });

    const metadata = JSON.parse(data);
    const buffers = [];

    for (const chunk of metadata.chunks) {
      let chunkBuffer = null;

      for (const node of chunk.nodes) {
        try {
          const response = await axios.get(
            `${node}/chunk/${chunk.chunkId}`,
            { timeout: 2000 }
          );

          chunkBuffer = Buffer.from(response.data.data, "base64");
          break;

        } catch (err) {
          console.log(`Node ${node} failed, trying next...`);
        }
      }

      if (!chunkBuffer) {
        return res.status(500).json({
          error: "All replicas failed for chunk",
        });
      }

      const hash = crypto
        .createHash("sha256")
        .update(chunkBuffer)
        .digest("hex");

      if (hash !== chunk.hash) {
        return res.status(500).json({
          error: "Integrity check failed",
        });
      }

      buffers.push(chunkBuffer);
    }

    const finalBuffer = Buffer.concat(buffers);

    res.setHeader("Content-Disposition", `attachment; filename="${metadata.filename}"`);
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

app.listen(PORT, () => {
  console.log(`🚀 Master ${MASTER_ID} running on ${PORT}`);
});