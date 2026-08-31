# dna

a genome, unfurling itself exactly once. base by base.

live at <https://dna.maurice-frank.com>.

at human scale:

* 30 b/s → ~3.3 years  (what it is actually running at, from 2026-06-09)
* ~101 b/s → ~1 year
* ~1235 b/s → ~30 days

## build

requires `samtools` (>= 1.16 for `samtools consensus`) and `python3`.

```bash
scaffold/build.sh \
  --cram sample.cram \
  --ref  reference.fa \
  --out  artifacts \
  --start-epoch 2026-07-01T00:00:00Z \
  --runtime 31536000          # ~1 year; or use --rate 101 (bases/sec)

# add the optional pileup (large on disk):
scaffold/build.sh ... --pileup --max-depth 64
```

inputs: cram, `.crai` (else auto-created), and the reference fasta
(else auto-created). the reference is mandatory; a cram cannot be decoded
without it.

## run

the runtime is a cloudflare worker over an r2 bucket. no server, no state.

```bash
npx wrangler dev --remote      # runs against the real bucket
npx wrangler deploy
node worker/gate.test.mjs      # asserts nothing past f(now) is reachable
```

the page talks to three endpoints:

| endpoint | what it gives |
| --- | --- |
| `/meta` | `n`, `rate`, `startEpoch`, contigs. cacheable, no sequence in it |
| `/head?from=` | the slice revealed since `from`, ending exactly at `f(now)` |
| `/pileup?pos=` | one pile-up column, refused if `pos` is past `f(now)` |

everything else is served straight from `web/` as a static asset.

`touristic attractions` are fetched on the worker from ensembl and ucsc, keyed
to the 200 kb window around the playhead and memoised in the edge cache, so a
window costs one round of upstream calls per hour no matter how many people are
watching. with nobody watching there are no requests and so no fetches at all.
which attraction is showing is derived from the clock rather than pushed, so
every viewer sees the same one at the same moment without the worker holding
any state.

pacing lives in `wrangler.toml` (`START_EPOCH`, `RATE`). changing either moves
the playhead, so treat them as fixed once the piece is running.

## the gate

the genome is revealed exactly once, in step with wall-clock time, and nothing
ahead of the playhead is retrievable — that is the whole point of the piece and
it is enforced in one place.

the r2 bucket is **private**: no public access, no `r2.dev` domain. the only
path from those objects to a response body is `readBases()` in
`worker/src/index.js`, and every caller clamps its end to `currentIndex()`
first. an endpoint that reads the consensus goes through that function or it
does not read the consensus. `worker/gate.test.mjs` pins the behaviour.

## deploy

pushes to `main` deploy via `.github/workflows/deploy.yml`, which needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in repo secrets.

the artifacts are uploaded once, by hand — wrangler caps a single object at
315 mb, so the 3.1 gb consensus needs a multipart client against the s3 endpoint:

```bash
wrangler r2 bucket create dna-artifacts
rclone copy artifacts/consensus.bin r2:dna-artifacts/   # or aws s3 cp
wrangler r2 object put dna-artifacts/meta.json --file artifacts/meta.json
```

the bucket must stay private. do not enable the `r2.dev` public url.
