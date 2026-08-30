#!/usr/bin/env node
"use strict";
//
// dna runtime server.
//
// A stateless, dependency-free (Node built-ins only) "reveal bytes up to f(now)"
// service. The global cursor is a pure function of wall-clock time:
//
//   current_index = floor((now - start_epoch) * rate)   clamped to [0, N]
//
// so every client renders the same state and the genome streams exactly once
// over the whole runtime. Data is read from the flat artifacts with positioned
// reads (pread); we never load the multi-GB files into memory and never expose
// anything beyond current_index. That single clamp is the entire enforcement of
// the "not retrievable at once" constraint.
//
const http = require("http");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Config: defaults < config.json < environment.
// ---------------------------------------------------------------------------
function loadConfig() {
  const cfg = {
    artifactsDir: "./artifacts",
    webDir: "./web",
    listen: "8080",
    startEpoch: null, // unix seconds (number) or RFC3339 string
    rate: null, // bases per second
    runtimeSeconds: null, // alternative to rate
    tail: 4096, // bases sent to a fresh client for visual continuity
    tickMs: 250, // server reveal cadence
    pileup: null, // null = auto (enabled iff artifacts present)
    attractions: true,
    attractionSpecies: "homo_sapiens",
    attractionAssembly: "GRCh38",
    attractionWindowBases: 200000,
    attractionDeadAirMs: 30000,
    attractionMinIntervalMs: 12000,
    attractionMaxIntervalMs: 45000,
    attractionCacheSize: 96,
    attractionHistorySize: 8,
    attractionFetchTimeoutMs: 12000,
  };
  const cfgPath = process.env.DNA_CONFIG || path.join(__dirname, "config.json");
  if (fs.existsSync(cfgPath)) {
    Object.assign(cfg, JSON.parse(fs.readFileSync(cfgPath, "utf8")));
  }
  const env = process.env;
  const ENV_MAP = [
    ["DNA_ARTIFACTS_DIR", "artifactsDir"],
    ["DNA_WEB_DIR", "webDir"],
    ["DNA_LISTEN", "listen"],
    ["DNA_START_EPOCH", "startEpoch"],
    ["DNA_RATE", "rate", Number],
    ["DNA_RUNTIME_SECONDS", "runtimeSeconds", Number],
    ["DNA_TAIL", "tail", Number],
    ["DNA_TICK_MS", "tickMs", Number],
    ["DNA_PILEUP", "pileup", (v) => v === "true"],
    ["DNA_ATTRACTIONS", "attractions", (v) => v === "true"],
    ["DNA_ATTRACTION_SPECIES", "attractionSpecies"],
    ["DNA_ATTRACTION_ASSEMBLY", "attractionAssembly"],
    ["DNA_ATTRACTION_WINDOW_BASES", "attractionWindowBases", Number],
    ["DNA_ATTRACTION_DEAD_AIR_MS", "attractionDeadAirMs", Number],
    ["DNA_ATTRACTION_MIN_INTERVAL_MS", "attractionMinIntervalMs", Number],
    ["DNA_ATTRACTION_MAX_INTERVAL_MS", "attractionMaxIntervalMs", Number],
    ["DNA_ATTRACTION_CACHE_SIZE", "attractionCacheSize", Number],
    ["DNA_ATTRACTION_HISTORY_SIZE", "attractionHistorySize", Number],
    ["DNA_ATTRACTION_FETCH_TIMEOUT_MS", "attractionFetchTimeoutMs", Number],
  ];
  for (const [envKey, cfgKey, parse] of ENV_MAP) {
    if (env[envKey] != null) cfg[cfgKey] = parse ? parse(env[envKey]) : env[envKey];
  }
  return cfg;
}

function parseEpochSeconds(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`cannot parse start epoch: ${v}`);
  return ms / 1000;
}

// ---------------------------------------------------------------------------
// State: opened once at startup.
// ---------------------------------------------------------------------------
function openState(cfg) {
  const dir = cfg.artifactsDir;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const N = meta.n;

  const consensusFd = fs.openSync(path.join(dir, "consensus.bin"), "r");

  // pileup is auto-enabled iff the artifacts exist (unless force-disabled).
  const pileupBinPath = path.join(dir, "pileup.bin");
  const pileupIdxPath = path.join(dir, "pileup.idx");
  const havePileup = fs.existsSync(pileupBinPath) && fs.existsSync(pileupIdxPath);
  const pileupEnabled = cfg.pileup !== false && havePileup;
  let pileupBinFd = null;
  let pileupIdxFd = null;
  if (pileupEnabled) {
    pileupBinFd = fs.openSync(pileupBinPath, "r");
    pileupIdxFd = fs.openSync(pileupIdxPath, "r");
  }

  // pacing: explicit config beats meta defaults; resolve to a single rate.
  const pacing = meta.pacing || {};
  const startEpoch = parseEpochSeconds(
    cfg.startEpoch != null ? cfg.startEpoch : pacing.start_epoch
  );
  if (startEpoch === null) throw new Error("no start epoch configured (config.startEpoch or meta.pacing.start_epoch)");

  let rate = cfg.rate != null ? cfg.rate : pacing.rate_bases_per_sec;
  const runtime = cfg.runtimeSeconds != null ? cfg.runtimeSeconds : pacing.runtime_seconds;
  if ((!rate || rate <= 0) && runtime && runtime > 0) rate = N / runtime;
  if (!rate || rate <= 0) throw new Error("no pacing configured (set rate or runtimeSeconds)");

  return {
    cfg,
    meta,
    N,
    consensusFd,
    pileupEnabled,
    pileupBinFd,
    pileupIdxFd,
    startEpoch,
    rate,
    tail: cfg.tail,
    tickMs: cfg.tickMs,
    clients: new Set(),
    attractions: createAttractionState(cfg),
  };
}

function ucscAssemblyFor(assembly) {
  const asm = String(assembly || "GRCH38").toUpperCase();
  if (asm === "GRCH37") {
    return { genome: "hg19", track: "phastCons46way", label: "46 vertebrates" };
  }
  return { genome: "hg38", track: "phastCons100way", label: "100 vertebrates" };
}

function createAttractionState(cfg) {
  const assembly = String(cfg.attractionAssembly || "GRCh38").toUpperCase();
  const ucsc = ucscAssemblyFor(assembly);
  const enabled = cfg.attractions !== false;
  return {
    enabled,
    species: cfg.attractionSpecies,
    assembly,
    ucscGenome: ucsc.genome,
    ucscConsTrack: ucsc.track,
    ucscConsLabel: ucsc.label,
    windowBases: clampInt(cfg.attractionWindowBases, 1000, 5000000, 200000),
    deadAirMs: clampInt(cfg.attractionDeadAirMs, 0, 3600000, 30000),
    minIntervalMs: clampInt(cfg.attractionMinIntervalMs, 1000, 3600000, 12000),
    maxIntervalMs: clampInt(cfg.attractionMaxIntervalMs, 1000, 3600000, 45000),
    cacheSize: clampInt(cfg.attractionCacheSize, 4, 1024, 96),
    historySize: clampInt(cfg.attractionHistorySize, 1, 64, 8),
    fetchTimeoutMs: clampInt(cfg.attractionFetchTimeoutMs, 1000, 120000, 12000),
    serverBase: assembly === "GRCH37"
      ? "https://grch37.rest.ensembl.org"
      : "https://rest.ensembl.org",
    webBase: assembly === "GRCH37"
      ? "https://grch37.ensembl.org"
      : "https://www.ensembl.org",
    history: [],
    cache: new Map(),
    timer: null,
    running: false,
    nextEmitAt: 0,
    lastWindowKey: null,
    idleSince: 0,
    inflight: null,
  };
}

function clampInt(v, min, max, fallback) {
  if (!Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function currentIndex(st, nowMs) {
  const elapsed = nowMs / 1000 - st.startEpoch;
  if (elapsed <= 0) return 0;
  const idx = Math.floor(elapsed * st.rate);
  return idx > st.N ? st.N : idx;
}

// Positioned read of [start, end) from a fd as a latin1 (raw ASCII) string.
function readBases(fd, start, end) {
  const len = end - start;
  if (len <= 0) return "";
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, start + got);
    if (n <= 0) break;
    got += n;
  }
  return buf.toString("latin1", 0, got);
}

function contigFor(st, pos) {
  const c = st.meta.contigs;
  let lo = 0;
  let hi = c.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c[mid].start <= pos) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const ctg = c[ans];
  return { name: ctg.name, coord: pos - ctg.start + 1 };
}

function normalizeContigName(name) {
  let v = String(name || "").trim();
  v = v.replace(/^chr/i, "");
  if (v === "M") return "MT";
  return v;
}

function attractionWindowFor(st, pos) {
  const c = contigFor(st, pos);
  const ctg = st.meta.contigs.find((x) => x.name === c.name);
  if (!ctg) return null;
  const seq = normalizeContigName(c.name);
  const win = st.attractions.windowBases;
  const bucket = Math.floor((c.coord - 1) / win);
  const start = bucket * win + 1;
  const end = Math.min(ctg.length, start + win - 1);
  return {
    key: `${seq}:${start}-${end}:${st.attractions.assembly}`,
    contig: c.name,
    seqRegion: seq,
    start,
    end,
  };
}

function jitterMs(st) {
  const a = st.attractions.minIntervalMs;
  const b = Math.max(a, st.attractions.maxIntervalMs);
  return a + Math.floor(Math.random() * (b - a + 1));
}

function broadcast(st, obj) {
  for (const res of st.clients) {
    try {
      sseWrite(res, obj);
    } catch (_) {
      // close handlers prune dead connections.
    }
  }
}

function pruneCache(st) {
  const tv = st.attractions;
  while (tv.cache.size > tv.cacheSize) {
    const oldest = tv.cache.keys().next();
    if (oldest.done) break;
    tv.cache.delete(oldest.value);
  }
}

function pushAttractionHistory(st, attraction) {
  const tv = st.attractions;
  tv.history.push(attraction);
  if (tv.history.length > tv.historySize) {
    tv.history.splice(0, tv.history.length - tv.historySize);
  }
}

function upsertCacheEntry(st, key, patch) {
  const tv = st.attractions;
  const cur = tv.cache.get(key) || { key, attractions: [], cursor: 0 };
  tv.cache.set(key, Object.assign(cur, patch));
  pruneCache(st);
  return tv.cache.get(key);
}

function attractionSourceScore(source, clinical) {
  const s = String(source || "").toLowerCase();
  const c = String(clinical || "").toLowerCase();
  if (s.includes("clinvar")) {
    if (c.includes("pathogenic")) return 110;
    if (c.includes("likely pathogenic")) return 104;
    return 96;
  }
  if (s.includes("gwas")) return 100;
  if (s.includes("omim")) return 100;
  if (s.includes("cancer gene census")) return 99;
  if (s.includes("cosmic")) return 94;
  if (s.includes("g2p")) return 92;
  if (s.includes("hgmd")) return 90;
  return 80;
}

function shortGeneName(gene) {
  return gene.external_name || gene.gene_id || gene.id || "an unnamed gene";
}

function titleCaseLoose(s) {
  return String(s || "").replace(/\b([a-z])/g, (m, ch) => ch.toUpperCase());
}

function prettifyGeneDescription(description) {
  const raw = String(description || "").trim();
  if (!raw) return "";
  const match = raw.match(/^(.*?)\s*\[Source:(.*)\]$/i);
  if (!match) return raw;
  const label = match[1].trim();
  const meta = match[2]
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.indexOf(":");
      if (idx === -1) return titleCaseLoose(part);
      const key = titleCaseLoose(part.slice(0, idx).trim());
      const value = part.slice(idx + 1).trim();
      return `${key}: ${value}`;
    })
    .join("; ");
  return meta ? `${label} (${meta})` : label;
}

function compact(s, max) {
  const v = String(s || "").replace(/\s+/g, " ").trim();
  if (v.length <= max) return v;
  return `${v.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}


const REGULATORY_CLASS = {
  promoter_like: {
    title: "promoter-like cCREs",
    detail: "promoter-like signature",
    score: 82,
  },
  enhancer_like: {
    title: "enhancer-like cCREs",
    detail: "proximal enhancer-like signature",
    score: 78,
  },
  distal: {
    title: "distal cCREs",
    detail: "distal enhancer-like signature",
    score: 74,
  },
  ctcf_bound: {
    title: "CTCF-bound cCREs",
    detail: "CTCF binding signature",
    score: 72,
  },
};

const CCRE_LABEL_TO_CLASS = {
  PLS: "promoter_like",
  pELS: "enhancer_like",
  dELS: "distal",
  "CTCF-only": "ctcf_bound",
  "CTCF-bound": "ctcf_bound",
};

const ENSEMBL_REGULATORY_TO_CLASS = {
  promoter: "promoter_like",
  enhancer: "enhancer_like",
  CTCF_binding_site: "ctcf_bound",
  open_chromatin_region: "distal",
};

function classifyCcreElements(ccreItems) {
  const counts = new Map();
  for (const item of ccreItems) {
    const labels = String(item.ccre || item.encodeLabel || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    for (const label of labels) {
      const cls = CCRE_LABEL_TO_CLASS[label];
      if (cls) counts.set(cls, (counts.get(cls) || 0) + 1);
    }
  }
  return counts;
}

function classifyEnsemblRegulatory(regulatory) {
  const counts = new Map();
  for (const item of regulatory) {
    const cls = ENSEMBL_REGULATORY_TO_CLASS[item.description];
    if (cls) counts.set(cls, (counts.get(cls) || 0) + 1);
  }
  return counts;
}

function buildRegulatoryAttractions(st, region, classCounts, source) {
  const out = [];
  for (const [classKey, meta] of Object.entries(REGULATORY_CLASS)) {
    const n = classCounts.get(classKey) || 0;
    if (!n) continue;
    out.push({
      id: `${region.key}:reg:${classKey}:${n}`,
      windowKey: region.key,
      category: "regulation",
      score: meta.score,
      title: meta.title,
      detail: compact(`${n} ${meta.detail}${n === 1 ? "" : "s"} overlap this window.`, 150),
      source,
      url: source === "ENCODE SCREEN cCRE" ? buildUcscRegionUrl(st, region) : undefined,
      region: { contig: region.contig, start: region.start, end: region.end },
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

function topPhenotypeAttraction(region, records, kind) {
  const flattened = [];
  for (const rec of records) {
    for (const assoc of rec.phenotype_associations || []) {
      flattened.push({
        id: rec.id,
        description: assoc.description,
        source: assoc.source,
        clinical: assoc.attributes && assoc.attributes.clinical_significance,
        gene: (assoc.attributes && assoc.attributes.associated_gene) || null,
      });
    }
  }
  if (!flattened.length) return null;
  flattened.sort((a, b) => attractionSourceScore(b.source, b.clinical) - attractionSourceScore(a.source, a.clinical));
  const top = flattened[0];
  const clinical = top.clinical ? ` (${top.clinical})` : "";
  const label = kind === "variant" ? top.id : (top.gene || top.id);
  return {
    id: `${region.key}:${kind}:${top.id}:${top.description}`,
    windowKey: region.key,
    category: kind === "variant" ? "disease" : "trait",
    score: attractionSourceScore(top.source, top.clinical),
    title: `${top.source}: ${label}`,
    detail: compact(`${top.description}${clinical}`, 150),
    source: `Ensembl ${top.source}`,
    region: {
      contig: region.contig,
      start: region.start,
      end: region.end,
    },
  };
}

function buildRegionUrl(st, region) {
  const seqRegion = region.seqRegion || normalizeContigName(region.contig);
  return `${st.attractions.webBase}/Homo_sapiens/Location/View?r=${encodeURIComponent(
    `${seqRegion}:${region.start}-${region.end}`
  )}`;
}

function ucscChromName(contig) {
  const v = String(contig || "").trim();
  if (/^chr/i.test(v)) return v;
  return `chr${v}`;
}

function buildUcscRegionUrl(st, region) {
  const chrom = ucscChromName(region.contig);
  return `https://genome.ucsc.edu/cgi-bin/hgTracks?db=${encodeURIComponent(
    st.attractions.ucscGenome
  )}&position=${encodeURIComponent(`${chrom}:${region.start}-${region.end}`)}`;
}

function decorateAttraction(st, attraction) {
  if (attraction.url) return attraction;
  return Object.assign(attraction, {
    url: buildRegionUrl(st, attraction.region),
  });
}

const UCSC_API = "https://api.genome.ucsc.edu";
const CONS_PROBE_COUNT = 8;
const CONS_PROBE_SIZE = 2048;
const CONS_HIGH = 0.9;

function conservationProbesFor(region) {
  const span = region.end - region.start + 1;
  const probes = [];
  for (let i = 0; i < CONS_PROBE_COUNT; i++) {
    const center = region.start + Math.floor(((i + 0.5) / CONS_PROBE_COUNT) * span);
    let start = Math.max(region.start, center - Math.floor(CONS_PROBE_SIZE / 2));
    let end = Math.min(region.end, start + CONS_PROBE_SIZE - 1);
    start = Math.max(region.start, end - CONS_PROBE_SIZE + 1);
    probes.push({ start, end });
  }
  return probes;
}

function summarizeConservationValues(items) {
  let sum = 0;
  let high = 0;
  let max = 0;
  let n = 0;
  for (const item of items) {
    const len = item.end - item.start;
    if (len <= 0) continue;
    const v = Number(item.value);
    if (!Number.isFinite(v)) continue;
    sum += v * len;
    n += len;
    if (v >= CONS_HIGH) high += len;
    if (v > max) max = v;
  }
  return {
    bases: n,
    mean: n ? sum / n : 0,
    highFraction: n ? high / n : 0,
    max,
  };
}

function isConservationHotspot(summary) {
  if (!summary || summary.bases <= 0) return false;
  return (
    summary.highFraction >= 0.08 ||
    summary.mean >= 0.65 ||
    (summary.max >= 0.99 && summary.highFraction >= 0.02)
  );
}

function conservationPct(fraction) {
  return `${Math.round(fraction * 1000) / 10}%`;
}

function buildConservationAttraction(st, region, summary) {
  const label = st.attractions.ucscConsLabel;
  const highPct = conservationPct(summary.highFraction);
  const meanPct = conservationPct(summary.mean);
  const maxPct = conservationPct(summary.max);
  let detail;
  if (summary.highFraction >= 0.12) {
    detail = `This stretch is unusually preserved across ${label}—about ${highPct} of sampled bases sit in the top conservation tier—which usually means function matters here.`;
  } else if (summary.mean >= 0.65) {
    detail = `Conservation runs high here (mean ${meanPct} across ${label}), hinting that selection has held this sequence steady across species.`;
  } else {
    detail = `Highly conserved peaks (up to ${maxPct}) show up across ${label}, marking pockets where sequence change is rare and function likely matters.`;
  }
  const score = clampInt(
    72 + summary.highFraction * 40 + summary.mean * 18 + summary.max * 6,
    68,
    88,
    76
  );
  return {
    id: `${region.key}:conservation:${highPct}:${meanPct}`,
    windowKey: region.key,
    category: "conservation",
    score,
    title: "conservation hotspot",
    detail: compact(detail, 150),
    source: "UCSC phastCons",
    url: buildUcscRegionUrl(st, region),
    region: { contig: region.contig, start: region.start, end: region.end },
  };
}

async function fetchUcscConservationProbe(st, region, probe, signal) {
  const tv = st.attractions;
  const endpoint = new URL("/getData/track", UCSC_API);
  endpoint.searchParams.set("genome", tv.ucscGenome);
  endpoint.searchParams.set("track", tv.ucscConsTrack);
  endpoint.searchParams.set("chrom", ucscChromName(region.contig));
  endpoint.searchParams.set("start", String(probe.start - 1));
  endpoint.searchParams.set("end", String(probe.end));
  const res = await fetch(endpoint, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    throw new Error(`ucsc ${res.status} for ${endpoint.pathname}`);
  }
  const data = await res.json();
  return data[tv.ucscConsTrack] || [];
}

async function fetchConservationForWindow(st, region, signal) {
  const probes = conservationProbesFor(region);
  const chunks = await Promise.all(
    probes.map((probe) => fetchUcscConservationProbe(st, region, probe, signal))
  );
  const summary = summarizeConservationValues(chunks.flat());
  return isConservationHotspot(summary) ? summary : null;
}

function buildAttractions(st, region, genes, regulatory, ccreItems, genePhenotypes, variantPhenotypes, conservation) {
  const out = [];
  const overlappingGenes = genes.filter((g) => g.start <= region.end && g.end >= region.start);
  if (overlappingGenes.length) {
    const ranked = overlappingGenes
      .slice()
      .sort((a, b) => {
        const pa = a.biotype === "protein_coding" ? 1 : 0;
        const pb = b.biotype === "protein_coding" ? 1 : 0;
        if (pb !== pa) return pb - pa;
        return (b.end - b.start) - (a.end - a.start);
      });
    const top = ranked[0];
    out.push({
      id: `${region.key}:gene:${top.id}`,
      windowKey: region.key,
      category: "gene",
      score: top.biotype === "protein_coding" ? 92 : 80,
      title: `inside ${shortGeneName(top)}`,
      detail: compact(
        prettifyGeneDescription(top.description) || `${shortGeneName(top)} overlaps this part of ${region.contig}.`,
        150
      ),
      source: "Ensembl gene model",
      region: { contig: region.contig, start: region.start, end: region.end },
    });
  } else if (genes.length) {
    const center = Math.floor((region.start + region.end) / 2);
    const nearest = genes
      .slice()
      .sort((a, b) => {
        const da = Math.min(Math.abs(a.start - center), Math.abs(a.end - center));
        const db = Math.min(Math.abs(b.start - center), Math.abs(b.end - center));
        return da - db;
      })[0];
    out.push({
      id: `${region.key}:near:${nearest.id}`,
      windowKey: region.key,
      category: "gene",
      score: nearest.biotype === "protein_coding" ? 74 : 64,
      title: `nearest gene: ${shortGeneName(nearest)}`,
      detail: compact(
        prettifyGeneDescription(nearest.description) || `${shortGeneName(nearest)} is the nearest annotated gene here.`,
        150
      ),
      source: "Ensembl gene model",
      region: { contig: region.contig, start: region.start, end: region.end },
    });
  }

  const genePhenotype = topPhenotypeAttraction(region, genePhenotypes, "gene");
  if (genePhenotype) out.push(genePhenotype);

  const variantPhenotype = topPhenotypeAttraction(region, variantPhenotypes, "variant");
  if (variantPhenotype) out.push(variantPhenotype);

  const ccreCounts = classifyCcreElements(ccreItems);
  const regulatoryCounts = ccreCounts.size
    ? ccreCounts
    : classifyEnsemblRegulatory(regulatory);
  if (regulatoryCounts.size) {
    const source = ccreCounts.size ? "ENCODE SCREEN cCRE" : "Ensembl regulation";
    out.push(...buildRegulatoryAttractions(st, region, regulatoryCounts, source));
  }

  if (conservation) {
    out.push(buildConservationAttraction(st, region, conservation));
  }

  if (!out.length) {
    out.push({
      id: `${region.key}:quiet`,
      windowKey: region.key,
      category: "quiet",
      score: 10,
      title: "quiet stretch",
      detail: `No standout gene, disease, or regulatory landmark was found in ${region.contig}:${region.start.toLocaleString("en-US")}-${region.end.toLocaleString("en-US")}.`,
      source: "Ensembl region summary",
      region: { contig: region.contig, start: region.start, end: region.end },
    });
  }

  const seen = new Set();
  return out
    .sort((a, b) => b.score - a.score)
    .filter((item) => {
      const k = `${item.title}|${item.detail}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((item) => decorateAttraction(st, item));
}

async function fetchJsonWithTimeout(st, pathname, query, signal) {
  const endpoint = new URL(pathname, st.attractions.serverBase);
  for (const [key, value] of query) endpoint.searchParams.append(key, value);
  endpoint.searchParams.append("content-type", "application/json");
  const res = await fetch(endpoint, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    throw new Error(`ensembl ${res.status} for ${endpoint.pathname}`);
  }
  return res.json();
}

async function fetchCcreForWindow(st, region, signal) {
  const tv = st.attractions;
  if (tv.assembly !== "GRCH38") return [];
  const endpoint = new URL("/getData/track", UCSC_API);
  endpoint.searchParams.set("genome", tv.ucscGenome);
  endpoint.searchParams.set("track", "encodeCcreCombined");
  endpoint.searchParams.set("chrom", ucscChromName(region.contig));
  endpoint.searchParams.set("start", String(region.start - 1));
  endpoint.searchParams.set("end", String(region.end));
  const res = await fetch(endpoint, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    throw new Error(`ucsc ccre ${res.status} for ${region.key}`);
  }
  const data = await res.json();
  if (data.error) return [];
  return data.encodeCcreCombined || [];
}

async function fetchAttractionsForWindow(st, region) {
  const tv = st.attractions;
  const queryRegion = `${region.seqRegion}:${region.start}-${region.end}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), tv.fetchTimeoutMs);
  tv.inflight = { key: region.key, controller: ac };
  upsertCacheEntry(st, region.key, { status: "fetching", region });
  try {
    const overlapSpecies = tv.species === "homo_sapiens" ? "human" : tv.species;
    const conservationPromise = fetchConservationForWindow(st, region, ac.signal).catch((err) => {
      if (err && err.name !== "AbortError") {
        console.error(`conservation fetch failed for ${region.key}: ${err.message}`);
      }
      return null;
    });
    const ccrePromise = fetchCcreForWindow(st, region, ac.signal).catch((err) => {
      if (err && err.name !== "AbortError") {
        console.error(`cCRE fetch failed for ${region.key}: ${err.message}`);
      }
      return [];
    });
    const [overlap, genePhenotypes, variantPhenotypes, conservation, ccreItems] = await Promise.all([
      fetchJsonWithTimeout(
        st,
        `/overlap/region/${overlapSpecies}/${queryRegion}`,
        [["feature", "gene"], ["feature", "regulatory"]],
        ac.signal
      ),
      fetchJsonWithTimeout(
        st,
        `/phenotype/region/${tv.species}/${queryRegion}`,
        [["feature_type", "Gene"]],
        ac.signal
      ),
      fetchJsonWithTimeout(
        st,
        `/phenotype/region/${tv.species}/${queryRegion}`,
        [["feature_type", "Variation"]],
        ac.signal
      ),
      conservationPromise,
      ccrePromise,
    ]);

    const genes = overlap.filter((item) => item.feature_type === "gene");
    const regulatory = overlap.filter((item) => item.feature_type === "regulatory");
    const attractions = buildAttractions(
      st,
      region,
      genes,
      regulatory,
      ccreItems,
      genePhenotypes,
      variantPhenotypes,
      conservation
    );
    upsertCacheEntry(st, region.key, {
      status: "ready",
      region,
      attractions,
      cursor: 0,
    });
  } catch (err) {
    if (err && err.name !== "AbortError") {
      console.error(`attractions fetch failed for ${region.key}: ${err.message}`);
    }
    upsertCacheEntry(st, region.key, {
      status: "error",
      region,
      errorAt: Date.now(),
      attractions: [],
      cursor: 0,
    });
  } finally {
    clearTimeout(timer);
    if (tv.inflight && tv.inflight.key === region.key) {
      tv.inflight = null;
    }
  }
}

function startAttractionLoop(st) {
  const tv = st.attractions;
  if (!tv.enabled) return;
  tv.idleSince = 0;
  if (!tv.nextEmitAt) tv.nextEmitAt = Date.now() + jitterMs(st);
  if (tv.timer) return;
  tv.timer = setInterval(() => {
    void runAttractionLoop(st);
  }, 1000);
}

function stopAttractionLoop(st) {
  const tv = st.attractions;
  if (tv.timer) {
    clearInterval(tv.timer);
    tv.timer = null;
  }
  if (tv.inflight) {
    tv.inflight.controller.abort();
    tv.inflight = null;
  }
  tv.running = false;
  tv.idleSince = 0;
  tv.nextEmitAt = 0;
  tv.lastWindowKey = null;
}

async function runAttractionLoop(st) {
  const tv = st.attractions;
  if (!tv.enabled || tv.running) return;
  tv.running = true;
  try {
    if (st.clients.size === 0) {
      if (!tv.idleSince) tv.idleSince = Date.now();
      if (Date.now() - tv.idleSince >= tv.deadAirMs) stopAttractionLoop(st);
      return;
    }

    tv.idleSince = 0;
    const region = attractionWindowFor(st, Math.max(0, currentIndex(st, Date.now()) - 1));
    if (!region) return;
    let entry = tv.cache.get(region.key);

    if (!entry || (entry.status === "error" && Date.now() - (entry.errorAt || 0) > 60000)) {
      await fetchAttractionsForWindow(st, region);
      entry = tv.cache.get(region.key);
    }

    if (!entry || entry.status !== "ready" || !entry.attractions.length) return;

    const changedWindow = tv.lastWindowKey !== region.key;
    if (changedWindow || Date.now() >= tv.nextEmitAt) {
      const idx = entry.cursor % entry.attractions.length;
      const emittedAt = Date.now();
      const durationMs = jitterMs(st);
      const attraction = Object.assign({}, entry.attractions[idx], {
        emittedAt,
        durationMs,
        expiresAt: emittedAt + durationMs,
      });
      entry.cursor = (idx + 1) % entry.attractions.length;
      tv.lastWindowKey = region.key;
      tv.nextEmitAt = attraction.expiresAt;
      pushAttractionHistory(st, attraction);
      broadcast(st, { type: "attraction", attraction });
    }
  } finally {
    tv.running = false;
  }
}

// ---------------------------------------------------------------------------
// HTTP handlers.
// ---------------------------------------------------------------------------
function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function handleStream(st, req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // belt-and-braces if a proxy buffers
  });

  let last = currentIndex(st, Date.now());
  const tailStart = Math.max(0, last - st.tail);
  sseWrite(res, {
    type: "hello",
    index: last,
    n: st.N,
    rate: st.rate,
    startEpoch: st.startEpoch,
    pileup: st.pileupEnabled,
    contigs: st.meta.contigs,
    tail: readBases(st.consensusFd, tailStart, last),
    tailStart,
    attractionsEnabled: st.attractions.enabled,
    attractions: st.attractions.history,
  });

  st.clients.add(res);
  startAttractionLoop(st);

  let completeSent = false;
  const timer = setInterval(() => {
    const cur = currentIndex(st, Date.now());
    if (cur > last) {
      sseWrite(res, { type: "tick", index: cur, bases: readBases(st.consensusFd, last, cur) });
      last = cur;
    }
    if (cur >= st.N && !completeSent) {
      sseWrite(res, { type: "complete", index: st.N });
      completeSent = true;
    }
  }, st.tickMs);

  const stop = () => {
    clearInterval(timer);
    st.clients.delete(res);
  };
  req.on("close", stop);
  res.on("close", stop);
}

function handlePileup(st, query, res) {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(obj));
  };
  if (!st.pileupEnabled) return send(404, { error: "pileup not available" });
  const pos = Number.parseInt(query.pos, 10);
  if (!Number.isInteger(pos) || pos < 0 || pos >= st.N) return send(400, { error: "bad pos" });
  const cur = currentIndex(st, Date.now());
  if (pos > cur) return send(403, { error: "not yet revealed" }); // never leak the future

  const idxBuf = Buffer.allocUnsafe(16);
  fs.readSync(st.pileupIdxFd, idxBuf, 0, 16, pos * 8);
  const o1 = Number(idxBuf.readBigUInt64LE(0));
  const o2 = Number(idxBuf.readBigUInt64LE(8));
  const bases = readBases(st.pileupBinFd, o1, o2);
  const ref = readBases(st.consensusFd, pos, pos + 1);
  const { name, coord } = contigFor(st, pos);
  send(200, { pos, contig: name, coord, ref, depth: bases.length, bases });
}

function serveStatic(st, res) {
  const file = path.join(st.cfg.webDir, "index.html");
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("index.html not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}

function main() {
  const cfg = loadConfig();
  const st = openState(cfg);
  console.log(
    `dna: N=${st.N} rate=${st.rate.toFixed(3)} b/s start=${new Date(
      st.startEpoch * 1000
    ).toISOString()} pileup=${st.pileupEnabled} attractions=${st.attractions.enabled ? "on" : "off"}`
  );

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (parsed.pathname === "/stream") return handleStream(st, req, res);
    if (parsed.pathname === "/pileup") return handlePileup(st, Object.fromEntries(parsed.searchParams), res);
    if (parsed.pathname === "/" || parsed.pathname === "/index.html") return serveStatic(st, res);
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  // listen target may be "PORT" or "HOST:PORT".
  const listen = String(cfg.listen);
  if (listen.includes(":")) {
    const [host, port] = listen.split(":");
    server.listen(Number(port), host || "0.0.0.0", () => console.log(`listening on ${listen}`));
  } else {
    server.listen(Number(listen), "0.0.0.0", () => console.log(`listening on :${listen}`));
  }
}

main();
