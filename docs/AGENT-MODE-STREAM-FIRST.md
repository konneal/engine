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

## WHAT LANDED (0.2.151, probes green)

One pipeline body, TWO DELIVERIES — but the delivery is chosen by the
CHANNEL PARAMETER, not the request's stream preference:
`pipeline(channel, qq)` where channel is the live SSE writer or null.
The dispatch: `if (liveResponse) { void pipeline(live, q); return
liveResponse; } return await pipeline(null, q);`.

Laws the build adds to the serving doctrine:

1. **THE CHANNEL DECIDES THE LANE.** Inside the pipeline, every lane
   branch keys off `live` (the channel) — never off `wantsStream` (the
   request preference). The two are coupled by the hoist/dispatch, but
   the channel is the authority: a preference-guarded branch is reachable
   with a null channel (the first probe build 500'd every json ask in
   exactly that else).
2. **THE HOIST PRECEDES EVERY STEP.** The SSE opens before the vision
   step, the understanding, the register bridge — each mark() streams at
   the moment it runs (the owner's step order), never replayed from a
   buffer. The agentSteps buffer survives only for the json lane's
   single response.
3. **ONE READER, ONE LOOKUP (the photo flow).** The nameplate bridge
   (vision → extract → certificates.search) is the reader on a cert-photo
   turn; the agent loop stands down there (`!nameplate?.manufacturer`).
   The loop's image-bearing probe remains the reader on every OTHER
   image turn. The user watches: Reading the nameplate photograph →
   Nameplate read: … → certificates.search — … → the answer.
4. **THE CFA BUDGET.** A ~1400-line closure drops TypeScript's flow
   narrowing mid-function (values see `string | null` inside their own
   guards). The 24 carried sites are guard-backed `!` assertions — the
   guards are the runtime proof; a reduced repro for the narrowing loss
   is a follow-up.

Probes (local --remote dev against production bindings): JSON MPE ask
(7-10 citations, table block), streamed Chomsky refusal (pinned
sentence, no follow_up chips), streamed knowledge (read → citations →
tokens → quota → done), text cert question (the loop streams), the
photo flow in the owner's order.
