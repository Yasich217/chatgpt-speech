# ChatGPT Speech Dictation

Local VS Code extension for ChatGPT web push-to-talk dictation.

1. Run `ChatGPT Speech: Toggle Dictation` or press `Ctrl+Alt+D`.
2. Speak while switching tabs or minimizing VS Code.
3. Run the same command again.
4. The extension stops recording, sends the completed WAV to ChatGPT web transcription, and inserts the returned text into the last captured editor cursor.

Recording is done by an external `ffmpeg` process. Transcription happens only after recording stops, so VS Code focus changes do not break dictation.

## Remote SSH

The extension runs as a VS Code UI extension. Even when the folder is opened through Remote SSH, recording, `ffmpeg`, the Chrome helper, `${home}`, and `${tmpdir}` stay on the local machine where VS Code and the microphone are available. Text insertion still goes through the VS Code API, so it works in remote editors.

If settings use `${workspaceFolder}`, it is expanded only for local `file://` workspaces. In an SSH workspace it becomes empty because local `ffmpeg` and Chrome should not receive a remote path as their working directory.

## Auth

The extension intentionally has only ChatGPT web auth paths:

- `ChatGPT Speech: Refresh Web Session`: opens a Chrome helper profile, lets you sign in or pass the challenge, captures the ChatGPT session JSON and cookies, then stores them under `${home}/.chatgpt-speech/`.
- `chatgptSpeech.auth.webSessionTokenPath`: points to a ChatGPT session JSON file or raw bearer token. The default is `${home}/.chatgpt-speech/session.json`. When this token expires, saved cookies are used to refresh it through `https://chatgpt.com/api/auth/session`.
- `ChatGPT Speech: Set ChatGPT Session Token`: paste a raw `accessToken` or the full JSON from `https://chatgpt.com/api/auth/session`.

Visible settings:

- `chatgptSpeech.auth.tokenSource`: `webSessionFile`, `user`, or `codex`. `codex` reads `${home}/.codex/auth.json` before each request and does not copy it into the extension session.
- `chatgptSpeech.auth.token`: raw ChatGPT token when `tokenSource = user`.
- `chatgptSpeech.auth.webSessionTokenPath`: file path for saved session JSON/raw token.
- `chatgptSpeech.externalCallbacks.allowedDomains`: user-level allowlist for external session callbacks. Empty by default.
- `chatgptSpeech.externalCallbacks.caFile`: optional PEM CA file for an approved callback.
- `chatgptSpeech.transcription.language`: language hint, for example `ru` or `en`.
- `chatgptSpeech.insert.trimTranscript`: trim the final transcript before insertion.
- `chatgptSpeech.recorder.command`: recorder executable on the VS Code UI host. Defaults to `ffmpeg`.
- `chatgptSpeech.recorder.args`: recorder arguments. Leave empty for platform defaults.

## ChatGPT Web Transcription

The extension posts audio directly to:

- Endpoint: `https://chatgpt.com/backend-api/transcribe`
- Method: `POST`
- Body: `multipart/form-data`
- File field: `file`
- Success response: JSON with `text`

If a saved web token expires, the extension first refreshes it from saved ChatGPT cookies. If the request hits a challenge or the cookies are no longer valid, run `ChatGPT Speech: Refresh Web Session` from the error action. It opens the helper browser, captures fresh session/cookies, and can retry the failed dictation.

## External Session Callbacks

An external application can request a fresh session by opening this URI, with its one-time HTTPS callback URL percent-encoded in the query:

```text
vscode://yasich217.chatgpt-speech/refresh-session?callback=https%3A%2F%2Fauth.example.com%2Fone-time-callback
```

This integration is deny-by-default. The extension rejects the URI before opening Chrome unless the callback hostname is listed in the user-level `chatgptSpeech.externalCallbacks.allowedDomains` setting:

```json
{
  "chatgptSpeech.externalCallbacks.allowedDomains": [
    "auth.example.com",
    "*.callbacks.example.net"
  ]
}
```

Plain entries match exactly; wildcard entries match subdomains but not the parent domain. Callback URLs must use HTTPS on the default port and cannot contain URL credentials or fragments. Workspace settings cannot grant callback access. Redirects are not followed.

After session capture, the extension sends one JSON `POST` containing `token_json`, `cookie`, `user_agent`, `source`, `source_device_id`, and `notify_devices`. Treat the callback as a secret-bearing credential endpoint. No callback domain or private CA path is built into the extension; configure `chatgptSpeech.externalCallbacks.caFile` only when the approved endpoint uses a private CA.

## Development

```bash
npm install
npm run compile
npx vsce package
code --install-extension chatgpt-speech-1.1.0.vsix --force
```

Then press `F5` in VS Code and choose the `Run Extension` configuration.

## Project Structure

- `src/extension.ts`: extension activation, commands, recording, transcription dispatch, and editor insertion.
- `src/external/sessionCallback.ts`: callback URL policy and bounded HTTPS session delivery.
- `src/web/session.ts`: ChatGPT web session capture, cookies, CDP polling, and challenge handling.
- `src/platform/browser.ts`: platform-dependent browser discovery and helper profile preparation.

## Recorder

`ffmpeg` must be installed on the machine running the VS Code UI extension. In Remote SSH windows that is still your local desktop, not the SSH host. If `ffmpeg` is missing, dictation stops before auth/transcription and shows a recorder-specific error. Install `ffmpeg`, make sure it is on `PATH`, or set `chatgptSpeech.recorder.command` to the full executable path.

Default recorders:

- Linux: PulseAudio input `default`.
- macOS: AVFoundation input `:0`.
- Windows: DirectShow input `audio=default`.

Linux default command:

```bash
ffmpeg -hide_banner -loglevel error -y -f pulse -i default -ac 1 -ar 16000 /tmp/chatgpt-speech/dictation.wav
```

Override it if your microphone device needs another input:

```json
{
  "chatgptSpeech.recorder.command": "ffmpeg",
  "chatgptSpeech.recorder.args": [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "pulse",
    "-i",
    "alsa_input.pci-0000_00_1f.3.analog-stereo",
    "-ac",
    "1",
    "-ar",
    "16000",
    "${file}"
  ]
}
```
