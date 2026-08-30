# dna

a genome, unfurling itself exactly once. base by base.

live at <https://dna.maurice-frank.com>.

at human scale:

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

node only, zero dependencies.

```bash
cp server/config.example.json server/config.json   # edit pacing
node server/server.js
# or via env:
DNA_ARTIFACTS_DIR=./artifacts DNA_START_EPOCH=2026-07-01T00:00:00Z \
DNA_RUNTIME_SECONDS=31536000 node server/server.js
```

Open <http://localhost:8080>.

`touristic attractions` are enabled by default and are fetched only on the
backend from Ensembl region endpoints, then broadcast as summary messages over
the existing SSE stream. They are window-cached server-side and the attraction
worker quiets down after `attractionDeadAirMs` of having no connected listeners.

If your reference assembly is not GRCh38, set it explicitly in `config.json`
or via env:

```bash
DNA_ATTRACTION_ASSEMBLY=GRCh37
DNA_ATTRACTION_DEAD_AIR_MS=30000
DNA_ATTRACTION_WINDOW_BASES=200000
node server/server.js
```

## deploy

one small vps, sized for the artifact disk (~5 gb consensus-only, ~60-80 gb with
pile-up), running the server under `systemd` for the whole project, behind caddy
for automatic https and sse-friendly proxying.

```bash
# on the VPS, once:
sudo mkdir -p /opt/dna
sudo cp infra/dna.service /etc/systemd/system/
sudo cp infra/dna.env.example /opt/dna/dna.env   # edit pacing
caddy run --config infra/Caddyfile   # serves dna.maurice-frank.com; or run as a service

# from your machine:
infra/deploy.sh user@vps-host artifacts
```

the server is stateless: a restart (or reboot) resumes at the correct `f(now)`
index automatically.
