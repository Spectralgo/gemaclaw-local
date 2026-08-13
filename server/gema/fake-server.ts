import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Test-only fake Gema server: records every request (method, path,
 * headers, JSON body) and answers from a scripted route table. Ported
 * from the scripted-broker pattern in Wazo's gemaclaw-runner.test.ts.
 */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface FakeServer {
  url: string;
  requests: RecordedRequest[];
  /** Script a response; later calls override earlier ones. */
  respond: (
    method: string,
    path: string,
    status: number,
    body: unknown,
  ) => void;
  close: () => Promise<void>;
}

export async function startFakeServer(): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const routes = new Map<string, { status: number; body: unknown }>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const path = req.url ?? "/";
      requests.push({
        method: req.method ?? "GET",
        path,
        headers: req.headers,
        body,
      });
      const scripted =
        routes.get(`${req.method} ${path}`) ??
        ({ status: 404, body: { error: "unscripted route" } } as const);
      res.writeHead(scripted.status, { "content-type": "application/json" });
      res.end(JSON.stringify(scripted.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respond: (method, path, status, body) =>
      routes.set(`${method} ${path}`, { status, body }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
