# Falsify research experts

## Project evidence and scope

The user's invited repository is [Pseudo-Lab/Falsify](https://github.com/Pseudo-Lab/Falsify). Authenticated GitHub API access confirmed collaborator push permission on 2026-10-19 KST. The main README was read at commit `4c949487c64c1665d9b4c1603a18814f6dccbb75`. It proposes a Pseudo Lab Season 13 Red/Blue benchmark over 10–20 PMC Open Access biomedical papers: D1 text/table numeric inconsistency; D2 fabricated references; D3 claims unsupported by the reported evidence. Labels are correct, incorrect and needs review. The README proposes CC BY/CC0 source selection; each paper's actual rights must still be checked. Main contained README/assets at inspection, so its planned corpus and gates are not presented as implemented.

The existing `feat/workbench-html-guide-20261012` branch at `1f9e624bbfdd5d5b8d33bc074fef561157962b97` has a Workbench. Its own `tools/workbench/README.md` describes a static browser-local RED/BLUE application with independent human review and user-selected local CLI/harness execution. This extension does not modify that repository or connect Cloudbite to a Falsify backend. Existing personal Falsify preview/workbench/PDF/self-play repositories were also found; the invited upstream establishes the research scope.

Cloudbite's new roles advise on research project design and supplied evidence. Their normal direction/confidence fields remain project-advice judgments, not Falsify's correct/incorrect/needs-review truth labels or clinical outcomes. Missing papers, source excerpts, tables, registered protocols or independent judgments are evidence gaps, not proof of a defect. Reporting completeness is distinct from scientific validity.

## Added roles

All released 100 role IDs, ordering and definitions are preserved. New IDs are `cb-role-101` through `cb-role-120`.

| No. | Role | Main contribution to Falsify |
|---|---|---|
| 101 | Biomedical Research Methodologist | Hypothesis, controls, experimental units and reproducibility; D3 study-design boundaries. |
| 102 | Clinical Evidence Reviewer | Population/intervention/comparator/outcome and clinical applicability; evidence versus clinical claims. |
| 103 | Clinical Trial Methodologist | Registered endpoints, allocation, masking, missingness and changes to analysis plans. |
| 104 | Epidemiologist | Confounding, selection, temporal order and observational causal claims. |
| 105 | Biomedical Biostatistician | D1 denominators, effect sizes, intervals, multiplicity and consistency of reported results. |
| 106 | Systematic Review & Meta-analysis Specialist | Search/selection bias, evidence synthesis and heterogeneity; no invented pooled results. |
| 107 | Pharmacology & Pharmacokinetics Scientist | Exposure–response and mechanism claims; species, exposure and endpoint comparability. |
| 108 | Medicinal Chemist | Structure–activity evidence, assay artefacts and unsupported potency/selectivity claims. |
| 109 | Analytical Chemist | Measurement traceability, calibration, detection limits, units and method validation. |
| 110 | Chemical Identity & Structure Reviewer | Identifier/structure/stereochemistry consistency and chemical naming evidence. |
| 111 | Molecular & Cell Biologist | Model identity, biological replication, controls and limits of mechanism attribution. |
| 112 | Biochemist | Enzyme/interaction/assay interpretation and orthogonal support for mechanism claims. |
| 113 | Genomics & Bioinformatics Reviewer | Sample provenance, batch effects, leakage and reproducible sequence/omics analysis. |
| 114 | Preclinical & Translational Scientist | Model suitability, preclinical study quality and limits of human translation. |
| 115 | Toxicology Evidence Reviewer | Exposure, adverse-endpoint evidence and uncertainty in safety conclusions. |
| 116 | Scientific Image Integrity Reviewer | Image provenance, controls, transformations and preservation of originals; anomalies need adjudication. |
| 117 | Biomedical Citation & Retraction Reviewer | D2 reference identity, corrections/retractions and support for the cited claim. |
| 118 | Research Integrity & Benchmark Curator | Separate planted and adjudicated truth, leakage control, provenance and independent review. |
| 119 | Immunology Research Reviewer | Cell/population/assay specificity, immune mechanism claims and scope of model evidence. |
| 120 | Chemical Biology Scientist | Probe specificity, target engagement, orthogonal assays and mechanism alternatives. |

New category labels cover clinical medicine, biomedical research, pharmaceutical science and chemistry in KO/EN. The catalogue and routing candidate bound is 200; this release contains 120. Project selection and concurrency policies remain capped at 100. All registered roles, including numbers above 100, participate in Jev assessment and primary-owner selection. No existing role is replaced to make room.

## Knowledge and verification boundaries

Each role has eight authored knowledge cards (160 new cards in total), its own questions, methods, limitations and two collectable report/data artifacts. The packs reference 81 distinct source URLs; authoring notes specify whether a full text, abstract or landing page was read. Packs remain **unvalidated T0 starter knowledge**. They are not a large licensed medical corpus, measured specialist competence, patient-care support or validated defect detectors. Source metadata marked retrieved reflects an authoring-time fetch and identity check; runtime retrieval is local to that role's pack and does not query PubMed, Crossref, trial registries or retraction services. A tool call must actually run before a role can claim an external check happened.

Knowledge references contain no Falsify mutated papers, answer keys or held-out evaluation answers. The 60 evaluation cases are authored expectations stored under test fixtures; passing structural tests does not score model performance on those cases. Every research role has the no-peer-verification guard because Cloudbite currently provides no other expert's output to its independent sandbox.

Falsify's clean/mutant separation, original DOI, machine-readable mutation marker, disclosed diff, independent author/reviewer and separate truth records are requirements to assess, not features implemented by adding these personas. A later Falsify integration would require explicit document access and result contracts, human adjudication and scored held-out evaluation.

## Example project brief (KO)

**Title:** Falsify의 D3 판정 범위와 검토 절차 결정

**Objective:** 생의학 오픈액세스 논문 10–20편으로 숫자 불일치·허위 인용·근거와 결론의 어긋남을 검증하는 12주 프로젝트를 진행합니다. D3에서 임상시험과 전임상 논문을 함께 다룰지, 한 연구 유형부터 시작할지 결정해 주세요. 필요한 사실 카드, 판정 근거, 확인필요로 남길 조건, 작성자와 독립 검수자의 역할, 잘못된 결함 라벨을 막는 절차를 비교하고 첫 파일럿의 진행·중단 기준을 제안해 주세요.

**Context:** 현재 원문·수치표·등록 프로토콜·정답 라벨은 제공하지 않습니다. 특정 논문의 오류를 발견했다고 주장하지 말고, 제공된 사실과 가정을 구분해 프로젝트 설계를 조언해 주세요. 정상판과 변조판은 분리하고, 변조판을 사실 근거로 쓰지 않습니다. 통계·임상·생의학·인용 및 연구 무결성 중 실제로 필요한 관점을 선정해 주세요. 검토 규칙과 과학적 사실의 진위를 혼동하지 마세요.

Paste the objective and context into Cloudbite with Jev selection enabled. The selected team is an observed model judgment, not a guaranteed fixed set of all 20 roles.

## Verification

`node test/cloudbite-research.mjs` checks the original 100 definition hashes, new role wiring, pack isolation and byte hashes, source metadata, runtime workspace bounds, deliverables and no-peer guards. It loads all 20 workspaces with the actual Python runner and tests local knowledge retrieval/artifact collection. Provider-model answer quality is a separate evaluation and is not implied by these checks.

Coordinator acceptance passed 1069 research checks, including all 20 actual Python workspace loads and 40 collectable artifacts, and confirmed all first-100 runtime definitions and pool entries are unchanged. Live Jev smoke evaluated all 120 roles (134 first-stage questions) for synthetic Falsify, chemical-biology and EDA briefs. Falsify selected new clinical/epidemiology/preclinical/methodology/integrity roles; chemistry selected medicinal/analytical/chemical-biology/biochemistry/identity roles. These are routing smoke observations, not a scored benchmark or proof that every selected role is optimal.

Production release: runtime commit `662b3b3b2665614f208eb269b07e8959b5ccf105`, Worker `cloudbite-v001` version `3ee46cda-4b07-41ba-81ef-07999c82d8d3`, at https://cloudbite.shinick.dev/cloudbite. `npm run check`, all 14 Cloudbite test suites and the intended-config Wrangler dry run passed. Production bootstrap returned 120 experts and 120 runnable pool entries. Two new roles ran in independent real Daytona sandboxes through the existing Nosana model: Clinical Evidence Reviewer completed conditional (55%) on turn one; Chemical Biology Scientist completed abstain (35%) on turn three after an unretrieved citation was rejected, followed by local knowledge search and resubmission. This exercised normal-turn citation recovery, not last-turn repair. No actual paper or patient data were used; their scientific accuracy was not scored. Both sandbox GETs returned 404 from the owning accounts after cleanup and all three accounts had zero remaining project-labelled sandboxes. KO/EN rendering and the dynamic 120-role footer were checked in Aside. The synthetic QA history record was deleted after recording this evidence; user history was untouched.

During implementation, the biomedical Claude Opus 5.5 worker wrote its draft but was paused by its provider's biology safeguard before completing checks/fixtures. No model switch was made. The coordinator stopped that task, retained the draft and fetch evidence, fixed a duplicate source alias and overly broad D1/D2 wording, authored the remaining 30 harmless document-review fixtures and performed acceptance checks. That worker has no successful completion receipt or independent PASS. The clinical and catalogue workers completed with native receipts. A failed reference lookup is now explicitly not proof of fabrication; real-but-unsupported citations are evidence-support concerns rather than automatically D2. Core D1 remains the declared same-quantity text/table contradiction; other issue types require an explicitly adopted extension.
