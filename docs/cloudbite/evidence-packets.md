# Evidence packets, peer selection and observation signals

Pure helpers for the cross-review pass and the evidence UI. No network, no storage, no extra model calls.
Integration (project DO, API, client, contract) is owned by the coordinator; this page lists the hooks.

## Evidence packet (`src/cloudbite-evidence-packet.ts`)

`buildEvidencePacket({ brief, expertId, opinion, audit, pack? }, budget?)` builds one role's bounded packet.
`audit` is the collected `out/knowledge.json` content (`artifact:<run>:out/knowledge.json`) or `undefined`.
`pack` defaults to `applicationPack(expertId)` (phase-one/extension pack, or the STA pack) — never caller data.

Binding of the audit to the application pack:

| binding | meaning | card text exposed |
|---|---|---|
| `bound` | role, version, cards/sources sha256 match; every retrieved card is in the pack; retrieval source IDs equal the cards' resolved sources | yes, from the pack |
| `legacy-unbound` | audit has no pack hashes | no; only IDs present in the current pack |
| `stale` | version or hash differs from the application pack | no |
| `foreign` | pack or audit belongs to another role | no |
| `invalid` | not JSON, over 64 KiB, malformed, over bounds, or internally inconsistent | no |
| `absent` | role has a pack but no audit was collected | no |
| `no-pack` | role has no curated pack | no |

Card text and source records always come from the application pack, never from the audit. A source record
(title, URL, license) is metadata, not page text; `originalText: 'not-fetched'` and
`originalSourceTextFetched: false` are fixed, and an audit claiming `sourcePagesFetched: true` is ignored with a note.

Each cited reference gets a deterministic `availability`: `supplied-project-text`, `missing-project-text`,
`curated-card-text`, `curated-card-text-omitted`, `retrieval-unverified`, `not-retrieved` (catalogue presence only)
or `unknown-id`. This is availability, not support: the reply schema stays supported/challenged/insufficient.

Bounds (`EVIDENCE_PACKET_LIMITS`): 12 KiB per role, 32 KiB total via `buildEvidencePackets` including its serialized
array and packet envelopes, 1500-byte card summaries, UTF-8 truncation on code points. Whole packets may be omitted
when their fixed headers do not fit; `buildEvidenceSignals.packetCoverage` names the omitted experts. Order actual
review targets first when constructing review context. Included packets count cuts in `omitted`; missing packets
never imply no retrieval occurred. A zero/tiny budget returns an empty array (its two JSON brackets are fixed overhead).
Packets are deeply frozen and carry `bytes` and `sha256` of their canonical JSON.

## Cross-review (`src/cloudbite-cross-review.ts`)

- `reviewMessages(reviewer, peers, brief, definition?, packets?)` — with packets, the user data gains `peerEvidence`
  (peer packets only, never the reviewer's own) and the system prompt adds the availability rules. Without packets the
  messages are unchanged.
- `reviewSnapshot(brief, completed, packets?)` — adds `{expertId, sha256}` per packet; unchanged without packets.
- `peerSelection` / `peersFor(reviewer, completed, { catalogue?, brief?, packets? })` — deterministic, at most 3 peers:
  disagreement, evidence gaps and new domain coverage first, ties in completed order. Without options and with equal
  opinions it reduces to the previous first-three order.
- `reviewPlan(completed, catalogue, { brief?, packets? })` — reviewers, assignments with reasons, coverage
  (`assignedOpinions` of `completedOpinions`, `unassigned`) and a `disclosure` sentence stating the selective limits.
- `findingTextAvailability(report, completed, brief, packets?)` — per finding `textBasis`
  (`available` / `partial` / `unavailable` / `uncited`); it never changes a verdict.

## Observation signals (`src/cloudbite-evidence.ts`)

`buildEvidenceSignals(brief, experts, { packets?, crossReview? })` returns counts beside the expert's own
`selfAssessedConfidence`: references by kind, supplied text available/missing, knowledge availability, unknown
references, observed retrieval (binding, cards, sources), assumptions, cross-review supported/challenged/insufficient
and reviewed evidence items, and project review coverage. They are observations, never a calibrated probability,
accuracy score or confidence dispersion. `evidenceClaims` keeps its legacy meaning.

## Integration hooks for the coordinator

1. In `CloudbiteProject.crossReview`, read each completed expert's `artifact:<run>:out/knowledge.json`, call
   `buildEvidencePackets(completed.map(c => ({ brief, expertId: c.expertId, opinion: c.opinion, audit })))`.
2. Pass the packets to `reviewSnapshot`, `peersFor(r, completed, { catalogue, brief, packets })` and `reviewMessages(..., packets)`.
3. Optionally store `reviewPlan(...)` coverage/disclosure and `findingTextAvailability(...)` beside the review, and
   expose `buildEvidenceSignals(...)` in the project view; contract fields are the coordinator's decision.
4. Add `node test/cloudbite-evidence-packet.mjs` to `test:cloudbite` in `package.json`.
