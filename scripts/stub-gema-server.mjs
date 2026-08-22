import http from "node:http";
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const reply = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url === "/gemaclaw/companion/pair") {
      const { code } = JSON.parse(body || "{}");
      if (code === "ABCD1234") return reply(200, { token: "stub-companion-token" });
      return reply(400, { error: "bad code" });
    }
    if (req.url === "/gemaclaw/companion/poll") {
      const { token } = JSON.parse(body || "{}");
      if (token !== "stub-companion-token") return reply(403, {});
      console.log("STUB: poll ok");
      return reply(200, { tasks: [] });
    }
    reply(404, {});
  });
});
server.listen(4799, "127.0.0.1", () => console.log("STUB: listening"));
