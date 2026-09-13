// GENERATED from profile/*.yaml — regenerate: node scripts/gen_profile.mjs
// (never edit; the drift test compares this file to the sources)
export const PROFILE = {
  "publisher": {
    "id": "oiml",
    "name": "OIML",
    "full_name": "International Organization of Legal Metrology",
    "product_name": "OIML SMART AI",
    "description": "Retrieval-augmented answering over OIML publications: Recommendations, Documents, Basic publications, Guides and Expert reports.",
    "domains": {
      "public": "ai.oimlsmart.org"
    },
    "identity": {
      "issuer": "https://id.oimlsmart.org"
    }
  },
  "datasets": [
    {
      "id": "oiml",
      "label": "OIML Publications",
      "description": "Recommendations, Documents, Basic publications, Guides"
    },
    {
      "id": "smart-model",
      "label": "OIML SMART Models",
      "description": "The machine-readable Recommendation models (requirements' constraints, applicability rules, acceptance criteria, tests, terms) — derived from the Primmel packages",
      "note": "Some passages are the OIML SMART model plane (labeled OIML SMART model) — the platform's machine-readable Recommendation models derived from the Primmel packages. Treat their machine limits, applicability rules and acceptance criteria as the model's own statement of them (quote machine limits verbatim); where a model passage and a prose passage disagree, say so explicitly and cite both."
    },
    {
      "id": "iso",
      "label": "ISO/IEC Conformity Assessment",
      "description": "ISO/IEC 17xxx standards — federated with OIML results for members",
      "session": true,
      "permission": "ai-preview",
      "note": "Some passages come from the internal ISO/IEC corpus (labeled ISO/IEC …) — use them alongside the OIML passages and cite them the same way."
    }
  ],
  "corpora": {
    "production": [
      "oiml",
      "dirty",
      "clean",
      "synthetic",
      "smart-model"
    ],
    "lanes": {
      "exp_plain": [
        "exp_plain"
      ],
      "exp_adoc": [
        "exp_adoc"
      ],
      "exp_mko": [
        "exp_mko"
      ],
      "primmel": [
        "primmel"
      ],
      "primmel_flat": [
        "primmel"
      ],
      "exp_composed": [
        "exp_composed"
      ],
      "glossary": [
        "glossary"
      ]
    }
  },
  "sources": {
    "corpora": {
      "clean": {
        "repo": "~/src/mn/mn-samples-oiml",
        "note": "hand-curated Metanorma documents (29 sources) — precedence over dirty"
      },
      "dirty": {
        "repo": "~/src/oimlsmart/publications-private",
        "note": "OCR-derived Metanorma trees (880 sources)"
      }
    },
    "bibliography": {
      "relaton": {
        "repo": "~/src/relaton/relaton-data-oiml",
        "note": 5,
        "707 records": null
      }
    },
    "terminology": {
      "glossarist": {
        "repo": "~/src/oimlsmart/vocab",
        "note": "13 datasets; oiml-complete = 6",
        "031 concepts": null
      }
    },
    "models": {
      "primmel": {
        "repo": "~/src/oimlsmart/primmel-packages",
        "note": "the Recommendation models' SSOT"
      },
      "retrieval_plane": {
        "repo": "~/src/oimlsmart/smart",
        "note": "the projection export (SMART_REPO)"
      }
    }
  },
  "ui": {
    "suggestions": [
      "What is R 60?",
      "What is a load cell?",
      "What is the OIML-CS?",
      "Qu'est-ce que le OIML-CS ?"
    ],
    "models_disclosure": [
      {
        "role": "Answers (all tiers)",
        "model": "GLM-5.3 Flash",
        "note": "natively multimodal"
      },
      {
        "role": "Query understanding",
        "model": "Qwen3-30B-A3B"
      },
      {
        "role": "Understanding",
        "judging": null,
        "verification": null,
        "model": "DeepSeek-V4-Flash"
      },
      {
        "role": "Embeddings",
        "model": "Qwen3-Embedding-0.6B"
      },
      {
        "role": "Reranking",
        "model": "bge-reranker-base"
      }
    ],
    "smoke": [
      {
        "label": "R 60 mentions load cells",
        "query": "What is R 60?",
        "expect": "load cell"
      },
      {
        "label": "load cell definition",
        "query": "What is a load cell?",
        "expect": "transducer|measuring"
      },
      {
        "label": "refusal works",
        "query": "How do I make lasagna?",
        "expect": "don't have information"
      }
    ]
  },
  "retrieval": {
    "process_expansion": " OIML Certification System OIML-CS OIML B 18 CASCO ISO/IEC 17000 conformity assessment issuing authority application type evaluation certificate"
  }
} as const;
