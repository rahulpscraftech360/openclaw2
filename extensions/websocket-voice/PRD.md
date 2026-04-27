# Product Requirements Document (PRD)
## OpenClaw Direct WebSocket Voice Streaming Plugin

### 1. Overview & Objectives
**Goal:** Develop a production-grade OpenClaw extension (`websocket-voice`) that exposes a secure, bidirectional WebSocket endpoint for streaming audio directly between client applications (web/mobile) and OpenClaw's AI voice providers.
**Why:** To reduce latency, eliminate telephony provider costs (Twilio/Telnyx), and provide a native, high-fidelity voice experience for end-users interacting with OpenClaw agents.

### 2. Architecture & System Design
The plugin acts as a standalone **Voice AI Engine** (Pipeline Mode) that orchestrates STT, LLM, and TTS providers.
It uses OpenClaw's official `registerSpeechProvider` (TTS) and `registerRealtimeTranscriptionProvider` (STT) hooks.

*   **Ingress (Client -> Server):** The Fastify WebSocket server receives binary audio frames or JSON-wrapped Base64 audio, and pipes it to `RealtimeTranscriptionProvider.transcribeStream()`.
*   **Agent Processing:** When the STT provider emits an `onTranscript(isFinal=true)` event, the plugin pauses STT and triggers the OpenClaw Agent (LLM) to generate a text response.
*   **Egress (Server -> Client):** The LLM's streaming text is sent to `SpeechProvider.synthesizeStream()`. The resulting audio chunks are streamed back down the WebSocket to the client.
*   **Interruption (Barge-in):** If the STT detects speech while the bot is playing audio, the plugin immediately sends an `{"event": "clear"}` signal to the client to stop playback, cancels the current LLM/TTS generation, and listens to the new user input.

### 3. Core Requirements

#### 3.1 Connection & Protocol
*   **Endpoint:** Expose a secure `wss://<openclaw-host>/api/voice/stream` route using Fastify WebSockets.
*   **Protocol Design:** JSON-based envelope protocol multiplexing audio with control signals.
    *   `{"event": "start", "config": {"sampleRate": 16000, "encoding": "pcm_16bit"}}`
    *   `{"event": "media", "media": {"payload": "<base64_audio_chunk>"}}`
    *   `{"event": "clear"}` (Server -> Client: Stop playing audio)
    *   `{"event": "stop"}`

#### 3.2 OpenClaw Integration
*   Use `api.runtime.getRealtimeTranscriptionProvider()` to get the STT provider.
*   Use `api.runtime.getSpeechProvider()` to get the TTS provider.
*   Zero modifications to OpenClaw's core code. Packaged as a standalone extension using `openclaw.plugin.json`.

#### 3.3 Security & Authentication
*   **Authentication:** Token-based authentication via query string (`?token=xyz`) or initial `auth` message.
*   **Rate Limiting:** Enforce strict connection limits per IP/User to prevent abuse.
*   **Payload Limits:** Limit WebSocket frame sizes to prevent memory exhaustion attacks.

#### 3.4 Production Reliability
*   **Graceful Shutdown:** Close all active WebSocket connections and AI provider bridges when the server stops.
*   **Memory Leaks:** Strict garbage collection of audio buffers and streams on disconnect.
*   **Error Handling:** Surface detailed, non-sensitive errors to the client while logging stack traces internally.

### 4. Implementation Phases (Execution Plan)
1.  **Phase 1: Scaffolding & Configuration**
    *   Create extension directory `extensions/websocket-voice`.
    *   Define `openclaw.plugin.json`, `package.json`, `tsconfig.json`.
2.  **Phase 2: WebSocket Server & Auth**
    *   Register a Fastify WebSocket route in `register(api)`.
3.  **Phase 3: The Pipeline Orchestrator**
    *   Implement the STT -> LLM -> TTS pipeline.
    *   Handle bidirectional audio flow and buffer management.
4.  **Phase 4: Interruption Handling**
    *   Handle barge-in to ensure the client stops playing stale audio when the user interrupts.
