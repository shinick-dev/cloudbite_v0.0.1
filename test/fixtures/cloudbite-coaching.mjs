// Synthetic provider reply fixture only; not observed model advice or a human quality rating.
export function coachingFixture(expertId) {
  const claim = (text) => ({ text, expertIds: expertId ? [expertId] : [], refs: ['brief:objective'] });
  return {
    version: 'cloudbite-coaching/v1', stance: 'proceed-with-scope',
    viablePath: claim('Proposed: try a limited decision-support pilot before committing to a wider rollout.'),
    repairs: [{ issue: claim('Willingness to use this workflow is not yet evidenced.'), kind: 'unknown', priority: 'now',
      change: claim('Proposed: narrow the pilot to one existing team decision and a short decision brief.'),
      check: claim('Ask a prospective user to compare the brief with their current decision process.'),
      decisionTrigger: claim('Reconsider the workflow if the user cannot identify a useful change to their decision.') }],
    revisedProject: { objective: claim('Proposed: help a small team prepare one important project decision.'),
      scope: claim('Proposed: one brief with alternatives, material risks and a validation plan.'),
      nextMilestone: claim('Proposed: review one concrete decision brief with a prospective user.') },
    questions: [claim('Which upcoming team decision should the first pilot address?')],
  };
}
