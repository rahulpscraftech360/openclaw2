import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export function runPipeline(socket: import("ws").WebSocket, api: OpenClawPluginApi) {
  let isCleaningUp = false;
  let isBotSpeaking = false;
  let currentGenerationAbortController: AbortController | null = null;

  // 1. Resolve configured STT and TTS Providers
  const config = api.pluginConfig as any;
  const sttProviderId = config?.sttProvider;
  const ttsProviderId = config?.ttsProvider;

  const sttProvider = api.runtime.getRealtimeTranscriptionProvider(sttProviderId);
  const ttsProvider = api.runtime.getSpeechProvider(ttsProviderId);

  if (!sttProvider) {
    socket.send(JSON.stringify({ event: "error", message: "No RealtimeTranscriptionProvider found" }));
    socket.close(1011, "Missing STT Provider");
    return { cleanup };
  }

  if (!ttsProvider) {
    socket.send(JSON.stringify({ event: "error", message: "No SpeechProvider found" }));
    socket.close(1011, "Missing TTS Provider");
    return { cleanup };
  }

  // 2. Setup RealtimeTranscription Stream
  let transcriptionStream: any;
  
  async function initializeTranscription() {
    try {
      transcriptionStream = await sttProvider.transcribeStream({
        sampleRate: 16000,
        encoding: "linear16", // Default expected from client
        onTranscript: async (text: string, isFinal: boolean) => {
          if (isCleaningUp) return;

          // Send partial/final transcript back to the client
          socket.send(JSON.stringify({ event: "transcript", text, isFinal }));

          // Interruption handling (barge-in)
          if (isBotSpeaking && text.trim().length > 0) {
            handleBargeIn();
          }

          if (isFinal && text.trim().length > 0) {
            await handleAgentTurn(text);
          }
        },
        onError: (err) => {
          console.error("[websocket-voice] STT Error:", err);
          socket.send(JSON.stringify({ event: "error", message: "Transcription error" }));
        },
        onClose: () => {
          console.log("[websocket-voice] STT Stream closed");
        },
      });
    } catch (err) {
      console.error("[websocket-voice] Failed to start transcription stream:", err);
      socket.send(JSON.stringify({ event: "error", message: "Failed to initialize STT" }));
      socket.close(1011, "STT Init Failed");
    }
  }

  // 3. Handle Barge-In
  function handleBargeIn() {
    console.log("[websocket-voice] User interrupted (barge-in detected)");
    
    // Stop the client from playing any buffered audio
    socket.send(JSON.stringify({ event: "clear" }));
    
    // Cancel the ongoing LLM / TTS generation
    if (currentGenerationAbortController) {
      currentGenerationAbortController.abort();
      currentGenerationAbortController = null;
    }
    
    isBotSpeaking = false;
  }

  // 4. Handle LLM Agent + TTS Turn
  async function handleAgentTurn(userInput: string) {
    if (isCleaningUp) return;
    
    // Cancel any previous turn
    if (currentGenerationAbortController) {
      currentGenerationAbortController.abort();
    }
    currentGenerationAbortController = new AbortController();
    const abortSignal = currentGenerationAbortController.signal;

    try {
      // 4a. Run the OpenClaw LLM Agent
      // We assume api.runtime.agent exposes a completion stream or similar.
      // (Using a placeholder for the exact agent method, adapted to openclaw's standard runtime agent)
      const agentStream = await api.runtime.agent.chat({
        messages: [{ role: "user", content: userInput }],
        signal: abortSignal,
      });

      isBotSpeaking = true;
      let fullResponse = "";

      for await (const chunk of agentStream) {
        if (abortSignal.aborted) break;
        fullResponse += chunk.content || "";
      }

      if (abortSignal.aborted) return;

      // 4b. Stream the text to TTS Provider
      const ttsStream = await ttsProvider.synthesizeStream({
        text: fullResponse,
        sampleRate: 16000,
      });

      // 4c. Send synthesized audio chunks back to WebSocket client
      for await (const audioChunk of ttsStream) {
        if (abortSignal.aborted) break;
        
        socket.send(JSON.stringify({
          event: "media",
          media: { payload: audioChunk.toString("base64") }
        }));
      }

      isBotSpeaking = false;
      currentGenerationAbortController = null;

    } catch (err: any) {
      if (err.name === "AbortError") {
        console.log("[websocket-voice] Agent/TTS turn aborted");
      } else {
        console.error("[websocket-voice] Agent/TTS error:", err);
      }
      isBotSpeaking = false;
    }
  }

  // 5. Handle incoming WebSocket messages
  socket.on("message", (data: import("ws").RawData) => {
    if (isCleaningUp) return;

    try {
      const message = JSON.parse(data.toString());
      
      if (message.event === "start") {
        console.log("[websocket-voice] Received start event");
        // We could extract sampleRate here and pass to initializeTranscription
        initializeTranscription();
      } else if (message.event === "media") {
        if (transcriptionStream && !isBotSpeaking) {
          // Decode base64 audio payload and push to STT
          const buffer = Buffer.from(message.media.payload, "base64");
          transcriptionStream.write(buffer);
        }
      } else if (message.event === "stop") {
        console.log("[websocket-voice] Received stop event");
        cleanup();
        socket.close();
      }
    } catch (err) {
      console.error("[websocket-voice] Error parsing message:", err);
    }
  });

  // 6. Cleanup function
  function cleanup() {
    if (isCleaningUp) return;
    isCleaningUp = true;
    
    if (currentGenerationAbortController) {
      currentGenerationAbortController.abort();
    }
    
    if (transcriptionStream) {
      try {
        transcriptionStream.close();
      } catch (e) {
        // Ignore close errors
      }
    }
  }

  return { cleanup };
}
