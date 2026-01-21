import WebSocket from "ws";

const WS_URL = process.env.STT_WS_URL || "ws://localhost:2700";

const ws = new WebSocket(WS_URL);

ws.on("open", () => {
  console.log(`✅ Connected to Vosk Server at ${WS_URL}`);
  ws.send(
    JSON.stringify({
      config: {
        sample_rate: 16000,
      },
    }),
  );
  console.log("Sent config. Standing by for transcription...");
});

ws.on("message", (data) => {
  try {
    const response = JSON.parse(data.toString());
    if (response.text) {
      console.log(`📝 Transcribed: ${response.text}`);
    } else if (response.partial) {
      console.log(`⏱️ Thinking: ${response.partial}`);
    } else {
      console.log("ℹ️", response);
    }
  } catch (err) {
    console.error("❌ Parse error:", err);
  }
});

ws.on("error", (err) => {
  console.error("❌ Connection Error:", err.message);
});

ws.on("close", () => {
  console.log("🔌 Connection closed");
});
