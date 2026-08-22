import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  findChromeCommand,
  getSystemBrowserInfo,
  seedChromeProfileIfNeeded,
} from "../platform/browser";
import {
  expandWorkspaceFolderVar,
  localProcessCwd,
} from "../platform/vscodeHost";

type CookieRecord = {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  expires?: number;
};

type CdpClient = {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  onEvent(handler: (event: Record<string, unknown>) => void): void;
  close(): void;
};

export type WebSessionCapture = {
  accessToken: string;
  sessionJson: unknown;
  cookies: CookieRecord[];
  cookieHeader: string;
  userAgent?: string;
  clientVersion?: string;
  clientBuildNumber?: string;
  deviceId?: string;
  sessionId?: string;
  language?: string;
};

type RefreshDeps = {
  output: vscode.OutputChannel;
  updateStatus(text?: string): void;
  retryLastDictation(): Promise<void>;
  showError(
    prefix: string,
    error: unknown,
    options?: { retry?: boolean },
  ): void;
  extractAccessToken(value: string | undefined): string | undefined;
  publishCapture?(capture: WebSessionCapture): Promise<void>;
};

type CookieRefreshDeps = {
  output: vscode.OutputChannel;
  extractAccessToken(value: string | undefined): string | undefined;
};

let refreshingWebSession = false;

function l10n(
  message: string,
  ...args: Array<string | number | boolean>
): string {
  return vscode.l10n.t(message, ...args);
}

export async function refreshWebSession(
  options: { retryAfter?: boolean },
  deps: RefreshDeps,
): Promise<boolean> {
  if (refreshingWebSession) {
    vscode.window.showInformationMessage(
      l10n("ChatGPT web session refresh is already running."),
    );
    return false;
  }

  refreshingWebSession = true;
  deps.updateStatus(`$(sync~spin) ${l10n("Refreshing ChatGPT session")}`);

  let chrome: cp.ChildProcess | undefined;
  try {
    const systemBrowser = await getSystemBrowserInfo();
    deps.output.appendLine(
      `[auth-browser] system default browser: kind=${systemBrowser.kind}; desktop=${systemBrowser.desktopId ?? "unknown"}; mime=${systemBrowser.mimeDefault ?? "unknown"}`,
    );
    const chromeCommand = await findChromeCommand(
      getConfig<string>("auth.chromeCommand", "").trim(),
    );
    const profileDir = expandGeneralVars(
      getConfig<string>(
        "auth.browserProfilePath",
        "${home}/.chatgpt-speech/chrome-profile",
      ),
    );
    const sourceProfileDir = expandGeneralVars(
      getConfig<string>(
        "auth.browserSourceProfilePath",
        "${home}/.config/google-chrome",
      ),
    );
    await seedChromeProfileIfNeeded(profileDir, sourceProfileDir, deps.output);
    await fs.mkdir(profileDir, { recursive: true });
    const port = await getFreePort();
    const startUrl = `${getChatGptSessionUrl()}?ts=${Date.now()}`;
    const args = [
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profileDir}`,
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      startUrl,
    ];

    deps.output.appendLine(
      `[auth-browser] starting Chrome: ${chromeCommand} ${args.map(quoteArg).join(" ")}`,
    );
    chrome = cp.spawn(chromeCommand, args, {
      cwd: localProcessCwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    chrome.stderr?.on("data", (chunk: Buffer) =>
      deps.output.append(chunk.toString()),
    );
    chrome.stdout?.on("data", (chunk: Buffer) =>
      deps.output.append(chunk.toString()),
    );

    const browserNote =
      systemBrowser.kind === "firefox"
        ? l10n(
            "The system browser is Firefox; the Chrome helper is currently used for automatic token/cookie capture.",
          )
        : "";
    vscode.window.showInformationMessage(
      [
        l10n(
          "Chrome opened. Sign in or pass the check; this window will close after session/cookies are captured.",
        ),
        browserNote,
      ]
        .filter(Boolean)
        .join(" "),
    );

    const capture = await waitForChatGptSessionCapture(
      port,
      300_000,
      deps.extractAccessToken,
    );
    await writeWebSessionCapture(capture);
    await vscode.workspace
      .getConfiguration("chatgptSpeech")
      .update(
        "auth.tokenSource",
        "webSessionFile",
        vscode.ConfigurationTarget.Workspace,
      );
    deps.output.appendLine(
      `[auth-browser] captured session: tokenLength=${capture.accessToken.length}; cookies=${capture.cookies.length}`,
    );
    await deps.publishCapture?.(capture);
    vscode.window.showInformationMessage(
      options.retryAfter
        ? l10n("ChatGPT web session refreshed. Retrying dictation.")
        : l10n("ChatGPT web session refreshed."),
    );

    if (options.retryAfter) {
      await deps.retryLastDictation();
    }
    return true;
  } catch (error) {
    deps.showError(l10n("Could not refresh ChatGPT web session"), error, {
      retry: false,
    });
    return false;
  } finally {
    refreshingWebSession = false;
    deps.updateStatus();
    if (chrome && !chrome.killed) {
      chrome.kill("SIGTERM");
    }
  }
}

export function getChatGptSessionUrl(): string {
  return "https://chatgpt.com/api/auth/session";
}

export function getWebSessionCookiePath(): string {
  return expandGeneralVars(
    getConfig<string>(
      "auth.webSessionCookiePath",
      "${home}/.chatgpt-speech/cookies.txt",
    ),
  );
}

export async function readWebSessionUserAgent(): Promise<string> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(getWebSessionMetaPath(), "utf8"),
    ) as { userAgent?: unknown };
    return typeof parsed.userAgent === "string" ? parsed.userAgent.trim() : "";
  } catch {
    return "";
  }
}

export async function refreshWebSessionFromCookies(
  deps: CookieRefreshDeps,
): Promise<string | undefined> {
  const cookiePath = getWebSessionCookiePath();
  const cookie = (await readOptionalText(cookiePath)).trim();
  if (!cookie) {
    deps.output.appendLine(
      `[auth-session] skipped cookie refresh: no saved cookies at ${cookiePath}`,
    );
    return undefined;
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    Cookie: cookie,
    Referer: "https://chatgpt.com/",
  };
  const userAgent = await readWebSessionUserAgent();
  if (userAgent) {
    headers["User-Agent"] = userAgent;
  }

  const started = Date.now();
  const response = await fetch(getChatGptSessionUrl(), { headers });
  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  deps.output.appendLine(
    `[auth-session] cookie refresh response: ${response.status} ${response.statusText}; content-type=${contentType || "<none>"}; bodyBytes=${Buffer.byteLength(body, "utf8")}; ms=${Date.now() - started}`,
  );

  if (!response.ok) {
    if (isChatGptChallenge(response.status, contentType, body)) {
      deps.output.appendLine(
        "[auth-session] saved cookies hit a ChatGPT challenge; browser refresh is required",
      );
    }
    return undefined;
  }

  let sessionJson: unknown;
  try {
    sessionJson = JSON.parse(body) as unknown;
  } catch {
    deps.output.appendLine(
      "[auth-session] cookie refresh did not return JSON session data",
    );
    return undefined;
  }

  const token = deps.extractAccessToken(body);
  if (!token) {
    deps.output.appendLine(
      "[auth-session] cookie refresh session did not include accessToken",
    );
    return undefined;
  }

  await writeWebSessionJson(sessionJson, token);
  deps.output.appendLine(
    `[auth-session] refreshed accessToken from saved cookies: tokenLength=${token.length}`,
  );
  return token;
}

function getWebSessionMetaPath(): string {
  return expandGeneralVars(
    getConfig<string>(
      "auth.webSessionMetaPath",
      "${home}/.chatgpt-speech/session-meta.json",
    ),
  );
}

function isCloudflareChallenge(
  status: number,
  contentType: string,
  body: string,
): boolean {
  return (
    status === 403 &&
    (contentType.includes("text/html") ||
      /cloudflare|just a moment|challenge|ddos/i.test(body))
  );
}

export function isChatGptChallenge(
  status: number,
  contentType: string,
  body: string,
): boolean {
  return isCloudflareChallenge(status, contentType, body);
}

async function writePrivateText(file: string, value: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

async function readOptionalText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error(l10n("Could not allocate a local debugging port.")));
        }
      });
    });
  });
}

async function waitForChatGptSessionCapture(
  port: number,
  timeoutMs: number,
  extractAccessToken: (value: string | undefined) => string | undefined,
): Promise<WebSessionCapture> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    let cdp: CdpClient | undefined;
    try {
      const page = await getChatGptCdpPage(port);
      cdp = await connectCdp(page.webSocketDebuggerUrl);
      await cdp.send("Runtime.enable");
      await cdp.send("Network.enable");

      const clientHeaders: Partial<
        Pick<
          WebSessionCapture,
          | "clientVersion"
          | "clientBuildNumber"
          | "deviceId"
          | "sessionId"
          | "language"
          | "userAgent"
        >
      > = {};
      cdp.onEvent((event) => {
        const method = String(event.method ?? "");
        if (
          method !== "Network.requestWillBeSent" &&
          method !== "Network.responseReceived"
        ) {
          return;
        }
        const params = event.params as
          | {
              request?: { headers?: Record<string, unknown> };
              response?: { headers?: Record<string, unknown> };
            }
          | undefined;
        const headers = params?.request?.headers;
        if (headers) {
          clientHeaders.clientVersion ||= getHeaderValue(
            headers,
            "OAI-Client-Version",
          );
          clientHeaders.clientBuildNumber ||= getHeaderValue(
            headers,
            "OAI-Client-Build-Number",
          );
          clientHeaders.deviceId ||= getHeaderValue(headers, "OAI-Device-Id");
          clientHeaders.sessionId ||= getHeaderValue(headers, "OAI-Session-Id");
          clientHeaders.language ||= getHeaderValue(headers, "OAI-Language");
          clientHeaders.userAgent ||= getHeaderValue(headers, "User-Agent");
        }
      });

      while (Date.now() < deadline) {
        const sessionResult = await cdp.send<{
          result?: {
            value?: {
              status?: number;
              json?: unknown;
              error?: string;
              userAgent?: string;
            };
          };
        }>("Runtime.evaluate", {
          awaitPromise: true,
          returnByValue: true,
          expression: `fetch('/api/auth/session', { credentials: 'include' }).then(async r => ({ status: r.status, json: await r.json().catch(() => null), userAgent: navigator.userAgent })).catch(error => ({ status: 0, error: String(error), json: null, userAgent: navigator.userAgent }))`,
        });
        const sessionValue = sessionResult.result?.value;
        const token = extractAccessToken(
          JSON.stringify(sessionValue?.json ?? ""),
        );
        const cookiesResult = await cdp
          .send<{ cookies?: CookieRecord[] }>("Network.getAllCookies")
          .catch(() =>
            cdp?.send<{ cookies?: CookieRecord[] }>("Network.getCookies", {
              urls: ["https://chatgpt.com/", getChatGptSessionUrl()],
            }),
          );
        const cookies = cookiesResult?.cookies ?? [];
        const cookieHeader = serializeChatGptCookies(cookies);

        if (sessionValue?.status === 200 && token && cookieHeader) {
          return {
            accessToken: token,
            sessionJson: sessionValue.json,
            cookies,
            cookieHeader,
            userAgent:
              clientHeaders.userAgent ||
              (typeof sessionValue.userAgent === "string"
                ? sessionValue.userAgent
                : undefined),
            clientVersion: clientHeaders.clientVersion,
            clientBuildNumber: clientHeaders.clientBuildNumber,
            deviceId: clientHeaders.deviceId,
            sessionId: clientHeaders.sessionId,
            language: clientHeaders.language,
          };
        }
        lastError = `status=${sessionValue?.status ?? "unknown"} token=${token ? token.length : 0} cookies=${cookieHeader ? cookieHeader.length : 0}`;
        await delay(500);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      cdp?.close();
    }
    await delay(500);
  }
  throw new Error(
    l10n(
      "Timed out waiting for ChatGPT session capture. Last state: {0}",
      lastError,
    ),
  );
}

async function getChatGptCdpPage(
  port: number,
): Promise<{ webSocketDebuggerUrl: string; url: string }> {
  const pages = await fetchJson<
    Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>
  >(`http://127.0.0.1:${port}/json`);
  const page =
    pages.find(
      (candidate) =>
        candidate.type === "page" &&
        candidate.webSocketDebuggerUrl &&
        /chatgpt\.com/.test(candidate.url ?? ""),
    ) ??
    pages.find(
      (candidate) =>
        candidate.type === "page" && candidate.webSocketDebuggerUrl,
    );
  if (!page?.webSocketDebuggerUrl) {
    throw new Error(l10n("Chrome is not ready yet."));
  }
  return {
    webSocketDebuggerUrl: page.webSocketDebuggerUrl,
    url: page.url ?? "",
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(l10n("GET {0} failed: {1}", url, response.status));
  }
  return response.json() as Promise<T>;
}

async function connectCdp(wsUrl: string): Promise<CdpClient> {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const eventHandlers = new Set<(event: Record<string, unknown>) => void>();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      error?: unknown;
      result?: unknown;
    };
    if (message.id && pending.has(message.id)) {
      const handlers = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error) {
        handlers.reject(new Error(JSON.stringify(message.error)));
      } else {
        handlers.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) {
      for (const handler of eventHandlers) {
        handler(message as Record<string, unknown>);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error(l10n("CDP WebSocket failed to open."))),
      { once: true },
    );
  });
  return {
    send<T = Record<string, unknown>>(
      method: string,
      params: Record<string, unknown> = {},
    ) {
      const callId = ++id;
      ws.send(JSON.stringify({ id: callId, method, params }));
      return new Promise<T>((resolve, reject) => {
        pending.set(callId, {
          resolve: (value) => resolve(value as T),
          reject,
        });
      });
    },
    onEvent(handler: (event: Record<string, unknown>) => void) {
      eventHandlers.add(handler);
    },
    close() {
      ws.close();
    },
  };
}

function serializeChatGptCookies(cookies: CookieRecord[]): string {
  const nowSeconds = Date.now() / 1000;
  const pairs = cookies
    .filter((cookie) => cookie.name && typeof cookie.value === "string")
    .filter((cookie) => normalizeCookieDomain(cookie.domain) === "chatgpt.com")
    .filter(
      (cookie) =>
        !cookie.expires || cookie.expires < 0 || cookie.expires > nowSeconds,
    )
    .map((cookie) => `${cookie.name}=${cookie.value}`);
  return [...new Set(pairs)].join("; ");
}

function normalizeCookieDomain(domain: string | undefined): string {
  return (domain || "chatgpt.com").replace(/^\./, "").toLowerCase();
}

async function writeWebSessionCapture(capture: WebSessionCapture) {
  const sessionPath = await writeWebSessionJson(
    capture.sessionJson,
    capture.accessToken,
  );
  await writePrivateText(getWebSessionCookiePath(), capture.cookieHeader);
  await writePrivateText(
    getWebSessionMetaPath(),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        sessionPath,
        cookiePath: getWebSessionCookiePath(),
        accessTokenLength: capture.accessToken.length,
        userAgent: capture.userAgent ?? "",
        clientVersion: capture.clientVersion ?? "",
        clientBuildNumber: capture.clientBuildNumber ?? "",
        deviceId: capture.deviceId ?? "",
        sessionId: capture.sessionId ?? "",
        language: capture.language ?? "",
        cookieCount: capture.cookies.length,
        cookieNames: capture.cookies
          .filter(
            (cookie) => normalizeCookieDomain(cookie.domain) === "chatgpt.com",
          )
          .map((cookie) => `${cookie.domain}:${cookie.name}`),
      },
      null,
      2,
    ),
  );
}

async function writeWebSessionJson(
  sessionJson: unknown,
  accessToken: string,
): Promise<string> {
  const sessionPath = expandVars(
    getConfig<string>(
      "auth.webSessionTokenPath",
      "${home}/.chatgpt-speech/session.json",
    ),
    "",
  );
  await writePrivateText(sessionPath, JSON.stringify(sessionJson, null, 2));

  let meta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(
      await fs.readFile(getWebSessionMetaPath(), "utf8"),
    ) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or stale meta is fine; the session JSON is the important part.
  }
  meta.refreshedAt = new Date().toISOString();
  meta.sessionPath = sessionPath;
  meta.accessTokenLength = accessToken.length;
  await writePrivateText(
    getWebSessionMetaPath(),
    JSON.stringify(meta, null, 2),
  );
  return sessionPath;
}

function getHeaderValue(
  headers: Record<string, unknown>,
  name: string,
): string | undefined {
  const found = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  return typeof found === "string" ? found : undefined;
}

function getConfig<T>(key: string, fallback: T): T {
  return vscode.workspace
    .getConfiguration("chatgptSpeech")
    .get<T>(key, fallback);
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

function quoteArg(arg: string): string {
  return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
