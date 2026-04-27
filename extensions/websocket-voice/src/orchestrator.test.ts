import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
} from "openclaw/plugin-sdk/realtime-transcription";
import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/speech";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WebSocket } from "ws";
import { runPipeline } from "./orchestrator.js";
import type { PipelineDeps } from "./orchestrator.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSocket(readyState = 1 /* OPEN */) {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const sent: string[] = [];
  const socket = {
    readyState,
    OPEN: 1 as const,
    send: vi.fn((data: string) => sent.push(data)),
    close: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event]!.push(handler);
    }),
    /** Fire a named event on this mock socket. */
    emit(event: string, ...args: unknown[]) {
      for (const h of listeners[event] ?? []) h(...args);
    },
    sent,
  };
  return socket as unknown as WebSocket & {
    sent: string[];
    emit: (event: string, ...args: unknown[]) => void;
  };
}

function makeSession(): RealtimeTranscriptionSession & {
  _cbs: Record<string, (...a: unknown[]) => void>;
} {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    sendAudio: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    _cbs: {},
  };
}

function makeDeps(): PipelineDeps & {
  session: ReturnType<typeof makeSession>;
  synthesisMock: ReturnType<typeof vi.fn>;
} {
  const session = makeSession();

  const synthesisMock = vi.fn().mockResolvedValue({
    audioBuffer: Buffer.from("audio-bytes"),
    outputFormat: "mp3",
    fileExtension: "mp3",
    voiceCompatible: true,
  });

  const sttProvider = {
    id: "mock-stt",
    label: "Mock STT",
    isConfigured: () => true,
    createSession: vi.fn().mockReturnValue(session),
  } as unknown as RealtimeTranscriptionProviderPlugin;

  const ttsProvider = {
    id: "mock-tts",
    label: "Mock TTS",
    isConfigured: () => true,
    synthesize: synthesisMock,
  } as unknown as SpeechProviderPlugin;

  const subagent: PipelineDeps["subagent"] = {
    run: vi.fn().mockResolvedValue({ runId: "run-1" }),
    waitForRun: vi.fn().mockResolvedValue({ status: "ok" }),
    getSessionMessages: vi.fn().mockResolvedValue({
      messages: [{ role: "assistant", content: "Hello from bot" }],
    }),
    getSession: vi.fn().mockResolvedValue({ messages: [] }),
    deleteSession: vi.fn().mockResolvedValue(undefined),
  };

  return {
    subagent,
    cfg: {} as PipelineDeps["cfg"],
    sttProvider,
    ttsProvider,
    session,
    synthesisMock,
  };
}

function parseSent(socket: ReturnType<typeof makeSocket>) {
  return socket.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runPipeline", () => {
  let deps: ReturnType<typeof makeDeps>;
  let socket: ReturnType<typeof makeSocket>;

  beforeEach(() => {
    deps = makeDeps();
    socket = makeSocket();
  });

  // Helper: start session and return captured callbacks
  function startSession() {
    runPipeline(socket, deps);
    socket.emit("message", JSON.stringify({ event: "start" }));
    const createSessionMock = vi.mocked(
      (deps.sttProvider as { createSession: ReturnType<typeof vi.fn> }).createSession,
    );
    return createSessionMock.mock.calls[0]![0] as {
      onPartial?: (t: string) => void;
      onTranscript?: (t: string) => Promise<void> | void;
      onSpeechStart?: () => void;
      onError?: (e: Error) => void;
    };
  }

  it('{"event":"start"} creates STT session and calls connect()', () => {
    startSession();
    expect(
      (deps.sttProvider as { createSession: ReturnType<typeof vi.fn> }).createSession,
    ).toHaveBeenCalledOnce();
    expect(deps.session.connect).toHaveBeenCalledOnce();
  });

  it('{"event":"media"} while connected calls sendAudio with decoded buffer', () => {
    startSession();
    const payload = Buffer.from("pcm-data").toString("base64");
    socket.emit("message", JSON.stringify({ event: "media", media: { payload } }));
    expect(deps.session.sendAudio).toHaveBeenCalledWith(Buffer.from("pcm-data"));
  });

  it('{"event":"media"} before start does not crash and does not call sendAudio', () => {
    runPipeline(socket, deps);
    const payload = Buffer.from("early").toString("base64");
    expect(() =>
      socket.emit("message", JSON.stringify({ event: "media", media: { payload } })),
    ).not.toThrow();
    expect(deps.session.sendAudio).not.toHaveBeenCalled();
  });

  it('{"event":"stop"} closes the STT session and the socket', () => {
    startSession();
    socket.emit("message", JSON.stringify({ event: "stop" }));
    expect(deps.session.close).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("cleanup() is idempotent — calling twice does not double-close", () => {
    const handle = runPipeline(socket, deps);
    startSession();
    handle.cleanup();
    handle.cleanup();
    expect(deps.session.close).toHaveBeenCalledTimes(1);
  });

  it("onTranscript fires subagent.run, synthesize, sends media + turn_end", async () => {
    const cbs = startSession();
    await cbs.onTranscript?.("Hello bot");

    expect(deps.subagent.run).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Hello bot", deliver: false }),
    );
    expect(deps.synthesisMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hello from bot", target: "audio-file" }),
    );
    const events = parseSent(socket);
    expect(events.some((e) => e.event === "media")).toBe(true);
    expect(events.some((e) => e.event === "turn_end")).toBe(true);
  });

  it("onTranscript with blank text skips agent turn", async () => {
    const cbs = startSession();
    await cbs.onTranscript?.("   ");
    expect(deps.subagent.run).not.toHaveBeenCalled();
  });

  it("onSpeechStart while bot is speaking sends clear event", async () => {
    const cbs = startSession();
    // Start a turn so isBotSpeaking becomes true mid-flight
    const turnPromise = cbs.onTranscript?.("first input");
    // Let waitForRun resolve so the pipeline reaches isBotSpeaking = true
    await vi.mocked(deps.subagent.waitForRun).mock.results[0]?.value;
    cbs.onSpeechStart?.();
    await turnPromise;

    const events = parseSent(socket);
    expect(events.some((e) => e.event === "clear")).toBe(true);
  });

  it("subagent.waitForRun status=error sends error event and keeps socket open", async () => {
    vi.mocked(deps.subagent.waitForRun).mockResolvedValue({ status: "error", error: "timeout" });

    const cbs = startSession();
    await cbs.onTranscript?.("input");

    const events = parseSent(socket);
    expect(events.some((e) => e.event === "error")).toBe(true);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("no assistant text in session messages skips TTS without crashing", async () => {
    vi.mocked(deps.subagent.getSessionMessages).mockResolvedValue({ messages: [] });

    const cbs = startSession();
    await cbs.onTranscript?.("something");

    expect(deps.synthesisMock).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("synthesize() throwing sends error event and keeps socket open", async () => {
    deps.synthesisMock.mockRejectedValue(new Error("TTS failed"));

    const cbs = startSession();
    await cbs.onTranscript?.("input");

    const events = parseSent(socket);
    expect(events.some((e) => e.event === "error")).toBe(true);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("missing sttProvider closes socket with 1011", () => {
    const depsNoStt: PipelineDeps = { ...deps, sttProvider: undefined };
    runPipeline(socket, depsNoStt);
    expect(socket.close).toHaveBeenCalledWith(1011, expect.any(String));
  });

  it("missing ttsProvider closes socket with 1011", () => {
    const depsNoTts: PipelineDeps = { ...deps, ttsProvider: undefined };
    runPipeline(socket, depsNoTts);
    expect(socket.close).toHaveBeenCalledWith(1011, expect.any(String));
  });
});
