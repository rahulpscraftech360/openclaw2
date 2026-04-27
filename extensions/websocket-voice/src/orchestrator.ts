import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/speech";
import type { WebSocket } from "ws";

export type PipelineDeps = {
  subagent: PluginRuntime["subagent"];
  cfg: OpenClawConfig;
  sttProvider: RealtimeTranscriptionProviderPlugin | undefined;
  ttsProvider: SpeechProviderPlugin | undefined;
  sttProviderConfig: Record<string, unknown> | undefined;
  ttsProviderConfig: Record<string, unknown> | undefined;
  debug: boolean;
  onDebug: (message: string) => void;
};

export type PipelineHandle = {
  cleanup: () => void;
};

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveTtsRawConfig(cfg: OpenClawConfig): Record<string, unknown> {
  const root = readRecord(cfg);
  const messages = readRecord(root?.messages);
  return readRecord(messages?.tts) ?? {};
}

function resolveStreamingSttRawConfig(cfg: OpenClawConfig): Record<string, unknown> {
  const root = readRecord(cfg);
  const plugins = readRecord(root?.plugins);
  const entries = readRecord(plugins?.entries);
  const voiceCall = readRecord(entries?.["voice-call"]);
  const config = readRecord(voiceCall?.config);
  return readRecord(config?.streaming) ?? {};
}

function rawDataToString(data: import("ws").RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function extractAssistantText(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }

    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") {
      continue;
    }

    const content = record.content;
    if (typeof content === "string") {
      const text = content.trim();
      if (text.length > 0) {
        return text;
      }
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    const text = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          !!part &&
          typeof part === "object" &&
          !Array.isArray(part) &&
          (part as Record<string, unknown>).type === "text" &&
          typeof (part as Record<string, unknown>).text === "string",
      )
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (text.length > 0) {
      return text;
    }
  }

  return null;
}

function sendJson(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== socket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(payload));
}

export function runPipeline(socket: WebSocket, deps: PipelineDeps): PipelineHandle {
  const { subagent, cfg, sttProvider, ttsProvider } = deps;

  if (!sttProvider) {
    sendJson(socket, { event: "error", message: "No RealtimeTranscriptionProvider configured" });
    socket.close(1011, "Missing STT provider");
    return { cleanup: () => undefined };
  }

  if (!ttsProvider) {
    sendJson(socket, { event: "error", message: "No SpeechProvider configured" });
    socket.close(1011, "Missing TTS provider");
    return { cleanup: () => undefined };
  }

  const activeSttProvider = sttProvider;
  const activeTtsProvider = ttsProvider;

  let isCleaningUp = false;
  let currentAbort: AbortController | null = null;
  let transcriptionSession: ReturnType<typeof activeSttProvider.createSession> | null = null;
  let mediaFrameCount = 0;

  function debug(message: string): void {
    if (deps.debug) {
      deps.onDebug(message);
    }
  }

  function resolveSttRawConfig(): Record<string, unknown> {
    if (deps.sttProviderConfig) {
      return deps.sttProviderConfig;
    }
    if (activeSttProvider.id === "deepgram") {
      return {
        providers: {
          deepgram: {
            encoding: "linear16",
            sampleRate: 16000,
            interimResults: true,
          },
        },
      };
    }
    return {};
  }

  function handleBargeIn(): void {
    if (currentAbort) {
      currentAbort.abort();
      currentAbort = null;
    }
    sendJson(socket, { event: "clear" });
  }

  async function handleAgentTurn(transcript: string): Promise<void> {
    if (isCleaningUp) {
      return;
    }

    if (currentAbort) {
      currentAbort.abort();
    }

    const abort = new AbortController();
    currentAbort = abort;
    const sessionKey = crypto.randomUUID();

    try {
      debug(`final transcript: ${transcript}`);
      const { runId } = await subagent.run({
        sessionKey,
        message: transcript,
        deliver: false,
      });

      if (abort.signal.aborted) {
        return;
      }

      const result = await subagent.waitForRun({ runId, timeoutMs: 30_000 });
      if (abort.signal.aborted) {
        return;
      }

      if (result.status !== "ok") {
        sendJson(socket, { event: "error", message: "Agent run failed" });
        return;
      }

      const { messages } = await subagent.getSessionMessages({ sessionKey, limit: 5 });
      if (abort.signal.aborted) {
        return;
      }

      const responseText = extractAssistantText(messages);
      if (!responseText) {
        debug("agent returned no assistant text");
        return;
      }
      debug(`assistant response text length: ${responseText.length}`);

      const ttsProviderConfig =
        activeTtsProvider.resolveConfig?.({
          cfg,
          rawConfig: deps.ttsProviderConfig ?? resolveTtsRawConfig(cfg),
          timeoutMs: 30_000,
        }) ?? {};

      const synthesis = await activeTtsProvider.synthesize({
        text: responseText,
        cfg,
        providerConfig: ttsProviderConfig,
        target: "audio-file",
        timeoutMs: 30_000,
      });

      if (abort.signal.aborted) {
        return;
      }

      sendJson(socket, {
        event: "media",
        media: { payload: synthesis.audioBuffer.toString("base64") },
      });
      debug(`sent tts audio bytes: ${synthesis.audioBuffer.byteLength}`);
      sendJson(socket, { event: "turn_end" });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      console.error("[websocket-voice] Agent/TTS error:", error);
      sendJson(socket, { event: "error", message: "Agent or TTS failed" });
    } finally {
      if (currentAbort === abort) {
        currentAbort = null;
      }
    }
  }

  function startTranscriptionSession(): void {
    if (isCleaningUp) {
      return;
    }

    try {
      const sttRawConfig = resolveSttRawConfig();
      debug(`starting STT provider=${activeSttProvider.id}`);
      transcriptionSession = activeSttProvider.createSession({
        providerConfig: activeSttProvider.resolveConfig?.({ cfg, rawConfig: sttRawConfig }) ?? {},
        onPartial: (partial: string) => {
          debug(`partial transcript: ${partial}`);
          sendJson(socket, { event: "transcript", text: partial, isFinal: false });
        },
        onTranscript: async (transcript: string) => {
          sendJson(socket, { event: "transcript", text: transcript, isFinal: true });
          if (transcript.trim().length > 0) {
            await handleAgentTurn(transcript);
          }
        },
        onSpeechStart: () => {
          handleBargeIn();
        },
        onError: (error: Error) => {
          console.error("[websocket-voice] STT error:", error);
          sendJson(socket, { event: "error", message: "Transcription error" });
        },
      });
      void transcriptionSession.connect();
    } catch (error: unknown) {
      console.error("[websocket-voice] Failed to create STT session:", error);
      sendJson(socket, { event: "error", message: "Failed to initialize STT" });
      socket.close(1011, "STT init failed");
    }
  }

  socket.on("message", (data: import("ws").RawData) => {
    if (isCleaningUp) {
      return;
    }

    try {
      const message = JSON.parse(rawDataToString(data)) as Record<string, unknown>;
      if (message.event === "start") {
        debug("client sent start");
        startTranscriptionSession();
        return;
      }

      if (message.event === "media") {
        if (transcriptionSession?.isConnected()) {
          const media = message.media;
          if (media && typeof media === "object" && !Array.isArray(media)) {
            const payload = (media as Record<string, unknown>).payload;
            if (typeof payload === "string") {
              const audio = Buffer.from(payload, "base64");
              mediaFrameCount += 1;
              if (mediaFrameCount === 1 || mediaFrameCount % 50 === 0) {
                debug(`received audio frames=${mediaFrameCount} lastBytes=${audio.byteLength}`);
              }
              transcriptionSession.sendAudio(audio);
            }
          }
        }
        return;
      }

      if (message.event === "stop") {
        cleanup();
        socket.close();
      }
    } catch {
      // Ignore malformed client events.
    }
  });

  function cleanup(): void {
    if (isCleaningUp) {
      return;
    }

    isCleaningUp = true;
    if (currentAbort) {
      currentAbort.abort();
      currentAbort = null;
    }

    if (transcriptionSession) {
      try {
        transcriptionSession.close();
      } catch {
        // Ignore close errors.
      }
      transcriptionSession = null;
    }
  }

  return { cleanup };
}
