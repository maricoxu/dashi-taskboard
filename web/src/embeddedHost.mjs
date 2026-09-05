const DIRECT_IFRAME_PARAM = "__codex_taskboard_direct";
const FRAME_CAPABILITY_PARAM = "__codex_taskboard_frame_capability";

function frameCapability() {
  return typeof globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__ === "string"
    ? globalThis.__CODEX_TASKBOARD_FRAME_CAPABILITY__
    : typeof window !== "undefined"
      ? new URL(window.location.href).searchParams.get(FRAME_CAPABILITY_PARAM) || ""
      : "";
}

export function isEmbeddedHost() {
  return typeof window !== "undefined"
    && window.parent !== window
    && Boolean(frameCapability());
}

export function isDirectEmbeddedHost() {
  if (!isEmbeddedHost()) return false;
  try {
    const url = new URL(window.location.href);
    return (
      url.searchParams.get(DIRECT_IFRAME_PARAM) === "1"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      && (url.protocol === "http:" || url.protocol === "https:")
    );
  } catch {
    return false;
  }
}

let activeFrameChallenge = "";
const frameChallengeWaiters = new Set();
let frameChallengeRequested = false;

export function setEmbeddedFrameChallenge(challenge) {
  activeFrameChallenge = typeof challenge === "string" ? challenge : "";
  if (!activeFrameChallenge) return;
  frameChallengeWaiters.forEach((resolve) => resolve());
  frameChallengeWaiters.clear();
}

function receiveEmbeddedFrameChallenge(event) {
  if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
  const message = event.data;
  if (
    message.type !== "taskboard:frame-challenge"
    || message.capability !== frameCapability()
    || typeof message.payload?.challenge !== "string"
    || message.payload.challenge.length === 0
  ) return;
  setEmbeddedFrameChallenge(message.payload.challenge);
  // Storage initializes before React mounts. Acknowledge the challenge here
  // so the parent can mark the frame ready even while the first API request
  // is waiting for the same challenge.
  postEmbeddedHostMessage({ type: "taskboard:ready" });
}

if (typeof window !== "undefined" && isEmbeddedHost()) {
  window.addEventListener("message", receiveEmbeddedFrameChallenge);
  if (isDirectEmbeddedHost()) {
    queueMicrotask(() => postEmbeddedHostMessage({ type: "taskboard:ready" }));
  }
}

export function postEmbeddedHostMessage(message) {
  window.parent.postMessage({
    ...message,
    capability: frameCapability(),
    challenge: activeFrameChallenge,
  }, "*");
}

export function requestEmbeddedHostHttp(input) {
  if (!isEmbeddedHost() || isDirectEmbeddedHost()) return null;
  const requestId = `taskboard-http-${crypto.randomUUID()}`;
  if (!activeFrameChallenge && !frameChallengeRequested) {
    frameChallengeRequested = true;
    postEmbeddedHostMessage({ type: "taskboard:frame-awaiting-challenge" });
  }
  return new Promise((resolve, reject) => {
    let challengeTimer;
    const begin = () => {
      if (challengeTimer !== undefined) window.clearTimeout(challengeTimer);
      let settled = false;
      const timeout = window.setTimeout(() => finish(new Error("Taskboard host request timed out")), 30_000);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        if (error) reject(error);
        else resolve(value);
      };
      const onMessage = (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (
          !message
          || message.type !== "taskboard:http-response"
          || message.payload?.requestId !== requestId
        ) return;
        const payload = message.payload;
        if (payload.error) {
          finish(new Error(payload.error));
          return;
        }
        finish(null, payload);
      };
      window.addEventListener("message", onMessage);
      postEmbeddedHostMessage({
        type: "taskboard:http-request",
        payload: { ...input, requestId },
      });
    };
    if (activeFrameChallenge) {
      begin();
      return;
    }
    const waitForChallenge = () => {
      frameChallengeWaiters.delete(waitForChallenge);
      begin();
    };
    frameChallengeWaiters.add(waitForChallenge);
    challengeTimer = window.setTimeout(() => {
      frameChallengeWaiters.delete(waitForChallenge);
      reject(new Error("Taskboard frame challenge timed out"));
    }, 5_000);
  });
}

export async function fetchEmbeddedHost(url, init = {}) {
  const headers = new Headers(init.headers);
  const bridge = requestEmbeddedHostHttp({
    url: String(url),
    method: (init.method || "GET").toUpperCase(),
    headers: Object.fromEntries(headers.entries()),
    body: typeof init.body === "string" ? { kind: "text", value: init.body } : undefined,
  });
  if (!bridge) return null;
  const result = await bridge;
  const binary = atob(result.bodyBase64 || "");
  const body = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) body[index] = binary.charCodeAt(index);
  return new Response([204, 205, 304].includes(result.status) ? undefined : body, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
}

export function installEmbeddedExternalLinkHandler() {
  const handleClick = (event) => {
    const link = event.target instanceof Element
      ? event.target.closest('a[target="_blank"]')
      : null;
    if (!link) return;

    const rawHref = link.getAttribute("href");
    if (!rawHref) return;

    let url;
    try {
      url = new URL(rawHref);
    } catch {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    event.preventDefault();
    postEmbeddedHostMessage({
      type: "taskboard:open-external",
      payload: { url: url.href },
    });
  };

  document.addEventListener("click", handleClick, true);
  return () => document.removeEventListener("click", handleClick, true);
}
