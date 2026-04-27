import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { runPipeline } from "./orchestrator.js";

export function handleWebSocketConnection(
  socket: import("ws").WebSocket,
  req: any,
  api: OpenClawPluginApi
) {
  // 1. Extract and validate authentication
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");

  // Basic configuration logic (ideally loaded from plugin config)
  const config = api.pluginConfig as { authSecret?: string };
  if (config?.authSecret && token !== config.authSecret) {
    socket.send(JSON.stringify({ event: "error", message: "Unauthorized" }));
    socket.close(4001, "Unauthorized");
    return;
  }

  // Log new connection
  console.log(`[websocket-voice] New connection from ${req.socket.remoteAddress}`);

  // Start orchestrator pipeline for this socket
  const session = runPipeline(socket, api);

  socket.on("close", () => {
    console.log("[websocket-voice] Connection closed");
    session.cleanup();
  });

  socket.on("error", (err) => {
    console.error("[websocket-voice] Socket error:", err);
    session.cleanup();
  });
}
