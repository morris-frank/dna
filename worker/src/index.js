// dna runtime worker.
//
// A stateless "reveal bytes up to f(now)" service on Workers + R2. The global
// cursor is a pure function of wall-clock time:
//
//   current_index = floor((now - start_epoch) * rate)   clamped to [0, N]
//
// so every client renders the same state and the genome streams exactly once
// over the whole runtime.
//
// THE GATE: readBases() is the only path from R2 to a response body, and every
// caller clamps `end` to currentIndex() before reaching it. The R2 bucket is
// private and has no public access, so this function is the sole way any base
// leaves storage. Nothing beyond current_index is readable, by anyone, ever.
// If you add an endpoint that touches the consensus, it goes through here.

import {
  attractionWindowFor,
  contigFor,
  createAttractionConfig,
  currentAttraction,
  fetchAttractionsForWindow,
} from "./attractions.js";

const CONSENSUS_KEY = "consensus.bin";
const META_KEY = "meta.json";
const PILEUP_BIN_KEY = "pileup.bin";
const PILEUP_IDX_KEY = "pileup.idx";

// Cached for the lifetime of the isolate; the artifacts never change.
let metaPromise = null;

function loadMeta(env) {
  if (!metaPromise) {
    metaPromise = (async () => {
      const obj = await env.GENOME.get(META_KEY);
      if (!obj) throw new Error(`${META_KEY} not found in bucket`);
      return obj.json();
    })().catch((err) => {
      metaPromise = null; // let the next request retry
      throw err;
    });
  }
  return metaPromise;
}

function parseEpochSeconds(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const asNumber = Number(v);
  if (Number.isFinite(asNumber) && String(v).trim() !== "") return asNumber;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms / 1000;
}

// Pacing precedence matches the old server: explicit config beats meta defaults.
function resolveConfig(env, meta) {
  const N = meta.n;
  const pacing = meta.pacing || {};
  const startEpoch = parseEpochSeconds(env.START_EPOCH ?? pacing.start_epoch);
  if (startEpoch === null) throw new Error("no start epoch configured");

  let rate = env.RATE != null && env.RATE !== "" ? Number(env.RATE) : pacing.rate_bases_per_sec;
  const runtime = env.RUNTIME_SECONDS != null && env.RUNTIME_SECONDS !== ""
    ? Number(env.RUNTIME_SECONDS)
    : pacing.runtime_seconds;
  if ((!rate || rate <= 0) && runtime && runtime > 0) rate = N / runtime;
  if (!rate || rate <= 0) throw new Error("no pacing configured (set RATE or RUNTIME_SECONDS)");

  return {
    N,
    startEpoch,
    rate,
    contigs: meta.contigs,
    tail: Number(env.TAIL) > 0 ? Math.floor(Number(env.TAIL)) : 4096,
    headMaxSpan: Number(env.HEAD_MAX_SPAN) > 0 ? Math.floor(Number(env.HEAD_MAX_SPAN)) : 65536,
    pileup: String(env.PILEUP ?? "") === "true" || (env.PILEUP == null && meta.pileup === true),
  };
}

function currentIndex(cfg, nowMs) {
  const elapsed = nowMs / 1000 - cfg.startEpoch;
  if (elapsed <= 0) return 0;
  const idx = Math.floor(elapsed * cfg.rate);
  return idx > cfg.N ? cfg.N : idx;
}

function bytesToBases(buffer) {
  const u8 = new Uint8Array(buffer);
  let out = "";
  const CH = 8192;
  for (let i = 0; i < u8.length; i += CH) {
    out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return out;
}

// The gate. Range-read [start, end) from a private R2 object.
async function readBases(env, key, start, end) {
  const length = end - start;
  if (length <= 0) return "";
  const obj = await env.GENOME.get(key, { range: { offset: start, length } });
  if (!obj) throw new Error(`${key} not found in bucket`);
  return bytesToBases(await obj.arrayBuffer());
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers || {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------
function handleMeta(cfg, acfg) {
  return json(
    {
      n: cfg.N,
      rate: cfg.rate,
      startEpoch: cfg.startEpoch,
      pileup: cfg.pileup,
      contigs: cfg.contigs,
      attractionsEnabled: acfg.enabled,
      tail: cfg.tail,
    },
    { headers: { "Cache-Control": "public, max-age=3600" } }
  );
}

async function handleHead(env, cfg, acfg, url, ctx) {
  const now = Date.now();
  const index = currentIndex(cfg, now);

  // Where the client wants to resume from, clamped into the revealed past.
  const asked = Number.parseInt(url.searchParams.get("from"), 10);
  let from = Number.isInteger(asked) && asked >= 0
    ? Math.min(asked, index)
    : Math.max(0, index - cfg.tail);
  if (index - from > cfg.headMaxSpan) from = index - cfg.headMaxSpan;

  const bases = await readBases(env, CONSENSUS_KEY, from, index);

  let attraction = null;
  if (acfg.enabled && index > 0) {
    try {
      const list = await attractionsFor(env, cfg, acfg, index, url, ctx);
      attraction = currentAttraction(acfg, list, now);
    } catch (_) {
      // attractions are decoration; never fail the stream over them
    }
  }

  return json({ index, from, bases, attraction, serverNow: now, complete: index >= cfg.N });
}

// One window's attraction list, memoised in the edge cache. With no viewers
// there are no requests, so there are no upstream fetches either - the same
// quiet-when-nobody-is-listening behaviour the old dead-air timer gave us.
async function attractionsFor(env, cfg, acfg, index, url, ctx) {
  const region = attractionWindowFor(cfg.contigs, acfg, Math.max(0, index - 1));
  if (!region) return [];

  // The key has to sit on this zone - the Cache API refuses hostnames the
  // Worker does not control, and a refused key means we would re-fetch Ensembl
  // on every single request.
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/__attractions/${encodeURIComponent(region.key)}`);
  try {
    const hit = await cache.match(cacheKey);
    if (hit) return hit.json();
  } catch (_) {
    // a cache miss must never cost us the attraction
  }

  const list = await fetchAttractionsForWindow(acfg, region);
  // An empty list means every upstream was down. Hold it briefly so a degraded
  // Ensembl does not make each request pay the full fetch timeout, but retry
  // long before the hour a good result gets.
  const ttl = list.length ? acfg.cacheTtlSeconds : 120;
  const stash = new Response(JSON.stringify(list), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ttl}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, stash).catch(() => {}));
  return list;
}

async function handlePileup(env, cfg, url) {
  if (!cfg.pileup) return json({ error: "pileup not available" }, { status: 404 });
  const pos = Number.parseInt(url.searchParams.get("pos"), 10);
  if (!Number.isInteger(pos) || pos < 0 || pos >= cfg.N) {
    return json({ error: "bad pos" }, { status: 400 });
  }
  if (pos > currentIndex(cfg, Date.now())) {
    return json({ error: "not yet revealed" }, { status: 403 }); // never leak the future
  }

  const idxObj = await env.GENOME.get(PILEUP_IDX_KEY, { range: { offset: pos * 8, length: 16 } });
  if (!idxObj) return json({ error: "pileup index missing" }, { status: 404 });
  const view = new DataView(await idxObj.arrayBuffer());
  const o1 = Number(view.getBigUint64(0, true));
  const o2 = Number(view.getBigUint64(8, true));

  const [bases, ref] = await Promise.all([
    readBases(env, PILEUP_BIN_KEY, o1, o2),
    readBases(env, CONSENSUS_KEY, pos, pos + 1),
  ]);
  const { name, coord } = contigFor(cfg.contigs, pos);
  return json({ pos, contig: name, coord, ref, depth: bases.length, bases });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!["GET", "HEAD"].includes(request.method)) {
      return new Response("method not allowed", { status: 405 });
    }
    if (!["/meta", "/head", "/pileup"].includes(url.pathname)) {
      return env.ASSETS.fetch(request);
    }

    try {
      const meta = await loadMeta(env);
      const cfg = resolveConfig(env, meta);
      const acfg = createAttractionConfig(env);

      if (url.pathname === "/meta") return handleMeta(cfg, acfg);
      if (url.pathname === "/head") return handleHead(env, cfg, acfg, url, ctx);
      return handlePileup(env, cfg, url);
    } catch (err) {
      console.error(err && err.stack ? err.stack : String(err));
      return json({ error: "upstream error" }, { status: 500 });
    }
  },
};
