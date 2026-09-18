// GENERATED from profile/*.yaml — regenerate: node scripts/gen_profile.mjs
// (never edit; the drift test compares this file to the sources)
export const PROFILE = {
  "publisher": {
    "id": "fixture",
    "name": "Fixture",
    "full_name": "The Fixture Publisher",
    "product_name": "Fixture Answers",
    "description": "A minimal publisher profile exercising every declared surface: an open dataset, a permission-gated dataset, production and lane corpora, prompt vars and retrieval vocabulary.",
    "domains": {
      "public": "fixture.example.org",
      "origin_suffix": "fixture.example.org"
    },
    "identity": {
      "issuer": "https://id.fixture.example.org"
    },
    "codec": "plain-slug",
    "session_cookie": "fixture-session",
    "references": {
      "label_prefix": ""
    },
    "features": {
      "drafts": false,
      "model_plane": false
    }
  },
  "datasets": [
    {
      "id": "pub",
      "label": "Fixture Publications",
      "description": "The fixture publisher's corpus",
      "corpora": [
        "pub",
        "dirty",
        "clean",
        "synthetic"
      ],
      "note": "Some passages come from the fixture corpus — cite them the same way as every other passage."
    },
    {
      "id": "internal",
      "label": "Internal corpus",
      "description": "An access-restricted corpus proving the permission gate",
      "session": true,
      "permission": "preview",
      "corpora": [
        "internal"
      ]
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
    "process_expansion": " fixture certification system framework application evaluation",
    "process_note": "Retrieval note: these passages come from the fixture certification system documents because they govern application procedures for fixture publications."
  },
  "prompts": {
    "vars": {
      "publisher_identity": "the Fixture Organization — a worldwide organization that publishes the fixture corpus",
      "assistant_identity": "the fixture assistant — a public service answering questions about the fixture publisher's documents",
      "refusal_sentence": "I don't have information on this in the indexed fixture documents.",
      "account_note_source": "the user's own fixture account",
      "corpus_kind": "a fixture corpus publication",
      "corpus_kind_plural": "fixture corpus publications",
      "cite_example": "FIXTURE 1:2024 §2.1",
      "cite_quote_example": "FIXTURE 1:2024 §2.1: \"the limit shall not exceed one interval\"",
      "parts_example": "FIXTURE 1-1, FIXTURE 1-A",
      "docid_example": "FIXTURE 1-2",
      "spelling_examples": "\"f1\", \"FIXTURE 1\"",
      "process_vocab": "the fixture certification system framework"
    }
  }
} as const;
