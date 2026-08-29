import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSshTarget } from "./auth.js";
import {
  buildListFilesCommand,
  parseRemoteFileListing,
  shellQuote
} from "./files.js";

test("SSH target validation accepts hostnames and rejects command-like input", () => {
  assert.deepEqual(normalizeSshTarget("gpu.example.edu", 2222), {
    host: "gpu.example.edu",
    port: 2222
  });
  assert.deepEqual(normalizeSshTarget("[2001:db8::1]", "22"), {
    host: "2001:db8::1",
    port: 22
  });
  assert.throws(() => normalizeSshTarget("host; reboot", 22), /主机地址不合法/);
  assert.throws(() => normalizeSshTarget("example.com", 70000), /SSH 端口/);
});

test("shellQuote preserves single quotes without leaving the shell argument", () => {
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
  const command = buildListFilesCommand("/home/alice/a'b");
  assert.match(command, /^bash -lc '/);
  assert.match(command, /requested=/);
  assert.doesNotMatch(command, /requested=\/home\/alice\/a'b/);
  assert.throws(() => buildListFilesCommand("../etc"), /远程路径不合法/);
});

test("remote file listing parser joins metadata and du sizes", () => {
  const output = [
    "HOME", "/home/alice",
    "PATH", "/home/alice/project",
    "TRUNCATED", "0",
    "ENTRY", "models", "d", "4096", "1724910000.5", "/home/alice/project/models",
    "ENTRY", "train.log", "f", "200", "1724920000", "/home/alice/project/train.log",
    "SIZES",
    "1073741824\t/home/alice/project/models",
    "200\t/home/alice/project/train.log",
    ""
  ].join("\0");
  const listing = parseRemoteFileListing(output);
  assert.equal(listing.home, "/home/alice");
  assert.equal(listing.path, "/home/alice/project");
  assert.equal(listing.parent, "/home/alice");
  assert.equal(listing.entries[0]?.kind, "directory");
  assert.equal(listing.entries[0]?.sizeBytes, 1073741824);
  assert.equal(listing.entries[1]?.hidden, false);
  assert.equal(listing.totalBytes, 1073742024);
  assert.equal(listing.truncated, false);
  assert.equal(listing.cached, false);
  assert.ok(Number.isFinite(Date.parse(listing.scannedAt)));
});

test("home listing has no parent and reports hidden files", () => {
  const output = [
    "HOME", "/home/alice",
    "PATH", "/home/alice",
    "TRUNCATED", "1",
    "ENTRY", ".cache", "d", "0", "0", "/home/alice/.cache",
    "SIZES", "512\t/home/alice/.cache", ""
  ].join("\0");
  const listing = parseRemoteFileListing(output);
  assert.equal(listing.parent, null);
  assert.equal(listing.truncated, true);
  assert.equal(listing.entries[0]?.hidden, true);
});
