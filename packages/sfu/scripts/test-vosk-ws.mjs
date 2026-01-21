import WebSocket from 'ws';

const WS_URL = 'ws://localhost:2700';
const ws = new WebSocket(WS_URL);

ws.on('open', () => {
    console.log('✅ Connected! Sending config...');
    
    // 1. Send Config
    ws.send(JSON.stringify({ config: { sample_rate: 16000 } }));

    // 2. Send some "silence" to keep it alive (1 second of 16-bit PCM)
    console.log('Sending 1 second of silence to keep connection open...');
    const silence = Buffer.alloc(32000); // 16000 samples * 2 bytes
    ws.send(silence);
});

ws.on('message', (data) => {
    console.log('📝 Received from Vosk:', data.toString());
});

ws.on('close', (code, reason) => {
    console.log(`🔌 Connection closed (Code: ${code}, Reason: ${reason || 'None'})`);
});

ws.on('error', (err) => console.error('❌ Error:', err));