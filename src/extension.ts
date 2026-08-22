import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  postExternalSessionCallback,
  validateExternalSessionCallback,
  type ExternalSessionPayload,
} from "./external/sessionCallback";
import {
  describeExtensionHost,
  expandWorkspaceFolderVar,
  localProcessCwd,
} from "./platform/vscodeHost";
import {
  getChatGptSessionUrl,
  getWebSessionCookiePath,
  isChatGptChallenge,
  readWebSessionUserAgent,
  refreshWebSessionFromCookies,
  refreshWebSession as refreshChatGptWebSession,
  type WebSessionCapture,
} from "./web/session";

type InsertionTarget = {
  uri: vscode.Uri;
  selections: vscode.Selection[];
  viewColumn?: vscode.ViewColumn;
};

type AuthToken = {
  value: string;
  source: string;
  expiresAt?: Date;
};

type ProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
};

type RecordingSession = {
  file: string;
  process: cp.ChildProcessWithoutNullStreams;
  closePromise: Promise<ProcessResult>;
  startedAt: number;
  target?: InsertionTarget;
};

type DeferredRetry = {
  file: string;
  target?: InsertionTarget;
};

type RefreshWebSessionOptions = {
  callbackUrl?: URL;
  retryAfter?: boolean;
};

let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let lastEditorTarget: InsertionTarget | undefined;
let recording: RecordingSession | undefined;
let lastDeferredRetry: DeferredRetry | undefined;
let lastTranscript: string | undefined;
let retryingDeferred = false;

function l10n(
  message: string,
  ...args: Array<string | number | boolean>
): string {
  return vscode.l10n.t(message, ...args);
}

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("ChatGPT Speech");
  status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  status.command = "chatgptSpeech.toggleDictation";
  context.subscriptions.push(output, status);

  if (vscode.window.activeTextEditor) {
    lastEditorTarget = captureTarget(vscode.window.activeTextEditor);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "chatgptSpeech.toggleDictation",
      toggleDictation,
    ),
    vscode.commands.registerCommand(
      "chatgptSpeech.startDictation",
      startDictation,
    ),
    vscode.commands.registerCommand(
      "chatgptSpeech.stopDictation",
      stopDictation,
    ),
    vscode.commands.registerCommand(
      "chatgptSpeech.retryLastDictation",
      retryLastDictation,
    ),
    vscode.commands.registerCommand(
      "chatgptSpeech.copyLastTranscript",
      copyLastTranscript,
    ),
    vscode.commands.registerCommand(
      "chatgptSpeech.setOpenAIApiKey",
      setApiToken,
    ),
    vscode.commands.registerCommand(
      "chatgptSpeech.openAuthSessionPage",
      openAuthSessionPage,
    ),
    vscode.commands.registerCommand("chatgptSpeech.refreshWebSession", () =>
      refreshWebSession({ retryAfter: false }),
    ),
    vscode.commands.registerCommand(
      "chatgptSpeech.refreshWebSessionAndRetry",
      () => refreshWebSession({ retryAfter: true }),
    ),
    vscode.commands.registerCommand("chatgptSpeech.showLog", () =>
      output.show(),
    ),
    vscode.window.registerUriHandler({ handleUri }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        lastEditorTarget = captureTarget(editor);
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      lastEditorTarget = captureTarget(event.textEditor);
    }),
  );

  updateStatus();
  output.appendLine("ChatGPT Speech activated.");
  output.appendLine(`[host] ${describeExtensionHost(context)}`);
}

export function deactivate() {
  if (recording) {
    recording.process.kill("SIGTERM");
  }
}

async function toggleDictation() {
  if (recording) {
    await stopDictation();
    return;
  }

  await startDictation();
}

async function startDictation() {
  if (recording) {
    vscode.window.showInformationMessage(l10n("Dictation is already active."));
    return;
  }

  const target = currentTarget();
  const file = await createAudioFilePath();

  try {
    const command = getConfig<string>("recorder.command", "ffmpeg").trim();
    const rawArgs = getConfig<string[]>("recorder.args", []);
    const args = (rawArgs.length ? rawArgs : defaultRecorderArgs()).map((arg) =>
      expandVars(arg, file),
    );
    await assertRecorderCommandAvailable(command);
    const authToken = await resolveAuthToken(true);

    output.appendLine(
      `[record] token source: ${authToken ? describeToken(authToken) : "none"}`,
    );
    output.appendLine(
      `[record] starting: ${command} ${args.map(quoteArg).join(" ")}`,
    );

    const child = cp.spawn(command, args, {
      cwd: localProcessCwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const closePromise = observeProcess(child);
    recording = {
      file,
      process: child,
      closePromise,
      startedAt: Date.now(),
      target,
    };

    await assertRecorderStarted(recording);
    updateStatus();
    await vscode.commands.executeCommand(
      "setContext",
      "chatgptSpeech.recording",
      true,
    );
    vscode.window.showInformationMessage(
      l10n(
        "Dictation recording started. Run the command again to stop and insert text.",
      ),
    );
  } catch (error) {
    recording = undefined;
    updateStatus();
    await vscode.commands.executeCommand(
      "setContext",
      "chatgptSpeech.recording",
      false,
    );
    showError(l10n("Could not start dictation recording"), error);
  }
}

async function stopDictation() {
  const session = recording;
  if (!session) {
    vscode.window.showInformationMessage(l10n("Dictation is not recording."));
    return;
  }

  recording = undefined;
  updateStatus(`$(sync~spin) ${l10n("Transcribing")}`);
  await vscode.commands.executeCommand(
    "setContext",
    "chatgptSpeech.recording",
    false,
  );

  try {
    output.appendLine(
      `[record] stopping after ${Math.round((Date.now() - session.startedAt) / 1000)}s`,
    );
    await stopRecorder(session.process, session.closePromise);
    await assertAudioFile(session.file);
    await processDeferredRecording(
      session.file,
      session.target ?? lastEditorTarget,
    );
  } catch (error) {
    lastDeferredRetry = {
      file: session.file,
      target: session.target ?? lastEditorTarget,
    };
    showError(l10n("Dictation failed"), error, { retry: true });
  } finally {
    updateStatus();
  }
}

async function processDeferredRecording(
  file: string,
  target: InsertionTarget | undefined,
) {
  const resolvedToken = await resolveAuthToken(true);
  const transcript = await transcribe(file, resolvedToken);
  const text = getConfig<boolean>("insert.trimTranscript", true)
    ? transcript.trim()
    : transcript;
  output.appendLine(`[transcribe] transcript length: ${text.length}`);
  if (!text) {
    vscode.window.showWarningMessage(
      l10n("Transcription returned empty text."),
    );
    return;
  }

  lastTranscript = text;
  output.appendLine("[insert] inserting transcript");
  const insertionResult = await insertTranscriptWithRecovery(target, text);
  lastDeferredRetry = undefined;
  if (insertionResult === "copied") {
    output.appendLine("[insert] transcript copied after insert failed");
    return;
  }
  output.appendLine("[insert] transcript inserted");
}

async function retryLastDictation() {
  if (retryingDeferred) {
    vscode.window.showInformationMessage(
      l10n("Dictation retry is already running."),
    );
    return;
  }

  const retry = lastDeferredRetry;
  if (!retry) {
    vscode.window.showInformationMessage(
      l10n("No failed dictation is available to retry."),
    );
    return;
  }

  retryingDeferred = true;
  updateStatus(`$(sync~spin) ${l10n("Retrying")}`);
  try {
    await assertAudioFile(retry.file);
    await processDeferredRecording(
      retry.file,
      retry.target ?? lastEditorTarget,
    );
  } catch (error) {
    showError(l10n("Dictation retry failed"), error, {
      retry: true,
    });
  } finally {
    retryingDeferred = false;
    updateStatus();
  }
}

async function copyLastTranscript() {
  if (!lastTranscript) {
    vscode.window.showInformationMessage(
      l10n("No transcript is available yet."),
    );
    return;
  }

  await vscode.env.clipboard.writeText(lastTranscript);
  vscode.window.showInformationMessage(
    l10n("Last transcript copied to clipboard."),
  );
}

async function refreshWebSession(
  options: RefreshWebSessionOptions = {},
): Promise<boolean> {
  const callbackUrl = options.callbackUrl;
  return refreshChatGptWebSession(options, {
    output,
    updateStatus,
    retryLastDictation,
    showError,
    extractAccessToken,
    publishCapture: callbackUrl
      ? (capture) => publishExternalSessionCapture(capture, callbackUrl)
      : undefined,
  });
}

async function handleUri(uri: vscode.Uri): Promise<void> {
  const requestedPath = uri.path.replace(/^\/+/, "");
  output.appendLine(
    `[external-callback] received VS Code URI path=${requestedPath || "<empty>"}`,
  );
  if (requestedPath !== "refresh-session") {
    vscode.window.showWarningMessage(
      l10n("Unknown ChatGPT Speech URI command: {0}", requestedPath || "/"),
    );
    return;
  }

  const params = new URLSearchParams(uri.query);
  const rawCallbackUrl =
    params.get("callback") ?? params.get("callback_url") ?? "";

  let callbackUrl: URL;
  try {
    callbackUrl = validateExternalSessionCallback(
      rawCallbackUrl,
      getGlobalConfig<string[]>("externalCallbacks.allowedDomains", []),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    output.appendLine(`[external-callback] rejected: ${reason}`);
    vscode.window.showWarningMessage(
      l10n("External session callback rejected: {0}", reason),
    );
    return;
  }

  output.appendLine("[external-callback] approved; refreshing web session");
  const refreshed = await refreshWebSession({ callbackUrl });
  if (refreshed) {
    vscode.window.showInformationMessage(
      l10n("ChatGPT web session sent to the approved external callback."),
    );
  }
}

async function publishExternalSessionCapture(
  capture: WebSessionCapture,
  callbackUrl: URL,
): Promise<void> {
  const body: ExternalSessionPayload = {
    token_json: JSON.stringify(
      capture.sessionJson ?? { accessToken: capture.accessToken },
    ),
    cookie: capture.cookieHeader,
    user_agent: capture.userAgent ?? "",
    source: "vscode-chatgpt-speech",
    source_device_id: "vscode-chatgpt-speech",
    notify_devices: true,
  };
  const caFile = getGlobalConfig<string>("externalCallbacks.caFile", "").trim();
  const ca = caFile ? await fs.readFile(expandGeneralVars(caFile)) : undefined;
  const result = await postExternalSessionCallback(callbackUrl, body, { ca });
  output.appendLine(
    `[external-callback] accepted: status=${result.statusCode}; responseBytes=${result.responseBytes}; tokenBytes=${Buffer.byteLength(body.token_json, "utf8")}; cookieBytes=${Buffer.byteLength(body.cookie, "utf8")}`,
  );
}

function currentTarget(): InsertionTarget | undefined {
  return vscode.window.activeTextEditor
    ? captureTarget(vscode.window.activeTextEditor)
    : lastEditorTarget;
}

function captureTarget(editor: vscode.TextEditor): InsertionTarget {
  return {
    uri: editor.document.uri,
    selections: editor.selections.map(
      (selection) => new vscode.Selection(selection.anchor, selection.active),
    ),
    viewColumn: editor.viewColumn,
  };
}

async function createAudioFilePath(): Promise<string> {
  const dir = path.join(os.tmpdir(), "chatgpt-speech");
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, `dictation-${Date.now()}.wav`);
}

function defaultRecorderArgs(): string[] {
  if (process.platform === "darwin") {
    return [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "avfoundation",
      "-i",
      ":0",
      "-ac",
      "1",
      "-ar",
      "16000",
      "${file}",
    ];
  }

  if (process.platform === "win32") {
    return [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "dshow",
      "-i",
      "audio=default",
      "-ac",
      "1",
      "-ar",
      "16000",
      "${file}",
    ];
  }

  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "pulse",
    "-i",
    "default",
    "-ac",
    "1",
    "-ar",
    "16000",
    "${file}",
  ];
}

async function assertRecorderCommandAvailable(command: string) {
  if (!command) {
    throw new Error(l10n("Recorder command is empty."));
  }

  const found = await resolveExecutable(command);
  if (!found) {
    throw new Error(
      l10n(
        'Recorder command "{0}" was not found on the VS Code UI host. Install ffmpeg there or set chatgptSpeech.recorder.command to a full path.',
        command,
      ),
    );
  }
}

async function resolveExecutable(command: string): Promise<string | undefined> {
  const normalized = stripWrappingQuotes(command);
  if (hasPathSeparator(normalized)) {
    for (const candidate of executableCandidates(normalized)) {
      if (await canExecute(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const candidate of executableCandidates(path.join(dir, normalized))) {
      if (await canExecute(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function hasPathSeparator(value: string): boolean {
  return path.isAbsolute(value) || value.includes("/") || value.includes("\\");
}

function executableCandidates(file: string): string[] {
  if (process.platform !== "win32" || path.extname(file)) {
    return [file];
  }

  const pathExt = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  return pathExt
    .split(";")
    .filter(Boolean)
    .map((extension) => `${file}${extension.toLowerCase()}`);
}

async function canExecute(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) {
      return false;
    }

    if (process.platform === "win32") {
      return true;
    }

    await fs.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function observeProcess(
  child: cp.ChildProcessWithoutNullStreams,
): Promise<ProcessResult> {
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk.toString());
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderr = appendBounded(stderr, text);
    output.append(text);
  });

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}

async function assertRecorderStarted(
  session: Pick<RecordingSession, "closePromise">,
) {
  const earlyExit = await Promise.race([
    session.closePromise.then((result) => ({ result })),
    delay(800).then(() => undefined),
  ]);

  if (earlyExit) {
    throw new Error(
      l10n(
        "Recorder exited early with code {0}: {1}",
        earlyExit.result.code ?? "null",
        earlyExit.result.stderr.trim(),
      ),
    );
  }
}

async function stopRecorder(
  processToStop: cp.ChildProcessWithoutNullStreams,
  closePromise: Promise<ProcessResult>,
) {
  if (!processToStop.killed && processToStop.stdin.writable) {
    processToStop.stdin.write("q");
    processToStop.stdin.end();
  }

  const result = await Promise.race([
    closePromise,
    delay(5000).then(async () => {
      processToStop.kill("SIGTERM");
      return closePromise;
    }),
  ]);

  output.appendLine(
    `[record] recorder closed: code=${result.code ?? "null"} signal=${result.signal ?? "null"}`,
  );
}

async function assertAudioFile(file: string) {
  const stat = await fs.stat(file);
  if (stat.size <= 44) {
    throw new Error(l10n("Recorded audio is empty: {0}", file));
  }
  output.appendLine(`[record] audio file: ${file} (${stat.size} bytes)`);
}

async function transcribe(
  file: string,
  authToken: AuthToken | undefined,
): Promise<string> {
  if (!authToken) {
    throw new Error(l10n("ChatGPT web token is missing."));
  }
  output.appendLine("[transcribe] provider=chatgptWeb");
  return transcribeWithChatGptWeb(file, authToken);
}

async function transcribeWithChatGptWeb(
  file: string,
  authToken: AuthToken,
): Promise<string> {
  const endpoint = getConfig<string>(
    "transcription.chatgptWeb.endpoint",
    "https://chatgpt.com/backend-api/transcribe",
  );
  const language = normalizeLanguageForChatGptWeb(
    getConfig<string>(
      "transcription.language",
      getConfig<string>("transcription.chatgptWeb.language", "ru-RU"),
    ),
  );
  const cookie =
    getConfig<string>("transcription.chatgptWeb.cookie", "").trim() ||
    (await readOptionalText(getWebSessionCookiePath()));
  const userAgent =
    getConfig<string>("transcription.chatgptWeb.userAgent", "").trim() ||
    (await readWebSessionUserAgent());
  const clientVersion = getConfig<string>(
    "transcription.chatgptWeb.clientVersion",
    "",
  ).trim();
  const clientBuildNumber = getConfig<string>(
    "transcription.chatgptWeb.clientBuildNumber",
    "",
  ).trim();
  const challengeUrl = getConfig<string>(
    "transcription.chatgptWeb.challengeUrl",
    "https://chatgpt.com/",
  );
  const targetPath = endpointPath(endpoint);
  const form = await audioFormData(file, "file");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${authToken.value}`,
    "OAI-Language": language,
    "X-OpenAI-Target-Path": targetPath,
    "X-OpenAI-Target-Route": targetPath,
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
  };

  if (userAgent) {
    headers["User-Agent"] = userAgent;
  }
  if (clientVersion) {
    headers["OAI-Client-Version"] = clientVersion;
  }
  if (clientBuildNumber) {
    headers["OAI-Client-Build-Number"] = clientBuildNumber;
  }
  if (cookie) {
    headers.Cookie = cookie;
  }

  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: form,
  });

  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  output.appendLine(
    `[chatgpt-web] response: ${response.status} ${response.statusText}; content-type=${contentType || "<none>"}; bodyBytes=${Buffer.byteLength(body, "utf8")}; ms=${Date.now() - started}`,
  );

  if (!response.ok) {
    if (isChatGptChallenge(response.status, contentType, body)) {
      output.appendLine(`[chatgpt-web] challenge URL: ${challengeUrl}`);
      throw new Error(
        l10n(
          'ChatGPT web request hit a Cloudflare/DDOS challenge. Use "ChatGPT Speech: Refresh Web Session" to open Chrome, pass the check, capture cookies, and retry.',
        ),
      );
    }
    throw new Error(
      l10n(
        "ChatGPT web transcription failed: {0} {1}: {2}",
        response.status,
        response.statusText,
        body.slice(0, 1000),
      ),
    );
  }

  const parsed = JSON.parse(body) as { text?: unknown };
  if (typeof parsed.text !== "string") {
    throw new Error(
      l10n("ChatGPT web transcription response did not include text."),
    );
  }
  output.appendLine(`[chatgpt-web] transcript length: ${parsed.text.length}`);
  return parsed.text;
}

async function audioFormData(
  file: string,
  fieldName: string,
): Promise<FormData> {
  const data = await fs.readFile(file);
  const form = new FormData();
  form.append(
    fieldName,
    new Blob([data], { type: "audio/wav" }),
    path.basename(file),
  );
  return form;
}

async function insertTranscript(
  target: InsertionTarget | undefined,
  text: string,
) {
  if (!target) {
    throw new Error(l10n("No editor cursor target was captured."));
  }

  output.appendLine(`[insert] opening document: ${target.uri.toString()}`);
  const document = await vscode.workspace.openTextDocument(target.uri);
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: target.viewColumn ?? vscode.ViewColumn.Active,
    preserveFocus: false,
    preview: false,
  });

  const selections = target.selections.length
    ? target.selections
    : [editor.selection];
  output.appendLine(`[insert] selections: ${selections.length}`);
  const validSelections = selections.map(
    (selection) =>
      new vscode.Selection(
        document.validatePosition(selection.anchor),
        document.validatePosition(selection.active),
      ),
  );

  editor.selections = validSelections;
  const ok = await editor.edit(
    (builder) => {
      for (const selection of validSelections) {
        builder.replace(selection, text);
      }
    },
    { undoStopBefore: true, undoStopAfter: true },
  );

  if (!ok) {
    throw new Error(l10n("VS Code rejected the transcript edit."));
  }
  output.appendLine("[insert] editor edit accepted");
}

async function insertTranscriptWithRecovery(
  target: InsertionTarget | undefined,
  text: string,
): Promise<"inserted" | "copied"> {
  let current = target;
  for (;;) {
    try {
      await insertTranscript(current, text);
      return "inserted";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`[insert] failed: ${message}`);
      const selected = await vscode.window.showErrorMessage(
        l10n("Could not insert dictated text: {0}", message),
        l10n("Retry insert"),
        l10n("Copy transcript"),
        l10n("Show Log"),
      );

      if (selected === l10n("Retry insert")) {
        current = currentTarget() ?? current;
        continue;
      }

      if (selected === l10n("Copy transcript")) {
        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage(
          l10n("Dictated text copied to clipboard."),
        );
        return "copied";
      }

      if (selected === l10n("Show Log")) {
        output.show();
        continue;
      }

      throw error;
    }
  }
}

async function resolveAuthToken(
  required: boolean,
  sourceOverride?: string,
): Promise<AuthToken | undefined> {
  const source =
    sourceOverride ?? getConfig<string>("auth.tokenSource", "webSessionFile");
  if (source !== "webSessionFile" && source !== "user" && source !== "codex") {
    throw new Error(
      l10n(
        'Unsupported token source "{0}". Use "webSessionFile", "user", or "codex".',
        source,
      ),
    );
  }

  let value = await readToken(source);
  if (source === "webSessionFile") {
    const token = value ? authTokenFromValue(value, source) : undefined;
    if (!token || tokenNeedsRefresh(token)) {
      output.appendLine(
        token
          ? `[auth] web session token expires soon (${token.expiresAt?.toISOString() ?? "unknown"}); refreshing from saved cookies`
          : "[auth] web session token missing; refreshing from saved cookies",
      );
      value =
        (await refreshWebSessionFromCookies({
          output,
          extractAccessToken,
        })) ?? value;
    }
  }

  if (value) {
    const token = authTokenFromValue(value, source);
    assertTokenFresh(token);
    return token;
  }

  if (required) {
    throw new Error(
      l10n(
        'ChatGPT web token is missing. Run "ChatGPT Speech: Refresh Web Session", open {0} and paste the JSON with "ChatGPT Speech: Set API Token", or save it to chatgptSpeech.auth.webSessionTokenPath.',
        getChatGptSessionUrl(),
      ),
    );
  }
  return undefined;
}

async function readToken(source: string): Promise<string | undefined> {
  if (source === "user") {
    return extractAccessToken(getConfig<string>("auth.token", ""));
  }

  if (source === "webSessionFile") {
    const tokenPath = expandVars(
      getConfig<string>(
        "auth.webSessionTokenPath",
        "${home}/.chatgpt-speech/session.json",
      ),
      "",
    );
    return extractAccessToken(await readOptionalText(tokenPath));
  }

  if (source === "codex") {
    const authPath = expandVars(
      getConfig<string>("auth.codexAuthPath", "${home}/.codex/auth.json"),
      "",
    );
    const tokenPath = getConfig<string>(
      "auth.codexTokenPath",
      "tokens.access_token",
    );
    const raw = await readOptionalText(authPath);
    if (!raw.trim()) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as unknown;
    const configured = getByPath(parsed, tokenPath);
    return extractAccessToken(
      typeof configured === "string"
        ? configured
        : JSON.stringify(configured ?? parsed),
    );
  }

  return undefined;
}

function extractAccessToken(value: string | undefined): string | undefined {
  const clean = value?.trim();
  if (!clean) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(clean) as unknown;
    const token = firstStringByPath(parsed, [
      "accessToken",
      "access_token",
      "token",
      "jwt",
      "user.accessToken",
      "tokens.access_token",
    ]);
    return token?.trim() || undefined;
  } catch {
    return clean;
  }
}

function assertTokenFresh(token: AuthToken) {
  if (!tokenNeedsRefresh(token)) {
    return;
  }

  const advice =
    token.source === "codex"
      ? l10n(
          "Let the Codex extension refresh its own auth, then retry. This extension only reads Codex auth live and does not copy it.",
        )
      : l10n(
          'Run "ChatGPT Speech: Refresh Web Session", open {0}, or paste a fresh session JSON.',
          getChatGptSessionUrl(),
        );
  throw new Error(
    l10n(
      "API token from {0} is expired or about to expire ({1}). {2}",
      token.source,
      token.expiresAt?.toISOString() ?? "unknown",
      advice,
    ),
  );
}

function authTokenFromValue(value: string, source: string): AuthToken {
  return {
    value,
    source,
    expiresAt: parseJwtExpiry(value),
  };
}

function tokenNeedsRefresh(token: AuthToken): boolean {
  if (!token.expiresAt) {
    return false;
  }
  return token.expiresAt.getTime() - Date.now() <= 30_000;
}

function normalizeLanguageForChatGptWeb(language: string): string {
  const clean = language.trim();
  if (!clean) {
    return "";
  }
  return clean.includes("-") ? clean : `${clean}-${clean.toUpperCase()}`;
}

function firstStringByPath(
  value: unknown,
  paths: string[],
): string | undefined {
  for (const candidate of paths) {
    const found = getByPath(value, candidate);
    if (typeof found === "string") {
      return found;
    }
  }
  return undefined;
}

function parseJwtExpiry(token: string): Date | undefined {
  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(
        parts[1].replaceAll("-", "+").replaceAll("_", "/"),
        "base64",
      ).toString("utf8"),
    ) as { exp?: unknown };
    return typeof payload.exp === "number"
      ? new Date(payload.exp * 1000)
      : undefined;
  } catch {
    return undefined;
  }
}

async function setApiToken() {
  const value = await vscode.window.showInputBox({
    title: l10n("ChatGPT session token"),
    prompt: l10n(
      "Paste a raw accessToken or the full JSON from {0}. The token will be stored in VS Code user settings.",
      getChatGptSessionUrl(),
    ),
    placeHolder: '{"accessToken":"..."}',
    password: true,
    ignoreFocusOut: true,
  });

  if (value === undefined) {
    return;
  }

  const tokenValue = extractAccessToken(value);
  if (tokenValue) {
    const token: AuthToken = {
      value: tokenValue,
      source: "user",
      expiresAt: parseJwtExpiry(tokenValue),
    };
    assertTokenFresh(token);
    const config = vscode.workspace.getConfiguration("chatgptSpeech");
    await config.update(
      "auth.token",
      tokenValue,
      vscode.ConfigurationTarget.Global,
    );
    await config.update(
      "auth.tokenSource",
      "user",
      vscode.ConfigurationTarget.Global,
    );
    vscode.window.showInformationMessage(
      token.expiresAt
        ? l10n(
            "ChatGPT session token saved; expires {0}.",
            token.expiresAt.toISOString(),
          )
        : l10n("ChatGPT session token saved."),
    );
  } else {
    await vscode.workspace
      .getConfiguration("chatgptSpeech")
      .update("auth.token", "", vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
      l10n("ChatGPT session token cleared."),
    );
  }
}

async function openAuthSessionPage() {
  try {
    const url = getChatGptSessionUrl();
    await vscode.env.openExternal(vscode.Uri.parse(url));
    output.appendLine(`[auth] opened ChatGPT session URL: ${url}`);
  } catch (error) {
    showError(l10n("Could not open ChatGPT session token page"), error);
  }
}

function updateStatus(text?: string) {
  if (text) {
    status.text = text;
    status.tooltip = l10n("ChatGPT Speech is processing");
    status.backgroundColor = undefined;
    status.show();
    return;
  }

  if (recording) {
    status.text = `$(record) ${l10n("Recording")}`;
    status.tooltip = l10n("Stop dictation and insert transcript");
    status.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
  } else {
    status.text = `$(mic) ${l10n("Dictate")}`;
    status.tooltip = l10n("Start dictation");
    status.backgroundColor = undefined;
  }
  status.show();
}

function getConfig<T>(key: string, fallback: T): T {
  return vscode.workspace
    .getConfiguration("chatgptSpeech")
    .get<T>(key, fallback);
}

function getGlobalConfig<T>(key: string, fallback: T): T {
  const inspected = vscode.workspace
    .getConfiguration("chatgptSpeech")
    .inspect<T>(key);
  return inspected?.globalValue ?? inspected?.defaultValue ?? fallback;
}

function expandVars(value: string, file: string): string {
  return expandGeneralVars(value)
    .replaceAll("${file}", file)
    .replaceAll(
      "${workspaceFolder}",
      expandWorkspaceFolderVar("${workspaceFolder}"),
    )
    .replaceAll("${tmpdir}", os.tmpdir());
}

function expandGeneralVars(value: string): string {
  return value
    .replaceAll("${home}", os.homedir())
    .replaceAll("~", os.homedir());
}

function getByPath(value: unknown, dottedPath: string): unknown {
  if (!dottedPath) {
    return value;
  }

  return dottedPath.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, value);
}

function appendBounded(current: string, next: string): string {
  const combined = current + next;
  return combined.length > 20000
    ? combined.slice(combined.length - 20000)
    : combined;
}

function quoteArg(arg: string): string {
  return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}

function describeToken(token: AuthToken): string {
  return token.expiresAt
    ? `${token.source}, expires ${token.expiresAt.toISOString()}`
    : `${token.source}, no JWT expiry`;
}

function endpointPath(endpoint: string): string {
  try {
    return new URL(endpoint).pathname;
  } catch {
    return endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readOptionalText(file: string): Promise<string> {
  try {
    return (await fs.readFile(file, "utf8")).trim();
  } catch {
    return "";
  }
}

function showError(
  prefix: string,
  error: unknown,
  options: { retry?: boolean } = {},
) {
  const message = error instanceof Error ? error.message : String(error);
  output.appendLine(`[error] ${prefix}: ${message}`);
  void showActionableError(`${prefix}: ${message}`, options);
}

async function showActionableError(
  message: string,
  options: { retry?: boolean } = {},
) {
  const shouldOfferSessionUrl =
    /token|unauthorized|401|403|expired|challenge|cloudflare|ddos/i.test(
      message,
    );
  const shouldOfferBrowserRefresh =
    /challenge|cloudflare|ddos|ChatGPT web|session/i.test(message);
  const retryAction = l10n("Retry");
  const refreshSessionAction = l10n("Refresh ChatGPT web session and retry");
  const openSessionTokenAction = l10n("Open ChatGPT session token");
  const showLogAction = l10n("Show Log");
  const actions = [
    ...(options.retry ? [retryAction] : []),
    ...(shouldOfferBrowserRefresh ? [refreshSessionAction] : []),
    ...(shouldOfferSessionUrl ? [openSessionTokenAction] : []),
    showLogAction,
  ];
  const selected = await vscode.window.showErrorMessage(message, ...actions);

  if (selected === retryAction) {
    await vscode.commands.executeCommand("chatgptSpeech.retryLastDictation");
    return;
  }

  if (selected === refreshSessionAction) {
    await vscode.commands.executeCommand(
      "chatgptSpeech.refreshWebSessionAndRetry",
    );
    return;
  }

  if (selected === openSessionTokenAction) {
    await vscode.env.openExternal(vscode.Uri.parse(getChatGptSessionUrl()));
    return;
  }

  if (selected === showLogAction) {
    output.show();
  }
}
