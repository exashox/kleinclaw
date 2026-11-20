import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import {
  cleanupKleinanzeigenStorage,
  kleinanzeigenImagePreferences,
  setKleinanzeigenAdImages,
  syncKleinanzeigenAds,
} from "../src/cli.js";
import { contentHashForAd } from "../miniclaw/dist/index.js";

async function workspace() {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kleinclaw-sync-")));
  const adRoot = path.join(tmp, "ads");
  await fs.mkdir(adRoot, { recursive: true });
  const configPath = path.join(tmp, "config.yaml");
  await fs.writeFile(configPath, "ad_files: []\n", "utf8");
  return { tmp, adRoot, configPath, config: { adRoots: [adRoot], configPath } };
}

async function writeAd(adRoot, name, lines) {
  const directory = path.join(adRoot, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "ad.yaml"), [...lines, ""].join("\n"), "utf8");
  return directory;
}

async function readAd(directory) {
  return parseYaml(await fs.readFile(path.join(directory, "ad.yaml"), "utf8"));
}

/** Writes the content hash miniclaw stores after a publish. */
async function markPublished(directory) {
  const adPath = path.join(directory, "ad.yaml");
  const ad = parseYaml(await fs.readFile(adPath, "utf8"));
  await fs.appendFile(adPath, `content_hash: "${contentHashForAd(ad)}"\n`, "utf8");
}

async function setAdField(directory, key, value) {
  const adPath = path.join(directory, "ad.yaml");
  const text = await fs.readFile(adPath, "utf8");
  await fs.writeFile(adPath, text.replace(new RegExp(`^${key}:.*$`, "m"), `${key}: ${value}`), "utf8");
}

function fakeKleinanzeigen(onlineAds, calls = []) {
  return async (argv) => {
    calls.push(argv);
    const dirArg = argv.find((arg) => arg.startsWith("--download-dir="));
    const idsArg = argv.find((arg) => arg.startsWith("--ads="));
    const downloadDir = dirArg.slice("--download-dir=".length);
    for (const id of idsArg.slice("--ads=".length).split(",")) {
      const ad = onlineAds[id];
      if (!ad) {
        continue;
      }
      const target = path.join(downloadDir, `ad_${id}_x`);
      await fs.mkdir(target, { recursive: true });
      const images = [];
      for (const [index, content] of (ad.images ?? ["online image"]).entries()) {
        const name = `ad_${id}__img${index + 1}.jpg`;
        await fs.writeFile(path.join(target, name), content);
        images.push(name);
      }
      await fs.writeFile(
        path.join(target, `ad_${id}.yaml`),
        [
          `id: ${id}`,
          `title: "${ad.title}"`,
          `description: "${ad.description}"`,
          `category: "${ad.category}"`,
          `price: ${ad.price}`,
          `price_type: ${ad.priceType ?? "NEGOTIABLE"}`,
          "images:",
          ...images.map((name) => `  - ${name}`),
          "",
        ].join("\n"),
        "utf8",
      );
    }
    return { stdout: "DONE: ok\n", stderr: "", code: 0, signal: null, termination: "exit" };
  };
}

async function publishedAd(adRoot, name, { internalId, id, title, description = "Gut erhalten.", price }) {
  const directory = await writeAd(adRoot, name, [
    `internal_id: ${internalId}`,
    "active: true",
    `id: ${id}`,
    `title: "${title}"`,
    `description: "${description}"`,
    'category: "210/217"',
    `price: ${price}`,
    "price_type: NEGOTIABLE",
    "images:",
    '  - "1.jpg"',
  ]);
  await fs.writeFile(path.join(directory, "1.jpg"), `local ${name}`);
  await markPublished(directory);
  return directory;
}

describe("two-way sync with Kleinanzeigen", () => {
  it("pulls online edits, reports local changes, and flags conflicts", async () => {
    const { adRoot, config } = await workspace();
    const lamp = await publishedAd(adRoot, "lamp", {
      internalId: 1, id: "3100000001", title: "Schreibtischlampe Metall", price: 30,
    });
    const chair = await publishedAd(adRoot, "chair", {
      internalId: 2, id: "3100000002", title: "Bürostuhl mit Armlehnen", price: 40,
    });
    const table = await publishedAd(adRoot, "table", {
      internalId: 3, id: "3100000003", title: "Esstisch Eiche massiv", price: 120,
    });
    await publishedAd(adRoot, "gone", {
      internalId: 4, id: "3100000004", title: "Bereits gelöschte Anzeige", price: 5,
    });
    const sold = await publishedAd(adRoot, "sold", {
      internalId: 5, id: "3100000005", title: "Schon verkaufte Anzeige", price: 5,
    });
    await fs.appendFile(path.join(sold, "ad.yaml"), "sold: true\n", "utf8");

    const online = {
      // The user lowered the lamp price on the website.
      3100000001: { title: "Schreibtischlampe Metall", description: "Gut erhalten.", category: "210/217", price: 25 },
      3100000002: { title: "Bürostuhl mit Armlehnen", description: "Gut erhalten.", category: "210/217", price: 40 },
      3100000003: { title: "Esstisch Eiche massiv", description: "Gut erhalten.", category: "210/217", price: 120 },
    };
    const calls = [];
    const runConfig = { ...config, commandRunner: fakeKleinanzeigen(online, calls) };

    const dry = await syncKleinanzeigenAds({ confirm: true, dryRun: true }, runConfig);
    assert.deepEqual(dry.counts, { would_pull: 1, in_sync: 2, not_found_online: 1 });
    assert.deepEqual(dry.skipped, { notPublished: 0, sold: 1, notYaml: 0 });
    assert.equal((await readAd(lamp)).price, 30, "dry run must not write");
    assert.equal(calls.length, 1, "one browser run for all ads");

    const first = await syncKleinanzeigenAds({ confirm: true }, runConfig);
    assert.deepEqual(first.counts, { pulled: 1, in_sync: 2, not_found_online: 1 });
    const pulled = first.results.find((entry) => entry.internalId === 1);
    assert.deepEqual(pulled.applied, ["price"]);
    const lampYaml = await readAd(lamp);
    assert.equal(lampYaml.price, 25);
    assert.equal(contentHashForAd(lampYaml), lampYaml.content_hash, "pulled ad must not count as changed");
    assert.match(lampYaml.online_hash, /^[0-9a-f]{32}$/);
    assert.ok(lampYaml.last_synced_on);

    // Now: chair changed locally only, table changed on both sides.
    await setAdField(chair, "price", "35");
    await setAdField(table, "price", "110");
    online[3100000003].description = "Gut erhalten, kleine Kratzer.";

    const second = await syncKleinanzeigenAds({ confirm: true }, runConfig);
    const statusById = Object.fromEntries(second.results.map((entry) => [entry.internalId, entry.status]));
    assert.deepEqual(statusById, { 1: "in_sync", 2: "local_ahead", 3: "conflict", 4: "not_found_online" });
    assert.equal((await readAd(chair)).price, 35, "local changes are kept");
    assert.equal((await readAd(table)).description, "Gut erhalten.", "conflicts are not resolved automatically");
    const conflict = second.results.find((entry) => entry.internalId === 3);
    assert.deepEqual(conflict.differences.map((entry) => entry.field), ["description", "price"]);
    assert.ok(second.nextActions.some((action) => /conflict/.test(action)));

    // Conflicts stay conflicts until resolved.
    const third = await syncKleinanzeigenAds({ confirm: true, internalIds: [3] }, runConfig);
    assert.equal(third.results[0].status, "conflict");
  });

  it("takes over changed online images when the local ad is unchanged", async () => {
    const { adRoot, config } = await workspace();
    const lamp = await publishedAd(adRoot, "lamp", {
      internalId: 1, id: "3100000001", title: "Schreibtischlampe Metall", price: 30,
    });
    const online = {
      3100000001: {
        title: "Schreibtischlampe Metall",
        description: "Gut erhalten.",
        category: "210/217",
        price: 30,
        images: ["new front", "new side"],
      },
    };
    const result = await syncKleinanzeigenAds(
      { confirm: true },
      { ...config, commandRunner: fakeKleinanzeigen(online) },
    );
    assert.equal(result.results[0].status, "pulled");
    assert.deepEqual(result.results[0].importedImages, ["online-01.jpg", "online-02.jpg"]);
    assert.deepEqual((await readAd(lamp)).images, ["online-01.jpg", "online-02.jpg"]);
  });

  it("requires confirmation and limits one run to 20 ads", async () => {
    const { config } = await workspace();
    await assert.rejects(syncKleinanzeigenAds({}, config), /confirm must be true/);
    const empty = await syncKleinanzeigenAds({ confirm: true }, config);
    assert.equal(empty.checked, 0);
  });
});

describe("storage cleanup", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  const old = new Date("2026-11-01T12:00:00Z");
  const fresh = new Date("2026-11-19T12:00:00Z");

  async function file(target, content, mtime) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    await fs.utimes(target, mtime, mtime);
  }

  async function exists(target) {
    return fs.stat(target).then(() => true, () => false);
  }

  it("moves unassigned and duplicate images to the trash and keeps used ones", async () => {
    const { tmp, adRoot, config } = await workspace();
    const lamp = await writeAd(adRoot, "lamp", [
      "internal_id: 1",
      "title: Schreibtischlampe Metall",
      "images:",
      '  - "a.jpg"',
    ]);
    await file(path.join(lamp, "a.jpg"), "lamp front", old);
    await file(path.join(lamp, "old.jpg"), "replaced photo", old);
    await file(path.join(lamp, "new.jpg"), "fresh unlisted photo", fresh);
    await file(path.join(lamp, "a-copy.jpg"), "lamp front", fresh);
    const chair = await writeAd(adRoot, "chair", [
      "internal_id: 2",
      "title: Bürostuhl mit Armlehnen",
      "images:",
      '  - "x.jpg"',
      '  - "x2.jpg"',
    ]);
    await file(path.join(chair, "x.jpg"), "chair", old);
    await file(path.join(chair, "x2.jpg"), "chair", old);
    await file(path.join(adRoot, "inbox", "stray.jpg"), "never assigned", old);
    await file(path.join(adRoot, "inbox", "fresh.jpg"), "just sent", fresh);
    await fs.mkdir(path.join(adRoot, "inbox", "sub"), { recursive: true });
    await file(path.join(adRoot, ".tmp-ad_1", "x.yaml"), "x", old);
    await fs.utimes(path.join(adRoot, ".tmp-ad_1"), old, old);
    await file(path.join(tmp, ".kleinclaw-123-abc.yaml"), "temp config", old);
    await file(path.join(adRoot, ".kleinclaw", "trash", "2026-10-01", "x.jpg"), "expired", old);
    await file(path.join(adRoot, ".kleinclaw", "trash", "2026-11-15", "y.jpg"), "recent", old);

    const report = await cleanupKleinanzeigenStorage({}, config, { now });
    assert.equal(report.applied, false);
    assert.deepEqual(report.counts, {
      temporary: 2,
      expired_trash: 1,
      unlisted_in_ad: 1,
      duplicate: 1,
      unassigned: 1,
    });
    assert.deepEqual(report.duplicatesInAd, [
      { internalId: 2, title: "Bürostuhl mit Armlehnen", files: ["x.jpg", "x2.jpg"] },
    ]);
    const duplicate = report.items.find((item) => item.reason === "duplicate");
    assert.equal(duplicate.path, path.join("lamp", "a-copy.jpg"));
    assert.equal(duplicate.duplicateOf, path.join("lamp", "a.jpg"));
    assert.ok(await exists(path.join(lamp, "old.jpg")), "report only must not move anything");

    await assert.rejects(cleanupKleinanzeigenStorage({ apply: true }, config, { now }), /confirm/);
    const applied = await cleanupKleinanzeigenStorage({ apply: true, confirm: true }, config, { now });
    assert.equal(applied.applied, true);

    const trash = path.join(adRoot, ".kleinclaw", "trash", "2026-11-20");
    assert.ok(await exists(path.join(trash, "lamp", "old.jpg")));
    assert.ok(await exists(path.join(trash, "lamp", "a-copy.jpg")));
    assert.ok(await exists(path.join(trash, "inbox", "stray.jpg")));
    for (const kept of [
      path.join(lamp, "a.jpg"),
      path.join(lamp, "new.jpg"),
      path.join(chair, "x.jpg"),
      path.join(chair, "x2.jpg"),
      path.join(adRoot, "inbox", "fresh.jpg"),
      path.join(adRoot, ".kleinclaw", "trash", "2026-11-15", "y.jpg"),
    ]) {
      assert.ok(await exists(kept), `${kept} must be kept`);
    }
    for (const removed of [
      path.join(lamp, "old.jpg"),
      path.join(adRoot, ".tmp-ad_1"),
      path.join(tmp, ".kleinclaw-123-abc.yaml"),
      path.join(adRoot, ".kleinclaw", "trash", "2026-10-01"),
      path.join(adRoot, "inbox", "sub"),
    ]) {
      assert.equal(await exists(removed), false, `${removed} must be gone`);
    }
    assert.ok(await exists(path.join(adRoot, "inbox")), "top-level folders stay");

    const again = await cleanupKleinanzeigenStorage({}, config, { now });
    assert.deepEqual(again.counts, {});
  });
});

describe("learning the image order", () => {
  async function adWithPhotos(adRoot, name, internalId) {
    const directory = await writeAd(adRoot, name, [
      `internal_id: ${internalId}`,
      `title: Testanzeige Nummer ${internalId}`,
      'category: "Möbel"',
    ]);
    for (const photo of ["front.jpg", "side.jpg", "defect.jpg"]) {
      await fs.writeFile(path.join(directory, photo), `${name} ${photo}`);
    }
    return directory;
  }

  it("records proposals and corrections and derives guidance", async () => {
    const { adRoot, config } = await workspace();
    for (const internalId of [1, 2, 3]) {
      const directory = await adWithPhotos(adRoot, `ad-${internalId}`, internalId);
      const proposal = await setKleinanzeigenAdImages(
        {
          confirm: true,
          internalIds: [internalId],
          images: ["side.jpg", "front.jpg", "defect.jpg"],
          assessments: [
            { image: "side.jpg", role: "angle", quality: 5 },
            { image: "front.jpg", role: "overview", quality: 4 },
            { image: "defect.jpg", role: "defect", quality: 3 },
          ],
        },
        config,
      );
      assert.deepEqual(proposal.learning, { recorded: "proposal" });
      assert.ok(await fs.stat(path.join(directory, ".kleinclaw-image-proposal.json")));

      const corrected = await setKleinanzeigenAdImages(
        {
          confirm: true,
          internalIds: [internalId],
          images: ["front.jpg", "side.jpg", "defect.jpg"],
          orderSource: "user",
        },
        config,
      );
      assert.deepEqual(corrected.learning, { recorded: "feedback", corrected: true });
      await assert.rejects(fs.stat(path.join(directory, ".kleinclaw-image-proposal.json")), /ENOENT/);
    }

    const preferences = await kleinanzeigenImagePreferences({}, config);
    assert.equal(preferences.events, 3);
    assert.equal(preferences.correctionRate, 1);
    assert.deepEqual(preferences.coverRoles, { overview: 3 });
    assert.deepEqual(preferences.averagePositionByRole, { overview: 1, angle: 2, defect: 3 });
    assert.deepEqual(preferences.userMovesByRole.overview, { average: 1, count: 3 });
    assert.ok(preferences.guidance.some((line) => /cover is usually a "overview"/.test(line)));
    assert.ok(preferences.guidance.some((line) => /moves "overview" images 1 positions earlier/.test(line)));
    assert.equal(preferences.recentCorrections.length, 3);
    assert.deepEqual(
      (await kleinanzeigenImagePreferences({ category: "auto" }, config)).events,
      0,
    );

    await assert.rejects(
      kleinanzeigenImagePreferences({ action: "add_rule", rule: "Titelbild nie vor weißer Wand" }, config),
      /confirm/,
    );
    const added = await kleinanzeigenImagePreferences(
      { action: "add_rule", rule: "Titelbild nie vor weißer Wand", confirm: true },
      config,
    );
    assert.deepEqual(added.rules.map((rule) => rule.text), ["Titelbild nie vor weißer Wand"]);
    assert.ok(added.guidance[0].startsWith("user rule:"));
    const removed = await kleinanzeigenImagePreferences(
      { action: "remove_rule", ruleId: added.rules[0].id, confirm: true },
      config,
    );
    assert.deepEqual(removed.rules, []);
    assert.ok(await fs.stat(path.join(adRoot, ".kleinclaw", "image-preferences.json")));
  });

  it("skips byte-identical duplicates in one image list", async () => {
    const { adRoot, config } = await workspace();
    const directory = await writeAd(adRoot, "lamp", ["internal_id: 1", "title: Schreibtischlampe Metall"]);
    await fs.writeFile(path.join(directory, "a.jpg"), "same");
    await fs.writeFile(path.join(directory, "a (copy).jpg"), "same");
    await fs.writeFile(path.join(directory, "b.jpg"), "other");
    const result = await setKleinanzeigenAdImages(
      { confirm: true, internalIds: [1], images: ["a.jpg", "b.jpg", "a (copy).jpg"] },
      config,
    );
    assert.deepEqual(result.images, ["a.jpg", "b.jpg"]);
    assert.deepEqual(result.skippedDuplicates, [{ image: "a (copy).jpg", duplicateOf: "a.jpg" }]);
  });
});
