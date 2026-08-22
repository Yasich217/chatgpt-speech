# ChatGPT Speech Dictation

Локальное расширение VS Code для ChatGPT web диктовки по кнопке.

1. Запусти `ChatGPT Speech: включить/остановить диктовку` или нажми `Ctrl+Alt+D`.
2. Говори, можно переключаться между окнами.
3. Запусти ту же команду ещё раз.
4. Расширение остановит запись, отправит готовый WAV в ChatGPT web transcription и вставит текст в последний курсор редактора.

Запись делает внешний `ffmpeg`. Распознавание выполняется после остановки записи, поэтому смена фокуса VS Code не ломает диктовку.

## Remote SSH

Расширение запускается как VS Code UI extension. Даже если открыта папка через Remote SSH, запись, `ffmpeg`, Chrome helper, `${home}` и `${tmpdir}` остаются на локальном компьютере, где работает VS Code и доступен микрофон. Вставка текста выполняется через VS Code API, поэтому она работает и в remote-редакторах.

Если в настройках используется `${workspaceFolder}`, он подставляется только для локальных `file://` workspace. В SSH workspace это значение пустое, потому что локальный `ffmpeg` и Chrome не должны получать remote path как рабочий каталог.

## Авторизация

В расширении намеренно остались только ChatGPT web способы авторизации:

- `ChatGPT Speech: обновить web-сессию`: открывает Chrome helper profile, даёт войти или пройти challenge, забирает ChatGPT session JSON и cookies, затем сохраняет их в `${home}/.chatgpt-speech/`.
- `chatgptSpeech.auth.webSessionTokenPath`: путь к ChatGPT session JSON или raw bearer token. По умолчанию `${home}/.chatgpt-speech/session.json`. Когда токен истекает, сохранённые cookies используются для обновления через `https://chatgpt.com/api/auth/session`.
- `ChatGPT Speech: задать ChatGPT session token`: вставка raw `accessToken` или полного JSON с `https://chatgpt.com/api/auth/session`.

Видимые настройки:

- `chatgptSpeech.auth.tokenSource`: `webSessionFile`, `user` или `codex`. `codex` читает `${home}/.codex/auth.json` перед каждым запросом и не копирует его в session-файлы расширения.
- `chatgptSpeech.auth.token`: raw ChatGPT token, когда `tokenSource = user`.
- `chatgptSpeech.auth.webSessionTokenPath`: путь к session JSON/raw token.
- `chatgptSpeech.externalCallbacks.allowedDomains`: пользовательский allowlist внешних session callback. По умолчанию пуст.
- `chatgptSpeech.externalCallbacks.caFile`: необязательный PEM-файл CA для разрешённого callback.
- `chatgptSpeech.transcription.language`: подсказка языка, например `ru` или `en`.
- `chatgptSpeech.insert.trimTranscript`: обрезать пробелы перед вставкой.
- `chatgptSpeech.recorder.command`: исполняемый файл recorder на VS Code UI host. По умолчанию `ffmpeg`.
- `chatgptSpeech.recorder.args`: аргументы recorder. Пустой список включает платформенные значения по умолчанию.

## ChatGPT Web Transcription

Расширение отправляет аудио напрямую в:

- Endpoint: `https://chatgpt.com/backend-api/transcribe`
- Method: `POST`
- Body: `multipart/form-data`
- File field: `file`
- Success response: JSON с `text`

Если сохранённый web token истёк, расширение сначала обновит его из сохранённых ChatGPT cookies. Если запрос упёрся в challenge или cookies уже невалидны, нажми действие `ChatGPT Speech: обновить web-сессию` в ошибке. Расширение откроет helper browser, обновит session/cookies и сможет повторить упавшую диктовку.

## Внешние session callback

Внешнее приложение может запросить свежую сессию, открыв URI с одноразовым HTTPS callback, закодированным в query:

```text
vscode://yasich217.chatgpt-speech/refresh-session?callback=https%3A%2F%2Fauth.example.com%2Fone-time-callback
```

По умолчанию интеграция запрещена. Расширение отклонит URI ещё до запуска Chrome, если hostname callback отсутствует в пользовательской настройке `chatgptSpeech.externalCallbacks.allowedDomains`:

```json
{
  "chatgptSpeech.externalCallbacks.allowedDomains": [
    "auth.example.com",
    "*.callbacks.example.net"
  ]
}
```

Обычная запись совпадает с доменом точно; wildcard разрешает поддомены, но не сам родительский домен. Callback обязан использовать HTTPS на стандартном порту и не может содержать URL credentials или fragment. Workspace-настройки не могут выдать такое разрешение. Redirect не выполняется.

После захвата сессии расширение отправляет один JSON `POST` с полями `token_json`, `cookie`, `user_agent`, `source`, `source_device_id` и `notify_devices`. Callback нужно считать credential endpoint с секретами. В расширении нет встроенного домена callback или пути к приватному CA; `chatgptSpeech.externalCallbacks.caFile` задаётся только для разрешённого endpoint с собственным CA.

## Разработка

```bash
npm install
npm run compile
npx vsce package
code --install-extension chatgpt-speech-1.1.0.vsix --force
```

Для отладки нажми `F5` в VS Code и выбери конфигурацию `Run Extension`.

## Структура проекта

- `src/extension.ts`: активация расширения, команды, запись, распознавание и вставка.
- `src/external/sessionCallback.ts`: политика callback URL и ограниченная HTTPS-передача сессии.
- `src/web/session.ts`: ChatGPT web session, cookies, CDP capture и challenge handling.
- `src/platform/browser.ts`: платформенно-зависимый выбор Chrome и подготовка helper profile.

## Recorder

`ffmpeg` должен быть установлен на машине, где запущен VS Code UI extension. В окне Remote SSH это всё равно локальный компьютер, а не SSH host. Если `ffmpeg` не найден, диктовка остановится до авторизации/распознавания и покажет ошибку recorder. Установи `ffmpeg`, добавь его в `PATH` или укажи полный путь в `chatgptSpeech.recorder.command`.

Значения по умолчанию:

- Linux: PulseAudio input `default`.
- macOS: AVFoundation input `:0`.
- Windows: DirectShow input `audio=default`.

Дефолтная команда Linux:

```bash
ffmpeg -hide_banner -loglevel error -y -f pulse -i default -ac 1 -ar 16000 /tmp/chatgpt-speech/dictation.wav
```

Если нужен другой микрофон:

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
