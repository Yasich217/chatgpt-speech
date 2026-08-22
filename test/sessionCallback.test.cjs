const assert = require("node:assert/strict");
const test = require("node:test");
const {
  isExternalCallbackDomainAllowed,
  validateExternalSessionCallback,
} = require("../out/external/sessionCallback.js");

test("allows only exact configured callback domains", () => {
  assert.equal(
    isExternalCallbackDomainAllowed("auth.example.com", ["auth.example.com"]),
    true,
  );
  assert.equal(
    isExternalCallbackDomainAllowed("sub.auth.example.com", [
      "auth.example.com",
    ]),
    false,
  );
  assert.equal(
    isExternalCallbackDomainAllowed("auth.example.com.attacker.test", [
      "auth.example.com",
    ]),
    false,
  );
});

test("supports explicit wildcard entries without matching the parent", () => {
  assert.equal(
    isExternalCallbackDomainAllowed("one.example.com", ["*.example.com"]),
    true,
  );
  assert.equal(
    isExternalCallbackDomainAllowed("deep.one.example.com", ["*.example.com"]),
    true,
  );
  assert.equal(
    isExternalCallbackDomainAllowed("example.com", ["*.example.com"]),
    false,
  );
});

test("normalizes case, trailing dots, and internationalized domains", () => {
  assert.equal(
    isExternalCallbackDomainAllowed("AUTH.EXAMPLE.COM.", ["auth.example.com"]),
    true,
  );
  assert.equal(
    isExternalCallbackDomainAllowed("xn--e1afmkfd.xn--p1ai", ["пример.рф"]),
    true,
  );
});

test("rejects callbacks unless the URL and domain are safe", () => {
  const allowed = ["auth.example.com"];

  assert.throws(
    () =>
      validateExternalSessionCallback("http://auth.example.com/cb", allowed),
    /HTTPS/,
  );
  const callbackWithCredentials = new URL("https://auth.example.com/cb");
  callbackWithCredentials.username = "test-user";
  callbackWithCredentials.password = "test-password";
  assert.throws(
    () =>
      validateExternalSessionCallback(
        callbackWithCredentials.toString(),
        allowed,
      ),
    /credentials/,
  );
  assert.throws(
    () =>
      validateExternalSessionCallback(
        "https://auth.example.com:8443/cb",
        allowed,
      ),
    /default HTTPS port/,
  );
  assert.throws(
    () =>
      validateExternalSessionCallback(
        "https://auth.example.com/cb#fragment",
        allowed,
      ),
    /fragment/,
  );
  assert.throws(
    () =>
      validateExternalSessionCallback("https://127.0.0.1/cb", ["127.0.0.1"]),
    /domain name/,
  );
  assert.throws(
    () => validateExternalSessionCallback("https://attacker.test/cb", allowed),
    /allowedDomains/,
  );
});

test("preserves an approved one-time callback path and query", () => {
  const callback = validateExternalSessionCallback(
    "https://auth.example.com/session/submit?ticket=one-time-secret",
    ["auth.example.com"],
  );
  assert.equal(callback.hostname, "auth.example.com");
  assert.equal(callback.pathname, "/session/submit");
  assert.equal(callback.searchParams.get("ticket"), "one-time-secret");
});
