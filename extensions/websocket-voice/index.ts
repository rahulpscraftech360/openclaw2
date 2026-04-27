import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import fastifyWebsocket from "@fastify/websocket";
import { handleWebSocketConnection } from "./src/server.js";

export default definePluginEntry({
  id: "websocket-voice",
  name: "WebSocket Voice Streaming",
  description: "Native bidirectional voice streaming over WebSockets via Pipeline (STT -> LLM -> TTS)",
  
  register(api) {
    // 1. Hook into OpenClaw's existing Fastify web server
    api.registerFastifyPlugin(async (fastify) => {
      // Register fastify-websocket if it isn't already present
      if (!fastify.hasPlugin("@fastify/websocket")) {
        await fastify.register(fastifyWebsocket);
      }

      // 2. Add our custom WebSocket route (/api/voice/stream)
      fastify.get("/api/voice/stream", { websocket: true }, (connection, req) => {
        handleWebSocketConnection(connection.socket, req, api);
      });
    });
  },
});
