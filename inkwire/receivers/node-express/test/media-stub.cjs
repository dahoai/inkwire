// Preloaded (node --require) ONLY by the conformance harness, never by the receiver itself.
// The conformance case "media fetch-by-url" asks a receiver to fetch https://example.test/imgs/ok.png,
// a host that does not exist. This answers that one URL (a 1x1 PNG) at the dns/https layer so the real
// guard code still runs end to end: it resolves the name, checks the address, pins it, and streams the
// reply. Every other host goes to the real dns and https.
const dns = require("node:dns");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const lookup = dns.promises.lookup;
dns.promises.lookup = function (host, ...rest) {
  if (host === "example.test") return Promise.resolve([{ address: "93.184.216.34", family: 4 }]);
  return lookup.call(this, host, ...rest);
};

const request = https.request;
https.request = function (opts, cb) {
  if (!opts || opts.hostname !== "example.test") return request.apply(this, arguments);
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy = () => req;
  req.end = () => {
    const ok = opts.path === "/imgs/ok.png";
    const res = Readable.from([ok ? PNG : Buffer.from("no")]);
    res.statusCode = ok ? 200 : 404;
    res.headers = { "content-type": "image/png", "content-length": String(ok ? PNG.length : 2) };
    process.nextTick(() => cb(res));
  };
  return req;
};
