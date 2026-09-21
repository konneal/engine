var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// workers/worker_public/src/profile.gen.ts
var PROFILE = {
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
      "note": "Some passages come from the fixture corpus \u2014 cite them the same way as every other passage."
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
    "models": {},
    "licensed": [
      {
        "key": "std:fixture-60068-2-30",
        "package": "fixture-60068-2-30",
        "doc_number": "60068-2-30",
        "title": "FIXTURE environmental testing \u2014 damp heat, cyclic",
        "edition": "2005"
      }
    ]
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
      "publisher_identity": "the Fixture Organization \u2014 a worldwide organization that publishes the fixture corpus",
      "assistant_identity": "the fixture assistant \u2014 a public service answering questions about the fixture publisher's documents",
      "refusal_sentence": "I don't have information on this in the indexed fixture documents.",
      "account_note_source": "the user's own fixture account",
      "corpus_kind": "a fixture corpus publication",
      "corpus_kind_plural": "fixture corpus publications",
      "cite_example": "FIXTURE 1:2024 \xA72.1",
      "cite_quote_example": 'FIXTURE 1:2024 \xA72.1: "the limit shall not exceed one interval"',
      "parts_example": "FIXTURE 1-1, FIXTURE 1-A",
      "docid_example": "FIXTURE 1-2",
      "spelling_examples": '"f1", "FIXTURE 1"',
      "process_vocab": "the fixture certification system framework",
      "license_declare_pointer": "org admin \u2192 Settings \u2192 Standards licenses",
      "license_posture": `Some indexed publications are LICENSED. When a license boundary note names the question's publication, obey it: answer at the citation level only \u2014 the standard's title and edition, and the invoking clause the public passages carry \u2014 never state, paraphrase or "summarize from memory" any procedure of the licensed text, and point at the declare flow the note names. Public content (the Recommendations' own models, applicability and references) stays fully answerable.`
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
  __commonJS,
  __toESM,
  setProfile,
  P
};
