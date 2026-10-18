# Cloudbite

<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
The confirmed first audience is the Daytona HackSprint pitch audience. The example project selected by the user is launching a 100-person AI advisory room. A broader customer segment remains undecided.

## Product Purpose
Give one common project to several expert personas, let them work inside separate Daytona sandboxes, and collect their advice, evidence, artifacts, and self-reported confidence to support the user's decision.

## Operating Context
Reuse gw-shinick, reference pro-bably's expert catalogue, use Daytona for isolated execution and Nosana for inference. The 100-role pool now maps all planning entries to runnable roles, preserving the first 25 released IDs and their order. Ninety-five general roles have source-linked starter knowledge (570 cards); the separate PrimeTime STA pilot keeps its existing curated pack, and four original roles remain metadata-derived. All roles are unvalidated. Projects still select up to five experts; 100 simultaneous experts is not a verified runtime capacity. See `docs/cloudbite/pool-expansion.md` for scope and evaluation limits.

The default flow is question → explicit Run → server-side TypeSafe Jev routing across all100 roles → up to five expert sandboxes. The API key stays server-side. Selection suitability is separate from expert answer confidence. Routing failures are explicit, with no silent keyword fallback. Manual selection remains an advanced option, and the catalogue stays folded for browsing. Existing owner/visitor authorization is required. The285 generic-role held-out cases have not been scored by models or domain reviewers. Review roles receive no peer results; actual follow-up cross-review remains future work. See `docs/cloudbite/jev-routing.md` and `docs/cloudbite/expert-pool-100.md`.

## Capabilities and Constraints
New server runs have 30-day browser-scoped history with real questions, expert answers, feedback and deletion. The owner can review all records and see deterministic improvement signals, separated from browser/server simulations. The report counts failure categories, reference formatting, confidence patterns and feedback; it does not prove answer accuracy, run extra model evaluations, train models or automatically change prompts. Visitors retain read-only history access after their execution grant expires; cookie removal loses access. See docs/cloudbite/history.txt.

The user requests an HTML preview of the finished pitch experience while implementation continues. The preview must be explicitly simulated and separate from the real console. Its data does not prove provider performance, customer demand, accuracy, or business outcomes. Confidence means a model's self-assessment, not measured accuracy or independent expert agreement.

## Brand Commitments
Cloudbite v0.0.1. The user subsequently requested English and confirmed a blue-and-white layout adapted from the AI Coding Lab specification: navy header, approximately224px navigation sidebar, central expert workspace and right-hand progress/decision panel, with1536×1024 as primary viewport. Preserve the expert-sandbox product, rather than copying classroom terminology or claiming unsupported CLI features.

The later 2026-10-18 request adds KO / EN on the console, visitor request, owner inbox and QR surfaces. Switching language preserves inputs and live work. The owner signs in with a security key registered on Cloudbite's own domain; the Cloudbite-only session persists until explicit logout or credential/browser-data removal. First-key enrollment requires the owner's private setup credential. Legacy studyroom/admin session limits remain unchanged.

## Evidence on Hand
Local source, persona catalogue, workspace contract, and mocked-provider implementation checks. No verified paid-provider end-to-end execution or calibrated reliability evidence yet.
