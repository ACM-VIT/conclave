#!/usr/bin/env node
import { io } from "socket.io-client";

const integerEnv = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.warn(`[config] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
    return fallback;
  }

  return value;
};

const NEXT_API =
  process.env.NEXT_API || "https://conclave.acmvit.in/api/sfu/join";
const ROOM_ID = process.env.ROOM_ID || "acmvit-cybersec";
const CLIENT_ID = process.env.CLIENT_ID || "default";
const NUM = integerEnv("NUM", 200, { min: 1 });
const STAGGER_MS = integerEnv("STAGGER_MS", 50);
const STATS_MS = integerEnv("STATS_MS", 15000, { min: 1000 });

const FIRST_NAMES = [
  "Arjun", "Aarav", "Aditya", "Aanya", "Ananya", "Aisha", "Akshay", "Aman",
  "Amit", "Amrita", "Anand", "Ankit", "Ankita", "Arpita", "Arnav", "Asha",
  "Bhavya", "Chetan", "Deepak", "Deepika", "Dev", "Diya", "Esha", "Gaurav",
  "Harsh", "Ishaan", "Ishita", "Jay", "Karan", "Kavya", "Krishna", "Lakshmi",
  "Manish", "Maya", "Meera", "Mohit", "Naina", "Neha", "Nikhil", "Niraj",
  "Nisha", "Pooja", "Prachi", "Pranav", "Priya", "Rahul", "Raj", "Rajesh",
  "Ramesh", "Riya", "Rohan", "Rohit", "Sahil", "Sai", "Samar", "Sameera",
  "Sanjay", "Saumya", "Shreya", "Shubham", "Siddharth", "Simran", "Sneha",
  "Sonali", "Suresh", "Swati", "Tanvi", "Tarun", "Uma", "Varun", "Vijay",
  "Vikram", "Vinay", "Vivek", "Yash", "Zara",
];

const LAST_NAMES = [
  "Sharma", "Verma", "Gupta", "Patel", "Singh", "Kumar", "Iyer", "Reddy",
  "Nair", "Menon", "Rao", "Pillai", "Krishnan", "Banerjee", "Mukherjee",
  "Chatterjee", "Ghosh", "Roy", "Das", "Sen", "Joshi", "Desai", "Mehta",
  "Shah", "Agarwal", "Bhatia", "Khanna", "Kapoor", "Chopra", "Malhotra",
  "Saxena", "Mishra", "Tiwari", "Pandey", "Dubey", "Yadav", "Jain",
  "Bhandari", "Acharya", "Bhat",
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const randomName = () => {
  const first = pick(FIRST_NAMES);
  return Math.random() < 0.6 ? `${first} ${pick(LAST_NAMES)}` : first;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken({ name, sessionId, isHost }) {
  const resp = await fetch(NEXT_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sfu-client": CLIENT_ID,
    },
    body: JSON.stringify({
      roomId: ROOM_ID,
      sessionId,
      user: { name },
      clientId: CLIENT_ID,
      isHost: Boolean(isHost),
      allowRoomCreation: Boolean(isHost),
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`token ${resp.status}: ${text.slice(0, 120)}`);
  }
  const payload = await resp.json().catch(() => null);
  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.token !== "string" ||
    typeof payload.sfuUrl !== "string"
  ) {
    throw new Error("token response missing token or sfuUrl");
  }
  return payload;
}

const state = {
  attempted: 0,
  connected: 0,
  joined: 0,
  waiting: 0,
  joinFailed: 0,
  tokenFailed: 0,
  socketErrors: 0,
};

async function spawnParticipant(i, isHost) {
  state.attempted++;
  const name = randomName();
  const sessionId = `loadtest-${i}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  let token;
  let sfuUrl;
  try {
    const data = await getToken({ name, sessionId, isHost });
    token = data.token;
    sfuUrl = data.sfuUrl;
  } catch (err) {
    state.tokenFailed++;
    console.error(`[#${i}] token: ${err.message}`);
    return null;
  }

  const socket = io(sfuUrl, {
    auth: { token },
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
    timeout: 20000,
  });

  let joinedOnce = false;
  let waitingCounted = false;

  const emitJoin = () => {
    socket.emit(
      "joinRoom",
      {
        roomId: ROOM_ID,
        sessionId,
        displayName: name,
      },
      (resp) => {
        if (resp && resp.error) {
          state.joinFailed++;
          console.error(`[#${i}] join: ${resp.error}`);
          return;
        }
        if (resp && resp.status === "waiting") {
          if (!waitingCounted) {
            waitingCounted = true;
            state.waiting++;
          }
          return;
        }
        if (resp && resp.status === "joined" && !joinedOnce) {
          joinedOnce = true;
          if (waitingCounted) {
            waitingCounted = false;
            state.waiting = Math.max(0, state.waiting - 1);
          }
          state.joined++;
        }
      },
    );
  };

  socket.on("connect", () => {
    state.connected++;
    emitJoin();
  });

  socket.on("joinApproved", () => {
    emitJoin();
  });

  socket.on("disconnect", () => {
    state.connected = Math.max(0, state.connected - 1);
  });

  socket.on("connect_error", (err) => {
    state.socketErrors++;
    console.error(`[#${i}] connect_error: ${err.message}`);
  });

  return { socket, name, sessionId, isHost, index: i };
}

async function main() {
  let shuttingDown = false;
  console.log(
    `[boot] participants=${NUM} room=${ROOM_ID} clientId=${CLIENT_ID} api=${NEXT_API} stagger=${STAGGER_MS}ms`,
  );
  const handles = [];
  for (let i = 0; i < NUM; i++) {
    const handle = await spawnParticipant(i, i === 0);
    if (handle) handles.push(handle);
    if (i + 1 < NUM) await sleep(STAGGER_MS);
  }
  console.log(`[boot] spawn loop done, ${handles.length}/${NUM} attempted`);

  const statsTimer = setInterval(() => {
    console.log(
      `[stats] attempted=${state.attempted} connected=${state.connected} joined=${state.joined} waiting=${state.waiting} joinFail=${state.joinFailed} tokenFail=${state.tokenFailed} sockErr=${state.socketErrors}`,
    );
  }, STATS_MS);

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}, disconnecting ${handles.length} sockets`);
    clearInterval(statsTimer);
    for (const handle of handles) {
      try {
        handle.socket.disconnect();
      } catch {}
    }
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
