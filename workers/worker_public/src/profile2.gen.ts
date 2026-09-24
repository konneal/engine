// GENERATED from profile2/*.yaml — regenerate: node scripts/gen_profile.mjs
// (never edit; the drift test compares this file to the sources)
export const PROFILE = {
  "publisher": {
    "id": "atlas",
    "name": "Atlas",
    "full_name": "The Atlas Standards Institute",
    "product_name": "Atlas Answers",
    "description": "The second fixture publisher of the reference matrix: a technical-standards institute issuing specifications and errata, with a working-group corpus behind a session permission.",
    "domains": {
      "public": "answers.atlas.example",
      "origin_suffix": "atlas.example"
    },
    "identity": {
      "issuer": "https://identity.atlas.example"
    },
    "codec": "plain-slug",
    "session_cookie": "atlas-session",
    "references": {
      "label_prefix": "ATLAS"
    },
    "production": [
      "spec",
      "errata",
      "model"
    ],
    "lanes": {
      "review": [
        "review"
      ],
      "glossary": [
        "glossary"
      ]
    },
    "catalog_url_template": "https://catalog.atlas.example/{type}",
    "catalog_corpora": [
      "spec"
    ],
    "features": {
      "drafts": false,
      "model_plane": false
    }
  },
  "datasets": [
    {
      "id": "spec",
      "label": "Atlas Specifications",
      "description": "The institute's published specifications and errata",
      "corpora": [
        "spec",
        "errata"
      ],
      "note": "Some passages come from the Atlas errata corpus — cite them the same way as every other passage."
    },
    {
      "id": "wg",
      "label": "Working-group corpus",
      "description": "An access-restricted corpus proving the permission gate",
      "session": true,
      "permission": "committee",
      "corpora": [
        "wg"
      ]
    }
  ],
  "corpora": {
    "production": [
      "spec",
      "errata",
      "model"
    ],
    "lanes": {
      "review": [
        "review"
      ],
      "glossary": [
        "glossary"
      ]
    },
    "corpora": {
      "spec": {
        "repo": "fixtures/matrix2",
        "note": "the second fixture corpus"
      }
    },
    "bibliography": {},
    "terminology": {},
    "models": {}
  },
  "sources": {
    "corpora": {},
    "bibliography": {},
    "terminology": {},
    "models": {}
  },
  "ui": {
    "suggestions": [
      "What does ATLAS 12 specify?",
      "Which errata are open?"
    ],
    "models_disclosure": [
      {
        "role": "Answers",
        "model": "atlas-answer-model"
      }
    ],
    "smoke": [
      {
        "label": "sanity",
        "query": "What does ATLAS 12 specify?",
        "expect": "ATLAS"
      }
    ]
  },
  "retrieval": {
    "process_expansion": " atlas review procedure errata committee specification",
    "process_note": "Retrieval note: these passages come from the Atlas review-procedure documents because they govern the institute's publication process."
  },
  "prompts": {
    "vars": {
      "assistant_identity": "the Atlas Answers assistant — a public service answering questions about the Atlas Standards Institute's specifications",
      "refusal_sentence": "I don't have information on this in the indexed Atlas specifications.",
      "account_note_source": "the user's own Atlas Answers account"
    }
  }
} as const;
