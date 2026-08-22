import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

function l10n(
  message: string,
  ...args: Array<string | number | boolean>
): string {
  return vscode.l10n.t(message, ...args);
}

export type SystemBrowserInfo = {
  desktopId?: string;
  mimeDefault?: string;
  kind: "chrome" | "firefox" | "unknown";
};

export async function getSystemBrowserInfo(): Promise<SystemBrowserInfo> {
  if (process.platform !== "linux") {
    return { kind: "unknown" };
  }

  const desktopId =
    (
      await execFileText("xdg-settings", ["get", "default-web-browser"])
    ).trim() || undefined;
  const mimeOutput = await execFileText("gio", [
    "mime",
    "x-scheme-handler/https",
  ]);
  const xdgMimeDefault = (
    await execFileText("xdg-mime", [
      "query",
      "default",
      "x-scheme-handler/https",
    ])
  ).trim();
  const mimeDefault =
    (/Default application.*?:\s*([^\s]+)/.exec(mimeOutput)?.[1] ??
      xdgMimeDefault) ||
    undefined;
  const identity = `${desktopId ?? ""} ${mimeDefault ?? ""}`.toLowerCase();
  const kind = /firefox/.test(identity)
    ? "firefox"
    : /chrome|chromium|brave|edge/.test(identity)
      ? "chrome"
      : "unknown";

  return { desktopId, mimeDefault, kind };
}

export async function seedChromeProfileIfNeeded(
  profileDir: string,
  sourceProfileDir: string,
  output: vscode.OutputChannel,
) {
  const marker = path.join(profileDir, ".chatgpt-speech-seeded");
  if ((await pathExists(marker)) || !(await pathExists(sourceProfileDir))) {
    return;
  }

  if (await pathExists(profileDir)) {
    const backup = `${profileDir}.backup-${Date.now()}`;
    await fs.rename(profileDir, backup);
    output.appendLine(
      `[auth-browser] moved existing helper profile to ${backup}`,
    );
  }

  output.appendLine(
    `[auth-browser] seeding Chrome profile from ${sourceProfileDir} to ${profileDir}`,
  );
  await fs.mkdir(path.dirname(profileDir), { recursive: true });
  await fs.cp(sourceProfileDir, profileDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (source) => shouldCopyChromeProfileEntry(source, sourceProfileDir),
  });
  await writePrivateText(marker, new Date().toISOString());
}

export async function findChromeCommand(configured: string): Promise<string> {
  const candidates = configured
    ? [configured]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "win32"
        ? ["chrome.exe", "msedge.exe"]
        : [
            "/usr/bin/google-chrome-stable",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "google-chrome-stable",
            "google-chrome",
            "chromium",
            "chromium-browser",
          ];

  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    const resolved = await resolveExecutable(candidate);
    if (resolved) {
      return resolved;
    }
  }
  throw new Error(
    l10n(
      "Chrome executable was not found. Set hidden setting chatgptSpeech.auth.chromeCommand if Chrome is installed in a custom path.",
    ),
  );
}

async function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    cp.execFile(command, args, { timeout: 5000 }, (error, stdout) => {
      resolve(error ? "" : stdout.toString());
    });
  });
}

async function writePrivateText(file: string, value: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

function shouldCopyChromeProfileEntry(
  source: string,
  sourceProfileDir: string,
): boolean {
  const relative = path
    .relative(sourceProfileDir, source)
    .replaceAll(path.sep, "/");
  if (!relative) {
    return true;
  }

  const base = path.basename(relative);
  if (/^Singleton/.test(base)) {
    return false;
  }

  return ![
    "Crashpad",
    "ShaderCache",
    "GrShaderCache",
    "GraphiteDawnCache",
    "Default/Cache",
    "Default/Code Cache",
    "Default/GPUCache",
    "Default/DawnCache",
    "Default/Service Worker/CacheStorage",
    "Default/Session Storage",
    "Default/Sessions",
  ].some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable(command: string): Promise<string | undefined> {
  const pathEnv = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}
