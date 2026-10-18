// Deterministic TypeSafe wire fixtures. These test orchestration, not Jev judgment quality.
export function jevFixtureResponse(request, { relevance = {}, needs = {}, coverage = {}, overlap = 0, defaultRelevance = 0.05 } = {}) {
  const answers = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === 'noul') {
      const value = id.startsWith('fit:') ? (relevance[id.slice(4)] ?? defaultRelevance)
        : id.startsWith('need:') ? (needs[id.slice(5)] ?? 0.05) : overlap;
      answers[id] = { type: 'noul', noul: value };
    } else if (question.type === 'choice') {
      const options = Object.keys(question.criteria);
      const target = coverage[id.replace(/^cover:/, '')];
      // Option names belong to the request, not to arbitrary generated role IDs.
      const option = options.includes(target) ? target : options.find(key => {
        const value = question.criteria[key];
        return target && JSON.stringify(value).includes(target);
      }) ?? options.find(key => /none/i.test(key)) ?? options[0];
      answers[id] = { type: 'choice', choice: option, confidence: 1,
        probabilities: Object.fromEntries(options.map(key => [key, key === option ? 1 : 0])) };
    } else throw new Error('Unexpected fixture primitive');
  }
  return { model: request.model, answers };
}
