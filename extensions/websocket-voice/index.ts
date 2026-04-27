import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createVoiceServer, type VoiceServer } from "./src/server.js";

type PluginConfig = {
  port?: number;
  authSecret?: string;
  sttProvider?: string;
  ttsProvider?: string;
};

function resolvePort(rawPort: unknown): number {
  if (
    typeof rawPort === "number" &&
    Number.isInteger(rawPort) &&
    rawPort > 0 &&
    rawPort <= 65_535
  ) {
    return rawPort;
  }
  if (typeof rawPort === "string") {
    const parsed = Number.parseInt(rawPort, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) {
      return parsed;
    }
  }
  return 8765;
}

export default definePluginEntry({
  id: "websocket-voice",
  name: "WebSocket Voice Streaming",
  description:
    "Bidirectional voice streaming over WebSockets. Runs a standalone WS server " +
    "on a dedicated port (STT -> LLM -> TTS pipeline).",

  register(api) {
    let server: VoiceServer | undefined;

    const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;

    api.registerService({
      id: "websocket-voice-server",
      start() {
        const port = resolvePort(pluginConfig.port);
        server = createVoiceServer(
          {
            port,
            authSecret: pluginConfig.authSecret,
            sttProviderId: pluginConfig.sttProvider,
            ttsProviderId: pluginConfig.ttsProvider,
          },
          api,
        );
        api.logger.info(`[websocket-voice] Listening on ws://0.0.0.0:${port}`);
      },
      async stop() {
        await server?.close();
        server = undefined;
      },
    });
  },
});
