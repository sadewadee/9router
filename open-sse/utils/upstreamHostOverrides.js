// Upstream host overrides (UPSTREAM_HOST_OVERRIDES).
//
// Some upstreams only resolve correctly from certain networks (e.g. EdgeOne
// geo-DNS answers 0.0.0.1 for www.codebuddy.ai to US resolvers). An override
// pins `hostname -> ipv4` for outgoing connections while everything that
// identifies the host stays on the real name: the URL, the Host header, the TLS
// SNI and the certificate verification. It is the programmatic equivalent of
// `extra_hosts` (direct) and `curl --connect-to` (through an HTTP proxy, where
// the proxy would otherwise resolve the name itself).
//
// Format: UPSTREAM_HOST_OVERRIDES="www.codebuddy.ai=43.159.106.56,other.host=1.2.3.4"

const ENV_NAME = "UPSTREAM_HOST_OVERRIDES";
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_CONNECT_RESPONSE_BYTES = 16 * 1024;
const KEEP_ALIVE_INITIAL_DELAY_MS = 60_000;

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

const noop = () => {};

function normalizeHostname(hostname) {
  return String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Parse "host=ipv4,host2=ipv4" into a Map<lowercased hostname, ipv4>.
 * Malformed entries are skipped and reported in ONE warning. Later entries win
 * over earlier ones for the same hostname. Empty/undefined input → empty Map.
 */
export function parseHostOverrides(raw, warn = console.warn) {
  const overrides = new Map();
  const text = raw === undefined || raw === null ? "" : String(raw).trim();
  if (!text) return overrides;

  const malformed = [];
  for (const part of text.split(",")) {
    const entry = part.trim();
    if (!entry) continue;

    const eq = entry.indexOf("=");
    const hostname = eq > 0 ? normalizeHostname(entry.slice(0, eq)) : "";
    const ip = eq > 0 ? entry.slice(eq + 1).trim() : "";
    // An IP literal as the "hostname" can never be matched by name, reject it.
    if (!HOSTNAME_RE.test(hostname) || IPV4_RE.test(hostname) || !IPV4_RE.test(ip)) {
      malformed.push(entry);
      continue;
    }
    overrides.set(hostname, ip);
  }

  if (malformed.length > 0) {
    warn(`[ProxyFetch] ${ENV_NAME}: ignoring malformed entries (expected hostname=ipv4): ${malformed.join(", ")}`);
  }
  return overrides;
}

// Parsed once per distinct env value (so the warning is emitted once, and the
// env can still be changed between process starts or in tests).
let cachedRaw = null;
let cachedOverrides = new Map();

export function getHostOverrides() {
  const raw = process.env[ENV_NAME] || "";
  if (raw !== cachedRaw) {
    cachedOverrides = parseHostOverrides(raw);
    cachedRaw = raw;
  }
  return cachedOverrides;
}

/** Override IPv4 for the hostname of `targetUrl`, or null when none applies. */
export function getHostOverrideIp(targetUrl) {
  const overrides = getHostOverrides();
  if (overrides.size === 0) return null;
  try {
    return overrides.get(normalizeHostname(new URL(targetUrl).hostname)) || null;
  } catch {
    return null;
  }
}

/** True when `proxyUrl` is an HTTP(S) proxy that speaks CONNECT (not SOCKS). */
export function supportsConnectTunnel(proxyUrl) {
  try {
    const { protocol } = new URL(proxyUrl);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Direct (no proxy) dispatcher that always dials `ip`, whatever hostname the
 * request is for. SNI and certificate verification still use the request host
 * because undici derives them from the URL, not from the lookup result.
 */
export async function createHostOverrideDirectDispatcher(ip) {
  const { Agent } = await import("undici");
  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        // net.connect may ask for all addresses (autoSelectFamily) or a single one.
        if (options?.all) callback(null, [{ address: ip, family: 4 }]);
        else callback(null, ip, 4);
      },
    },
  });
}

function basicProxyAuth(proxy) {
  if (!proxy.username) return null;
  const decode = (value) => {
    try { return decodeURIComponent(value); } catch { return value; }
  };
  const credentials = `${decode(proxy.username)}:${decode(proxy.password)}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

/**
 * Open a CONNECT tunnel to `targetHost:targetPort` through an HTTP(S) proxy.
 * Resolves with the raw tunnel socket once the proxy answered 2xx. Errors never
 * include the proxy URL or its credentials.
 */
function openConnectTunnel({ proxy, targetHost, targetPort, net, tls }) {
  return new Promise((resolve, reject) => {
    const useTls = proxy.protocol === "https:";
    const proxyHost = proxy.hostname.replace(/^\[|\]$/g, "");
    const proxyPort = Number(proxy.port) || (useTls ? 443 : 80);
    const authority = `${targetHost}:${targetPort}`;

    const socket = useTls
      ? tls.connect({ host: proxyHost, port: proxyPort, servername: net.isIP(proxyHost) ? undefined : proxyHost })
      : net.connect({ host: proxyHost, port: proxyPort });

    let settled = false;
    let head = Buffer.alloc(0);

    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", fail);
      socket.removeListener("close", onClose);
      socket.setTimeout(0);
    };
    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      socket.on("error", noop);
      socket.destroy();
      reject(err);
    }
    function onClose() {
      fail(new Error(`Proxy closed the connection before answering CONNECT ${authority}`));
    }
    function onData(chunk) {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > MAX_CONNECT_RESPONSE_BYTES) fail(new Error("Proxy CONNECT response header too large"));
        return;
      }

      const statusLine = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
      if (!match) return fail(new Error("Proxy sent an invalid CONNECT response"));
      const status = Number(match[1]);
      if (status < 200 || status >= 300) {
        const err = new Error(`Proxy refused CONNECT ${authority} (HTTP ${status})`);
        err.statusCode = status;
        return fail(err);
      }
      // The target speaks second (TLS ClientHello / HTTP request), so anything
      // after the header block is a protocol error and would be lost to the
      // TLS layer anyway.
      if (head.length !== end + 4) return fail(new Error("Proxy sent unexpected data after CONNECT response"));

      settled = true;
      cleanup();
      // Late socket errors surface through the TLS/HTTP layer that takes over.
      socket.on("error", noop);
      resolve(socket);
    }

    socket.on("data", onData);
    socket.on("error", fail);
    socket.on("close", onClose);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error(`Proxy CONNECT ${authority} timed out`)));
    socket.once(useTls ? "secureConnect" : "connect", () => {
      const auth = basicProxyAuth(proxy);
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\n` +
        `Host: ${authority}\r\n` +
        (auth ? `Proxy-Authorization: ${auth}\r\n` : "") +
        "Proxy-Connection: Keep-Alive\r\n\r\n"
      );
    });
  });
}

/**
 * Dispatcher that reaches any origin through an HTTP(S) proxy, but asks the
 * proxy to CONNECT to `ip` (same port as the URL) instead of the hostname.
 * TLS then starts over the tunnel with SNI = the URL's hostname and normal
 * certificate verification against that hostname; the request line and Host
 * header are untouched. Undici's own ProxyAgent cannot do this: it always
 * CONNECTs to the request origin.
 */
export async function createHostOverrideTunnelDispatcher(proxyUrl, ip) {
  const [{ Agent, buildConnector }, netModule, tlsModule] = await Promise.all([
    import("undici"),
    import("net"),
    import("tls"),
  ]);
  const net = netModule.default ?? netModule;
  const tls = tlsModule.default ?? tlsModule;

  const proxy = new URL(proxyUrl);
  const upgradeToTls = buildConnector({});

  return new Agent({
    connect: (opts, callback) => {
      const isHttps = opts.protocol === "https:";
      const targetPort = Number(opts.port) || (isHttps ? 443 : 80);

      openConnectTunnel({ proxy, targetHost: ip, targetPort, net, tls }).then((socket) => {
        socket.setNoDelay(true);
        socket.setKeepAlive(true, KEEP_ALIVE_INITIAL_DELAY_MS);
        if (!isHttps) return callback(null, socket);

        try {
          upgradeToTls(
            { ...opts, servername: opts.servername || opts.hostname, httpSocket: socket },
            (err, tlsSocket) => {
              if (err) socket.destroy();
              callback(err, tlsSocket);
            }
          );
        } catch (err) {
          socket.destroy();
          callback(err);
        }
      }, callback);
    },
  });
}
