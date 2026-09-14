export declare const PROFILE: {
    readonly publisher: {
        readonly id: "atlas";
        readonly name: "Atlas";
        readonly full_name: "The Atlas Standards Institute";
        readonly product_name: "Atlas Answers";
        readonly description: "The second fixture publisher of the reference matrix: a technical-standards institute issuing specifications and errata, with a working-group corpus behind a session permission.";
        readonly domains: {
            readonly public: "answers.atlas.example";
            readonly origin_suffix: "atlas.example";
        };
        readonly identity: {
            readonly issuer: "https://identity.atlas.example";
        };
        readonly codec: "plain-slug";
        readonly session_cookie: "atlas-session";
        readonly references: {
            readonly label_prefix: "ATLAS";
        };
        readonly production: readonly ["spec", "errata", "model"];
        readonly lanes: {
            readonly review: readonly ["review"];
            readonly glossary: readonly ["glossary"];
        };
        readonly features: {
            readonly drafts: false;
            readonly model_plane: false;
        };
    };
    readonly datasets: readonly [{
        readonly id: "spec";
        readonly label: "Atlas Specifications";
        readonly description: "The institute's published specifications and errata";
        readonly corpora: readonly ["spec", "errata"];
        readonly note: "Some passages come from the Atlas errata corpus — cite them the same way as every other passage.";
    }, {
        readonly id: "wg";
        readonly label: "Working-group corpus";
        readonly description: "An access-restricted corpus proving the permission gate";
        readonly session: true;
        readonly permission: "committee";
        readonly corpora: readonly ["wg"];
    }];
    readonly corpora: {
        readonly production: readonly ["spec", "errata", "model"];
        readonly lanes: {
            readonly review: readonly ["review"];
            readonly glossary: readonly ["glossary"];
        };
        readonly corpora: {
            readonly spec: {
                readonly repo: "fixtures/matrix2";
                readonly note: "the second fixture corpus";
            };
        };
        readonly bibliography: {};
        readonly terminology: {};
        readonly models: {};
    };
    readonly sources: {
        readonly corpora: {};
        readonly bibliography: {};
        readonly terminology: {};
        readonly models: {};
    };
    readonly ui: {
        readonly suggestions: readonly ["What does ATLAS 12 specify?", "Which errata are open?"];
        readonly models_disclosure: readonly [{
            readonly role: "Answers";
            readonly model: "atlas-answer-model";
        }];
        readonly smoke: readonly [{
            readonly label: "sanity";
            readonly query: "What does ATLAS 12 specify?";
            readonly expect: "ATLAS";
        }];
    };
    readonly retrieval: {
        readonly process_expansion: " atlas review procedure errata committee specification";
        readonly process_note: "Retrieval note: these passages come from the Atlas review-procedure documents because they govern the institute's publication process.";
    };
    readonly prompts: {
        readonly vars: {
            readonly assistant_identity: "the Atlas Answers assistant — a public service answering questions about the Atlas Standards Institute's specifications";
            readonly refusal_sentence: "I don't have information on this in the indexed Atlas specifications.";
            readonly account_note_source: "the user's own Atlas Answers account";
        };
    };
};
