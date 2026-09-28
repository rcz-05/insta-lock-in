import { test } from "node:test";
import assert from "node:assert/strict";
import { readProfile } from "../src/scan.js";

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
