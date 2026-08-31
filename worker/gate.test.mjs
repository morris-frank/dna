import worker from "./src/index.js";

const N = 1000;
const GENOME_BYTES = Buffer.from(Array.from({length: N}, (_, i) => "ACGT"[i % 4]).join(""), "latin1");
const meta = { n: N, contigs: [{ name: "chr1", start: 0, length: N }], pileup: false, pacing: {} };

const env = {
  // index = 500 right now
  START_EPOCH: String(Date.now() / 1000 - 500), RATE: "1",
  ATTRACTIONS: "false", TAIL: "4096", PILEUP: "true",
  GENOME: {
    async get(key, opts) {
      if (key === "meta.json") return { json: async () => meta };
      if (key === "pileup.idx") { const b = Buffer.alloc(16); b.writeBigUInt64LE(0n,0); b.writeBigUInt64LE(4n,8); return { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset+16) }; }
      const src = GENOME_BYTES;
      const { offset, length } = opts.range;
      const slice = src.subarray(offset, offset + length);
      return { arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length) };
    },
  },
  ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
};
const ctx = { waitUntil() {} };
const call = (p) => worker.fetch(new Request("https://x" + p), env, ctx);

let fail = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS" : "FAIL") + "  " + name + (extra ? "  " + extra : "")); if (!ok) fail++; };

const idx = (await (await call("/head")).json()).index;
check("index tracks the clock", idx >= 499 && idx <= 501, `index=${idx}`);

for (const q of ["", "?from=0", "?from=900", "?from=999999", "?from=-5", "?from=abc", "?from=499"]) {
  const h = await (await call("/head" + q)).json();
  const end = h.from + h.bases.length;
  check(`/head${q || " (no from)"} stops at the playhead`, end <= h.index && h.from >= 0 && h.from <= h.index,
        `from=${h.from} +${h.bases.length} => ${end} <= ${h.index}`);
}

const span = await (await call("/head?from=0")).json();
check("HEAD_MAX_SPAN caps one response", span.bases.length <= 65536, `got ${span.bases.length}`);

const future = await call("/pileup?pos=900");
check("/pileup refuses the future", future.status === 403, `status=${future.status}`);
const past = await call("/pileup?pos=100");
check("/pileup allows the revealed past", past.status === 200, `status=${past.status}`);
const bad = await call("/pileup?pos=" + (N + 5));
check("/pileup rejects out-of-range", bad.status === 400, `status=${bad.status}`);
check("unknown path falls through to assets", (await call("/whatever")).status === 200);
check("POST is rejected", (await worker.fetch(new Request("https://x/head", {method:"POST"}), env, ctx)).status === 405);

// The bases returned must be exactly the real slice - no drift in the latin1 path.
const h2 = await (await call("/head?from=100")).json();
check("bytes match source exactly", h2.bases === GENOME_BYTES.subarray(h2.from, h2.index).toString("latin1"));

console.log(fail ? `\n${fail} FAILED` : "\nall gate checks passed");
process.exit(fail ? 1 : 0);
