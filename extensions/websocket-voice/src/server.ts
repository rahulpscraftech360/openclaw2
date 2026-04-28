import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders,
  type RealtimeTranscriptionProviderPlugin,
} from "openclaw/plugin-sdk/realtime-transcription";
import {
  getSpeechProvider,
  listSpeechProviders,
  type SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech";
import { WebSocketServer, type WebSocket } from "ws";
import { runPipeline } from "./orchestrator.js";

export type VoiceServerConfig = {
  port: number;
  authSecret: string | undefined;
  sttProviderId: string | undefined;
  ttsProviderId: string | undefined;
  sttProviderConfig: Record<string, unknown> | undefined;
  ttsProviderConfig: Record<string, unknown> | undefined;
  debug: boolean | undefined;
};

export type VoiceServer = {
  close: () => Promise<void>;
};

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveConfiguredTtsProviderId(cfg: Record<string, unknown>): string | undefined {
  const messages = readRecord(cfg.messages);
  const tts = readRecord(messages?.tts);
  const provider = tts?.provider;
  return typeof provider === "string" && provider.trim().length > 0 ? provider.trim() : undefined;
}

function resolveStreamingConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const plugins = readRecord(cfg.plugins);
  const entries = readRecord(plugins?.entries);
  const voiceCall = readRecord(entries?.["voice-call"]);
  const config = readRecord(voiceCall?.config);
  return readRecord(config?.streaming) ?? {};
}

function sortByAutoSelectOrder<T extends { id: string; autoSelectOrder?: number }>(
  items: T[],
): T[] {
  return [...items].sort((left, right) => {
    const leftOrder = left.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.id.localeCompare(right.id);
  });
}

function resolveSttProvider(
  requestedId: string | undefined,
  api: OpenClawPluginApi,
): RealtimeTranscriptionProviderPlugin | undefined {
  if (requestedId) {
    return getRealtimeTranscriptionProvider(requestedId, api.config);
  }

  const cfgRecord = readRecord(api.config) ?? {};
  const streamingConfig = resolveStreamingConfig(cfgRecord);
  const providers = sortByAutoSelectOrder(listRealtimeTranscriptionProviders(api.config));
  for (const provider of providers) {
    const providerConfig =
      provider.resolveConfig?.({ cfg: api.config, rawConfig: streamingConfig }) ?? {};
    if (provider.isConfigured({ cfg: api.config, providerConfig })) {
      return provider;
    }
  }
  return providers[0];
}

function resolveTtsProvider(
  requestedId: string | undefined,
  api: OpenClawPluginApi,
): SpeechProviderPlugin | undefined {
  if (requestedId) {
    return getSpeechProvider(requestedId, api.config);
  }

  const cfgRecord = readRecord(api.config) ?? {};
  const preferredId = resolveConfiguredTtsProviderId(cfgRecord);
  if (preferredId) {
    const preferredProvider = getSpeechProvider(preferredId, api.config);
    if (preferredProvider) {
      const preferredConfig =
        preferredProvider.resolveConfig?.({
          cfg: api.config,
          rawConfig: readRecord(readRecord(cfgRecord.messages)?.tts) ?? {},
          timeoutMs: 30_000,
        }) ?? {};
      if (
        preferredProvider.isConfigured({
          cfg: api.config,
          providerConfig: preferredConfig,
          timeoutMs: 30_000,
        })
      ) {
        return preferredProvider;
      }
    }
  }

  const providers = sortByAutoSelectOrder(listSpeechProviders(api.config));
  for (const provider of providers) {
    const providerConfig =
      provider.resolveConfig?.({
        cfg: api.config,
        rawConfig: readRecord(readRecord(cfgRecord.messages)?.tts) ?? {},
        timeoutMs: 30_000,
      }) ?? {};
    if (provider.isConfigured({ cfg: api.config, providerConfig, timeoutMs: 30_000 })) {
      return provider;
    }
  }
  return providers[0];
}

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

    const resolvedStt = resolveSttProvider(config.sttProviderId, api);
    const resolvedTts = resolveTtsProvider(config.ttsProviderId, api);
    api.logger.info(
      `[websocket-voice] connection — stt=${resolvedStt?.id ?? "NONE"} tts=${resolvedTts?.id ?? "NONE"}`,
    );

    const handle = runPipeline(socket, {
      subagent: api.runtime.subagent,
      cfg: api.config,
      sttProvider: resolvedStt,
      ttsProvider: resolvedTts,
      sttProviderConfig: config.sttProviderConfig,
      ttsProviderConfig: config.ttsProviderConfig,
      debug: config.debug === true,
      onDebug: (message) => api.logger.info(`[websocket-voice] dbg: ${message}`),
      onInfo: (message) => api.logger.info(`[websocket-voice] ${message}`),
      onError: (message, _error) => api.logger.error(`[websocket-voice] ${message}`),
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
