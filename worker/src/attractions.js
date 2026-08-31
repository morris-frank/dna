// Attraction engine: ported unchanged in behaviour from the Node server.
//
// Everything here is runtime-agnostic (fetch / URL / AbortController), so it
// runs in a Worker isolate as-is. The one structural change from the Node
// version is that emission is no longer a stateful broadcast loop: the current
// attraction is a pure function of the wall clock, so every client derives the
// same one without the server holding a cursor.

const UCSC_API = "https://api.genome.ucsc.edu";
const CONS_PROBE_COUNT = 8;
const CONS_PROBE_SIZE = 2048;
const CONS_HIGH = 0.9;

export function clampInt(v, min, max, fallback) {
  if (!Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function ucscAssemblyFor(assembly) {
  const asm = String(assembly || "GRCH38").toUpperCase();
  if (asm === "GRCH37") {
    return { genome: "hg19", track: "phastCons46way", label: "46 vertebrates" };
  }
  return { genome: "hg38", track: "phastCons100way", label: "100 vertebrates" };
}

export function createAttractionConfig(env) {
  const assembly = String(env.ATTRACTION_ASSEMBLY || "GRCh38").toUpperCase();
  const ucsc = ucscAssemblyFor(assembly);
  return {
    enabled: String(env.ATTRACTIONS ?? "true") !== "false",
    species: env.ATTRACTION_SPECIES || "homo_sapiens",
    assembly,
    ucscGenome: ucsc.genome,
    ucscConsTrack: ucsc.track,
    ucscConsLabel: ucsc.label,
    windowBases: clampInt(Number(env.ATTRACTION_WINDOW_BASES), 1000, 5000000, 200000),
    slotMs: clampInt(Number(env.ATTRACTION_SLOT_MS), 4000, 3600000, 25000),
    fetchTimeoutMs: clampInt(Number(env.ATTRACTION_FETCH_TIMEOUT_MS), 1000, 120000, 12000),
    cacheTtlSeconds: clampInt(Number(env.ATTRACTION_CACHE_TTL_SECONDS), 60, 86400, 3600),
    serverBase: assembly === "GRCH37"
      ? "https://grch37.rest.ensembl.org"
      : "https://rest.ensembl.org",
    webBase: assembly === "GRCH37"
      ? "https://grch37.ensembl.org"
      : "https://www.ensembl.org",
  };
}

// ---------------------------------------------------------------------------
// Region geometry.
// ---------------------------------------------------------------------------
export function contigFor(contigs, pos) {
  let lo = 0;
  let hi = contigs.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (contigs[mid].start <= pos) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const ctg = contigs[ans];
  return { name: ctg.name, coord: pos - ctg.start + 1 };
}

function normalizeContigName(name) {
  let v = String(name || "").trim();
  v = v.replace(/^chr/i, "");
  if (v === "M") return "MT";
  return v;
}

export function attractionWindowFor(contigs, acfg, pos) {
  const c = contigFor(contigs, pos);
  const ctg = contigs.find((x) => x.name === c.name);
  if (!ctg) return null;
  const seq = normalizeContigName(c.name);
  const win = acfg.windowBases;
  const bucket = Math.floor((c.coord - 1) / win);
  const start = bucket * win + 1;
  const end = Math.min(ctg.length, start + win - 1);
  return {
    key: `${seq}:${start}-${end}:${acfg.assembly}`,
    contig: c.name,
    seqRegion: seq,
    start,
    end,
  };
}

// ---------------------------------------------------------------------------
// Scoring and prose.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Regulatory classification.
// ---------------------------------------------------------------------------
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

function buildRegulatoryAttractions(acfg, region, classCounts, source) {
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
      url: source === "ENCODE SCREEN cCRE" ? buildUcscRegionUrl(acfg, region) : undefined,
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

function buildRegionUrl(acfg, region) {
  const seqRegion = region.seqRegion || normalizeContigName(region.contig);
  return `${acfg.webBase}/Homo_sapiens/Location/View?r=${encodeURIComponent(
    `${seqRegion}:${region.start}-${region.end}`
  )}`;
}

function ucscChromName(contig) {
  const v = String(contig || "").trim();
  if (/^chr/i.test(v)) return v;
  return `chr${v}`;
}

function buildUcscRegionUrl(acfg, region) {
  const chrom = ucscChromName(region.contig);
  return `https://genome.ucsc.edu/cgi-bin/hgTracks?db=${encodeURIComponent(
    acfg.ucscGenome
  )}&position=${encodeURIComponent(`${chrom}:${region.start}-${region.end}`)}`;
}

function decorateAttraction(acfg, attraction) {
  if (attraction.url) return attraction;
  return Object.assign(attraction, {
    url: buildRegionUrl(acfg, attraction.region),
  });
}

// ---------------------------------------------------------------------------
// Conservation (UCSC phastCons).
// ---------------------------------------------------------------------------
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

function buildConservationAttraction(acfg, region, summary) {
  const label = acfg.ucscConsLabel;
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
    url: buildUcscRegionUrl(acfg, region),
    region: { contig: region.contig, start: region.start, end: region.end },
  };
}

async function fetchUcscConservationProbe(acfg, region, probe, signal) {
  const endpoint = new URL("/getData/track", UCSC_API);
  endpoint.searchParams.set("genome", acfg.ucscGenome);
  endpoint.searchParams.set("track", acfg.ucscConsTrack);
  endpoint.searchParams.set("chrom", ucscChromName(region.contig));
  endpoint.searchParams.set("start", String(probe.start - 1));
  endpoint.searchParams.set("end", String(probe.end));
  const res = await fetch(endpoint, { headers: { Accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`ucsc ${res.status} for ${endpoint.pathname}`);
  const data = await res.json();
  return data[acfg.ucscConsTrack] || [];
}

async function fetchConservationForWindow(acfg, region, signal) {
  const probes = conservationProbesFor(region);
  const chunks = await Promise.all(
    probes.map((probe) => fetchUcscConservationProbe(acfg, region, probe, signal))
  );
  const summary = summarizeConservationValues(chunks.flat());
  return isConservationHotspot(summary) ? summary : null;
}

// ---------------------------------------------------------------------------
// Assembly of one window's attraction list.
// ---------------------------------------------------------------------------
function buildAttractions(acfg, region, genes, regulatory, ccreItems, genePhenotypes, variantPhenotypes, conservation) {
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
  const regulatoryCounts = ccreCounts.size ? ccreCounts : classifyEnsemblRegulatory(regulatory);
  if (regulatoryCounts.size) {
    const source = ccreCounts.size ? "ENCODE SCREEN cCRE" : "Ensembl regulation";
    out.push(...buildRegulatoryAttractions(acfg, region, regulatoryCounts, source));
  }

  if (conservation) {
    out.push(buildConservationAttraction(acfg, region, conservation));
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
    .map((item) => decorateAttraction(acfg, item));
}

async function fetchJson(acfg, pathname, query, signal) {
  const endpoint = new URL(pathname, acfg.serverBase);
  for (const [key, value] of query) endpoint.searchParams.append(key, value);
  endpoint.searchParams.append("content-type", "application/json");
  const res = await fetch(endpoint, { headers: { Accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`ensembl ${res.status} for ${endpoint.pathname}`);
  return res.json();
}

async function fetchCcreForWindow(acfg, region, signal) {
  if (acfg.assembly !== "GRCH38") return [];
  const endpoint = new URL("/getData/track", UCSC_API);
  endpoint.searchParams.set("genome", acfg.ucscGenome);
  endpoint.searchParams.set("track", "encodeCcreCombined");
  endpoint.searchParams.set("chrom", ucscChromName(region.contig));
  endpoint.searchParams.set("start", String(region.start - 1));
  endpoint.searchParams.set("end", String(region.end));
  const res = await fetch(endpoint, { headers: { Accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`ucsc ccre ${res.status} for ${region.key}`);
  const data = await res.json();
  if (data.error) return [];
  return data.encodeCcreCombined || [];
}

export async function fetchAttractionsForWindow(acfg, region) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), acfg.fetchTimeoutMs);
  try {
    const overlapSpecies = acfg.species === "homo_sapiens" ? "human" : acfg.species;
    const queryRegion = `${region.seqRegion}:${region.start}-${region.end}`;
    const conservationPromise = fetchConservationForWindow(acfg, region, ac.signal).catch(() => null);
    const ccrePromise = fetchCcreForWindow(acfg, region, ac.signal).catch(() => []);
    const [overlap, genePhenotypes, variantPhenotypes, conservation, ccreItems] = await Promise.all([
      fetchJson(acfg, `/overlap/region/${overlapSpecies}/${queryRegion}`, [["feature", "gene"], ["feature", "regulatory"]], ac.signal),
      fetchJson(acfg, `/phenotype/region/${acfg.species}/${queryRegion}`, [["feature_type", "Gene"]], ac.signal),
      fetchJson(acfg, `/phenotype/region/${acfg.species}/${queryRegion}`, [["feature_type", "Variation"]], ac.signal),
      conservationPromise,
      ccrePromise,
    ]);
    const genes = overlap.filter((item) => item.feature_type === "gene");
    const regulatory = overlap.filter((item) => item.feature_type === "regulatory");
    return buildAttractions(acfg, region, genes, regulatory, ccreItems, genePhenotypes, variantPhenotypes, conservation);
  } finally {
    clearTimeout(timer);
  }
}

// The Node server rotated a cursor and broadcast on a jittered timer. Here the
// slot is derived from the clock instead, so it needs no state and every client
// independently lands on the same attraction at the same moment.
export function currentAttraction(acfg, list, nowMs) {
  if (!list || !list.length) return null;
  const slot = Math.floor(nowMs / acfg.slotMs);
  const emittedAt = slot * acfg.slotMs;
  return Object.assign({}, list[slot % list.length], {
    emittedAt,
    durationMs: acfg.slotMs,
    expiresAt: emittedAt + acfg.slotMs,
  });
}
