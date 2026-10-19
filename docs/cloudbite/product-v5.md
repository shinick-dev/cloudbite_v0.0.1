# Cloudbite: connected review and human regression feedback

This increment connects source-support readings to the decision memo and author-response round, expands the optional
cross-review to key conclusions and assumptions, and lets the project's user record a rubric review of a saved answer.
Original opinions, confidence values and completed reviews remain unchanged. No additional automatic model pass is added.

## Using the review workflow

1. Finish a live project with at least two completed expert opinions, then explicitly request cross-review.
2. Read the ordinary evidence verdict and its source-support assessment separately. A supported verdict may still have
   partial or insufficient source support; that conflict must remain visible.
3. The same reviewer pass can name an exact quotation from a peer's summary, assumption or next action. It can flag an
   unsupported premise, causal overreach or a missing assumption. Not every claim is reviewed: selection and text bounds
   are disclosed. An exact quotation proves which text was targeted, not that the reviewer's conclusion is true.
4. Request a new author-response round for affected authors, or request the optional decision memo. A follow-up is a new
   project with its own normal budget. Nothing automatically re-runs or changes the parent answer.

The memo receives source assessments and core-claim findings as untrusted model readings. Agreement, exact quotation
matching and a model's self-assessed confidence are not calibrated accuracy or independent confirmation.

## Recording a person's evaluation

Open **History / 사용 기록**, open a finished live record, and expand the human review section beneath a completed answer.
Each rubric dimension starts unscored. Record the scores you can assess, issue categories and a comment; optionally flag
the answer as a regression candidate. Save, then reload the record to see the server's saved revision and time.

The review is bound to the exact question, stage, supplied material, expert opinion and saved report. It is a sidecar,
not an edit of the answer. Only the project's own history user may write it; an owner viewing another user's project
does not become that user. A stale answer hash or concurrent revision returns a conflict. Deletion and retention apply
to the review as well. Helpful/unhelpful feedback remains a separate feature.

## Exporting a regression candidate

After saving, download the regression-candidate JSON from the same answer. It contains that answer, its input and the
person's annotation, with content hashes. It excludes history credentials, the internal actor identity, sandbox logs and
other experts' answers. The history evaluation is explicitly **not blinded**.

The offline importer rechecks the included hashes and writes cases, saved-answer exports, exact-file-bound rating rows
and a manifest for the existing batch evaluator. It does not call a model, browse sources, train a model or declare a
winner. Unscored dimensions stay `NOT_SCORED`; a regression candidate collected after seeing an answer is not a held-out
benchmark. Use the importer instructions in `human-review.md` for the command and provenance options.

## Related contracts

- `core-claims.md`: targeting checks and selective coverage bounds.
- `source-review-flow.md`: source assessments, conflicts and author-response planning.
- `human-review.md`: storage, UI, exports and offline import.
- `quality-evaluation.md` and `quality-pilot.md`: the existing evaluator and observed execution evidence.

## 한국어

새 검토는 기존 답변을 덮어쓰지 않습니다. 출처 근거가 부족한 ‘지지’ 판정과 요약·가정·다음 행동의 지적을
종합 판단 및 새 작성자 응답 라운드에 전달합니다. 사람 평가는 사용 기록의 답변별 접힌 영역에서 저장하며,
직접 입력하지 않은 점수는 미채점 상태로 남습니다. 내려받은 회귀 후보는 원문과 평가를 함께 묶은 자료이며,
정확도 인증이나 자동 합격 판정이 아닙니다.
