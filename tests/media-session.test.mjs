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

test("artwork is staged with project assets and multi-image replacement is atomic", async () => {
  const f = fixture();
  const { owner } = f;
  assert.equal(await owner.load(file("assets.wav")), true);
  assert.equal(await owner.changeImage("logo", file("old-logo.png", "image/png")), true);
  assert.equal(await owner.changeImage("artwork", file("old-cover.png", "image/png")), true);
  const oldLogo = owner.snapshot.logo;
  const oldArtwork = owner.snapshot.artwork;

  assert.equal(
    await owner.replaceAssets({
      logo: file("staged-logo.png", "image/png"),
      artwork: file("bad.png", "image/png"),
    }),
    false,
  );
  assert.equal(owner.snapshot.logo, oldLogo);
  assert.equal(owner.snapshot.artwork, oldArtwork);
  assert.ok(f.revoked.some((url) => url.startsWith("asset:logo:staged-logo.png:")));

  assert.equal(
    await owner.replaceAssets({
      logo: file("new-logo.png", "image/png"),
      artwork: file("new-cover.png", "image/png"),
    }),
    true,
  );
  assert.equal(owner.snapshot.logo.file.name, "new-logo.png");
  assert.equal(owner.snapshot.artwork.file.name, "new-cover.png");
  assert.ok(f.revoked.includes(oldLogo.url));
  assert.ok(f.revoked.includes(oldArtwork.url));
  const artworkUrl = owner.snapshot.artwork.url;
  owner.dispose();
  assert.ok(f.revoked.includes(artworkUrl));
});

test("atomic image replacement is discarded when a new media load starts before staging finishes", async () => {
  const imageRead = deferred();
  const imageReadStarted = deferred();
  const audioPreparation = deferred();
  const f = fixture({
    prepareAudio: async (mediaFile) =>
      mediaFile.name === "next-track.wav" ? audioPreparation.promise : null,
    readImage: async (imageFile, _kind, asset) => {
      if (imageFile.name === "pending-logo.png") {
        imageReadStarted.resolve();
        await imageRead.promise;
      }
      return asset;
    },
  });
  const { owner } = f;
  assert.equal(await owner.load(file("active-track.wav")), true);
  assert.equal(await owner.changeImage("logo", file("old-logo.png", "image/png")), true);
  assert.equal(await owner.changeImage("artwork", file("old-cover.png", "image/png")), true);
  const oldLogo = owner.snapshot.logo;
  const oldArtwork = owner.snapshot.artwork;

  const replacement = owner.replaceAssets({
    logo: file("pending-logo.png", "image/png"),
    artwork: file("pending-cover.png", "image/png"),
  });
  await imageReadStarted.promise;
  const loading = owner.load(file("next-track.wav"));
  assert.equal(owner.requestGeneration, 2);
  assert.equal(owner.snapshot.file.name, "active-track.wav");

  imageRead.resolve();
  assert.equal(await replacement, false);
  assert.equal(owner.snapshot.logo, oldLogo);
  assert.equal(owner.snapshot.artwork, oldArtwork);
  assert.ok(f.revoked.some((url) => url.startsWith("asset:logo:pending-logo.png:")));
  assert.ok(f.revoked.some((url) => url.startsWith("asset:artwork:pending-cover.png:")));

  audioPreparation.resolve(null);
  assert.equal(await loading, true);
  assert.equal(owner.snapshot.logo, oldLogo);
  assert.equal(owner.snapshot.artwork, oldArtwork);
  owner.dispose();
});

test("single image changes are discarded when a new media load starts while they are pending", async () => {
  const imageRead = deferred();
  const imageReadStarted = deferred();
  const audioPreparation = deferred();
  const f = fixture({
    prepareAudio: async (mediaFile) =>
      mediaFile.name === "next-track.wav" ? audioPreparation.promise : null,
    readImage: async (imageFile, _kind, asset) => {
      if (imageFile.name === "pending-cover.png") {
        imageReadStarted.resolve();
        await imageRead.promise;
      }
      return asset;
    },
  });
  const { owner } = f;
  assert.equal(await owner.load(file("active-track.wav")), true);
  assert.equal(await owner.changeImage("artwork", file("old-cover.png", "image/png")), true);
  const oldArtwork = owner.snapshot.artwork;

  const changing = owner.changeImage("artwork", file("pending-cover.png", "image/png"));
  await imageReadStarted.promise;
  const loading = owner.load(file("next-track.wav"));
  assert.equal(owner.requestGeneration, 2);
  imageRead.resolve();
  assert.equal(await changing, false);
  assert.equal(owner.snapshot.artwork, oldArtwork);
  assert.ok(f.revoked.some((url) => url.startsWith("asset:artwork:pending-cover.png:")));

  audioPreparation.resolve(null);
  assert.equal(await loading, true);
  assert.equal(owner.snapshot.artwork, oldArtwork);
  owner.dispose();
});

test("project asset load includes artwork and can skip preparation for inactive track activation", async () => {
  let prepared = 0;
  const f = fixture({ prepareAudio: async () => (prepared++, null) });
  const { owner } = f;
  const cover = file("cover.png", "image/png");
  assert.equal(
    await owner.load(file("inactive-track.wav"), {
      prepareSound: false,
      projectAssets: { logo: null, background: null, artwork: cover },
    }),
    true,
  );
  assert.equal(prepared, 0);
  assert.equal(owner.snapshot.artwork.file, cover);
  assert.equal(owner.snapshot.sound, null);
  assert.equal(owner.snapshot.live !== null, true);
  owner.dispose();
});

test("suspending prepared sound releases derived PCM while retaining playback and live response", async () => {
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
  const { owner } = f;
  assert.equal(await owner.load(file("prepared-track.wav")), true);
  const oldFeatures = owner.snapshot.features;
  assert.equal(oldFeatures.samples.length, 1);
  assert.equal(owner.suspendPreparedSound(), true);
  assert.equal(owner.snapshot.features, null);
  assert.equal(owner.snapshot.sound, null);
  assert.equal(owner.snapshot.live !== null, true);
  assert.equal(oldFeatures.samples.length, 0);
  assert.equal(owner.snapshot.file.name, "prepared-track.wav");
  owner.dispose();
});

test("clearing a track releases its resources, invalidates pending work, and leaves the owner reusable", async () => {
  const pendingAudio = deferred();
  const pendingImage = deferred();
  const pendingImageStarted = deferred();
  const preparedAudio = {
    sampleRate: 48000,
    numberOfChannels: 1,
    length: 48000,
    duration: 1,
    getChannelData: () => new Float32Array(48000),
  };
  const f = fixture({
    prepareAudio: async (mediaFile) => {
      if (mediaFile.name === "pending-track.wav") return pendingAudio.promise;
      if (mediaFile.name === "pcm-track.wav")
        return { audio: preparedAudio, events: [], envelopes: [], overview: [] };
      return null;
    },
    readImage: async (imageFile, _kind, asset) => {
      if (imageFile.name === "pending-background.png") {
        pendingImageStarted.resolve();
        await pendingImage.promise;
      }
      return asset;
    },
  });
  const { owner } = f;
  assert.equal(await owner.load(file("pcm-track.wav")), true);
  assert.equal(await owner.changeImage("logo", file("brand.png", "image/png")), true);
  assert.equal(await owner.changeImage("background", file("brand-bg.png", "image/png")), true);
  assert.equal(await owner.changeImage("artwork", file("cover.png", "image/png")), true);
  const logo = owner.snapshot.logo;
  const background = owner.snapshot.background;
  const cover = owner.snapshot.artwork;
  const media = owner.snapshot.media;
  const source = owner.snapshot.source;
  const features = owner.snapshot.features;
  assert.ok(features.samples.length > 0);

  const events = [];
  owner.subscribe((event) => events.push(event));
  const pendingLoad = owner.load(file("pending-track.wav"));
  const pendingBackground = owner.changeImage(
    "background",
    file("pending-background.png", "image/png"),
  );
  await pendingImageStarted.promise;
  assert.equal(owner.clearMedia(), true);
  assert.equal(owner.snapshot.file, null);
  assert.equal(owner.snapshot.media, null);
  assert.equal(owner.snapshot.video, null);
  assert.equal(owner.snapshot.sound, null);
  assert.equal(owner.snapshot.features, null);
  assert.equal(owner.snapshot.live, null);
  assert.equal(owner.snapshot.source, null);
  assert.equal(owner.snapshot.duration, 0);
  assert.equal(owner.snapshot.logo, logo);
  assert.equal(owner.snapshot.background, background);
  assert.equal(owner.snapshot.artwork, null);
  assert.equal(media.removed, true);
  assert.equal(source.disconnected, true);
  assert.equal(features.samples.length, 0);
  assert.ok(f.revoked.includes(cover.url));
  assert.equal(f.revoked.includes(logo.url), false);
  assert.equal(f.revoked.includes(background.url), false);
  assert.ok(events.some((event) => event.type === "loading" && !event.loading));
  assert.ok(events.some((event) => event.type === "position" && event.time === 0));
  assert.ok(events.some((event) => event.type === "memory" && event.snapshot.file === null));

  pendingImage.resolve();
  pendingAudio.resolve(null);
  assert.equal(await pendingLoad, false);
  assert.equal(await pendingBackground, false);
  assert.equal(owner.snapshot.background, background);
  assert.ok(f.revoked.some((url) => url.startsWith("asset:background:pending-background.png:")));
  assert.ok(f.revoked.some((url) => url.startsWith("media:pending-track.wav:")));

  assert.equal(await owner.load(file("live-track.wav")), true);
  const live = owner.snapshot.live;
  assert.ok(live);
  assert.equal(owner.clearMedia(), true);
  assert.equal(live.disposed, true);
  assert.equal(owner.snapshot.file, null);
  assert.equal(owner.snapshot.logo, logo);
  assert.equal(owner.snapshot.background, background);
  assert.equal(await owner.load(file("after-clear.wav")), true);
  assert.equal(owner.snapshot.file.name, "after-clear.wav");
  owner.dispose();
});

test("locked media clear leaves the active track and assets untouched", async () => {
  let locked = false;
  const f = fixture({ isBlocked: () => locked });
  const { owner } = f;
  assert.equal(await owner.load(file("locked-track.wav")), true);
  assert.equal(await owner.changeImage("artwork", file("locked-cover.png", "image/png")), true);
  const snapshot = owner.snapshot;
  locked = true;
  assert.equal(owner.clearMedia(), false);
  assert.equal(owner.snapshot.file, snapshot.file);
  assert.equal(owner.snapshot.media, snapshot.media);
  assert.equal(owner.snapshot.artwork, snapshot.artwork);
  assert.equal(snapshot.media.removed, false);
  assert.equal(f.revoked.includes(snapshot.artwork.url), false);
  locked = false;
  assert.equal(owner.clearMedia(), true);
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
