// workers/worker_public/src/profile.gen.ts
var PROFILE = {
  "publisher": {
    "id": "fixture",
    "name": "Fixture",
    "full_name": "The Fixture Publisher",
    "product_name": "Fixture Answers",
    "description": "A minimal publisher profile exercising every declared surface: an open dataset, a permission-gated dataset, production and lane corpora, prompt vars and retrieval vocabulary.",
    "domains": {
      "public": "fixture.example.org"
    },
    "identity": {
      "issuer": "https://id.fixture.example.org"
    },
    "codec": "plain-slug"
  },
  "datasets": [
    {
      "id": "pub",
      "label": "Fixture Publications",
      "description": "The fixture publisher's corpus",
      "note": "Some passages come from the fixture corpus \u2014 cite them the same way as every other passage."
    },
    {
      "id": "internal",
      "label": "Internal corpus",
      "description": "An access-restricted corpus proving the permission gate",
      "session": true,
      "permission": "preview"
    }
  ],
  "corpora": {
    "production": [
      "pub",
      "dirty",
      "clean",
      "synthetic",
      "model"
    ],
    "lanes": {
      "exp_a": [
        "exp_a"
      ],
      "exp_b": [
        "exp_b"
      ],
      "glossary": [
        "glossary"
      ]
    }
  },
  "sources": {
    "corpora": {
      "clean": {
        "repo": "fixtures/corpus",
        "note": "the engine's fixture corpus"
      }
    },
    "bibliography": {},
    "terminology": {},
    "models": {}
  },
  "ui": {
    "suggestions": [
      "What is in the fixture corpus?",
      "Which documents does the fixture publisher issue?"
    ],
    "models_disclosure": [
      {
        "role": "Answers",
        "model": "fixture-answer-model"
      }
    ],
    "smoke": [
      {
        "label": "sanity",
        "query": "What is in the fixture corpus?",
        "expect": "fixture"
      }
    ]
  },
  "retrieval": {
    "process_expansion": " fixture certification system framework application evaluation"
  },
  "prompts": {
    "vars": {
      "assistant_identity": "the fixture assistant \u2014 a public service answering questions about the fixture publisher's documents",
      "refusal_sentence": "I don't have information on this in the indexed fixture documents."
    }
  }
};

// workers/worker_public/src/profile.ts
var current = PROFILE;
function P() {
  return current;
}

// workers/worker_public/src/refusal.ts
function refusalAnswer() {
  return P().prompts.vars.refusal_sentence;
}
var REFUSAL_VARIANT = /^\s*I don[’']?t have information on .{1,120}? in the indexed OIML (?:publications|passages|documents|corpus)\.?/i;
var REFUSAL_DRIFT = [
  /\b(can'?t|cannot|couldn'?t|unable)\b[^.]{0,120}?\b(indexed )?OIML publications\b/i,
  /\bno real answer to give\b[^.]{0,120}?\bOIML\b/i,
  /\b(?:falls|well) outside\b[^.]{0,120}?\b(?:what I can answer|my scope|the scope of)\b/i,
  /\boutside (?:of )?what (?:I|this service) can answer\b/i,
  // "I can't answer that — weather forecasting is outside my scope":
  // requires the refusal verb, so a scope DISCUSSION inside a real answer
  // ("this exemption is outside the scope of R 60") never matches
  /\bI can[’']?t answer\b[^.]{0,100}?\bscope\b/i,
  /^\s*I don[’']?t have any indexed OIML \w+(?:s)? (?:covering|about|on)\b/im
];
function sentenceStart(answer, i) {
  let s = 0;
  for (const sep of [". ", "! ", "? ", "\n"]) {
    const j = answer.lastIndexOf(sep, i);
    if (j >= 0) s = Math.max(s, j + sep.length);
  }
  return s;
}
function sentenceEnd(answer, i) {
  const m = /[.!?\n]/.exec(answer.slice(i));
  return m ? i + m.index + 1 : answer.length;
}
function canonicalRefusal(answer) {
  const CANON = refusalAnswer();
  if (answer.includes(CANON)) return answer;
  const variant = answer.match(REFUSAL_VARIANT);
  if (variant) return answer.replace(variant[0], CANON);
  for (const drift of REFUSAL_DRIFT) {
    const m = drift.exec(answer);
    if (!m) continue;
    return answer.slice(0, sentenceStart(answer, m.index)) + CANON + answer.slice(sentenceEnd(answer, m.index));
  }
  return answer;
}
export {
  canonicalRefusal,
  refusalAnswer
};
