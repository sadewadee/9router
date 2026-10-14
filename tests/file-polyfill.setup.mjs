// Node 18 lacks the File global that undici (pulled in via proxyFetch) expects
// at module-evaluation time. Runs in every vitest worker before tests.
if (typeof globalThis.File === "undefined") {
  globalThis.File = class File extends Blob {
    constructor(parts, name, options) {
      super(parts, options);
      this.name = String(name);
    }
  };
}
