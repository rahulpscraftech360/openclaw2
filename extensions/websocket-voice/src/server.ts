import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getRealtimeTranscriptionProvider } from "openclaw/plugin-sdk/realtime-transcription";
import { getSpeechProvider } from "openclaw/plugin-sdk/speech";
import { WebSocketServer, type WebSocket } from "ws";
import { runPipeline } from "./orchestrator.js";

export type VoiceServerConfig = {
  port: number;
  authSecret: string | undefined;
  sttProviderId: string | undefined;
  ttsProviderId: string | undefined;
};

export type VoiceServer = {
  close: () => Promise<void>;
};

export function createVoiceServer(config: VoiceServerConfig, api: OpenClawPluginApi): VoiceServer {
  const activeHandles = new Map<WebSocket, { cleanup: () => void }>();
  const wss = new WebSocketServer({ port: config.port });

  wss.on("connection", (socket: WebSocket, req: import("http").IncomingMessage) => {
    if (config.authSecret) {
      const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
      if (token !== config.authSecret) {
        socket.send(JSON.stringify({ event: "error", message: "Unauthorized" }));
        socket.close(4001, "Unauthorized");
        return;
      }
    }

    const handle = runPipeline(socket, {
      subagent: api.runtime.subagent,
      cfg: api.config,
      sttProvider: getRealtimeTranscriptionProvider(config.sttProviderId, api.config),
      ttsProvider: getSpeechProvider(config.ttsProviderId, api.config),
    });

    activeHandles.set(socket, handle);

    socket.on("close", () => {
      handle.cleanup();
      activeHandles.delete(socket);
    });

    socket.on("error", (error: unknown) => {
      api.logger.error(`[websocket-voice] Socket error: ${String(error)}`);
      handle.cleanup();
      activeHandles.delete(socket);
    });
  });

  wss.on("error", (error: unknown) => {
    api.logger.error(`[websocket-voice] Server error: ${String(error)}`);
  });

  return {
    close(): Promise<void> {
      return new Promise((resolve) => {
        for (const [socket, handle] of activeHandles) {
          handle.cleanup();
          socket.close();
        }
        activeHandles.clear();
        wss.close(() => resolve());
      });
    },
  };
}
