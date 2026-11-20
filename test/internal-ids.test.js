import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import {
  assignKleinanzeigenInternalIds,
  draftKleinanzeigenAd,
  findKleinanzeigenAd,
  listKleinanzeigenAds,
  readKleinanzeigenAd,
  runKleinanzeigenOperation,
  setKleinanzeigenAdFields,
  setKleinanzeigenAdImages,
  syncCheckKleinanzeigenAd,
} from "../src/cli.js";
import { contentHashForAd } from "../miniclaw/dist/index.js";
import { PublishingConfig } from "../miniclaw/dist/model/publishing-config.js";

async function workspace() {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kleinclaw-ids-")));
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

function okRunner(calls, { onCall } = {}) {
  return async (argv) => {
    calls.push(argv);
    await onCall?.(argv);
    return { stdout: "DONE: ok\n", stderr: "", code: 0, signal: null, termination: "exit" };
  };
}

describe("internal ad IDs", () => {
  it("assigns internal IDs to drafts and keeps identity when a draft is overwritten", async () => {
    const { adRoot, config } = await workspace();
    const draft = {
      confirm: true,
      title: "Kinderfahrrad 20 Zoll blau",
      description: "Gut erhalten.\nAbholung in Köln.",
      category: "Fahrräder",
      price: 60,
    };

    const first = await draftKleinanzeigenAd({ ...draft, directory: "bike" }, config);
    const second = await draftKleinanzeigenAd({ ...draft, directory: "bike-2" }, config);
    assert.equal(first.internalId, 1);
    assert.equal(second.internalId, 2);

    // Simulate a publication of the first draft, then overwrite it.
    const adPath = path.join(adRoot, "bike", "ad.yaml");
    const published = (await fs.readFile(adPath, "utf8")) +
      'id: 3123456789\ncontent_hash: "abc"\ncreated_on: "2026-11-01T10:00:00"\n';
    await fs.writeFile(adPath, published, "utf8");
    const overwritten = await draftKleinanzeigenAd(
      { ...draft, directory: "bike", overwrite: true, price: 55 },
      config,
    );
    const yaml = parseYaml(await fs.readFile(adPath, "utf8"));
    assert.equal(overwritten.internalId, 1);
    assert.equal(yaml.internal_id, 1);
    assert.equal(yaml.id, 3123456789);
    assert.equal(yaml.content_hash, "abc");
    assert.equal(yaml.created_on, "2026-11-01T10:00:00");
    assert.equal(yaml.price, 55);
    assert.deepEqual(overwritten.preservedKeys.sort(), ["content_hash", "created_on", "id", "internal_id"]);
  });

  it("assigns missing internal IDs oldest first and never renumbers existing ones", async () => {
    const { adRoot, config } = await workspace();
    await writeAd(adRoot, "newer", ["title: Neuere Anzeige mit Titel", 'created_on: "2026-10-02"']);
    await writeAd(adRoot, "older", ["title: Ältere Anzeige mit Titel", 'created_on: "2026-09-01"']);
    await writeAd(adRoot, "kept", ["internal_id: 7", "title: Anzeige mit fester Nummer"]);

    const before = await listKleinanzeigenAds(config);
    assert.equal(before.adsWithoutInternalId, 2);
    assert.equal(before.nextFreeInternalId, 8);

    const result = await assignKleinanzeigenInternalIds({ confirm: true }, config);
    assert.deepEqual(
      result.assigned.map((entry) => [entry.internalId, entry.adDirectory]),
      [[8, "older"], [9, "newer"]],
    );
    const kept = parseYaml(await fs.readFile(path.join(adRoot, "kept", "ad.yaml"), "utf8"));
    assert.equal(kept.internal_id, 7);

    const again = await assignKleinanzeigenInternalIds({ confirm: true }, config);
    assert.equal(again.changed, false);
    await assert.rejects(assignKleinanzeigenInternalIds({}, config), /confirm must be true/);
  });

  it("reports duplicate internal IDs and refuses to scope to them", async () => {
    const { adRoot, config } = await workspace();
    await writeAd(adRoot, "a", ["internal_id: 3", "title: Erste Anzeige mit Nummer drei"]);
    await writeAd(adRoot, "b", ["internal_id: 3", "title: Zweite Anzeige mit Nummer drei"]);

    const listed = await listKleinanzeigenAds(config);
    assert.equal(listed.internalIdDuplicates.length, 1);
    assert.equal(listed.internalIdDuplicates[0].internalId, 3);
    await assert.rejects(
      readKleinanzeigenAd({ internalIds: [3] }, config),
      /internal ID 3 is used by 2 ads/,
    );
    await assert.rejects(readKleinanzeigenAd({ internalIds: [4] }, config), /internal ID 4 was not found/);
  });

  it("finds ads by internal ID, Kleinanzeigen ID, and title words", async () => {
    const { adRoot, config } = await workspace();
    await writeAd(adRoot, "lamp", ["internal_id: 12", "id: 3123456789", "title: Schreibtischlampe Metall schwarz"]);
    await writeAd(adRoot, "lamp-2", ["internal_id: 13", "title: Stehlampe Metall weiß"]);

    const byInternal = await findKleinanzeigenAd({ ref: "#12" }, config);
    assert.equal(byInternal.count, 1);
    assert.equal(byInternal.matches[0].matchedBy, "internal_id");
    assert.equal(byInternal.matches[0].kleinanzeigenId, "3123456789");

    const byPlainNumber = await findKleinanzeigenAd({ ref: "13" }, config);
    assert.equal(byPlainNumber.matches[0].internalId, 13);

    const byKleinanzeigenId = await findKleinanzeigenAd({ ref: "3123456789" }, config);
    assert.equal(byKleinanzeigenId.matches[0].matchedBy, "kleinanzeigen_id");
    assert.equal(byKleinanzeigenId.matches[0].internalId, 12);

    const byTitle = await findKleinanzeigenAd({ ref: "lampe metall" }, config);
    assert.equal(byTitle.ambiguous, true);
    assert.deepEqual(byTitle.matches.map((entry) => entry.internalId), [12, 13]);

    const exact = await findKleinanzeigenAd({ ref: "schreibtischlampe" }, config);
    assert.equal(exact.count, 1);

    const listed = await listKleinanzeigenAds(config, { query: "#13" });
    assert.deepEqual(listed.ads.map((entry) => entry.internalId), [13]);
  });

  it("changes title and description of an ad addressed by internal ID", async () => {
    const { adRoot, config } = await workspace();
    const directory = await writeAd(adRoot, "chair", [
      "internal_id: 4",
      "active: true",
      'title: "Bürostuhl alt"',
      "description: |",
      "  Erste Zeile.",
      "  Zweite Zeile.",
      "",
      "# keep this comment",
      "price: 40",
    ]);

    const result = await setKleinanzeigenAdFields(
      {
        confirm: true,
        internalIds: [4],
        title: "Bürostuhl ergonomisch mit Armlehnen",
        description: "Neu beschrieben.\nMit Armlehnen.\n\nAbholung.",
      },
      config,
    );
    const text = await fs.readFile(path.join(directory, "ad.yaml"), "utf8");
    const yaml = parseYaml(text);
    assert.equal(result.summary.title, "Bürostuhl ergonomisch mit Armlehnen");
    assert.equal(yaml.description.trim(), "Neu beschrieben.\nMit Armlehnen.\n\nAbholung.");
    assert.equal(yaml.price, 40);
    assert.equal(yaml.internal_id, 4);
    assert.match(text, /^# keep this comment$/m);

    await assert.rejects(
      setKleinanzeigenAdFields({ confirm: true, internalIds: [4], title: "kurz" }, config),
      /at least 10 characters/,
    );
  });
});

describe("ad image order", () => {
  it("writes images in the given order and copies inbox photos into the ad directory", async () => {
    const { adRoot, config } = await workspace();
    const directory = await writeAd(adRoot, "table", [
      "internal_id: 5",
      "title: Esstisch Eiche massiv",
      "images:",
      '  - "*.jpg"',
      "price: 120",
    ]);
    await fs.writeFile(path.join(directory, "b-detail.jpg"), "detail");
    await fs.writeFile(path.join(directory, "a-side.jpg"), "side");
    await fs.writeFile(path.join(directory, "old.jpg"), "old");
    const inbox = path.join(adRoot, "inbox");
    await fs.mkdir(inbox);
    await fs.writeFile(path.join(inbox, "front (1).jpg"), "front");

    const result = await setKleinanzeigenAdImages(
      {
        confirm: true,
        internalIds: [5],
        images: ["inbox/front (1).jpg", "b-detail.jpg", "a-side.jpg"],
      },
      config,
    );

    assert.deepEqual(result.images, ["front _1_.jpg", "b-detail.jpg", "a-side.jpg"]);
    assert.deepEqual(result.copied, [{ from: path.join("inbox", "front (1).jpg"), to: "front _1_.jpg" }]);
    assert.deepEqual(result.unlistedImages, ["old.jpg"]);
    assert.deepEqual(result.previousImages, ["*.jpg"]);
    const yaml = parseYaml(await fs.readFile(path.join(directory, "ad.yaml"), "utf8"));
    assert.deepEqual(yaml.images, ["front _1_.jpg", "b-detail.jpg", "a-side.jpg"]);
    assert.equal(yaml.price, 120);
    assert.equal(await fs.readFile(path.join(directory, "front _1_.jpg"), "utf8"), "front");

    // Inbox photos are moved, so nothing unassigned stays behind.
    assert.deepEqual(result.movedSources, [path.join("inbox", "front (1).jpg")]);
    await assert.rejects(fs.stat(path.join(inbox, "front (1).jpg")), /ENOENT/);

    // The same photo sent again under another name reuses the existing file.
    await fs.writeFile(path.join(inbox, "IMG_0001.jpg"), "front");
    const again = await setKleinanzeigenAdImages(
      { confirm: true, internalIds: [5], images: ["inbox/IMG_0001.jpg", "b-detail.jpg"] },
      config,
    );
    assert.deepEqual(again.copied, []);
    assert.deepEqual(again.images, ["front _1_.jpg", "b-detail.jpg"]);
    await assert.rejects(fs.stat(path.join(inbox, "IMG_0001.jpg")), /ENOENT/);
  });

  it("rejects unsupported formats, duplicates, and files outside adRoots", async () => {
    const { tmp, adRoot, config } = await workspace();
    const directory = await writeAd(adRoot, "shelf", ["internal_id: 6", "title: Regal aus Kiefernholz"]);
    await fs.writeFile(path.join(directory, "photo.webp"), "webp");
    await fs.writeFile(path.join(directory, "photo.jpg"), "jpg");
    await fs.writeFile(path.join(tmp, "outside.jpg"), "outside");

    await assert.rejects(
      setKleinanzeigenAdImages({ confirm: true, internalIds: [6], images: ["photo.webp"] }, config),
      /convert other formats first/,
    );
    await assert.rejects(
      setKleinanzeigenAdImages(
        { confirm: true, internalIds: [6], images: ["photo.jpg", "./photo.jpg"] },
        config,
      ),
      /same file twice/,
    );
    await assert.rejects(
      setKleinanzeigenAdImages(
        { confirm: true, internalIds: [6], images: [path.join(tmp, "outside.jpg")] },
        config,
      ),
      /inside configured adRoots/,
    );
  });
});

describe("image fingerprints and internal ID scopes for live operations", () => {
  it("records a baseline silently and flags swapped image files as changed", async () => {
    const { adRoot, config } = await workspace();
    const directory = await writeAd(adRoot, "sofa", [
      "internal_id: 9",
      "active: true",
      "id: 3100000001",
      "title: Sofa grau drei Sitze",
      "images:",
      '  - "*.jpg"',
    ]);
    await fs.writeFile(path.join(directory, "1.jpg"), "first version");
    const adPath = path.join(directory, "ad.yaml");
    // Pretend miniclaw published it: store the current content hash.
    const published = parseYaml(await fs.readFile(adPath, "utf8"));
    await fs.appendFile(adPath, `content_hash: "${contentHashForAd(published)}"\n`, "utf8");

    const calls = [];
    const runConfig = { ...config, commandRunner: okRunner(calls) };
    const first = await runKleinanzeigenOperation(
      "update",
      { confirm: true, internalIds: [9] },
      runConfig,
    );
    assert.equal(first.imageChanges, undefined);
    let yaml = parseYaml(await fs.readFile(adPath, "utf8"));
    assert.match(yaml.images_fingerprint, /^[0-9a-f]{32}$/);
    assert.equal(contentHashForAd(yaml), yaml.content_hash, "baseline must not mark the ad changed");
    assert.ok(calls[0].some((arg) => arg.startsWith("--ad-file=") && arg.includes("sofa")));

    await fs.writeFile(path.join(directory, "1.jpg"), "second version, same name");
    const second = await runKleinanzeigenOperation(
      "update",
      { confirm: true, internalIds: [9] },
      runConfig,
    );
    yaml = parseYaml(await fs.readFile(adPath, "utf8"));
    assert.deepEqual(second.imageChanges.map((entry) => entry.internalId), [9]);
    assert.notEqual(contentHashForAd(yaml), yaml.content_hash, "swapped image must mark the ad changed");
  });

  it("maps internal IDs to Kleinanzeigen IDs for delete", async () => {
    const { adRoot, config } = await workspace();
    await writeAd(adRoot, "old", ["internal_id: 2", "id: 3100000002", "title: Alte Anzeige zum Löschen"]);
    await writeAd(adRoot, "draft", ["internal_id: 3", "title: Entwurf ohne Veröffentlichung"]);
    const calls = [];

    await runKleinanzeigenOperation(
      "delete",
      { confirm: true, internalIds: [2] },
      { ...config, commandRunner: okRunner(calls) },
    );
    assert.ok(calls[0].includes("--ads=3100000002"));

    await assert.rejects(
      runKleinanzeigenOperation(
        "delete",
        { confirm: true, internalIds: [3] },
        { ...config, commandRunner: okRunner(calls) },
      ),
      /never published/,
    );
    await assert.rejects(
      runKleinanzeigenOperation(
        "delete",
        { confirm: true, internalIds: [2], adIds: ["3100000002"] },
        { ...config, commandRunner: okRunner(calls) },
      ),
      /cannot be combined/,
    );
  });
});

describe("online sync check", () => {
  async function syncWorkspace() {
    const ws = await workspace();
    const directory = await writeAd(ws.adRoot, "bike", [
      "internal_id: 11",
      "active: true",
      "id: 3100000011",
      'title: "Kinderfahrrad 20 Zoll blau"',
      'description: "Gut erhalten."',
      'category: "210/217"',
      "price: 60",
      "price_type: NEGOTIABLE",
      "images:",
      '  - "local-1.jpg"',
    ]);
    await fs.writeFile(path.join(directory, "local-1.jpg"), "local image");
    const calls = [];
    const runner = okRunner(calls, {
      onCall: async (argv) => {
        const dirArg = argv.find((arg) => arg.startsWith("--download-dir="));
        assert.ok(dirArg, "sync check must pass --download-dir");
        const target = path.join(dirArg.slice("--download-dir=".length), "ad_3100000011_bike");
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, "ad_3100000011__img1.jpg"), "online one");
        await fs.writeFile(path.join(target, "ad_3100000011__img2.jpg"), "online two");
        await fs.writeFile(
          path.join(target, "ad_3100000011.yaml"),
          [
            "id: 3100000011",
            "title: Kinderfahrrad 20 Zoll blau",
            "description: Gut erhalten. Preis gesenkt!",
            'category: "210/217"',
            "price: 50",
            "price_type: NEGOTIABLE",
            "images:",
            "  - ad_3100000011__img1.jpg",
            "  - ad_3100000011__img2.jpg",
            "",
          ].join("\n"),
          "utf8",
        );
      },
    });
    return { ...ws, directory, calls, runConfig: { ...ws.config, commandRunner: runner } };
  }

  it("reports differences without changing the local ad", async () => {
    const { tmp, directory, calls, runConfig } = await syncWorkspace();
    const before = await fs.readFile(path.join(directory, "ad.yaml"), "utf8");

    const result = await syncCheckKleinanzeigenAd({ confirm: true, internalIds: [11] }, runConfig);

    assert.equal(result.ok, true);
    assert.equal(result.inSync, false);
    assert.deepEqual(result.differences.map((entry) => entry.field), ["description", "price"]);
    assert.deepEqual(result.images, {
      local: 1,
      online: 2,
      countDiffers: true,
      note: "online images are re-encoded by Kleinanzeigen, so only the count is compared",
    });
    assert.equal(result.changed, false);
    assert.ok(calls[0].includes("--ads=3100000011"));
    assert.ok(calls[0].includes("download"));
    const { last_synced_on: synced, ...afterFields } = parseYaml(
      await fs.readFile(path.join(directory, "ad.yaml"), "utf8"),
    );
    assert.deepEqual(afterFields, parseYaml(before), "only the sync timestamp may change");
    assert.ok(synced);
    const leftovers = (await fs.readdir(tmp)).filter((name) => name.startsWith(".kleinclaw-sync-"));
    assert.deepEqual(leftovers, [], "temporary download folder must be removed");
  });

  it("takes over online values and images on request", async () => {
    const { directory, runConfig } = await syncWorkspace();

    const result = await syncCheckKleinanzeigenAd(
      { confirm: true, internalIds: [11], apply: ["description", "price"], applyImages: true },
      runConfig,
    );

    assert.deepEqual(result.applied, ["description", "price"]);
    assert.deepEqual(result.importedImages, ["online-01.jpg", "online-02.jpg"]);
    const yaml = parseYaml(await fs.readFile(path.join(directory, "ad.yaml"), "utf8"));
    assert.equal(yaml.price, 50);
    assert.equal(yaml.description, "Gut erhalten. Preis gesenkt!");
    assert.deepEqual(yaml.images, ["online-01.jpg", "online-02.jpg"]);
    assert.equal(yaml.internal_id, 11);
    assert.equal(contentHashForAd(yaml), yaml.content_hash, "synced ad must not count as changed");
    assert.equal(await fs.readFile(path.join(directory, "online-02.jpg"), "utf8"), "online two");
  });

  it("refuses ads that were never published", async () => {
    const { adRoot, config } = await workspace();
    await writeAd(adRoot, "draft", ["internal_id: 1", "title: Entwurf ohne Veröffentlichung"]);
    await assert.rejects(
      syncCheckKleinanzeigenAd({ confirm: true, internalIds: [1] }, config),
      /no Kleinanzeigen ID yet/,
    );
  });
});

describe("live run timeouts", () => {
  it("gives live browser runs a longer timeout than local commands", async () => {
    const { adRoot, config } = await workspace();
    await writeAd(adRoot, "lamp", ["internal_id: 1", "active: true", "title: Schreibtischlampe Metall"]);
    const seen = [];
    const runner = async (argv, options) => {
      seen.push([argv.find((arg) => ["verify", "publish"].includes(arg)), options.timeoutMs]);
      return { stdout: "DONE: ok\n", stderr: "", code: 0, signal: null, termination: "exit" };
    };

    await runKleinanzeigenOperation("verify", {}, { ...config, commandRunner: runner });
    await runKleinanzeigenOperation(
      "publish",
      { confirm: true, internalIds: [1], selector: "all" },
      { ...config, commandRunner: runner },
    );
    await runKleinanzeigenOperation(
      "publish",
      { confirm: true, internalIds: [1], selector: "all" },
      { ...config, liveTimeoutMs: 900000, commandRunner: runner },
    );
    assert.deepEqual(seen, [["verify", 120000], ["publish", 600000], ["publish", 900000]]);
  });

  it("marks a publish that timed out without saved ID as uncertain", async () => {
    const { adRoot, config } = await workspace();
    await writeAd(adRoot, "lamp", ["internal_id: 1", "active: true", "title: Schreibtischlampe Metall"]);
    const result = await runKleinanzeigenOperation(
      "publish",
      { confirm: true, internalIds: [1], selector: "all" },
      {
        ...config,
        commandRunner: async () => ({
          stdout: "filling form\n",
          stderr: "",
          code: null,
          signal: "SIGTERM",
          termination: "timeout",
        }),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.outcome.status, "timed_out");
    assert.equal(result.outcome.uncertain, true);
    assert.match(result.outcome.nextActions[0], /do not run publish again/);
  });

  it("reports a timeout after the ID was saved as success", async () => {
    const { adRoot, config } = await workspace();
    const directory = await writeAd(adRoot, "lamp", [
      "internal_id: 1",
      "active: true",
      "title: Schreibtischlampe Metall",
    ]);
    const result = await runKleinanzeigenOperation(
      "publish",
      { confirm: true, internalIds: [1], selector: "all" },
      {
        ...config,
        commandRunner: async () => {
          await fs.appendFile(path.join(directory, "ad.yaml"), "id: 3100000099\n", "utf8");
          return { stdout: "", stderr: "", code: null, signal: "SIGTERM", termination: "timeout" };
        },
      },
    );
    assert.equal(result.outcome.success, true);
    assert.equal(result.outcome.status, "succeeded_with_process_timeout");
    assert.equal(result.outcome.uncertain, undefined);
  });
});

describe("miniclaw defaults for stable references", () => {
  it("waits only briefly for the review page after the ID is saved", async () => {
    const { TimeoutConfig } = await import("../miniclaw/dist/model/timeout-config.js");
    assert.equal(new TimeoutConfig({}).publishingResult, 20);
    assert.equal(new TimeoutConfig({ publishing_result: 300 }).publishingResult, 300);
  });

  it("does not delete other ads by title on republication unless configured", () => {
    assert.equal(new PublishingConfig({}).deleteOldAdsByTitle, false);
    assert.equal(new PublishingConfig({ delete_old_ads_by_title: true }).deleteOldAdsByTitle, true);
  });

  it("keeps internal_id out of the content hash", () => {
    const ad = { title: "Kinderfahrrad 20 Zoll blau", price: 60 };
    assert.equal(contentHashForAd({ ...ad, internal_id: 4 }), contentHashForAd(ad));
    assert.notEqual(contentHashForAd({ ...ad, images_fingerprint: "x" }), contentHashForAd(ad));
  });
});
