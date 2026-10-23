import { describe, expect, it, mock } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { SupabaseClient } from "@supabase/supabase-js";
import { Comment, CommentData } from "../src/adapters/supabase/helpers/comment";
import { Context } from "../src/types/context";
import { pluginSettingsSchema } from "../src/types/plugin-input";

const COMMENT_MARKDOWN = "A synthetic private comment with enough detail to be indexed and used for annotation.";
const EMBEDDING = [0.25, 0.5];

type Write = Record<string, unknown>;
type Selection = { data: Write[]; error: null };

function createHarness(settings: Record<string, unknown> = {}, hasExistingComment = false) {
  const writes: Write[] = [];
  const createEmbedding = mock(async () => EMBEDDING);
  const selection = {
    eq: () => selection,
    in: () => selection,
    is: () => selection,
    then: (resolve: (result: Selection) => unknown) =>
      Promise.resolve({ data: hasExistingComment ? [{ id: "comment-1" }] : [], error: null } as Selection).then(resolve),
  };
  const client = {
    from: () => ({
      select: () => selection,
      insert: async (values: Write[]) => {
        writes.push(...values);
        return { data: values, error: null };
      },
      update: (values: Write) => ({
        eq: () => ({
          in: async () => {
            writes.push(values);
            return { data: null, error: null };
          },
        }),
      }),
    }),
  } as unknown as SupabaseClient;
  const context = {
    config: Value.Decode(pluginSettingsSchema, Value.Default(pluginSettingsSchema, settings)),
    logger: {
      error: mock(() => {}),
      warn: mock(() => {}),
      debug: mock(() => {}),
      ok: mock(() => {}),
    },
    adapters: { voyage: { embedding: { createEmbedding } } },
  } as unknown as Context;

  return { comment: new Comment(client, context), writes, createEmbedding };
}

function createCommentData(isPrivate: boolean): CommentData {
  return {
    id: "comment-1",
    markdown: COMMENT_MARKDOWN,
    author_id: 1,
    issue_id: "issue-1",
    isPrivate,
    payload: {
      repository: { private: isPrivate },
      comment: { body: COMMENT_MARKDOWN, user: { type: "User" } },
    },
  };
}

describe("private comment redaction", () => {
  it("defaults the setting to false and rejects non-boolean values", () => {
    const defaults = Value.Decode(pluginSettingsSchema, Value.Default(pluginSettingsSchema, {})) as Record<string, unknown>;
    expect(defaults.redactPrivateRepoComments).toBe(false);
    expect(Value.Check(pluginSettingsSchema, { ...defaults, redactPrivateRepoComments: "true" })).toBe(false);
  });

  const cases = [
    { name: "omitted setting keeps private content", settings: {}, isPrivate: true, shouldRedact: false },
    { name: "false keeps private content", settings: { redactPrivateRepoComments: false }, isPrivate: true, shouldRedact: false },
    { name: "true redacts private content", settings: { redactPrivateRepoComments: true }, isPrivate: true, shouldRedact: true },
    { name: "true preserves public content", settings: { redactPrivateRepoComments: true }, isPrivate: false, shouldRedact: false },
  ];

  for (const operation of ["create", "update"] as const) {
    for (const scenario of cases) {
      it(`${operation}: ${scenario.name}`, async () => {
        const { comment, writes, createEmbedding } = createHarness(scenario.settings, operation === "update");
        const data = createCommentData(scenario.isPrivate);
        if (operation === "create") {
          await comment.createComment(data);
        } else {
          await comment.updateComment(data);
        }

        expect(writes).toHaveLength(1);
        expect(writes[0].markdown).toBe(scenario.shouldRedact ? null : COMMENT_MARKDOWN);
        expect(writes[0].payload).toEqual(scenario.shouldRedact ? null : data.payload);
        if (scenario.shouldRedact) {
          expect(writes[0].embedding).toBeNull();
          expect(createEmbedding).not.toHaveBeenCalled();
        } else {
          expect(JSON.parse(writes[0].embedding as string)).toEqual(EMBEDDING);
          expect(createEmbedding).toHaveBeenCalledWith(COMMENT_MARKDOWN);
        }
      });
    }
  }

  it("keeps captured private comments available to the deferred queue without immediate provider calls", async () => {
    const { comment, writes, createEmbedding } = createHarness();
    await comment.createComment(createCommentData(true), { deferEmbedding: true });

    expect(writes[0].markdown).toBe(COMMENT_MARKDOWN);
    expect(writes[0].payload).toEqual(createCommentData(true).payload);
    expect(writes[0].embedding).toBeNull();
    expect(createEmbedding).not.toHaveBeenCalled();
  });

  it("redacts private review comments even when embedding is deferred", async () => {
    const { comment, writes, createEmbedding } = createHarness({ redactPrivateRepoComments: true });
    await comment.createComment({ ...createCommentData(true), docType: "review_comment" }, { deferEmbedding: true });

    expect(writes[0]).toMatchObject({ doc_type: "review_comment", markdown: null, payload: null, embedding: null });
    expect(createEmbedding).not.toHaveBeenCalled();
  });

  it("uses the configured policy when an update creates a missing review document", async () => {
    const { comment, writes, createEmbedding } = createHarness({ redactPrivateRepoComments: true });
    await comment.updateComment({ ...createCommentData(true), docType: "pull_request_review" }, { deferEmbedding: true });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ doc_type: "pull_request_review", markdown: null, payload: null, embedding: null });
    expect(createEmbedding).not.toHaveBeenCalled();
  });

  it("preserves the command embedding filter when private content capture is enabled", async () => {
    const { comment, writes, createEmbedding } = createHarness();
    const data = { ...createCommentData(true), markdown: "/start", payload: { repository: { private: true }, comment: { body: "/start" } } };
    await comment.createComment(data);

    expect(writes[0].markdown).toBeNull();
    expect(writes[0].payload).toEqual(data.payload);
    expect(createEmbedding).not.toHaveBeenCalled();
  });
});
