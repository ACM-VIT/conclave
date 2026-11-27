import { createServer } from "node:http";
import { config } from "../../config/config.js";
import { createSfuApp } from "../../server/http/createApp.js";
import { initControlPlane } from "../../server/init.js";
import { LocalRoomRegistry } from "../../server/roomRegistry.js";
import { createSfuState } from "../../server/state.js";

const name = process.argv[2] ?? "sfu";
const state = createSfuState({
  roomRegistry: new LocalRoomRegistry({ instanceId: name, instanceUrl: "http://localhost", ttlMs: 45000 }),
});
await initControlPlane(state);
const server = createServer(createSfuApp({ state, config, getIo: () => null }));
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`listening ${address && typeof address === "object" ? address.port : 0}\n`);
});
process.stdin.resume();
process.stdin.on("end", () => {
  server.close();
  server.closeAllConnections();
  void state.controlPlane.close().then(() => process.exit(0));
});
