# The agent-mode stream-first architecture (the designed next build)

## The demand (owner directive, 2026-10-15): SOTA agent bots 2026 —
users see EVERY call as it runs. The current shape: the ask handler
computes the ENTIRE pipeline (understanding → retrieval → register →
nameplate vision → the agent loop) BEFORE the SSE response opens —
the user waits minutes in silence, then receives the buffered steps +
the answer tokens.

## The target shape
1. The SSE opens at the top of the streamed branch (right after the
   cache check): the controller is captured; `live.send(ev)` works from
   that moment.
2. The pipeline runs ONCE, inside the streamed branch, emitting live:
   - mark() sends `{type:"agent", step}` immediately (no agentSteps
     buffer + flush).
   - The vision/question-understanding/certificate-lookup steps each
     send their start (and result) events — the owner's step order.
   - The short-circuits (register count/latest, verdict) send their
     events (citations/tokens/blocks/done) through the same channel.
   - The generation streams tokens as today (the 0.2.148 head-buffer +
     narration restart ride along).
3. The JSON lane becomes a CLIENT of the same stream: run the stream,
   aggregate {answer, citations, blocks, quota, context} from the
   events, return json. ONE pipeline body, two delivery modes — no
   duplication. (The done event gains the contextOut fields — additive.)

## The mechanical plan
- The block (understanding → the generation, ~610-1905 in ask.ts)
  moves into the streamed branch inside start().
- The exits convert: the 3 err()s → the graceful token + done; the
  json returns inside the streamed branch → the aggregator return;
  sseResponse(...) → live.send per event + close.
- The json lane below the branch → the aggregator (~40 lines).
- The event-shape additions are additive (context in done; the error
  token convention).

## The safe path
1. The engine PR: merge safely (no deploy).
2. Publish → the ai scratch worktree pins 0.2.15x → `npm run dev:public`
   (the LOCAL worker, remote bindings) → the probes: the streamed
   Chomsky refusal, the photo flow's step order, a JSON MPE ask, the
   long question.
3. Only after the probes: the ai pin bump PR → auto-deploy → the
   production probes.
