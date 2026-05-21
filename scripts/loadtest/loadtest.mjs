#!/usr/bin/env node
// Synthetic-participant load test. Spawns NUM socket.io clients that fetch
// a JWT from the Next.js /api/sfu/join endpoint and then issue joinRoom
// against the SFU, persisting the connection until SIGINT/SIGTERM. The
// first participant requests host so the room is auto-created if it does
// not exist yet.
//
// Env vars:
//   NEXT_API      Next.js token endpoint (default https://conclave.acmvit.in/api/sfu/join)
//   ROOM_ID       Meeting room code to join (default acmvit-cybersec)
//   NUM           Participant count (default 200)
//   STAGGER_MS    Spacing between spawns (default 50)
//   STATS_MS      Stats heartbeat interval (default 15000)

import { io } from "socket.io-client";

const NEXT_API =
  process.env.NEXT_API || "https://conclave.acmvit.in/api/sfu/join";
const ROOM_ID = process.env.ROOM_ID || "acmvit-cybersec";
const NUM = Number(process.env.NUM || 200);
const STAGGER_MS = Number(process.env.STAGGER_MS || 50);
const STATS_MS = Number(process.env.STATS_MS || 15000);

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
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId: ROOM_ID,
      sessionId,
      user: { name },
      isHost: Boolean(isHost),
      allowRoomCreation: Boolean(isHost),
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`token ${resp.status}: ${text.slice(0, 120)}`);
  }
  return resp.json();
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
  console.log(
    `[boot] participants=${NUM} room=${ROOM_ID} api=${NEXT_API} stagger=${STAGGER_MS}ms`,
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
    console.log(`[shutdown] received ${signal}, disconnecting ${handles.length} sockets`);
    clearInterval(statsTimer);
    for (const handle of handles) {
      try {
        handle.socket.disconnect();
      } catch {
        // ignore
      }
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
