# WebSocket Voice

Native bidirectional voice streaming over WebSockets for OpenClaw.

## Build

```bash
pnpm --dir extensions/websocket-voice build
```

## Pack

```bash
pnpm --dir extensions/websocket-voice pack
```

## Install locally

```bash
pnpm openclaw plugins install extensions/websocket-voice/cheeko-ai-websocket-voice-2026.4.27.tgz --force
pnpm openclaw plugins enable websocket-voice
pnpm openclaw gateway restart
```
