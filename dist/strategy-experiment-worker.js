const { solveRestrictedHorizon } = self.DecoderSolver;

self.onmessage = ({ data }) => {
  if (data.type !== 'start') return;
  const { cards, weights, actions, state, groups } = data;
  for (let position = 0; position < groups.length; position += 1) {
    const group = groups[position];
    postMessage({ type: 'group-start', position, group });
    const startedAt = performance.now();
    try {
      const result = solveRestrictedHorizon({
        cards, weights, actions,
        hints: state.hints, challenges: state.challenges, candidates: state.candidates,
        knownMask: state.knownMask, matchedMask: state.matchedMask, guessed: state.guessed,
        remainingPuzzles: state.remainingPuzzles, resourceModel: state.resourceModel,
        depth: group.depth, maxStates: group.budget,
      });
      postMessage({ type: 'group-result', position, group, elapsed: (performance.now() - startedAt) / 1000,
        result: { action: result.action, value: result.value, expandedStates: result.expandedStates,
          rootActionValues: (result.rootActionValues || []).filter((entry) => entry.action?.type === 'challenge') } });
    } catch (error) {
      postMessage({ type: 'group-error', position, group, elapsed: (performance.now() - startedAt) / 1000,
        limitReached: String(error.message).startsWith('HORIZON_STATE_LIMIT:'), message: String(error.message) });
    }
  }
  postMessage({ type: 'complete' });
};
