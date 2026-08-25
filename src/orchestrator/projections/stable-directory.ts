import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

import { LifecycleError } from "../lifecycle/errors.js";
import type {
  V2RetiredGeneration,
  V2RetirementImage,
  V2RetirementIntent,
} from "./reconciliation-journal.js";

const MUTATION_TIMEOUT_MS = 5_000;
const MAX_STABLE_MANIFEST_BYTES = 64 * 1_024;
const MAX_STABLE_GENERATION_BYTES = 512 * 1_024 * 1_024;
export const PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME =
  ".projection-manifest.publish.lock" as const;
export const PROJECTION_RECONCILIATION_JOURNAL_FILENAME =
  "projection-reconciliation-v2.json" as const;
const MUTATION_SCRIPT = String.raw`
"use strict";
const { createHash } = require("node:crypto");
const {
  closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, readdirSync, linkSync, renameSync, unlinkSync, writeSync,
} = require("node:fs");
const { basename, resolve } = require("node:path");
const [
  operation, expectedPath, expectedDevice, expectedInode, ...operationArguments
] = process.argv.slice(1);
const MAX_MANIFEST_BYTES = ${String(MAX_STABLE_MANIFEST_BYTES)};
const MAX_GENERATION_BYTES = ${String(MAX_STABLE_GENERATION_BYTES)};
const MANIFEST_NAME = "projection-manifest.json";
const MANIFEST_TEMP_NAME = ".projection-manifest.json.tmp";
const LOCK_NAME = ${JSON.stringify(PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME)};
const RECONCILIATION_JOURNAL_NAME = ${JSON.stringify(PROJECTION_RECONCILIATION_JOURNAL_FILENAME)};
const RECONCILIATION_JOURNAL_TEMP_NAME = ".projection-reconciliation-v2.json.tmp";
const TOKEN = /^[0-9a-f]{32}$/u;
const V2_GENERATION = /^projections-2-([1-9][0-9]{0,9})\.sqlite$/u;
const V2_RETIRED = /^\.projections-2-retired-([0-9a-f]{32})\.sqlite$/u;
const normalized = (path) => {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
};
const invalid = () => { throw new Error("PROJECTION_PATH_INVALID"); };
const integrity = () => { throw new Error("INTEGRITY_FAILURE"); };
const assertDirectory = () => {
  const directory = lstatSync(".", { bigint: true });
  if (!directory.isDirectory() || directory.isSymbolicLink()) invalid();
  if (
    normalized(realpathSync.native(".")) !== normalized(expectedPath)
    || directory.dev.toString() !== expectedDevice
    || directory.ino.toString() !== expectedInode
  ) invalid();
  return directory;
};
const captureManifest = () => {
  const manifestName = MANIFEST_NAME;
  let before;
  try {
    before = lstatSync(manifestName, { bigint: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      const directory = assertDirectory();
      return {
        state: "missing",
        directoryDevice: directory.dev.toString(),
        directoryInode: directory.ino.toString(),
      };
    }
    throw error;
  }
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.size < 0n
    || before.size > BigInt(MAX_MANIFEST_BYTES)
  ) invalid();
  let handle;
  try {
    handle = openSync(manifestName, "r");
    const opened = fstatSync(handle, { bigint: true });
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) invalid();
    const bytes = readFileSync(handle);
    const openedAfter = fstatSync(handle, { bigint: true });
    const after = lstatSync(manifestName, { bigint: true });
    if (
      bytes.byteLength !== Number(before.size)
      || openedAfter.dev !== opened.dev
      || openedAfter.ino !== opened.ino
      || openedAfter.size !== opened.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || !after.isFile()
      || after.isSymbolicLink()
    ) invalid();
    const directory = assertDirectory();
    return {
      state: "present",
      directoryDevice: directory.dev.toString(),
      directoryInode: directory.ino.toString(),
      device: opened.dev.toString(),
      inode: opened.ino.toString(),
      size: opened.size.toString(),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytesBase64: bytes.toString("base64"),
    };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
};
const syncDirectory = () => {
  let handle;
  try {
    handle = openSync(".", "r");
    fsyncSync(handle);
  } catch (error) {
    const code = error && error.code;
    if (
      code !== "EINVAL" && code !== "EISDIR" && code !== "ENOTSUP"
      && code !== "EOPNOTSUPP"
      && !(process.platform === "win32" && (code === "EACCES" || code === "EBADF" || code === "EPERM"))
    ) throw error;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
};
const sidecarPresent = (name) => {
  for (const suffix of ["-wal", "-shm"]) {
    try {
      lstatSync(name + suffix);
      return true;
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      integrity();
    }
  }
  return false;
};
const captureFileIdentity = (name, maximumBytes = MAX_MANIFEST_BYTES) => {
  const before = lstatSync(name, { bigint: true });
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.size < 0n
    || before.size > BigInt(maximumBytes)
  ) invalid();
  let handle;
  try {
    handle = openSync(name, "r");
    const opened = fstatSync(handle, { bigint: true });
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.ctimeNs !== before.ctimeNs
    ) invalid();
    const bytes = readFileSync(handle);
    const openedAfter = fstatSync(handle, { bigint: true });
    const after = lstatSync(name, { bigint: true });
    if (
      bytes.byteLength !== Number(before.size)
      || openedAfter.dev !== opened.dev
      || openedAfter.ino !== opened.ino
      || openedAfter.size !== opened.size
      || openedAfter.ctimeNs !== opened.ctimeNs
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.ctimeNs !== before.ctimeNs
      || !after.isFile()
      || after.isSymbolicLink()
    ) invalid();
    assertDirectory();
    return {
      device: opened.dev.toString(),
      inode: opened.ino.toString(),
      size: opened.size.toString(),
      ctimeNs: opened.ctimeNs.toString(),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
};
const assertToken = (token) => {
  if (typeof token !== "string" || !TOKEN.test(token)) invalid();
  return token;
};
const assertLock = (token) => {
  const lock = captureFileIdentity(LOCK_NAME);
  if (lock.bytes.toString("utf8") !== token) invalid();
};
const linkIfAbsent = (source, target) => {
  try {
    linkSync(source, target);
    return true;
  } catch (error) {
    if (error && error.code === "EEXIST") return false;
    throw error;
  }
};
const removeRegularFile = (name) => {
  const entry = lstatSync(name);
  if (!entry.isFile() || entry.isSymbolicLink()) invalid();
  unlinkSync(name);
};
const fileMatchesArguments = (file, offset) => (
  file.device === operationArguments[offset]
  && file.inode === operationArguments[offset + 1]
  && file.size === operationArguments[offset + 2]
  && file.sha256 === operationArguments[offset + 3]
);
const sameGenerationIdentity = (file, expected) => (
  file.device === expected.device
  && file.inode === expected.inode
  && file.size === expected.size
  && file.ctimeNs === expected.ctimeNs
  && file.sha256 === expected.sha256
);
const sameGenerationRenameContinuity = (file, expected) => (
  file.device === expected.device
  && file.inode === expected.inode
  && file.size === expected.size
  && file.sha256 === expected.sha256
);
const exactKeys = (value, keys) => (
  typeof value === "object" && value !== null && !Array.isArray(value)
  && Reflect.ownKeys(value).length === keys.length
  && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
);
const validGeneration = (value) => (
  Number.isSafeInteger(value) && value >= 0 && value <= 2147483647
);
const exactRetirementImage = (value) => {
  if (
    !exactKeys(value, ["device", "inode", "size", "ctimeNs", "sha256"])
    || typeof value.device !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.device)
    || typeof value.inode !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.inode)
    || typeof value.size !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.size)
    || BigInt(value.size) > BigInt(MAX_GENERATION_BYTES)
    || typeof value.ctimeNs !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.ctimeNs)
    || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256)
  ) invalid();
  return {
    device: value.device,
    inode: value.inode,
    size: value.size,
    ctimeNs: value.ctimeNs,
    sha256: value.sha256,
  };
};
const exactRetirement = (value) => {
  if (!validGeneration(value && value.generation)) invalid();
  if (value.state === "intent") {
    if (
      !exactKeys(value, ["state", "generation", "finalFilename", "retiredFilename", "image"])
      || typeof value.finalFilename !== "string"
      || !V2_GENERATION.test(value.finalFilename)
      || Number(V2_GENERATION.exec(value.finalFilename)[1]) !== value.generation
      || typeof value.retiredFilename !== "string" || !V2_RETIRED.test(value.retiredFilename)
    ) invalid();
    return {
      state: "intent",
      generation: value.generation,
      finalFilename: value.finalFilename,
      retiredFilename: value.retiredFilename,
      image: exactRetirementImage(value.image),
    };
  }
  if (
    value.state !== "retired"
    || !exactKeys(value, ["state", "generation", "retiredFilename", "image"])
    || typeof value.retiredFilename !== "string" || !V2_RETIRED.test(value.retiredFilename)
  ) invalid();
  return {
    state: "retired",
    generation: value.generation,
    retiredFilename: value.retiredFilename,
    image: exactRetirementImage(value.image),
  };
};
const canonicalJournalBytes = (journal) => Buffer.from(JSON.stringify(journal) + "\n", "utf8");
const exactJournal = (bytes) => {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { invalid(); }
  if (!validGeneration(value && value.highestReservedGeneration)) invalid();
  if (exactKeys(value, ["highestReservedGeneration"])) {
    const legacy = { highestReservedGeneration: value.highestReservedGeneration };
    if (!canonicalJournalBytes(legacy).equals(bytes)) throw new Error("JOURNAL_FORMAT_MISMATCH");
    return { highestReservedGeneration: legacy.highestReservedGeneration, retirements: [] };
  }
  if (
    !exactKeys(value, ["highestReservedGeneration", "retirements"])
    || !Array.isArray(value.retirements)
    || value.retirements.length > 100000
  ) invalid();
  const generations = new Set();
  const retiredFilenames = new Set();
  const retirements = value.retirements.map((record) => {
    const retirement = exactRetirement(record);
    if (
      retirement.generation > value.highestReservedGeneration
      || generations.has(retirement.generation)
      || retiredFilenames.has(retirement.retiredFilename)
    ) invalid();
    generations.add(retirement.generation);
    retiredFilenames.add(retirement.retiredFilename);
    return retirement;
  });
  const canonical = { highestReservedGeneration: value.highestReservedGeneration, retirements };
  if (!canonicalJournalBytes(canonical).equals(bytes)) throw new Error("JOURNAL_FORMAT_MISMATCH");
  return canonical;
};
const readJournal = () => {
  try {
    return exactJournal(captureFileIdentity(RECONCILIATION_JOURNAL_NAME).bytes);
  } catch (error) {
    if (error && error.code === "ENOENT") return { highestReservedGeneration: 0, retirements: [] };
    throw error;
  }
};
const writeDurable = (name, bytes) => {
  let handle;
  try {
    handle = openSync(name, "wx", 0o600);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = writeSync(handle, bytes, offset, bytes.byteLength - offset, offset);
      if (!Number.isSafeInteger(written) || written <= 0) invalid();
      offset += written;
    }
    fsyncSync(handle);
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
};
const writeJournal = (journal) => {
  try {
    lstatSync(RECONCILIATION_JOURNAL_TEMP_NAME);
    invalid();
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  const bytes = canonicalJournalBytes(journal);
  writeDurable(RECONCILIATION_JOURNAL_TEMP_NAME, bytes);
  renameSync(RECONCILIATION_JOURNAL_TEMP_NAME, RECONCILIATION_JOURNAL_NAME);
  syncDirectory();
  const observed = readJournal();
  if (!canonicalJournalBytes(observed).equals(bytes)) throw new Error("JOURNAL_VERIFY_MISMATCH");
};
const transactionNames = (attemptToken) => ({
  previous: ".projection-manifest.previous-" + attemptToken,
  attempted: ".projection-manifest.attempted-" + attemptToken,
  displaced: ".projection-manifest.displaced-" + attemptToken,
  failed: ".projection-manifest.failed-" + attemptToken,
});
try {
  assertDirectory();
  if (operation === "cleanup") {
    const generationTemp = /^\.projections-[12]-[1-9][0-9]{0,9}(?:-[0-9a-f]{32})?\.sqlite\.tmp(?:-(?:wal|shm))?$/u;
    for (const name of readdirSync(".")) {
      if (name !== ".projection-manifest.json.tmp" && !generationTemp.test(name)) continue;
      const entry = lstatSync(name);
      if (!entry.isFile() || entry.isSymbolicLink()) invalid();
      unlinkSync(name);
    }
    process.stdout.write("cleaned");
  } else if (operation === "capture-manifest") {
    process.stdout.write(JSON.stringify(captureManifest()));
  } else if (operation === "assert-generation") {
    const [filename] = operationArguments;
    if (
      typeof filename !== "string"
      || basename(filename) !== filename
      || !/^projections-[12]-[1-9][0-9]{0,9}\.sqlite$/u.test(filename)
    ) invalid();
    if (sidecarPresent(filename)) integrity();
    try {
      const entry = lstatSync(filename);
      if (!entry.isFile() || entry.isSymbolicLink()) invalid();
      process.stdout.write("present");
    } catch (error) {
      if (error && error.code === "ENOENT") process.stdout.write("missing");
      else throw error;
    }
  } else if (operation === "reserve-reconciliation-journal") {
    const [lockToken, requested] = operationArguments;
    assertLock(assertToken(lockToken));
    if (typeof requested !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(requested)) invalid();
    const requestedGeneration = Number(requested);
    if (!Number.isSafeInteger(requestedGeneration) || requestedGeneration > 2147483647) invalid();
    const journal = readJournal();
    const next = Math.max(journal.highestReservedGeneration, requestedGeneration);
    writeJournal({ highestReservedGeneration: next, retirements: journal.retirements });
    assertLock(lockToken);
    process.stdout.write(String(next));
  } else if (operation === "begin-reconciliation-retirement") {
    const [lockToken, encodedIntent] = operationArguments;
    assertLock(assertToken(lockToken));
    if (typeof encodedIntent !== "string") invalid();
    let input;
    try { input = JSON.parse(encodedIntent); } catch { invalid(); }
    const intent = exactRetirement(input);
    if (intent.state !== "intent" || JSON.stringify(intent) !== encodedIntent) invalid();
    const journal = readJournal();
    if (
      intent.generation > journal.highestReservedGeneration
      || journal.retirements.some((record) => (
        record.generation === intent.generation || record.retiredFilename === intent.retiredFilename
      ))
    ) invalid();
    writeJournal({
      highestReservedGeneration: journal.highestReservedGeneration,
      retirements: [...journal.retirements, intent],
    });
    assertLock(lockToken);
    process.stdout.write(JSON.stringify(intent));
  } else if (operation === "complete-reconciliation-retirement") {
    const [lockToken, encodedIntent, encodedImage] = operationArguments;
    assertLock(assertToken(lockToken));
    if (typeof encodedIntent !== "string" || typeof encodedImage !== "string") invalid();
    let intentInput;
    let imageInput;
    try {
      intentInput = JSON.parse(encodedIntent);
      imageInput = JSON.parse(encodedImage);
    } catch { invalid(); }
    const intent = exactRetirement(intentInput);
    const image = exactRetirementImage(imageInput);
    if (
      intent.state !== "intent"
      || JSON.stringify(intent) !== encodedIntent
      || JSON.stringify(image) !== encodedImage
      || !sameGenerationRenameContinuity(image, intent.image)
    ) invalid();
    const journal = readJournal();
    const index = journal.retirements.findIndex((record) => record.generation === intent.generation);
    if (index < 0 || JSON.stringify(journal.retirements[index]) !== JSON.stringify(intent)) invalid();
    const retired = {
      state: "retired",
      generation: intent.generation,
      retiredFilename: intent.retiredFilename,
      image,
    };
    const retirements = [...journal.retirements];
    retirements[index] = retired;
    writeJournal({ highestReservedGeneration: journal.highestReservedGeneration, retirements });
    assertLock(lockToken);
    process.stdout.write(JSON.stringify(retired));
  } else if (operation === "read-reconciliation-retirements") {
    const [lockToken] = operationArguments;
    assertLock(assertToken(lockToken));
    const journal = readJournal();
    assertLock(lockToken);
    process.stdout.write(JSON.stringify(journal.retirements));
  } else if (operation === "read-generation-image") {
    const [lockToken, filename] = operationArguments;
    assertLock(assertToken(lockToken));
    if (typeof filename !== "string" || !V2_GENERATION.test(filename)) invalid();
    if (sidecarPresent(filename)) integrity();
    const image = captureFileIdentity(filename, MAX_GENERATION_BYTES);
    assertLock(lockToken);
    process.stdout.write(JSON.stringify({
      filename,
      device: image.device,
      inode: image.inode,
      size: image.size,
      ctimeNs: image.ctimeNs,
      sha256: image.sha256,
      bytesBase64: image.bytes.toString("base64"),
    }));
  } else if (operation === "retire-generation") {
    const [lockToken, filename, retiredFilename, device, inode, size, ctimeNs, sha256] = operationArguments;
    assertLock(assertToken(lockToken));
    if (
      typeof filename !== "string" || !V2_GENERATION.test(filename)
      || typeof retiredFilename !== "string" || !V2_RETIRED.test(retiredFilename)
    ) invalid();
    try {
      lstatSync(retiredFilename);
      invalid();
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    if (sidecarPresent(filename) || sidecarPresent(retiredFilename)) integrity();
    const expected = { device, inode, size, ctimeNs, sha256 };
    const current = captureFileIdentity(filename, MAX_GENERATION_BYTES);
    if (!sameGenerationIdentity(current, expected)) invalid();
    renameSync(filename, retiredFilename);
    syncDirectory();
    const retired = captureFileIdentity(retiredFilename, MAX_GENERATION_BYTES);
    if (!sameGenerationRenameContinuity(retired, expected)) invalid();
    assertLock(lockToken);
    process.stdout.write(JSON.stringify({
      filename: retiredFilename,
      device: retired.device,
      inode: retired.inode,
      size: retired.size,
      ctimeNs: retired.ctimeNs,
      sha256: retired.sha256,
    }));
  } else if (operation === "capture-retired-generation") {
    const [lockToken, retiredFilename] = operationArguments;
    assertLock(assertToken(lockToken));
    if (typeof retiredFilename !== "string" || !V2_RETIRED.test(retiredFilename)) invalid();
    if (sidecarPresent(retiredFilename)) integrity();
    let retired;
    try {
      retired = captureFileIdentity(retiredFilename, MAX_GENERATION_BYTES);
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
      assertDirectory();
    }
    assertLock(lockToken);
    process.stdout.write(retired === undefined ? "null" : JSON.stringify({
      filename: retiredFilename,
      device: retired.device,
      inode: retired.inode,
      size: retired.size,
      ctimeNs: retired.ctimeNs,
      sha256: retired.sha256,
    }));
  } else if (operation === "install-generation") {
    const [lockToken, temporaryFilename, finalFilename, device, inode, size, sha256] = operationArguments;
    assertLock(assertToken(lockToken));
    if (
      typeof temporaryFilename !== "string"
      || !/^\.projections-2-[1-9][0-9]{0,9}-[0-9a-f]{32}\.sqlite\.tmp$/u.test(temporaryFilename)
      || typeof finalFilename !== "string"
      || !/^projections-2-[1-9][0-9]{0,9}\.sqlite$/u.test(finalFilename)
    ) invalid();
    const temporary = captureFileIdentity(temporaryFilename, MAX_GENERATION_BYTES);
    if (
      temporary.device !== device || temporary.inode !== inode
      || temporary.size !== size || temporary.sha256 !== sha256
      || sidecarPresent(temporaryFilename) || sidecarPresent(finalFilename)
    ) invalid();
    if (!linkIfAbsent(temporaryFilename, finalFilename)) {
      process.stdout.write("superseded");
    } else {
      const installed = captureFileIdentity(finalFilename, MAX_GENERATION_BYTES);
      if (
        installed.device !== temporary.device || installed.inode !== temporary.inode
        || installed.size !== temporary.size || installed.sha256 !== temporary.sha256
      ) integrity();
      removeRegularFile(temporaryFilename);
      syncDirectory();
      assertLock(lockToken);
      process.stdout.write("installed");
    }
  } else if (operation === "acquire-manifest-lock") {
    const lockToken = assertToken(operationArguments[0]);
    let handle;
    try {
      handle = openSync(LOCK_NAME, "wx", 0o600);
    } catch (error) {
      if (error && error.code === "EEXIST") {
        process.stdout.write("busy");
      } else throw error;
    }
    if (handle !== undefined) {
      try {
        const bytes = Buffer.from(lockToken, "utf8");
        let offset = 0;
        while (offset < bytes.byteLength) {
          const written = writeSync(handle, bytes, offset, bytes.byteLength - offset, offset);
          if (!Number.isSafeInteger(written) || written <= 0) invalid();
          offset += written;
        }
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      syncDirectory();
      assertLock(lockToken);
      process.stdout.write("acquired");
    }
  } else if (operation === "release-manifest-lock") {
    const lockToken = assertToken(operationArguments[0]);
    assertLock(lockToken);
    const retained = readdirSync(".").some((name) => (
      name.startsWith(".projection-manifest.previous-")
      || name.startsWith(".projection-manifest.attempted-")
      || name.startsWith(".projection-manifest.displaced-")
      || name.startsWith(".projection-manifest.failed-")
    ));
    if (retained) process.stdout.write("poisoned");
    else {
      removeRegularFile(LOCK_NAME);
      syncDirectory();
      assertDirectory();
      process.stdout.write("released");
    }
  } else if (operation === "prepare-manifest") {
    const lockToken = assertToken(operationArguments[0]);
    const attemptToken = assertToken(operationArguments[1]);
    const expectedState = operationArguments[2];
    if (expectedState !== "missing" && expectedState !== "present") invalid();
    const names = transactionNames(attemptToken);
    assertLock(lockToken);
    const candidate = captureFileIdentity(MANIFEST_TEMP_NAME);
    for (const name of Object.values(names)) {
      try {
        lstatSync(name);
        invalid();
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
    }
    if (!linkIfAbsent(MANIFEST_TEMP_NAME, names.attempted)) invalid();
    const attempted = captureFileIdentity(names.attempted);
    if (
      attempted.device !== candidate.device
      || attempted.inode !== candidate.inode
      || attempted.size !== candidate.size
      || attempted.sha256 !== candidate.sha256
    ) invalid();
    let outcome = "prepared";
    if (expectedState === "present") {
      try {
        linkSync(MANIFEST_NAME, names.previous);
      } catch (error) {
        if (error && error.code === "ENOENT") outcome = "poisoned";
        else throw error;
      }
      if (outcome === "prepared") {
        const previous = captureFileIdentity(names.previous);
        if (!fileMatchesArguments(previous, 3)) outcome = "superseded";
      }
    } else {
      try {
        lstatSync(MANIFEST_NAME);
        outcome = "superseded";
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
    }
    syncDirectory();
    assertLock(lockToken);
    process.stdout.write(outcome);
  } else if (operation === "install-manifest") {
    const lockToken = assertToken(operationArguments[0]);
    const attemptToken = assertToken(operationArguments[1]);
    const expectedState = operationArguments[2];
    if (expectedState !== "missing" && expectedState !== "present") invalid();
    const names = transactionNames(attemptToken);
    assertLock(lockToken);
    const attempted = captureFileIdentity(names.attempted);
    if (expectedState === "present") {
      const previous = captureFileIdentity(names.previous);
      if (!fileMatchesArguments(previous, 3)) invalid();
    } else {
      try {
        lstatSync(names.previous);
        invalid();
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
    }
    for (const name of [names.displaced, names.failed]) {
      try {
        lstatSync(name);
        invalid();
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
    }
    if (expectedState === "missing") {
      if (!linkIfAbsent(names.attempted, MANIFEST_NAME)) {
        process.stdout.write("superseded");
      } else {
        removeRegularFile(MANIFEST_TEMP_NAME);
        syncDirectory();
        assertLock(lockToken);
        process.stdout.write("installed");
      }
    } else {
      let moved = false;
      try {
        renameSync(MANIFEST_NAME, names.displaced);
        moved = true;
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
      if (!moved) process.stdout.write("poisoned");
      else {
        const displaced = captureFileIdentity(names.displaced);
        if (!fileMatchesArguments(displaced, 3)) {
          if (!linkIfAbsent(names.displaced, MANIFEST_NAME)) {
            process.stdout.write("poisoned");
          } else {
            syncDirectory();
            process.stdout.write("superseded");
          }
        } else if (!linkIfAbsent(names.attempted, MANIFEST_NAME)) {
          syncDirectory();
          process.stdout.write("superseded");
        } else {
          removeRegularFile(MANIFEST_TEMP_NAME);
          syncDirectory();
          assertLock(lockToken);
          process.stdout.write("installed");
        }
      }
    }
  } else if (operation === "commit-manifest") {
    const lockToken = assertToken(operationArguments[0]);
    const attemptToken = assertToken(operationArguments[1]);
    const previousState = operationArguments[2];
    if (previousState !== "missing" && previousState !== "present") invalid();
    const names = transactionNames(attemptToken);
    assertLock(lockToken);
    const attemptedSize = operationArguments[7];
    const attemptedSha256 = operationArguments[8];
    if (
      typeof attemptedSize !== "string"
      || !/^(?:0|[1-9][0-9]*)$/u.test(attemptedSize)
      || BigInt(attemptedSize) > BigInt(MAX_MANIFEST_BYTES)
      || typeof attemptedSha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(attemptedSha256)
    ) invalid();
    const attempted = captureFileIdentity(names.attempted);
    if (attempted.size !== attemptedSize || attempted.sha256 !== attemptedSha256) invalid();
    if (previousState === "present") {
      captureFileIdentity(names.previous);
    } else {
      try {
        lstatSync(names.previous);
        invalid();
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
    }
    const retained = [];
    for (const name of [names.displaced, names.failed]) {
      try {
        captureFileIdentity(name);
        retained.push(name);
      } catch (error) {
        if (!error || error.code !== "ENOENT") throw error;
      }
    }
    removeRegularFile(names.attempted);
    if (previousState === "present") removeRegularFile(names.previous);
    for (const name of retained) removeRegularFile(name);
    syncDirectory();
    assertLock(lockToken);
    process.stdout.write("committed");
  } else if (operation === "rollback-manifest") {
    const lockToken = assertToken(operationArguments[0]);
    const attemptToken = assertToken(operationArguments[1]);
    const previousState = operationArguments[2];
    if (previousState !== "missing" && previousState !== "present") invalid();
    const names = transactionNames(attemptToken);
    assertLock(lockToken);
    const attempted = captureFileIdentity(names.attempted);
    if (!fileMatchesArguments(attempted, 7)) invalid();
    if (previousState === "present") {
      const previous = captureFileIdentity(names.previous);
      if (!fileMatchesArguments(previous, 3)) invalid();
      const displaced = captureFileIdentity(names.displaced);
      if (!fileMatchesArguments(displaced, 3)) invalid();
    } else {
      for (const name of [names.previous, names.displaced]) {
        try {
          lstatSync(name);
          invalid();
        } catch (error) {
          if (!error || error.code !== "ENOENT") throw error;
        }
      }
    }
    try {
      lstatSync(names.failed);
      invalid();
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    let moved = false;
    try {
      renameSync(MANIFEST_NAME, names.failed);
      moved = true;
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    if (!moved) {
      syncDirectory();
      process.stdout.write("poisoned");
    } else {
      const failed = captureFileIdentity(names.failed);
      if (!fileMatchesArguments(failed, 7)) {
        if (!linkIfAbsent(names.failed, MANIFEST_NAME)) {
          process.stdout.write("superseded");
        } else {
          syncDirectory();
          process.stdout.write("superseded");
        }
      } else {
        let outcome;
        if (previousState === "present") {
          outcome = linkIfAbsent(names.previous, MANIFEST_NAME) ? "restored" : "superseded";
          if (outcome === "restored") {
            const restored = captureFileIdentity(MANIFEST_NAME);
            if (!fileMatchesArguments(restored, 3)) invalid();
          }
        } else {
          try {
            lstatSync(MANIFEST_NAME);
            outcome = "superseded";
          } catch (error) {
            if (error && error.code === "ENOENT") outcome = "removed";
            else throw error;
          }
        }
        syncDirectory();
        assertLock(lockToken);
        process.stdout.write(outcome);
      }
    }
  } else invalid();
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : "PROJECTION_PATH_INVALID");
  process.exitCode = 2;
}
`;

export interface ProjectionDirectoryIdentity {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
}

export interface StableProjectionManifestFileIdentity {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly sha256: string;
}

export interface StableProjectionManifestContentIdentity {
  readonly size: string;
  readonly sha256: string;
}

export interface StableProjectionGenerationIdentity {
  readonly filename: string;
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly ctimeNs: string;
  readonly sha256: string;
}

export interface StableProjectionGenerationImage {
  readonly identity: StableProjectionGenerationIdentity;
  readonly bytes: Uint8Array;
}

export type StableProjectionManifestSnapshot =
  | Readonly<{
    readonly state: "missing";
    readonly directoryIdentity: ProjectionDirectoryIdentity;
  }>
  | Readonly<{
    readonly state: "present";
    readonly directoryIdentity: ProjectionDirectoryIdentity;
    readonly fileIdentity: StableProjectionManifestFileIdentity;
    readonly bytesBase64: string;
  }>;

export interface StableProjectionDirectoryOperations {
  capture(directory: string): ProjectionDirectoryIdentity;
  cleanupKnownTemps(directory: string, identity: ProjectionDirectoryIdentity): void;
  assertGeneration(
    directory: string,
    filename: string,
    identity: ProjectionDirectoryIdentity,
  ): void;
  reserveReconciliationJournal(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    minimumGeneration: number,
  ): number;
  beginReconciliationRetirement(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    intent: V2RetirementIntent,
  ): V2RetirementIntent;
  completeReconciliationRetirement(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    intent: V2RetirementIntent,
    image: V2RetirementImage,
  ): V2RetiredGeneration;
  readReconciliationRetirements(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
  ): readonly (V2RetirementIntent | V2RetiredGeneration)[];
  readGenerationImage(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    filename: string,
  ): StableProjectionGenerationImage;
  retireGeneration(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    expected: StableProjectionGenerationIdentity,
    retiredFilename: string,
  ): StableProjectionGenerationIdentity;
  captureRetiredGeneration(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    retiredFilename: string,
  ): StableProjectionGenerationIdentity | null;
  installGeneration(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    temporaryFilename: string,
    finalFilename: string,
    expected: StableProjectionGenerationIdentity,
  ): "installed" | "superseded";
  captureManifest(
    directory: string,
    identity: ProjectionDirectoryIdentity,
  ): StableProjectionManifestSnapshot;
  acquireManifestPublicationLock(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
  ): "acquired" | "busy";
  prepareManifestPublication(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    attemptToken: string,
    expected: StableProjectionManifestSnapshot,
  ): "prepared" | "superseded" | "poisoned";
  installManifestIfExpected(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    attemptToken: string,
    expected: StableProjectionManifestSnapshot,
  ): "installed" | "superseded" | "poisoned";
  commitManifestPublication(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    attemptToken: string,
    previous: StableProjectionManifestSnapshot,
    attempted: StableProjectionManifestContentIdentity,
  ): "committed" | "poisoned";
  rollbackManifestPublication(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    attemptToken: string,
    previous: StableProjectionManifestSnapshot,
    installed: Extract<StableProjectionManifestSnapshot, { readonly state: "present" }>,
  ): "restored" | "removed" | "superseded" | "poisoned";
  releaseManifestPublicationLock(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
  ): "released" | "poisoned";
}

function normalizedPath(path: string): string {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function invalid(cause?: unknown): never {
  throw new Error("PROJECTION_PATH_INVALID", cause === undefined ? undefined : { cause });
}

export function captureProjectionDirectoryIdentity(
  directory: string,
): ProjectionDirectoryIdentity {
  if (
    !isAbsolute(directory)
    || normalize(directory) !== directory
    || resolve(directory) !== directory
  ) {
    return invalid();
  }
  try {
    const stat = lstatSync(directory, { bigint: true });
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || normalizedPath(realpathSync.native(directory)) !== normalizedPath(directory)
    ) return invalid();
    return Object.freeze({
      canonicalPath: directory,
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "PROJECTION_PATH_INVALID") throw error;
    return invalid(error);
  }
}

export function sameProjectionDirectoryIdentity(
  left: ProjectionDirectoryIdentity,
  right: ProjectionDirectoryIdentity,
): boolean {
  return normalizedPath(left.canonicalPath) === normalizedPath(right.canonicalPath)
    && left.device === right.device
    && left.inode === right.inode;
}

function runStableMutation(
  operation:
    | "cleanup"
    | "assert-generation"
    | "reserve-reconciliation-journal"
    | "begin-reconciliation-retirement"
    | "complete-reconciliation-retirement"
    | "read-reconciliation-retirements"
    | "read-generation-image"
    | "retire-generation"
    | "capture-retired-generation"
    | "install-generation"
    | "capture-manifest"
    | "acquire-manifest-lock"
    | "prepare-manifest"
    | "install-manifest"
    | "commit-manifest"
    | "rollback-manifest"
    | "release-manifest-lock",
  directory: string,
  identity: ProjectionDirectoryIdentity,
  argumentsAfterIdentity: readonly string[] = [],
): string {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      MUTATION_SCRIPT,
      operation,
      identity.canonicalPath,
      identity.device,
      identity.inode,
      ...argumentsAfterIdentity,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      maxBuffer: operation === "read-generation-image"
        ? Math.ceil((MAX_STABLE_GENERATION_BYTES * 4) / 3) + 4_096
        : (MAX_STABLE_MANIFEST_BYTES * 2) + 4_096,
      timeout: MUTATION_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.status !== 0 || result.error !== undefined) {
    if (result.error === undefined && result.stderr === "INTEGRITY_FAILURE") {
      throw new LifecycleError("INTEGRITY_FAILURE");
    }
    return invalid(result.error ?? result.stderr);
  }
  return result.stdout;
}

function snapshotIdentityArguments(
  snapshot: StableProjectionManifestSnapshot,
): readonly [string, string, string, string, string] {
  if (snapshot.state === "missing") return ["missing", "", "", "", ""];
  return [
    "present",
    snapshot.fileIdentity.device,
    snapshot.fileIdentity.inode,
    snapshot.fileIdentity.size,
    snapshot.fileIdentity.sha256,
  ];
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value);
}

function decodeGenerationIdentity(value: string, filename: string): StableProjectionGenerationIdentity {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return invalid();
  const source = decoded as Record<string, unknown>;
  if (
    Reflect.ownKeys(source).length !== 5
    || !decimal(source.device)
    || !decimal(source.inode)
    || !decimal(source.size)
    || !decimal(source.ctimeNs)
    || BigInt(source.size) > BigInt(MAX_STABLE_GENERATION_BYTES)
    || typeof source.sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(source.sha256)
  ) return invalid();
  return Object.freeze({
    filename,
    device: source.device,
    inode: source.inode,
    size: source.size,
    ctimeNs: source.ctimeNs,
    sha256: source.sha256,
  });
}

function decodeGenerationImage(value: string): StableProjectionGenerationImage {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return invalid();
  const source = decoded as Record<string, unknown>;
  if (
    Reflect.ownKeys(source).length !== 7
    || typeof source.filename !== "string"
    || !/^projections-2-[1-9][0-9]{0,9}\.sqlite$/u.test(source.filename)
    || typeof source.bytesBase64 !== "string"
  ) return invalid();
  const identity = decodeGenerationIdentity(JSON.stringify({
    device: source.device,
    inode: source.inode,
    size: source.size,
    ctimeNs: source.ctimeNs,
    sha256: source.sha256,
  }), source.filename);
  const bytes = Buffer.from(source.bytesBase64, "base64");
  if (
    bytes.toString("base64") !== source.bytesBase64
    || BigInt(bytes.byteLength) !== BigInt(identity.size)
    || createHash("sha256").update(bytes).digest("hex") !== identity.sha256
  ) return invalid();
  return Object.freeze({ identity, bytes });
}

function decodeRetiredGeneration(value: string): StableProjectionGenerationIdentity {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return invalid();
  const source = decoded as Record<string, unknown>;
  if (
    Reflect.ownKeys(source).length !== 6
    || typeof source.filename !== "string"
    || !/^\.projections-2-retired-[0-9a-f]{32}\.sqlite$/u.test(source.filename)
  ) return invalid();
  return decodeGenerationIdentity(JSON.stringify({
    device: source.device,
    inode: source.inode,
    size: source.size,
    ctimeNs: source.ctimeNs,
    sha256: source.sha256,
  }), source.filename);
}

function exactRecordKeys(source: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(source).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(source, key));
}

function decodeRetirementImage(value: unknown): V2RetirementImage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const source = value as Record<PropertyKey, unknown>;
  if (
    !exactRecordKeys(source, ["device", "inode", "size", "ctimeNs", "sha256"])
    || !decimal(source.device)
    || !decimal(source.inode)
    || !decimal(source.size)
    || BigInt(source.size) > BigInt(MAX_STABLE_GENERATION_BYTES)
    || !decimal(source.ctimeNs)
    || typeof source.sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(source.sha256)
  ) return invalid();
  return Object.freeze({
    device: source.device,
    inode: source.inode,
    size: source.size,
    ctimeNs: source.ctimeNs,
    sha256: source.sha256,
  });
}

function decodeRetirementRecord(value: unknown): V2RetirementIntent | V2RetiredGeneration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const source = value as Record<PropertyKey, unknown>;
  if (
    !Number.isSafeInteger(source.generation)
    || (source.generation as number) < 0
    || (source.generation as number) > 2_147_483_647
    || typeof source.retiredFilename !== "string"
    || !/^\.projections-2-retired-[0-9a-f]{32}\.sqlite$/u.test(source.retiredFilename)
  ) return invalid();
  const generation = source.generation as number;
  const image = decodeRetirementImage(source.image);
  if (source.state === "intent") {
    if (
      !exactRecordKeys(source, ["state", "generation", "finalFilename", "retiredFilename", "image"])
      || typeof source.finalFilename !== "string"
      || !/^projections-2-[1-9][0-9]{0,9}\.sqlite$/u.test(source.finalFilename)
      || Number(/^projections-2-([1-9][0-9]{0,9})\.sqlite$/u.exec(source.finalFilename)?.[1]) !== generation
    ) return invalid();
    return Object.freeze({
      state: "intent",
      generation,
      finalFilename: source.finalFilename,
      retiredFilename: source.retiredFilename,
      image,
    });
  }
  if (source.state !== "retired" || !exactRecordKeys(
    source,
    ["state", "generation", "retiredFilename", "image"],
  )) return invalid();
  return Object.freeze({
    state: "retired",
    generation,
    retiredFilename: source.retiredFilename,
    image,
  });
}

function decodeRetirementRecordText(value: string): V2RetirementIntent | V2RetiredGeneration {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  return decodeRetirementRecord(decoded);
}

function decodeReconciliationRetirements(
  value: string,
): readonly (V2RetirementIntent | V2RetiredGeneration)[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (!Array.isArray(decoded) || decoded.length > 100_000) return invalid();
  const generations = new Set<number>();
  const retiredFilenames = new Set<string>();
  const records = decoded.map((value) => {
    const record = decodeRetirementRecord(value);
    if (generations.has(record.generation) || retiredFilenames.has(record.retiredFilename)) {
      return invalid();
    }
    generations.add(record.generation);
    retiredFilenames.add(record.retiredFilename);
    return record;
  });
  return Object.freeze(records);
}

function decodeManifestSnapshot(
  value: string,
  canonicalPath: string,
): StableProjectionManifestSnapshot {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    return invalid();
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return invalid();
  const source = decoded as Record<string, unknown>;
  if (!decimal(source.directoryDevice) || !decimal(source.directoryInode)) return invalid();
  const directoryIdentity = Object.freeze({
    canonicalPath,
    device: source.directoryDevice,
    inode: source.directoryInode,
  });
  if (source.state === "missing") {
    if (Reflect.ownKeys(source).length !== 3) return invalid();
    return Object.freeze({ state: "missing", directoryIdentity });
  }
  if (
    source.state !== "present"
    || Reflect.ownKeys(source).length !== 8
    || !decimal(source.device)
    || !decimal(source.inode)
    || !decimal(source.size)
    || BigInt(source.size) > BigInt(MAX_STABLE_MANIFEST_BYTES)
    || typeof source.sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(source.sha256)
    || typeof source.bytesBase64 !== "string"
  ) return invalid();
  const bytes = Buffer.from(source.bytesBase64, "base64");
  if (
    bytes.toString("base64") !== source.bytesBase64
    || BigInt(bytes.byteLength) !== BigInt(source.size)
    || createHash("sha256").update(bytes).digest("hex") !== source.sha256
  ) return invalid();
  return Object.freeze({
    state: "present",
    directoryIdentity,
    fileIdentity: Object.freeze({
      device: source.device,
      inode: source.inode,
      size: source.size,
      sha256: source.sha256,
    }),
    bytesBase64: source.bytesBase64,
  });
}

export const filesystemStableProjectionDirectoryOperations:
StableProjectionDirectoryOperations = Object.freeze({
  capture: captureProjectionDirectoryIdentity,
  cleanupKnownTemps(directory: string, identity: ProjectionDirectoryIdentity): void {
    if (runStableMutation("cleanup", directory, identity) !== "cleaned") return invalid();
  },
  assertGeneration(
    directory: string,
    filename: string,
    identity: ProjectionDirectoryIdentity,
  ): void {
    if (runStableMutation("assert-generation", directory, identity, [filename]) !== "present") {
      return invalid();
    }
  },
  reserveReconciliationJournal(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    minimumGeneration: number,
  ): number {
    if (!Number.isSafeInteger(minimumGeneration) || minimumGeneration < 0 || minimumGeneration > 2_147_483_647) {
      return invalid();
    }
    const result = runStableMutation(
      "reserve-reconciliation-journal",
      directory,
      identity,
      [lockToken, String(minimumGeneration)],
    );
    if (!decimal(result) || Number(result) > 2_147_483_647) return invalid();
    return Number(result);
  },
  beginReconciliationRetirement(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    intent: V2RetirementIntent,
  ): V2RetirementIntent {
    const validated = decodeRetirementRecord(intent);
    if (validated.state !== "intent") return invalid();
    const result = decodeRetirementRecordText(runStableMutation(
      "begin-reconciliation-retirement",
      directory,
      identity,
      [lockToken, JSON.stringify(validated)],
    ));
    if (result.state !== "intent" || JSON.stringify(result) !== JSON.stringify(validated)) {
      return invalid();
    }
    return result;
  },
  completeReconciliationRetirement(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    intent: V2RetirementIntent,
    image: V2RetirementImage,
  ): V2RetiredGeneration {
    const validatedIntent = decodeRetirementRecord(intent);
    if (validatedIntent.state !== "intent") return invalid();
    const validatedImage = decodeRetirementImage(image);
    const result = decodeRetirementRecordText(runStableMutation(
      "complete-reconciliation-retirement",
      directory,
      identity,
      [lockToken, JSON.stringify(validatedIntent), JSON.stringify(validatedImage)],
    ));
    if (
      result.state !== "retired"
      || result.generation !== validatedIntent.generation
      || result.retiredFilename !== validatedIntent.retiredFilename
      || JSON.stringify(result.image) !== JSON.stringify(validatedImage)
    ) return invalid();
    return result;
  },
  readReconciliationRetirements(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
  ): readonly (V2RetirementIntent | V2RetiredGeneration)[] {
    return decodeReconciliationRetirements(runStableMutation(
      "read-reconciliation-retirements",
      directory,
      identity,
      [lockToken],
    ));
  },
  readGenerationImage(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    filename: string,
  ): StableProjectionGenerationImage {
    return decodeGenerationImage(runStableMutation(
      "read-generation-image",
      directory,
      identity,
      [lockToken, filename],
    ));
  },
  retireGeneration(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    expected: StableProjectionGenerationIdentity,
    retiredFilename: string,
  ): StableProjectionGenerationIdentity {
    if (!/^projections-2-[1-9][0-9]{0,9}\.sqlite$/u.test(expected.filename)) return invalid();
    if (!/^\.projections-2-retired-[0-9a-f]{32}\.sqlite$/u.test(retiredFilename)) return invalid();
    const result = runStableMutation("retire-generation", directory, identity, [
      lockToken,
      expected.filename,
      retiredFilename,
      expected.device,
      expected.inode,
      expected.size,
      expected.ctimeNs,
      expected.sha256,
    ]);
    return decodeRetiredGeneration(result);
  },
  captureRetiredGeneration(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    retiredFilename: string,
  ): StableProjectionGenerationIdentity | null {
    if (!/^\.projections-2-retired-[0-9a-f]{32}\.sqlite$/u.test(retiredFilename)) return invalid();
    const result = runStableMutation(
      "capture-retired-generation",
      directory,
      identity,
      [lockToken, retiredFilename],
    );
    return result === "null" ? null : decodeRetiredGeneration(result);
  },
  installGeneration(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    temporaryFilename: string,
    finalFilename: string,
    expected: StableProjectionGenerationIdentity,
  ): "installed" | "superseded" {
    const result = runStableMutation("install-generation", directory, identity, [
      lockToken,
      temporaryFilename,
      finalFilename,
      expected.device,
      expected.inode,
      expected.size,
      expected.sha256,
    ]);
    if (result !== "installed" && result !== "superseded") return invalid();
    return result;
  },
  captureManifest(
    directory: string,
    identity: ProjectionDirectoryIdentity,
  ): StableProjectionManifestSnapshot {
    return decodeManifestSnapshot(
      runStableMutation("capture-manifest", directory, identity),
      identity.canonicalPath,
    );
  },
  acquireManifestPublicationLock(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
  ): "acquired" | "busy" {
    const result = runStableMutation("acquire-manifest-lock", directory, identity, [lockToken]);
    if (result !== "acquired" && result !== "busy") return invalid();
    return result;
  },
  prepareManifestPublication(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    attemptToken: string,
    expected: StableProjectionManifestSnapshot,
  ): "prepared" | "superseded" | "poisoned" {
    if (!sameProjectionDirectoryIdentity(identity, expected.directoryIdentity)) return invalid();
    const result = runStableMutation("prepare-manifest", directory, identity, [
      lockToken,
      attemptToken,
      ...snapshotIdentityArguments(expected),
    ]);
    if (result !== "prepared" && result !== "superseded" && result !== "poisoned") {
      return invalid();
    }
    return result;
  },
  installManifestIfExpected(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    attemptToken: string,
    expected: StableProjectionManifestSnapshot,
  ): "installed" | "superseded" | "poisoned" {
    if (!sameProjectionDirectoryIdentity(identity, expected.directoryIdentity)) return invalid();
    const result = runStableMutation("install-manifest", directory, identity, [
      lockToken,
      attemptToken,
      ...snapshotIdentityArguments(expected),
    ]);
    if (result !== "installed" && result !== "superseded" && result !== "poisoned") {
      return invalid();
    }
    return result;
  },
  commitManifestPublication(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    attemptToken: string,
    previous: StableProjectionManifestSnapshot,
    attempted: StableProjectionManifestContentIdentity,
  ): "committed" | "poisoned" {
    if (
      !sameProjectionDirectoryIdentity(identity, previous.directoryIdentity)
      || !decimal(attempted.size)
      || BigInt(attempted.size) > BigInt(MAX_STABLE_MANIFEST_BYTES)
      || !/^[0-9a-f]{64}$/u.test(attempted.sha256)
    ) return invalid();
    const result = runStableMutation("commit-manifest", directory, identity, [
      lockToken,
      attemptToken,
      ...snapshotIdentityArguments(previous),
      attempted.size,
      attempted.sha256,
    ]);
    if (result !== "committed" && result !== "poisoned") return invalid();
    return result;
  },
  rollbackManifestPublication(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
    attemptToken: string,
    previous: StableProjectionManifestSnapshot,
    installed: Extract<StableProjectionManifestSnapshot, { readonly state: "present" }>,
  ): "restored" | "removed" | "superseded" | "poisoned" {
    if (
      !sameProjectionDirectoryIdentity(identity, previous.directoryIdentity)
      || !sameProjectionDirectoryIdentity(identity, installed.directoryIdentity)
    ) return invalid();
    const installedIdentity = snapshotIdentityArguments(installed);
    const result = runStableMutation("rollback-manifest", directory, identity, [
      lockToken,
      attemptToken,
      ...snapshotIdentityArguments(previous),
      ...installedIdentity.slice(1),
    ]);
    if (
      result !== "restored"
      && result !== "removed"
      && result !== "superseded"
      && result !== "poisoned"
    ) return invalid();
    return result;
  },
  releaseManifestPublicationLock(
    directory: string,
    identity: ProjectionDirectoryIdentity,
    lockToken: string,
  ): "released" | "poisoned" {
    const result = runStableMutation("release-manifest-lock", directory, identity, [lockToken]);
    if (result !== "released" && result !== "poisoned") return invalid();
    return result;
  },
});
