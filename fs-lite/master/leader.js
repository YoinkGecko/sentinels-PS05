const redis = require("./redisClient");

const LOCK_KEY = "fs_master_lock";
const TTL = 5; // seconds

let isLeader = false;
let instanceId = null;

async function tryBecomeLeader(id) {
  const result = await redis.set(LOCK_KEY, id, {
    NX: true,
    EX: TTL,
  });

  if (result === "OK") {
    isLeader = true;
    instanceId = id;
    console.log(`🟢 Became Leader: ${id}`);
  }
}

async function refreshLock() {
  if (!isLeader) return;

  const current = await redis.get(LOCK_KEY);
  if (current === instanceId) {
    await redis.expire(LOCK_KEY, TTL);
  } else {
    isLeader = false;
    console.log("🔴 Lost leadership");
  }
}

async function startElection(id) {
  instanceId = id;

  setInterval(async () => {
    if (!isLeader) {
      await tryBecomeLeader(id);
    } else {
      await refreshLock();
    }
  }, 2000);
}

function amILeader() {
  return isLeader;
}

module.exports = { startElection, amILeader };