import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMediaSessionSource } from "./load-media-session-source.mjs";

const { MediaSessionOwner } = await loadMediaSessionSource();

class FakeMedia extends EventTarget {
  constructor(isVideo, elements) {
    super();
    this.isVideo = isVideo;
    this.elements = elements;
    this.duration = 12;
    this.currentTime = 0;
    this.paused = true;
    this.ended = false;
    this.loop = false;
    this.removed = false;
    this._src = "";
    this.playCalls = 0;
  }
  set src(value) {
    this._src = value;
    queueMicrotask(() => {
      if (/broken/.test(value)) this.dispatchEvent(new Event("error"));
      else this.dispatchEvent(new Event("loadeddata"));
    });
  }
  get src() {
    return this._src;
  }
  play() {
    this.playCalls++;
    this.ended = false;
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  removeAttribute(name) {
    if (name === "src") this._src = "";
  }
  load() {}
  remove() {
    this.removed = true;
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(overrides = {}) {
  const elements = [],
    revoked = [],
    sources = [],
    lives = [],
    host = {
      appendChild(element) {
        element.parent = this;
      },
    };
  let objectCounter = 0,
    assetCounter = 0,
    contextClosed = false;
  const monitor = {
    gain: {
      value: 1,
      setValueAtTime(value) {
        this.value = value;
      },
      setTargetAtTime(value) {
        this.value = value;
      },
    },
    connect() {},
    disconnect() {
      this.disconnected = true;
    },
  };
  const context = {
    currentTime: 0,
    sampleRate: 48000,
    destination: {},
    createGain: () => monitor,
    resume: overrides.resume ?? (async () => {}),
    close: async () => {
      contextClosed = true;
    },
  };
  const dependencies = {
    getMediaHost: () => host,
    createMediaElement: (isVideo) => {
      const element = new FakeMedia(isVideo, elements);
      elements.push(element);
      return element;
    },
    createObjectURL: (blob) => `media:${blob.name}:${++objectCounter}`,
    revokeObjectURL: (url) => revoked.push(url),
    readImage: async (file, kind) => {
      const asset = { file, url: `asset:${kind}:${file.name}:${++assetCounter}`, image: { file } };
      if (file.name === "bad.png") throw new Error("Bad image data");
      if (overrides.readImage) return overrides.readImage(file, kind, asset);
      return asset;
    },
    prepareAudio: async (file) => {
      if (overrides.prepareAudio) return overrides.prepareAudio(file);
      return null;
    },
    createAudioContext: () => context,
    createMonitor: () => monitor,
    createSource: () => {
      const source = {
        connected: false,
        connect() {
          this.connected = true;
        },
        disconnect() {
          this.disconnected = true;
        },
      };
      sources.push(source);
      return source;
    },
    createLiveSound: () => {
      const live = {
        reset() {},
        dispose() {
          this.disposed = true;
        },
      };
      lives.push(live);
      return live;
    },
    isBlocked: () => overrides.isBlocked?.() ?? false,
  };
  return {
    owner: new MediaSessionOwner(dependencies),
    elements,
    revoked,
    sources,
    lives,
    context,
    monitor,
    get contextClosed() {
      return contextClosed;
    },
  };
}

const file = (name, type = "audio/wav") => new File(["fixture"], name, { type });

test("project commit exposes all replacement resources before releasing the old project", async () => {
  const f = fixture(),
    { owner } = f;
  assert.equal(owner.snapshot.file, null);
  assert.equal(owner.snapshot.logo, null);
  assert.equal(await owner.load(file("first.wav")), true);
  await owner.changeImage("logo", file("old-logo.png", "image/png"));
  await owner.changeImage("background", file("old-background.png", "image/png"));
  const oldMedia = owner.snapshot.media;
  const oldLogo = owner.snapshot.logo;
  const oldBackground = owner.snapshot.background;
  const seen = [];
  owner.subscribe((event) => {
    if (event.type === "commit")
      seen.push({
        snapshot: event.snapshot,
        oldMediaStillAttached: !oldMedia.removed,
        oldUrlsNotRevoked:
          !f.revoked.includes(oldLogo.url) && !f.revoked.includes(oldBackground.url),
      });
  });

  const next = file("next.mp4", "video/mp4");
  assert.equal(
    await owner.load(next, {
      range: [2, 8],
      projectAssets: {
        logo: file("new-logo.png", "image/png"),
        background: file("new-background.png", "image/png"),
      },
    }),
    true,
  );

  assert.equal(owner.requestGeneration, 2);
  assert.equal(owner.generation, 2);
  assert.equal(owner.snapshot.file, next);
  assert.equal(owner.snapshot.video, owner.snapshot.media);
  assert.equal(owner.snapshot.live !== null, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].snapshot.logo.file.name, "new-logo.png");
  assert.equal(seen[0].snapshot.background.file.name, "new-background.png");
  assert.equal(seen[0].oldMediaStillAttached, true);
  assert.equal(seen[0].oldUrlsNotRevoked, true);
  assert.equal(oldMedia.removed, true);
  assert.ok(f.revoked.includes(oldLogo.url));
  assert.ok(f.revoked.includes(oldBackground.url));
  assert.equal(seen[0].snapshot.generation, 2);
  owner.dispose();
});

test("media replacement and owner disposal free each prepared frame analyzer once", async () => {
  const audio = {
    sampleRate: 48000,
    numberOfChannels: 1,
    length: 48000,
    duration: 1,
    getChannelData: () => new Float32Array(48000),
  };
  const f = fixture({
    prepareAudio: async () => ({ audio, events: [], envelopes: [], overview: [] }),
  });
  assert.equal(await f.owner.load(file("with-pcm.wav")), true);
  const oldFeatures = f.owner.snapshot.features;
  let oldDisposals = 0;
  const oldDispose = oldFeatures.dispose.bind(oldFeatures);
  oldFeatures.dispose = () => {
    oldDisposals++;
    oldDispose();
  };

  assert.equal(await f.owner.load(file("replacement-with-pcm.wav")), true);
  assert.equal(oldDisposals, 1);
  assert.equal(oldFeatures.samples.length, 0);
  const currentFeatures = f.owner.snapshot.features;
  let currentDisposals = 0;
  const currentDispose = currentFeatures.dispose.bind(currentFeatures);
  currentFeatures.dispose = () => {
    currentDisposals++;
    currentDispose();
  };
  f.owner.dispose();
  f.owner.dispose();
  assert.equal(currentDisposals, 1);
  assert.equal(currentFeatures.samples.length, 0);
});

test("a newer load cancels a stale candidate and only successful commits advance snapshot generation", async () => {
  const slow = deferred(),
    f = fixture({
      prepareAudio: (current) =>
        current.name === "slow.wav" ? slow.promise : Promise.resolve(null),
    });
  const first = f.owner.load(file("slow.wav"));
  await Promise.resolve();
  const next = file("winner.wav");
  const second = f.owner.load(next);
  assert.equal(await first, false);
  assert.equal(await second, true);
  slow.resolve(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.owner.requestGeneration, 2);
  assert.equal(f.owner.generation, 1);
  assert.equal(f.owner.snapshot.file, next);
  assert.ok(f.revoked.includes("media:slow.wav:1"));
  assert.equal(f.sources.length, 1);
  f.owner.dispose();
});

test("failed project assets leave the current media and assets intact and reclaim successful siblings", async () => {
  const f = fixture(),
    { owner } = f;
  const old = file("old.wav");
  assert.equal(await owner.load(old), true);
  await owner.changeImage("logo", file("kept.png", "image/png"));
  const oldMedia = owner.snapshot.media,
    oldLogo = owner.snapshot.logo;
  const result = await owner.load(file("bad-replacement.wav"), {
    projectAssets: {
      logo: file("bad.png", "image/png"),
      background: file("candidate.png", "image/png"),
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result, false);
  assert.equal(owner.snapshot.file, old);
  assert.equal(owner.snapshot.media, oldMedia);
  assert.equal(owner.snapshot.logo, oldLogo);
  assert.equal(owner.generation, 1);
  assert.ok(!f.revoked.includes(oldLogo.url));
  assert.ok(f.revoked.some((url) => url.startsWith("asset:background:candidate.png:")));
  assert.ok(f.revoked.includes("media:bad-replacement.wav:2"));
  owner.dispose();
});

test("an image that finishes after export locks is rejected and its object URL is reclaimed", async () => {
  const pending = deferred();
  let blocked = false;
  const f = fixture({
    isBlocked: () => blocked,
    readImage: (current, _kind, asset) =>
      current.name === "pending.png" ? pending.promise.then(() => asset) : Promise.resolve(asset),
  });
  await f.owner.changeImage("logo", file("kept.png", "image/png"));
  const kept = f.owner.snapshot.logo;
  const change = f.owner.changeImage("logo", file("pending.png", "image/png"));
  blocked = true;
  pending.resolve();
  assert.equal(await change, false);
  assert.equal(f.owner.snapshot.logo, kept);
  assert.ok(f.revoked.some((url) => url.startsWith("asset:logo:pending.png:")));
  f.owner.dispose();
});

test("transport callbacks preserve native gain, loop, seeks, and segment preview boundaries", async () => {
  const f = fixture();
  assert.equal(await f.owner.load(file("transport.wav")), true);
  const events = [];
  f.owner.subscribe((event) => events.push(event));
  f.owner.setVolume(0.25);
  f.owner.setLoop(true);
  assert.equal(f.owner.snapshot.media.loop, true);
  assert.equal(f.monitor.gain.value, 0.25);
  assert.equal(await f.owner.play(), true);
  assert.equal(f.owner.snapshot.playing, true);
  f.owner.seek(3);
  assert.equal(f.owner.snapshot.media.currentTime, 3);
  assert.ok(
    events.some((event) => event.type === "seek" && event.source === "api" && event.time === 3),
  );
  assert.equal(await f.owner.previewRange([2, 4]), true);
  f.owner.snapshot.media.currentTime = 4;
  f.owner.pollPosition(true);
  assert.equal(f.owner.snapshot.playing, false);
  assert.ok(events.some((event) => event.type === "pause" && event.time === 4));
  assert.equal(f.owner.snapshot.media.loop, true);
  assert.equal(f.owner.snapshot.audioContext !== null, true);
  const media = f.owner.snapshot.media;
  media.ended = true;
  media.paused = false;
  media.dispatchEvent(new Event("ended"));
  assert.equal(f.owner.snapshot.playing, false);
  assert.equal(await f.owner.togglePlay(), true);
  assert.equal(f.owner.snapshot.playing, true);
  f.owner.dispose();
});

test("a pause invalidates a play waiting for AudioContext resume without a stale error", async () => {
  const resume = deferred(),
    f = fixture({ resume: () => resume.promise });
  assert.equal(await f.owner.load(file("pending-play.wav")), true);
  const errors = [];
  f.owner.subscribe((event) => {
    if (event.type === "error") errors.push(event);
  });
  const pending = f.owner.play();
  f.owner.pause();
  resume.reject(new Error("resume was interrupted"));
  assert.equal(await pending, false);
  assert.equal(f.elements[0].playCalls, 0);
  assert.deepEqual(errors, []);
  f.owner.dispose();
});

test("a pause invalidates a range preview waiting for AudioContext resume", async () => {
  const resume = deferred(),
    f = fixture({ resume: () => resume.promise });
  assert.equal(await f.owner.load(file("pending-preview.wav")), true);
  const errors = [];
  f.owner.subscribe((event) => {
    if (event.type === "error") errors.push(event);
  });
  const pending = f.owner.previewRange([2, 5]);
  f.owner.pause();
  resume.resolve();
  assert.equal(await pending, false);
  assert.equal(f.elements[0].playCalls, 0);
  assert.deepEqual(errors, []);
  f.owner.dispose();
});

test("export locking after resume begins rejects playback and togglePlay is blocked at entry", async () => {
  const resume = deferred();
  let blocked = false;
  const f = fixture({ resume: () => resume.promise, isBlocked: () => blocked });
  assert.equal(await f.owner.load(file("export-lock.wav")), true);
  blocked = true;
  assert.equal(await f.owner.togglePlay(), false);
  assert.equal(f.elements[0].playCalls, 0);
  blocked = false;
  const pending = f.owner.previewRange([1, 3]);
  blocked = true;
  resume.resolve();
  assert.equal(await pending, false);
  assert.equal(f.elements[0].playCalls, 0);
  blocked = false;
  assert.equal(await f.owner.play(), true);
  blocked = true;
  assert.equal(await f.owner.togglePlay(), false);
  assert.equal(f.owner.snapshot.playing, true);
  f.owner.pause();
  assert.equal(f.owner.snapshot.playing, false);
  f.owner.dispose();
});

test("a committed replacement invalidates play waiting to resume the old resource", async () => {
  const resume = deferred(),
    f = fixture({ resume: () => resume.promise });
  assert.equal(await f.owner.load(file("old-pending-play.wav")), true);
  const oldMedia = f.elements[0];
  const pending = f.owner.play();
  const replacement = file("replacement.wav");
  assert.equal(await f.owner.load(replacement), true);
  resume.resolve();
  assert.equal(await pending, false);
  assert.equal(oldMedia.playCalls, 0);
  assert.equal(f.owner.snapshot.file, replacement);
  assert.equal(f.owner.snapshot.media.playCalls, 0);
  f.owner.dispose();
});

test("dispose invalidates pending transport without reporting an obsolete resume error", async () => {
  const resume = deferred(),
    f = fixture({ resume: () => resume.promise });
  assert.equal(await f.owner.load(file("dispose-pending-play.wav")), true);
  const errors = [];
  f.owner.subscribe((event) => {
    if (event.type === "error") errors.push(event);
  });
  const pending = f.owner.previewRange([1, 4]);
  f.owner.dispose();
  resume.reject(new Error("context closed"));
  assert.equal(await pending, false);
  assert.equal(f.elements[0].playCalls, 0);
  assert.deepEqual(errors, []);
});

test("dispose aborts in-flight work and releases every committed browser resource once", async () => {
  const pendingImage = deferred();
  const f = fixture({ readImage: (_file, _kind, asset) => pendingImage.promise.then(() => asset) });
  assert.equal(await f.owner.load(file("active.wav")), true);
  const loading = f.owner.load(file("pending.wav"), {
    projectAssets: { logo: file("late.png", "image/png"), background: null },
  });
  await Promise.resolve();
  f.owner.dispose();
  assert.equal(await loading, false);
  pendingImage.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.owner.snapshot.file, null);
  assert.ok(f.elements[0].removed);
  assert.ok(f.elements[1].removed);
  assert.equal(f.contextClosed, true);
  assert.ok(f.revoked.includes("media:active.wav:1"));
  assert.ok(f.revoked.includes("media:pending.wav:2"));
  assert.ok(f.revoked.some((url) => url.startsWith("asset:logo:late.png:")));
  assert.equal(f.sources[0]?.disconnected, true);
  assert.equal(f.lives[0]?.disposed, true);
});
