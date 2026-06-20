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

const booleanEnv = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
};

const NEXT_API =
  process.env.NEXT_API || "https://conclave.acmvit.in/api/sfu/join";
const ROOM_ID = process.env.ROOM_ID || "acmvit-cybersec";
const CLIENT_ID = process.env.CLIENT_ID || "default";
const NUM = integerEnv("NUM", 200, { min: 1 });
const STAGGER_MS = integerEnv("STAGGER_MS", 50);
const STATS_MS = integerEnv("STATS_MS", 15000, { min: 1000 });
const HOST_READY_TIMEOUT_MS = integerEnv("HOST_READY_TIMEOUT_MS", 5000, {
  min: 0,
});
const AUTO_ADMIT_MS = integerEnv("AUTO_ADMIT_MS", 0, { min: 0 });
const HOST_PARTICIPANT = booleanEnv("HOST_PARTICIPANT", true);
const SFU_SECRET = process.env.SFU_SECRET || "";
const SFU_ADMIN_URL = process.env.SFU_ADMIN_URL || "";

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
  "Vikram", "Vinay", "Vivek", "Yash", "Zara", "Aditi", "Advait", "Ahana",
  "Alisha", "Anirudh", "Anushka", "Aparna", "Aryan", "Avani", "Avinash",
  "Ayush", "Devika", "Dhruv", "Farhan", "Fatima", "Gayatri", "Himanshu",
  "Imran", "Ira", "Jai", "Jatin", "Juhi", "Kabir", "Kiara", "Lavanya",
  "Leela", "Madhav", "Mahima", "Mihir", "Mira", "Nandini", "Naveen",
  "Navya", "Neel", "Neeraj", "Niharika", "Parth", "Payal", "Rehan",
  "Ritika", "Saanvi", "Sara", "Sarthak", "Shanaya", "Sonia", "Tara",
  "Trisha", "Ved", "Vidya", "Zoya", "Aarush", "Aarohi", "Abhay", "Ishan",
  "Rudra", "Samaira", "Vihaan", "Vivaan",
];

const LAST_NAMES = [
  "Sharma", "Verma", "Gupta", "Patel", "Singh", "Kumar", "Iyer", "Reddy",
  "Nair", "Menon", "Rao", "Pillai", "Krishnan", "Banerjee", "Mukherjee",
  "Chatterjee", "Ghosh", "Roy", "Das", "Sen", "Joshi", "Desai", "Mehta",
  "Shah", "Agarwal", "Bhatia", "Khanna", "Kapoor", "Chopra", "Malhotra",
  "Saxena", "Mishra", "Tiwari", "Pandey", "Dubey", "Yadav", "Jain",
  "Bhandari", "Acharya", "Bhat", "Ahuja", "Bajaj", "Bansal", "Barua",
  "Bose", "Chandra", "Chauhan", "D'Souza", "Fernandes", "Gill", "Kale",
  "Kamat", "Kulkarni", "Lal", "Mahajan", "Mann", "Mathur", "Murthy",
  "Naidu", "Narayanan", "Parekh", "Prasad", "Sethi", "Shetty", "Sinha",
  "Sodhi", "Subramanian", "Talwar", "Thakur", "Thomas", "Tripathi",
  "Venkatesh", "Wadhwa", "Zaveri",
];

const INITIALS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const randomName = () => {
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  const roll = Math.random();

  if (roll < 0.5) return `${first} ${last}`;
  if (roll < 0.68) return first;
  if (roll < 0.8) return `${first} ${pick(INITIALS)}. ${last}`;
  if (roll < 0.9) return `${first} ${last[0]}.`;
  if (roll < 0.96) return `${first} ${pick(LAST_NAMES)} ${last}`;
  return `${first}-${pick(FIRST_NAMES)} ${last}`;
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
  admitted: 0,
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
  let resolveJoined;
  const joined = new Promise((resolve) => {
    resolveJoined = resolve;
  });

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
          resolveJoined();
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

  return { socket, name, sessionId, isHost, index: i, joined, sfuUrl };
}

async function main() {
  let shuttingDown = false;
  let admitInFlight = false;
  console.log(
    `[boot] participants=${NUM} room=${ROOM_ID} clientId=${CLIENT_ID} api=${NEXT_API} stagger=${STAGGER_MS}ms hostParticipant=${HOST_PARTICIPANT} autoAdmit=${AUTO_ADMIT_MS}ms adminHttp=${Boolean(SFU_SECRET)}`,
  );
  const handles = [];
  let hostHandle = null;
  let autoAdmitTimer = null;
  let adminBaseUrl = SFU_ADMIN_URL;

  const admitAllPending = async () => {
    if (admitInFlight) return;
    admitInFlight = true;
    if (SFU_SECRET && adminBaseUrl) {
      try {
        const url = new URL(
          `/admin/rooms/${encodeURIComponent(ROOM_ID)}/pending/admit-all`,
          adminBaseUrl,
        );
        url.searchParams.set("clientId", CLIENT_ID);
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sfu-secret": SFU_SECRET,
          },
          body: "{}",
        });
        const payload = await resp.json().catch(() => null);
        if (!resp.ok || (payload && payload.error)) {
          console.error(
            `[admin] http admit-all: ${resp.status} ${payload?.error || resp.statusText}`,
          );
          return;
        }
        const admittedCount =
          payload && Number.isInteger(payload.admittedCount)
            ? payload.admittedCount
            : 0;
        if (admittedCount > 0) {
          state.admitted += admittedCount;
          console.log(`[admin] admitted ${admittedCount} pending participant(s)`);
        }
      } catch (err) {
        console.error(`[admin] http admit-all: ${err.message}`);
      } finally {
        admitInFlight = false;
      }
      return;
    }
    if (!hostHandle || !hostHandle.socket.connected) {
      admitInFlight = false;
      return;
    }
    hostHandle.socket.emit("admin:admitAllPending", (resp) => {
      admitInFlight = false;
      if (resp && resp.error) {
        console.error(`[admin] admit-all: ${resp.error}`);
        return;
      }
      const admittedCount =
        resp && Number.isInteger(resp.admittedCount) ? resp.admittedCount : 0;
      if (admittedCount > 0) {
        state.admitted += admittedCount;
        console.log(`[admin] admitted ${admittedCount} pending participant(s)`);
      }
    });
  };

  for (let i = 0; i < NUM; i++) {
    const handle = await spawnParticipant(i, HOST_PARTICIPANT && i === 0);
    if (handle) {
      handles.push(handle);
      adminBaseUrl ||= handle.sfuUrl;
      if (HOST_PARTICIPANT && i === 0) {
        hostHandle = handle;
        await Promise.race([handle.joined, sleep(HOST_READY_TIMEOUT_MS)]);
      }
      if (i === 0 && AUTO_ADMIT_MS > 0) {
        autoAdmitTimer = setInterval(admitAllPending, AUTO_ADMIT_MS);
      }
    }
    if (i + 1 < NUM) await sleep(STAGGER_MS);
  }
  console.log(`[boot] spawn loop done, ${handles.length}/${NUM} attempted`);
  admitAllPending();

  const statsTimer = setInterval(() => {
    console.log(
      `[stats] attempted=${state.attempted} connected=${state.connected} joined=${state.joined} waiting=${state.waiting} admitted=${state.admitted} joinFail=${state.joinFailed} tokenFail=${state.tokenFailed} sockErr=${state.socketErrors}`,
    );
  }, STATS_MS);

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] received ${signal}, disconnecting ${handles.length} sockets`);
    clearInterval(statsTimer);
    if (autoAdmitTimer) clearInterval(autoAdmitTimer);
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
