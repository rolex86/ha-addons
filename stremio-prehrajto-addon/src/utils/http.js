import fetch from "node-fetch";
import { ENV } from "../env.js";

function buildHttpError(method, url, res, text) {
  const err = new Error(`${method} ${url} failed with ${res.status} ${res.statusText}`);
  err.status = res.status;
  err.body = (text || "").slice(0, 300);
  return err;
}

export async function httpGet(
  url,
  {
    headers = {},
    timeoutMs = 15000,
    redirect = "follow",
    throwOnHttpError = true,
  } = {},
) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": ENV.PREHRAJTO_USER_AGENT,
        ...headers,
      },
      redirect,
      signal: ctrl.signal,
    });

    const text = await res.text();
    if (throwOnHttpError && !res.ok) throw buildHttpError("GET", url, res, text);
    return { res, text };
  } finally {
    clearTimeout(t);
  }
}

export async function httpHead(
  url,
  {
    headers = {},
    timeoutMs = 15000,
    redirect = "follow",
    throwOnHttpError = true,
  } = {},
) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: {
        "User-Agent": ENV.PREHRAJTO_USER_AGENT,
        ...headers,
      },
      redirect,
      signal: ctrl.signal,
    });

    if (throwOnHttpError && !res.ok) {
      throw buildHttpError("HEAD", url, res, "");
    }
    return { res };
  } finally {
    clearTimeout(t);
  }
}

export async function httpPost(
  url,
  body,
  {
    headers = {},
    timeoutMs = 15000,
    redirect = "manual",
    throwOnHttpError = true,
  } = {},
) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": ENV.PREHRAJTO_USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body,
      redirect,
      signal: ctrl.signal,
    });

    const text = await res.text();
    if (throwOnHttpError && !res.ok) {
      throw buildHttpError("POST", url, res, text);
    }
    return { res, text };
  } finally {
    clearTimeout(t);
  }
}
