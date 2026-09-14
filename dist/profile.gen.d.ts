export declare const PROFILE: {
    readonly publisher: {
        readonly id: "fixture";
        readonly name: "Fixture";
        readonly full_name: "The Fixture Publisher";
        readonly product_name: "Fixture Answers";
        readonly description: "A minimal publisher profile exercising every declared surface: an open dataset, a permission-gated dataset, production and lane corpora, prompt vars and retrieval vocabulary.";
        readonly domains: {
            readonly public: "fixture.example.org";
            readonly origin_suffix: "fixture.example.org";
        };
        readonly identity: {
            readonly issuer: "https://id.fixture.example.org";
        };
        readonly codec: "plain-slug";
        readonly session_cookie: "fixture-session";
        readonly references: {
            readonly label_prefix: "";
        };
        readonly features: {
            readonly drafts: false;
            readonly model_plane: false;
        };
    };
    readonly datasets: readonly [{
        readonly id: "pub";
        readonly label: "Fixture Publications";
        readonly description: "The fixture publisher's corpus";
        readonly corpora: readonly ["pub", "dirty", "clean", "synthetic"];
        readonly note: "Some passages come from the fixture corpus — cite them the same way as every other passage.";
    }, {
        readonly id: "internal";
        readonly label: "Internal corpus";
        readonly description: "An access-restricted corpus proving the permission gate";
        readonly session: true;
        readonly permission: "preview";
        readonly corpora: readonly ["internal"];
    }];
    readonly corpora: {
        readonly production: readonly ["pub", "dirty", "clean", "synthetic", "model"];
        readonly lanes: {
            readonly exp_a: readonly ["exp_a"];
            readonly exp_b: readonly ["exp_b"];
            readonly glossary: readonly ["glossary"];
        };
    };
    readonly sources: {
        readonly corpora: {
            readonly clean: {
                readonly repo: "fixtures/corpus";
                readonly note: "the engine's fixture corpus";
            };
        };
        readonly bibliography: {};
        readonly terminology: {};
        readonly models: {};
    };
    readonly ui: {
        readonly suggestions: readonly ["What is in the fixture corpus?", "Which documents does the fixture publisher issue?"];
        readonly models_disclosure: readonly [{
            readonly role: "Answers";
            readonly model: "fixture-answer-model";
        }];
        readonly smoke: readonly [{
            readonly label: "sanity";
            readonly query: "What is in the fixture corpus?";
            readonly expect: "fixture";
        }];
    };
    readonly retrieval: {
        readonly process_expansion: " fixture certification system framework application evaluation";
        readonly process_note: "Retrieval note: these passages come from the fixture certification system documents because they govern application procedures for fixture publications.";
    };
    readonly prompts: {
        readonly vars: {
            readonly assistant_identity: "the fixture assistant — a public service answering questions about the fixture publisher's documents";
            readonly refusal_sentence: "I don't have information on this in the indexed fixture documents.";
            readonly account_note_source: "the user's own fixture account";
            readonly corpus_kind: "a fixture corpus publication";
            readonly corpus_kind_plural: "fixture corpus publications";
            readonly cite_example: "FIXTURE 1:2024 §2.1";
            readonly cite_quote_example: "FIXTURE 1:2024 §2.1: \"the limit shall not exceed one interval\"";
            readonly parts_example: "FIXTURE 1-1, FIXTURE 1-A";
            readonly docid_example: "FIXTURE 1-2";
            readonly spelling_examples: "\"f1\", \"FIXTURE 1\"";
            readonly process_vocab: "the fixture certification system framework";
        };
    };
};
