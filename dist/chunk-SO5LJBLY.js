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
function setProfile(profile) {
  current = profile;
}
function P() {
  return current;
}

export {
  setProfile,
  P
};
