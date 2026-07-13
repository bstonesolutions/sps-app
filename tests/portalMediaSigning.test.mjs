import test from "node:test";
import assert from "node:assert/strict";

import { signPortalMedia } from "../api/_portal-auth.js";

test("portal media signing batches and replaces only allowlisted client-media references", async () => {
  const priorFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      async json() {
        return [
          { path: "media/client photo.jpg", signedURL: "/object/sign/client-media/media/client%20photo.jpg?token=short" },
        ];
      },
    };
  };

  try {
    const source = {
      client: {
        sitePhotos: [
          "sps-storage://client-media/media/client%20photo.jpg",
          { src: "https://ysqarusrewceezckawlo.supabase.co/storage/v1/object/public/client-media/media/client%20photo.jpg" },
        ],
        history: [{
          clientFeedback: "sps-storage://client-media/media/not-this-clients-file.jpg",
          photos: [],
        }],
        external: "https://example.com/customer-map.png",
        otherBucket: "sps-storage://other-bucket/media/nope.jpg",
      },
    };
    const signed = await signPortalMedia(source);

    const expected = "https://ysqarusrewceezckawlo.supabase.co/storage/v1/object/sign/client-media/media/client%20photo.jpg?token=short";
    assert.equal(signed.client.sitePhotos[0], expected);
    assert.equal(signed.client.sitePhotos[1].src, expected);
    assert.equal(signed.client.history[0].clientFeedback, source.client.history[0].clientFeedback);
    assert.equal(signed.client.external, source.client.external);
    assert.equal(signed.client.otherBucket, source.client.otherBucket);
    assert.notEqual(signed, source);

    assert.match(request.url, /\/storage\/v1\/object\/sign\/client-media$/);
    assert.deepEqual(JSON.parse(request.options.body), {
      expiresIn: 3600,
      paths: ["media/client photo.jpg"],
    });
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("portal media signing fails closed when the signing service rejects the request", async () => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, async json() { return {}; } });
  try {
    await assert.rejects(
      signPortalMedia({ client: { documents: [{ src: "sps-storage://client-media/media/private.jpg" }] } }),
      /portal_media_sign_failed/
    );
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("portal media signing reports partial object failures instead of silently returning private refs", async () => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return [{ path: "media/available.jpg", signedURL: "/object/sign/client-media/media/available.jpg?token=ok" }];
    },
  });
  try {
    await assert.rejects(
      signPortalMedia({
        client: { sitePhotos: [
          "sps-storage://client-media/media/available.jpg",
          "sps-storage://client-media/media/missing.jpg",
        ] },
      }),
      (error) => {
        assert.equal(error.message, "portal_media_sign_incomplete");
        assert.equal(error.unavailableCount, 1);
        assert.match(error.partialValue.client.sitePhotos[0], /token=ok/);
        assert.equal(error.partialValue.client.sitePhotos[1], "sps-storage://client-media/media/missing.jpg");
        return true;
      }
    );
  } finally {
    globalThis.fetch = priorFetch;
  }
});
