import { test } from "node:test";
import assert from "node:assert/strict";
import { readProfile, readInbox } from "../src/scan.js";
import { messagesFrom } from "../src/instagram.js";

test("reads posts, reels and latest story from new style page data", () => {
  const bodies = [
    {
      data: {
        user: { pk: "42", username: "Maya", latest_reel_media: 1790000000 },
        xdt_api__v1__feed__user_timeline_graphql_connection: {
          edges: [
            { node: { code: "AAA", taken_at: 1789000000, user: { username: "maya" } } },
            { node: { code: "BBB", taken_at: 1789500000, product_type: "clips", user: { username: "maya" } } },
          ],
        },
      },
    },
    // Someone else's post on the page (for example a suggestion) is ignored.
    { node: { code: "ZZZ", taken_at: 1789900000, user: { username: "sam" } } },
  ];
  const p = readProfile(bodies, "maya");
  assert.equal(p.id, "42");
  assert.deepEqual(p.posts, [
    { id: "BBB", ts: 1789500000000, url: "https://www.instagram.com/reel/BBB/" },
    { id: "AAA", ts: 1789000000000, url: "https://www.instagram.com/p/AAA/" },
  ]);
  assert.deepEqual(p.stories, [
    { id: "story:1790000000", ts: 1790000000000, url: "https://www.instagram.com/stories/maya/" },
  ]);
});

test("reads old style shortcode data and no story means none", () => {
  const p = readProfile(
    [{ graphql: { user: { id: "7", username: "maya", edge_owner_to_timeline_media: { edges: [{ node: { shortcode: "CCC", taken_at_timestamp: 1788000000 } }] } } } }],
    "maya",
  );
  assert.equal(p.id, "7");
  assert.deepEqual(p.posts.map((x) => x.id), ["CCC"]);
  assert.deepEqual(p.stories, []);
});

test("nothing recognisable gives empty results", () => {
  assert.deepEqual(readProfile([{ foo: 1 }, null, "x"], "maya"), { id: null, posts: [], postCount: 0, stories: [] });
});

test("posts Rayan already liked are skipped", () => {
  const p = readProfile(
    [{ edges: [{ node: { code: "L1", taken_at: 1789000000, has_liked: true } }, { node: { code: "N1", taken_at: 1789000001, has_liked: false } }] }],
    "maya",
  );
  assert.deepEqual(p.posts.map((x) => x.id), ["N1"]);
  assert.equal(p.postCount, 2);
});

test("reads the conversation list from inbox page data", () => {
  const T = 1790000000000;
  const thread = (key, users, msgs, extra = {}) => ({
    as_ig_direct_thread: {
      thread_key: key,
      is_group: users.length > 1,
      users: users.map((username) => ({ username })),
      viewer: { interop_messaging_user_fbid: "111" },
      slide_messages: { edges: msgs.map(([id, sender, ts]) => ({ node: { id, sender_fbid: sender, timestamp_ms: String(ts) } })) },
      ...extra,
    },
  });
  const bodies = [
    { data: { mailbox: { threads_by_folder: { edges: [
      { node: thread("t1", ["Maya"], [["m3", "222", T + 3000], ["m2", "111", T + 2000], ["m1", "222", T + 1000]]) },
      { node: thread("g1", ["maya", "sam"], [["x1", "222", T + 9000]]) },
    ] } } } },
    // A fuller copy of the same thread from a detail response wins.
    { data: { thread: thread("t1", ["Maya"], [["m4", "222", T + 4000], ["m3", "222", T + 3000], ["m2", "111", T + 2000], ["m1", "222", T + 1000]]) } },
  ];
  const box = readInbox(bodies);
  assert.equal(box.viewer.pk, "111");
  assert.equal(box.inbox.threads.length, 2);
  // Only what she sent after my last reply, from the one to one chat, not the group.
  assert.deepEqual(messagesFrom(box, "maya"), [
    { id: "dm:m4", ts: T + 4000, url: "https://www.instagram.com/direct/t/t1/" },
    { id: "dm:m3", ts: T + 3000, url: "https://www.instagram.com/direct/t/t1/" },
  ]);
  assert.equal(readInbox([{ nothing: true }]), null);
});
