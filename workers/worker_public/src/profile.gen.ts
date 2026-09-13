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
  }
} as const;
