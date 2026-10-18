# Cloudbite v0.0.1 — expert sandbox workspace

## Current contract

The user is reusing gw-shinick for Daytona HackSprint. Replace the classroom-centered primary experience with a common project worked on by expert personas inside separate Daytona sandboxes. Reference Shinick-Han/pro-bably for role registry, domain routing, work-order structure and provenance. Workers run in StackBite using Claude Code, claude-opus-5-5, medium effort. Do not substitute providers.

## First vertical slice

- A project brief and selected expert roles become explicit per-expert work orders.
- Each expert has an isolated workspace containing its persona, shared brief, role-specific objective, output contract and activity/artifact files.
- Daytona executes the workspace; Nosana provides model inference through a configured server-side endpoint. Provider credentials stay out of browser responses, prompts, artifacts and source.
- A project console shows expert identity, actual execution state, activity, artifacts and aggregate findings. Failed, pending, cancelled and simulated work must be distinguishable from completed live work.
- Start with a bounded small real team (3–5 selected roles); keep a 100-role catalogue/expansion path without pretending 100 live sandboxes were provisioned.
- A local demonstration must run without production secrets, explicitly labeled as a demo.

## Reuse and invariants

Reuse relevant authentication, credential-broker and Daytona lifecycle behavior. Keep existing legacy lab routes working while introducing Cloudbite. Do not grant new broad privileges to persona text or user input. Preserve cancellation, resource cleanup and per-workspace isolation. Never expose Daytona management credentials or Nosana API credentials to a browser or model input.

The existing repository has no .codegraph index. Do not create one.

## Boundaries

Local edits, dependencies, focused tests, isolated worktrees and local commits are authorized. Workers do not push, deploy, change production secrets/DNS/routes, create paid live resources, or touch the source gw-shinick deployment. The coordinator owns integration and acceptance.

## Product decisions still to refine

The initial example is launching a 100-expert AI advisory product. Advisor outputs should include recommendation, rationale/evidence, assumptions, uncertainty/confidence, disagreements and next actions. Confidence is self-assessed, not calibrated accuracy. Experts can produce files and use explicit tools; this is an execution workspace, with advice as one supported outcome.
