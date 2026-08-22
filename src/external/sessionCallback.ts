import * as https from "node:https";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

const MAX_CALLBACK_URL_LENGTH = 8192;
const MAX_CALLBACK_PAYLOAD_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export type ExternalSessionPayload = {
  token_json: string;
  cookie: string;
  user_agent: string;
  source: string;
  source_device_id: string;
  notify_devices: boolean;
};

export type ExternalSessionCallbackResult = {
  responseBytes: number;
  statusCode: number;
};

export type ExternalSessionCallbackOptions = {
  ca?: Buffer;
  maxResponseBytes?: number;
  timeoutMs?: number;
};

export function validateExternalSessionCallback(
  rawUrl: string,
  allowedDomains: readonly string[],
): URL {
  const value = rawUrl.trim();
  if (!value) {
    throw new Error("The callback URL is missing.");
  }
  if (value.length > MAX_CALLBACK_URL_LENGTH) {
    throw new Error("The callback URL is too long.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("The callback URL is invalid.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("The callback URL must use HTTPS.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("The callback URL must not contain credentials.");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error("The callback URL must use the default HTTPS port.");
  }
  if (parsed.hash) {
    throw new Error("The callback URL must not contain a fragment.");
  }

  const hostname = normalizeDomain(parsed.hostname);
  if (!hostname || isIP(hostname)) {
    throw new Error("The callback URL must contain a valid domain name.");
  }
  if (!isExternalCallbackDomainAllowed(hostname, allowedDomains)) {
    throw new Error(
      `Callback domain ${hostname} is not in chatgptSpeech.externalCallbacks.allowedDomains.`,
    );
  }

  parsed.hostname = hostname;
  return parsed;
}

export function isExternalCallbackDomainAllowed(
  hostname: string,
  allowedDomains: readonly string[],
): boolean {
  const normalizedHostname = normalizeDomain(hostname);
  if (!normalizedHostname || isIP(normalizedHostname)) {
    return false;
  }

  return allowedDomains.some((entry) => {
    const normalized = normalizeAllowedDomain(entry);
    if (!normalized) {
      return false;
    }
    if (!normalized.wildcard) {
      return normalizedHostname === normalized.domain;
    }
    return normalizedHostname.endsWith(`.${normalized.domain}`);
  });
}

export async function postExternalSessionCallback(
  callbackUrl: URL,
  body: ExternalSessionPayload,
  options: ExternalSessionCallbackOptions = {},
): Promise<ExternalSessionCallbackResult> {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  if (payload.length > MAX_CALLBACK_PAYLOAD_BYTES) {
    throw new Error("The external session callback payload is too large.");
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value: ExternalSessionCallbackResult) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const rejectOnce = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    const request = https.request(
      callbackUrl,
      {
        method: "POST",
        ca: options.ca,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": String(payload.length),
        },
      },
      (response) => {
        let responseBytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          responseBytes += Buffer.byteLength(chunk);
          if (responseBytes > maxResponseBytes) {
            response.destroy(
              new Error("The external session callback response is too large."),
            );
          }
        });
        response.once("error", rejectOnce);
        response.once("end", () => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            rejectOnce(
              new Error(
                `The external session callback returned HTTP ${statusCode || "unknown"}.`,
              ),
            );
            return;
          }
          resolveOnce({ responseBytes, statusCode });
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("The external session callback timed out."));
    });
    request.once("error", rejectOnce);
    request.end(payload);
  });
}

function normalizeAllowedDomain(
  value: string,
): { domain: string; wildcard: boolean } | undefined {
  const trimmed = value.trim().toLowerCase();
  const wildcard = trimmed.startsWith("*.");
  const domain = normalizeDomain(wildcard ? trimmed.slice(2) : trimmed);
  return domain ? { domain, wildcard } : undefined;
}

function normalizeDomain(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    !trimmed ||
    trimmed.includes(":") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("@") ||
    trimmed.includes("*")
  ) {
    return undefined;
  }

  const ascii = domainToASCII(trimmed).toLowerCase();
  if (!ascii || ascii.length > 253) {
    return undefined;
  }
  const labels = ascii.split(".");
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith("-") ||
        label.endsWith("-"),
    )
  ) {
    return undefined;
  }
  return ascii;
}
